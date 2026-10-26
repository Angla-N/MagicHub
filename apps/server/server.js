/**
 * MagicHub 后端 · V0.1 极简连通版
 *
 * 职责（本阶段仅此而已）：
 *  1. 提供一个 HTTP 端口，浏览器访问可见"服务已启动"；
 *  2. 提供 WebSocket 服务：客户端连上即收到 hello，
 *     之后收到任意消息原样广播给所有在线客户端，用于验证双向连通。
 *
 * 启动：
 *  cd apps/server
 *  npm install   # 首次
 *  npm start     # 默认端口 3000，可用 PORT 环境变量覆盖
 */
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT) || 3000;

// ---------- HTTP：健康检查 ----------
const httpServer = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`MagicHub server is running.\nWebSocket: ws://localhost:${PORT}\n`);
});

// ---------- WebSocket：连接 + 广播 ----------
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  console.log(`[ws] client connected (total: ${wss.clients.size})`);

  // 连上先打招呼，前端据此确认握手成功
  ws.send(JSON.stringify({ type: "hello", msg: "已连接 MagicHub 服务" }));

  ws.on("message", (data) => {
    const text = data.toString();
    console.log(`[ws] recv: ${text}`);
    // 广播给所有在线客户端（含发送者自己），前端用于回显验证
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
