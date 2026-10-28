/**
 * MagicHub 后端（独立服务，前后端分离）
 *
 * 能力：
 *  1. 账号 API：POST /api/register（用户名/名字/密码/头像）、POST /api/login（返回 token）、GET /api/me
 *  2. 聊天 API：通讯录 /api/users、好友 /api/friends(+add)、会话 /api/conversations、消息 /api/messages
 *  3. 插件 API：GET /api/plugins（扫描 plugins/）、/plugins/<id>/ 静态服务
 *  4. 头像静态服务：/avatars/<file>
 *  5. WebSocket：客户端先发 {type:"auth",token} 绑定身份，新消息定向推送给会话对方
 *  6. CORS：允许前端独立部署（H5 或 Electron file://）跨域调用
 *
 * 启动：
 *  cd apps/server
 *  npm start     # 默认端口 3000，可用 PORT 环境变量覆盖
 *
 * 前端独立运行（不再由后端托管页面）：
 *  cd apps/web
 *  npm start     # 独立静态服务器，默认 5173
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { extname, join, normalize, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { ensureStore, register, login, getUser, AVATARS_DIR } from "./lib/user-store.js";
import {
  listUsers, listFriends, addFriend, listConversations, getMessages, addMessage, peerOf,
} from "./lib/chat-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PLUGINS_ROOT = process.env.MAGICHUB_PLUGINS_ROOT || join(__dirname, "..", "..", "plugins"); // 仓库根 plugins/（Electron 打包场景由主进程注入）
const MAX_BODY = 512 * 1024; // API 请求体上限 512KB（含头像 base64）

/* ---------- 登录会话（内存 token，重启后需重新登录） ---------- */
const sessions = new Map(); // token -> { username, expiresAt }

function issueToken(username) {
  const token = randomBytes(24).toString("hex");
  sessions.set(token, { username, expiresAt: Date.now() + 7 * 24 * 3600 * 1000 });
  return token;
}

function resolveToken(req) {
  const auth = req.headers.authorization || "";
  const m = /^Bearer\s+(\S+)$/.exec(auth);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(m[1]);
    return null;
  }
  return s.username;
}

ensureStore();

/* ================= 插件系统 ================= */

/**
 * 扫描 plugins/<plugin-id>/manifest.json，返回插件元信息列表。
 * 插件 = plugins/ 下一个文件夹 + manifest.json，放入即被发现（无需注册）。
 */
function listPlugins() {
  if (!existsSync(PLUGINS_ROOT)) return [];
  const out = [];
  for (const dir of readdirSync(PLUGINS_ROOT)) {
    const p = join(PLUGINS_ROOT, dir);
    if (!statSync(p).isDirectory()) continue;
    const mf = join(p, "manifest.json");
    if (!existsSync(mf)) continue;
    try {
      const m = JSON.parse(readFileSync(mf, "utf8"));
      out.push({
        id: dir,
        name: m.name || dir,
        version: m.version || "0.0.0",
        description: m.description || "",
        entry: m.entry || "index.html",
        icon: m.icon || "",
      });
    } catch (err) {
      console.error(`[plugins] ${dir}/manifest.json 解析失败: ${err.message}`);
    }
  }
  return out;
}

/** 解析 /plugins/<id>/<path> 为插件目录内的真实文件路径（防路径穿越） */
function resolvePluginPath(urlPath) {
  const parts = urlPath.split("/").filter(Boolean); // [id, ...rest]
  if (parts.length < 1) return null;
  const [id, ...rest] = parts;
  const base = join(PLUGINS_ROOT, id);
  if (!existsSync(base) || !statSync(base).isDirectory()) return null;

  if (rest.length === 0) {
    // 目录入口：按 manifest 的 entry 解析，默认 index.html
    let entry = "index.html";
    const mf = join(base, "manifest.json");
    if (existsSync(mf)) {
      try { entry = JSON.parse(readFileSync(mf, "utf8")).entry || "index.html"; } catch { /* 忽略 */ }
    }
    rest.push(entry);
  }

  const normalized = normalize(rest.join("/")).replace(/^([/\\])+/, "");
  const file = join(base, normalized);
  if (file !== base && !file.startsWith(base + sep)) return null;
  return file;
}

/* ================= HTTP：API + 静态资源 ================= */

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
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(payload));
}

/** 安全地把 URL 路径解析为 baseRoot 内的文件路径（防路径穿越） */
function resolveInRoot(baseRoot, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const normalized = normalize(decoded).replace(/^([/\\])+/, "");
  const file = join(baseRoot, normalized);
  if (file !== baseRoot && !file.startsWith(baseRoot + sep)) return null;
  return file;
}

async function serveStatic(res, file) {
  if (!file || !existsSync(file)) {
    sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "资源不存在" } });
    return;
  }
  const info = await stat(file);
  if (info.isDirectory()) {
    return serveStatic(res, join(file, "index.html"));
  }
  const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
  const body = await readFile(file);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

const httpServer = createServer(async (req, res) => {
  const method = req.method || "GET";
  const urlPath = (req.url || "/").split("?")[0];

  try {
    // ---- CORS 预检 ----
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      return res.end();
    }

    // ---- 账号 API ----
    if (method === "POST" && (urlPath === "/api/register" || urlPath === "/api/login")) {
      let payload;
      try {
        const raw = await readBody(req);
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "请求体不是合法 JSON" } });
      }

      let result;
      if (urlPath === "/api/register") {
        result = register(payload.username, payload.password, payload.displayName, payload.avatar);
      } else {
        result = login(payload.username, payload.password);
        if (result.ok) {
          result.data.token = issueToken(result.data.username);
        }
      }
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    // ---- 聊天 API：加好友 / 发消息（POST，需登录） ----
    if (method === "POST" && (urlPath === "/api/friends/add" || urlPath === "/api/messages")) {
      const username = resolveToken(req);
      if (!username) {
        return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "未登录或会话已过期" } });
      }
      let payload;
      try {
        const raw = await readBody(req);
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "请求体不是合法 JSON" } });
      }
      let result;
      if (urlPath === "/api/friends/add") {
        result = addFriend(username, payload.username);
      } else {
        result = addMessage(payload.convId, username, payload.text);
        if (result.ok) {
          const peer = peerOf(payload.convId, username);
          if (peer) pushToPeer(peer, { type: "message", data: { convId: payload.convId, msg: result.data.msg } });
        }
      }
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    if (method !== "GET" && method !== "HEAD") {
      return sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "不支持的方法" } });
    }

    // ---- 会话校验：GET /api/me ----
    if (urlPath === "/api/me") {
      const username = resolveToken(req);
      if (!username) {
        return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "未登录或会话已过期" } });
      }
      return sendJson(res, 200, { ok: true, data: getUser(username) });
    }

    // ---- 聊天 API：通讯录 / 好友 / 会话 / 消息历史（GET，需登录） ----
    if (urlPath === "/api/users" || urlPath === "/api/friends" || urlPath === "/api/conversations" || urlPath === "/api/messages") {
      const username = resolveToken(req);
      if (!username) {
        return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "未登录或会话已过期" } });
      }
      if (urlPath === "/api/users") {
        return sendJson(res, 200, { ok: true, data: { users: listUsers(username) } });
      }
      if (urlPath === "/api/friends") {
        return sendJson(res, 200, { ok: true, data: { friends: listFriends(username) } });
      }
      if (urlPath === "/api/conversations") {
        return sendJson(res, 200, { ok: true, data: { conversations: listConversations(username) } });
      }
      const qs = new URLSearchParams((req.url || "").split("?")[1] || "");
      const conv = qs.get("conv");
      if (!conv) {
        return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "缺少 conv 参数" } });
      }
      const messages = getMessages(conv, username);
      if (!messages) {
        return sendJson(res, 403, { ok: false, error: { code: "FORBIDDEN", message: "会话不存在或无权访问（请先添加好友）" } });
      }
      return sendJson(res, 200, { ok: true, data: { messages } });
    }

    // ---- 插件 API：插件列表 ----
    if (urlPath === "/api/plugins") {
      return sendJson(res, 200, { ok: true, data: { plugins: listPlugins() } });
    }

    // ---- 插件资源：/plugins/<id>/<path> ----
    if (urlPath.startsWith("/plugins/")) {
      return await serveStatic(res, resolvePluginPath(urlPath.slice("/plugins/".length)));
    }

    // ---- 头像：/avatars/<file> ----
    if (urlPath.startsWith("/avatars/")) {
      const file = resolveInRoot(AVATARS_DIR, urlPath.slice("/avatars/".length));
      return await serveStatic(res, file);
    }

    return sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "接口或资源不存在（前端页面请由 apps/web 独立服务提供）" } });
  } catch (err) {
    console.error(`[http] ${method} ${urlPath} -> ${err.message}`);
    return sendJson(res, 500, { ok: false, error: { code: "INTERNAL", message: "服务器内部错误" } });
  }
});

/* ================= WebSocket：登录认证 + 定向推送 ================= */

const wss = new WebSocketServer({ server: httpServer });
const wsClients = new Map(); // username -> ws（在线连接）

/** 定向推送给指定用户（对方在线则实时送达） */
function pushToPeer(username, frame) {
  const target = wsClients.get(username);
  if (target && target.readyState === WebSocket.OPEN) {
    target.send(JSON.stringify(frame));
  }
}

wss.on("connection", (ws) => {
  console.log(`[ws] client connected (total: ${wss.clients.size})`);

  ws.username = null;

  ws.on("message", (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (frame && frame.type === "auth" && frame.token) {
      const s = sessions.get(String(frame.token));
      if (s && s.expiresAt >= Date.now()) {
        ws.username = s.username;
        wsClients.set(ws.username, ws);
        ws.send(JSON.stringify({ type: "auth_ok", username: ws.username }));
        console.log(`[ws] ${ws.username} 已认证（在线 ${wsClients.size}）`);
      } else {
        ws.send(JSON.stringify({ type: "auth_fail", message: "登录已过期，请重新登录" }));
      }
    }
  });

  ws.on("close", () => {
    if (ws.username) wsClients.delete(ws.username);
    console.log(`[ws] client disconnected (online: ${wsClients.size})`);
  });

  ws.on("error", () => { /* close 统一处理 */ });
});

httpServer.listen(PORT, () => {
  console.log(`MagicHub server listening:`);
  console.log(`  api       -> http://localhost:${PORT}/api/*`);
  console.log(`  websocket -> ws://localhost:${PORT}`);
  console.log(`  plugins   -> ${PLUGINS_ROOT}`);
  console.log(`  avatars   -> ${AVATARS_DIR}`);
  console.log(`（前端页面由 apps/web 独立提供，本服务不托管页面）`);
});
