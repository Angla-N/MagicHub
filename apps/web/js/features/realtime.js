/* ============================================================
   MagicHub · js/features/realtime.js —— WebSocket 实时通道
   认证 / 新消息推送 / 撤回 / 在线状态 / 正在输入 / 断线重连
   ============================================================ */
(function (MH) {
  "use strict";

  class Realtime {
    constructor(session) {
      this.session = session;
      this.statusEl = MH.Utils.$("status");
      this.statusText = MH.Utils.$("statusText");
      this.ws = null;
      this.retryTimer = null;
    }

    isOpen() {
      return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    /** 通知对方"正在输入" */
    sendTyping(convId) {
      if (!this.isOpen()) return;
      this.ws.send(JSON.stringify({ type: "typing", data: { convId: convId } }));
    }

    setStatus(state, text) {
      this.statusEl.classList.remove("on", "err");
      if (state === "on") this.statusEl.classList.add("on");
      if (state === "err") this.statusEl.classList.add("err");
      this.statusText.textContent = text;
    }

    setInputEnabled(en) {
      MH.Utils.$("input").disabled = !en;
      MH.Utils.$("sendBtn").disabled = !en;
      MH.Utils.$("attachBtn").disabled = !en;
    }

    connect() {
      var self = this;
      clearTimeout(this.retryTimer);
      this.setStatus("", "连接中…");
      this.ws = new WebSocket(MH.Config.WS_URL);
      this.ws.onopen = function () {
        self.setStatus("", "认证中…");
        self.ws.send(JSON.stringify({ type: "auth", token: self.session.token }));
      };
      this.ws.onmessage = function (ev) {
        var frame;
        try { frame = JSON.parse(ev.data); } catch (e) { return; }
        self.handle(frame);
      };
      this.ws.onclose = function () {
        self.setStatus("err", "已断开 · 3 秒后重连");
        self.setInputEnabled(false);
        self.retryTimer = setTimeout(function () { self.connect(); }, 3000);
      };
      this.ws.onerror = function () { /* onclose 统一处理 */ };
    }

    handle(frame) {
      var convs = MH.app.convs;
      var activeConv = convs.activeConv;

      if (frame.type === "auth_ok") {
        this.setStatus("on", "已连接");
        if (activeConv) {
          this.setInputEnabled(true);
          // 重连成功后重新拉取当前会话，保证与其他客户端/窗口保持同步
          convs.open(activeConv);
        }
      } else if (frame.type === "auth_fail") {
        this.setStatus("err", "登录已过期");
        this.setInputEnabled(false);
      } else if (frame.type === "message") {
        var d = frame.data || {};
        if (activeConv && d.convId === activeConv) {
          MH.app.messages.append(d.msg, false);
          // 同步内存数组（滚动分页重渲染保持一致）
          convs.msgs.push(d.msg);
          if (!convs.oldestTs) convs.oldestTs = d.msg.ts;
          // 正在看该会话：服务端计数置 0（若对方刚发来）
          if (convs.convMeta[d.convId] && convs.convMeta[d.convId].unread > 0) {
            convs.convMeta[d.convId].unread = 0;
            convs.updateBadge(d.convId, 0);
          }
          fetch(MH.Config.BASE + "/api/conversations/read", {
            method: "POST",
            headers: MH.app.http.authHeaders(true),
            body: JSON.stringify({ convId: d.convId }),
          }).catch(function () {});
          convs.load();
        } else {
          // 非当前会话：未读 +1 并显示角标
          if (convs.convMeta[d.convId]) {
            convs.convMeta[d.convId].unread = (convs.convMeta[d.convId].unread || 0) + 1;
            convs.updateBadge(d.convId, convs.convMeta[d.convId].unread);
          }
          MH.toast("收到新消息");
          // 桌面通知（后台驻留 / 窗口未聚焦时由主进程弹出系统通知）
          var peerName = "";
          if (convs.convMeta[d.convId] && convs.convMeta[d.convId].peer) peerName = convs.convMeta[d.convId].peer.displayName || convs.convMeta[d.convId].peer.username;
          var body = "";
          if (d.msg && d.msg.file) body = "[文件] " + (d.msg.file.name || "");
          else if (d.msg && d.msg.text) body = d.msg.text;
          if (window.magicHub && window.magicHub.notify) {
            window.magicHub.notify(peerName + " 发来消息", body.slice(0, 80)).catch(function () {});
          } else {
            document.title = "(" + (convs.convMeta[d.convId] ? convs.convMeta[d.convId].unread : 1) + ") MagicHub";
          }
          convs.load();
        }
      } else if (frame.type === "recall") {
        // 对方/其他端撤回：本地气泡同步标记为"已撤回"
        var r = frame.data || {};
        convs.recallLocal(r.convId, r.msgId);
        convs.load();
      } else if (frame.type === "presence_map") {
        // 连接建立后下发的好友在线清单
        var pm = frame.data || {};
        var presence = MH.app.presence;
        presence.onlineUsers = {};
        (pm.online || []).forEach(function (u) { presence.onlineUsers[u] = true; });
        presence.render();
      } else if (frame.type === "presence") {
        // 好友上线/离线广播
        var pr = frame.data || {};
        var p = MH.app.presence;
        if (pr.online) p.onlineUsers[pr.username] = true;
        else delete p.onlineUsers[pr.username];
        p.render();
      } else if (frame.type === "typing") {
        // 对方正在输入（仅当前会话显示）
        var tp = frame.data || {};
        if (activeConv && tp.convId === activeConv && tp.from !== this.session.username) {
          MH.app.presence.showTyping(tp.from);
        }
      }
    }
  }

  MH.Realtime = Realtime;
})(window.MH = window.MH || {});
