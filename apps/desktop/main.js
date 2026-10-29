/**
 * MagicHub 客户端（纯前端壳，不内置业务服务器）
 *
 * 职责：
 *  1. 创建无边框窗口（自绘标题栏，-webkit-app-region 拖拽）
 *  2. 加载本地前端页面（login.html / index.html）
 *  3. 通过 preload 暴露窗口控制 / 后台驻留 / 本地插件管理 API
 *  4. 后台驻留：默认关闭窗口时最小化到系统托盘（快速启动），可在设置中关闭
 *  5. 本地插件：从服务器插件市场下载 .7z 并解压到 exe 目录/data/plugins，自动加载
 *
 * 业务数据（账号、聊天记录、文件下载）全部由独立的 MagicHub-Server 提供。
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, net, Notification } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");

app.setName("MagicHub");

let win = null;
let tray = null;
let quitting = false;

/* ---- 便携本地数据：exe 目录/data（插件下载到本地，不占用 C 盘用户目录） ---- */
const localDataDir = path.join(path.dirname(process.execPath), "data");
const localPluginsDir = path.join(localDataDir, "plugins");
// P2：#25 设置文件移到 exe 旁 data/settings.json（与插件同目录，不占 C 盘）
const settingsFile = path.join(localDataDir, "settings.json");
const legacySettingsFile = path.join(app.getPath("userData"), "settings.json");
const sevenZip = app.isPackaged
  ? path.join(process.resourcesPath, "7za.exe")
  : path.join(__dirname, "7za.exe");

/* ---- 设置读写（后台驻留开关；P2：#25 首次启动把旧的 C 盘设置迁移到 exe 旁） ---- */
function readSettings() {
  try {
    if (fs.existsSync(legacySettingsFile) && !fs.existsSync(settingsFile)) {
      // 旧版设置（C 盘 userData）迁移：复制内容后删除旧文件
      const old = JSON.parse(fs.readFileSync(legacySettingsFile, "utf8"));
      fs.mkdirSync(localDataDir, { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify(old, null, 2));
      try { fs.rmSync(legacySettingsFile, { force: true }); } catch { /* 忽略 */ }
      return old;
    }
    if (fs.existsSync(settingsFile)) return JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  } catch { /* 忽略 */ }
  return {};
}
function writeSettings(patch) {
  const s = readSettings();
  Object.assign(s, patch);
  try { fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2)); } catch { /* 忽略 */ }
  return s;
}
function keepInBackground() {
  const s = readSettings();
  return s.keepInBackground !== false; // 默认开启后台驻留
}

/* ---- 本地插件 ---- */
/** 插件入口路径防穿越：规范化后必须位于插件目录内，非法返回 null */
function safePluginEntry(dir, entry) {
  const p = path.resolve(dir, String(entry || "index.html"));
  if (p !== dir && !p.startsWith(dir + path.sep)) return null;
  return p;
}

/** 递归统计目录文件数与总大小；超过上限抛错（zip 炸弹防护） */
function assertDirLimits(dir, maxFiles = 200, maxBytes = 50 * 1024 * 1024) {
  let files = 0, bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) stack.push(p);
      else {
        files++;
        bytes += st.size;
        if (files > maxFiles || bytes > maxBytes) {
          throw new Error(`插件解压后过大（>${maxFiles} 个文件 / >${Math.round(maxBytes / 1024 / 1024)}MB），已拒绝`);
        }
      }
    }
  }
}

function listLocalPlugins() {
  const out = [];
  if (!fs.existsSync(localPluginsDir)) return out;
  for (const name of fs.readdirSync(localPluginsDir)) {
    const dir = path.join(localPluginsDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const mf = path.join(dir, "manifest.json");
    if (!fs.existsSync(mf)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(mf, "utf8"));
      const entry = safePluginEntry(dir, m.entry || "index.html");
      if (!entry) { console.error(`[magichub-client] 跳过插件 ${name}：入口路径不合法`); continue; }
      // P2：#24 启用/禁用：目录下存在 .disabled 标记视为停用（不删除，随时可恢复）
      const enabled = !fs.existsSync(path.join(dir, ".disabled"));
      out.push({
        id: String(m.id || name),
        name: m.name || name,
        version: m.version || "0.0.0",
        description: m.description || "",
        entry: m.entry || "index.html",
        icon: m.icon || "",
        enabled,
        localEntry: "file:///" + entry.replace(/\\/g, "/"),
        installedAt: fs.statSync(dir).mtimeMs,
      });
    } catch { /* 跳过损坏的本地插件 */ }
  }
  return out;
}

/** P2：#24 设置插件启用状态：停用写入 .disabled 标记文件，启用删除标记 */
function setPluginEnabled(id, enabled) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(id))) return false;
  const dir = path.join(localPluginsDir, String(id));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
  const mark = path.join(dir, ".disabled");
  if (enabled) {
    try { if (fs.existsSync(mark)) fs.rmSync(mark, { force: true }); } catch { return false; }
  } else {
    try { fs.writeFileSync(mark, ""); } catch { return false; }
  }
  return true;
}

/** 解压 .7z 安装包到本地插件目录（校验 manifest + 入口防穿越 + 解压规模限制） */
function extractPluginArchive(id, packPath) {
  return new Promise((resolve, reject) => {
    const dest = path.join(localPluginsDir, id);
    if (!fs.existsSync(sevenZip)) {
      reject(new Error("客户端缺少解压工具（7za.exe）"));
      return;
    }
    fs.mkdirSync(dest, { recursive: true });
    execFile(sevenZip, ["x", packPath, `-o${dest}`, "-y", "-bso0", "-bsp0"], { windowsHide: true }, (err) => {
      if (err) {
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 忽略 */ }
        reject(new Error("解压失败：" + err.message));
        return;
      }
      // zip 炸弹防护：文件数/总大小上限
      try {
        assertDirLimits(dest);
      } catch (e) {
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 忽略 */ }
        reject(new Error(e.message));
        return;
      }
      const mf = path.join(dest, "manifest.json");
      if (!fs.existsSync(mf)) {
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 忽略 */ }
        reject(new Error("插件包缺少 manifest.json"));
        return;
      }
      try {
        const m = JSON.parse(fs.readFileSync(mf, "utf8"));
        if (String(m.id || "") !== id) {
          try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 忽略 */ }
          reject(new Error("manifest.id 与插件名不一致"));
          return;
        }
        const entry = safePluginEntry(dest, m.entry || "index.html");
        if (!entry) {
          try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 忽略 */ }
          reject(new Error("插件入口路径不合法（禁止越出插件目录）"));
          return;
        }
        resolve({
          id, name: m.name || id, version: m.version || "0.0.0",
          description: m.description || "", entry: m.entry || "index.html", icon: m.icon || "",
        });
      } catch (e) {
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 忽略 */ }
        reject(new Error("manifest.json 非法"));
      }
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    frame: false, // 自绘标题栏
    backgroundColor: "#1E1E1E",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  // 打开程序默认停在登录页（用户确认登录后才进入主界面）
  const webEntry = app.isPackaged
    ? path.join(process.resourcesPath, "web", "login.html")
    : path.join(__dirname, "..", "..", "web", "login.html");
  win.loadFile(webEntry);

  // 关闭窗口：后台驻留开启时隐藏到托盘，否则真正退出
  win.on("close", (e) => {
    if (!quitting && keepInBackground()) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => { win = null; });
}

/* ---- 托盘（后台驻留） ---- */
function createTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "brand", "icon.ico")
    : path.join(__dirname, "..", "..", "brand", "icon.ico");
  try {
    tray = new Tray(iconPath);
    tray.setToolTip("MagicHub 客户端");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 MagicHub", click: () => { if (win) { win.show(); win.focus(); } } },
      { type: "separator" },
      { label: "退出 MagicHub", click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on("click", () => { if (win) { win.show(); win.focus(); } });
  } catch (e) {
    console.error("[magichub-client] 托盘初始化失败:", e.message);
  }
}

/* ---- IPC ---- */
ipcMain.handle("win:minimize", () => win && win.minimize());
ipcMain.handle("win:maximize", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle("win:close", () => win && win.close());

/* 系统通知：后台驻留 / 窗口最小化时新消息桌面弹出（P1） */
ipcMain.handle("app:notify", (_e, title, body) => {
  if (win && win.isVisible() && win.isFocused()) return false; // 前台聚焦时不打扰
  try {
    if (Notification.isSupported()) {
      new Notification({ title: String(title || "MagicHub"), body: String(body || ""), silent: false }).show();
      return true;
    }
  } catch { /* 忽略 */ }
  return false;
});

ipcMain.handle("settings:getKeepInBackground", () => keepInBackground());
ipcMain.handle("settings:setKeepInBackground", (_e, val) => {
  writeSettings({ keepInBackground: !!val });
  return !!val;
});

ipcMain.handle("plugins:listLocal", () => listLocalPlugins());
ipcMain.handle("plugins:setEnabled", (_e, id, enabled) => setPluginEnabled(id, !!enabled));
ipcMain.handle("plugins:install", async (_e, payload) => {
  const id = String((payload && payload.id) || "");
  const buffer = payload && payload.buffer;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !buffer) {
    throw new Error("参数错误");
  }
  const tmpDir = path.join(localDataDir, ".tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const packPath = path.join(tmpDir, id + ".7z");
  fs.writeFileSync(packPath, Buffer.from(buffer));
  try {
    return await extractPluginArchive(id, packPath);
  } finally {
    try { fs.rmSync(packPath, { force: true }); } catch { /* 忽略 */ }
  }
});
ipcMain.handle("plugins:uninstall", (_e, id) => {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(id))) return false;
  const dir = path.join(localPluginsDir, String(id));
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
  return false;
});

app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => {
  // 后台驻留开启时保持托盘运行；关闭时正常退出
  if (!keepInBackground()) app.quit();
});
