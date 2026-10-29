/* ============================================================
   MagicHub · js/app.js —— 主界面启动装配
   校验登录会话 → 解析配置 → 实例化各组件 → 绑定事件 → 拉取数据并连接
   ============================================================ */
(function (MH) {
  "use strict";

  class App {
    start() {
      /* 登录门禁：必须真实登录后才能进入主界面 */
      var session = MH.Session.open();
      if (!session) {
        MH.Session.clear();
        location.replace("login.html");
        return;
      }

      /* 服务地址：用户填写的服务器地址 > Electron 注入 > 本机默认 */
      MH.Config.resolve(session.data);

      var app = MH.app = {};
      app.session = session;
      app.http = new MH.Http(session);

      /* 通用组件 */
      app.windowBar = new MH.WindowBar();
      app.lightbox = new MH.Lightbox();
      app.myProfile = new MH.MyProfile(session);
      app.pwdDialog = new MH.PasswordDialog(app.http);

      /* 业务功能 */
      app.shell = new MH.Shell();
      app.plugins = new MH.PluginStore(app.http, session);
      app.market = new MH.MarketView(app.http);
      app.settings = new MH.SettingsView(app.http, session);
      app.messages = new MH.Messages(app.http);
      app.convs = new MH.Conversations(app.http);
      app.composer = new MH.Composer(app.http);
      app.presence = new MH.Presence();
      app.contacts = new MH.ContactsView(app.http);
      app.realtime = new MH.Realtime(session);

      /* 依赖当前会话/联系人状态的组件 */
      app.peerCard = new MH.PeerCard(app.convs);
      app.globalSearch = new MH.GlobalSearch(app.http, app.convs);
      app.msgSearch = new MH.MessageSearch();

      /* 绑定事件（依赖组件已全部就绪） */
      app.windowBar.init();
      app.lightbox.init();
      app.myProfile.init();
      app.pwdDialog.init();
      app.shell.init();
      app.peerCard.init();
      app.globalSearch.init();
      app.msgSearch.init();
      app.messages.init();
      app.convs.init();
      app.composer.init();
      app.presence.init();
      app.settings.init();
      app.market.init();

      /* 进入主界面先校验 token 是否过期（401 时 api() 统一清会话并跳登录页） */
      app.http.api(MH.Config.BASE + "/api/me", { headers: app.http.authHeaders() })
        .catch(function () { /* api() 已处理 401；网络错误保持页面 */ });

      app.plugins.load();
      app.realtime.connect();
    }
  }

  new App().start();
})(window.MH = window.MH || {});
