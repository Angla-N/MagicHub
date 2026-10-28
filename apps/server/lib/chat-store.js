/**
 * MagicHub · chat-store —— 好友 / 会话 / 消息 JSON 存储
 *
 * 数据模型（全部本地 JSON，不用数据库）：
 *  - 好友关系：users.json 每个用户记录内 friends: [username...]（双向同时建立）
 *  - 会话与消息：data/chat.json
 *      { convs: { "<convId>": { id, members: [a,b], messages: [{from,text,ts}] } } }
 *  - 会话 id：两个用户名按字典序以 __ 连接（a__b），保证同两人只一个会话
 *
 * 规则（产品需求）：
 *  - 通讯录（GET /api/users）能看到所有已注册用户（含未加好友的），但不能发消息
 *  - 加好友后才能出现在会话列表，才能互发消息
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MAGICHUB_DATA_DIR || join(__dirname, "..", "data");
const USERS_FILE = join(DATA_DIR, "users.json");
const CHAT_FILE = join(DATA_DIR, "chat.json");

function loadUsers() {
  if (!existsSync(USERS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(USERS_FILE, "utf8"));
  } catch (err) {
    console.error(`[chat] users.json 读取失败: ${err.message}`);
    return {};
  }
}

function saveUsers(users) {
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2) + "\n", "utf8");
}

function loadChat() {
  if (!existsSync(CHAT_FILE)) return { convs: {} };
  try {
    return JSON.parse(readFileSync(CHAT_FILE, "utf8"));
  } catch (err) {
    console.error(`[chat] chat.json 读取失败: ${err.message}`);
    return { convs: {} };
  }
}

function saveChat(chat) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CHAT_FILE, JSON.stringify(chat, null, 2) + "\n", "utf8");
}

/** 会话 id：两用户名按字典序排序后以 __ 连接 */
export function convId(a, b) {
  return [a, b].sort().join("__");
}

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

/** 会话列表（我的好友会话），附最后一条消息；无会话时自动创建空白会话 */
export function listConversations(me) {
  const chat = loadChat();
  const friends = listFriends(me);
  const out = [];
  for (const f of friends) {
    const id = convId(me, f.username);
    let conv = chat.convs[id];
    if (!conv) {
      conv = { id, members: [me, f.username], messages: [] };
      chat.convs[id] = conv;
      saveChat(chat);
    }
    const last = conv.messages[conv.messages.length - 1] || null;
    out.push({ id, peer: f, last });
  }
  return out;
}

/** 校验我是会话成员 */
function convOf(chat, id, me) {
  const conv = chat.convs[id];
  if (!conv) return null;
  if (!conv.members.includes(me)) return null;
  return conv;
}

export function getMessages(convIdValue, me) {
  const chat = loadChat();
  const conv = convOf(chat, convIdValue, me);
  if (!conv) return null;
  return conv.messages;
}

/** 发消息：落盘并返回消息对象（WS 推送由 server 完成） */
export function addMessage(convIdValue, from, text) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "消息不能为空" } };
  }
  const chat = loadChat();
  const conv = convOf(chat, convIdValue, from);
  if (!conv) return { ok: false, error: { code: "FORBIDDEN", message: "会话不存在或无权访问（请先添加好友）" } };

  const msg = { from, text: text.slice(0, 2000), ts: Date.now() };
  conv.messages.push(msg);
  if (conv.messages.length > 500) conv.messages = conv.messages.slice(-500); // 单会话最多保留 500 条
  saveChat(chat);
  return { ok: true, data: { convId: convIdValue, msg } };
}

/** 会话另一方（用于 WS 定向推送） */
export function peerOf(convIdValue, me) {
  const chat = loadChat();
  const conv = convOf(chat, convIdValue, me);
  if (!conv) return null;
  return conv.members.find((m) => m !== me) || null;
}
