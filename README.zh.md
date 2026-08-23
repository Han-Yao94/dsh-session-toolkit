# dsh-session-toolkit

[English](README.md) | 中文

DeepSeek Harness 插件整合包。将六个此前相互独立的本地插件——会话身份、全局提示词、会话自动上线、Web 重启服务、Session log 按钮平移、会话间对等消息——合并为单一可安装包（官方组合包形态，`dsh.bundle.patch`），经 `dsh plugin add` 安装。

## 功能特性

- **会话身份** — 每会话人设提示词注入该会话系统提示词（独立段 `session-identity`，order 40，每次组装按 agent 求值），支持默认身份与每会话覆盖。UI：身份浮层（启用开关、4000 字符软上限、保存/重置、编辑默认身份、继承默认身份）及双入口状态按钮：`conversation.session.header.actions`（id `session-identity`，order 40）与 `conversation.input.left`（id `session-identity-input`，order 40）。
- **全局提示词** — 设置页（`settings.section`，id `global-prompt`，order 30）配置一段注入所有会话系统提示词的文本（段 `global-prompt`，order 50）。连续 `{` 被空格化（`/\{+/g`），避免与提示词变量冲突。
- **会话自动上线** — 开启每会话开关的会话在 GUI 重启后自动 resume（`ctx.agents.resume`，携带 `agentDefaultModel` 默认模型）；开关从关→开时立即生效。过滤链：开关开启 + 仅顶层（非 subagent origin、`delegationDepth <= 0`、无 `parentSession`）+ 非空白（`seedLength !== 0`）。并发受限（`CONCURRENCY = 3`）、单项失败隔离、in-flight 集合防重复 resume。
- **Web 重启服务** — 通用设置中的「重启服务」条目（`settings.general.item`，id `web-restart`，order 90），**无 UAC 弹窗**（spawn 继承服务器进程 token，重启脚本的提权分支不会触达），带全屏进度覆盖层（探测驱动进度、刷新前补满动画、90s 超时兜底 + 手动刷新）。路由：`GET /api/restart`（健康探测，恒 200）与 `POST /api/restart`（触发，进行中返回 409，202 后 500ms 缓冲再 spawn）。恢复以**先中断后恢复**判定：覆盖层仅在观测到探测连续失败 `client.restartFailThreshold` 次、随后再次返回 200 时才刷新；若探测全程可达则判定"未检测到重启"（`noRestart`），直至超时并提示手动刷新。
- **Session log 按钮平移** — 在 `conversation.session.header.utilities` 遮蔽官方下载按钮（同 id `session-log-download`，priority −1，cell shadowing），并在 `conversation.session.header.actions` 注册复刻按钮（id `session-log-download-moved`，order 41），复用官方 `sessionLogDownload` controller（`ctx.get('sessionLogDownload')`），下载行为与官方完全一致。
- **会话间对等消息** — host 平面注册 `send_to_session` / `list_sessions` 工具（按会话 id 或工作区路径寻址、唤醒投递）+ 「复制会话 ID」按钮双入口（`conversation.session.header.actions` id `copy-session-id` order 30；`conversation.input.left` id `copy-session-id-input` order 30）。发送前消息内容经 `toPlainText` 转为纯文本，接收方看到整洁文本而非原始 markdown。

## 架构

- **host 半** — `lib/index.js` 组装六个功能模块（`identity.js`、`global-prompt.js`、`auto-resume.js`、`web-restart.js`、`peer-message.js`、`log-reposition.js`）。`inject` 为模块依赖去重并集；每个模块的 `apply` 经 `safe()` 守卫运行，单个模块失败不影响整包。所有贡献均绑定生命周期（提示词段与 HTTP 路由用 `ctx.effect`，工具随插件 fiber 注册；定时器统一走 `timer` 服务）。
- **client 半** — `client/client.js` 为单个 `window.__ModuleLoader__.load` 包；五个 UI 模块以 IIFE 内联并由统一 `apply` 按序注册全部插槽（逐模块守卫）。全部 UI 使用 `React.createElement`；样式以 `data-plugin` style 标签注入，使用主题 CSS 变量并覆盖暗色模式；无全局 DOM 操作。

### 注册插槽

| 插槽 | Id | 顺序/优先级 | 功能 |
|---|---|---|---|
| `settings.section` | `global-prompt` | order 30 | 全局提示词页 |
| `settings.general.item` | `web-restart` | order 90 | 重启服务条目 |
| `conversation.session.header.actions` | `copy-session-id` | order 30 | 复制会话 ID |
| `conversation.session.header.actions` | `session-identity` | order 40 | 身份按钮 |
| `conversation.session.header.actions` | `session-log-download-moved` | order 41 | Session log 下载 |
| `conversation.input.left` | `copy-session-id-input` | order 30 | 复制会话 ID（工具行） |
| `conversation.input.left` | `session-identity-input` | order 40 | 身份按钮（工具行） |
| `conversation.session.header.utilities` | `session-log-download` | priority −1（遮蔽） | 隐藏官方按钮 |

## 配置

Settings 命名空间（schema 校验、`applies: live`、持久化于 `settings.yaml`）：

| 命名空间 | Schema | 说明 |
|---|---|---|
| `session-identity` | `{ default: {enabled: boolean, text: string}, sessions: Record<sessionId, {enabled, text}> }` | 解析顺序：会话记录 → 默认 → 空。禁用或空文本不注入。身份文本上限 8000 字符（token 守卫截断）。 |
| `session-auto-resume` | `{ sessions: Record<sessionId, boolean> }` | 每会话开关；缺省键视为关闭。 |
| `global-prompt` | `{ enabled: boolean, content: string }` | 启用时注入所有会话。 |
| `workspace-prompt` | `{ workspaces: Record<path,{enabled, content}>, removed: string[] }` | 按工作区的提示词。某会话会得到与其 cwd 目录前缀匹配、路径最深（最具体）且启用的工作区内容。`removed` 记录用户已移除的路径，使活跃工作区同步不重新补回。 |
| `workspace-registry-active` | `{ active: [{path, sessionCount}] }` | 活跃工作区只读投影（来自 `workspaceRegistry.list()`），供设置界面显示活跃会话数；`workspaceRegistry` 缺失时降级。 |
| `workspace-prompt` | `{ workspaces: Record<path,{enabled, content}>, removed: string[] }` | 按工作区的提示词。某会话会得到与其 cwd 目录前缀匹配、路径最深（最具体）且启用的工作区内容。`removed` 记录用户已移除的路径，使活跃工作区同步不重新补回。 |
| `workspace-registry-active` | `{ active: [{path, sessionCount}] }` | 活跃工作区只读投影（来自 `workspaceRegistry.list()`），供设置界面显示活跃会话数；`workspaceRegistry` 缺失时降级。 |
| `file-blocklist` | `{ global: string[], sessions: Record<sessionId, string[]> }` | 屏蔽文件 glob 列表（`**`/`*`/`?`，路径大小写不敏感）。read/read_image 等工具可靠拦截；shell 命令文本启发式（字面路径包含或模式正则匹配）。**边界**：shell 间接读取（变量展开、改名复制、拼接）不保证拦截。 |

文件屏蔽边界：read/read_image 可靠拦截；shell 间接读取（变量展开/改名复制/拼接）不保证——仅作启发式提示。

### 插件 Config（cordis）

聚合包导出单一 `Config`（schemastery schema），按功能分键。默认值 = 现状；可在 `cordis.yml` / `cordis.patch.yml` 插件行的 `config` 字段覆盖，无需改代码。client 半遵循同一 cordis 机制（导出 `Config` 并接收 `config.client`）；若 client bundle 无法解析 schemastery，client 半降级为默认值且不导出 `Config`（行为不变）：

```yaml
- id: session-toolkit
  name: 'dsh-session-toolkit'
  config:
    identity:
      maxText: 8000
      sectionOrder: 40
    globalPrompt:
      sectionOrder: 50
      workspaceSectionOrder: 60
    autoResume:
      concurrency: 3
    webRestart:
      scriptPath: ''          # 可选；缺省推导为 <DSH_HOME>/autostart/dsh-web-restart.cmd
      spawnDelayMs: 500
    client:
      identityCharLimit: 4000
      restartTimeoutMs: 90000
      restartPollMs: 1000
      restartFillMs: 600
      restartFailThreshold: 2
      copyFeedbackMs: 1600
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `identity.maxText` | 8000 | 身份文本截断上限（字符，token 守卫）。 |
| `identity.sectionOrder` | 40 | 身份段在系统提示词中的顺序。**迁移**：显式固定 `identity.sectionOrder: 55` 的用户需改为 40 以保持「身份 → 全局 → 工作区」顺序。 |
| `globalPrompt.sectionOrder` | 50 | 全局提示词段的顺序。 |
| `globalPrompt.workspaceSectionOrder` | 60 | 工作区提示词段的顺序（置于最后）。 |
| `globalPrompt.workspaceSectionOrder` | 60 | 工作区提示词段的顺序（置于最后）。 |
| `globalPrompt.workspaceSectionOrder` | 60 | 工作区提示词段的顺序（置于最后）。 |
| `autoResume.concurrency` | 3 | 启动恢复的最大在途 resume 数。 |
| `webRestart.scriptPath` | 推导 | 重启脚本路径；缺省 `<DSH_HOME>/autostart/dsh-web-restart.cmd`（经 dsh-home-paths）。 |
| `webRestart.spawnDelayMs` | 500 | 202 缓冲后 spawn 重启脚本的延迟。 |
| `client.identityCharLimit` | 4000 | 身份编辑文本域字符上限（UI 软限制）。 |
| `client.restartTimeoutMs` | 90000 | 重启覆盖层超时（显示手动刷新提示）。 |
| `client.restartPollMs` | 1000 | 重启健康探测轮询间隔。 |
| `client.restartFillMs` | 600 | 探测恢复后的进度补满动画时长。 |
| `client.restartFailThreshold` | 2 | 判定"观测到中断"所需的连续失败探测次数。 |
| `client.copyFeedbackMs` | 1600 | 复制反馈对勾显示时长。 |

## 部署

安装进任意 profile（bundle 层；单一源码，无副本漂移）：

```powershell
# npm 安装
dsh plugin --profile <name> add dsh-session-toolkit

# GitHub 安装
dsh plugin --profile <name> add github:Han-Yao94/dsh-session-toolkit

# 本地 checkout / tarball
dsh plugin --profile <name> add ./dsh-session-toolkit-<version>.tgz
```

包内 `dsh.bundle.patch`（`cordis.patch.yml`）注册单一条目（`id: session-toolkit`，`name: 'dsh-session-toolkit'`）作为 **bundle 层**——在 `dsh-base` / `dsh-web-app` 之后、profile patch 层之前应用（层序：bundles 按序 → profile patch → home patch → `--patch` overlay）。

卸载：`dsh plugin --profile <name> remove dsh-session-toolkit`。

### 本地开发

迭代源码时可直接安装 checkout（`dsh plugin --profile <name> add <源码路径>`，使用 pnpm `link:` 依赖），或手工 junction 到 profile 的 `node_modules` 并在 profile 的 `cordis.patch.yml` 显式 `- insert:` 注册。推荐使用官方 `dsh plugin add` 流程。

### 分享与安装

已发布至 **npm**（`dsh-session-toolkit`，v0.1.2，MIT）并同步至 **GitHub**（`github.com/Han-Yao94/dsh-session-toolkit`）。纯 JS 包——**无构建步骤、无 prepare 脚本**。`files` 已白名单 `lib/`、`client/`、`cordis.patch.yml` 与 README。

- **npm**：消费者 `dsh plugin --profile <name> add dsh-session-toolkit` 安装；新版本通过 `npm publish`（或 `pnpm publish`）发布。
- **GitHub**：`dsh plugin --profile <name> add github:Han-Yao94/dsh-session-toolkit`。
- **tarball**：`pnpm pack` → `dsh plugin --profile <name> add ./dsh-session-toolkit-<version>.tgz`。

运行时依赖（`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-home-paths`）声明在 `dependencies`，随安装自动拉取；平台模块（`react`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-*`）为 `peerDependencies`，由 DSH 宿主提供。已验证：打包 tgz 的干净安装可完整解析所有 import（不依赖本地 junction）。

## 模型体验

### 系统提示词贡献

#### 模型看到的内容

每次组装贡献三个段，顺序：`session-identity`（order 40）→ `global-prompt`（order 50）→ `workspace-prompt`（order 60），位于部署 persona 之后、工具引导（100–199）之前。身份段在组装时按 agent（`AssembleContext.agent`）从 `session-identity` 设置解析，subagent（`origin`/`delegationDepth`）跳过。工作区段为 cwd 前缀匹配到配置工作区（取路径最深/最具体且启用者）的会话注入该工作区内容，否则为空。空段在渲染时删除。

#### Token 影响

启用时三个段的文本随每次请求重复。全局提示词作用于所有会话；身份文本仅作用于能解析到它的会话（自身记录或默认）；工作区文本仅作用于 cwd 前缀匹配到已启用且已配置工作区（取最具体）的会话。身份文本上限 8000 字符（token 守卫）。

#### KV Cache 影响

设置不变时各段渲染文本是请求前缀的固定部分；修改会话身份或全局提示词可能从首个变化 token 起使提供方缓存复用失效（与官方 persona 段语义一致）。

### 工具面

`send_to_session` 与 `list_sessions` 在 host 平面注册，所有会话可见（subagent 经常驻 preset 组装继承）。参数与返回均为 JSON 兼容。

## 机制与红线

- **身份注入** 使用单一全局段、text 提供方按 agent 求值——无逐 agent 注册、无生命周期开销、设置变更实时生效。
- **自动上线绝不调用 `dispose()`** —— `AgentHandle.dispose()` 会从存储移除会话；关闭开关只影响下次重启，绝不下线当前会话。
- **重启零 UAC 是构造性保证** —— spawn 继承服务器进程 token（SYSTEM 或用户），`taskkill` 目标是同权限进程，脚本提权分支（唯一 UAC 来源）不可达。若 3080 被其他程序占用，仍可能出现提权重试（重启脚本中有说明）。
- **遮蔽基于 cell shadowing** —— utilities 条目以更低 priority 重注册官方 `session-log-download` cell；遮蔽崩溃时官方条目优雅 abdicate 回退。
- **纯文本转换** —— `toPlainText`（10 条规则、代码围栏状态机、宽松匹配）仅在发送时执行；消息结构与 `source: { kind: 'user' }` 不变。

## 已知限制与暂缓事项

- client 半为手工维护的单文件 IIFE 包；新增功能需同步维护 `lib/` 与 `client/client.js` 两处。
- 平移的 Session log 按钮依赖官方 `sessionLogDownload` controller 接口；官方升级变更接口需同步（见 `lib/log-reposition.js`）。
- `toPlainText` 宽松斜体匹配可能误删非格式位置的成对 `*`（如 `a * b * c`）；对 agent 生成消息可接受，边界收紧为可选优化。
- 聚合 `inject` 并集会等待所列全部服务；某 profile 缺一服务会拖慢整包 apply（web profile 当前齐备）。
- `ctx.get('agentDefaultModel')` 在 apply 时非惰性解析；gateway 先于本包挂载该服务，web profile 恒有值。
- **重启探测窗口** — 仅在健康探测连续失败 `restartFailThreshold × restartPollMs`（默认 2 × 1000 ms = 2 s）后恢复时判定为重启。若 relaunch 在该窗口内完成，覆盖层可能误报"未检测到重启"（`noRestart`）；调低 `restartFailThreshold` 到 1 虽更灵敏，也会让单次瞬时失败被误判为重启中断。

## 恢复方法

卸载组合包：`dsh plugin --profile <name> remove dsh-session-toolkit`，重启 GUI。若要回退到整合前布局，重新启用原插件而非安装本包。
