/* ============================================================
   MagicHub · js/features/plugin-store.js —— 插件仓库
   本地已装插件 / 服务器市场插件 / 侧栏入口 / 下载安装 / 卸载 / 发布
   ============================================================ */
(function (MH) {
  "use strict";

  class PluginStore {
    constructor(http, session) {
      this.http = http;
      this.session = session;
      this.local = [];   // 桌面端：本地已安装插件
      this.market = [];  // 服务器市场插件列表
      this.entries = {}; // pluginId -> 插件元数据（侧栏入口 / hash 路由）
    }

    /** 插件图标地址：服务端已提取图标 > 绝对地址 > 本地目录 > 服务器插件目录 */
    iconUrl(p) {
      if (!p.icon) return null;
      if (p.iconUrl) return MH.Config.BASE + p.iconUrl;
      if (/^(https?:)?\/\//.test(p.icon)) return p.icon;
      if (p.localEntry) return "file:///" + (p.localEntry.slice("file:///".length).split("/").slice(0, -1).join("/") + "/" + p.icon);
      return MH.Config.BASE + "/plugins/" + p.id + "/" + p.icon;
    }

    /** 渲染侧边栏插件区（本地已装插件） */
    renderRail() {
      var rail = MH.Utils.$("pluginRail");
      rail.innerHTML = "";
      this.entries = {};
      var list = this.local.filter(function (p) { return p.enabled !== false; }); // 侧栏只显示启用插件
      // 浏览器模式（无桌面 IPC）：回退显示服务器公开插件
      if (!window.magicHub || !window.magicHub.listLocalPlugins) {
        list = this.market.filter(function (p) { return p.public !== false; });
      }
      list.forEach(function (p) {
        this.entries[p.id] = p;
        var btn = document.createElement("button");
        btn.className = "rail-item";
        btn.title = p.name + "（插件）";
        var icon = this.iconUrl(p);
        if (icon) {
          var img = document.createElement("img");
          img.src = icon; img.alt = "";
          btn.appendChild(img);
        } else {
          btn.textContent = p.name.charAt(0);
          btn.style.fontWeight = "800"; btn.style.fontSize = "14px"; btn.style.color = "var(--accent-soft)";
        }
        btn.addEventListener("click", function () {
          MH.app.shell.clearRailActive(); btn.classList.add("on");
          MH.app.shell.showPlugin(p.id, p);
        });
        rail.appendChild(btn);
      }, this);
      MH.Utils.$("pluginSep").hidden = list.length === 0;
    }

    /** 加载插件：本地已装 + 服务器市场，两者就绪后渲染侧栏并恢复 hash 视图 */
    load() {
      var self = this;
      var localDone = false;
      function done() {
        if (localDone) {
          self.renderRail();
          MH.app.shell.openByHash();
        }
      }

      // 桌面端：读取本地已装插件
      if (window.magicHub && window.magicHub.listLocalPlugins) {
        window.magicHub.listLocalPlugins()
          .then(function (list) {
            self.local = list || [];
            localDone = true; done();
          })
          .catch(function () { localDone = true; done(); });
      } else {
        localDone = true;
      }

      // 服务器市场列表
      this.http.api(MH.Config.BASE + "/api/plugins", { headers: this.http.authHeaders() })
        .then(function (data) {
          self.market = (data.ok && data.data && data.data.plugins) || [];
          localDone = true; done();
        })
        .catch(function () { /* 后端未启动 */ });
    }

    /** 下载安装：拉 7z → 交给桌面端解压到本地 */
    install(p) {
      var self = this;
      if (!window.magicHub || !window.magicHub.installPlugin) {
        MH.toast("请在桌面客户端中下载安装插件（浏览器模式仅支持浏览与上传）");
        return;
      }
      MH.toast("正在下载 " + p.name + " …");
      fetch(MH.Config.BASE + "/api/plugins/" + encodeURIComponent(p.id) + "/download", {
        headers: { Authorization: "Bearer " + this.session.token },
      })
        .then(function (res) {
          if (res.status === 401) {
            MH.Session.clear();
            location.replace("login.html");
            throw new Error("登录已过期");
          }
          if (!res.ok) throw new Error("下载失败");
          return res.arrayBuffer();
        })
        .then(function (buf) {
          return window.magicHub.installPlugin(p.id, buf);
        })
        .then(function (info) {
          MH.toast("插件「" + info.name + "」安装成功");
          return window.magicHub.listLocalPlugins();
        })
        .then(function (list) {
          self.local = list || [];
          self.renderRail();
          MH.app.market.render();
        })
        .catch(function (err) { MH.toast("安装失败：" + (err.message || err)); });
    }

    uninstall(id) {
      var self = this;
      if (!window.magicHub || !window.magicHub.uninstallPlugin) {
        MH.toast("请在桌面客户端中卸载插件");
        return Promise.resolve();
      }
      return window.magicHub.uninstallPlugin(id)
        .then(function () {
          MH.toast("插件已卸载");
          return window.magicHub.listLocalPlugins();
        })
        .then(function (list) {
          self.local = list || [];
          self.renderRail();
          MH.app.market.render();
        })
        .catch(function (err) { MH.toast("卸载失败：" + (err.message || err)); });
    }

    /** 上传 .7z 插件包到服务器 */
    upload(file) {
      var self = this;
      if (!/\.7z$/i.test(file.name)) {
        MH.toast("请选择 .7z 格式的插件包（可用 tools/plugin-pack.py 生成）");
        return;
      }
      if (file.size > 10 * 1024 * 1024) { MH.toast("插件包不能超过 10MB"); return; }
      MH.toast("正在上传 " + file.name + " …");
      var fr = new FileReader();
      fr.onload = function () {
        var data = fr.result; // dataURL
        self.http.api(MH.Config.BASE + "/api/plugins/upload", {
          method: "POST",
          headers: self.http.authHeaders(true),
          body: JSON.stringify({ name: file.name, data: data }),
        })
          .then(function (d) {
            if (d.ok) {
              MH.toast("插件「" + d.data.name + "」已发布到服务器（默认为私有，可在市场中设为公开）");
              return self.http.api(MH.Config.BASE + "/api/plugins", { headers: self.http.authHeaders() });
            }
            throw new Error((d.error && d.error.message) || "上传失败");
          })
          .then(function (d) {
            self.market = (d.ok && d.data && d.data.plugins) || [];
            MH.app.market.render();
          })
          .catch(function (err) { MH.toast("上传失败：" + (err.message || err)); });
      };
      fr.readAsDataURL(file);
    }
  }

  MH.PluginStore = PluginStore;
})(window.MH = window.MH || {});
