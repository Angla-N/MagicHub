/**
 * MagicHub · user-store —— JSON 账号存储
 *
 * 账号持久化到 data/users.json（本地文件，不用数据库），
 * 密码以 scrypt 加盐哈希保存，绝不存明文。
 * 用户可设置名字（displayName）与头像（base64 上传，保存到 data/avatars/）。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 数据目录：Electron 打包场景下由 MAGICHUB_DATA_DIR 指向用户数据目录（asar 内只读，必须外置）
const DATA_DIR = process.env.MAGICHUB_DATA_DIR || join(__dirname, "..", "data");
const USERS_FILE = join(DATA_DIR, "users.json");
export const AVATARS_DIR = join(DATA_DIR, "avatars");

/** 预置演示账号，方便首次体验登录 */
const DEMO_ACCOUNT = { username: "demo", password: "demo123", displayName: "演示用户" };

function hashPassword(password, salt) {
  return scryptSync(String(password), salt, 64).toString("hex");
}

function createRecord(username, password, displayName, avatar) {
  const salt = randomBytes(16).toString("hex");
  return {
    username,
    displayName: displayName || username,
    avatar: avatar || null,
    salt,
    hash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  };
}

/** 确保数据目录与 users.json 存在；不存在则创建并写入演示账号 */
export function ensureStore() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(AVATARS_DIR)) mkdirSync(AVATARS_DIR, { recursive: true });
  if (!existsSync(USERS_FILE)) {
    const users = {};
    users[DEMO_ACCOUNT.username] = createRecord(
      DEMO_ACCOUNT.username,
      DEMO_ACCOUNT.password,
      DEMO_ACCOUNT.displayName,
      null
    );
    writeFileSync(USERS_FILE, JSON.stringify(users, null, 2) + "\n", "utf8");
    console.log(`[users] 已创建账号存储并预置演示账号 ${DEMO_ACCOUNT.username} / ${DEMO_ACCOUNT.password}`);
  }
}

/**
 * 保存头像（base64 data URL）到 data/avatars/<username>.<ext>，返回可访问路径。
 * 格式/大小不合法返回 null。
 */
export function saveAvatar(username, dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  if (buf.length === 0 || buf.length > 300 * 1024) return null;
  const ext = m[1] === "jpeg" ? "jpg" : m[1];
  if (!existsSync(AVATARS_DIR)) mkdirSync(AVATARS_DIR, { recursive: true });
  const file = join(AVATARS_DIR, `${username}.${ext}`);
  writeFileSync(file, buf);
  return `/avatars/${username}.${ext}`;
}

function loadUsers() {
  ensureStore();
  try {
    return JSON.parse(readFileSync(USERS_FILE, "utf8"));
  } catch (err) {
    console.error(`[users] 读取失败: ${err.message}`);
    return {};
  }
}

function saveUsers(users) {
  ensureStore();
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2) + "\n", "utf8");
}

/** 按用户名取公开资料（用于会话校验 /api/me） */
export function getUser(username) {
  const users = loadUsers();
  const r = users[username];
  if (!r) return null;
  return { username, displayName: r.displayName || username, avatar: r.avatar || null };
}

const USERNAME_RE = /^[\w-]{3,24}$/;
const DISPLAY_NAME_RE = /^[^\s]{1,32}$/;

/** 注册：校验 -> 查重 -> 保存头像 -> 落盘 */
export function register(username, password, displayName, avatarData) {
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    return { ok: false, error: { code: "INVALID_USERNAME", message: "账号需为 3-24 位字母、数字、下划线或短横线" } };
  }
  if (typeof password !== "string" || password.length < 6 || password.length > 64) {
    return { ok: false, error: { code: "INVALID_PASSWORD", message: "密码长度需为 6-64 位" } };
  }
  const name = typeof displayName === "string" ? displayName.trim() : "";
  if (name && !DISPLAY_NAME_RE.test(name)) {
    return { ok: false, error: { code: "INVALID_DISPLAY_NAME", message: "名字需为 1-32 个字符（不含空格）" } };
  }

  const users = loadUsers();
  if (users[username]) {
    return { ok: false, error: { code: "USERNAME_TAKEN", message: "该账号已被注册" } };
  }

  const avatar = saveAvatar(username, avatarData);
  users[username] = createRecord(username, password, name, avatar);
  saveUsers(users);
  console.log(`[users] 新账号注册: ${username} (${name || username}, avatar=${avatar ? "yes" : "no"})`);
  return { ok: true, data: { username, displayName: name || username, avatar } };
}

/** 登录：恒时比较哈希，失败信息统一，避免枚举账号 */
export function login(username, password) {
  if (typeof username !== "string" || typeof password !== "string") {
    return { ok: false, error: { code: "INVALID_CREDENTIALS", message: "账号或密码错误" } };
  }

  const users = loadUsers();
  const record = users[username];
  if (!record) {
    return { ok: false, error: { code: "INVALID_CREDENTIALS", message: "账号或密码错误" } };
  }

  const expected = Buffer.from(record.hash, "hex");
  const actual = Buffer.from(hashPassword(password, record.salt), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, error: { code: "INVALID_CREDENTIALS", message: "账号或密码错误" } };
  }

  console.log(`[users] 登录成功: ${username}`);
  return {
    ok: true,
    data: { username, displayName: record.displayName || username, avatar: record.avatar || null },
  };
}
