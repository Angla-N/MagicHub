/**
 * MagicHub · user-store —— JSON 账号存储
 *
 * 账号持久化到 data/users.json（本地文件，不用数据库），
 * 密码以 scrypt 加盐哈希保存，绝不存明文。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 数据目录：Electron 打包场景下由 MAGICHUB_DATA_DIR 指向用户数据目录（asar 内只读，必须外置）
const DATA_DIR = process.env.MAGICHUB_DATA_DIR || join(__dirname, "..", "data");
const USERS_FILE = join(DATA_DIR, "users.json");

/** 预置演示账号，方便首次体验登录 */
const DEMO_ACCOUNT = { username: "demo", password: "demo123" };

function hashPassword(password, salt) {
  return scryptSync(String(password), salt, 64).toString("hex");
}

function createRecord(username, password) {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
}

/** 确保数据目录与 users.json 存在；不存在则创建并写入演示账号 */
export function ensureStore() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(USERS_FILE)) {
    const users = {};
    users[DEMO_ACCOUNT.username] = createRecord(DEMO_ACCOUNT.username, DEMO_ACCOUNT.password);
    writeFileSync(USERS_FILE, JSON.stringify(users, null, 2) + "\n", "utf8");
    console.log(`[users] 已创建账号存储并预置演示账号 ${DEMO_ACCOUNT.username} / ${DEMO_ACCOUNT.password}`);
  }
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

const USERNAME_RE = /^[\w-]{3,24}$/;

/** 注册：校验 -> 查重 -> 落盘 */
export function register(username, password) {
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    return { ok: false, error: { code: "INVALID_USERNAME", message: "账号需为 3-24 位字母、数字、下划线或短横线" } };
  }
  if (typeof password !== "string" || password.length < 6 || password.length > 64) {
    return { ok: false, error: { code: "INVALID_PASSWORD", message: "密码长度需为 6-64 位" } };
  }

  const users = loadUsers();
  if (users[username]) {
    return { ok: false, error: { code: "USERNAME_TAKEN", message: "该账号已被注册" } };
  }

  users[username] = createRecord(username, password);
  saveUsers(users);
  console.log(`[users] 新账号注册: ${username}`);
  return { ok: true, data: { username } };
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
  return { ok: true, data: { username } };
}
