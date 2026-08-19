# dsh-session-toolkit

DeepSeek Harness 工作台插件整合包。由以下 6 个本地插件整合为一：

| 原插件 | 功能 | 模块 |
|---|---|---|
| dsh-session-identity | 会话身份（每会话人设注入 + 浮层编辑 + 双入口按钮 + 自动上线开关行） | lib/identity.js |
| dsh-global-prompt | 全局提示词（设置页 + 系统提示词段，含 `/\{+/g` sanitize 修复与新文案） | lib/global-prompt.js |
| dsh-auto-resume | 会话自动上线（开关开启的会话重启后自动 resume；过滤链/并发控制/立即生效） | lib/auto-resume.js |
| dsh-web-restart | 设置页重启服务（`/api/restart` 双路由 + 零 UAC spawn + 覆盖层进度条） | lib/web-restart.js |
| dsh-session-log-reposition | Session log 按钮平移（遮蔽官方 utilities 按钮 + actions 槽复刻，复用官方 controller） | lib/log-reposition.js |
| peer-message | 会话间对等消息工具（send_to_session / list_sessions）+ 复制会话 ID 按钮（双入口） | lib/peer-message.js |

## 架构

- **host 半**：`lib/index.js` 组装入口，按功能拆分 6 个子模块；统一 inject 依赖（settings / systemPrompt / webServer / agents / tools / sessionPersistence / sessionTitle / workspaceRegistry / commands）。
- **client 半**：`client/client.js` 单文件内联（`__ModuleLoader__` 只解析平台模块，不解析本地子模块），注册：
  - `settings.section`：全局提示词（id `global-prompt`）
  - `settings.general.item`：重启服务（id `web-restart`）
  - `conversation.session.header.actions`：复制 ID（30）/ 身份（40）/ Session log（41）
  - `conversation.input.left`：身份（40）/ 复制 ID（30）
  - `conversation.session.header.utilities`：遮蔽官方下载按钮（id `session-log-download`，priority -1）

## Settings 命名空间（与整合前完全兼容，settings.yaml 已落盘数据保留）

- `session-identity`：`{ default: {enabled, text}, sessions: Record<sessionId, {enabled, text}> }`
- `session-auto-resume`：`{ sessions: Record<sessionId, boolean> }`
- `global-prompt`：`{ enabled, content }`（由本包注册；官方 dsh-global-prompt 经 bundle.patch 自注册，已在 profile patch 中 `disabled: true` 抑制）

## 关键机制与红线

- **身份注入**：`systemPrompt.section` 独立段名 `session-identity`、order 55（全局提示词 50 之后、工具引导 100 之前），text 按 `AssembleContext.agent` 实时求值；subagent（origin/delegationDepth）不注入；`/\{+/g` 连续花括号空格化转义。
- **自动上线**：启动时 `sessionPersistence.list()` → 过滤（开关开启 + 顶层 + 非空白 seedLength）→ `agents.resume()`（inFlight 防竞态、CONCURRENCY=3、失败隔离）；settings watch 对 false→true 立即生效。**红线：绝不调用 `dispose()`**（会从存储删除会话）；关闭开关≠下线，仅影响下次重启。
- **重启服务**：`webServer.register` 双路由（GET 健康探测 / POST 触发），202 → 500ms 缓冲 → detached spawn `dsh-web-restart.cmd`（继承服务器进程权限，无 UAC）；防重入 409；覆盖层进度条探测驱动 + 成功补满动画 + 90s 超时兜底。
- **按钮平移**：utilities 槽同 id `session-log-download` + priority -1 遮蔽官方按钮（cell shadowing），actions 槽复刻按钮复用官方 `sessionLogDownload` controller；官方包零改动。

## 部署

- 源码唯一目录：`D:\dsh-session-toolkit`
- `C:\Users\Francis Han\.dsh\profiles\web\node_modules\dsh-session-toolkit` 为 junction → `D:\dsh-session-toolkit`
- `D:\dsh-session-toolkit\node_modules` junction → `C:\Users\Francis Han\.dsh\profiles\node_modules`（供 `@deepseek-ai/*` 依赖解析）
- `cordis.patch.yml`：`- id: session-toolkit / name: 'dsh-session-toolkit'`；原 6 插件条目不再注册（dsh-global-prompt 经 bundle.patch 自注册，以 `disabled: true` 抑制）

## 恢复方法

移除 `cordis.patch.yml` 中 `session-toolkit` insert 条目（并恢复原插件的注册条目，若原插件目录仍在 node_modules 下），重启 GUI 即回到整合前状态。

## 已知限制

- client 半为单文件内联，功能模块以代码注释分区；新增功能需同步维护 `lib/` 与 `client/client.js` 两处。
- Session log 复刻按钮依赖官方 `sessionLogDownload` controller 接口，官方包升级若变更接口需同步（见 lib/log-reposition.js 注释）。
- 身份注入每轮请求携带身份文本 token（与 persona/全局提示词一致）。
