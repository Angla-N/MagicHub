/**
 * MagicHub 桌面端 · Electron 主进程
 *
 * 职责：
 *  1. 探测空闲端口，用 utilityProcess 启动内置 Node 服务（apps/server，无需独立 node 安装）
 *  2. 创建无边框窗口（自绘标题栏，-webkit-app-region 拖拽）
 *  3. 通过 preload 暴露窗口控制 API（window.magicHub）
 */
const { app, BrowserWindow, ipcMain, utilityProcess } = require("electron");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");

app.setName("MagicHub");

let win = null;
let serverProc = null;
let serverPort = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 端口是否空闲（无监听则空闲） */
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(true));
  });
}

/** 探测第一个空闲端口（3000-3010） */
async function pickPort() {
  for (let p = 3000; p <= 3010; p++) {
    if (await portFree(p)) return p;
  }
  return 3000;
}

/** HTTP 探活 */
function httpOk(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/plugins", timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

/** 启动内置 Node 服务，等待可访问 */
async function startServer(port) {
  const serverDir = app.isPackaged
    ? path.join(process.resourcesPath, "server") // extraResource 按 basename 落到 resources/
    : path.join(__dirname, "..", "server");
  const starter = path.join(__dirname, "starter.js");

  serverProc = utilityProcess.fork(starter, [], {
    serviceName: "magichub-server",
    env: {
      ...process.env,
      PORT: String(port),
      MAGICHUB_DATA_DIR: app.getPath("userData"), // 账号数据外置到用户目录
      MAGICHUB_PLUGINS_ROOT: app.isPackaged
        ? path.join(process.resourcesPath, "plugins")
        : path.join(__dirname, "..", "..", "plugins"),
      MAGICHUB_SERVER_DIR: serverDir,
      MAGICHUB_LOG: path.join(app.getPath("userData"), "server.log"),
    },
  });

  for (let i = 0; i < 50; i++) {
    await sleep(150);
    if (await httpOk(port)) return true;
  }
  return false;
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
      // 把内置服务地址注入渲染进程（preload 通过 process.argv 读取）
      additionalArguments: [`--magichub-server-base=http://127.0.0.1:${serverPort}`],
    },
  });

  win.once("ready-to-show", () => win.show());
  // 打开程序默认停在登录页（用户确认登录后才进入主界面），登录成功后再跳转 index.html
  const webEntry = app.isPackaged
    ? path.join(process.resourcesPath, "web", "login.html")
    : path.join(__dirname, "..", "..", "web", "login.html");
  win.loadFile(webEntry);
  win.on("closed", () => { win = null; });
}

/* ---- 窗口控制 IPC ---- */
ipcMain.handle("win:minimize", () => win && win.minimize());
ipcMain.handle("win:maximize", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle("win:close", () => win && win.close());

app.whenReady().then(async () => {
  serverPort = await pickPort();
  const ok = await startServer(serverPort);
  if (!ok) {
    console.error("[magichub] 内置服务未能启动，端口 " + serverPort + " 无法访问");
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill(); } catch { /* 忽略 */ }
  }
});
