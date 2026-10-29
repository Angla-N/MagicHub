/* ============================================================
   MagicHub · js/core/toast.js —— 轻提示
   底部居中气泡，2.4 秒后自动消失
   ============================================================ */
(function (MH) {
  "use strict";

  var timer = null;

  MH.toast = function (msg) {
    var el = MH.Utils.$("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(function () { el.classList.remove("show"); }, 2400);
  };
})(window.MH = window.MH || {});
