/* ============================================================
   MagicHub · js/features/composer.js —— 消息发送
   文本 / 图片压缩 / 小文件 base64 / 大文件分片上传 / 失败重试
   ============================================================ */
(function (MH) {
  "use strict";

  class Composer {
    constructor(http) {
      this.http = http;
      this.input = MH.Utils.$("input");
      this.sendBtn = MH.Utils.$("sendBtn");
      this.attachBtn = MH.Utils.$("attachBtn");
      this.attachPop = MH.Utils.$("attachPop");
    }

    init() {
      var self = this;
      MH.Utils.$("sendBtn").addEventListener("click", function () { self.send(); });
      this.input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); self.send(); }
      });

      /* 附件按钮 + 图片/文件选择 */
      this.attachBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        self.attachPop.classList.toggle("show");
      });
      document.addEventListener("click", function () { self.attachPop.classList.remove("show"); });
      MH.Utils.$("pickImage").addEventListener("click", function () {
        self.attachPop.classList.remove("show");
        MH.Utils.$("imageInput").click();
      });
      MH.Utils.$("pickFile").addEventListener("click", function () {
        self.attachPop.classList.remove("show");
        MH.Utils.$("fileInput").click();
      });
      MH.Utils.$("imageInput").addEventListener("change", function () {
        if (this.files && this.files[0]) self.sendImageMsg(this.files[0]);
        this.value = "";
      });
      MH.Utils.$("fileInput").addEventListener("change", function () {
        if (this.files && this.files[0]) self.sendFileMsg(this.files[0]);
        this.value = "";
      });
    }

    send() {
      this.sendText(this.input.value.trim());
    }

    /** 发送消息（含失败重试） */
    post(body, onOk) {
      return this.http.api(MH.Config.BASE + "/api/messages", {
        method: "POST",
        headers: this.http.authHeaders(true),
        body: JSON.stringify(body),
      })
        .then(function (data) {
          if (data.ok) { onOk(data.data); return true; }
          MH.toast((data.error && data.error.message) || "发送失败");
          return false;
        })
        .catch(function () { MH.toast("发送失败，请检查后端服务"); return false; });
    }

    sendText(text) {
      var input = this.input;
      if (!text || !MH.app.convs.activeConv || !MH.app.realtime.isOpen()) return;
      input.value = "";
      this.post({ convId: MH.app.convs.activeConv, text: text }, function (d) {
        MH.app.messages.append(d.msg, true);
        MH.app.convs.load();
      }).then(function (ok) {
        if (!ok) MH.app.messages.showFail(text, null);
      });
    }

    /** 图片：canvas 压缩到最长边 1280 / JPEG 0.82 */
    compressImage(file, cb) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var MAX = 1280;
        var scale = Math.min(1, MAX / Math.max(img.width, img.height));
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        cb(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
      img.src = url;
    }

    canSendFile() {
      if (!MH.app.convs.activeConv) { MH.toast("请先选择一个会话"); return false; }
      if (!MH.app.realtime.isOpen()) { MH.toast("未连接到服务器"); return false; }
      return true;
    }

    sendImageMsg(file) {
      var self = this;
      if (!this.canSendFile()) return;
      this.compressImage(file, function (dataUrl) {
        if (!dataUrl) { MH.toast("图片读取失败"); return; }
        var size = Math.round(dataUrl.length * 0.75);
        self.post({
          convId: MH.app.convs.activeConv,
          text: "",
          file: { name: file.name.replace(/\.[^.]+$/, ".jpg") || "image.jpg", type: "image/jpeg", size: size, data: dataUrl },
        }, function (d) {
          MH.app.messages.append(d.msg, true);
          MH.app.convs.load();
        }).then(function (ok) {
          if (!ok) MH.app.messages.showFail(null, { name: file.name, type: "image/jpeg", size: size, data: dataUrl });
        });
      });
    }

    /** 文件分片上传（>2MB 走 init→chunk×N→complete；小文件沿用原 base64 路径兼容） */
    sendFileMsg(file) {
      var self = this;
      if (!this.canSendFile()) return;
      if (file.size > 500 * 1024 * 1024) { MH.toast("文件不能超过 500MB"); return; }
      if (file.size <= 2 * 1024 * 1024) return this.sendSmallFile(file);
      MH.toast("正在上传…（分片）");
      this.http.api(MH.Config.BASE + "/api/upload/init", {
        method: "POST",
        headers: this.http.authHeaders(true),
        body: JSON.stringify({ name: file.name, size: file.size, type: file.type || "application/octet-stream" }),
      }).then(function (d) {
        if (!d.ok) { MH.toast((d.error && d.error.message) || "上传初始化失败"); return; }
        var uploadId = d.data.uploadId, chunkSize = d.data.chunkSize, chunks = d.data.chunks;
        var offset = 0, idx = 0;
        var done = 0;
        function next() {
          if (idx >= chunks) return complete();
          var blob = file.slice(offset, offset + chunkSize);
          offset += chunkSize;
          var reader = new FileReader();
          reader.onload = function () {
            var b64 = reader.result.split(",")[1];
            self.http.api(MH.Config.BASE + "/api/upload/chunk", {
              method: "POST",
              headers: self.http.authHeaders(true),
              body: JSON.stringify({ uploadId: uploadId, index: idx, data: b64 }),
            }).then(function (r) {
              idx++;
              if (r.ok) {
                done++;
                if (done % 5 === 0) MH.toast("上传中… " + Math.round(done * 100 / chunks) + "%");
                next();
              } else {
                MH.toast((r.error && r.error.message) || "分片上传失败");
              }
            }).catch(function () { MH.toast("分片上传失败，请检查网络"); });
          };
          reader.readAsDataURL(blob);
        }
        function complete() {
          self.http.api(MH.Config.BASE + "/api/upload/complete", {
            method: "POST",
            headers: self.http.authHeaders(true),
            body: JSON.stringify({ uploadId: uploadId }),
          }).then(function (r) {
            if (!r.ok) { MH.toast((r.error && r.error.message) || "上传失败"); return; }
            var meta = r.data;
            self.post({
              convId: MH.app.convs.activeConv,
              text: "",
              file: { url: meta.url, name: meta.name, type: meta.type, size: meta.size },
            }, function (m) {
              MH.app.messages.append(m, true);
              MH.app.convs.load();
            }).then(function (ok) {
              if (!ok) MH.app.messages.showFail(null, { name: file.name, type: file.type, size: file.size, data: "" });
            });
          }).catch(function () { MH.toast("上传失败，请检查后端服务"); });
        }
        next();
      }).catch(function () { MH.toast("上传初始化失败，请检查后端服务"); });
    }

    sendSmallFile(file) {
      var self = this;
      var reader = new FileReader();
      reader.onload = function () {
        var b64 = reader.result.split(",")[1];
        self.post({
          convId: MH.app.convs.activeConv,
          text: "",
          file: { name: file.name, type: file.type || "application/octet-stream", size: file.size, data: b64 },
        }, function (d) {
          MH.app.messages.append(d.msg, true);
          MH.app.convs.load();
        }).then(function (ok) {
          if (!ok) MH.app.messages.showFail(null, { name: file.name, type: file.type, size: file.size, data: b64 });
        });
      };
      reader.onerror = function () { MH.toast("文件读取失败"); };
      reader.readAsDataURL(file);
    }
  }

  MH.Composer = Composer;
})(window.MH = window.MH || {});
