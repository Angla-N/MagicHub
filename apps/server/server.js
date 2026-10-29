/**
 * MagicHub 后端（独立服务，前后端分离）
 *
 * 能力：
 *  1. 账号 API：POST /api/register（用户名/名字/密码/头像 + 算术验证码）、POST /api/login（返回 token）、GET /api/me
 *  2. 聊天 API：通讯录 /api/users、好友 /api/friends(+add)、会话 /api/conversations、消息 /api/messages
 *  3. 插件 API：GET /api/plugins（扫描 plugins/）、/plugins/<id>/ 静态服务
 *  4. 头像静态服务：/avatars/<file>；文件消息静态服务：/uploads/<file>（签名 URL 鉴权）
 *  5. WebSocket：客户端先发 {type:"auth",token} 绑定身份，新消息定向推送给会话对方
 *  6. CORS：Origin 白名单（前端独立部署：H5 / Electron file://）
 *
 * 安全（v0.2.0）：
 *  - 登录 token 为签名 JWT（HMAC-SHA256），密钥持久化到 data/jwt-secret，重启不掉线；
 *    载荷携带 tokenVersion，改密码后旧 token 全部失效
 *  - 登录失败锁定（IP+账号 5 次锁 15 分钟）+ 登录/注册滑动窗口限流
 *  - 注册需算术验证码（服务端出题、一次性、5 分钟有效）
 *  - /uploads/ 文件需签名 URL（5 分钟有效）才能访问
 *  - 上传文件扩展名白名单 + 文件头魔数校验（拒绝伪造扩展名/恶意脚本）
 *  - CORS Origin 白名单
 *  - 插件包解压后限制文件数/总大小（zip 炸弹防护）
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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, renameSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { extname, join, normalize, sep, basename } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { ensureStore, register, login, getUser, getUserRecord, changePassword, AVATARS_DIR } from "./lib/user-store.js";
import {
  listUsers, listFriends, addFriend, removeFriend, listConversations, getMessages, addMessage, peerOf, markRead,
  ensureChatStore, DATA_DIR,
} from "./lib/chat-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PLUGINS_ROOT = process.env.MAGICHUB_PLUGINS_ROOT || join(__dirname, "..", "..", "plugins"); // 插件市场仓库（打包场景由主进程注入到数据目录）
const SEVEN_ZIP = process.env.MAGICHUB_7Z || ""; // 7za.exe（用于插件包解压/打包）
const UPLOADS_DIR = join(DATA_DIR, "uploads");
const MAX_BODY = 12 * 1024 * 1024; // 请求体上限 12MB（头像 + 图片/文件消息 base64）
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000; // token 有效期 7 天

/* ================= JWT：签名 token（重启不掉线，改密可吊销） ================= */

const JWT_SECRET_FILE = join(DATA_DIR, "jwt-secret");

function loadJwtSecret() {
  try {
    if (existsSync(JWT_SECRET_FILE)) {
      const s = readFileSync(JWT_SECRET_FILE, "utf8").trim();
      if (s.length >= 16) return s;
    }
  } catch { /* 忽略 */ }
  const s = randomBytes(32).toString("hex");
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(JWT_SECRET_FILE, s, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.error(`[auth] 无法持久化 JWT 密钥（token 重启后仍将失效）: ${err.message}`);
  }
  return s;
}
const JWT_SECRET = loadJwtSecret();

function signToken(username, tokenVersion) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ u: username, v: tokenVersion || 0, exp })).toString("base64url");
  const sig = createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}

function verifyToken(token) {
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(token || ""));
  if (!m) return null;
  const expect = createHmac("sha256", JWT_SECRET).update(m[1]).digest("base64url");
  const got = Buffer.from(m[2]);
  const expBuf = Buffer.from(expect);
  if (expBuf.length !== got.length || !timingSafeEqual(expBuf, got)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")); } catch { return null; }
  if (!p || typeof p.u !== "string" || typeof p.exp !== "number" || p.exp < Date.now()) return null;
  // tokenVersion 校验：改密码后旧 token 失效
  const record = getUserRecord(p.u);
  if (!record) return null;
  if ((record.tokenVersion || 0) !== (p.v || 0)) return null;
  return p.u;
}

function issueToken(username) {
  const record = getUserRecord(username);
  return signToken(username, (record && record.tokenVersion) || 0);
}

function resolveToken(req) {
  const auth = req.headers.authorization || "";
  const m = /^Bearer\s+(\S+)$/.exec(auth);
  if (!m) return null;
  try { return verifyToken(m[1]); } catch { return null; }
}

/* ================= 限流与验证码 ================= */

const LOGIN_FAILS = new Map(); // "login:<ip>:<user>" -> { fail, until, lockedUntil }
const RATE_HITS = new Map();   // "reg:<ip>" / "login:<ip>" -> { hits, until }
const CAPTCHAS = new Map();    // id -> { answer, exp }

/** 登录失败锁定：5 次失败锁 15 分钟（按 IP+账号） */
function loginKey(ip, username) { return "login:" + (ip || "?") + ":" + String(username || "").toLowerCase(); }
function lockedRemaining(key) {
  const e = LOGIN_FAILS.get(key);
  if (e && e.lockedUntil && e.lockedUntil > Date.now()) return Math.ceil((e.lockedUntil - Date.now()) / 1000);
  return 0;
}
function recordLoginFail(key) {
  const now = Date.now();
  let e = LOGIN_FAILS.get(key);
  if (!e || e.until < now) e = { fail: 0, until: now + 60 * 60 * 1000, lockedUntil: 0 };
  e.fail++;
  if (e.fail >= 5) e.lockedUntil = now + 15 * 60 * 1000;
  LOGIN_FAILS.set(key, e);
  return e;
}
function clearLoginFails(key) { LOGIN_FAILS.delete(key); }

/** 滑动窗口计数限流：超过 limit 返回 true */
function hitRate(key, limit, windowMs) {
  const now = Date.now();
  let e = RATE_HITS.get(key);
  if (!e || e.until < now) e = { hits: 0, until: now + windowMs };
  e.hits++;
  RATE_HITS.set(key, e);
  return e.hits > limit;
}

/** 注册算术验证码：服务端出题，一次性，5 分钟有效 */
function newCaptcha() {
  const a = 1 + Math.floor(Math.random() * 9);
  const b = 1 + Math.floor(Math.random() * 9);
  const id = randomBytes(8).toString("hex");
  CAPTCHAS.set(id, { answer: String(a + b), exp: Date.now() + 5 * 60 * 1000 });
  // 懒清理：超过 400 个时清掉过期项
  if (CAPTCHAS.size > 400) {
    const now = Date.now();
    for (const [k, v] of CAPTCHAS) if (v.exp < now) CAPTCHAS.delete(k);
  }
  return { id, question: `${a} + ${b} = ?` };
}
function checkCaptcha(id, answer) {
  const e = CAPTCHAS.get(String(id || ""));
  if (!e || e.exp < Date.now()) { CAPTCHAS.delete(String(id || "")); return false; }
  if (String(answer || "").trim() !== e.answer) return false;
  CAPTCHAS.delete(String(id || "")); // 一次性
  return true;
}

// 定时清理限流与验证码（不阻止进程退出）
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of LOGIN_FAILS) {
    if ((!e.lockedUntil || e.lockedUntil < now) && e.until < now) LOGIN_FAILS.delete(k);
  }
  for (const [k, e] of RATE_HITS) if (e.until < now) RATE_HITS.delete(k);
  for (const [k, v] of CAPTCHAS) if (v.exp < now) CAPTCHAS.delete(k);
}, 60 * 1000).unref();

/* ================= CORS Origin 白名单 ================= */

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173", "http://127.0.0.1:5173",
  "http://localhost:3000", "http://127.0.0.1:3000",
];
const ALLOWED_ORIGINS = new Set([
  ...DEFAULT_ALLOWED_ORIGINS,
  ...(process.env.MAGICHUB_CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
]);

/** 按请求 Origin 计算允许的 CORS 头；null 表示拒绝（不返回 CORS 头，浏览器拦截） */
function corsAllow(origin) {
  if (!origin || origin === "null") return "*"; // 无 Origin（同源/curl）或 file:// 页面（Electron）
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

await ensureStore();
ensureChatStore();

/* ================= 插件市场 ================= */

/**
 * 插件存储模型（data/plugins/）—— 只保留压缩包，不留源码：
 *  - <id>.7z         插件安装包（唯一存储形态，客户端下载后本地解压运行）
 *  - .meta/<id>.json 市场元信息 { author, public, uploadedAt }
 *  - .icons/<id>.<ext> 从 .7z 内提取的图标（上传时提取，市场列表直接引用）
 */
const PLUGIN_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const PLUGIN_MAX_FILES = 200;   // 解压后文件数上限（zip 炸弹防护）
const PLUGIN_MAX_BYTES = 50 * 1024 * 1024; // 解压后总大小上限

function pluginMetaPath(id) { return join(PLUGINS_ROOT, ".meta", id + ".json"); }
function pluginArchivePath(id) { return join(PLUGINS_ROOT, id + ".7z"); }
/** 插件图标提取目录：上传/种子的 .7z 内的 icon 文件会被提取到 .icons/<id>.<ext>，供列表直接引用 */
function pluginIconDir() { return join(PLUGINS_ROOT, ".icons"); }
function pluginIconPath(id, ext) { return join(PLUGINS_ROOT, ".icons", id + (ext || "")); }
/** 找该插件已提取的图标文件（返回绝对路径，无则 null） */
function findPluginIcon(id) {
  const dir = pluginIconDir();
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (f === id || f.startsWith(id + ".")) return join(dir, f);
  }
  return null;
}
/** 把插件目录内 manifest.icon 指向的文件复制到 .icons/<id><ext>（防路径穿越，仅取 basename） */
function extractPluginIcon(id, pluginDir, iconName) {
  if (!iconName || typeof iconName !== "string") return;
  const base = basename(String(iconName).split("?")[0]);
  if (!/^[a-zA-Z0-9_.\-]+$/.test(base)) return;
  const src = join(pluginDir, base);
  if (!existsSync(src) || !statSync(src).isFile()) return;
  try {
    mkdirSync(pluginIconDir(), { recursive: true });
    copyFileSync(src, pluginIconPath(id, extname(base)));
  } catch (err) {
    console.error(`[plugins] 提取 ${id} 图标失败: ${err.message}`);
  }
}

/** 读取插件市场元信息（默认：内置/公开） */
function readPluginMeta(id) {
  const mf = pluginMetaPath(id);
  if (existsSync(mf)) {
    try { return JSON.parse(readFileSync(mf, "utf8")); } catch { /* 忽略 */ }
  }
  return { author: "system", public: true, uploadedAt: 0 };
}

/** 校验插件包解压结果：manifest.json 必须存在且合法，id 必须安全合法，entry 防路径穿越 */
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
  // entry 防路径穿越：规范化后必须位于插件目录内
  const entry = String(m.entry || "index.html");
  const entryFile = join(dir, entry);
  const relEntry = normalize(entry).replace(/^([/\\])+/, "");
  const safe = relEntry && relEntry !== ".." && !relEntry.startsWith(".." + sep) && !relEntry.includes(".." + sep);
  if (!safe || !existsSync(entryFile) || !statSync(entryFile).isFile()) {
    return { ok: false, error: "入口文件不存在或路径不合法：" + entry };
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

/** 用 7za 打包插件目录为 <pack>（下载内置插件时现场生成；在目录内打包保证包根即插件内容） */
function createArchive(dir, pack) {
  return new Promise((resolve) => {
    if (!SEVEN_ZIP || !existsSync(SEVEN_ZIP)) {
      resolve({ ok: false, error: "服务器未配置压缩工具（7za.exe）" });
      return;
    }
    execFile(SEVEN_ZIP, ["a", "-t7z", "-mx=5", "-y", "-bso0", "-bsp0", pack, "*"], { windowsHide: true, cwd: dir }, (err) => {
      if (err) resolve({ ok: false, error: "打包失败：" + err.message });
      else resolve({ ok: true });
    });
  });
}

/** 解压目录规模统计与上限校验（zip 炸弹防护）：超限抛错 */
function assertArchiveLimits(root) {
  let files = 0, bytes = 0;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else {
        files++;
        bytes += st.size;
        if (files > PLUGIN_MAX_FILES || bytes > PLUGIN_MAX_BYTES) {
          throw new Error(`插件包解压后过大（>${PLUGIN_MAX_FILES} 个文件 / >${Math.round(PLUGIN_MAX_BYTES / 1024 / 1024)}MB），疑似压缩炸弹`);
        }
      }
    }
  }
  return { files, bytes };
}

/** 扫描插件市场（data/plugins/*.7z + .meta/*.json；兼容旧源码目录），返回市场列表 */
function listPlugins() {
  if (!existsSync(PLUGINS_ROOT)) return [];
  const out = [];
  const seen = new Set();
  // 1) .7z 存档为主：元数据读 .meta/<id>.json
  for (const name of readdirSync(PLUGINS_ROOT)) {
    const m = /^([a-zA-Z0-9_-]{1,64})\.7z$/.exec(name);
    if (!m) continue;
    const id = m[1];
    const meta = readPluginMeta(id);
    const iconFile = findPluginIcon(id);
    out.push({
      id,
      name: (meta.manifest && meta.manifest.name) || id,
      version: (meta.manifest && meta.manifest.version) || "0.0.0",
      description: (meta.manifest && meta.manifest.description) || "",
      entry: (meta.manifest && meta.manifest.entry) || "index.html",
      icon: (meta.manifest && meta.manifest.icon) || "",
      iconUrl: iconFile ? "/icons/" + basename(iconFile) : "",
      author: meta.author || "system",
      public: meta.public !== false,
      uploadedAt: meta.uploadedAt || 0,
      hasArchive: true,
    });
    seen.add(id);
  }
  // 2) 兼容：旧源码目录（含 manifest.json，开发仓库内置插件）→ 下载时现场打包
  for (const dir of readdirSync(PLUGINS_ROOT)) {
    const p = join(PLUGINS_ROOT, dir);
    if (seen.has(dir) || !statSync(p).isDirectory()) continue;
    const mf = join(p, "manifest.json");
    if (!existsSync(mf)) continue;
    try {
      const m = JSON.parse(readFileSync(mf, "utf8"));
      const meta = readPluginMeta(dir);
      const iconFile = findPluginIcon(dir);
      out.push({
        id: dir,
        name: m.name || dir,
        version: m.version || "0.0.0",
        description: m.description || "",
        entry: m.entry || "index.html",
        icon: m.icon || "",
        iconUrl: iconFile ? "/icons/" + basename(iconFile) : (m.icon ? "/plugins/" + encodeURIComponent(dir) + "/" + m.icon : ""),
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

/** 上传插件（7Z 包）：校验 → 解压（临时目录）→ 炸弹防护 → 只保留 .7z 存档 + .meta 元数据 */
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
  // 解压规模校验（zip 炸弹防护）
  try {
    assertArchiveLimits(outDir);
  } catch (err) {
    rmSync(tmpRoot, { recursive: true, force: true });
    return { ok: false, error: { code: "BAD_PACKAGE", message: err.message } };
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
  if (existsSync(pluginArchivePath(id)) || existsSync(join(PLUGINS_ROOT, id))) {
    rmSync(tmpRoot, { recursive: true, force: true });
    return { ok: false, error: { code: "EXISTS", message: "插件「" + id + "」已存在（可在插件市场中删除后重新上传）" } };
  }
  mkdirSync(PLUGINS_ROOT, { recursive: true });
  mkdirSync(join(PLUGINS_ROOT, ".meta"), { recursive: true });
  try {
    copyFileSync(packPath, pluginArchivePath(id));
    const meta = {
      author: username,
      public: false,
      uploadedAt: Date.now(),
      manifest: {
        name: v.manifest.name,
        version: v.manifest.version,
        description: v.manifest.description || "",
        entry: v.manifest.entry || "index.html",
        icon: v.manifest.icon || "",
      },
    };
    writeFileSync(pluginMetaPath(id), JSON.stringify(meta, null, 2));
    // 提取 .7z 内的图标到 .icons/（市场列表直接引用，无需解压包）
    extractPluginIcon(id, root, v.manifest.icon);
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
  const meta = readPluginMeta(id);
  if (meta.author === "system") return { ok: false, error: { code: "FORBIDDEN", message: "内置插件不可删除" } };
  if (meta.author !== username) return { ok: false, error: { code: "FORBIDDEN", message: "只能删除自己上传的插件" } };
  if (!existsSync(pluginArchivePath(id)) && !existsSync(join(PLUGINS_ROOT, id))) {
    return { ok: false, error: { code: "NOT_FOUND", message: "插件不存在" } };
  }
  rmSync(pluginArchivePath(id), { force: true });
  rmSync(pluginMetaPath(id), { force: true });
  const iconFile = findPluginIcon(id);
  if (iconFile) rmSync(iconFile, { force: true });
  rmSync(join(PLUGINS_ROOT, id), { recursive: true, force: true }); // 兼容旧源码目录
  console.log(`[plugins] ${username} 删除插件: ${id}`);
  return { ok: true };
}

/** 设置插件公开状态（仅上传者） */
function setPluginVisibility(id, username, isPublic) {
  if (!PLUGIN_ID_RE.test(id)) return { ok: false, error: { code: "BAD_ID", message: "插件 id 不合法" } };
  if (!existsSync(pluginArchivePath(id)) && !existsSync(join(PLUGINS_ROOT, id))) {
    return { ok: false, error: { code: "NOT_FOUND", message: "插件不存在" } };
  }
  const meta = readPluginMeta(id);
  if (meta.author !== username) return { ok: false, error: { code: "FORBIDDEN", message: "只能管理自己上传的插件" } };
  meta.public = !!isPublic;
  mkdirSync(join(PLUGINS_ROOT, ".meta"), { recursive: true });
  writeFileSync(pluginMetaPath(id), JSON.stringify(meta, null, 2));
  return { ok: true, data: { public: meta.public } };
}

/** 准备插件安装包（有 .7z 直接用；旧源码目录现场打包落盘后复用） */
async function ensureArchive(id) {
  const pack = pluginArchivePath(id);
  if (existsSync(pack)) return pack;
  const dir = join(PLUGINS_ROOT, id);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
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

function corsHeaders(origin) {
  const allow = corsAllow(origin);
  if (allow === null) return null;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function sendJson(res, status, payload) {
  const origin = (res.req && res.req.headers && res.req.headers.origin) || "";
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  const cors = corsHeaders(origin);
  if (cors) Object.assign(headers, cors);
  res.writeHead(status, headers);
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

/* ---------- 上传文件安全：扩展名白名单 + 文件头魔数校验 ---------- */

const UPLOAD_EXT_WHITELIST = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".txt", ".md",
  ".zip", ".rar", ".7z",
  ".mp3", ".wav", ".mp4", ".mov",
]);

/** 按文件头魔数识别真实类型；无法识别返回 null */
function sniffType(buf) {
  if (!buf || buf.length < 4) return null;
  const head = (s, off) => buf.slice(off || 0, (off || 0) + s.length).toString("latin1");
  // 图片
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && (head("GIF87a") === "GIF87a" || head("GIF89a") === "GIF89a")) return "gif";
  if (buf.length >= 12 && head("RIFF") === "RIFF" && head("WEBP", 8) === "WEBP") return "webp";
  // 文档
  if (buf.length >= 5 && head("%PDF-") === "%PDF-") return "pdf";
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return "cfb"; // doc/xls/ppt 旧格式
  if (buf.length >= 4 && buf.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "zip"; // zip / docx/xlsx/pptx
  // 压缩包
  if (buf.length >= 6 && buf.slice(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return "7z";
  if (buf.length >= 7 && head("Rar!\x1a\x07") === "Rar!\x1a\x07") return "rar";
  // 文本
  if (buf.length >= 1024 && !buf.slice(0, 1024).includes(0)) return "text"; // 前 1KB 无 NUL，视为文本
  // 音视频
  if (buf.length >= 4 && head("ID3") === "ID3") return "mp3";
  if (buf.length >= 3 && buf[0] === 0xff && (buf[1] === 0xfb || buf[1] === 0xf2 || buf[1] === 0xf3 || buf[1] === 0xfa)) return "mp3";
  if (buf.length >= 12 && head("RIFF") === "RIFF" && head("WAVE", 8) === "WAVE") return "wav";
  if (buf.length >= 8 && head("ftyp", 4) === "ftyp") return "mp4";
  return null;
}

/** 扩展名与魔数匹配表（value 可为数组） */
const EXT_SNIFF = {
  ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif", ".webp": "webp",
  ".pdf": "pdf",
  ".doc": ["cfb", "zip"], ".docx": "zip", ".xls": ["cfb", "zip"], ".xlsx": "zip",
  ".ppt": ["cfb", "zip"], ".pptx": "zip",
  ".txt": "text", ".md": "text",
  ".zip": "zip", ".rar": "rar", ".7z": "7z",
  ".mp3": "mp3", ".wav": "wav", ".mp4": ["mp4", "quicktime"], ".mov": ["mp4", "quicktime"],
};

/** 校验上传内容：扩展名在白名单且魔数匹配；返回 { ok } 或 { ok:false, error } */
function validateUpload(buf, origName) {
  const ext = extname(origName || "").toLowerCase();
  if (!UPLOAD_EXT_WHITELIST.has(ext)) {
    return { ok: false, error: "文件类型不受支持（仅允许图片/常见文档/压缩包/音视频，禁止脚本与网页文件）" };
  }
  const sniff = sniffType(buf);
  const expect = EXT_SNIFF[ext];
  const ok = sniff !== null && (Array.isArray(expect) ? expect.includes(sniff) : expect === sniff);
  if (!ok) {
    return { ok: false, error: "文件内容与扩展名不符，已拒绝（请确认文件未损坏或未被改名）" };
  }
  return { ok: true };
}

/** 保存上传文件到 data/uploads（校验通过后），返回静态访问路径 */
function saveUploadFile(base64, origName) {
  const buf = decodeBase64Payload(base64);
  if (!buf.length) return null;
  const v = validateUpload(buf, origName);
  if (!v.ok) return null;
  if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });
  const rawExt = extname(origName || "").toLowerCase();
  const safeExt = /^[.\w-]{1,12}$/.test(rawExt) ? rawExt : ".bin";
  const name = Date.now() + "-" + randomBytes(4).toString("hex") + safeExt;
  // 二进制原子写
  const file = join(UPLOADS_DIR, name);
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  writeFileSync(tmp, buf);
  try { renameSync(tmp, file); } catch { rmSync(tmp, { force: true }); throw new Error("写入失败"); }
  return "/uploads/" + name;
}

/** 上传文件签名 URL：/uploads/<file>?sig=..&exp=..（5 分钟有效，需登录获取） */
function signUploadPath(path) {
  const exp = Date.now() + 5 * 60 * 1000;
  const data = path + "|" + exp;
  const sig = createHmac("sha256", JWT_SECRET).update(data).digest("hex");
  return "/uploads/" + path.slice("/uploads/".length) + "?sig=" + sig + "&exp=" + exp;
}
function verifyUploadSig(path, qs) {
  const sig = qs.get("sig");
  const exp = Number(qs.get("exp") || 0);
  if (!sig || !exp || exp < Date.now()) return false;
  const expect = createHmac("sha256", JWT_SECRET).update(path + "|" + exp).digest("hex");
  return timingSafeEqual(Buffer.from(expect), Buffer.from(String(sig)));
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
  const headers = {
    "Content-Type": type,
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  };
  // 静态服务兜底：脚本/网页类文件一律附件下载，绝不内联渲染
  const ext = extname(file).toLowerCase();
  if (ext === ".html" || ext === ".svg" || ext === ".js") headers["Content-Disposition"] = "attachment";
  const origin = (res.req && res.req.headers && res.req.headers.origin) || "";
  const cors = corsHeaders(origin);
  if (cors) Object.assign(headers, cors);
  res.writeHead(200, headers);
  res.end(body);
}

const httpServer = createServer(async (req, res) => {
  const method = req.method || "GET";
  const urlPath = (req.url || "/").split("?")[0];
  const qs = new URLSearchParams((req.url || "").split("?")[1] || "");
  const origin = req.headers.origin || "";

  try {
    // ---- CORS 预检 ----
    if (method === "OPTIONS") {
      const cors = corsHeaders(origin);
      if (!cors) {
        res.writeHead(403);
        return res.end("Origin not allowed");
      }
      res.writeHead(204, cors);
      return res.end();
    }

    // ---- 注册验证码：GET /api/register/captcha ----
    if (method === "GET" && urlPath === "/api/register/captcha") {
      // 防止脚本刷题：同 IP 每分钟最多 20 次
      if (hitRate("captcha:" + (req.socket.remoteAddress || "?"), 20, 60 * 1000)) {
        return sendJson(res, 429, { ok: false, error: { code: "RATE_LIMITED", message: "获取验证码过于频繁，请稍后再试" } });
      }
      return sendJson(res, 200, { ok: true, data: newCaptcha() });
    }

    // ---- 账号 API：注册（需验证码）/ 登录（限流） ----
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
      const ip = req.socket.remoteAddress || "?";

      let result;
      if (urlPath === "/api/register") {
        // 注册滑动限流：同 IP 60 分钟内最多 10 次
        if (hitRate("reg:" + ip, 10, 60 * 60 * 1000)) {
          return sendJson(res, 429, { ok: false, error: { code: "RATE_LIMITED", message: "注册过于频繁，请 1 小时后再试" } });
        }
        // 算术验证码：服务端出题，一次性
        if (!checkCaptcha(payload.captchaId, payload.captchaAnswer)) {
          return sendJson(res, 400, { ok: false, error: { code: "BAD_CAPTCHA", message: "验证码错误或已过期，请刷新后重试" } });
        }
        result = await register(payload.username, payload.password, payload.displayName, payload.avatar);
      } else {
        // 登录：同 IP 15 分钟内最多 60 次尝试（防多账号枚举）
        if (hitRate("login:" + ip, 60, 15 * 60 * 1000)) {
          return sendJson(res, 429, { ok: false, error: { code: "RATE_LIMITED", message: "登录尝试过于频繁，请稍后再试" } });
        }
        // 登录失败锁定：IP+账号 5 次失败锁 15 分钟
        const key = loginKey(ip, payload.username);
        const locked = lockedRemaining(key);
        if (locked > 0) {
          return sendJson(res, 429, { ok: false, error: { code: "LOCKED", message: `尝试次数过多，请 ${Math.ceil(locked / 60)} 分钟后重试` } });
        }
        result = await login(payload.username, payload.password);
        if (result.ok) {
          result.data.token = issueToken(result.data.username);
          clearLoginFails(key);
        } else {
          const e = recordLoginFail(key);
          const remain = e.lockedUntil && e.lockedUntil > Date.now() ? Math.ceil((e.lockedUntil - Date.now()) / 1000) : 0;
          if (remain > 0) {
            result.error = { code: "LOCKED", message: `尝试次数过多，请 ${Math.ceil(remain / 60)} 分钟后重试` };
          }
        }
      }
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    // ---- 聊天 API：加/删好友 / 发消息 / 标记已读（POST，需登录） ----
    if (method === "POST" && (urlPath === "/api/friends/add" || urlPath === "/api/friends/remove" || urlPath === "/api/messages" || urlPath === "/api/conversations/read")) {
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
      } else if (urlPath === "/api/friends/remove") {
        result = removeFriend(username, payload.username);
      } else if (urlPath === "/api/conversations/read") {
        result = markRead(payload.convId, username);
      } else {
        // 文件消息：base64 解码 → 类型/魔数校验 → 落盘（≤8MB），再存消息元数据
        let fileMeta = null;
        const pf = payload.file;
        if (pf && pf.data) {
          const buf = decodeBase64Payload(pf.data);
          if (buf.length > 8 * 1024 * 1024) {
            return sendJson(res, 400, { ok: false, error: { code: "FILE_TOO_LARGE", message: "文件不能超过 8MB" } });
          }
          const savedUrl = saveUploadFile(pf.data, pf.name); // 内部做扩展名白名单 + 魔数校验
          if (!savedUrl) {
            return sendJson(res, 400, { ok: false, error: { code: "FILE_REJECTED", message: "文件类型不受支持或内容与扩展名不符" } });
          }
          fileMeta = {
            url: savedUrl,
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

    // ---- 账号：修改密码（POST，需登录；改密后旧 token 全部失效）----
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
      const result = await changePassword(username, payload.oldPassword, payload.newPassword);
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

    // ---- 上传文件签名 URL：GET /api/uploads/sign?path=/uploads/<file>（需登录）----
    if (urlPath === "/api/uploads/sign") {
      const username = resolveToken(req);
      if (!username) {
        return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "未登录或会话已过期" } });
      }
      const path = qs.get("path") || "";
      if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(path)) {
        return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "路径不合法" } });
      }
      if (!existsSync(join(UPLOADS_DIR, basename(path)))) {
        return sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "文件不存在或已过期" } });
      }
      return sendJson(res, 200, { ok: true, data: { url: signUploadPath(path) } });
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
      const conv = qs.get("conv");
      if (!conv) {
        return sendJson(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "缺少 conv 参数" } });
      }
      const messages = getMessages(conv, username);
      if (messages === null) {
        return sendJson(res, 403, { ok: false, error: { code: "FORBIDDEN", message: "会话不存在或无权访问（请先添加好友）" } });
      }
      return sendJson(res, 200, { ok: true, data: { messages } });
    }

    // ---- 插件市场：列表 / 下载安装包 ----
    if (urlPath === "/api/plugins") {
      const username = resolveToken(req);
      const plugins = listPlugins()
        .filter((p) => p.public !== false || (username && p.author === username))
        .map((p) => ({ ...p, isOwner: !!username && p.author === username }));
      return sendJson(res, 200, { ok: true, data: { plugins } });
    }
    if (urlPath.startsWith("/api/plugins/") && urlPath.endsWith("/download")) {
      const username = resolveToken(req);
      if (!username) {
        return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "未登录或会话已过期" } });
      }
      const id = urlPath.slice("/api/plugins/".length, -"/download".length);
      // 私有插件仅作者可下载
      const pmeta = listPlugins().find((x) => x.id === id);
      if (!pmeta) {
        return sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "插件不存在" } });
      }
      if (pmeta.public === false && pmeta.author !== username) {
        return sendJson(res, 403, { ok: false, error: { code: "FORBIDDEN", message: "该插件未公开，仅作者可下载" } });
      }
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

    // ---- 插件图标：/icons/<file>（上传时从 .7z 提取到 .icons/） ----
    if (urlPath.startsWith("/icons/")) {
      const file = resolveInRoot(pluginIconDir(), urlPath.slice("/icons/".length));
      return await serveStatic(res, file);
    }

    // ---- 头像：/avatars/<file> ----
    if (urlPath.startsWith("/avatars/")) {
      const file = resolveInRoot(AVATARS_DIR, urlPath.slice("/avatars/".length));
      return await serveStatic(res, file);
    }

    // ---- 上传文件（图片/文档等）：/uploads/<file> —— 需签名 URL（5 分钟有效）----
    if (urlPath.startsWith("/uploads/")) {
      if (!verifyUploadSig(urlPath, qs)) {
        return sendJson(res, 403, { ok: false, error: { code: "FORBIDDEN", message: "链接已过期或无效，请从会话中重新打开" } });
      }
      const file = resolveInRoot(UPLOADS_DIR, urlPath.slice("/uploads/".length));
      return await serveStatic(res, file);
    }

    return sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "接口或资源不存在（前端页面请由 apps/web 独立服务提供）" } });
  } catch (err) {
    console.error(`[http] ${method} ${urlPath} -> ${err.message}`);
    return sendJson(res, 500, { ok: false, error: { code: "INTERNAL", message: "服务器内部错误" } });
  }
});

/* ================= WebSocket：登录认证（JWT）+ 定向推送 ================= */

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
      const username = verifyToken(String(frame.token));
      if (username) {
        ws.username = username;
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
  console.log(`  uploads   -> ${UPLOADS_DIR}（签名 URL 鉴权）`);
  console.log(`（前端页面由 apps/web 独立提供，本服务不托管页面）`);
});
