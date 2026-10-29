/* ============================================================
   MagicHub · js/components/password-dialog.js —— 修改密码弹窗
   ============================================================ */
(function (MH) {
  "use strict";

  class PasswordDialog {
    constructor(http) {
      this.http = http;
      this.mask = MH.Utils.$("pwdMask");
    }

    init() {
      var self = this;

      MH.Utils.$("setPwdBtn").addEventListener("click", function () {
        MH.Utils.$("pwdOld").value = "";
        MH.Utils.$("pwdNew").value = "";
        MH.Utils.$("pwdNew2").value = "";
        MH.Utils.$("pwdErr").textContent = "";
        self.mask.hidden = false;
      });

      MH.Utils.$("pwdCancel").addEventListener("click", function () { self.mask.hidden = true; });
      this.mask.addEventListener("click", function (e) { if (e.target === self.mask) self.mask.hidden = true; });

      MH.Utils.$("pwdSave").addEventListener("click", function () { self.save(); });
    }

    save() {
      var oldP = MH.Utils.$("pwdOld").value;
      var newP = MH.Utils.$("pwdNew").value;
      var newP2 = MH.Utils.$("pwdNew2").value;
      var errEl = MH.Utils.$("pwdErr");
      if (!oldP) { errEl.textContent = "请输入原密码"; return; }
      if (newP.length < 6) { errEl.textContent = "新密码至少 6 位"; return; }
      if (newP !== newP2) { errEl.textContent = "两次输入的新密码不一致"; return; }

      var saveBtn = MH.Utils.$("pwdSave");
      var mask = this.mask;
      saveBtn.disabled = true;
      this.http.api(MH.Config.BASE + "/api/account/password", {
        method: "POST",
        headers: this.http.authHeaders(true),
        body: JSON.stringify({ oldPassword: oldP, newPassword: newP }),
      })
        .then(function (d) {
          saveBtn.disabled = false;
          if (d.ok) {
            mask.hidden = true;
            MH.toast("密码修改成功");
          } else {
            errEl.textContent = (d.error && d.error.message) || "修改失败，请重试";
          }
        })
        .catch(function () {
          saveBtn.disabled = false;
          errEl.textContent = "无法连接服务器，请检查服务器地址";
        });
    }
  }

  MH.PasswordDialog = PasswordDialog;
})(window.MH = window.MH || {});
