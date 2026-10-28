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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { extname, join, normalize, sep, basename } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { ensureStore, register, login, getUser, changePassword, AVATARS_DIR } from "./lib/user-store.js";
import {
  listUsers, listFriends, addFriend, listConversations, getMessages, addMessage, peerOf, markRead, DATA_DIR,
} from "./lib/chat-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PLUGINS_ROOT = process.env.MAGICHUB_PLUGINS_ROOT || join(__dirname, "..", "..", "plugins"); // 插件市场仓库（打包场景由主进程注入到数据目录）
const SEVEN_ZIP = process.env.MAGICHUB_7Z || ""; // 7za.exe（用于插件包解压/打包）
const UPLOADS_DIR = join(DATA_DIR, "uploads");
const MAX_BODY = 12 * 1024 * 1024; // 请求体上限 12MB（头像 + 图片/文件消息 base64）

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

/* ================= 插件市场 ================= */

/**
 * 插件目录模型（data/plugins/<id>/）：
 *  - manifest.json  插件声明（id/name/version/entry/icon/description…）
 *  - meta.json      市场元信息 { author, public, uploadedAt }（上传时写入，内置插件缺省 system/公开）
 *  - <id>.7z        原始安装包（客户端可下载；内置插件下载时按需现场打包）
 *  - 其余文件       插件本体（解压后的静态资源）
 */
const PLUGIN_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function pluginMetaPath(id) { return join(PLUGINS_ROOT, id, "meta.json"); }
function pluginArchivePath(id) { return join(PLUGINS_ROOT, id, id + ".7z"); }

/** 读取插件市场元信息（默认：内置/公开） */
function readPluginMeta(id) {
  const mf = pluginMetaPath(id);
  if (existsSync(mf)) {
    try { return JSON.parse(readFileSync(mf, "utf8")); } catch { /* 忽略 */ }
  }
  return { author: "system", public: true, uploadedAt: 0 };
}

/** 校验插件包解压结果：manifest.json 必须存在且合法，id 必须安全合法 */
function validateExtracted(dir, expectedId) {
  const mf = join(dir, "manifest.json");
  if (!existsSync(mf)) return { ok: false, error: "压缩包内缺少 manifest.json（请用插件打包工具生成）" };
  let m;
  try { m = JSON.parse(readFileSync(mf, "utf8")); } catch {
    return { ok: false, error: "manifest.json 不是合法 JSON" };
  }
  const id = String(m.id || "");
  if (!PLUGIN_ID_RE.test(id)) return { ok: false, error: "manifest.id 必须为 1-64 位字母/数字/_/-" };
  if (expectedId && id !== expectedId) return { ok: false, error: "插件 id 与文件名不一致：" + id };
  if (!String(m.name || "").trim()) return { ok: false, error: "manifest.name 不能为空" };
  if (!String(m.version || "").trim()) return { ok: false, error: "manifest.version 不能为空" };
  const entry = String(m.entry || "index.html");
  const entryFile = join(dir, entry);
  if (!existsSync(entryFile) || !statSync(entryFile).isFile()) {
    return { ok: false, error: "入口文件不存在：" + entry };
  }
  return { ok: true, manifest: m };
}

/** 用 7za 解压 <pack> 到 <dir>（-y 覆盖），返回是否成功 */
function extractArchive(pack, dir) {
  return new Promise((resolve) => {
    if (!SEVEN_ZIP || !existsSync(SEVEN_ZIP)) {
      resolve({ ok: false, error: "服务器未配置解压工具（7za.exe）" });
      return;
    }
    execFile(SEVEN_ZIP, ["x", pack, `-o${dir}`, "-y", "-bso0", "-bsp0"], { windowsHide: true }, (err) => {
      if (err) resolve({ ok: false, error: "解压失败：" + err.message });
      else resolve({ ok: true });
    });
  });
}

/** 用 7za 打包插件目录为 <pack>（下载内置插件时现场生成） */
function createArchive(dir, pack) {
  return new Promise((resolve) => {
    if (!SEVEN_ZIP || !existsSync(SEVEN_ZIP)) {
      resolve({ ok: false, error: "服务器未配置压缩工具（7za.exe）" });
      return;
    }
    execFile(SEVEN_ZIP, ["a", "-t7z", "-mx=5", "-y", "-bso0", "-bsp0", pack, join(dir, "*")], { windowsHide: true }, (err) => {
      if (err) resolve({ ok: false, error: "打包失败：" + err.message });
      else resolve({ ok: true });
    });
  });
}

/** 扫描 data/plugins/<plugin-id>/manifest.json，返回市场列表（含作者/公开状态） */
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
      const meta = readPluginMeta(dir);
      out.push({
        id: dir,
        name: m.name || dir,
        version: m.version || "0.0.0",
        description: m.description || "",
        entry: m.entry || "index.html",
        icon: m.icon || "",
        author: meta.author || "system",
        public: meta.public !== false,
        uploadedAt: meta.uploadedAt || 0,
        hasArchive: existsSync(pluginArchivePath(dir)),
      });
    } catch (err) {
      console.error(`[plugins] ${dir}/manifest.json 解析失败: ${err.message}`);
    }
  }
  return out;
}

/** 上传插件（7Z 包）：校验 → 解压 → 登记 meta.json → 入库 */
async function uploadPlugin(username, payload) {
  const name = String(payload.name || "");
  if (!/\.7z$/i.test(name)) return { ok: false, error: { code: "BAD_PACKAGE", message: "请上传 .7z 格式的插件包" } };
  const buf = decodeBase64Payload(payload.data);
  if (!buf.length) return { ok: false, error: { code: "BAD_PACKAGE", message: "包内容为空" } };
  if (buf.length > 10 * 1024 * 1024) return { ok: false, error: { code: "TOO_LARGE", message: "插件包不能超过 10MB" } };

  const tmpRoot = join(DATA_DIR, ".plugin-tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const tag = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const packPath = join(tmpRoot, tag + ".7z");
  const outDir = join(tmpRoot, tag);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(packPath, buf);

  const ex = await extractArchive(packPath, outDir);
  if (!ex.ok) {
    rmSync(tmpRoot, { recursive: true, force: true });
    return { ok: false, error: { code: "BAD_PACKAGE", message: ex.error } };
  }
  // 解压结果可能在子目录（不同打包工具的目录结构不同）→ 向下最多 2 层找含 manifest.json 的目录
  let root = outDir;
  try {
    for (let depth = 0; depth < 2; depth++) {
      if (existsSync(join(root, "manifest.json"))) break;
      const sub = readdirSync(root).find((d) => existsSync(join(root, d, "manifest.json")));
      if (!sub) break;
      root = join(root, sub);
    }
  } catch { /* 保持 root */ }

  const v = validateExtracted(root);
  if (!v.ok) {
    rmSync(tmpRoot, { recursive: true, force: true });
    return { ok: false, error: { code: "BAD_PACKAGE", message: v.error } };
  }
  const id = v.manifest.id;
  const dest = join(PLUGINS_ROOT, id);
  if (existsSync(dest)) {
    rmSync(tmpRoot, { recursive: true, force: true });
    return { ok: false, error: { code: "EXISTS", message: "插件「" + id + "」已存在（上传者可在插件市场删除后重新上传）" } };
  }
  mkdirSync(PLUGINS_ROOT, { recursive: true });
  try {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    if (root !== outDir) {
      // 子目录结构：把子目录内容移动到最终位置
      mkdirSync(dest, { recursive: true });
      for (const item of readdirSync(root)) {
        const s = join(root, item);
        const t = join(dest, item);
        if (statSync(s).isDirectory()) {
          // 递归拷贝
          mkdirSync(t, { recursive: true });
          for (const f of readdirSync(s)) copyFileSync(join(s, f), join(t, f));
        } else {
          copyFileSync(s, t);
        }
      }
    } else {
      copyFileSync(join(outDir, "manifest.json"), join(dest, "manifest.json"));
      for (const item of readdirSync(outDir)) {
        if (item === "manifest.json") continue;
        const s = join(outDir, item);
        const t = join(dest, item);
        if (statSync(s).isDirectory()) {
          mkdirSync(t, { recursive: true });
          for (const f of readdirSync(s)) copyFileSync(join(s, f), join(t, f));
        } else {
          copyFileSync(s, t);
        }
      }
    }
    copyFileSync(packPath, pluginArchivePath(id));
    writeFileSync(pluginMetaPath(id), JSON.stringify({ author: username, public: false, uploadedAt: Date.now() }, null, 2));
  } catch (err) {
    rmSync(tmpRoot, { recursive: true, force: true });
    return { ok: false, error: { code: "INTERNAL", message: "插件入库失败：" + err.message } };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log(`[plugins] ${username} 上传插件: ${id} v${v.manifest.version}`);
  return { ok: true, data: { id, name: v.manifest.name, version: v.manifest.version } };
}

/** 删除插件（仅上传者 / system 内置插件不可删） */
function removePlugin(id, username) {
  if (!PLUGIN_ID_RE.test(id)) return { ok: false, error: { code: "BAD_ID", message: "插件 id 不合法" } };
  const dir = join(PLUGINS_ROOT, id);
  if (!existsSync(dir)) return { ok: false, error: { code: "NOT_FOUND", message: "插件不存在" } };
  const meta = readPluginMeta(id);
  if (meta.author === "system") return { ok: false, error: { code: "FORBIDDEN", message: "内置插件不可删除" } };
  if (meta.author !== username) return { ok: false, error: { code: "FORBIDDEN", message: "只能删除自己上传的插件" } };
  rmSync(dir, { recursive: true, force: true });
  console.log(`[plugins] ${username} 删除插件: ${id}`);
  return { ok: true };
}

/** 设置插件公开状态（仅上传者） */
function setPluginVisibility(id, username, isPublic) {
  if (!PLUGIN_ID_RE.test(id)) return { ok: false, error: { code: "BAD_ID", message: "插件 id 不合法" } };
  const dir = join(PLUGINS_ROOT, id);
  if (!existsSync(dir)) return { ok: false, error: { code: "NOT_FOUND", message: "插件不存在" } };
  const meta = readPluginMeta(id);
  if (meta.author !== username) return { ok: false, error: { code: "FORBIDDEN", message: "只能管理自己上传的插件" } };
  meta.public = !!isPublic;
  writeFileSync(pluginMetaPath(id), JSON.stringify(meta, null, 2));
  return { ok: true, data: { public: meta.public } };
}

/** 准备插件安装包（有 7z 直接用；没有则现场打包） */
async function ensureArchive(id) {
  const dir = join(PLUGINS_ROOT, id);
  if (!existsSync(dir)) return null;
  const pack = pluginArchivePath(id);
  if (existsSync(pack)) return pack;
  const r = await createArchive(dir, pack);
  return r.ok ? pack : null;
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
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".rar": "application/x-rar-compressed",
  ".7z": "application/x-7z-compressed",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

/** 读取请求体（限制大小） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return resolve({ ok: false, reason: "too_large" });
      resolve({ ok: true, raw: Buffer.concat(chunks).toString("utf8") });
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

/** 保存上传文件到 data/uploads，返回静态访问路径 */
function saveUploadFile(base64, origName) {
  if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });
  const rawExt = extname(origName || "").toLowerCase();
  const safeExt = /^[.\w-]{1,12}$/.test(rawExt) ? rawExt : ".bin";
  const name = Date.now() + "-" + Math.random().toString(36).slice(2, 8) + safeExt;
  writeFileSync(join(UPLOADS_DIR, name), base64);
  return "/uploads/" + name;
}

/** 兼容带 data URL 前缀或纯 base64 两种输入 */
function decodeBase64Payload(s) {
  const m = /^data:[\w/.-]+;base64,(.*)$/s.exec(s || "");
  return Buffer.from(m ? m[1] : (s || ""), "base64");
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
        const body = await readBody(req);
        if (!body.ok) {
          return sendJson(res, 413, { ok: false, error: { code: "BODY_TOO_LARGE", message: "请求体过大（含附件请使用消息文件上传）" } });
        }
        payload = body.raw ? JSON.parse(body.raw) : {};
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

    // ---- 聊天 API：加好友 / 发消息 / 标记已读（POST，需登录） ----
    if (method === "POST" && (urlPath === "/api/friends/add" || urlPath === "/api/messages" || urlPath === "/api/conversations/read")) {
      const username = resolveToken(req);
      if (!username) {
        return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "未登录或会话已过期" } });
      }
      let payload;
      try {
        const body = await readBody(req);
        if (!body.ok) {
          return sendJson(res, 413, { ok: false, error: { code: "BODY_TOO_LARGE", message: "请求体过大（含附件请使用消息文件上传）" } });
        }
        payload = body.raw ? JSON.parse(body.raw) : {};
      } catch {
        return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "请求体不是合法 JSON" } });
      }
      let result;
      if (urlPath === "/api/friends/add") {
        result = addFriend(username, payload.username);
      } else if (urlPath === "/api/conversations/read") {
        result = markRead(payload.convId, username);
      } else {
        // 文件消息：base64 解码落盘（≤8MB），再存消息元数据
        let fileMeta = null;
        const pf = payload.file;
        if (pf && pf.data) {
          const buf = decodeBase64Payload(pf.data);
          if (buf.length > 8 * 1024 * 1024) {
            return sendJson(res, 400, { ok: false, error: { code: "FILE_TOO_LARGE", message: "文件不能超过 8MB" } });
          }
          fileMeta = {
            url: saveUploadFile(buf, pf.name),
            name: String(pf.name || "file"),
            type: String(pf.type || "application/octet-stream"),
            size: Number(pf.size) || buf.length,
          };
        }
        result = addMessage(payload.convId, username, payload.text, fileMeta);
        if (result.ok) {
          const peer = peerOf(payload.convId, username);
          if (peer) pushToPeer(peer, {
            type: "message",
            data: { convId: payload.convId, msg: result.data.msg, unread: result.data.peerUnread },
          });
        }
      }
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    // ---- 账号：修改密码（POST，需登录）----
    if (urlPath === "/api/account/password" && method === "POST") {
      const username = resolveToken(req);
      if (!username) {
        return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "未登录或会话已过期" } });
      }
      let payload = {};
      try {
        const b = await readBody(req);
        if (!b.ok) {
          return sendJson(res, 413, { ok: false, error: { code: "BODY_TOO_LARGE", message: "请求体过大" } });
        }
        payload = JSON.parse(b.raw || "{}");
      } catch {
        return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "请求体不是合法 JSON" } });
      }
      if (typeof payload.oldPassword !== "string" || typeof payload.newPassword !== "string") {
        return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "缺少原密码或新密码" } });
      }
      const result = changePassword(username, payload.oldPassword, payload.newPassword);
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    // ---- 插件市场：上传 / 公开设置（POST，需登录）----
    if (urlPath === "/api/plugins/upload" && method === "POST") {
      const username = resolveToken(req);
      if (!username) {
        return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "未登录或会话已过期" } });
      }
      let payload = {};
      try {
        const b = await readBody(req);
        if (!b.ok) {
          return sendJson(res, 413, { ok: false, error: { code: "BODY_TOO_LARGE", message: "请求体过大" } });
        }
        payload = JSON.parse(b.raw || "{}");
      } catch {
        return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "请求体不是合法 JSON" } });
      }
      const result = await uploadPlugin(username, payload);
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    if (method === "POST" && urlPath.startsWith("/api/plugins/") && urlPath.endsWith("/visibility")) {
      const username = resolveToken(req);
      if (!username) {
        return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "未登录或会话已过期" } });
      }
      const id = urlPath.slice("/api/plugins/".length, -"/visibility".length);
      let payload = {};
      try {
        const b = await readBody(req);
        payload = JSON.parse((b && b.raw) || "{}");
      } catch { /* payload 保持空 */ }
      const result = setPluginVisibility(id, username, payload.public);
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    // ---- 插件市场：删除（DELETE，需登录，仅作者）----
    if (method === "DELETE" && urlPath.startsWith("/api/plugins/")) {
      const username = resolveToken(req);
      if (!username) {
        return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "未登录或会话已过期" } });
      }
      const id = urlPath.slice("/api/plugins/".length);
      const result = removePlugin(id, username);
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

    // ---- 插件市场：列表 / 下载安装包 ----
    if (urlPath === "/api/plugins") {
      const username = resolveToken(req);
      const plugins = listPlugins().map((p) => ({ ...p, isOwner: !!username && p.author === username }));
      return sendJson(res, 200, { ok: true, data: { plugins } });
    }
    if (urlPath.startsWith("/api/plugins/") && urlPath.endsWith("/download")) {
      const username = resolveToken(req);
      if (!username) {
        return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "未登录或会话已过期" } });
      }
      const id = urlPath.slice("/api/plugins/".length, -"/download".length);
      const pack = await ensureArchive(id);
      if (!pack) {
        return sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "插件不存在" } });
      }
      const body = await readFile(pack);
      res.writeHead(200, {
        "Content-Type": "application/x-7z-compressed",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(basename(pack))}"`,
        "Content-Length": body.length,
      });
      res.end(body);
      return;
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

    // ---- 上传文件（图片/文档等）：/uploads/<file> ----
    if (urlPath.startsWith("/uploads/")) {
      const file = resolveInRoot(UPLOADS_DIR, urlPath.slice("/uploads/".length));
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
const wsClients = new Map(); // username -> Set<ws>（同一账号可多端在线，全部实时送达）

/** 定向推送给指定用户的所有在线连接 */
function pushToPeer(username, frame) {
  const conns = wsClients.get(username);
  if (!conns) return;
  const payload = JSON.stringify(frame);
  for (const c of conns) {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
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
        if (!wsClients.has(ws.username)) wsClients.set(ws.username, new Set());
        wsClients.get(ws.username).add(ws);
        ws.send(JSON.stringify({ type: "auth_ok", username: ws.username }));
        console.log(`[ws] ${ws.username} 已认证（在线 ${wss.clients.size} 连接）`);
      } else {
        ws.send(JSON.stringify({ type: "auth_fail", message: "登录已过期，请重新登录" }));
      }
    }
  });

  ws.on("close", () => {
    if (ws.username) {
      const conns = wsClients.get(ws.username);
      if (conns) {
        conns.delete(ws);
        if (!conns.size) wsClients.delete(ws.username);
      }
    }
    console.log(`[ws] client disconnected (online: ${wss.clients.size})`);
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
