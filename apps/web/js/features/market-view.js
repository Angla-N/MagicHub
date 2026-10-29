/* ============================================================
   MagicHub · js/features/market-view.js —— 插件市场视图
   统计 / 全部与我的分组 / 安装更新卸载 / 公开私有 / 删除
   ============================================================ */
(function (MH) {
  "use strict";

  class MarketView {
    constructor(http) {
      this.http = http;
      this.tab = "all"; // all | mine
      this.body = MH.Utils.$("marketBody");
    }

    get store() { return MH.app.plugins; }

    icon(p) {
      var icon = this.store.iconUrl(p);
      return icon ? '<img src="' + icon + '" alt="">' : p.name.charAt(0);
    }

    installedIds() {
      var s = {};
      this.store.local.forEach(function (p) { s[p.id] = p; });
      return s;
    }

    /** 市场去重合并：服务器市场项 + 本地已装项 */
    merged() {
      var shown = {};
      this.store.market.forEach(function (p) { shown[p.id] = p; });
      this.store.local.forEach(function (p) { if (!shown[p.id]) shown[p.id] = p; });
      return shown;
    }

    renderStats() {
      var local = this.installedIds();
      var mine = this.store.market.filter(function (p) { return p.isOwner; }).length;
      MH.Utils.$("mstatMine").textContent = mine;
      MH.Utils.$("mstatInstalled").textContent = Object.keys(local).length;
      MH.Utils.$("mstatAll").textContent = this.store.market.length;
    }

    render() {
      this.renderStats();
      var box = this.body;
      var local = this.installedIds();
      var shown = this.merged();
      var ids = Object.keys(shown);
      if (!ids.length) {
        box.innerHTML = '<div class="market-empty">市场为空：先用右上角「上传」按钮把 .7z 插件包发布到服务器</div>';
        return;
      }
      // 按 Tab 过滤：全部 = 公开项 + 我的（含私有）；我的 = 我发布的 + 我已下载的
      var self = this;
      var visible = ids.filter(function (id) {
        var p = shown[id];
        if (self.tab === "mine") {
          return p.isOwner || local[id];
        }
        return p.public !== false || p.isOwner || local[id];
      });
      if (!visible.length) {
        box.innerHTML = '<div class="market-empty">' + (this.tab === "mine" ? "还没有你发布或下载的插件" : "暂无公开插件") + '</div>';
        return;
      }
      box.innerHTML = "";
      visible.forEach(function (id) {
        var p = shown[id];
        var lp = local[id];
        var isLocal = !!lp;
        var isOwner = p.isOwner;
        var card = document.createElement("div");
        card.className = "mkt-card";

        var actions = "";
        var badge = "";
        if (isLocal) {
          // 本地已装且市场版本更高 → 显示"更新"（覆盖安装，不重复计数）
          var hasUpdate = p.version && lp.version && MH.Utils.versionCmp(p.version, lp.version) > 0;
          badge = '<span class="mkt-badge inst">' + (hasUpdate ? "可更新" : "已安装") + '</span>';
          actions += hasUpdate
            ? '<button class="mkt-btn primary" data-act="update" data-id="' + id + '">更新</button>'
            : "";
          actions += '<button class="mkt-btn danger" data-act="uninstall" data-id="' + id + '">卸载</button>';
        } else {
          badge = p.public === false ? '<span class="mkt-badge priv">未公开</span>' : '<span class="mkt-badge pub">公开</span>';
          actions += '<button class="mkt-btn primary" data-act="install" data-id="' + id + '">下载安装</button>';
        }
        if (isOwner) {
          actions += '<button class="mkt-btn" data-act="toggle" data-id="' + id + '">' + (p.public === false ? "设为公开" : "设为私有") + "</button>";
          actions += '<button class="mkt-btn danger" data-act="delete" data-id="' + id + '">删除</button>';
        }

        card.innerHTML =
          '<div class="mkt-top">' +
            '<div class="mkt-icon">' + self.icon(p) + '</div>' +
            '<div class="mkt-info">' +
              '<b>' + p.name + ' <span style="color:var(--text-3);font-weight:600;font-size:11px">v' + p.version + '</span></b>' +
              '<div class="mkt-meta">作者：' + p.author + ' · ' + id + '</div>' +
            '</div>' +
          '</div>' +
          (p.description ? '<div class="mkt-desc">' + p.description + '</div>' : "") +
          '<div class="mkt-actions">' + badge + actions + '</div>';

        box.appendChild(card);
      });
    }

    setTabUI() {
      var all = MH.Utils.$("mktTabAll");
      var mineTab = MH.Utils.$("mktTabMine");
      var on = this.tab === "mine" ? mineTab : all;
      all.classList.toggle("on", on === all);
      mineTab.classList.toggle("on", on === mineTab);
    }

    init() {
      var self = this;

      MH.Utils.$("mktTabAll").addEventListener("click", function () { self.tab = "all"; self.setTabUI(); self.render(); });
      MH.Utils.$("mktTabMine").addEventListener("click", function () { self.tab = "mine"; self.setTabUI(); self.render(); });

      /* 上传 .7z 插件包 */
      MH.Utils.$("pluginUploadBtn").addEventListener("click", function () { MH.Utils.$("pluginPackInput").click(); });
      MH.Utils.$("pluginPackInput").addEventListener("change", function () {
        if (this.files && this.files[0]) self.store.upload(this.files[0]);
        this.value = "";
      });

      this.body.addEventListener("click", function (e) {
        var btn = e.target.closest(".mkt-btn");
        if (!btn) return;
        var act = btn.getAttribute("data-act"), id = btn.getAttribute("data-id");
        var p = self.store.market.find(function (x) { return x.id === id; }) || {};
        if (act === "install") self.store.install(p);
        else if (act === "update") self.store.install(p); // 更新 = 下载新版覆盖安装
        else if (act === "uninstall") self.store.uninstall(id);
        else if (act === "delete") {
          if (!confirm("确定删除插件「" + (p.name || id) + "」？服务器与市场中的该插件都会被删除。")) return;
          self.http.api(MH.Config.BASE + "/api/plugins/" + encodeURIComponent(id), {
            method: "DELETE",
            headers: self.http.authHeaders(),
          })
            .then(function (d) {
              if (!d.ok) throw new Error((d.error && d.error.message) || "删除失败");
              MH.toast("插件已删除");
              return self.http.api(MH.Config.BASE + "/api/plugins", { headers: self.http.authHeaders() });
            })
            .then(function (d) {
              self.store.market = (d.ok && d.data && d.data.plugins) || [];
              self.render();
            })
            .catch(function (err) { MH.toast("删除失败：" + (err.message || err)); });
        } else if (act === "toggle") {
          var toPublic = p.public === false;
          self.http.api(MH.Config.BASE + "/api/plugins/" + encodeURIComponent(id) + "/visibility", {
            method: "POST",
            headers: self.http.authHeaders(true),
            body: JSON.stringify({ public: toPublic }),
          })
            .then(function (d) {
              if (!d.ok) throw new Error((d.error && d.error.message) || "设置失败");
              MH.toast(toPublic ? "插件已公开，所有用户可见" : "插件已设为私有");
              return self.http.api(MH.Config.BASE + "/api/plugins", { headers: self.http.authHeaders() });
            })
            .then(function (d) {
              self.store.market = (d.ok && d.data && d.data.plugins) || [];
              self.render();
            })
            .catch(function (err) { MH.toast("设置失败：" + (err.message || err)); });
        }
      });
    }
  }

  MH.MarketView = MarketView;
})(window.MH = window.MH || {});
