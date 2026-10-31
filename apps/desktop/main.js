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
const { createHash } = require("node:crypto");
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

/* ---- 前端脚本缓存（实时更新架构）：打包模式不内置前端，从服务器拉取缓存到 exe 旁 data/web ---- */
const webCacheDir = app.isPackaged ? path.join(localDataDir, "web") : null;
const DEFAULT_SERVER_BASE = "http://localhost:3000";
function readServerBase() {
  const s = readSettings();
  return String(s.serverBase || DEFAULT_SERVER_BASE).replace(/\/+$/, "");
}

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

/* ================= 前端脚本同步（打包模式）：服务器发布 → 本地缓存 → 加载 ================= */

/** 安全地把清单相对路径解析为缓存目录内路径（防穿越：拒绝 .. / . 段与绝对路径） */
function resolveCachePath(baseRoot, rel) {
  const parts = String(rel || "").split("/").filter(Boolean);
  if (!parts.length) return null;
  for (const p of parts) if (p === ".." || p === ".") return null;
  const cur = path.resolve(baseRoot, ...parts);
  if (cur !== baseRoot && !cur.startsWith(baseRoot + path.sep)) return null;
  return cur;
}

function localManifestFile() { return path.join(webCacheDir, "web-manifest.json"); }
function readLocalManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(localManifestFile(), "utf8"));
    if (m && typeof m.version === "number" && Array.isArray(m.files)) return m;
  } catch { /* 无缓存或损坏 */ }
  return null;
}
function writeLocalManifest(m) {
  try {
    fs.mkdirSync(webCacheDir, { recursive: true });
    const tmp = localManifestFile() + ".tmp-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fs.renameSync(tmp, localManifestFile());
  } catch (err) {
    console.error("[magichub-client] 写本地前端清单失败:", err.message);
  }
}
function fileMatch(list, f) {
  return list.some((x) => x.path === f.path && x.sha256 === f.sha256);
}

/**
 * 确保本地前端为服务器最新版本（增量同步，sha256 校验）。
 * 返回 { entry, version, offline }；服务器不可达且无本地缓存时返回 null（引导页配置重试）。
 */
async function ensureWeb(onStatus) {
  const base = readServerBase();
  const st = (m) => { if (onStatus) onStatus(m); };

  // 1. 拉取服务器前端清单
  let manifest = null;
  try {
    const r = await fetch(base + "/api/web/manifest", { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = await r.json();
      if (j && j.ok && j.data && j.data.version) manifest = j.data;
    }
  } catch { manifest = null; }

  const local = readLocalManifest();

  // 2. 服务器不可达：有本地缓存则离线启动；否则返回 null（引导页）
  if (!manifest) {
    if (local) {
      st("服务器不可达，使用本地缓存（v" + local.version + "）");
      return { entry: local.entry || "login.html", version: local.version, offline: true };
    }
    st("无法获取前端：请确认服务器已启动");
    return null;
  }

  // 3. 版本一致且文件齐全 → 直接用本地缓存（第二次及以后启动，秒开）
  if (local && local.version === manifest.version && (manifest.files || []).every((f) => fileMatch(local.files, f))) {
    st("前端已是最新（v" + manifest.version + "）");
    return { entry: manifest.entry || "login.html", version: manifest.version, offline: false };
  }

  // 4. 增量下载缺失/变化的文件（版本不同或首次）
  const need = (manifest.files || []).filter((f) => !(local && fileMatch(local.files, f)));
  st("正在同步前端 v" + manifest.version + "…（" + need.length + " 个文件）");
  fs.mkdirSync(webCacheDir, { recursive: true });
  let okAll = true;
  for (let i = 0; i < need.length; i++) {
    const f = need[i];
    try {
      const enc = f.path.split("/").map(encodeURIComponent).join("/");
      const r = await fetch(base + "/api/web/file/" + enc, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const hash = createHash("sha256").update(buf).digest("hex");
      if (hash !== f.sha256) throw new Error("sha256 校验失败");
      const dest = resolveCachePath(webCacheDir, f.path);
      if (!dest) throw new Error("路径不合法");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + ".tmp-" + Date.now();
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      if (i % 10 === 0 || i === need.length - 1) {
        st("正在同步前端 v" + manifest.version + "…（" + (i + 1) + "/" + need.length + "）");
      }
    } catch (e) {
      console.error("[magichub-client] 文件同步失败 " + f.path + ":", e.message);
      // 该文件本地有旧版则容忍继续；没有旧版则整体失败（引导页重试）
      if (!(local && fileMatch(local.files, f))) { okAll = false; break; }
    }
  }
  if (!okAll) {
    st("同步失败：请确认服务器在线后重试");
    return null;
  }

  writeLocalManifest(manifest);
  st("前端同步完成（v" + manifest.version + "）");
  return { entry: manifest.entry || "login.html", version: manifest.version, offline: false };
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
  if (!app.isPackaged) {
    // 开发模式：直接加载仓库前端
    win.loadFile(path.join(__dirname, "..", "..", "web", "login.html"));
    return;
  }
  // 打包模式：先加载内置引导页（同步前端/进度/错误配置），同步完成后切入缓存前端
  win.loadFile(path.join(process.resourcesPath, "boot.html")).then(() => runWebSync());

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

/* 引导页：前端同步状态 / 服务器地址配置（打包模式启动时） */
let syncing = false;
async function runWebSync() {
  if (syncing) return;
  syncing = true;
  const st = (m) => { if (win && !win.isDestroyed()) win.webContents.send("boot:status", String(m)); };
  try {
    const target = await ensureWeb(st);
    if (!target) { st("无法获取前端：请确认服务器已启动"); return; }
    if (win && !win.isDestroyed()) {
      await win.loadFile(path.join(webCacheDir, target.entry));
    }
  } catch (e) {
    st("同步失败：" + e.message);
  } finally {
    syncing = false;
  }
}
ipcMain.handle("boot:getServerBase", () => readServerBase());
ipcMain.handle("boot:setServerBase", (_e, base) => {
  const b = String(base || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[\w.-]+(:\d+)?$/.test(b)) return false;
  writeSettings({ serverBase: b });
  return true;
});
ipcMain.handle("boot:retry", () => { runWebSync(); return true; });

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
