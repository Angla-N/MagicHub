/* ============================================================
   MagicHub · js/pages/login.js —— 登录 / 注册页
   服务器地址校验 / 登录注册 / 算术验证码 / 头像裁剪压缩 / 上次登录提示
   ============================================================ */
(function (MH) {
  "use strict";

  class LoginPage {
    constructor() {
      this.mode = "login"; // login | register
      this.captcha = { id: null, q: null };
      this.avatarData = null; // base64 data URL（未选则为 null）

      this.serverEl = document.getElementById("server");
      this.form = document.getElementById("authForm");
      this.usernameEl = document.getElementById("username");
      this.displayNameEl = document.getElementById("displayName");
      this.passwordEl = document.getElementById("password");
      this.errorEl = document.getElementById("authError");
      this.submitBtn = document.getElementById("submitBtn");
      this.tabLogin = document.getElementById("tabLogin");
      this.tabRegister = document.getElementById("tabRegister");
      this.switchBtn = document.getElementById("switchBtn");
      this.switchHint = document.getElementById("switchHint");
      this.authCard = document.getElementById("authCard");
      this.captchaQ = document.getElementById("captchaQ");
      this.captchaInput = document.getElementById("captcha");
    }

    init() {
      this.initWindowBar();
      this.initServer();
      this.initCaptcha();
      this.initTabs();
      this.initAvatar();
      this.initSubmit();
      this.initLastLogin();
      this.initServerCheck();
    }

    /** 窗口控制：Electron 桌面壳下生效；浏览器中隐藏标题栏 */
    initWindowBar() {
      var winBar = document.querySelector(".login-titlebar");
      if (window.magicHub && window.magicHub.minimize) {
        document.getElementById("winMin").addEventListener("click", function () { window.magicHub.minimize(); });
        document.getElementById("winMax").addEventListener("click", function () { window.magicHub.maximize(); });
        document.getElementById("winClose").addEventListener("click", function () { window.magicHub.close(); });
      } else if (winBar) {
        winBar.hidden = true;
      }
    }

    initServer() {
      var injected = (window.magicHub && window.magicHub.serverBase) || "";
      // 服务器地址：上次保存的 > Electron 注入 > 本机默认
      this.serverEl.value = localStorage.getItem("magichub_server") || injected || "http://localhost:3000";
    }

    /** 规范化服务器地址并即时保存 */
    getAPI() {
      var v = this.serverEl.value.trim();
      if (!v) v = "http://localhost:3000";
      if (!/^https?:\/\//i.test(v)) v = "http://" + v;
      if (/\/$/.test(v)) v = v.slice(0, -1);
      return v;
    }

    showError(msg) { this.errorEl.textContent = msg; }

    /* ===== 注册算术验证码（服务端出题，一次性） ===== */
    initCaptcha() {
      var self = this;
      document.getElementById("captchaRefresh").addEventListener("click", function () { self.loadCaptcha(); });
    }

    loadCaptcha() {
      var self = this;
      var API = this.getAPI();
      fetch(API + "/api/register/captcha")
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.ok) {
            self.captcha = d.data;
            self.captchaQ.textContent = d.data.question;
            self.captchaInput.value = "";
          } else {
            self.captcha = { id: null, q: null };
            self.captchaQ.textContent = (d.error && d.error.message) || "获取失败，稍后重试";
          }
        })
        .catch(function () {
          self.captcha = { id: null, q: null };
          self.captchaQ.textContent = "服务器不可用，检查地址";
        });
    }

    setMode(m) {
      var self = this;
      this.mode = m;
      this.tabLogin.classList.toggle("on", m === "login");
      this.tabRegister.classList.toggle("on", m === "register");
      this.authCard.classList.toggle("reg", m === "register");
      this.submitBtn.textContent = m === "login" ? "登 录" : "注 册";
      this.switchHint.innerHTML = m === "login"
        ? '还没有账号？<button type="button" id="switchBtn2">去注册</button>'
        : '已有账号？<button type="button" id="switchBtn2">去登录</button>';
      document.getElementById("switchBtn2").addEventListener("click", function () {
        self.setMode(self.mode === "login" ? "register" : "login");
      });
      this.errorEl.textContent = "";
      if (m === "register") this.loadCaptcha(); // 进入注册模式时加载/刷新验证码
    }

    initTabs() {
      var self = this;
      this.tabLogin.addEventListener("click", function () { self.setMode("login"); });
      this.tabRegister.addEventListener("click", function () { self.setMode("register"); });
      this.switchBtn.addEventListener("click", function () { self.setMode(self.mode === "login" ? "register" : "login"); });
    }

    /* ===== 头像上传：读取 -> 中心裁剪 128x128 -> JPEG 压缩 -> 预览 ===== */
    initAvatar() {
      var self = this;
      var avatarInput = document.getElementById("avatarInput");
      var avatarImg = document.getElementById("avatarImg");
      var avatarPh = document.getElementById("avatarPh");

      avatarInput.addEventListener("change", function () {
        var file = avatarInput.files && avatarInput.files[0];
        if (!file) return;
        if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
          self.showError("仅支持 PNG / JPG / GIF / WebP 图片");
          return;
        }
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          var size = 128;
          var canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#252526";
          ctx.fillRect(0, 0, size, size);
          var side = Math.min(img.width, img.height);
          ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
          self.avatarData = canvas.toDataURL("image/jpeg", 0.85);
          avatarImg.src = self.avatarData;
          avatarImg.style.display = "block";
          avatarPh.style.display = "none";
          URL.revokeObjectURL(url);
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          self.showError("图片读取失败，请换一张");
        };
        img.src = url;
      });
    }

    /* ===== 提交 ===== */
    initSubmit() {
      var self = this;
      this.form.addEventListener("submit", function (e) { self.submit(e); });
    }

    submit(e) {
      e.preventDefault();
      var self = this;
      var username = this.usernameEl.value.trim();
      var password = this.passwordEl.value;

      if (!/^[\w-]{3,24}$/.test(username)) {
        this.showError("账号需为 3-24 位字母、数字、下划线或短横线");
        return;
      }
      if (password.length < 6) {
        this.showError("密码至少 6 位");
        return;
      }

      var body;
      if (this.mode === "register") {
        var name = this.displayNameEl.value.trim();
        if (!name) { this.showError("请填写名字"); return; }
        if (name.length > 32) { this.showError("名字最长 32 个字符"); return; }
        if (!this.captcha.id) { this.showError("验证码未加载，请重试"); this.loadCaptcha(); return; }
        if (!this.captchaInput.value.trim()) {
          this.showError("请完成验证码计算");
          return;
        }
        body = JSON.stringify({
          username: username, password: password, displayName: name, avatar: this.avatarData,
          captchaId: this.captcha.id, captchaAnswer: this.captchaInput.value.trim(),
        });
      } else {
        body = JSON.stringify({ username: username, password: password });
      }

      var submitBtn = this.submitBtn;
      submitBtn.disabled = true;
      submitBtn.textContent = this.mode === "login" ? "登录中…" : "注册中…";
      var API = this.getAPI();

      fetch(API + (this.mode === "login" ? "/api/login" : "/api/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.ok) {
            if (self.mode === "register") {
              // 注册成功：预填账号，切回登录态提示去登录
              self.setMode("login");
              self.usernameEl.value = username;
              self.passwordEl.value = "";
              self.showError("");
              self.switchHint.innerHTML = "注册成功，请登录";
              submitBtn.disabled = false;
              submitBtn.textContent = "登 录";
              return;
            }
            // 登录成功：保存会话（含 token、资料与服务器地址），进入主界面
            var d = data.data || {};
            var serverBase = self.getAPI();
            localStorage.setItem("magichub_server", serverBase);
            localStorage.setItem("magichub_session", JSON.stringify({
              username: d.username,
              displayName: d.displayName || d.username,
              avatar: d.avatar || null,
              token: d.token,
              serverBase: serverBase,
              loginAt: Date.now()
            }));
            location.href = "index.html";
          } else {
            self.showError((data.error && data.error.message) || "操作失败，请重试");
            // 注册场景：验证码错误/过期/被限流时刷新题面
            if (self.mode === "register" && data.error && /BAD_CAPTCHA|RATE_LIMITED|LOCKED/.test(data.error.code || "")) {
              self.loadCaptcha();
            }
            submitBtn.disabled = false;
            submitBtn.textContent = self.mode === "login" ? "登 录" : "注 册";
          }
        })
        .catch(function () {
          self.showError("无法连接服务器，请检查服务器地址是否正确（默认 http://localhost:3000）");
          submitBtn.disabled = false;
          submitBtn.textContent = self.mode === "login" ? "登 录" : "注 册";
        });
    }

    /* ===== 上次登录提示 ===== */
    initLastLogin() {
      // 默认停留在登录页：即使上次登录过也不自动进入，由用户确认登录后再进（避免 token 过期直接进入报"登录超时"）
      var last = localStorage.getItem("magichub_session");
      if (!last) return;
      try {
        var ls = JSON.parse(last);
        if (ls && ls.username) {
          document.getElementById("lastLoginName").textContent = ls.displayName || ls.username;
          document.getElementById("lastLogin").hidden = false;
          this.usernameEl.value = ls.username;
        }
      } catch (e) { /* 忽略损坏的会话 */ }
    }

    /* ===== 服务器地址验证：探测后端 /api/plugins，弹窗反馈结果 ===== */
    initServerCheck() {
      var self = this;
      var checkBtn = document.getElementById("serverCheck");
      var checkMask = document.getElementById("checkMask");
      checkBtn.addEventListener("click", function () {
        var api = self.getAPI();
        checkBtn.disabled = true;
        checkBtn.textContent = "验证中…";
        var done = function () { checkBtn.disabled = false; checkBtn.textContent = "验证"; };
        fetch(api + "/api/plugins", { method: "GET" })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok) {
              self.showCheckModal(true, "已成功连接到服务器，「" + api + "」地址没有问题，可以登录使用。");
            } else {
              self.showCheckModal(false, "服务器响应异常：请确认「" + api + "」是 MagicHub 服务器。");
            }
          })
          .catch(function () {
            self.showCheckModal(false, "无法连接到服务器「" + api + "」：请检查地址是否正确、服务器是否已启动。");
          })
          .finally(function () { done(); });
      });
      checkMask.addEventListener("click", function (e) { if (e.target === checkMask) checkMask.hidden = true; });
      document.getElementById("checkClose").addEventListener("click", function () { checkMask.hidden = true; });
    }

    showCheckModal(ok, body) {
      var modal = document.getElementById("checkModal");
      modal.classList.toggle("ok", ok);
      modal.classList.toggle("err", !ok);
      document.getElementById("checkTitle").innerHTML = ok
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>连接成功'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>连接失败';
      document.getElementById("checkBody").textContent = body;
      document.getElementById("checkMask").hidden = false;
    }
  }

  MH.LoginPage = LoginPage;

  new LoginPage().init();
})(window.MH = window.MH || {});
