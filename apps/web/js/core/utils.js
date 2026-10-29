/* ============================================================
   MagicHub · js/core/utils.js —— 通用工具
   DOM 取值 / 文本转义 / 时间与大小格式化 / 头像与文件卡片 / 版本比较
   ============================================================ */
(function (MH) {
  "use strict";

  class Utils {
    /** 按 id 取元素 */
    static $(id) {
      return document.getElementById(id);
    }

    static escapeHtml(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    static escapeReg(s) {
      return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    /** 会话预览时间：今天 HH:mm / 昨天 / x月x日 / 年-月-日 */
    static fmtTime(ts) {
      if (!ts) return "";
      var d = new Date(ts), now = new Date();
      if (d.toDateString() === now.toDateString()) {
        return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
      }
      var yest = new Date(now); yest.setDate(now.getDate() - 1);
      if (d.toDateString() === yest.toDateString()) return "昨天";
      if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + "月" + d.getDate() + "日";
      return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
    }

    /** 日期分隔文案（跨天） */
    static fmtDay(ts) {
      var d = new Date(ts), now = new Date();
      if (d.toDateString() === now.toDateString()) return "今天";
      var yest = new Date(now); yest.setDate(now.getDate() - 1);
      if (d.toDateString() === yest.toDateString()) return "昨天";
      if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + "月" + d.getDate() + "日";
      return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
    }

    static fmtSize(n) {
      if (!n) return "";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      return (n / 1024 / 1024).toFixed(1) + " MB";
    }

    /** 会话列表预览：文本 / 图片 / 文件 */
    static previewText(m) {
      if (!m.file) return m.text || "";
      if (/^image\//.test(m.file.type)) return "[图片] " + m.file.name;
      return "[文件] " + m.file.name;
    }

    static fileCardHTML(f) {
      return '<div class="file-card" data-url="' + Utils.escapeHtml(f.url) + '">' +
        '<span class="file-ico"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/></svg></span>' +
        '<span class="file-info"><span class="file-name">' + Utils.escapeHtml(f.name) + '</span>' +
        '<span class="file-size">' + Utils.fmtSize(f.size) + '</span></span>' +
        '<button type="button" class="file-dl" data-dl="' + Utils.escapeHtml(f.name) + '">下载</button></div>';
    }

    /** 头像 HTML：首字母兜底 + 可选图片 */
    static avatarHTML(u) {
      var letter = (u.displayName || u.username).charAt(0).toUpperCase();
      return '<span class="avatar" style="background:var(--grad)"><span class="av-fallback">' + letter + '</span>' +
        (u.avatar ? '<img src="' + MH.Config.BASE + u.avatar + '" alt="" onerror="this.remove()">' : '') + '</span>';
    }

    /** 插件版本比较（semver 数字段逐级比较；无法解析时按字符串比较） */
    static versionCmp(a, b) {
      var pa = String(a || "").split(".").map(function (x) { return parseInt(x, 10) || 0; });
      var pb = String(b || "").split(".").map(function (x) { return parseInt(x, 10) || 0; });
      for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
        var va = pa[i] || 0, vb = pb[i] || 0;
        if (va !== vb) return va - vb;
      }
      return 0;
    }
  }

  MH.Utils = Utils;
})(window.MH = window.MH || {});
