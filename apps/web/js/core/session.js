/* ============================================================
   MagicHub · js/core/session.js —— 登录会话
   负责读取/校验/保存 localStorage 中的 magichub_session
   ============================================================ */
(function (MH) {
  "use strict";

  const STORAGE_KEY = "magichub_session";

  class Session {
    constructor(data) {
      this.data = data;
    }

    get username() { return this.data.username; }
    get displayName() { return this.data.displayName || this.data.username; }
    get avatar() { return this.data.avatar; }
    get token() { return this.data.token; }

    /** 写回 localStorage */
    save() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); } catch (e) { /* 容量不足时忽略 */ }
    }

    /** 资料更新后同步内存与本地存储 */
    applyProfile(user) {
      this.data.displayName = user.displayName;
      this.data.avatar = user.avatar;
      this.save();
    }

    /** 清空会话 */
    static clear() {
      localStorage.removeItem(STORAGE_KEY);
    }

    /** 读取并校验会话；无效返回 null */
    static open() {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      let data;
      try { data = JSON.parse(raw); } catch (e) { data = null; }
      if (!data || !data.username) return null;
      return new Session(data);
    }
  }

  MH.Session = Session;
})(window.MH = window.MH || {});
