/**
 * MagicHub 客户端（纯前端壳，不内置业务服务器）
 *
 * 职责：
 *  1. 创建无边框窗口（自绘标题栏，-webkit-app-region 拖拽）
 *  2. 加载本地前端页面（login.html / index.html）
 *  3. 通过 preload 暴露窗口控制 API（window.magicHub）
 *
 * 业务数据（账号、聊天记录、文件下载）全部由独立的 MagicHub-Server 提供，
 * 客户端在登录页填写服务器地址（默认本机 http://localhost:3000）。
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

app.setName("MagicHub");

let win = null;

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

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
