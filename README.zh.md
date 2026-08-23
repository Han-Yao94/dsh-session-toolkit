# dsh-session-toolkit

[English](README.md) | 中文

DeepSeek Harness 的整合插件工具箱。将先前 6 个独立的本地插件——会话身份、全局提示词、会话自动恢复、Web 重启服务、Session log 按钮平移、会话间消息——合并为单个可安装包（官方 bundle 形态，`dsh.bundle.patch`），通过 `dsh plugin add` 安装。

## 功能

- **会话身份（Session Identity）** —— 每会话人设提示词注入该会话系统提示词（独立段 `session-identity`，order 40，每次组装按 agent 求值），支持默认身份与每会话覆盖。UI：身份浮层（启用开关、4000 字符软上限、保存/重置、编辑默认身份、继承默认身份）及双入口状态按钮：`conversation.session.header.actions`（id `session-identity`，order 40）与 `conversation.input.left`（id `session-identity-input`，order 40）。
- **全局提示词（Global Prompt）** —— 设置页（`settings.section`，id `global-prompt`，order 30），以 **Tabs（全局 / 按工作区）** 渲染。*全局* Tab 注入一段作用于所有会话系统提示词的文本（段 `global-prompt`，order 50）；*按工作区* Tab 注入按工作区提示词（段 `workspace-prompt`，order 60）。连续 `{` 被空格化（`/\{+/g`），避免与提示词变量冲突。
- **工作区提示词（Workspace Prompt）** —— 为 `cwd` 前缀匹配到已配置工作区目录（该目录及子目录）的会话注入按工作区提示词。工作区列表由**活跃会话的 `cwd`** 聚合而来（`ctx.agents.roots()`，去重并按会话数计数）。当多个已启用工作区前缀命中某会话的 `cwd` 时，取**最具体（路径最深/最长）**者。`removed` 记录用户已移除的路径，使活跃工作区同步不重新补回。工作区行的启用开关 **即时保存（live-save）**；「保存」按钮仅持久化提示词**内容 + 引用文件**。
- **引用文件（Referenced Files）** —— 全局提示词与工作区提示词均可引用**文件列表**。每次组装用 `fs.readFileSync`（UTF-8）**实时**重新读取每个引用文件，内容经 sanitize（`{` 空格化）后注入到提示词文本之后。读取失败会**跳过**（该文件内容不注入）并在 UI 中显示具体原因。支持纯文本/markdown，无大小上限。每个文件的读取状态经 `prompt-file-status` 命名空间投影到 UI（`ok`：N 字符 / `fail`：原因 / 未读取）。
- **会话自动恢复（Session Auto-Resume）** —— 开启开关的会话在 GUI 重启后自动恢复（`ctx.agents.resume`，携带 `agentDefaultModel` 的默认模型）；开启某会话即立即恢复（false→true 边沿）。过滤：开关开启、仅顶层（无 subagent origin、无 `delegationDepth > 0`、无 `parentSession`）、非空白（`seedLength !== 0`）。并发受限（`CONCURRENCY = 3`），逐项失败隔离 + 在途集合防重复恢复。
- **Web 重启（Web Restart）** —— General 设置中的「重启服务」入口（`settings.general.item`，id `web-restart`，order 90），以**零 UAC 提示**重启 GUI 服务器（spawn 继承服务器进程 token，重启脚本的提权分支不可达），并显示全屏进度覆盖层（探针驱动进度、重载前填充动画、90 秒超时回退到手动刷新）。路由：`GET /api/restart`（健康探针，恒 200）与 `POST /api/restart`（触发，重启在途时 409，202 + 500ms 缓冲后 spawn）。恢复检测采用**中断-恢复**：覆盖层仅在观察到探针连续失败 `client.restartFailThreshold` 次并再次返回 200 后重载；若探针全程可达则报告「未检测到重启」（`noRestart`）直到超时，提供手动刷新。
- **Session log 按钮平移（Session-Log Button Relocation）** —— 遮蔽 `conversation.session.header.utilities` 中的官方下载按钮（同 id `session-log-download`，priority −1，cell shadowing），并在 `conversation.session.header.actions` 注册副本（id `session-log-download-moved`，order 41），复用官方 `sessionLogDownload` controller（`ctx.get('sessionLogDownload')`），下载行为与官方一致。
- **会话间消息（Peer Messaging）** —— host 平面注册 `send_to_session` / `list_sessions` 工具（按 id 或工作区路径寻址会话、wakeup 投递），并在 `conversation.session.header.actions`（id `copy-session-id`，order 30）与 `conversation.input.left`（id `copy-session-id-input`，order 30）各加「复制会话 ID」按钮。发出消息内容在投递前经 `toPlainText` 转为纯文本，接收方看到整洁文本而非原始 markdown。

## 架构

- **Host 半** —— `lib/index.js` 组装六个功能模块（`identity.js`、`global-prompt.js`、`auto-resume.js`、`web-restart.js`、`peer-message.js`、`log-reposition.js`）。`inject` 为模块依赖去重并集；每个模块的 `apply` 在 `safe()` 守卫内运行，单个模块失败不影响整包。所有贡献均绑定生命周期（提示词段与 HTTP 路由用 `ctx.effect`，工具随插件 fiber 注册；定时器统一走 `timer` 服务）。`global-prompt.js` 拥有 `global-prompt`、`workspace-prompt`、`workspace-registry-active`、`prompt-file-status` 命名空间、`readPromptFiles` 辅助函数（实时 `fs.readFileSync` 读），以及工作区/活跃工作流投影（`agents.roots()` → 活跃工作区）。
- **Client 半** —— `client/client.js` 为单一 `window.__ModuleLoader__.load` bundle；五个 UI 模块内联在 IIFE 中并在一个 `apply` 里按序注册全部 slot（逐模块守卫）。所有 UI 用 `React.createElement`；样式以 `data-plugin` style 标签注入，使用主题 CSS 变量与深色覆盖；无全局 DOM 操作。global-prompt 模块渲染 **Tabs（全局 / 按工作区）** 页面，并含可复用 `FileRefsPanel`（添加/移除引用文件，经绑定的 `prompt-file-status` scope 显示每文件状态）。

### 注册的 Slots

| Slot | Id | Order / priority | 功能 |
|---|---|---|---|
| `settings.section` | `global-prompt` | order 30 | 全局 + 工作区提示词页（Tabs） |
| `settings.general.item` | `web-restart` | order 90 | 重启入口 |
| `conversation.session.header.actions` | `copy-session-id` | order 30 | 复制会话 ID |
| `conversation.session.header.actions` | `session-identity` | order 40 | 身份按钮 |
| `conversation.session.header.actions` | `session-log-download-moved` | order 41 | Session log 下载 |
| `conversation.input.left` | `copy-session-id-input` | order 30 | 复制会话 ID（工具行） |
| `conversation.input.left` | `session-identity-input` | order 40 | 身份按钮（工具行） |
| `conversation.session.header.utilities` | `session-log-download` | priority −1（遮蔽） | 隐藏官方按钮 |

## 配置

设置命名空间（schema 校验、`applies: live`、持久化于 `settings.yaml`）：

| 命名空间 | Schema | 说明 |
|---|---|---|
| `session-identity` | `{ default: {enabled: boolean, text: string}, sessions: Record<sessionId, {enabled, text}> }` | 解析顺序：会话记录 → 默认 → 空。禁用或空文本不注入。身份文本上限 8000 字符（token 守卫截断）。 |
| `session-auto-resume` | `{ sessions: Record<sessionId, boolean> }` | 每会话开关；缺省键视为关闭。 |
| `global-prompt` | `{ enabled: boolean, content: string, files: string[] }` | 启用时注入所有会话。`files` 为引用文件列表，组装时实时读取并追加（读取失败的文件跳过）。 |
| `workspace-prompt` | `{ workspaces: Record<path,{enabled, content, files: string[]}>, removed: string[] }` | 按工作区提示词。某会话会得到与其 `cwd` 目录前缀匹配、路径最深（最具体）且启用的工作区提示词。`removed` 记录用户已移除的路径，使活跃工作区同步不重新补回。 |
| `workspace-registry-active` | `{ active: [{path, sessionCount}] }` | 活跃工作区只读投影，来自 **`ctx.agents.roots()`**（各 agent 的 `session.header.cwd` 去重计数）。**不**来自 `workspaceRegistry`（该服务在本插件作用域不可见）。 |
| `prompt-file-status` | `{ byScope: Record<global\|path, [{filePath, status: 'ok'\|'fail', charCount?, reason?}]> }` | 各作用域引用文件的最近读取结果只读投影；UI 的 `FileRefsPanel` 读取显示 `ok: N 字符` / `fail: 原因`。 |
| `file-blocklist` | `{ global: string[], sessions: Record<sessionId, string[]> }` | 屏蔽文件 glob 列表（`**`/`*`/`?`，路径大小写不敏感）。read/read_image 等工具可靠拦截；shell 命令文本启发式（字面路径包含或模式正则匹配）。**边界**：shell 间接读取（变量展开、改名复制、拼接）不保证拦截。 |

### 插件 Config（cordis）

聚合包导出单一 `Config`（schemastery schema），按功能分键。默认值 = 现状；可在 `cordis.yml` / `cordis.patch.yml` 插件行的 `config` 字段覆盖，无需改代码。client 半遵循同一 cordis 机制（导出 `Config` 并接收 `config.client`）；若 client bundle 无法解析 schemastery，client 半降级为默认值且不导出 `Config`：

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
| `autoResume.concurrency` | 3 | 启动恢复的最大在途 resume 数。 |
| `webRestart.scriptPath` | 推导 | 重启脚本路径；缺省 `<DSH_HOME>/autostart/dsh-web-restart.cmd`（经 dsh-home-paths）。 |
| `webRestart.spawnDelayMs` | 500 | 202 缓冲后 spawn 重启脚本的延迟。 |
| `client.identityCharLimit` | 4000 | 身份编辑区字符上限（UI 软上限）。 |
| `client.restartTimeoutMs` | 90000 | 重启覆盖层超时（之后提示手动刷新）。 |
| `client.restartPollMs` | 1000 | 重启健康轮询间隔。 |
| `client.restartFillMs` | 600 | 检测到恢复后的进度填充动画时长。 |
| `client.restartFailThreshold` | 2 | 判定中断前的连续健康轮询失败次数。 |
| `client.copyFeedbackMs` | 1600 | 复制反馈对勾时长。 |

## 部署

安装到任意 profile（bundle 层；单一来源，无副本）：

```powershell
# 来自 npm
dsh plugin --profile <name> add dsh-session-toolkit

# 来自 GitHub
dsh plugin --profile <name> add github:Han-Yao94/dsh-session-toolkit

# 来自本地 checkout / tarball
dsh plugin --profile <name> add ./dsh-session-toolkit-<version>.tgz
```

包的 `dsh.bundle.patch`（`cordis.patch.yml`）将单一入口（`id: session-toolkit`，`name: 'dsh-session-toolkit'`）注册为 **bundle 层**——在 `dsh-base` / `dsh-web-app` 之后、profile patch 层之前应用（层序：bundles 依次 → profile patch → home patch → `--patch` 覆盖）。

卸载：`dsh plugin --profile <name> remove dsh-session-toolkit`。

### 本地开发

迭代源码时可安装 checkout（`dsh plugin --profile <name> add <源码路径>`，使用 pnpm `link:` 依赖），或手工 junction 到 profile 的 `node_modules` 并在 profile 的 `cordis.patch.yml` 显式 `- insert:` 注册。推荐使用官方 `dsh plugin add` 流程。

### 分享与安装

已发布至 **npm**（`dsh-session-toolkit`，v0.1.3，MIT）并同步至 **GitHub**（`github.com/Han-Yao94/dsh-session-toolkit`）。纯 JS 包——**无构建步骤、无 prepare 脚本**。`files` 已白名单 `lib/`、`client/`、`cordis.patch.yml` 与 README。

- **npm**：消费者 `dsh plugin --profile <name> add dsh-session-toolkit` 安装；新版本通过 `npm publish`（或 `pnpm publish`）发布。
- **GitHub**：`dsh plugin --profile <name> add github:Han-Yao94/dsh-session-toolkit`。
- **tarball**：`pnpm pack` → `dsh plugin --profile <name> add ./dsh-session-toolkit-<version>.tgz`。

运行时依赖（`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-home-paths`）声明在 `dependencies`，随安装自动拉取；平台模块（`react`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-*`）为 `peerDependencies`，由 DSH 宿主提供。已验证：打包 tgz 的干净安装可完整解析所有 import（不依赖本地 junction）。

## 模型体验

### 系统提示词贡献

#### 模型看到的内容

每次组装贡献三个段，顺序：`session-identity`（order 40）→ `global-prompt`（order 50）→ `workspace-prompt`（order 60），位于部署 persona 之后、工具引导（100–199）之前。身份段在组装时按 agent（`AssembleContext.agent`）从 `session-identity` 设置解析，subagent（`origin`/`delegationDepth`）跳过。工作区段为 `cwd` 前缀匹配到配置工作区（取路径最深/最具体且启用者）的会话注入该工作区提示词，否则为空。

全局段与工作区段都会在提示词文本后追加其**引用文件内容**：每次组装用 `fs.readFileSync`（UTF-8）实时重新读取 `files`，对每个文件内容 sanitize（`{` 空格化）后拼接。无法读取的文件会**跳过**（其内容不注入），但其读取状态被记录供 UI 显示。空段在渲染时删除。

#### Token 影响

启用时三个段的文本随每次请求重复。全局提示词作用于所有会话；身份文本仅作用于能解析到它的会话（自身记录或默认）；工作区文本仅作用于 `cwd` 前缀匹配到已启用且已配置工作区（取最具体）的会话。引用文件的完整内容会加入实际提示词，因此消耗额外 token——大引用文件会显著增加每次请求的 token 成本。身份文本上限 8000 字符（token 守卫）。

#### KV Cache 影响

设置不变时各段渲染文本是请求前缀的固定部分；修改会话身份或全局/工作区提示词（或编辑/新增引用文件）可能从首个变化 token 起使提供方缓存复用失效（与官方 persona 段语义一致）。

### 工具面

`send_to_session` 与 `list_sessions` 在 host 平面注册，所有会话可见（subagent 经常驻 preset 组装继承）。参数与返回均为 JSON 兼容。

## 机制与红线

- **身份注入** 使用单一全局段、text 提供方按 agent 求值——无逐 agent 注册、无生命周期开销、设置变更实时生效。
- **frozen 设置铁律（红线）** —— DSH 的 `ctx.settings.register(...).scope.get()` 返回的 value 被 **`deepFreeze` 冻结（不可变）**。任何 host 写 scope 前，必须先将对象 **`{ ... }`（数组 `.slice()`）拷贝成可变对象，再用 `update()`**（register scope 只有 `get`/`watch`/`update`/`replace`，**无 `set`**）；直接改冻结对象会抛 `object is not extensible`（正是此处修复的「工作区列表空」根因）。client 端用 `settingsScope.bind().set()`（client scope 支持 `set`）。同一 `{ ... }` 拷贝规则适用于 client 对 `workspace-prompt` 的写入（`onWsFilesChange` / `save` / `saveWsEnabled` / `removeWorkspace`）。
- **引用文件实时读取、失败跳过** —— `readPromptFiles` 在每次组装的 `text()` 内运行；读取失败的文件不会中断组装，其状态被记录到 `prompt-file-status` 供 UI 显示。
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
- **重启探测窗口** — 仅在健康探测连续失败 `restartFailThreshold × restartPollMs`（默认 2 × 1000 ms = 2 s）后恢复时判定为重启。若 relaunch 在该窗口内完成，覆盖层可能误报「未检测到重启」（`noRestart`）；调低 `restartFailThreshold` 到 1 虽更灵敏，也会让单次瞬时失败被误判为重启中断。
- **引用文件在组装内同步读取** —— `readPromptFiles` 每次组装对每个引用文件使用 `fs.readFileSync`；文件很多或很大时会阻塞组装（「无大小上限」需求是有意权衡）。`prompt-file-status` 每次在组装路径更新（且 UI 的 `FileRefsPanel` 随状态重渲染），属轻微性能噪音。client 端 `files` 即时保存（`onWsFilesChange` / `save`）。

## 恢复方法

卸载 bundle：`dsh plugin --profile <name> remove dsh-session-toolkit`，然后重启 GUI。要回退到整合前的布局，请重新启用原插件而非安装本包。
