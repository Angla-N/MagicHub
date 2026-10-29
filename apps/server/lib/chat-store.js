/**
 * MagicHub · chat-store —— 好友 / 会话 / 消息存储（分片 JSON，不用数据库）
 *
 * 数据模型：
 *  - 好友关系：users.json 每个用户记录内 friends: [username...]（双向同时建立）
 *  - 会话与消息：data/chat/<convId>/
 *      meta.json        { id, members:[a,b], unread:{ username:n }, lastMsg:{...}|null }
 *      msgs-00000.json  [msg...]（每片最多 500 条，写满开新片，历史永不丢）
 *  - 会话 id：两个用户名按字典序以 __ 连接（a__b），保证同两人只一个会话
 *  - 未读：每条消息给会话另一方 unread+1；打开会话调用 markRead 清零
 *
 * v0.2.0 安全/可靠性：
 *  - 原子写（临时文件 + rename）+ .bak 备份 + 损坏时拒绝覆盖
 *  - 消息分片存储：单会话消息不再被静默截断到 500 条，写盘只写最后一片
 *  - listConversations 只读 meta.json，不再触发任何写盘副作用
 *  - 自动迁移旧版 data/chat.json（一次性拆分为分片，原文件改名保留）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsonOrThrow, saveJson, atomicWrite } from "./json-file.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.MAGICHUB_DATA_DIR || join(__dirname, "..", "data");
const USERS_FILE = join(DATA_DIR, "users.json");
const LEGACY_CHAT_FILE = join(DATA_DIR, "chat.json");
const CHAT_DIR = join(DATA_DIR, "chat");
const SLICE_MAX = 500; // 每片消息上限（写满开新片，不截断历史）

/* ---------- 用户（好友关系也存 users.json） ---------- */

function loadUsers() {
  return loadJsonOrThrow(USERS_FILE, "users.json");
}

function saveUsers(users) {
  saveJson(USERS_FILE, users, "users.json");
}

/* ---------- 会话分片读写 ---------- */

function convDir(id) { return join(CHAT_DIR, String(id)); }
function metaFile(id) { return join(convDir(id), "meta.json"); }

function readMeta(id) {
  const f = metaFile(id);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch (err) {
    console.error(`[chat] 会话 ${id} meta.json 损坏（将按空会话重建）: ${err.message}`);
    return null;
  }
}

function writeMeta(id, meta) {
  saveJson(metaFile(id), meta, `chat/${id}/meta.json`);
}

function sliceIndex(name) {
  const m = /^msgs-(\d+)\.json$/.exec(name);
  return m ? Number(m[1]) : -1;
}

/** 返回该会话已排序的分片文件绝对路径列表 */
function listSlices(id) {
  const dir = convDir(id);
  if (!existsSync(dir)) return [];
  const files = [];
  for (const n of readdirSync(dir)) {
    if (sliceIndex(n) >= 0) files.push(join(dir, n));
  }
  files.sort((a, b) => sliceIndex(basename(b)) - sliceIndex(basename(a))); // 降序：最新片在前
  return files;
}

/** 读分片；文件损坏时改名为 .corrupt 保留，返回空（保证不再覆盖坏数据） */
function readSlice(file) {
  if (!existsSync(file)) return { msgs: [], corrupt: false };
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return { msgs: Array.isArray(v) ? v : [], corrupt: false };
  } catch (err) {
    console.error(`[chat] 分片损坏 ${file}，改名保留不再覆盖: ${err.message}`);
    try { renameSync(file, file + ".corrupt-" + Date.now()); } catch { /* 忽略 */ }
    return { msgs: [], corrupt: true };
  }
}

/** 合并该会话全部分片（按片顺序 + 片内顺序） */
function getAllMessages(id) {
  const files = listSlices(id).reverse(); // 已按索引降序排，反转成升序
  const out = [];
  for (const f of files) {
    const { msgs } = readSlice(f);
    for (const m of msgs) out.push(m);
  }
  return out;
}

/* ---------- 旧版 chat.json 一次性迁移 ---------- */

export function ensureChatStore() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(CHAT_DIR)) mkdirSync(CHAT_DIR, { recursive: true });
  migrateLegacyChat();
}

function migrateLegacyChat() {
  if (!existsSync(LEGACY_CHAT_FILE)) return;
  let chat = null;
  try {
    chat = JSON.parse(readFileSync(LEGACY_CHAT_FILE, "utf8"));
  } catch (err) {
    // 旧文件损坏：不迁移、不删除，保留现场供人工检查
    console.error(`[chat] 旧版 chat.json 无法解析，保留原文件不迁移: ${err.message}`);
    return;
  }
  const convs = (chat && chat.convs) || {};
  let count = 0;
  for (const [id, conv] of Object.entries(convs)) {
    if (!conv || !Array.isArray(conv.members)) continue;
    const dir = convDir(id);
    mkdirSync(dir, { recursive: true });
    const meta = {
      id: String(id),
      members: conv.members,
      unread: conv.unread || {},
      lastMsg: conv.messages && conv.messages.length ? conv.messages[conv.messages.length - 1] : null,
    };
    writeMeta(id, meta);
    const msgs = Array.isArray(conv.messages) ? conv.messages : [];
    for (let i = 0; i < msgs.length; i += SLICE_MAX) {
      atomicWrite(join(dir, "msgs-" + String(i / SLICE_MAX).padStart(5, "0") + ".json"),
        JSON.stringify(msgs.slice(i, i + SLICE_MAX)) + "\n");
    }
    count++;
  }
  try { renameSync(LEGACY_CHAT_FILE, LEGACY_CHAT_FILE + ".migrated"); } catch { /* 忽略 */ }
  console.log(`[chat] 已迁移旧版 chat.json → data/chat/（${count} 个会话），原文件保留为 chat.json.migrated`);
}

/* ---------- 用户 / 好友 ---------- */

function publicUser(username, record) {
  return {
    username,
    displayName: record.displayName || username,
    avatar: record.avatar || null,
  };
}

/** 通讯录：所有已注册用户（排除自己），标注是否已是好友；无加好友也能看到，但不能发消息 */
export function listUsers(me) {
  const users = loadUsers();
  const out = [];
  for (const [username, record] of Object.entries(users)) {
    if (username === me) continue;
    const u = publicUser(username, record);
    u.isFriend = Array.isArray(record.friends) && record.friends.includes(me);
    out.push(u);
  }
  return out;
}

export function listFriends(me) {
  const users = loadUsers();
  const record = users[me];
  const out = [];
  for (const name of record && Array.isArray(record.friends) ? record.friends : []) {
    const r = users[name];
    if (r) out.push(publicUser(name, r));
  }
  return out;
}

/** 添加好友：双向建立关系（已添加则幂等成功） */
export function addFriend(me, other) {
  const users = loadUsers();
  if (!users[me]) return { ok: false, error: { code: "NOT_FOUND", message: "账号不存在" } };
  if (!users[other]) return { ok: false, error: { code: "NOT_FOUND", message: "对方账号不存在" } };
  if (me === other) return { ok: false, error: { code: "INVALID", message: "不能添加自己为好友" } };

  users[me].friends = users[me].friends || [];
  users[other].friends = users[other].friends || [];
  if (!users[me].friends.includes(other)) users[me].friends.push(other);
  if (!users[other].friends.includes(me)) users[other].friends.push(me);
  saveUsers(users);
  console.log(`[chat] 好友建立: ${me} <-> ${other}`);
  return { ok: true, data: { username: other } };
}

/** 删除好友：双向移除关系（不是好友则幂等成功） */
export function removeFriend(me, other) {
  const users = loadUsers();
  if (!users[me]) return { ok: false, error: { code: "NOT_FOUND", message: "账号不存在" } };
  if (me === other) return { ok: false, error: { code: "INVALID", message: "不能删除自己" } };

  users[me].friends = (users[me].friends || []).filter((n) => n !== other);
  if (users[other]) {
    users[other].friends = (users[other].friends || []).filter((n) => n !== me);
  }
  saveUsers(users);
  console.log(`[chat] 好友解除: ${me} -x- ${other}`);
  return { ok: true, data: { username: other } };
}

/** 会话 id：两用户名按字典序排序后以 __ 连接 */
export function convId(a, b) {
  return [a, b].sort().join("__");
}

/** 会话列表（我的好友会话），附最后一条消息；只读 meta，不触发任何写盘 */
export function listConversations(me) {
  const friends = listFriends(me);
  const out = [];
  for (const f of friends) {
    const id = convId(me, f.username);
    const meta = readMeta(id);
    const last = meta && meta.lastMsg ? meta.lastMsg : null;
    const unread = (meta && meta.unread && meta.unread[me]) || 0;
    out.push({ id, peer: f, last, unread });
  }
  // 按最后消息时间降序（活跃会话置顶）
  out.sort((a, b) => (b.last ? b.last.ts : 0) - (a.last ? a.last.ts : 0));
  return out;
}

/** 校验我是会话成员（会话 id 即成员列表，无需读盘即可判定） */
function convMembersOf(convIdValue) {
  const parts = String(convIdValue).split("__");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (parts[0] !== [parts[0], parts[1]].sort()[0]) return null; // 必须按字典序（防伪造）
  return parts;
}

export function getMessages(convIdValue, me) {
  const members = convMembersOf(convIdValue);
  if (!members || !members.includes(me)) return null;
  if (!existsSync(metaFile(convIdValue))) return []; // 从未聊过 → 空
  return getAllMessages(convIdValue);
}

/** 发消息：追加到最后一片（满 500 开新片），只写最后一帧 + meta；WS 推送由 server 完成 */
export function addMessage(convIdValue, from, text, file) {
  const hasText = typeof text === "string" && text.trim().length > 0;
  const hasFile = !!file && typeof file === "object";
  if (!hasText && !hasFile) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "消息内容为空" } };
  }
  const members = convMembersOf(convIdValue);
  if (!members || !members.includes(from)) {
    return { ok: false, error: { code: "FORBIDDEN", message: "会话不存在或无权访问（请先添加好友）" } };
  }

  const msg = { from, ts: Date.now() };
  if (hasText) msg.text = text.trim().slice(0, 2000);
  if (hasFile) msg.file = {
    url: file.url,
    name: String(file.name || "file").slice(0, 120),
    type: String(file.type || "application/octet-stream").slice(0, 80),
    size: Number(file.size) || 0,
  };

  const dir = convDir(convIdValue);
  mkdirSync(dir, { recursive: true });

  // 未读计数：给会话另一方 +1
  const peer = members.find((m) => m !== from) || null;
  let meta = readMeta(convIdValue) || { id: convIdValue, members, unread: {}, lastMsg: null };
  meta.unread = meta.unread || {};

  // 写最后一片：满 500 开新片
  const slices = listSlices(convIdValue); // 降序
  let lastFile = slices.length ? slices[0] : null;
  let lastIdx = lastFile ? sliceIndex(basename(lastFile)) : -1;
  let cur;
  if (lastFile) {
    const r = readSlice(lastFile);
    cur = r.corrupt ? [] : r.msgs; // 坏片已改名保留，从空开始写新片
  } else {
    cur = [];
  }
  let targetFile;
  if (cur.length >= SLICE_MAX) {
    targetFile = join(dir, "msgs-" + String(lastIdx + 1).padStart(5, "0") + ".json");
    cur = [];
  } else {
    targetFile = lastFile || join(dir, "msgs-" + String(lastIdx + 1).padStart(5, "0") + ".json");
  }
  cur.push(msg);
  atomicWrite(targetFile, JSON.stringify(cur) + "\n");

  // 更新 meta（lastMsg + unread），原子写
  meta.lastMsg = msg;
  if (peer) meta.unread[peer] = (meta.unread[peer] || 0) + 1;
  writeMeta(convIdValue, meta);

  return { ok: true, data: { convId: convIdValue, msg, peerUnread: peer ? meta.unread[peer] : 0 } };
}

/** 已读：把我在该会话的未读计数清零 */
export function markRead(convIdValue, me) {
  const members = convMembersOf(convIdValue);
  if (!members || !members.includes(me)) {
    return { ok: false, error: { code: "FORBIDDEN", message: "会话不存在或无权访问" } };
  }
  const meta = readMeta(convIdValue);
  if (!meta) return { ok: true, data: { convId: convIdValue } }; // 无会话记录，幂等成功
  meta.unread = meta.unread || {};
  meta.unread[me] = 0;
  writeMeta(convIdValue, meta);
  return { ok: true, data: { convId: convIdValue } };
}

/** 会话另一方（用于 WS 定向推送） */
export function peerOf(convIdValue, me) {
  const members = convMembersOf(convIdValue);
  if (!members || !members.includes(me)) return null;
  return members.find((m) => m !== me) || null;
}
