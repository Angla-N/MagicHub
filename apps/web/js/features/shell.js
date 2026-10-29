/* ============================================================
   MagicHub · js/features/shell.js —— 主界面外壳
   视图切换（会话 / 通讯录 / 设置 / 插件市场 / 插件）
   导航栏激活态 / 会话列表显隐 / hash 路由
   ============================================================ */
(function (MH) {
  "use strict";

  class Shell {
    constructor() {
      this.viewTitle = MH.Utils.$("viewTitle");
      this.chatView = MH.Utils.$("chatView");
      this.contactsView = MH.Utils.$("contactsView");
      this.pluginView = MH.Utils.$("pluginView");
      this.settingsView = MH.Utils.$("settingsView");
      this.marketView = MH.Utils.$("marketView");
      this.railItems = Array.prototype.slice.call(document.querySelectorAll(".rail-item[data-view]"));
    }

    init() {
      var self = this;

      this.railItems.forEach(function (item) {
        item.addEventListener("click", function () {
          self.clearRailActive();
          item.classList.add("on");
          var v = item.getAttribute("data-view");
          if (v === "chat") self.showChat();
          else if (v === "contacts") self.showContacts();
          else if (v === "market") self.showMarket();
          else if (v === "settings") self.showSettings();
        });
      });

      MH.Utils.$("pluginClose").addEventListener("click", function () {
        self.showChat();
        self.clearRailActive();
        self.railItems[0].classList.add("on");
        if (location.hash) history.replaceState(null, "", location.pathname);
      });

      window.addEventListener("hashchange", function () { self.openByHash(); });
    }

    setListPane(show) { document.body.classList.toggle("chat-mode", !!show); }

    /* 未选会话时聊天界面全空：头像栏与输入栏都不显示，选中后才出现 */
    setChatChrome(show) {
      MH.Utils.$("chatHead").style.display = show ? "flex" : "none";
      MH.Utils.$("inputBar").style.display = show ? "flex" : "none";
    }

    hideAllViews() {
      this.chatView.style.display = "none";
      this.contactsView.style.display = "none";
      this.pluginView.style.display = "none";
      this.settingsView.style.display = "none";
      this.marketView.style.display = "none";
    }

    showChat() {
      this.hideAllViews();
      this.chatView.style.display = "flex";
      this.viewTitle.textContent = "会话";
      this.setListPane(true);
      var convs = MH.app.convs;
      this.setChatChrome(!!convs.activeConv);
      convs.load();
      // 切回聊天视图时重新拉取当前会话消息（与后端保持一致）
      if (convs.activeConv) convs.open(convs.activeConv);
    }

    showContacts() {
      this.hideAllViews();
      this.contactsView.style.display = "flex";
      this.viewTitle.textContent = "通讯录";
      this.setListPane(false);
      MH.app.contacts.loadUsers();
    }

    showSettings() {
      this.hideAllViews();
      this.settingsView.style.display = "flex";
      this.viewTitle.textContent = "设置";
      this.setListPane(false);
      MH.app.settings.render();
    }

    showMarket() {
      this.hideAllViews();
      this.marketView.style.display = "flex";
      this.viewTitle.textContent = "插件市场";
      this.setListPane(false);
      MH.app.market.render();
    }

    showPlugin(id, meta) {
      this.hideAllViews();
      this.pluginView.style.display = "flex";
      this.viewTitle.textContent = meta.name;
      MH.Utils.$("pluginTitle").textContent = meta.name;
      MH.Utils.$("pluginFrame").src = meta.localEntry || (MH.Config.BASE + "/plugins/" + id + "/" + meta.entry);
      this.setListPane(false);
    }

    clearRailActive() {
      this.railItems.forEach(function (x) { x.classList.remove("on"); });
      document.querySelectorAll("#pluginRail .rail-item").forEach(function (x) { x.classList.remove("on"); });
    }

    /* hash 路由：#plugin/<id> / #contacts / #settings / #market */
    openByHash() {
      var m = /^#plugin\/([^/]+)/.exec(location.hash);
      if (m && MH.app.plugins.entries[m[1]]) {
        this.clearRailActive();
        this.showPlugin(m[1], MH.app.plugins.entries[m[1]]);
        return;
      }
      if (location.hash === "#contacts") {
        this.clearRailActive();
        this.railItems[1].classList.add("on");
        this.showContacts();
        return;
      }
      if (location.hash === "#market") {
        this.clearRailActive();
        var mi = this.railItems.findIndex(function (x) { return x.getAttribute("data-view") === "market"; });
        if (mi >= 0) this.railItems[mi].classList.add("on");
        this.showMarket();
        return;
      }
      if (location.hash === "#settings") {
        this.clearRailActive();
        this.railItems[this.railItems.length - 1].classList.add("on");
        this.showSettings();
        return;
      }
      this.showChat();
      this.clearRailActive();
      this.railItems[0].classList.add("on");
    }
  }

  MH.Shell = Shell;
})(window.MH = window.MH || {});
