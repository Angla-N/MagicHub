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
- **前后端分离**：`MagicHub-Server.exe`（无窗口托盘常驻，业务/记录/文件/插件/WebSocket）+ `MagicHub-Client.exe`（纯前端壳，登录页填服务器地址即可连接远程服务器）
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
┌───────────────────┐        HTTP / WebSocket        ┌──────────────────────┐
│  MagicHub-Client  │ ─────────────────────────────▶ │  MagicHub-Server     │
│  (Electron 壳)    │                                │  (无窗口托盘常驻)      │
│                    │                                │                      │
│  apps/web          │  登录 / 好友 / 聊天 / 插件 API  │  apps/server         │
│  index.html        │ ◀───────────────────────────── │  server.js           │
│  login.html        │                                │   ├─ user-store.js   │
│  css/ theme.css    │                                │   └─ chat-store.js   │
│       chat.css     │                                │                      │
│  data/plugins/     │  插件下载(.7z) → 本地解压加载     │  data/               │
│  （本地已装插件）     │                                │   ├─ users.json      │
└───────────────────┘                                │   ├─ chat.json       │
                                                      │   ├─ avatars/        │
                                                      │   ├─ uploads/        │
                                                      │   └─ plugins/        │
                                                      │       *.7z + .meta/  │
                                                      │       + .icons/      │
                                                      └──────────────────────┘
```

## 目录结构

```
MagicHub/
├── apps/
│   ├── server/            # 后端源码（node:http + ws）
│   │   ├── server.js      # HTTP API + WebSocket + 插件市场
│   │   └── lib/           # user-store.js（scrypt）/ chat-store.js
│   ├── server-app/        # MagicHub-Server 打包工程（托盘常驻 + 便携 data + 插件种子）
│   ├── desktop/           # MagicHub-Client 打包工程（纯前端壳）
│   └── web/               # 前端（index.html / login.html / css / scripts/serve.mjs）
├── plugins/               # 内置插件源码（开发仓库）/ 开发模式插件市场
├── tools/                 # 7za.exe、plugin-pack.py
├── brand/                 # 程序图标
├── docs/DESIGN.md         # 工程与插件系统设计
├── dist/                  # 打包产物（两个 exe）
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

### 打包为 exe

在各打包工程目录下执行：

```bash
# 客户端（apps/desktop）
npm run pack

# 服务器（apps/server-app）
npm run pack
```

两者都调用 `tools/pack.mjs`：自动带入 `7za.exe`（插件市场解压/打包依赖）、`brand` 图标和运行资源，并把临时目录放在仓库内（避免 C 盘 → 产物盘 rename 报 EPERM），不会再漏资源。

也可以一次打包两端（在仓库根目录）：

```bash
node tools/pack.mjs            # 客户端 + 服务端
node tools/pack.mjs client     # 只打包客户端
node tools/pack.mjs server     # 只打包服务端
```

产物：`dist\MagicHub-Server-win32-x64\MagicHub-Server.exe`、`dist\MagicHub-Client-win32-x64\MagicHub-Client.exe`。

### 运行

1. 先启动 `MagicHub-Server.exe`（托盘常驻，首次启动自动生成 `data/` 数据目录 + 内置插件种子）
2. 再启动 `MagicHub-Client.exe`，在登录页填入服务器地址（默认 `localhost:3000`，可填服务器 IP），点「验证」确认连通后登录

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

服务器所有数据都在 `Server.exe` 同目录 `data/`（便携，不占 C 盘）：

```
data/
├── users.json          # 账号（scrypt 盐哈希密码）
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
