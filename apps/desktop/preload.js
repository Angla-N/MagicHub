/**
 * MagicHub 桌面端 · preload
 * 通过 contextBridge 暴露安全的窗口控制 API 给页面（window.magicHub）
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("magicHub", {
  isDesktop: true,
  minimize: () => ipcRenderer.invoke("win:minimize"),
  maximize: () => ipcRenderer.invoke("win:maximize"),
  close: () => ipcRenderer.invoke("win:close"),
});
