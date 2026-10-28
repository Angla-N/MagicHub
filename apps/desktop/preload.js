/**
 * MagicHub 桌面端 · preload
 * 通过 contextBridge 暴露安全的窗口控制 API 与内置服务地址（window.magicHub）
 */
const { contextBridge, ipcRenderer } = require("electron");

// 主进程经 additionalArguments 注入，形如 --magichub-server-base=http://127.0.0.1:3000
const argv = process.argv || [];
const baseArg = argv.find((a) => a.startsWith("--magichub-server-base="));

contextBridge.exposeInMainWorld("magicHub", {
  isDesktop: true,
  serverBase: baseArg ? baseArg.slice("--magichub-server-base=".length) : null,
  minimize: () => ipcRenderer.invoke("win:minimize"),
  maximize: () => ipcRenderer.invoke("win:maximize"),
  close: () => ipcRenderer.invoke("win:close"),
});
