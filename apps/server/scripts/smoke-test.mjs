/**
 * MagicHub · 冒烟测试（smoke test）
 * 验证 V0.2 后端：静态服务 / 注册 / 登录 / WebSocket 连通与广播
 *
 * 用法（先启动服务器）：
 *   cd apps/server
 *   npm start          # 一个终端
 *   node scripts/smoke-test.mjs   # 另一个终端；默认 3000，可传端口参数
 */
import WebSocket from "ws";

const PORT = Number(process.argv[2] || process.env.PORT || 3000);
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? "  <- " + detail : ""}`);
  }
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, text: await res.text() };
}

// 每次运行用随机账号，避免污染 users.json
const uname = "t_" + Date.now().toString(36);

console.log(`=== MagicHub smoke test @ localhost:${PORT} ===`);

// 1. 静态服务
const loginPage = await get("/login.html");
check("GET /login.html -> 200 且含 MagicHub", loginPage.status === 200 && loginPage.text.includes("MagicHub"), `status=${loginPage.status}`);

const home = await get("/");
check("GET / -> 200 且为聊天页", home.status === 200 && home.text.includes("msgArea"), `status=${home.status}`);

const css = await get("/css/theme.css");
check("GET /css/theme.css -> 200 且含主题 token", css.status === 200 && css.text.includes("--primary"), `status=${css.status}`);

const traversal = await get("/../../../../Windows/win.ini");
check("路径穿越被拦截", traversal.status === 404, `status=${traversal.status}`);

// 2. 注册
const reg1 = await post("/api/register", { username: uname, password: "pass123456" });
check("注册新账号 -> ok", reg1.status === 200 && reg1.json.ok === true, JSON.stringify(reg1.json));

const regDup = await post("/api/register", { username: uname, password: "pass123456" });
check("重复注册被拒 (USERNAME_TAKEN)", regDup.json.ok === false && regDup.json.error.code === "USERNAME_TAKEN", JSON.stringify(regDup.json));

const regBad = await post("/api/register", { username: "a", password: "123" });
check("非法账号/密码被拒", regBad.json.ok === false && regBad.json.error.code === "INVALID_USERNAME", JSON.stringify(regBad.json));

// 3. 登录
const logDemo = await post("/api/login", { username: "demo", password: "demo123" });
check("预置演示账号 demo 可登录", logDemo.status === 200 && logDemo.json.ok === true, JSON.stringify(logDemo.json));

const logNew = await post("/api/login", { username: uname, password: "pass123456" });
check("新注册账号可登录", logNew.json.ok === true, JSON.stringify(logNew.json));

const logWrong = await post("/api/login", { username: uname, password: "wrong" });
check("错误密码被拒 (INVALID_CREDENTIALS)", logWrong.json.ok === false && logWrong.json.error.code === "INVALID_CREDENTIALS", JSON.stringify(logWrong.json));

// 4. WebSocket：hello + 广播回显
const wsResult = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const events = [];
  const timer = setTimeout(() => resolve({ timeout: true, events }), 4000);

  ws.on("open", () => {
    events.push("open");
    ws.send("smoke-broadcast-" + Date.now());
  });
  ws.on("message", (d) => {
    const frame = JSON.parse(d.toString());
    events.push(frame.type + ":" + (frame.text || frame.msg || ""));
    if (frame.type === "broadcast" && frame.text.startsWith("smoke-broadcast-")) {
      clearTimeout(timer);
      resolve({ events });
    }
  });
  ws.on("error", (err) => {
    clearTimeout(timer);
    resolve({ error: err.message, events });
  });
});
check("WS 握手 hello", Array.isArray(wsResult.events) && wsResult.events.includes("hello:已连接 MagicHub 服务"), JSON.stringify(wsResult));
check("WS 广播回显", Array.isArray(wsResult.events) && wsResult.events.some((e) => e.startsWith("broadcast:smoke-broadcast-")), JSON.stringify(wsResult));

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
