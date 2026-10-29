/**
 * MagicHub 桌面端 · preload
 * 通过 contextBridge 暴露安全的窗口控制 / 后台驻留 / 本地插件管理 API（window.magicHub）
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
  /* 系统通知（后台驻留时新消息桌面弹出） */
  notify: (title, body) => ipcRenderer.invoke("app:notify", title, body),
  /* 后台驻留 */
  getKeepInBackground: () => ipcRenderer.invoke("settings:getKeepInBackground"),
  setKeepInBackground: (val) => ipcRenderer.invoke("settings:setKeepInBackground", !!val),
  /* 本地插件 */
  listLocalPlugins: () => ipcRenderer.invoke("plugins:listLocal"),
  installPlugin: (id, buffer) => ipcRenderer.invoke("plugins:install", { id, buffer }),
  uninstallPlugin: (id) => ipcRenderer.invoke("plugins:uninstall", id),
  /* P2：#24 插件启用/禁用 */
  setPluginEnabled: (id, enabled) => ipcRenderer.invoke("plugins:setEnabled", id, !!enabled),
});
