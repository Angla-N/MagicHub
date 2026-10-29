/* ============================================================
   MagicHub · js/features/settings-view.js —— 设置视图
   账号资料编辑 / 后台驻留开关 / 服务器存储占用 / 已启用插件
   ============================================================ */
(function (MH) {
  "use strict";

  class SettingsView {
    constructor(http, session) {
      this.http = http;
      this.session = session;
      this.pendingAvatar = null; // 待保存的新头像 dataURL
    }

    init() {
      var self = this;

      MH.Utils.$("setAvatarBtn").addEventListener("click", function () { MH.Utils.$("setAvatarInput").click(); });
      MH.Utils.$("setAvatarInput").addEventListener("change", function () {
        if (!this.files || !this.files[0]) return;
        var file = this.files[0];
        if (file.size > 300 * 1024) { MH.toast("头像不能超过 300KB"); this.value = ""; return; }
        var fr = new FileReader();
        fr.onload = function () {
          self.pendingAvatar = fr.result;
          var wrap = MH.Utils.$("setAvatarWrap");
          wrap.innerHTML = "";
          var img = document.createElement("img");
          img.src = self.pendingAvatar;
          wrap.appendChild(img);
          MH.toast("头像已选择，点击「保存资料」生效");
        };
        fr.readAsDataURL(file);
        this.value = "";
      });

      MH.Utils.$("setProfileSave").addEventListener("click", function () { self.saveProfile(this); });

      // 后台驻留开关变化时写入桌面端设置
      MH.Utils.$("keepCheck").addEventListener("change", function () {
        if (window.magicHub && window.magicHub.setKeepInBackground) {
          window.magicHub.setKeepInBackground(this.checked).then(function () {
            MH.toast(this.checked ? "已开启后台驻留：关闭窗口时最小化到托盘" : "已关闭后台驻留：关闭窗口将退出程序");
          }.bind(this));
        }
      });
    }

    /** 进入设置页时渲染全部内容 */
    render() {
      var session = this.session;
      // 填充账号信息与服务器地址
      MH.Utils.$("setNameInput").value = session.displayName;
      MH.Utils.$("setUsername").textContent = session.username;
      MH.Utils.$("setServer").textContent = MH.Config.BASE;
      this.renderAvatar();
      this.loadStats();

      // 后台驻留开关（仅桌面端）
      var keepRow = MH.Utils.$("keepRow");
      if (window.magicHub && window.magicHub.getKeepInBackground) {
        keepRow.style.display = "flex";
        window.magicHub.getKeepInBackground().then(function (v) { MH.Utils.$("keepCheck").checked = !!v; });
      } else {
        keepRow.style.display = "none";
      }

      // 已启用插件列表（本地已装）
      var store = MH.app.plugins;
      var box = MH.Utils.$("setPlugins");
      var list = store.local.length ? store.local : (window.magicHub ? [] : store.market.filter(function (p) { return p.public !== false; }));
      if (!list.length) {
        box.innerHTML = '<div class="set-empty">暂无插件，去「插件市场」下载安装</div>';
        return;
      }
      box.innerHTML = "";
      list.forEach(function (p) {
        var row = document.createElement("div");
        row.className = "set-plugin";
        var icon = store.iconUrl(p);
        var enabled = p.enabled !== false;
        row.innerHTML = (icon ? '<img src="' + icon + '" alt="">' : '<span class="set-plugin-letter">' + p.name.charAt(0) + '</span>') +
          '<div class="set-plugin-meta"><b>' + p.name + '</b><span>' + (p.description || "MagicHub 插件") + ' · v' + (p.version || "-") + '</span></div>' +
          (window.magicHub && window.magicHub.setPluginEnabled
            ? '<label class="switch" data-id="' + p.id + '"><input type="checkbox" data-enable="' + p.id + '"' + (enabled ? " checked" : "") + '><span class="slider"></span></label>'
            : '<span class="set-plugin-on">已启用</span>') +
          (window.magicHub && window.magicHub.uninstallPlugin
            ? '<button class="set-btn danger" data-uninstall="' + p.id + '" title="卸载插件（删除目录）">卸载</button>'
            : "");
        box.appendChild(row);
      });

      // 启停开关：停用后侧栏入口立即消失；启用后恢复
      Array.prototype.forEach.call(box.querySelectorAll("[data-enable]"), function (cb) {
        cb.addEventListener("change", function () {
          var id = this.getAttribute("data-enable");
          window.magicHub.setPluginEnabled(id, this.checked).then(function (ok) {
            if (!ok) { MH.toast("切换失败"); return; }
            MH.toast(this.checked ? "插件已启用" : "插件已停用（数据保留，可随时恢复）");
            return window.magicHub.listLocalPlugins();
          }.bind(this)).then(function (list) {
            if (list) {
              store.local = list || [];
              store.renderRail();
              MH.app.settings.render(); // 重渲染设置页插件列表
            }
          }).catch(function () {});
        });
      });

      // 卸载按钮
      Array.prototype.forEach.call(box.querySelectorAll("[data-uninstall]"), function (btn) {
        btn.addEventListener("click", function () {
          var id = this.getAttribute("data-uninstall");
          store.uninstall(id).then(function () { MH.app.settings.render(); });
        });
      });
    }

    /** 头像预览（偶发未保存时只更新页面，不改账号） */
    renderAvatar() {
      var wrap = MH.Utils.$("setAvatarWrap");
      var session = this.session;
      wrap.innerHTML = "";
      if (session.avatar) {
        var img = document.createElement("img");
        img.src = MH.Config.BASE + session.avatar;
        img.alt = "我的头像";
        img.onerror = function () { wrap.textContent = session.displayName.charAt(0).toUpperCase(); };
        wrap.appendChild(img);
      } else {
        wrap.textContent = session.displayName.charAt(0).toUpperCase();
      }
    }

    /** 服务器存储占用 */
    loadStats() {
      var http = this.http;
      http.api(MH.Config.BASE + "/api/server/stats", { headers: http.authHeaders() })
        .then(function (d) {
          if (!d.ok || !d.data) return;
          var s = d.data;
          MH.Utils.$("stTotal").textContent = s.total || "-";
          MH.Utils.$("stChat").textContent = s.chat || "-";
          MH.Utils.$("stUploads").textContent = s.uploads || "-";
          MH.Utils.$("stAvatars").textContent = s.avatars || "-";
          MH.Utils.$("stPlugins").textContent = s.plugins || "-";
        })
        .catch(function () { /* 后端未启动 */ });
    }

    /** 保存昵称/头像 */
    saveProfile(btn) {
      var session = this.session;
      var name = MH.Utils.$("setNameInput").value.trim();
      var body = {};
      if (name && name !== session.displayName) body.displayName = name;
      if (this.pendingAvatar) body.avatar = this.pendingAvatar;
      if (!body.displayName && !body.avatar) { MH.toast("没有需要保存的修改"); return; }
      var self = this;
      btn.disabled = true;
      this.http.api(MH.Config.BASE + "/api/account/profile", {
        method: "POST",
        headers: this.http.authHeaders(true),
        body: JSON.stringify(body),
      }).then(function (d) {
        btn.disabled = false;
        if (!d.ok) { MH.toast((d.error && d.error.message) || "保存失败"); return; }
        var u = d.data;
        session.applyProfile(u);
        self.pendingAvatar = null;
        MH.app.myProfile.renderAvatar();
        self.renderAvatar();
        MH.app.convs.load(); // 会话栏名字/头像即时刷新
        MH.toast("资料已更新");
      }).catch(function () { btn.disabled = false; MH.toast("保存失败，请检查后端服务"); });
    }
  }

  MH.SettingsView = SettingsView;
})(window.MH = window.MH || {});
