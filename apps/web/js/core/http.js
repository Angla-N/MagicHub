/* ============================================================
   MagicHub · js/core/http.js —— 统一请求封装
   认证头 / 401 自动退回登录页 / 上传文件签名 URL
   ============================================================ */
(function (MH) {
  "use strict";

  class Http {
    constructor(session) {
      this.session = session;
    }

    authHeaders(json) {
      var h = { "Authorization": "Bearer " + this.session.token };
      if (json) h["Content-Type"] = "application/json";
      return h;
    }

    /** 统一 API 封装：401 时清会话并跳回登录页（避免 token 过期后各接口乱报错） */
    api(url, opts) {
      return fetch(url, opts).then(function (res) {
        if (res.status === 401) {
          MH.Session.clear();
          location.replace("login.html");
          throw new Error("UNAUTHORIZED");
        }
        return res.json();
      });
    }

    /** 上传文件签名 URL（/uploads/ 需签名，5 分钟有效）：图片/下载前先取签名 */
    signedUploadUrl(path) {
      var self = this;
      return this.api(MH.Config.BASE + "/api/uploads/sign?path=" + encodeURIComponent(path), { headers: self.authHeaders() })
        .then(function (d) { return d.ok ? MH.Config.BASE + d.data.url : null; });
    }
  }

  MH.Http = Http;
})(window.MH = window.MH || {});
