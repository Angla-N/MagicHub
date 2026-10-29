/* ============================================================
   MagicHub · js/features/presence.js —— 在线状态与"正在输入"
   ============================================================ */
(function (MH) {
  "use strict";

  class Presence {
    constructor() {
      this.onlineUsers = {}; // username -> true（好友在线清单）
      this.typingTimer = null;
      this.lastTypingSent = 0;
    }

    init() {
      var self = this;
      // 输入框 input：节流 2s 通知对方"正在输入"
      MH.Utils.$("input").addEventListener("input", function () {
        if (!MH.app.convs.activeConv || !MH.app.realtime.isOpen()) return;
        var now = Date.now();
        if (now - self.lastTypingSent > 2000) {
          self.lastTypingSent = now;
          MH.app.realtime.sendTyping(MH.app.convs.activeConv);
        }
      });
    }

    /** 聊天头部状态点：当前会话对方在线 → 绿点，离线 → 灰点 */
    updateChatHeadPresence() {
      var dot = document.querySelector(".chat-head .dot");
      if (!dot) return;
      var peerName = "";
      var convs = MH.app.convs;
      if (convs.activeConv && convs.convMeta[convs.activeConv] && convs.convMeta[convs.activeConv].peer) {
        peerName = convs.convMeta[convs.activeConv].peer.username;
      }
      dot.className = "dot " + (peerName && this.onlineUsers[peerName] ? "online" : "offline");
    }

    /** 收到 presence / presence_map 后统一刷新状态 UI */
    render() {
      this.updateChatHeadPresence();
      MH.app.convs.render(); // 会话列表在线点
    }

    /** 对方正在输入提示（2.5s 后自动消失） */
    showTyping(from) {
      var hint = MH.Utils.$("typingHint");
      if (!hint) return;
      var convs = MH.app.convs;
      var name = "";
      if (convs.convMeta[convs.activeConv] && convs.convMeta[convs.activeConv].peer) {
        name = convs.convMeta[convs.activeConv].peer.displayName || convs.convMeta[convs.activeConv].peer.username;
      }
      hint.innerHTML = '<span class="typing"><i></i><i></i><i></i></span> ' + MH.Utils.escapeHtml(name || from) + " 正在输入…";
      hint.hidden = false;
      clearTimeout(this.typingTimer);
      var self = this;
      this.typingTimer = setTimeout(function () { hint.hidden = true; }, 2500);
    }

    /** 打开/关闭会话时隐藏"正在输入" */
    hide() {
      clearTimeout(this.typingTimer);
      var hint = MH.Utils.$("typingHint");
      if (hint) hint.hidden = true;
    }
  }

  MH.Presence = Presence;
})(window.MH = window.MH || {});
