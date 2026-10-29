/* ============================================================
   MagicHub · js/features/contacts-view.js —— 通讯录
   所有用户列表 / 查看资料 / 添加与删除好友（不能直接发消息）
   ============================================================ */
(function (MH) {
  "use strict";

  class ContactsView {
    constructor(http) {
      this.http = http;
      this.list = MH.Utils.$("userList");
      this.detail = MH.Utils.$("userDetail");
      this.selectedUser = null;
    }

    renderDetail(u) {
      var letter = (u.displayName || u.username).charAt(0).toUpperCase();
      var avatarHtml = u.avatar
        ? '<div class="big-avatar" style="background:var(--grad)"><img src="' + MH.Config.BASE + u.avatar + '" alt="" onerror="this.remove()"></div>'
        : '<div class="big-avatar">' + letter + '</div>';
      var btn = u.isFriend
        ? '<button class="add-btn del" id="detailDel">删除好友</button>'
        : '<button class="add-btn" id="detailAdd">添加好友</button>';
      this.detail.innerHTML = avatarHtml +
        '<div class="d-name">' + (u.displayName || u.username) + '</div>' +
        '<div class="d-tip">账号：' + u.username + '</div>' +
        '<div class="d-tip">' + (u.isFriend ? "你们已是好友，可在「会话」中聊天" : "添加好友后，即可在「会话」中聊天") + '</div>' + btn;
      var self = this;
      var addBtn = MH.Utils.$("detailAdd");
      if (addBtn) addBtn.addEventListener("click", function () { self.addFriend(u.username); });
      var delBtn = MH.Utils.$("detailDel");
      if (delBtn) delBtn.addEventListener("click", function () { self.removeFriend(u.username); });
    }

    loadUsers() {
      var self = this;
      this.http.api(MH.Config.BASE + "/api/users", { headers: this.http.authHeaders() })
        .then(function (data) {
          var users = (data.ok && data.data && data.data.users) || [];
          self.list.innerHTML = "";
          if (users.length === 0) {
            self.list.innerHTML = '<div class="c-prev" style="padding:16px;text-align:center;color:var(--text-3)">暂无其他用户</div>';
            return;
          }
          users.forEach(function (u) {
            var el = document.createElement("div");
            el.className = "c-item";
            el.innerHTML = MH.Utils.avatarHTML(u) +
              '<div class="ci-main"><div class="ci-name">' + (u.displayName || u.username) + '</div>' +
              '<div class="ci-acc">' + u.username + '</div></div>' +
              (u.isFriend
                ? '<button class="add-btn del" data-del="' + u.username + '">删除</button>'
                : '<button class="add-btn" data-add="' + u.username + '">添加</button>');
            el.addEventListener("click", function () {
              Array.prototype.forEach.call(self.list.children, function (x) { x.classList.remove("on"); });
              el.classList.add("on");
              self.selectedUser = u;
              self.renderDetail(u);
            });
            var addBtn = el.querySelector("[data-add]");
            if (addBtn) addBtn.addEventListener("click", function (ev) {
              ev.stopPropagation();
              self.addFriend(u.username);
            });
            var delBtn = el.querySelector("[data-del]");
            if (delBtn) delBtn.addEventListener("click", function (ev) {
              ev.stopPropagation();
              self.removeFriend(u.username);
            });
            self.list.appendChild(el);
          });
          if (self.selectedUser) {
            var match = users.filter(function (u) { return u.username === self.selectedUser.username; })[0];
            if (match) { self.selectedUser = match; self.renderDetail(match); }
          }
        })
        .catch(function () { /* 后端未启动 */ });
    }

    addFriend(username) {
      var self = this;
      this.http.api(MH.Config.BASE + "/api/friends/add", {
        method: "POST",
        headers: this.http.authHeaders(true),
        body: JSON.stringify({ username: username }),
      })
        .then(function (data) {
          if (data.ok) {
            MH.toast("已添加好友，去「会话」开始聊天吧");
            self.loadUsers();
            MH.app.convs.load();
          } else {
            MH.toast((data.error && data.error.message) || "添加失败");
          }
        })
        .catch(function () { MH.toast("添加失败，请检查后端服务"); });
    }

    /** 删除好友：两步确认（是否同时清空双方聊天记录） */
    removeFriend(username) {
      var self = this;
      if (!confirm("确定删除好友「" + username + "」？删除后将无法再看到对方，需重新添加才能聊天。")) return;
      var clearChat = confirm("是否同时清空双方的历史聊天记录？\n（选择「确定」= 同时清空服务器记录；选择「取消」= 仅解除好友，保留记录）");
      this.http.api(MH.Config.BASE + "/api/friends/remove", {
        method: "POST",
        headers: this.http.authHeaders(true),
        body: JSON.stringify({ username: username, clearChat: clearChat }),
      })
        .then(function (data) {
          if (data.ok) {
            MH.toast("已删除好友「" + username + "」" + (clearChat ? "，并清空聊天记录" : ""));
            // 若当前正与该好友聊天，关闭会话
            var convs = MH.app.convs;
            if (convs.activeConv && convs.convMeta[convs.activeConv] && convs.convMeta[convs.activeConv].peer.username === username) {
              convs.close();
            }
            self.loadUsers();
            MH.app.convs.load();
          } else {
            MH.toast((data.error && data.error.message) || "删除失败");
          }
        })
        .catch(function () { MH.toast("删除失败，请检查后端服务"); });
    }
  }

  MH.ContactsView = ContactsView;
})(window.MH = window.MH || {});
