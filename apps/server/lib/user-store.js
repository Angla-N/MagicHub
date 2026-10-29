/**
 * MagicHub · user-store —— JSON 账号存储
 *
 * 账号持久化到 data/users.json（本地文件，不用数据库），
 * 密码以 scrypt 加盐哈希保存，绝不存明文。
 * 用户可设置名字（displayName）与头像（base64 上传，保存到 data/avatars/）。
 *
 * 安全（v0.2.0）：
 *  - scrypt 异步哈希，不阻塞事件循环
 *  - 原子写 + .bak 备份 + 损坏时拒绝覆盖（见 lib/json-file.js）
 *  - 演示账号仅开发模式预置（打包部署不内置任何账号）
 *  - 每个账号带 tokenVersion，改密码时 +1 吊销该账号全部已签发 token
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsonOrThrow, saveJson } from "./json-file.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 数据目录：Electron 打包场景下由 MAGICHUB_DATA_DIR 指向用户数据目录（asar 内只读，必须外置）
const DATA_DIR = process.env.MAGICHUB_DATA_DIR || join(__dirname, "..", "data");
const USERS_FILE = join(DATA_DIR, "users.json");
export const AVATARS_DIR = join(DATA_DIR, "avatars");

/** 打包（MagicHub-Server.exe）时主进程注入 MAGICHUB_PACKAGED=1 → 不预置演示账号 */
const IS_PACKAGED = process.env.MAGICHUB_PACKAGED === "1";

/** 演示账号仅开发模式（node 直接运行 / 未标记打包）时预置 */
const DEMO_ACCOUNT = { username: "demo", password: "demo123", displayName: "演示用户" };

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(String(password), salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString("hex"));
    });
  });
}

async function createRecord(username, password, displayName, avatar) {
  const salt = randomBytes(16).toString("hex");
  return {
    username,
    displayName: displayName || username,
    avatar: avatar || null,
    salt,
    hash: await hashPassword(password, salt),
    tokenVersion: 0, // 改密时 +1，使已签发 token 全部失效
    createdAt: new Date().toISOString(),
  };
}

/** 确保数据目录与 users.json 存在；打包模式不预置演示账号 */
export async function ensureStore() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(AVATARS_DIR)) mkdirSync(AVATARS_DIR, { recursive: true });
  if (!existsSync(USERS_FILE)) {
    const users = {};
    if (!IS_PACKAGED) {
      users[DEMO_ACCOUNT.username] = await createRecord(
        DEMO_ACCOUNT.username,
        DEMO_ACCOUNT.password,
        DEMO_ACCOUNT.displayName,
        null
      );
    }
    saveJson(USERS_FILE, users, "users.json");
    if (!IS_PACKAGED) {
      console.log(`[users] 已创建账号存储并预置演示账号 ${DEMO_ACCOUNT.username} / ${DEMO_ACCOUNT.password}（仅开发模式）`);
    } else {
      console.log("[users] 已创建账号存储（打包模式：无预置账号）");
    }
  }
}

/**
 * 保存头像（base64 data URL）到 data/avatars/<username>.<ext>，返回可访问路径。
 * 格式/大小不合法返回 null。头像为二进制，走临时文件 + rename 原子写。
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
  atomicWriteBytes(file, buf);
  return `/avatars/${username}.${ext}`;
}

/** 二进制原子写：临时文件 + rename 覆盖 */
function atomicWriteBytes(file, buf) {
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  writeFileSync(tmp, buf);
  try {
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    throw err;
  }
}

function loadUsers() {
  return loadJsonOrThrow(USERS_FILE, "users.json");
}

/** 完整用户记录（含 tokenVersion，供 JWT 校验） */
export function getUserRecord(username) {
  const users = loadUsers();
  return users && typeof users[username] === "object" ? users[username] : null;
}

/** 按用户名取公开资料（用于会话校验 /api/me） */
export function getUser(username) {
  const r = getUserRecord(username);
  if (!r) return null;
  return { username, displayName: r.displayName || username, avatar: r.avatar || null };
}

const USERNAME_RE = /^[\w-]{3,24}$/;
const DISPLAY_NAME_RE = /^[^\s]{1,32}$/;

/** 注册：校验 -> 查重 -> 保存头像 -> 落盘（异步哈希） */
export async function register(username, password, displayName, avatarData) {
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
  users[username] = await createRecord(username, password, name, avatar);
  saveJson(USERS_FILE, users, "users.json");
  console.log(`[users] 新账号注册: ${username} (${name || username}, avatar=${avatar ? "yes" : "no"})`);
  return { ok: true, data: { username, displayName: name || username, avatar } };
}

/** 登录：异步哈希 + 恒时比较，失败信息统一，避免枚举账号 */
export async function login(username, password) {
  if (typeof username !== "string" || typeof password !== "string") {
    return { ok: false, error: { code: "INVALID_CREDENTIALS", message: "账号或密码错误" } };
  }

  const users = loadUsers();
  const record = users[username];
  if (!record) {
    return { ok: false, error: { code: "INVALID_CREDENTIALS", message: "账号或密码错误" } };
  }

  const expected = Buffer.from(record.hash, "hex");
  const actual = Buffer.from(await hashPassword(password, record.salt), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, error: { code: "INVALID_CREDENTIALS", message: "账号或密码错误" } };
  }

  console.log(`[users] 登录成功: ${username}`);
  return {
    ok: true,
    data: { username, displayName: record.displayName || username, avatar: record.avatar || null },
  };
}

/** 修改密码：校验旧密码后替换为新密码的哈希（新盐），并把 tokenVersion +1 使旧 token 全部失效 */
export async function changePassword(username, oldPassword, newPassword) {
  if (typeof username !== "string" || typeof oldPassword !== "string" || typeof newPassword !== "string") {
    return { ok: false, error: { code: "INVALID_INPUT", message: "参数错误" } };
  }
  if (newPassword.length < 6 || newPassword.length > 64) {
    return { ok: false, error: { code: "WEAK_PASSWORD", message: "新密码至少 6 位，最长 64 位" } };
  }

  const users = loadUsers();
  const record = users[username];
  if (!record) {
    return { ok: false, error: { code: "INVALID_CREDENTIALS", message: "账号或密码错误" } };
  }
  const expected = Buffer.from(record.hash, "hex");
  const actual = Buffer.from(await hashPassword(oldPassword, record.salt), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, error: { code: "INVALID_CREDENTIALS", message: "原密码错误" } };
  }

  const salt = randomBytes(16).toString("hex");
  record.salt = salt;
  record.hash = await hashPassword(newPassword, salt);
  record.tokenVersion = (record.tokenVersion || 0) + 1; // 吊销该账号所有已签发 token
  saveJson(USERS_FILE, users, "users.json");
  console.log(`[users] 密码已修改并吊销旧 token: ${username} (tokenVersion=${record.tokenVersion})`);
  return {
    ok: true,
    data: { username, displayName: record.displayName || username, avatar: record.avatar || null },
  };
}

/**
 * 更新个人资料（昵称 / 头像，P2：#22）。
 * displayName / avatarData 均可选：只传需要改的字段。
 * 旧头像文件清理：仅当新头像成功保存且旧头像不是同一个文件时才删除。
 */
export function updateProfile(username, displayName, avatarData) {
  const users = loadUsers();
  const record = users[username];
  if (!record) {
    return { ok: false, error: { code: "NOT_FOUND", message: "账号不存在" } };
  }

  let name = record.displayName || username;
  if (displayName !== undefined && displayName !== null) {
    const n = String(displayName).trim();
    if (!n || !DISPLAY_NAME_RE.test(n)) {
      return { ok: false, error: { code: "INVALID_DISPLAY_NAME", message: "名字需为 1-32 个字符（不含空格）" } };
    }
    name = n;
  }

  let avatar = record.avatar || null;
  if (avatarData !== undefined && avatarData !== null) {
    const oldAvatar = record.avatar || null;
    const saved = saveAvatar(username, avatarData);
    if (!saved) {
      return { ok: false, error: { code: "INVALID_AVATAR", message: "头像格式不支持或超过 300KB（支持 png/jpeg/gif/webp）" } };
    }
    avatar = saved;
    // 清理旧头像文件（不同文件名才删）
    if (oldAvatar && oldAvatar !== saved) {
      const oldFile = join(AVATARS_DIR, basename(oldAvatar));
      try { if (existsSync(oldFile)) rmSync(oldFile, { force: true }); } catch { /* 忽略 */ }
    }
  }

  record.displayName = name;
  record.avatar = avatar;
  saveJson(USERS_FILE, users, "users.json");
  console.log(`[users] 资料更新: ${username} (displayName=${name}, avatar=${avatar ? "yes" : "no"})`);
  return { ok: true, data: { username, displayName: name, avatar } };
}
