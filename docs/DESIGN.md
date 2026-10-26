# MagicHub 工程与插件系统设计

> 设计基线：2026-10-26・V0.1
> 产品方向：轻量聊天（消息 + 文件传输）→ 组件化 → VS Code 式插件系统
> UI 基调：深黑主题（色深参考 VS Code），蓝色点睛，无彩色背景



***

## 1. 产品与技术栈

### 1.1 产品演进



| 阶段 | 能力        | 说明                              |
| -- | --------- | ------------------------------- |
| 一期 | 聊天 + 文件传输 | 实时消息、会话、联系人、拖拽传文件               |
| 二期 | 组件化       | UI 组件库独立成包，业务按模块组织              |
| 三期 | 插件系统      | VS Code 式扩展：插件贡献内容，装了才可见（如新闻推送） |
| 四期 | 发布        | 现成打包框架打包分发                      |

### 1.2 技术栈决策



| 层    | 选型                                | 理由                                                     |
| ---- | --------------------------------- | ------------------------------------------------------ |
| 前端   | TypeScript + React 18 + Vite      | TS 保证组件契约可静态检查；React 生态成熟，适合聊天类交互密集 UI；Vite 构建快        |
| 后端   | Node.js 20+ + Fastify + Socket.IO | 轻量、性能好；Socket.IO 实时双向通道成熟，聊天下行 / 上行都顺                  |
| 存储   | SQLite（better-sqlite3，本地优先）       | 聊天记录本地优先、隐私友好；后期可平滑换 Postgres                          |
| 原生扩展 | Rust via N-API（NAPI-RS）           | 性能敏感链路交给 Rust：加解密、大文件哈希校验、图片压缩、消息队列                    |
| 桌面壳  | Electron 起步                       | 与 VS Code 同为 Electron，插件宿主模型最成熟、参考价值最高；Tauri 作为后续轻量化备选 |
| 共享层  | 单仓（Monorepo）多包                    | 组件库 / 插件宿主 / 协议类型一处维护，跨包复用                             |



***

## 2. 工程结构（Monorepo）



```
magichub/
├── apps/
│   ├── desktop/          # Electron + React 桌面壳（主进程 + 渲染进程，待建）
│   ├── server/           # Node 后端（V0.1: WebSocket 连通骨架；目标 Fastify + Socket.IO + SQLite）
│   └── web/              # H5 演示前端（单页，WebSocket 连通验证）
├── core/
│   ├── ui/               # 组件库（Base / Composite 两层）
│   ├── plugin-host/      # 插件宿主（进程管理、API 面、贡献点注册）
│   └── protocol/         # 共享类型 / 消息协议 / 插件契约类型
├── native/
│   └── rust-core/        # Rust N-API 扩展（crypto / hash / image / queue）
├── plugins/
│   └── news-feed/        # 新闻推送插件（示例：装才可见）
├── docs/                 # 设计文档
└── package.json          # workspace 根
```



***

## 3. 组件化设计原则

### 3.1 三层组件体系



| 层              | 定义             | 示例                                                |
| -------------- | -------------- | ------------------------------------------------- |
| Base 基础组件      | 无业务语义，纯样式 + 交互 | Avatar、Bubble、InputBar、Badge、Toast、Switch、Tooltip |
| Composite 组合组件 | 组合基础组件，承载局部交互  | ConversationItem、MessageList、Composer、ChatHeader  |
| Feature 业务模块   | 组合 + 状态 + 服务调用 | Chat、Contacts、FileTransfer、Settings               |

### 3.2 组件契约



* 每个组件定义稳定 props /events 类型（TS interface），**不直接依赖服务实现**，服务经注入传入。

* 样式全部走 CSS Variables（Token），不写死色值 —— 这是后续插件主题系统的基础。

* 主题 Token（深黑默认）：



```
--bg:#1E1E1E; --surface:#252526; --surface-2:#2A2D2E; --border:#3C3C3C;
--primary:#007ACC; --primary-strong:#1C97EA; --accent:#0A84FF; --accent-soft:#7DC8F7;
--text:#E8E8E8; --text-2:#9D9D9D; --text-3:#6E6E6E;
```



* 插件只能经「贡献点」接入宿主 UI（见 4.3），**禁止**直接修改宿主组件源码。



***

## 4. 插件系统设计（对标 VS Code）

### 4.1 总体架构



```
┌─────────────────────────── 宿主（Electron 渲染/主进程）──────────────────────────┐
│  UI 组件库 ← 贡献点渲染（视图容器 / 视图 / 命令 / 菜单 / 主题）                    │
│  PluginHost（宿主侧：加载 manifest、分发事件、注入 API、管理生命周期）             │
└───────────────┬───────────────────────────────────────────────┬─────────────────┘
                │ spawn 独立进程（受限环境）                       │ 仅宿主可调用
        ┌───────▼────────┐                              ┌─────────▼─────────┐
        │  插件进程        │                              │  Rust N-API       │
        │  sandbox 运行    │                              │  crypto/hash/...  │
        │  只能访问注入的   │                              │  不暴露给插件       │
        │  magicHub.* API  │                              └───────────────────┘
        └─────────────────┘
```



* **宿主与插件分离**：插件跑在独立子进程，崩溃不影响宿主；API 面由宿主显式注入，插件拿不到 Node/Electron 全局能力。

* **Rust 模块是宿主私产**：性能敏感链路（加解密、blake3 校验、图片压缩）只由宿主调用，插件只能通过宿主 API 间接使用。

### 4.2 插件清单（manifest.json）



```
{
  "name": "magichub.news-feed",
  "displayName": "新闻推送",
  "version": "0.1.0",
  "publisher": "MagicHub",
  "main": "dist/index.js",
  "permissions": ["network"],
  "activationEvents": ["onStartup", "onView:magichub.newsFeed"],
  "contributes": {
    "viewsContainers": [{ "id": "activitybar", "title": "新闻" }],
    "views": [{ "id": "newsFeedView", "title": "新闻订阅", "container": "activitybar" }],
    "commands": [{ "command": "newsFeed.refresh", "title": "刷新新闻" }],
    "configuration": [{ "key": "newsFeed.updateInterval", "default": 60 }]
  }
}
```

### 4.3 贡献点（Contributions）



| 贡献点                         | 作用                       | 新闻插件示例                |
| --------------------------- | ------------------------ | --------------------- |
| `viewsContainers` / `views` | 注册侧边栏视图，未安装插件的用户完全看不到该入口 | 「新闻」视图容器 + 新闻列表视图     |
| `commands`                  | 注册命令，可绑定菜单 / 快捷键         | `newsFeed.refresh` 刷新 |
| `menus`                     | 在指定菜单插入项                 | 会话列表右键「查看相关新闻」        |
| `configuration`             | 声明设置项                    | 自动刷新间隔                |
| `themes`                    | 插件可附带主题（后期）              | 新闻高亮主题                |

> 关键产品规则：
>
> **视图容器与视图均来自插件贡献，宿主不内置任何第三方入口**
>
> —— 用户不装插件，界面中该内容完全不存在。

### 4.4 插件 API（宿主注入的 `magichub.*` 命名空间）



```
declare namespace magicHub {
  export const views: {
    registerView(viewId: string, render: (ctx: ViewContext) => void): void;
  };
  export const commands: {
    registerCommand(id: string, handler: (args?: unknown) => void): void;
  };
  export const window: {
    showToast(msg: string): void;
    showMessage(level: "info" | "warn" | "error", msg: string): void;
  };
  export const storage: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };
  export const net: {
    fetch(url: string, opts?: RequestInit): Promise<Response>; // 需 manifest 声明 network 权限
  };
}
```

### 4.5 生命周期



```
安装 → 解析 manifest → 校验权限 → 拉起插件进程 → 注入 API →
按 activationEvents 激活（startup / 视图打开 / 命令调用）→
卸载：停止进程、注销全部贡献点、移除界面入口（视图消失）
```

### 4.6 新闻推送插件（首个示例插件）



* 数据源：插件通过 `magicHub.net.fetch` 拉取远端 RSS / API（权限 `network`）。

* 渲染：`magicHub.views.registerView("newsFeedView", ...)` 渲染新闻列表（标题、摘要、链接、时间）。

* 触发：`onStartup` 激活 + `configuration.updateInterval` 控制轮询。

* 卸载即消失：注销视图后，侧边栏「新闻」入口随之移除，用户界面回到未安装状态。



***

## 5. 数据与协议（一期聊天）

### 5.1 实时消息



* 通道：Socket.IO（WebSocket 传输），JSON 信封、版本化字段（`v: 1`）。

* 消息类型：`text | image | file | system`，携带 `seq`（顺序号）、`msgId`、`from`、`convId`、`ts`。

* 送达语义：ACK + 回执（已读 / 已送达），本地缓存 + 增量同步。

### 5.2 文件传输（Rust 加速）



* 上传前由 Rust `blake3` 分块哈希，传输过程分块 + 断点续传，接收端 Rust 校验，块不匹配自动重传。

* 大文件走独立传输通道（HTTP 分块），不占实时消息通道。

### 5.3 安全



* 端到端加密（E2EE）：密钥本地生成、本地存储（OS keychain），服务端不存明文。

* 加解密、签名等由 `native/rust-core` 承担（内存安全 + 吞吐）。



***

## 6. 开发路线



| 阶段     | 里程碑                             | 验收标准                     |
| ------ | ------------------------------- | ------------------------ |
| 一：基础框架 | workspace 脚手架、UI 组件库（深黑主题）、三栏布局 | 组件库可独立预览，聊天窗口静态可用        |
| 二：核心聊天 | 实时消息、会话管理、联系人、文件传输              | 双端可收发消息与文件，断点续传可用        |
| 三：插件系统 | PluginHost、贡献点、API 注入、新闻推送示例    | 安装插件→新闻入口出现；卸载→入口消失      |
| 四：发布优化 | Electron 打包、性能压测、安全审计           | 达成交付指标（<1s 送达、99.9% 可用性） |



***

## 7. Git 工作流与规范



* 主干 `main` 保持可运行；功能在分支开发，合并回 main。

* 提交信息格式：`type(scope): description`，如 `feat(core/ui): 新增 Bubble 组件`、`style(ui-demo): 切换深黑主题`。

* 每个可交付增量完成后即提交（本仓库首个提交为 `chore: 初始化仓库…`，后续按此粒度推进）。

* 里程碑打 tag：`v0.1.0` 起。