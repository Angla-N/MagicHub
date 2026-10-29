# MagicHub・TODO / 优化清单

> 以 "真实用户 + 工程师" 双视角对照源码（apps/server、apps/web、apps/desktop）逐项挑刺。
> 优先级：**P0 安全 / 数据可靠性 → P1 核心体验 → P2 功能增强 → P3 工程治理**。
> 每条都标注了问题位置与建议方案，可直接按条派活。
> 状态标记：`[x] 已完成` / `[ ] 待做`。已完成条目保留原始描述备查。

***

## P0・安全与数据可靠性

> **v0.2.0 已全部完成**（commit `31c141d`）。验收：`.tmp-pack/p0_test.py` 27/27 PASS。

### 1. [x] 登录 token 只存内存，重启即全员掉线
- 位置：`apps/server/server.js`（原 `sessions` Map）
- 问题：服务器重启后所有客户端 token 失效，必须重新登录；无法横向扩容。
- 方案：token 改为**签名 JWT**（HMAC-SHA256，密钥持久化 `data/jwt-secret`，重启不掉线；载荷含 tokenVersion，改密即全部失效）。

### 2. [x] 登录 / 注册接口无限流，可被暴力破解与滥注册
- 位置：`server.js` 登录 / 注册路由、`user-store.js`
- 问题：无失败次数锁定、无验证码、无 IP 维度限流；注册接口可被脚本刷号。
- 方案：按 IP + 用户名失败计数（5 次锁 15 分钟）；注册接口加算术验证码（`GET /api/register/captcha`，POST 必须带 captchaId/captchaAnswer）。

### 3. [x] 上传文件（/uploads/）静态服务无鉴权
- 位置：`server.js` 静态服务、`saveUploadFile`
- 问题：聊天文件 URL 泄露后任何人可下载。
- 方案：`/uploads/` 改为**签名 URL**（`GET /api/uploads/sign` 登录签发，5 分钟有效，HMAC 校验）。

### 4. [x] 上传文件无类型 / 内容校验 → 存储型 XSS 面
- 位置：`server.js` 上传链路
- 问题：可上传恶意 `.svg` / `.html` 经 `/uploads/` 分发执行。
- 方案：扩展名白名单 + **文件头魔数校验**；静态服务对 html/svg/js 一律 `Content-Disposition: attachment`。

### 5. [x] CORS 全开 `*`
- 位置：`server.js`
- 问题：任何站点可携带 Authorization 跨域调用。
- 方案：Origin 白名单（Electron file://、已知前端），其余拒绝。

### 6. [x] 客户端本地插件 entry 路径未校验 → 可读任意本地文件
- 位置：`apps/desktop/main.js`
- 问题：恶意插件 `entry: "../secret.txt"` 可直读任意文件。
- 方案：`safePluginEntry` 校验规范化后必须位于插件目录内；解压规模限制。

### 7. [x] 插件上传解压无 zip 炸弹防护
- 位置：`server.js` 插件上传、`desktop/main.js`
- 问题：压缩包可解压出超大 / 海量文件。
- 方案：**200 文件 / 50MB** 解压上限，超限清理拒绝。

### 8. [x] 演示账号硬编码进每个部署
- 位置：`user-store.js`
- 问题：每部署自带公开弱口令账号。
- 方案：仅开发模式预置 `demo/demo123`；打包模式（`MAGICHUB_PACKAGED=1`）不建。

### 9. [x] 改密码不吊销旧 token；token 无注销接口
- 位置：`user-store.js`、`server.js`
- 问题：改密后旧 token 仍有效。
- 方案：JWT 载荷含 tokenVersion，改密自增即全部失效。

### 10. [x] scryptSync 同步哈希阻塞事件循环
- 位置：`user-store.js`
- 问题：峰值登录卡住服务。
- 方案：改为异步 `scrypt`（Promise）。

### 11. [x] JSON 存储无原子写，损坏时静默重置可能覆盖丢数据
- 位置：`chat-store.js`、`user-store.js`
- 问题：崩溃产生半截 JSON 后再写即覆盖成空，历史数据永久丢失。
- 方案：`lib/json-file.js` 原子写（tmp+rename）+ 备份 + **损坏拒写**（loadJsonOrThrow）。

### 12. [x] 消息 500 条 / 会话静默截断
- 位置：`chat-store.js`
- 问题：旧消息被丢弃，聊天记录不可回溯。
- 方案：**分片存储** `data/chat/<convId>/msgs-NNNNN.json`（500/片）+ 旧 chat.json 迁移改名 `.migrated`。

***

## P1・核心体验

> **v0.3.0 已全部完成**（本轮）。验收：`.tmp-pack/p1_test.py` 31/31 PASS。

### 13. [x] 前端登录门禁不校验 token 是否过期
- 位置：`apps/web/index.html`
- 方案：进入主界面先 `GET /api/me` 校验；任一 API 401 统一清会话跳登录页。

### 14. [x] WS 无心跳，半开连接不清理
- 位置：`server.js` WebSocket 区
- 方案：服务端每 30s ping，60s 未 pong 清理 `wsClients` 并 terminate。

### 15. [x] 文件传输上限 8MB，无分片 / 断点
- 位置：`server.js`、`index.html`
- 方案：分片上传 `POST /api/upload/{init,chunk,complete}`（2MB/片，幂等重传，上限 500MB）；消息只存元数据引用。

### 16. [x] 消息搜索只有 "当前会话内本地过滤"
- 位置：`server.js`、`index.html`
- 方案：后端 `GET /api/search?q=` 跨全部会话检索；前端会话栏加全局搜索入口（按会话分组，点击跳转）。

### 17. [x] 未读没有系统级提醒（托盘角标 / 通知）
- 位置：`desktop/main.js`、`index.html`
- 方案：Electron `Notification` 系统通知（前台聚焦不打扰）；preload 暴露 `window.magicHub.notify`。

### 18. [x] 无消息撤回 / 删除、无已读回执
- 位置：`chat-store.js`、`server.js`、`index.html`
- 方案：消息加 `id`；`POST /api/messages/recall`（仅发送者，标记 deleted，WS 广播 `recall` 帧同步双方）；`meta.lastReadAt` 已读回执（消息区底部 "已读"）。

### 19. [x] 删除好友后无聊天记录管理界面
- 位置：`chat-store.js`、`server.js`、`index.html`
- 方案：删除好友两步确认（可选**同时清空双方服务器记录**）；设置页新增"服务器存储占用"（data/chat/uploads/avatars/plugins，`GET /api/server/stats`）。

### 20. [x] 服务器端口冲突与健康检查缺失
- 位置：`apps/server-app/main.js`
- 方案：`GET /api/health`（无需登录）；server-app 每 5s 探测，连续失败托盘提示 + 系统通知。

### 21. [x] 内置插件种子与 "用户删除" 冲突
- 位置：`apps/server-app/main.js`
- 方案：`.meta/<id>.json` 记录 `deleted: true`，种子跳过已删除项，不再自动种回。

***

## P2・功能增强（让软件更像 "产品"）

### 22. [ ] 资料设置不完整：无法改头像 / 昵称
- 位置：`user-store.js`（无更新接口）、`index.html` 设置页（只展示）
- 问题：注册时传错头像 / 名字后永远改不了，只能重新注册。
- 建议：`POST /api/account/profile`（displayName + avatar），设置页加编辑表单。

### 23. [ ] 插件市场无 "更新" 机制
- 位置：`index.html` 插件市场、`desktop/main.js`
- 问题：同名 id 重新上传后客户端无版本比较，重复下载覆盖安装，无升级提示。
- 建议：本地已装记录版本，市场项版本更高时卡片显示 "更新"；插件元数据加 `updatedAt`。

### 24. [ ] 插件只有 "卸载 = 删除目录"，无启用 / 禁用开关
- 位置：`desktop/main.js`
- 问题：用户想暂时关掉插件又不想删。
- 建议：本地插件加 `.disabled` 标记，设置页可启停；停用后侧栏入口消失。

### 25. [ ] 客户端设置文件在 C 盘 userData
- 位置：`desktop/main.js`（`app.getPath("userData")/settings.json`）
- 问题：与 "数据不占 C 盘" 目标不一致（插件数据在 exe 旁，设置却在 C 盘）。
- 建议：设置文件移到 exe 旁 `data/settings.json`（与插件同目录）。

### 26. [ ] 消息区无分组时间、无滚动加载
- 位置：`index.html`（每条消息都渲染时间）、`server.js`（全量返回）
- 问题：连续多条消息每条都显示时间，视觉噪点；历史消息一次全量拉取。
- 建议：同 5 分钟内消息只显示首条时间（会话顶部置顶日期）；`/api/messages?before=` 分页。

### 27. [ ] 无在线状态、无 "输入中" 提示
- 位置：`server.js` WS 只做推送，无状态广播
- 问题：不知道对方是否在线；看不到对方正在输入。
- 建议：WS 广播 `presence`（在线 / 离线）；输入框 `typing` 事件（节流 2s）。

### 28. [ ] 无通知声音 / 消息提示音
- 位置：`index.html`（无音频）
- 问题：收到消息完全静默（除 toast）。
- 建议：Web Audio 生成轻提示音（不依赖外部资源），设置页可开关。

### 29. [ ] 会话列表无置顶 / 分组
- 位置：`index.html` 会话列表
- 问题：只能按最后消息时间排序，无法置顶重要会话。
- 建议：会话加 `pinned` 标记，置顶优先排序；支持拖拽置顶。

### 30. [ ] Server 无日志轮转
- 位置：`server-app/main.js`（`server.log` 单文件）
- 问题：日志无限增长占满磁盘。
- 建议：按天 / 按 5MB 轮转，保留最近 7 份。

***

## P3・工程治理（长期健康）

### 31. [ ] 无任何自动化测试
- 问题：后端纯函数（user-store/chat-store/ 插件链路）可测但未测；前端无冒烟测试。
- 建议：node:test 给 store 层写单测（含数据损坏 / 并发场景）；前端保持截图冒烟。

### 32. [ ] index.html 已 1500+ 行，单文件难维护
- 问题：全部视图 / 逻辑堆在一个文件，后续加功能极易互相踩。
- 建议：按 "登录 / 会话栏 / 聊天区 / 通讯录 / 设置 / 插件市场" 拆模块（原生 ES modules 或轻量构建），沿用 `theme.css`/`chat.css` 的拆分思路。

### 33. [ ] 无配置化
- 位置：`server.js`（全部靠 env）
- 问题：端口 / 数据目录 / 7za 路径 / 文件上限都写死或只靠环境变量，部署不友好。
- 建议：`data/server.config.json`（端口、上传上限、CORS 白名单、插件限制），env 优先。

### 34. [ ] 打包产物约 180MB / 个
- 问题：electron 全量三平台二进制，体积大。
- 建议：`electron-builder` + asar（已用）+ 去掉调试符号；评估 NSIS 单文件安装包；后续可考虑 Tauri（README 已列为备选）。

### 35. [ ] 无 CI / 无自动打包
- 问题：每次手工 electron-packager。
- 建议：GitHub Actions 按 tag 自动打包双 exe 并上传 release。

### 36. [ ] 前端错误处理零散、多处静默 catch
- 位置：`index.html` 多处 `.catch(function () {})`
- 问题：后端未启动 / 接口失败时用户看到空白或 "无反应"，无法定位。
- 建议：统一 fetch 封装（错误 toast + 401 跳登录 + 重试）；页面级 "服务器离线" 横幅。

***

## 版本节奏

| 版本 | 状态 | 范围 |
| --- | --- | --- |
| v0.2.0 | ✅ 已发布（commit `31c141d`） | P0 全部（JWT、限流验证码、上传鉴权、炸弹防护、原子写、分片存储） |
| v0.3.0 | ✅ 已发布（本轮） | P1 全部（401 统一、WS 心跳、分片上传、全局搜索、系统通知、撤回 / 已读、删除清空 + 存储统计、健康检查、种子修复） |
| v0.4.0（规划） | ⏳ 待做 | P2 + P3（资料编辑、插件更新 / 启停、在线 / 输入中、测试、模块拆分、CI） |
