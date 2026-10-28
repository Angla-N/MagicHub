/**
 * MagicHub-Server 独立服务器程序（无窗口，托盘常驻）
 *
 * 职责：
 *  1. 启动内置 Node 业务服务（apps/server：账号、聊天记录、文件上传/下载、插件、WS 推送）
 *  2. 系统托盘常驻 + 退出菜单，数据目录默认在用户目录
 *
 * 客户端（MagicHub-Client / H5）通过服务器地址（默认 http://localhost:3000）连接本服务。
 */
const { app, Tray, Menu, utilityProcess } = require("electron");
const path = require("node:path");

app.setName("MagicHub-Server");

let serverProc = null;
let tray = null;

app.whenReady().then(() => {
  const serverDir = app.isPackaged
    ? path.join(process.resourcesPath, "server")
    : path.join(__dirname, "..", "server");
  const starter = path.join(__dirname, "starter.js");
  const port = process.env.MAGICHUB_PORT || "3000";
  const dataDir = process.env.MAGICHUB_DATA_DIR || path.join(app.getPath("userData"), "data");
  const pluginsRoot = app.isPackaged
    ? path.join(process.resourcesPath, "plugins")
    : path.join(__dirname, "..", "..", "plugins");

  serverProc = utilityProcess.fork(starter, [], {
    serviceName: "magichub-server",
    env: {
      ...process.env,
      PORT: String(port),
      MAGICHUB_DATA_DIR: dataDir,
      MAGICHUB_PLUGINS_ROOT: pluginsRoot,
      MAGICHUB_SERVER_DIR: serverDir,
      MAGICHUB_LOG: path.join(app.getPath("userData"), "server.log"),
    },
  });

  // 系统托盘：查看状态 / 退出
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "brand", "icon.ico")
    : path.join(__dirname, "..", "..", "brand", "icon.ico");
  try {
    tray = new Tray(iconPath);
    tray.setToolTip("MagicHub-Server · 端口 " + port);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "MagicHub 服务器运行中", enabled: false },
      { label: "端口 " + port + "（数据目录 " + dataDir + "）", enabled: false },
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
