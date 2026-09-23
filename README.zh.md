# dsh-session-toolkit

[English](README.md) | 中文

DeepSeek Harness 的整合插件工具箱。将先前 6 个独立的本地插件——会话身份、全局提示词、会话自动恢复、Web 重启服务、Session log 按钮平移、会话间消息——合并为单个可安装包(官方 bundle 形态,`dsh.bundle.patch`),通过 `dsh plugin add` 安装;另含提示词去重(Prompt Dedup)功能。

当前版本:**0.1.11**,已对照 **DeepSeek Harness `dsh-v0.1.7-alpha.1`** 验证——它同时是**最低支持版本**:0.1.6 及更早会**响亮失败**而非静默降级(见[兼容性](#compatibility))。

---

## 功能

### 会话身份(Session Identity)
每会话人设提示词注入该会话系统提示词(独立段 `session-identity`,order 40,每次组装按 agent 求值),支持默认身份与每会话覆盖。UI:身份浮层(启用开关、4000 字符软上限、保存/重置、编辑默认身份、继承默认身份)及双入口状态按钮:`conversation.session.header.actions`(id `session-identity`,order 40)与 `conversation.input.left`(id `session-identity-input`,order 40)。浮层卡片可按**标题行拖动**:位移每次移动都被钳制在视口内、窗口缩放时重新钳制;卡片比视口大时**每个轴都仍可移动**,四个边都能拖到。位置不持久化,浮层关闭即复位。

### 全局提示词(Global Prompt)
设置页(`settings.section`,id `global-prompt`,order 30),以 **Tabs(全局 / 按工作区)** 渲染。*全局* Tab 注入一段作用于所有会话系统提示词的文本(段 `global-prompt`,order 50);*按工作区* Tab 注入按工作区提示词(段 `workspace-prompt`,order 60)。两个段都以 **`interpolate: false`** 注册:提示词文本与引用文件里的 `{{...}}` 一律按字面保留,用户内容永不被改写,未注册的 `{{name}}` 也不可能让组装失败。0.1.6 之前的内核没有分段的 `interpolate` 开关,由 `lib/prompt-literal.js` 在组装结果上退化为 `{` 连续串空格化。

### 工作区提示词(Workspace Prompt)
为 `cwd` 前缀匹配到已配置工作区目录(该目录及子目录)的会话注入按工作区提示词。工作区列表由**活跃会话的 `cwd`** 聚合而来(`ctx.agents.roots()`,去重并按会话数计数)。当多个已启用工作区前缀命中某会话的 `cwd` 时,取**最具体(路径最深/最长)**者。`removed` 记录用户已移除的路径,使活跃工作区同步不重新补回。工作区行的启用开关 **即时保存(live-save)**;「保存」按钮仅持久化提示词**内容 + 引用文件**。

### 引用文件(Referenced Files)
全局提示词与工作区提示词均可引用**文件列表**。每次组装重新读取每个引用文件(UTF-8;按 `mtimeMs` + 大小缓存,未变化的文件不重复读盘),注入到提示词文本之后。有字节预算(`globalPrompt.maxFileBytes` / `maxTotalBytes`,默认 256 KiB / 1 MiB):超限文件**跳过**而不是阻塞组装。读取失败同样跳过,两种情况都在 UI 中显示具体原因。支持纯文本/markdown。每个文件的读取状态是 host 的**运行时投影**,经只读路由 `GET /api/session-toolkit/state` 送到 UI(`ok`:N 字符 / `fail`:原因 / 未读取),浏览器半只在设置页打开期间轮询它;**状态不写入任何配置文件**,内容未变时不重建投影。

### 会话自动恢复(Session Auto-Resume)
开启开关的会话在 GUI 重启后自动恢复,优先走**官方恢复链路**(`ctx.sessionController.resolveAgent`)——它除了 mount preset,还会通过 `installSelection` 恢复会话自己的模型选择,并做 subagent 归属校验与并发恢复去重;0.1.6 之前没有该服务的内核回落为 `ctx.agents.resume` + 手工 mount preset,并携带 `agentDefaultModel` 的默认模型。开启某会话即立即恢复(false→true 边沿)。过滤:开关开启、仅顶层(无 subagent origin、无 `delegationDepth > 0`、无 `parentSession`)、非空白(快照形状的 `eventCount !== 0`)。并发受限(`CONCURRENCY = 3`),逐项失败隔离 + 在途集合防重复恢复。

### Web 重启(Web Restart)
General 设置中的「重启服务」入口(`settings.general.item`,id `web-restart`,order 90),重启 GUI 服务器并显示全屏进度覆盖层(探针驱动进度、重载前填充动画、90 秒超时回退到手动刷新)。两条平台链路都**独立于将要退出的服务器进程**:

- **Windows**(`windows-script`):`wscript.exe` 执行 launcher VBS(隐藏控制台),由它运行 `<DSH_HOME>/autostart/dsh-web-restart.cmd`;spawn 继承服务器进程 token,提权分支(唯一 UAC 来源)不可达。
- **macOS / Linux**(`posix-relaunch`;配置了 `webRestart.scriptPath` 时为 `posix-script`):**无需任何配置即可自重启**——host 生成一次性 `/bin/sh` 脚本:SIGTERM 当前 PID → 最多等 10 秒(超时 SIGKILL)→ `cd` 回原工作目录 → 以原命令(`process.execPath` + `process.argv.slice(1)`)重新执行,输出追加到 `<DSH_HOME>/autostart/dsh-web-restart.log`。若服务器由 supervisor 之类托管,可把 `webRestart.scriptPath` 指向自己的 `.sh` 接管。

client 挂载时探测 `GET /api/restart`,host 回报 `available: false`(不支持的平台)时直接隐藏入口,该平台 `POST` 返回 501。路由:`GET /api/restart`(健康探针,恒 200 + `available`/`mode`/`platform`)与 `POST /api/restart`(触发;重启在途 **409**,配置的脚本不存在或无法自重启 **500** 且带原因,可继续 **202** + 500ms 缓冲后 spawn)。client **只在拿到 202 时进入覆盖层**——其它状态就地显示错误,不再空转 90 秒。恢复检测采用**中断-恢复**:覆盖层仅在观察到探针连续失败 `restartFailThreshold` 次并再次返回 200 后重载;若探针全程可达则报告「未检测到重启」(`noRestart`)直到超时,提供手动刷新。

同一个 webServer 上另注册只读状态路由 `GET /api/session-toolkit/state`(活跃工作区 + 引用文件读取状态;非 `GET` 一律 405):设置页靠它拿这两项**运行时投影**,因此它们不再占用 settings 命名空间,也不落盘。

### Session log 按钮平移(Session-Log Button Relocation)
遮蔽 `conversation.session.header.utilities` 中的官方条目(同 id `session-log-download`,priority −1,cell shadowing),并在 `conversation.session.header.actions` 注册副本(id `session-log-download-moved`,order 41),复用官方 `sessionLogDownload` controller(`ctx.get('sessionLogDownload')`),下载行为与官方一致。副本对齐 **0.1.6** 的官方形态——「⋯ 更多操作」菜单(单条「下载 Session 日志」)触发共享对话框(文案走本插件自己的 locale 命名空间);它是**冻结的复刻件**:官方改版必须人工同步,官方条目新增菜单项时也要重新核对遮蔽策略。

### 会话管理(Session Admin)
host 平面另注册两个工具,**与 `send_to_session` / `list_sessions` 同平面**:

- **`create_session`** —— 自主创建一个新的顶层会话(GUI 左侧导航里的一个聊天窗口)。**`cwd` 与 `prompt` 均必填**:`cwd` 必须是绝对路径(无 `cwd` 的会话不会进宿主列表),`prompt` 是新会话的首条消息。创建成功即产生一条真实用户消息(**会真实跑一轮模型、消耗一次调用**);按内核设计,产生过事件的会话会被持久化,因此**本工具不提供「只登记、不说话」的临时会话**。可选 `title` 会立即设定标题并 pin 住。返回体含 `sessionId`、`cwd`、`status`、`title` 与 `notes`。
- **`rename_session`** —— 修改一个**在线(live)**会话的标题。改名会 **pin 住标题**,不再被自动标题生成覆盖。目标必须是顶层会话且当前在线:目标是子会话(`origin=subagent` 或 `delegationDepth>0`)时明确拒绝,不静默改写。

两者都以**结构化结果**返回(**工具执行本身不抛未捕获异常**):成功 `{ ok: true, … }`,失败 `{ ok: false, error: '<码>', errorText: '<原始原因>' }`。错误码:`MODEL_UNAVAILABLE` / `MODEL_SELECTION_FAILED` / `MODEL_SELECTION_INVALID` / `EMPTY_CWD` / `CWD_NOT_ABSOLUTE` / `EMPTY_PROMPT` / `PROMPT_TOO_LONG` / `PRESET_RESOLVE_FAILED` / `CREATE_FAILED` / `CREATE_UNAVAILABLE` / `CREATE_NO_AGENT` / `EMPTY_TARGET` / `EMPTY_TITLE` / `SESSION_UNAVAILABLE` / `TARGET_IS_SUBAGENT` / `TITLE_SERVICE_UNAVAILABLE` / `UNEXPECTED`。
(`prompt` 缺失由内核工具参数校验在**框架层**拒绝——内核把它转成工具错误结果，该异常不经本插件代码；`prompt` 传了但纯空白才由本插件返回 `EMPTY_PROMPT`。两者都不创建会话。)

**两处如实声明**:
- **可见性未在工具内验证** —— 「带 `prompt` 建出的会话会出现在左侧导航」取决于内核是否**真正开跑一轮**(导航按「空白会话」判据过滤,该状态只在 `turn/start` 时翻转;`followup` 只是入队并唤醒驱动)。因此返回体**不下**「已出现在导航」的结论,`notes` 会写明这一点。
- **preset 降级** —— `agentPresets` 服务存在但默认 preset 解析失败时,工具**返回 `PRESET_RESOLVE_FAILED`,而不是交付一个没有 preset 的残缺会话**;服务整体缺失属合法降级,会话照建并带说明性 `notes`。

### 会话间消息(Peer Messaging)
host 平面注册 `send_to_session` / `list_sessions` 工具(按 id 或工作区路径寻址会话、wakeup 投递),并在 `conversation.session.header.actions`(id `copy-session-id`,order 30)与 `conversation.input.left`(id `copy-session-id-input`,order 30)各加「复制会话 ID」按钮。发出消息内容在投递前经 `toPlainText` 转为纯文本,接收方看到整洁文本而非原始 markdown。

### 提示词去重(Prompt Dedup)
对 **身份 / 全局 / 工作区** 三段系统提示词(段 `session-identity`、`global-prompt`、`workspace-prompt`,order 40/50/60)做**跨段行级去重**。`promptDedup.enabled` 默认开启(仅显式设为 false 时禁用)。按 `\n` 切分,三段内出现过的**完全相同原行**只保留"先出现"那一份(全局 `seen` 贯穿三段,同段内部自重复也收敛),后出现段的重复行被去掉;任何段独有内容一律保留。**空行(含只有空白的行)不参与去重**——空行是 markdown 的段落/列表分隔,把它当成重复行会让第一段之后的每一段空行都被删掉。不解析 `{{name}}` 占位符(单行完整组,按行切分不会切断)、不破坏 markdown、不设 complete,绝不动 harness 自带段(`harness:identity` / `deployment:persona` / 工具段)。机制:在插件根 ctx 订阅 `system-prompt/assemble` waterfall,`await next()` 后对返回结果的 `sections` 做去重再返回。

---

## 兼容性

插件已对照 **DeepSeek Harness `dsh-v0.1.7-alpha.1`** 验证,并以它作为**最低支持版本**:0.1.7 把 settings 从「插件注册命名空间 + `ctx.settingsScope.bind`」改为「条目 Config 的 `volatile` 字段 + `ctx.configForms`」,用户数据面因此整体迁移(见[设置字段](#设置字段条目-config-的-volatile-部分))。在 0.1.6 及更早内核上,客户端条目会停在 `pending (waiting for service: configForms)`,`web boot` 报「Failed to load plugins」——这是**响亮失败**而非静默降级,处置是升级 harness 或卸载本插件。`interpolate: false` 与 `ctx.sessionController.resolveAgent` 的既有兜底不变。

- **框架**:`@deepseek-ai/cordis` 4.0.3 与 `@deepseek-ai/schemastery` 3.18.3(即 `dsh-v0.1.7-alpha.1` vendored 的版本)。`@deepseek-ai/schemastery` 的下限是 `^3.18.3`:`volatile()` 在该版本才存在,更早的 3.18.x 会让 `Config` 构造直接抛错。插件经 cordis harness 加载,并以 `dsh.bundle.patch` 注册为 bundle。
- **Host 服务**(已对照原生源码校验):本条目 `Config` 的 `volatile()` 字段 + `.get()` 实时读取,提交后由 `ctx.on('loader/volatile-update', …)` 通知(不重挂插件);`ctx.get('settings').update('session-toolkit', patch)` 作为 host 写回条目 config 的入口(工作区自动补回用);`ctx.systemPrompt.section({ name, order, text, interpolate: false })`;`ctx.agents.{ get, resume({ resumeSessionId, agentOptions, setup }), roots, requireInitiator }`;`ctx.sessionController.resolveAgent(sessionId)`;`session.header` 字段(`cwd`、`origin`、`delegationDepth`、`parentSession`、`agentPreset`;没有 `seedLength`);用于等待晚到可选服务的 `ctx.inject(names, cb)`;`ctx.get('webServer').register({ kind: 'exact', path, handler })`;`@deepseek-ai/dsh-tools` 的 `defineTool` + `tools.register()`;以及 `ctx.get('agentDefaultModel')`、`sessionPersistence`、`sessionTitle`、`workspaceRegistry`、`sessionLogDownload`、`timer`、`on`、`effect`。
- **Client 服务**(已校验):`window.__ModuleLoader__.load({ id, factory })`;`ctx.get('slots')` → `slots.register(meta, render)` / `slots.inject(name, fn)`(**低 priority 遮蔽**);`ctx.get('configForms').get('session-toolkit')` → 表单 `{ getSnapshot()/.value/.status, subscribe, set(field, value), unset(field), mutate(ops, expectedRevision) }`(写入经 host 校验后落盘当前 profile 的 `cordis.patch.yml`);`ctx.get('locale')` → `register(ns, { zh, en })` / `bind(ns)`;只读状态路由 `GET /api/session-toolkit/state`;以及 `timer` client 服务(`ctx.timeout`)。bundle 的运行时 `require` 均解析自模块表种子词(`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-primitives`、……)。

### 配置与设置数据面
插件的 **host 侧** `Config` 在插件加载时即用 schemastery 校验整棵配置树。解析顺序 = schema 默认 → profile patch(用户层);两者都在 host 侧解析完再交给插件。

DSH 0.1.7 起,settings 只投影**带 `volatile()` 的字段**,并只用两个事实标识一份设置:**被编辑条目的 id**(= `session-toolkit`)与**该条目的 Config**。因此:

- 用户数据(身份文本、全局/工作区提示词、自动上线开关、UI 旋钮)声明为 `volatile` 字段,浏览器半经 `ctx.get('configForms').get('session-toolkit')` 读写同一份条目 Config,写入由 host 校验后落盘**当前 profile 的 `cordis.patch.yml`**(不再有 `settings.yaml` 命名空间,也没有 `settingsScope` 服务)。
- host 半每次用到时 `.get()` 实时读取:`volatile` 值提交后**不重挂插件**,`identity` / `global-prompt` 段在下一次组装就生效,`auto-resume` 经 `loader/volatile-update` 立刻恢复新开启的会话。
- 普通字段(顺序、上限、重试、并发等部署参数)保持非 `volatile`:它们同样能在设置页里看到,但修改走 cordis 配置的正常生命周期。
- 运行时的**只读投影**(活跃工作区、引用文件读取状态)不属于配置,经 `GET /api/session-toolkit/state` 直接送给浏览器,既不落盘也不出现在表单里。

---

## 架构

- **Host 半** —— `lib/index.js` 组装九个功能模块(`identity.js`、`global-prompt.js`、`auto-resume.js`、`web-restart.js`、`peer-message.js`、`session-admin.js`、`log-reposition.js`、`prompt-dedup.js`、`prompt-literal.js`)。`inject` 为模块依赖去重并集;每个模块的 `apply` 在 `safe()` 守卫内运行,单个模块失败不影响整包。所有贡献均绑定生命周期(提示词段与 HTTP 路由用 `ctx.effect`,工具随插件 fiber 注册;定时器统一走 `timer` 服务)。`global-prompt.js` 拥有 `globalPrompt` / `workspacePrompt` 两组 volatile 字段的读取、`readPromptFiles` 辅助函数(实时 `fs.readFileSync` 读)、活跃工作区聚合(`agents.roots()` → `GET /api/session-toolkit/state`),以及把新出现的工作区路径经 `ctx.get('settings').update('session-toolkit', …)` 补进条目 config。
- **Client 半** —— `client/client.js` 为单一 `window.__ModuleLoader__.load` bundle;五个 UI 模块内联在 IIFE 中,在一个 `apply` 里按序注册全部 slot(逐模块守卫)。所有 UI 用 `React.createElement`;样式以 `data-plugin` style 标签注入,使用主题 CSS 变量与深色覆盖;无全局 DOM 操作。global-prompt 模块渲染 **Tabs(全局 / 按工作区)** 页面,并含可复用 `FileRefsPanel`(添加/移除引用文件;每文件状态来自 `GET /api/session-toolkit/state` 的轮询投影)。

### 注册的 Slots

| Slot | Id | Order / priority | 功能 |
|---|---|---|---|
| `settings.section` | `global-prompt` | order 30 | 全局 + 工作区提示词页(Tabs) |
| `settings.general.item` | `web-restart` | order 90 | 重启入口 |
| `conversation.session.header.actions` | `copy-session-id` | order 30 | 复制会话 ID |
| `conversation.session.header.actions` | `session-identity` | order 40 | 身份按钮 |
| `conversation.session.header.actions` | `session-log-download-moved` | order 41 | Session log 下载 |
| `conversation.input.left` | `copy-session-id-input` | order 30 | 复制会话 ID(工具行) |
| `conversation.input.left` | `session-identity-input` | order 40 | 身份按钮(工具行) |
| `conversation.session.header.utilities` | `session-log-download` | priority −1(遮蔽) | 隐藏官方按钮 |

---

## 配置

### 设置字段(条目 config 的 volatile 部分)

条目 id 固定为 `session-toolkit`;下面这些 `volatile()` 字段就是设置页读写的那份数据,schema 校验后落盘当前 profile 的 `cordis.patch.yml`。字段名即 config 路径(`identity.sessions` 等),浏览器半经 `configForms.get('session-toolkit')` 用同样的路径读写。

| 字段 | Schema | 说明 |
|---|---|---|
| `identity.default` | `{enabled: boolean, text: string}` | 默认身份。解析顺序:会话记录 → 默认 → 空。禁用或空文本不注入。 |
| `identity.sessions` | `Record<sessionId, {enabled, text}>` | 每会话身份。身份文本上限 `identity.maxText`(8000 字符,token 守卫)。 |
| `autoResume.sessions` | `Record<sessionId, boolean>` | 每会话「重启后自动上线」开关;缺省键视为关闭。 |
| `globalPrompt.{enabled,content,files}` | `{enabled: boolean, content: string, files: string[]}` | 启用时注入所有会话。`files` 为引用文件列表,组装时读取并追加(按 mtime/大小缓存;读取失败或超限的文件跳过)。 |
| `workspacePrompt.workspaces` | `Record<path,{enabled, content, files: string[]}>` | 按工作区提示词。某会话会得到与其 `cwd` 目录前缀匹配、路径最深(最具体)且启用的工作区提示词。 |
| `workspacePrompt.removed` | `string[]` | 用户已移除的路径,使活跃工作区同步不重新补回。 |
| `client.*` | 7 个 UI 旋钮(见下表) | 浏览器半的运行时参数(字符上限、重启超时/轮询/填充、复制反馈)。 |

**运行时投影(不落盘、不属于 config)**:活跃工作区 `[{path, sessionCount}]` 来自 **`ctx.agents.roots()`**(各 agent 的 `session.header.cwd` 去重计数;不来自本插件作用域不可见的 `workspaceRegistry`),引用文件读取状态为 `Record<global\|path, [{filePath, status: 'ok'\|'fail', charCount?, reason?}]>`;两者都经 `GET /api/session-toolkit/state` 提供给设置页。

### 插件 Config(cordis)

聚合包导出单一 `Config`(schemastery schema),按功能分键。默认值 = 现状;可在 `cordis.yml` / `cordis.patch.yml` 插件行的 `config` 字段覆盖,无需改代码。带 `.volatile()` 的分键(用户数据 + `client.*`)就是设置页读写的那份数据,浏览器半经 `configForms.get('session-toolkit')` 读到同一份解析结果(见[配置与设置数据面](#配置与设置数据面))。

```yaml
- id: session-toolkit
  name: 'dsh-session-toolkit'
  config:
    identity:
      maxText: 8000
      sectionOrder: 40
      default:                # volatile:默认身份
        enabled: false
        text: ''
      sessions: {}            # volatile:Record<sessionId, {enabled, text}>
    globalPrompt:
      sectionOrder: 50
      workspaceSectionOrder: 60
      maxFileBytes: 262144    # 单个引用文件上限;超限文件跳过并在 UI 报 fail
      maxTotalBytes: 1048576  # 单个段的全部引用文件合计上限
      enabled: false          # volatile:全局提示词开关
      content: ''             # volatile:全局提示词正文
      files: []               # volatile:引用文件列表
    workspacePrompt:          # volatile:按工作区提示词
      workspaces: {}          # Record<path, {enabled, content, files}>
      removed: []             # 用户已移除的路径
    autoResume:
      concurrency: 3
      sessions: {}            # volatile:Record<sessionId, boolean>
    webRestart:
      scriptPath: ''          # 可选;缺省推导为 <DSH_HOME>/autostart/dsh-web-restart.cmd
      spawnDelayMs: 500
    promptDedup:
      enabled: true           # 三段(身份/全局/工作区)跨段行级去重开关;默认 true = 开启(仅显式设为 false 时禁用)
    client:
      identityCharLimit: 4000 # volatile:以下 7 键都由浏览器半读取
      restartTimeoutMs: 90000
      restartPollMs: 1000
      restartFillMs: 600
      restartFailThreshold: 2
      restartSettleMs: 8000
      copyFeedbackMs: 1600
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `identity.maxText` | 8000 | 身份文本截断上限(字符,token 守卫)。UI 软上限为 `client.identityCharLimit`(4000,编辑区限制),**host 硬截断**为本值(8000)。 |
| `identity.sectionOrder` | 40 | 身份段在系统提示词中的顺序。**迁移**:显式固定 `identity.sectionOrder: 55` 的用户需改为 40 以保持「身份 → 全局 → 工作区」顺序。 |
| `globalPrompt.sectionOrder` | 50 | 全局提示词段的顺序。 |
| `globalPrompt.workspaceSectionOrder` | 60 | 工作区提示词段的顺序(置于最后)。 |
| `globalPrompt.maxFileBytes` | 262144 | 单个引用文件的字节上限;超限文件跳过(状态 `fail`)而不是阻塞组装。 |
| `globalPrompt.maxTotalBytes` | 1048576 | 单个段全部引用文件的合计字节预算。 |
| `autoResume.concurrency` | 3 | 启动恢复的最大在途 resume 数。 |
| `webRestart.scriptPath` | 推导 | 重启脚本路径。为空(默认)= Windows 推导 `<DSH_HOME>/autostart/dsh-web-restart.cmd`、macOS+Linux 推导 `…/dsh-web-restart.sh`,并在 POSIX 上额外启用**自重启**(无需脚本)。填路径=交给你自己的脚本:POSIX 下经 `/bin/sh` 执行,文件不存在时 `POST` 立即 500,不再让覆盖层空转。 |
| `webRestart.spawnDelayMs` | 500 | 202 缓冲后 spawn 重启脚本的延迟。 |
| `promptDedup.enabled` | true | 三段(身份/全局/工作区)系统提示词跨段行级去重开关(默认开启,仅显式设为 false 时禁用)。开启时,三段中出现过的**完全相同的非空原行**只保留"先出现"一份(全局 seen 贯穿三段),后出现段的重复行被去掉;**空行永远保留**(它是 markdown 的段落/列表分隔)。任何段独有内容一律保留。不解析 `{{name}}` 占位符、不破坏 markdown、不设 complete,绝不动 harness 自带段。 |
| `identity.default` / `identity.sessions` | 空 | **用户数据**(volatile):默认身份与每会话身份。设置页「会话身份」写入;也可直接写 profile patch。 |
| `globalPrompt.enabled` / `.content` / `.files` | off / 空 | **用户数据**(volatile):全局提示词开关、正文、引用文件列表。 |
| `workspacePrompt.workspaces` / `.removed` | 空 | **用户数据**(volatile):按工作区提示词与「已移除路径」。活跃工作区同步会把新出现的路径补进 `workspaces`(经 `ctx.get('settings').update`),`removed` 里的路径不会被补回。 |
| `autoResume.sessions` | 空 | **用户数据**(volatile):每会话「重启后自动上线」。false→true 立即恢复该会话。 |
下列 `client.*` 键由 host 校验;浏览器半经 `configForms.get('session-toolkit')` 读的就是这几个字段(表单不可用时回落 `client/client.js` 里的 `UI_FALLBACK`,值等于历史默认值)。设置页「插件」条目里可以直接改它们。

| 键 | 默认值 | 含义 |
|---|---|---|
| `client.identityCharLimit` | 4000 | 身份编辑区字符上限(UI 软上限;全局提示词编辑区同用)。 |
| `client.restartTimeoutMs` | 90000 | 重启覆盖层超时(之后提示手动刷新)。 |
| `client.restartPollMs` | 1000 | 重启健康轮询间隔(也是进度 tick)。 |
| `client.restartFillMs` | 600 | 检测到恢复后的进度填充动画时长。 |
| `client.restartFailThreshold` | 2 | 判定中断前的连续健康轮询失败次数。 |
| `client.restartSettleMs` | 8000 | 检测到恢复后、自动刷新前的稳定窗口(ms)。DSH 会话标题由 **LLM 异步生成**、无就绪信号,此值是"重启后首轮 reload 的等待窗口",用于改善标题 fallback(显示为工作区名)。若个别会话标题仍显示工作区名,可手动刷新或调大该键;根治需 DSH 提供"标题就绪"信号(建议向 DSH 反馈)。 |
| `client.copyFeedbackMs` | 1600 | 复制反馈对勾时长。 |

### 从旧 `settings.yaml` 迁移(0.1.6 → 0.1.7)

0.1.6 及更早,本插件的用户数据放在 `<DSH_HOME>/settings.yaml` 的命名空间里;0.1.7 的 harness 启动时会把该文件改名为 `settings.yaml.imported`,并**只**把「节名 == 某个存活条目 id」的节导入该条目——本插件的旧命名空间(`session-identity` 等)不匹配任何条目 id,因此它们被拒收、原样留在 `settings.yaml.imported` 里。

迁移映射(旧节 → 新 config 路径),一次搬完即可:

| 旧 `settings.yaml` 节 | 新 config 路径 |
|---|---|
| `session-identity.default` / `.sessions` | `identity.default` / `identity.sessions` |
| `global-prompt.{enabled,content,files}` | `globalPrompt.{enabled,content,files}` |
| `workspace-prompt.{workspaces,removed}` | `workspacePrompt.{workspaces,removed}` |
| `session-auto-resume.sessions` | `autoResume.sessions` |
| `session-toolkit-ui.*` | `client.*`(默认值相同,通常无需搬) |
| `workspace-registry-active`、`prompt-file-status` | **丢弃**:它们是运行时投影,现在由 `GET /api/session-toolkit/state` 提供 |

两种落地方式,选一种:

1. **设置页**:打开「插件」里 `dsh-session-toolkit` 条目的设置页,把旧值贴进对应字段(表单会写进 profile patch)。
2. **直接写 profile patch**(适合批量搬运):在 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 追加一个 `- id: session-toolkit` 条目,把上表右侧的路径放进 `config:`。写之前先用本插件自己的 `Config` 校验一遍即可避免形状错误:

   ```js
   import plugin from 'dsh-session-toolkit'   // 或直接 import 仓库的 lib/index.js
   plugin.Config(migratedConfig)              // 抛错即形状不对
   ```

---

## 部署

安装到任意 profile(bundle 层;单一来源,无副本):

```powershell
# 来自 npm
dsh plugin --profile web add dsh-session-toolkit

# 来自 GitHub
dsh plugin --profile web add github:Han-Yao94/dsh-session-toolkit

# 来自本地 checkout / tarball
dsh plugin --profile web add ./dsh-session-toolkit-<version>.tgz
```

包的 `dsh.bundle.patch`(`cordis.patch.yml`)将单一入口(`id: session-toolkit`,`name: 'dsh-session-toolkit'`)注册为 **bundle 层**——在 `dsh-base` / `dsh-web-app` 之后、profile patch 层之前应用(层序:bundles 依次 → profile patch → home patch → `--patch` 覆盖)。

卸载:`dsh plugin --profile web remove dsh-session-toolkit`。

### 本地开发

迭代源码时可安装 checkout(`dsh plugin --profile web add <源码路径>`,使用 pnpm `link:` 依赖),或手工 junction 到 profile 的 `node_modules` 并在 profile 的 `cordis.patch.yml` 显式 `- insert:` 注册。推荐使用官方 `dsh plugin add` 流程。

验证门(仅限源码 checkout 内运行——`scripts/` 不随发布包分发;无需构建步骤,也无需安装依赖):

```powershell
pnpm check    # 语法门 —— 对全部随包 JS 跑 node --check
pnpm verify   # 另加打包契约 —— 入口可达、import 声明完整、双语 README 版本一致
```

`pnpm verify` 断言「工作区内容 == 包内容」,因此一旦有人给 `package.json` 加上 `prepare`/`prepack`/`prepublishOnly` 脚本,它会**故意报错**。升级 harness 时使用的 DSH 集成点清单见 `docs/agents/integration-contracts.md`。

### 分享与安装

已发布至 **npm**(`dsh-session-toolkit`,**最新已发布版本 v0.1.8**,MIT)并同步至 **GitHub**(`github.com/Han-Yao94/dsh-session-toolkit`)。纯 JS 包——**无构建步骤、无 prepare 脚本**。`files` 已白名单 `lib/`、`client/`、`cordis.patch.yml` 与 README。

> **本仓库领先于已发布包。** npm 发布当前**处于暂停**,因此上文介绍的会话管理工具(`create_session` / `rename_session`)**尚未进入任何已发布版本**——今天从 npm 安装得到的是 0.1.8,其中不含这两个工具。要现在使用,请从本 checkout 或 GitHub 安装(`dsh plugin --profile web add github:Han-Yao94/dsh-session-toolkit`)。

- **npm**:消费者 `dsh plugin --profile web add dsh-session-toolkit` 安装;新版本通过 `npm publish`(或 `pnpm publish`)发布。
- **GitHub**:`dsh plugin --profile web add github:Han-Yao94/dsh-session-toolkit`。
- **tarball**:`pnpm pack` → `dsh plugin --profile web add ./dsh-session-toolkit-<version>.tgz`。

运行时依赖(`@deepseek-ai/schemastery`(下限 `^3.18.3`——`volatile()` 自该版本起才有)、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-home-paths`)声明在 `dependencies`,随安装自动拉取;平台模块(`react`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-primitives`)为 `peerDependencies`,由 DSH 宿主提供。harness 提供的包一律**只写一个前置版本代**——`^0.1.7-alpha.1`:caret 区间不跨 minor,而 semver 还额外要求"比较器里必须有一个指明**候选人自身 `major.minor.patch`** 的前置版本",这正是当初要写成 `^0.1.2-alpha.5 || ^0.1.6-alpha.2` 并集的原因,也正是 §F 偏斜的根因(插件拿到自己的旧副本、宿主在跑新版本)。既然 `dsh-v0.1.7-alpha.1` 已是最低支持版本,旧的并集成员已删除:**今后每次 harness 换代都必须同步抬高这些区间**,而 `node scripts/dependency-skew.measure.mjs --profile <DSH_HOME>/profiles/web`(期望 `SKEW_COUNT=0`)就是告诉你该抬了的那个检查。区间只在安装期生效——重新安装并重启 GUI 之后再量。`@deepseek-ai/dsh-client-ui-slots` 刻意不声明:`slots` 服务由 web shell 播种,npm peer 声明是死重。已验证:打包 tgz 的干净安装可完整解析所有 import(不依赖本地 junction)。另有两条**安装侧**工具(需要外部 checkout/profile,因此不挂 CI,见契约表 §D/§E/§F):

```bash
node scripts/dependency-skew.measure.mjs --profile <DSH_HOME>/profiles/web   # §F：期望 SKEW_COUNT=0
node scripts/dsh-log-ui.drift.mjs --harness <deepseek-harness 路径>          # §E：复刻件漂移
```

---

## 模型体验

### 系统提示词贡献

#### 模型看到的内容

每次组装贡献三个段,顺序:`session-identity`(order 40)→ `global-prompt`(order 50)→ `workspace-prompt`(order 60),位于部署 persona 之后、工具引导(100–199)之前。身份段在组装时按 agent(`AssembleContext.agent`)从 `session-identity` 设置解析,subagent(`origin`/`delegationDepth`)跳过。工作区段为 `cwd` 前缀匹配到配置工作区(取路径最深/最具体且启用者)的会话注入该工作区提示词,否则为空。

全局段与工作区段都会在提示词文本后追加其**引用文件内容**:每次组装读取 `files`(UTF-8,按 mtime/大小缓存),按原文拼接(段声明 `interpolate: false`,内容不被改写)。无法读取或超出字节预算的文件会**跳过**(其内容不注入),但其读取状态被记录供 UI 显示。空段在渲染时删除。

#### Token 影响

启用时三个段的文本随每次请求重复。全局提示词作用于所有会话;身份文本仅作用于能解析到它的会话(自身记录或默认);工作区文本仅作用于 `cwd` 前缀匹配到已启用且已配置工作区(取最具体)的会话。引用文件的完整内容会加入实际提示词,因此消耗额外 token——大引用文件会显著增加每次请求的 token 成本。身份文本上限 8000 字符(token 守卫)。

#### KV Cache 影响

设置不变时各段渲染文本是请求前缀的固定部分;修改会话身份或全局/工作区提示词(或编辑/新增引用文件)可能从首个变化 token 起使提供方缓存复用失效(与官方 persona 段语义一致)。

### 工具面

`send_to_session`、`list_sessions`、`create_session` 与 `rename_session` 在 host 平面注册,所有会话可见(subagent 经常驻 preset 组装继承)。参数与返回均为 JSON 兼容。**四个工具都会向模型暴露**,因此 `create_session` 的语义后果(创建即产生一条真实用户消息并消耗一次模型调用)对模型是可见的。

---

## 机制与红线

- **身份注入** 使用单一全局段、text 提供方按 agent 求值——无逐 agent 注册、无生命周期开销、设置变更实时生效。
- **frozen 配置铁律(红线)** —— volatile 字段 `ref.get()` 返回的是 **`deepFreeze` 快照(不可变)**。任何要改的地方必须先 **`{ ... }`(数组 `.slice()`)** 拷贝成可变对象再提交:host 半把整份新值交给 `ctx.get('settings').update(...)`,浏览器半把新值交给表单的 `set` / `mutate`(它们按 config 路径提交,不用整份替换)。直接改冻结对象会抛 `object is not extensible`(正是此处修复的「工作区列表空」根因)。同一 `{ ... }` 拷贝规则适用于 client 对 `workspacePrompt.workspaces` 的写入(`onWsFilesChange` / `save` / `saveWsEnabled` / `removeWorkspace`)。
- **引用文件读取、失败跳过** —— `readPromptFiles` 在每次组装的 `text()` 内运行(stat 判定是否重读);读取失败或超限的文件不会中断组装,其状态被记录进进程内投影供 `GET /api/session-toolkit/state` 与设置页显示,且只在内容变化时替换投影对象。
- **自动上线绝不调用 `dispose()`** —— `AgentHandle.dispose()` 会从存储移除会话;关闭开关只影响下次重启,绝不下线当前会话。
- **重启零 UAC 是构造性保证** —— spawn 继承服务器进程 token(SYSTEM 或用户),`taskkill` 目标是同权限进程,脚本提权分支(唯一 UAC 来源)不可达。若 3080 被其他程序占用,仍可能出现提权重试(重启脚本中有说明)。
- **遮蔽基于 cell shadowing** —— utilities 条目以更低 priority 重注册官方 `session-log-download` cell;遮蔽崩溃时官方条目优雅 abdicate 回退。
- **纯文本转换** —— `toPlainText`(10 条规则、代码围栏状态机、宽松匹配)仅在发送时执行;消息结构与 `source: { kind: 'user' }` 不变。

---

## 已知限制与暂缓事项

- client 半为手工维护的单文件 IIFE 包;新增功能需同步维护 `lib/` 与 `client/client.js` 两处。
- **client 半的「标识符作用域」没有任何门覆盖。** 调 `react.useState` 的块必须同时 `require('react')`：`react/jsx-runtime` **不提供**它，而缺绑定时组件渲染即抛错；**slot 渲染器会把那个抛错吞掉并丢掉整条 entry**，于是症状是「按钮静默地不见了」，而不是任何人看得见的报错。**这一形态从 2026-09-18（`3e44642` 加了 hooks 调用却没加 require）活到 2026-09-22**，穿过了全部的门。
- **收到的跨会话消息在界面上是「收起的一行」,不是可读的正文。** `send_to_session` 按**生产者归属**记录投递——`source: { kind: 'agent-message', form: 'relay', senderSessionId }`——而客户端对**所有**非人类来源都走它对 turn trigger 的渲染,那一行**默认收起,点开才见正文**。写成 `kind: 'user'` 会像人类消息一样 inline 展开,但会把**另一个 Agent 的话记成用户说的**——而那正是 V4 唯一规定为「生产者拥有」的字段。归属优先;**点那一行即可读到正文**(正文首行仍自带发件人)。
- **图标名属于集成面。** DSH 0.1.7 把 `@deepseek-ai/dsh-client-ui-primitives` 的图标从 `IconXxxOutline<尺寸>` 改名为 `IconXxxOutlineRegular` / `IconXxxOutlineMedium`(1 px 与 1.3 px 笔画;artwork 保留旧默认 `size`),因此 client 半必须使用**目标 harness** 的名字。不存在的名字求值为 `undefined`,而 `React.createElement(undefined, …)` 会抛错,导致**该组件子树整片空白、而它的导航行照常出现**(注册与渲染是两件事)。**这一形态对其余所有门都是静默的**——语法门、打包门、锚门当时全绿。用 `node scripts/primitives-export.assert.mjs --harness <checkout>` 守它:exit 1 会逐条列出插件引用了、而已装 harness 并未导出的成员。
- 平移的 Session log 入口依赖官方 `sessionLogDownload` controller 接口,且复刻官方 0.1.6 的「⋯ 更多操作」菜单形态;**它是冻结的复刻件**:DSH 升级后跑一次 `node scripts/dsh-log-ui.drift.mjs --harness <checkout>`——它按同一组锚点双向审计,漂移即非零退出(§E)。**有意的分叉**:官方 header 菜单此后多了第二项(`feedback`),本复刻件只保留 download;这是**已裁定的状态、不是待决问题**——门把它记成 note 而非失败,正因为"跟随上游新增能力"本身是一个决定,而该决定已于 2026-09-22 作出:**不跟随**。只有确实想要那个 feedback 入口时才需要重开。
- `toPlainText` 宽松斜体匹配可能误删非格式位置的成对 `*`(如 `a * b * c`);对 agent 生成消息可接受,边界收紧为可选优化。
- 聚合 `inject` 并集会等待所列全部服务;某 profile 缺一服务会拖慢整包 apply(web profile 当前齐备)。
- harness 提供的依赖区间是前置版本并集;改完区间必须重跑 `pnpm install`,并在装好的 profile 上跑 `node scripts/dependency-skew.measure.mjs --profile <DSH_HOME>/profiles/web`(期望 `SKEW_COUNT=0`;`DE-INSTANCE` 表示同版本不同实例,§F 判定为可接受)。
- `ctx.get('agentDefaultModel')`、`sessionTitle`、`workspaceRegistry` 改为调用时惰性解析,缺失时降级为 cwd/路径寻址;`tools` 与 `webServer` 改用 `ctx.inject` 等待就绪——loader 并发创建条目,apply 时刻的 `ctx.get` 没有顺序保证,晚到会让功能永久静默消失。
- **重启探测窗口** — 仅在健康探测连续失败 `restartFailThreshold × restartPollMs`(默认 2 × 1000 ms = 2 s)后恢复时判定为重启。若 relaunch 在该窗口内完成,覆盖层可能误报「未检测到重启」(`noRestart`);调低 `restartFailThreshold` 到 1 虽更灵敏,也会让单次瞬时失败被误判为重启中断。
- **引用文件在组装路径预热** —— `readPromptFiles` 每次组装对每个引用文件做一次 `statSync`,仅在 mtime/大小变化时读盘;单文件与合计字节预算避免超大文件阻塞组装或撑爆提示词,状态投影也只在变化时写入。client 端 `files` 即时保存(`onWsFilesChange` / `save`)。
- **UI 旋钮来自同一条目的 `client.*`** —— 浏览器半经 `configForms.get('session-toolkit')` 读 `client.*` 字段(表单不可用时回落冻结的 `UI_FALLBACK`)。client 条目本身仍拿不到 cordis 行配置,但设置的读取已不再需要 host 镜像:同一条目 Config 两侧都可见。
- **最低 harness 版本 = `dsh-v0.1.7-alpha.1`** —— settings 数据面在 0.1.7 改成「条目 Config 的 volatile 字段 + `configForms`」。0.1.6 及更早没有 `configForms`,客户端条目会停在 `pending`,web 客户端报「Failed to load plugins」;这是刻意的响亮失败(硬 inject),不是静默降级。

---

## 恢复方法

卸载 bundle:`dsh plugin --profile web remove dsh-session-toolkit`,然后重启 GUI。要回退到整合前的布局,请重新启用原插件而非安装本包。
