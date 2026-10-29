/* ============================================================
   MagicHub · js/features/conversations.js —— 会话列表与当前会话
   列表渲染 / 未读角标 / 搜索过滤 / 打开会话 / 历史分页 / 撤回
   ============================================================ */
(function (MH) {
  "use strict";

  class Conversations {
    constructor(http) {
      this.http = http;
      this.list = MH.Utils.$("chatList");
      this.searchInput = MH.Utils.$("convSearch");

      this.activeConv = null;
      this.convMeta = {};   // convId -> { id, peer, unread }
      this.lastConvs = [];
      this.searchKw = "";

      // 当前会话消息内存状态：滚动分页加载（顶部加载更早）
      this.msgs = [];
      this.hasMore = false;
      this.loadingMore = false;
      this.oldestTs = 0;
    }

    init() {
      var self = this;
      this.searchInput.addEventListener("input", function () {
        self.searchKw = this.value.trim().toLowerCase();
        self.render();
      });
    }

    render() {
      var self = this;
      var kw = this.searchKw;
      var convs = this.lastConvs;
      this.convMeta = {};
      this.list.innerHTML = "";
      var shown = convs.filter(function (c) {
        if (!kw) return true;
        var name = (c.peer.displayName || c.peer.username).toLowerCase();
        var last = c.last ? c.last.text.toLowerCase() : "";
        return name.indexOf(kw) >= 0 || last.indexOf(kw) >= 0;
      });
      if (shown.length === 0) {
        this.list.innerHTML = '<div class="c-prev" style="padding:16px;text-align:center;color:var(--text-3)">' +
          (convs.length === 0 ? "暂无会话<br>去「通讯录」添加好友" : "没有匹配的会话或消息") + '</div>';
        return;
      }
      shown.forEach(function (c) {
        self.convMeta[c.id] = c;
        var el = document.createElement("div");
        el.className = "chat-item" + (c.id === self.activeConv ? " on" : "");
        el.setAttribute("data-conv", c.id);
        var last = c.last
          ? (c.last.from === MH.app.session.username ? "我：" : "") + MH.Utils.previewText(c.last)
          : "你们已成为好友，开始聊天吧";
        var badgeHtml = c.unread > 0 ? '<span class="badge">' + (c.unread > 99 ? "99+" : c.unread) + '</span>' : "";
        // 在线状态点（会话列表头像右下）
        var od = MH.app.presence.onlineUsers[c.peer.username] ? '<i class="online-dot"></i>' : "";
        el.innerHTML = '<span class="av-wrap">' + MH.Utils.avatarHTML(c.peer) + od + badgeHtml + '</span>' +
          '<div class="c-main"><div class="c-row"><span class="c-name">' + (c.peer.displayName || c.peer.username) + '</span>' +
          '<span class="c-time">' + MH.Utils.fmtTime(c.last && c.last.ts) + '</span></div>' +
          '<div class="c-prev"></div></div>';
        el.querySelector(".c-prev").textContent = last;
        el.addEventListener("click", function () { self.open(c.id); });
        self.list.appendChild(el);
      });
    }

    updateBadge(convId, n) {
      var el = this.list.querySelector('[data-conv="' + convId + '"]');
      if (!el) return;
      var wrap = el.querySelector(".av-wrap");
      var badge = el.querySelector(".badge");
      if (n > 0) {
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "badge";
          wrap.appendChild(badge);
        }
        badge.textContent = n > 99 ? "99+" : n;
      } else if (badge) {
        badge.remove();
      }
    }

    load() {
      var self = this;
      this.http.api(MH.Config.BASE + "/api/conversations", { headers: this.http.authHeaders() })
        .then(function (data) {
          self.lastConvs = (data.ok && data.data && data.data.conversations) || [];
          self.render();
        })
        .catch(function () { /* 后端未启动 */ });
    }

    /** 关闭会话（清空聊天区，隐藏输入栏） */
    close() {
      this.activeConv = null;
      MH.app.shell.setChatChrome(false);
      MH.app.messages.reset();
      MH.Utils.$("emptyTip").style.display = "none";
      MH.app.presence.hide();
      // 重置会话消息内存状态
      this.msgs = [];
      this.hasMore = false;
      this.loadingMore = false;
      this.oldestTs = 0;
    }

    /** 打开会话：标记已读 + 加载历史 + 可发送 */
    open(convId) {
      var self = this;
      this.activeConv = convId;
      MH.app.presence.hide();
      MH.app.shell.setChatChrome(true);
      Array.prototype.forEach.call(this.list.children, function (el) {
        el.classList.toggle("on", el.getAttribute("data-conv") === convId);
      });
      var meta = this.convMeta[convId];
      if (meta) {
        MH.Utils.$("chatName").textContent = meta.peer.displayName || meta.peer.username;
        MH.Utils.$("peerAv").innerHTML = MH.Utils.avatarHTML(meta.peer);
        MH.app.presence.updateChatHeadPresence();
        // 标记已读：清零未读角标
        if (meta.unread > 0) {
          meta.unread = 0;
          this.updateBadge(convId, 0);
          fetch(MH.Config.BASE + "/api/conversations/read", {
            method: "POST",
            headers: this.http.authHeaders(true),
            body: JSON.stringify({ convId: convId }),
          }).catch(function () { /* 失败下次再清 */ });
        }
      }

      var area = MH.Utils.$("msgArea");
      var empty = MH.Utils.$("emptyTip");
      // 只清历史消息气泡，保留 emptyTip 占位节点（后续渲染依赖它）
      MH.app.messages.reset();
      empty.style.display = "none";
      // 重置分组与分页状态
      this.msgs = [];
      this.hasMore = false;
      this.loadingMore = false;
      this.oldestTs = 0;

      // 先渲染本地缓存（前端本地保存最近记录，弱网/离线也能立即看到）
      var cached = MH.MessageCache.read(convId);
      cached.forEach(function (m) { MH.app.messages.append(m, m.from === MH.app.session.username); });
      if (cached.length) area.scrollTop = area.scrollHeight;

      this.http.api(MH.Config.BASE + "/api/messages?conv=" + encodeURIComponent(convId), { headers: this.http.authHeaders() })
        .then(function (data) {
          if (!data.ok) {
            if (!cached.length) {
              empty.style.display = "";
              MH.Utils.$("emptyText").textContent = (data.error && data.error.message) || "无法加载消息";
            }
            return;
          }
          var msgs = data.data.messages || [];
          self.msgs = msgs.slice();
          self.hasMore = !!data.data.hasMore;
          self.oldestTs = msgs.length ? msgs[0].ts : 0;
          MH.MessageCache.write(convId, msgs);
          // 用服务器最新记录替换缓存气泡，避免重复
          MH.app.messages.reset();
          if (msgs.length === 0) {
            empty.style.display = "";
            MH.Utils.$("emptyText").textContent = "你们已成为好友，发一条消息打个招呼吧";
            return;
          }
          msgs.forEach(function (m) { MH.app.messages.append(m, m.from === MH.app.session.username); });
          // 已读回执：对方最近一次已读时间 >= 最后一条消息时间 → 显示"已读"
          var peerLastRead = data.data.peerLastRead || 0;
          var myLast = null;
          for (var i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].from === MH.app.session.username && !msgs[i].deleted) { myLast = msgs[i]; break; }
          }
          if (myLast && peerLastRead >= myLast.ts && msgs[msgs.length - 1] && msgs[msgs.length - 1].from === MH.app.session.username) {
            var rt = document.createElement("div");
            rt.className = "read-receipt";
            rt.textContent = "已读";
            rt.title = "对方于 " + MH.Utils.fmtTime(peerLastRead) + " 已读";
            area.appendChild(rt);
          }
          area.scrollTop = area.scrollHeight;
          self.bindScrollLoad(area);
        })
        .catch(function () { if (!cached.length) empty.style.display = ""; });

      var connected = MH.app.realtime.isOpen();
      MH.Utils.$("input").disabled = !connected;
      MH.Utils.$("sendBtn").disabled = !connected;
    }

    /** 加载更早的历史消息（滚动到顶部触发） */
    loadEarlier() {
      var self = this;
      if (!this.activeConv || this.loadingMore || !this.hasMore || !this.oldestTs) return;
      this.loadingMore = true;
      var area = MH.Utils.$("msgArea");
      var prevH = area.scrollHeight;
      var prevTop = area.scrollTop;
      this.http.api(MH.Config.BASE + "/api/messages?conv=" + encodeURIComponent(this.activeConv) + "&before=" + this.oldestTs, { headers: this.http.authHeaders() })
        .then(function (data) {
          self.loadingMore = false;
          if (!data.ok || !data.data) return;
          var older = data.data.messages || [];
          if (!older.length) { self.hasMore = false; return; }
          self.msgs = older.concat(self.msgs);
          self.hasMore = !!data.data.hasMore;
          self.oldestTs = older.length ? older[0].ts : self.oldestTs;
          // 整体重渲染（分组状态重置，保证顶部日期/时间正确）
          MH.app.messages.reset();
          self.msgs.forEach(function (m) { MH.app.messages.append(m, m.from === MH.app.session.username); });
          // 保持原滚动位置（新内容插在顶部）
          area.scrollTop = area.scrollHeight - prevH + prevTop;
        })
        .catch(function () { self.loadingMore = false; });
    }

    bindScrollLoad(area) {
      var self = this;
      area.onscroll = function () {
        if (area.scrollTop < 48) self.loadEarlier();
      };
    }

    /** 撤回自己发送的消息 */
    recall(msgId) {
      var self = this;
      if (!this.activeConv) return;
      this.http.api(MH.Config.BASE + "/api/messages/recall", {
        method: "POST",
        headers: this.http.authHeaders(true),
        body: JSON.stringify({ convId: this.activeConv, id: msgId }),
      }).then(function (d) {
        if (d.ok) {
          MH.toast("已撤回");
          self.recallLocal(self.activeConv, msgId);
          self.load();
        } else {
          MH.toast((d.error && d.error.message) || "撤回失败");
        }
      }).catch(function () { MH.toast("撤回失败，请检查后端服务"); });
    }

    /** 本地把消息标记为"已撤回"：同步当前气泡 + 更新缓存（其他端撤回推送时也调用） */
    recallLocal(convId, msgId) {
      var cache = MH.MessageCache.read(convId);
      var changed = false;
      cache.forEach(function (m) {
        if (String(m.id || "") === String(msgId || "")) { m.deleted = true; changed = true; }
      });
      if (changed) MH.MessageCache.write(convId, cache);
      // 同步内存会话数组（滚动分页重渲染时保持一致）
      this.msgs.forEach(function (m) {
        if (String(m.id || "") === String(msgId || "")) m.deleted = true;
      });
      MH.app.messages.markRecalled(msgId);
    }
  }

  MH.Conversations = Conversations;
})(window.MH = window.MH || {});
