/**
 * MagicHub 后端 · V0.2
 *
 * 能力：
 *  1. 静态文件服务：托管 apps/web（H5 前端：/、/login.html、/css/*）
 *  2. 账号 API：POST /api/register、POST /api/login（JSON 存储 + scrypt 哈希）
 *  3. WebSocket 服务：连接即 hello，收到消息原样广播（连通验证）
 *
 * 启动：
 *  cd apps/server
 *  npm install   # 首次
 *  npm start     # 默认端口 3000，可用 PORT 环境变量覆盖
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { ensureStore, register, login } from "./lib/user-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const WEB_ROOT = join(__dirname, "..", "web");
const MAX_BODY = 64 * 1024; // API 请求体上限 64KB

ensureStore();

/* ================= HTTP：静态服务 + API ================= */

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

/** 读取请求体（限制大小） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(Buffer.concat(chunks).toString("utf8"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** 安全地把 URL 路径解析为 WEB_ROOT 内的文件路径 */
function resolveStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const normalized = normalize(decoded).replace(/^([/\\])+/, "");
  const file = join(WEB_ROOT, normalized);
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + sep)) return null; // 路径穿越防护
  return file;
}

async function serveStatic(res, file) {
  if (!file || !existsSync(file)) {
    sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "页面不存在" } });
    return;
  }
  const info = await stat(file);
  if (info.isDirectory()) {
    return serveStatic(res, join(file, "index.html"));
  }
  const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
  const body = await readFile(file);
  res.writeHead(200, { "Content-Type": type, "Content-Length": body.length });
  res.end(body);
}

const httpServer = createServer(async (req, res) => {
  const method = req.method || "GET";
  const urlPath = (req.url || "/").split("?")[0];

  try {
    // ---- API 路由 ----
    if (method === "POST" && (urlPath === "/api/register" || urlPath === "/api/login")) {
      let payload;
      try {
        const raw = await readBody(req);
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "请求体不是合法 JSON" } });
      }

      const result = urlPath === "/api/register"
        ? register(payload.username, payload.password)
        : login(payload.username, payload.password);

      return sendJson(res, result.ok ? 200 : 400, result);
    }

    if (method !== "GET" && method !== "HEAD") {
      return sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "不支持的方法" } });
    }

    // ---- 静态文件 ----
    const file = resolveStaticPath(urlPath === "/" ? "/index.html" : urlPath);
    return await serveStatic(res, file);
  } catch (err) {
    console.error(`[http] ${method} ${urlPath} -> ${err.message}`);
    return sendJson(res, 500, { ok: false, error: { code: "INTERNAL", message: "服务器内部错误" } });
  }
});

/* ================= WebSocket：连接 + 广播 ================= */

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  console.log(`[ws] client connected (total: ${wss.clients.size})`);

  ws.send(JSON.stringify({ type: "hello", msg: "已连接 MagicHub 服务" }));

  ws.on("message", (data) => {
    const text = data.toString();
    console.log(`[ws] recv: ${text}`);
    const frame = JSON.stringify({ type: "broadcast", text });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(frame);
      }
    }
  });

  ws.on("close", () => {
    console.log(`[ws] client disconnected (total: ${wss.clients.size})`);
  });

  ws.on("error", (err) => {
    console.error(`[ws] error: ${err.message}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`MagicHub server listening:`);
  console.log(`  http   -> http://localhost:${PORT}`);
  console.log(`  websocket -> ws://localhost:${PORT}`);
});
