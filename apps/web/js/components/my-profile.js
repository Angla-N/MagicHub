/* ============================================================
   MagicHub · js/components/my-profile.js —— 我的账号
   导航栏头像渲染 + 点击弹出我的资料卡 + 退出登录
   ============================================================ */
(function (MH) {
  "use strict";

  class MyProfile {
    constructor(session) {
      this.session = session;
      this.avatarBtn = MH.Utils.$("avatarBtn");
    }

    init() {
      this.renderAvatar();

      var self = this;
      this.avatarBtn.addEventListener("click", function () {
        MH.Utils.$("myCardAvatar").innerHTML = MH.Utils.avatarHTML(self.session.data);
        MH.Utils.$("myCardName").textContent = self.session.displayName;
        MH.Utils.$("myCardAcc").textContent = "账号: " + self.session.username;
        MH.Utils.$("myMask").hidden = false;
      });

      MH.Utils.$("myClose").addEventListener("click", function () { MH.Utils.$("myMask").hidden = true; });
      MH.Utils.$("myMask").addEventListener("click", function (e) { if (e.target === this) this.hidden = true; });
      MH.Utils.$("myLogout").addEventListener("click", function () {
        MH.Session.clear();
        location.href = "login.html";
      });
    }

    /** 账号头像：有图用图，无图用首字母 */
    renderAvatar() {
      var btn = this.avatarBtn;
      var name = this.session.displayName;
      btn.innerHTML = "";
      if (this.session.avatar) {
        var img = document.createElement("img");
        img.src = MH.Config.BASE + this.session.avatar;
        img.alt = name;
        img.onerror = function () { img.remove(); btn.textContent = name.charAt(0).toUpperCase(); };
        btn.appendChild(img);
      } else {
        btn.textContent = name.charAt(0).toUpperCase();
      }
      btn.title = name + " · 点击查看我的资料";
    }
  }

  MH.MyProfile = MyProfile;
})(window.MH = window.MH || {});
