/* ============================================================
   MagicHub · js/components/global-search.js —— 全局消息搜索
   跨所有会话检索命中消息，按会话分组，点击跳转
   ============================================================ */
(function (MH) {
  "use strict";

  class GlobalSearch {
    constructor(http, convs) {
      this.http = http;
      this.convs = convs;
      this.mask = MH.Utils.$("globalSearchMask");
      this.input = MH.Utils.$("globalSearchInput");
      this.results = MH.Utils.$("globalSearchResults");
      this.timer = null;
    }

    init() {
      var self = this;

      MH.Utils.$("globalSearchBtn").addEventListener("click", function () {
        self.mask.hidden = false;
        self.input.value = "";
        self.results.innerHTML = "";
        setTimeout(function () { self.input.focus(); }, 50);
      });

      this.mask.addEventListener("click", function (e) { if (e.target === self.mask) self.mask.hidden = true; });

      this.input.addEventListener("input", function () {
        clearTimeout(self.timer);
        var kw = self.input.value.trim();
        if (!kw) { self.results.innerHTML = ""; return; }
        self.timer = setTimeout(function () { self.search(kw); }, 300);
      });
    }

    search(kw) {
      var self = this;
      var box = this.results;
      this.http.api(MH.Config.BASE + "/api/search?q=" + encodeURIComponent(kw), { headers: this.http.authHeaders() })
        .then(function (d) {
          if (!d.ok) return;
          var results = d.data.results || [];
          box.innerHTML = "";
          if (!results.length) {
            box.innerHTML = '<div class="gsearch-none">没有找到相关消息</div>';
            return;
          }
          results.forEach(function (r) {
            var peer = r.peer || {};
            var group = document.createElement("div");
            group.className = "gsearch-group";
            var head = document.createElement("div");
            head.className = "gsearch-peer";
            head.innerHTML = MH.Utils.avatarHTML(peer) + '<span class="gp-name">' + (peer.displayName || peer.username) + '</span><i class="gp-acc">账号 ' + peer.username + '</i>';
            group.appendChild(head);
            r.msgs.forEach(function (m) {
              var item = document.createElement("button");
              item.type = "button";
              item.className = "gsearch-item";
              var who = m.from === MH.app.session.username ? "我" : (peer.displayName || peer.username);
              var body = m.deleted ? "[已撤回]" : (m.text || MH.Utils.previewText(m));
              item.innerHTML = '<span class="gs-who">' + who + ' · ' + MH.Utils.fmtTime(m.ts) + '</span><span class="gs-text">' + MH.Utils.escapeHtml(String(body).slice(0, 64)) + '</span>';
              item.addEventListener("click", function () {
                MH.app.shell.showChat();
                self.convs.open(r.convId);
                self.mask.hidden = true;
              });
              group.appendChild(item);
            });
            box.appendChild(group);
          });
        })
        .catch(function () { /* 后端未启动 */ });
    }
  }

  MH.GlobalSearch = GlobalSearch;
})(window.MH = window.MH || {});
