/* ============================================================
   MagicHub · js/core/config.js —— 运行配置
   统一解析服务器地址（用户填写的地址 > Electron 注入 > 本机默认）
   ============================================================ */
(function (MH) {
  "use strict";

  class Config {
    /** 依据登录会话解析 BASE / WS_URL */
    static resolve(sessionData) {
      const base = sessionData.serverBase
        || (window.magicHub && window.magicHub.serverBase)
        || "http://localhost:3000";
      Config.BASE = base;
      Config.WS_URL = base.replace(/^http/, "ws") + "/";
      return base;
    }
  }

  Config.BASE = "http://localhost:3000";
  Config.WS_URL = "ws://localhost:3000/";

  MH.Config = Config;
})(window.MH = window.MH || {});
