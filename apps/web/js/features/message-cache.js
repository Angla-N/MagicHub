/* ============================================================
   MagicHub · js/features/message-cache.js —— 消息本地缓存
   打开会话先显示缓存，再向后端刷新（弱网/离线也能立即看到）
   ============================================================ */
(function (MH) {
  "use strict";

  class MessageCache {
    static key(convId) { return "mh_msg_cache_" + convId; }

    static read(convId) {
      try { return JSON.parse(localStorage.getItem(MessageCache.key(convId))) || []; }
      catch (e) { return []; }
    }

    static write(convId, msgs) {
      try { localStorage.setItem(MessageCache.key(convId), JSON.stringify(msgs.slice(-60))); }
      catch (e) { /* 容量不足时忽略 */ }
    }
  }

  MH.MessageCache = MessageCache;
})(window.MH = window.MH || {});
