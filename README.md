# MagicHub

轻量级桌面聊天应用：**Electron 壳 + 原生 HTML/CSS/JS 前端 + Node.js 后端**，数据用 JSON 文件存储（无需数据库）。深黑背景 + 深紫点睛的 VS Code 风格 UI，内置插件系统（VS Code 式扩展思路）与插件市场。

## 功能特性

- **账号系统**：注册（昵称/账号/密码/头像上传）、登录、修改密码；密码使用 `scrypt` 加盐哈希存储；头像为方形圆角并保存于服务器
- **聊天**：好友间消息收发（WebSocket 实时推送，多窗口/多机器同步）、图片消息、文件消息、消息搜索、未读红点、发送失败重试、消息本地缓存（打开会话先显示缓存再向服务器刷新）
- **通讯录**：浏览全部用户、添加/删除好友（双向解除）；未加好友只能查看，不能发消息
- **插件系统**：VS Code 式思路——插件贡献内容，装了才可见
  - **插件市场**：`.7z` 包上传 / 下载 / 公开 / 删除；插件只存压缩包（`<id>.7z` + `.meta/<id>.json` 元数据），上传时自动把包内图标提取到 `.icons/` 供市场直接展示；私有插件仅作者可见可下载
  - **客户端**：市场下载 `.7z` → 本地解压 → 自动加载（侧栏插件区、设置「已启用插件」即时更新），可卸载
  - 打包工具 `tools/plugin-pack.py`：校验格式 → 打 `.7z` → 生成 manifest 模板
- **前后端分离 + 实时更新**：服务器**不再打包 exe**，以脚本方式运行（`start-server.bat` 一键启动，数据在仓库内 `apps/server/data/`，不占 C 盘）；客户端仍是 exe，但只含 Electron 运行引擎与内置引导页，**前端脚本不打包**——首次启动从服务器拉取并缓存到 exe 旁 `data/web/`，此后直接加载本地；服务器发布新版前端（`node tools/pack.mjs server`）后，客户端启动时自动增量拉新并切换，无需用户手动更新
- **后台驻留**：客户端默认开启，关闭窗口最小化到托盘，可快速再启（设置界面可关）
- **UI**：深黑背景（`#1E1E1E`，VS Code 深度）+ 深紫点睛（`#7C3AED → #A855F7`）；QQ 风格三栏主界面；登录页为程序默认页

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Electron（自绘无边框标题栏 + preload contextBridge） |
| 前端 | 原生 HTML / CSS / JS（无框架，模块化拆分 `theme.css` 全局 / `chat.css` 聊天组件） |
| 后端 | Node.js `node:http` + `ws`（WebSocket） |
| 存储 | JSON 文件（`users.json` / `chat.json`），`data/` 目录便携存放，不占 C 盘 |
| 插件打包 | 7-Zip（`7za.exe`），上传/下载均 `.7z` |
| 密码安全 | `scrypt` 盐哈希 |

## 架构

```
┌───────────────────────┐        HTTP / WebSocket        ┌──────────────────────┐
│  MagicHub-Client      │ ─────────────────────────────▶ │  MagicHub-Server      │
│  (Electron 轻壳 exe)  │                                │  (node 脚本运行)      │
│  resources/boot.html  │  引导/同步/错误配置             │                      │
│  data/web/ 前端缓存    │  登录 / 好友 / 聊天 / 插件 API  │  apps/server          │
│   (首次从服务器拉取,    │ ◀───────────────────────────── │  server.js            │
│    后续加载本地,       │   /api/web/manifest + file     │   ├─ user-store.js    │
│    有新版自动增量更新)  │   （前端实时更新分发）          │   └─ chat-store.js    │
│  data/plugins/        │  插件下载(.7z) → 本地解压加载     │  data/               │
│  （本地已装插件）        │                                │   ├─ users.json      │
└───────────────────────┘                                │   ├─ chat.json       │
                                                          │   ├─ avatars/        │
                                                          │   ├─ uploads/        │
                                                          │   └─ plugins/        │
                                                          │       *.7z + .meta/  │
                                                          │       + .icons/      │
                                                          │  release/web/        │
                                                          │   （前端发布包 +      │
                                                          │    web-manifest.json）│
                                                          └──────────────────────┘
```

## 目录结构

```
MagicHub/
├── apps/
│   ├── server/            # 后端源码（node:http + ws）
│   │   ├── server.js      # HTTP API + WebSocket + 插件市场
│   │   └── lib/           # user-store.js（scrypt）/ chat-store.js
│   ├── server-app/        # 旧 Server 打包工程（已停用，不再打包 exe）
│   ├── desktop/           # MagicHub-Client 打包工程（轻壳：引擎 + 引导页，前端运行时拉取）
│   └── web/               # 前端（index.html / login.html / css / scripts/serve.mjs）
├── plugins/               # 内置插件源码（开发仓库）/ 开发模式插件市场
├── tools/                 # 7za.exe、plugin-pack.py
├── brand/                 # 程序图标
├── docs/DESIGN.md         # 工程与插件系统设计
├── dist/                  # 打包产物（客户端 exe；前端发布包在 release/web）
├── release/               # 前端发布包（pack.mjs server 生成，服务器分发）
└── ui-demo/               # UI 组件演示
```

## 快速开始

### 开发模式

需要 Node.js ≥ 18。后端默认 `3000` 端口，前端开发服务器 `5173`。

```bash
# 1. 启动后端（需先指定 7za 用于插件上传）
$env:MAGICHUB_7Z = "D:\C++Project\MagicHub\tools\7za.exe"   # Windows PowerShell
node apps/server/server.js

# 2. 启动前端开发服务器（另开终端）
node apps/web/scripts/serve.mjs

# 3. 浏览器打开 http://localhost:5173
```

测试账号：`alice2 / pass123`、`bob2 / pass123`（或直接注册新账号）。

### 打包 / 发布

在仓库根目录执行 `node tools/pack.mjs`：

```bash
node tools/pack.mjs            # 客户端打包 + 服务端发布
node tools/pack.mjs client     # 只打包客户端（轻壳 exe，不含前端脚本）
node tools/pack.mjs server     # 只发布前端脚本包（版本自动递增 → release/web/）
```

- **客户端 exe**：只含 Electron 引擎 + 主进程 + 内置引导页（`resources/boot.html`），体积大幅减小；自动带入 `7za.exe`、`brand` 图标
- **服务端发布**：把 `apps/web` 复制到 `release/web/`，版本号自动 +1，生成 `web-manifest.json`（逐文件 sha256 清单）；服务器通过 `/api/web/manifest`、`/api/web/file/*` 把前端分发给客户端
- 临时目录固定在仓库内（避免 C 盘 → 产物盘 rename 报 EPERM）

产物：`dist\MagicHub-Client-win32-x64\MagicHub-Client.exe`（前端发布包在 `release\web\`）。

### 运行

1. **启动服务器**（脚本方式，无需打包）：双击 `start-server.bat`，或直接 `node apps/server/server.js`（端口默认 3000，`PORT` 可覆盖；数据在仓库内 `apps/server/data/`）
2. **启动客户端**：运行 `MagicHub-Client.exe`。首次启动从服务器拉取前端脚本并缓存到 exe 旁 `data/web/`（不占 C 盘），之后直接加载本地；服务器发布新版前端后，客户端启动时自动增量拉新并切换，无需手动更新。服务器不可达但已有缓存时可离线启动；首次使用且服务器不在线时，内置引导页可配置服务器地址后重试

## 插件系统

- **市场存储模型**：一个插件 = `plugins/<id>.7z`（唯一包形态）+ `.meta/<id>.json`（作者/公开/上传时间/manifest 快照）+ `.icons/<id>.svg`（上传时从包内提取的图标）；不保留源码目录
- **权限**：私有插件仅作者可见、仅作者可下载；`system` 内置插件不可删除
- **客户端加载**：市场下载 `.7z` → 7za 解压到本地 `data/plugins/<id>/` → 校验 manifest 且 id 一致 → 自动加载；卸载即删除本地目录
- **打包工具**：

```bash
python tools/plugin-pack.py <插件目录> [-o 输出.7z] [--init] [--list]
# --init 生成 manifest 模板；--list 只校验不打包
```

## 数据存储

服务器数据默认在仓库内 `apps/server/data/`（便携，不占 C 盘；`MAGICHUB_DATA_DIR` 可覆盖）；客户端缓存与插件在 exe 旁 `data/`：

```
data/
├── users.json          # 账号（scrypt 盐哈希密码）
│   （客户端侧另有 data/web/ 前端缓存 + data/plugins/ 本地插件）
├── chat.json           # 好友关系 / 会话 / 消息
├── avatars/            # 用户头像
├── uploads/            # 聊天图片 / 文件
└── plugins/            # 插件市场（*.7z + .meta/ + .icons/）
```

## Git 工作流

- 主干 `main` 保持可运行，功能开发后再合回
- 提交信息格式：`type(scope): description`（如 `feat(plugin-market): ...`、`fix(chat): ...`）
- 每个可交付增量完成后即提交，方便回退追溯
- 里程碑打 tag（`v0.1.0` 起）

## 已知限制

- 当前未实现：消息撤回、语音/视频通话、端到端加密（插件 API 为后期预留）
- 文件传输通过 HTTP 上传/下载，单文件大小受后端限制（上传 10MB，插件 10MB）
