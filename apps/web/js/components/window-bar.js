/* ============================================================
   MagicHub · js/components/window-bar.js —— 窗口控制
   桌面壳下调用 Electron IPC；浏览器演示时仅提示
   ============================================================ */
(function (MH) {
  "use strict";

  class WindowBar {
    constructor() {
      this.native = window.magicHub || null;
    }

    init() {
      var native = this.native;
      MH.Utils.$("winMin").addEventListener("click", function () { native ? native.minimize() : MH.toast("最小化（演示）"); });
      MH.Utils.$("winMax").addEventListener("click", function () { native ? native.maximize() : MH.toast("最大化（演示）"); });
      MH.Utils.$("winClose").addEventListener("click", function () { native ? native.close() : MH.toast("关闭（演示）"); });
    }
  }

  MH.WindowBar = WindowBar;
})(window.MH = window.MH || {});
