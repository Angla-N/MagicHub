/**
 * MagicHub-Server 独立服务器程序（无窗口，托盘常驻）
 *
 * 职责：
 *  1. 启动内置 Node 业务服务（apps/server：账号、聊天记录、文件上传/下载、插件市场、WS 推送）
 *  2. 系统托盘常驻 + 退出菜单
 *  3. 数据目录便携化：聊天记录/头像/上传文件/插件市场统一放在 exe 目录下 data/ 文件夹，
 *     不写入系统用户目录（避免占用 C 盘）
 *
 * 客户端（MagicHub-Client / H5）通过服务器地址（默认 http://localhost:3000）连接本服务。
 */
const { app, Tray, Menu, utilityProcess } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

app.setName("MagicHub-Server");

let serverProc = null;
let tray = null;

/* ---- 便携数据目录：exe 所在目录/data ---- */
const dataDir = process.env.MAGICHUB_DATA_DIR || path.join(path.dirname(process.execPath), "data");
const pluginsRoot = path.join(dataDir, "plugins");
const bundledPlugins = app.isPackaged
  ? path.join(process.resourcesPath, "plugins")
  : path.join(__dirname, "..", "..", "plugins");
const sevenZip = app.isPackaged
  ? path.join(process.resourcesPath, "7za.exe")
  : path.join(__dirname, "7za.exe");

/** 首次启动：把内置插件打成 .7z 放进插件市场（data/plugins/<id>.7z + .meta/<id>.json），已存在不覆盖 */
function seedPlugins() {
  try {
    fs.mkdirSync(pluginsRoot, { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, ".meta"), { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, ".icons"), { recursive: true });
    if (!fs.existsSync(bundledPlugins) || !fs.existsSync(sevenZip)) return;
    for (const name of fs.readdirSync(bundledPlugins)) {
      const src = path.join(bundledPlugins, name);
      if (!fs.statSync(src).isDirectory()) continue;
      const mf = path.join(src, "manifest.json");
      if (!fs.existsSync(mf)) continue;
      const pack = path.join(pluginsRoot, name + ".7z");
      const metaFile = path.join(pluginsRoot, ".meta", name + ".json");
      const m = JSON.parse(fs.readFileSync(mf, "utf8"));
      // 图标：从包内/内置源码提取到 .icons/<name><ext>，市场列表直接引用
      const iconName = m.icon || "";
      const iconBase = iconName ? path.basename(String(iconName).split("?")[0]) : "";
      const iconDest = iconBase
        ? path.join(pluginsRoot, ".icons", name + path.extname(iconBase))
        : null;
      const iconOk = iconDest && fs.existsSync(iconDest);
      if (fs.existsSync(pack) && fs.existsSync(metaFile) && iconOk) continue; // 已存在（用户可能已更新/删除过）不覆盖
      if (!fs.existsSync(pack)) {
        // 打 .7z：在插件目录内打包，保证包根就是插件内容
        execFileSync(sevenZip, ["a", "-t7z", "-mx=5", "-y", "-bso0", "-bsp0", pack, "*"], {
          cwd: src, windowsHide: true, stdio: "pipe",
        });
      }
      // 补提取图标（即使包已存在）
      if (iconDest && !iconOk) {
        const iconSrc = path.join(src, iconBase);
        if (fs.existsSync(iconSrc) && fs.statSync(iconSrc).isFile()) {
          fs.copyFileSync(iconSrc, iconDest);
        }
      }
      // 写市场元数据（内置：system / 公开 + manifest 快照）
      fs.writeFileSync(metaFile, JSON.stringify({
        author: "system", public: true, uploadedAt: 0,
        manifest: {
          name: m.name || name,
          version: m.version || "0.0.0",
          description: m.description || "",
          entry: m.entry || "index.html",
          icon: m.icon || "",
        },
      }, null, 2));
      console.log(`[magichub-server] 内置插件已加入市场: ${name}.7z`);
    }
  } catch (e) {
    console.error("[magichub-server] 内置插件种子失败（不影响服务）:", e.message);
  }
}

app.whenReady().then(() => {
  seedPlugins();
  const serverDir = app.isPackaged
    ? path.join(process.resourcesPath, "server")
    : path.join(__dirname, "..", "server");
  const starter = path.join(__dirname, "starter.js");
  const port = process.env.MAGICHUB_PORT || "3000";

  serverProc = utilityProcess.fork(starter, [], {
    serviceName: "magichub-server",
    env: {
      ...process.env,
      PORT: String(port),
      MAGICHUB_DATA_DIR: dataDir,
      MAGICHUB_PLUGINS_ROOT: pluginsRoot,
      MAGICHUB_7Z: sevenZip,
      MAGICHUB_SERVER_DIR: serverDir,
      MAGICHUB_LOG: path.join(dataDir, "server.log"),
      // 打包部署标记：禁用内置演示账号（demo/demo123 仅开发模式预置）
      MAGICHUB_PACKAGED: app.isPackaged ? "1" : "0",
    },
  });

  // 系统托盘：查看状态 / 打开数据目录 / 退出
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "brand", "icon.ico")
    : path.join(__dirname, "..", "..", "brand", "icon.ico");
  try {
    tray = new Tray(iconPath);
    tray.setToolTip("MagicHub-Server · 端口 " + port);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "MagicHub 服务器运行中", enabled: false },
      { label: "端口 " + port, enabled: false },
      { label: "数据目录 " + dataDir, enabled: false },
      { type: "separator" },
      {
        label: "打开数据目录",
        click: () => {
          try { require("electron").shell.openPath(dataDir); } catch { /* 忽略 */ }
        },
      },
      { type: "separator" },
      {
        label: "退出 MagicHub-Server",
        click: () => {
          if (serverProc && !serverProc.killed) { try { serverProc.kill(); } catch { /* 忽略 */ } }
          app.quit();
        },
      },
    ]));
  } catch (e) {
    console.error("[magichub-server] 托盘初始化失败（不影响服务）:", e.message);
  }

  app.on("will-quit", () => {
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill(); } catch { /* 忽略 */ }
    }
  });
});

// 无窗口应用：所有窗口关闭后保持后台运行（托盘常驻）
app.on("window-all-closed", () => { /* 保持运行 */ });
