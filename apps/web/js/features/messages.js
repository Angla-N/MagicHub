/* ============================================================
   MagicHub · js/features/messages.js —— 消息气泡渲染
   分组时间 / 日期分隔 / 图片与文件 / 撤回 / 发送失败重试 / 文件下载
   ============================================================ */
(function (MH) {
  "use strict";

  class Messages {
    constructor(http) {
      this.http = http;
      this.area = MH.Utils.$("msgArea");
      this.emptyTip = MH.Utils.$("emptyTip");
      this.groupCtx = null; // { date: 当前渲染的日期串, ts: 上一条消息时间 }
    }

    init() {
      var self = this;
      // 文件消息下载：/uploads/ 需签名 URL，先取签名再触发下载
      this.area.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest(".file-dl") : null;
        if (!btn) return;
        var card = btn.closest(".file-card");
        if (!card) return;
        e.preventDefault();
        var path = card.getAttribute("data-url");
        var name = btn.getAttribute("data-dl") || "download";
        btn.disabled = true;
        self.http.signedUploadUrl(path).then(function (u) {
          btn.disabled = false;
          if (!u) { MH.toast("文件链接已过期，请刷新会话后重试"); return; }
          var a = document.createElement("a");
          a.href = u;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
        }).catch(function () { btn.disabled = false; });
      });
    }

    /** 清空历史消息气泡并重置分组状态（保留 emptyTip 占位节点） */
    reset() {
      this.area.querySelectorAll(".msg,.msg-date").forEach(function (el) { el.remove(); });
      this.groupCtx = null;
    }

    append(m, mine) {
      var area = this.area;
      this.emptyTip.style.display = "none";

      // 分组时间：同一天且距上一条 <= 5 分钟 → 时间隐藏；跨天插入日期分隔芯片
      var showTime = true;
      if (this.groupCtx) {
        var d = new Date(m.ts);
        var dayKey = d.toDateString();
        if (this.groupCtx.date !== dayKey) {
          if (this.groupCtx.date !== null) {
            var sep = document.createElement("div");
            sep.className = "msg-date";
            sep.textContent = MH.Utils.fmtDay(m.ts);
            area.appendChild(sep);
          }
          this.groupCtx.date = dayKey;
          this.groupCtx.ts = m.ts;
        } else if (m.ts - this.groupCtx.ts > 5 * 60 * 1000) {
          this.groupCtx.ts = m.ts;
        } else {
          showTime = false;
        }
      }

      var div = document.createElement("div");
      div.className = "msg " + (mine ? "out" : "in");
      if (m.id) div.setAttribute("data-msgid", String(m.id));
      var bubble = document.createElement("div");
      if (m.deleted) {
        // 已撤回占位（服务端保留记录，双方统一显示）
        bubble.className = "bubble recalled";
        bubble.textContent = mine ? "你撤回了一条消息" : "对方撤回了一条消息";
      } else if (m.file && /^image\//.test(m.file.type)) {
        bubble.className = "bubble has-img";
        var img = document.createElement("img");
        img.className = "msg-img";
        img.alt = m.file.name;
        img.loading = "lazy";
        // /uploads/ 需签名 URL（5 分钟有效）：先取签名再加载，失败显示占位
        this.http.signedUploadUrl(m.file.url).then(function (u) {
          if (!u) { img.classList.add("img-broken"); return; }
          img.src = u;
        });
        img.addEventListener("load", function () { area.scrollTop = area.scrollHeight; });
        img.addEventListener("click", function () { MH.app.lightbox.show(this.src); });
        bubble.appendChild(img);
      } else if (m.file) {
        bubble.className = "bubble";
        bubble.innerHTML = MH.Utils.fileCardHTML(m.file);
      } else {
        bubble.className = "bubble";
        bubble.textContent = m.text;
      }

      // 撤回按钮：仅自己发送且未撤回的消息显示（hover 可见，挂气泡右下角）
      if (mine && !m.deleted && m.id) {
        var rec = document.createElement("button");
        rec.type = "button";
        rec.className = "recall-btn";
        rec.textContent = "撤回";
        rec.title = "撤回这条消息";
        rec.addEventListener("click", function () { MH.app.convs.recall(m.id); });
        bubble.appendChild(rec);
      }

      div.appendChild(bubble);
      var time = document.createElement("div");
      time.className = "msg-time" + (showTime ? "" : " hide");
      time.textContent = showTime ? MH.Utils.fmtTime(m.ts) : "";
      div.appendChild(time);
      area.appendChild(div);
      area.scrollTop = area.scrollHeight;

      // 消息搜索激活时对新消息同步过滤
      if (MH.app.msgSearch && MH.app.msgSearch.isActive()) MH.app.msgSearch.apply();
    }

    /** 把指定消息气泡标记为"已撤回" */
    markRecalled(msgId) {
      Array.prototype.forEach.call(this.area.querySelectorAll('.msg[data-msgid="' + String(msgId) + '"]'), function (el) {
        var bubble = el.querySelector(".bubble");
        if (!bubble || bubble.classList.contains("recalled")) return;
        bubble.className = "bubble recalled";
        bubble.textContent = el.classList.contains("out") ? "你撤回了一条消息" : "对方撤回了一条消息";
        var rec = el.querySelector(".recall-btn");
        if (rec) rec.remove();
      });
    }

    /** 失败消息气泡：显示"发送失败，点击重试"，点击重新发送 */
    showFail(text, file) {
      var area = this.area;
      this.emptyTip.style.display = "none";
      var self = this;
      var div = document.createElement("div");
      div.className = "msg out fail";
      var bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = text || (file && file.name) || "消息发送失败";
      var tag = document.createElement("div");
      tag.className = "retry-tag";
      tag.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4"/></svg>发送失败，点击重试';
      div.appendChild(bubble);
      div.appendChild(tag);
      div.addEventListener("click", function () {
        div.style.opacity = ".5";
        MH.app.composer.post(
          { convId: MH.app.convs.activeConv, text: text || "", file: file ? { name: file.name, type: file.type, size: file.size, data: file.data } : undefined },
          function (d) {
            div.remove();
            self.append(d.msg, true);
            MH.app.convs.load();
          }
        ).then(function (ok) {
          if (!ok) div.style.opacity = "1";
        });
      });
      area.appendChild(div);
      area.scrollTop = area.scrollHeight;
    }
  }

  MH.Messages = Messages;
})(window.MH = window.MH || {});
