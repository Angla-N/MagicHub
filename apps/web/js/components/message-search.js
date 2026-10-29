/* ============================================================
   MagicHub · js/components/message-search.js —— 当前会话消息搜索
   过滤 + 高亮匹配消息
   ============================================================ */
(function (MH) {
  "use strict";

  class MessageSearch {
    constructor() {
      this.bar = MH.Utils.$("msgSearch");
      this.input = MH.Utils.$("msgSearchInput");
      this.count = MH.Utils.$("msgSearchCount");
      this.area = MH.Utils.$("msgArea");
    }

    init() {
      var self = this;
      MH.Utils.$("msgSearchBtn").addEventListener("click", function () {
        self.bar.style.display = "flex";
        self.input.focus();
      });
      MH.Utils.$("msgSearchClose").addEventListener("click", function () {
        self.bar.style.display = "none";
        self.input.value = "";
        self.apply();
      });
      this.input.addEventListener("input", function () { self.apply(); });
    }

    /** 搜索框是否正在过滤（有新消息时同步刷新） */
    isActive() {
      return !!this.input.value.trim();
    }

    apply() {
      var kw = this.input.value.trim().toLowerCase();
      var count = 0;
      Array.prototype.forEach.call(this.area.querySelectorAll(".msg"), function (m) {
        var bubble = m.querySelector(".bubble");
        var text = bubble ? bubble.textContent : "";
        var hit = !!kw && text.toLowerCase().indexOf(kw) >= 0;
        m.style.display = hit ? "" : "none";
        if (hit) count++;
        if (bubble) {
          bubble.innerHTML = MH.Utils.escapeHtml(text);
          if (kw) {
            bubble.innerHTML = bubble.innerHTML.replace(new RegExp(MH.Utils.escapeReg(kw), "gi"),
              function (x) { return '<span class="hl">' + x + '</span>'; });
          }
        }
      });
      this.count.textContent = kw ? count + " 条匹配" : "";
    }
  }

  MH.MessageSearch = MessageSearch;
})(window.MH = window.MH || {});
