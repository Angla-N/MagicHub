/* ============================================================
   MagicHub · js/components/lightbox.js —— 图片查看灯箱
   ============================================================ */
(function (MH) {
  "use strict";

  class Lightbox {
    constructor() {
      this.el = MH.Utils.$("lightbox");
      this.img = MH.Utils.$("lightboxImg");
    }

    init() {
      this.el.addEventListener("click", function () { this.classList.remove("show"); });
    }

    show(src) {
      this.img.src = src;
      this.el.classList.add("show");
    }
  }

  MH.Lightbox = Lightbox;
})(window.MH = window.MH || {});
