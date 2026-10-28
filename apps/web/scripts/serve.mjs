/**
 * MagicHub 前端独立静态服务器（前后端分离）
 * 仅托管 apps/web 下的页面资源，不包含任何业务 API。
 * API / WebSocket 由 apps/server 提供（默认 3000），页面通过 CORS 跨域调用。
 *
 * 启动：
 *  cd apps/web
 *  npm start        # 默认 5173，可用 PORT 环境变量覆盖
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(__dirname, "..");
const PORT = Number(process.env.PORT) || 5173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const normalized = normalize(decoded).replace(/^([/\\])+/, "");
  const file = join(WEB_ROOT, normalized);
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + sep)) return null; // 路径穿越防护
  return file;
}

async function serve(res, file) {
  if (!file || !existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
    return;
  }
  const info = await stat(file);
  if (info.isDirectory()) return serve(res, join(file, "index.html"));
  const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
  const body = await readFile(file);
  res.writeHead(200, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": "no-cache" });
  res.end(body);
}

createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  try {
    const file = resolvePath(urlPath === "/" ? "/index.html" : urlPath);
    await serve(res, file);
  } catch (err) {
    console.error(`[web] ${urlPath} -> ${err.message}`);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("500 Internal Server Error");
  }
}).listen(PORT, () => {
  console.log(`MagicHub web frontend:`);
  console.log(`  http -> http://localhost:${PORT}`);
  console.log(`（API 请运行 apps/server，页面经 CORS 跨域调用）`);
});
