/* ============================================================
   MagicHub · js/components/peer-card.js —— 好友资料卡
   点击聊天头部好友头像/名字，弹出资料卡
   ============================================================ */
(function (MH) {
  "use strict";

  class PeerCard {
    constructor(convs) {
      this.convs = convs;
      this.mask = MH.Utils.$("cardMask");
    }

    init() {
      var self = this;

      MH.Utils.$("peerBtn").addEventListener("click", function () { self.open(); });
      MH.Utils.$("cardClose").addEventListener("click", function () { self.mask.hidden = true; });
      MH.Utils.$("cardMsgBtn").addEventListener("click", function () { self.mask.hidden = true; });
      this.mask.addEventListener("click", function (e) { if (e.target === self.mask) self.mask.hidden = true; });
    }

    open() {
      var convs = this.convs;
      if (!convs.activeConv || !convs.convMeta[convs.activeConv]) return;
      var p = convs.convMeta[convs.activeConv].peer;
      MH.Utils.$("cardAvatar").innerHTML = MH.Utils.avatarHTML(p);
      MH.Utils.$("cardName").textContent = p.displayName || p.username;
      MH.Utils.$("cardAcc").textContent = "账号：" + p.username;
      this.mask.hidden = false;
    }
  }

  MH.PeerCard = PeerCard;
})(window.MH = window.MH || {});
