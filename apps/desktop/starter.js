/**
 * MagicHub 桌面端 · 内置服务启动器（由 utilityProcess 运行，CommonJS）
 * 通过动态 import 加载 ESM 的 server.js；服务目录由主进程经环境变量注入。
 * 调试日志写入 MAGICHUB_LOG 指向的文件（默认 %TEMP%\magichub-server.log）。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const logFile = process.env.MAGICHUB_LOG || path.join(os.tmpdir(), "magichub-server.log");
function log(msg) {
  try { fs.appendFileSync(logFile, new Date().toISOString() + " " + msg + "\n"); } catch { /* 忽略 */ }
}

const dir = process.env.MAGICHUB_SERVER_DIR;
log("starter start, dir=" + dir);
if (!dir) {
  log("MAGICHUB_SERVER_DIR 未设置");
  process.exit(1);
}

import(pathToFileURL(path.join(dir, "server.js")).href)
  .then(() => log("server import ok"))
  .catch((err) => {
    log("server import failed: " + (err && err.stack ? err.stack : String(err)));
    process.exit(1);
  });
