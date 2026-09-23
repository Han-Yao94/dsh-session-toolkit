# 集成点契约清单

**用途**：本插件把自身挂在 DSH 的若干内部集成点上；升级 DSH 时，「哪些点会断、断了表现为什么」必须有唯一真源。本文件就是那份真源。
**维护规则**：任何触及集成点的改动，必须同步本表（含 §0 的锚）；`QA Engineer` 的唯一产出载体就是本文件的补丁文本（由 `Tech Lead` 落盘）。
**基线**：`dsh-v0.1.7-alpha.1`（cordis `4.0.3`、schemastery `3.18.3`；2026-09-22 由迁移执行者对**已装 profile** 实测）。**最低支持版本即此版本**：settings 数据面在 0.1.7 改为「条目 Config 的 volatile 字段 + `ctx.configForms`」，0.1.6 及更早内核上客户端条目停在 pending。

> **旧基线不可复核（2026-09-10 核实）**：`@deepseek-ai/dsh-session@0.1.2-alpha.1` **从未发布**（registry 最早 `0.1.2-alpha.3`）。凡以「0.1.2-alpha.1 时点」为前提的断言都不可核；历史对照只能取 `0.1.2-alpha.3/.5`。**`package.json` 里写的 `^0.1.2-alpha.1` 下限是虚构的**——全部相关包最早只有 `0.1.2-alpha.2`（见 §F）。
> **版本范围**：「0.1.2 代…」类表述在本表中指 **`0.1.2-alpha.3` / `0.1.2-alpha.5`** 实测行为，**不含** `0.1.2-alpha.1`；本表的契约断言一律以**基线版本实测**为准，跨代兼容靠插件容错（如 `lib/auto-resume.js` 的 `normalizeEntry()`），**不构成契约**。

> **行号是本表最易腐的部分（2026-09-10 实测，两次静默失效）**：表中 harness 行号是 **0.1.5-alpha.1** 时点的定位提示；本仓库自身行号则会**随被引文件的任何一次编辑而静默失效**。
> ⚠️ **本表"仓库内行号"的时点 = 2026-09-22 那次提交**（v0.1.7 适配）。此前由 D 按 §D.3 抽样 15 条，**10 条已陈旧**（例：`require` 整组 `:41,798,799,…` 实际已移到 `:161,1106,1107,…`；`slots` 的 17 个陈旧行号纠正为 **14 个调用点**；「slot id 集合」的指针由 `README.zh.md:65-76`（那是"兼容性"散文，不是槽位表）纠正为 `:91-98`）。⇒ **这些数字只保证"在该提交那一刻对"**，此后照旧会腐；**判据永远是 §0 的内容锚，不是行号**。
> - 失效一：`lib/auto-resume.js` 因修复重写（裁定 #31）使本表 **6 个行号**全部位移，**无人报错**。
> - 失效二：`README.zh.md` 因插入 9 行验证门说明（Tech Writer，`L164`）使本表 **4 处引用**（`:203`/`:215`/`:217`/`:219`）全部 **+9**，**无人报错**。
> **结论**：**行号不得作为判据**，只用于首次跳转；**唯一判据是 §0 的内容锚**。且注意——**锚绿 ≠ 行号正确**：锚只能抓「被引文件变了」，**「文件没变而行号指向邻近但无关的行」（off-by-N）是已知不可机检类**，只能靠人工审阅发现。**不要因为锚全绿就认为表中行号是对的。**

**「off-by-N」为何不可机检（2026-09-10 由 `QA Engineer` 实测否证，勿重试）**：候选方案是「窗口内符号存在性」——取该引用行的标识符，若引用行 ±W 窗口内找不到就判「疑似陈旧」。实测（ground truth = **8 个已确认陈旧行号、共出现 9 次**）：

| W | 检出陈旧 | 误报「非陈旧」 |
|---|---|---|
| ±5 | 2/9 | 20/122 |
| ±10 | 0/9 | 16/122 |
| ±15 | 0/9 | 11/122 |
| ±25 | 0/9 | 1/122 |

**机制**：陈旧的本质是「内容整体移了 k 行」。要检出 k，窗口必须 **W < k**；但 W 一小，邻近无关行里的同名 token 立刻造成误报——**同一把尺子不可能既灵敏又不误报**。且「用表正文的 token 去判代码行」本身错位：W=±15 的误报集中在 `client/client.js:1884-1894` 的连续 11 行。**要机械化只能回到「作者为每行声明 token」，那正是裁定 #49 否掉的逐行锚方案。**

**限定条件（不要把上表读成「永久不可能」）**：该否证成立于**当前无基线提交**的状态。若将来 `lib/**`、`client/client.js`、`README*.md` 入库，位移可由 `git diff` 的行映射**精确求出**（旧内容在提交里，映射是确定的）——**因此这一层是「被未提交基线阻塞」，不是「本质上不可机械」**。该替代手段**尚未验证**，登记为候选，不得当作已成立的手段使用。

## 0. 内容锚（机器核，唯一判据）

被引文件的 SHA256 + 字节数。**任一不匹配 ⇒ 本表对应引用自动作废，必须逐行重核后重新落锚**（重核 = 按 §D.3 重新抽取 + 人工过一遍行号）。

| 被引文件 | SHA256（2026-09-22 重落锚：settings 数据面迁移到条目 Config） | 字节 |
|---|---|---|
| `lib/index.js` | `CAAC5D14A6AF201328C3FE054D89259CD3BF99FD5B58D3649C375A7F88A88FFA` | 5903 |
| `lib/identity.js` | `87522FC6863EE9E5FE6459906AE335AA09966E09891CC76323B3DAD5F7CF273E` | 2980 |
| `lib/global-prompt.js` | `F5ED7AFD8110932C3CE1063B5F8DC8FCFDA199C25A5428483360475582CF0487` | 14706 |
| `lib/auto-resume.js` | `8BC2376B9DEDCE352C7A4C7A7E35F46BF3FC7A11E33E9C4A7DE0BD9D828AE4CF` | 10648 |
| `lib/prompt-dedup.js` | `0590106A4333C5E8EB8F0D122211FD92C8660506D65244ABA9B5499E56FF2EB2` | 3055 |
| `lib/prompt-literal.js` | `8DFA38720ABE9DC93ED8D4ECC79E3B170452FE036724EBC16E51DBA14503721C` | 1871 |
| `lib/web-restart.js` | `48CA17C5C1A540DBE65AC218D7C17CFFB0E0BE4CBD0B1E5B6963C11846C7BDFC` | 9360 |
| `lib/request-guard.js` | `4BDF700894955A076CD1A95D8C1EB5D1FEB952C0EA78443A72639CCD3B32FCAE` | 9573 |
| `lib/peer-message.js` | `EBF60728A44BEF2314561C6DBC83C85859F2627D1E2E9C675F2756B468E0B80C` | 7257 |
| `lib/log-reposition.js` | `491282BF9C233C5449E96C3F203663B59B63A229AA22CEF48E5931E49CD0B03E` | 280 |
| `client/client.js` | `6A207C3A127E34F6834F38254F4975106DDBD1FD5B1B45B85FC5D1FA8DBB6E2A` | 136866 |
| `package.json` | `591249C13E46A622CDAD899FDFD99355D3615B4CD9EFBAAC6F1EE5F61A780088` | 1697 |
| `README.zh.md` | `E9F5F49B8CD61C36BA9A3E6509F1FC2ACD7B07DA2A4BAB69E952F4B51D448455` | 39923 |
| `cordis.patch.yml` | `9CB32E70D0C4C98255D83F7BF7D1D67F0B2803E88676B864D9FA84E4A4C2D826` | 285 |

**为什么锚这 13 个**：它们就是本表用行号引用的全部仓库内文件（2026-09-22 调整：删去已不存在的 `lib/ui-config.js`——设置通道迁移后该文件已删除；`lib/prompt-literal.js` 自 2026-09-18 起在表内）。**`README.md` 未锚**（本表只用行号引 `README.zh.md`；`README.md` 的一致性由 `pnpm verify` 的双语版本断言守）。**`docs/agents/**` 自身不锚**（本表是锚的**持有者**，自锚会自引用）。
**摩擦是刻意的**：任何一次对上述文件的合法改动都会让锚报红，迫使「改被引文件 ⇒ 重核本表」。`README.zh.md` 与 `package.json` 是高churn 项，报红最频繁属预期。
**已核、非缺口**：`lib/plaintext.js`、`lib/sanitize.js` 是仓库内的另外两个 `lib/` 文件，但它们**零 `ctx.`、零 `require`、零 `import`**（纯模块），不挂任何集成点，故不在本表内——**这是核过的结论，不是遗漏**。

## A. Host 契约

| 契约点 | 本仓库使用位置 | harness 真源 | 断裂症状 |
|---|---|---|---|
| **条目 Config 的 `volatile()` 字段 + `.get()`**（用户数据：身份、全局/工作区提示词、自动上线开关、`client.*`），提交后 `ctx.on('loader/volatile-update', …)` 通知，**不重挂插件** | `lib/identity.js`（`cfg.default/sessions`）、`lib/global-prompt.js`（`hostCfg.enabled/content/files`、`workspaceCfg.workspaces`）、`lib/auto-resume.js`（`cfg.sessions` + volatile-update 差分）、`lib/index.js`（Config 声明） | `vendor/schemastery`（`.volatile()` ≥3.18.3；`createVolatile`/`isVolatile` 经 `Symbol.for('cosmokit.volatile.write')` 跨副本识别）、`vendor/loader/src/config/entry.ts`（`_commitVolatile` → `fiber.ctx.emit(self, 'loader/volatile-update', paths)`） | 配置改动不生效（或直接抛 `volatile is not a function` / `object is not extensible`）；设置页空白 |
| **`ctx.get('configForms').get('session-toolkit')`**：浏览器半读写的就是同一条目 Config 的 volatile 字段 | `client/client.js`（`configForm` / `sectionOf` / `readUiCfg`） | `packages/client/ui-settings/src/client/config-form.ts`（`ConfigForms.get`/`ConfigForm.mutate`）、`packages/settings/settings/src/index.ts`（`describe`/`mutate` 的 volatile 路径校验与 `configEditor.edit`） | 设置页空白 / 写入被拒；UI 旋钮回落 `UI_FALLBACK` |
| `ctx.systemPrompt.section({ name, order, text, interpolate })` | `lib/identity.js:50`、`lib/global-prompt.js:232,250`（均带 `interpolate: false`）、`lib/prompt-literal.js:20`（旧内核兜底 waterfall） | `packages/core/system-prompt`（0.1.6 起 `PromptSection.interpolate`） | 提示词段消失或顺序错乱（身份→全局→工作区应为 40→50→60）；**旧内核缺兜底则 `{{...}}` 抛错、整轮组装失败** |
| `ctx.on('system-prompt/assemble', …, next)`（waterfall） | `lib/prompt-dedup.js:19`、`lib/prompt-literal.js:20` | `packages/core/system-prompt` | 提示词去重/按字面渲染静默失效（无报错，只有重复行或花括号被改写） |
| `ctx.agents.get(id)` / `ctx.agents.resume({ resumeSessionId, agentOptions, setup })` / `ctx.agents.roots()` | `lib/auto-resume.js:112,133`、`lib/global-prompt.js:31` | `dsh-agent/lib/types/index.d.ts:139`（`get` 返回裸 Agent）、`:287`（`resume`）、`:362`（`roots`）、`:110-129`（`ResumeAgentOptions`，形状未变） | 自动上线失效；工作区列表空（**历史根因**：见 `README.zh.md:297`「frozen 配置铁律（红线）」= `volatile` 的 `ref.get()` 返回 `deepFreeze` 快照） |
| **`ctx.sessionController.resolveAgent(id)`**（0.1.6 起）：官方恢复链路 = composeAgent（`installSelection` + mount preset）+ 归属校验 + 并发去重 | `lib/auto-resume.js:17`（`ctx.inject(['sessionController'], …)`）、`:117`（优先调用） | `packages/api/session-controller/src/index.ts:170`、`src/agent.ts:381`（composeAgent）、`:283`（selectionFor） | 手工 `ctx.agents.resume` 会丢掉会话自己的模型/effort 选择（重启后回落默认模型），并绕开后续官方在 resume 链上追加的步骤 |
| `ctx.on('session/created', …)` | `lib/global-prompt.js:286` | `packages/core/session` | 工作区回填不触发 |
| `ctx.effect(fn)`（生命周期绑定） | `lib/identity.js:50`、`lib/global-prompt.js:232,250`、`lib/web-restart.js:30` | `packages/core/scope` | 热重载重复注册 / 卸载残留 |
| `ctx.inject(['webServer'], cb)` → `webServer.register({ kind: 'exact', path, handler })` | `lib/web-restart.js:138`（`register` 在 `:142`） | `packages/host/webserver` | 重启路由 404，前端覆盖层超时；**apply 时刻一次性 `ctx.get` 会在服务晚到时静默失效**（loader 并发创建条目，无顺序保证） |
| 平台重启链路：Windows = `wscript.exe` + VBS + `.cmd`；POSIX（macOS/Linux）= 自定义 `.sh` 或**按当前 argv 自重启** | `lib/web-restart.js:17-19`（平台判定）、`:28`（`buildPosixRelaunchScript`）、`:61-62`（available/mode）、`:88`（precheck：脚本缺失/无法自重启 → 500）、`:97`（launch） | `packages/host/webserver`（路由）+ POSIX `/bin/sh` | macOS/Linux 上重启入口不可用或点击后空转到超时；自重启脚本落点/转义错误会让重启静默失败 |
| `ctx.inject(['tools'], cb)` + `defineTool({...})` + `tools.register(tool)` | `lib/peer-message.js:15`、`:51,123`（send）、`:125,140`（list） | `packages/core/tools`、`@deepseek-ai/dsh-tools` | `send_to_session` / `list_sessions` 从工具面消失 |
| **`ctx.inject(['sessionPersistence'], cb)`**（0.1.5 起改用注入；服务晚到会补跑，永不到则静默不执行） | `lib/auto-resume.js:174` | `cordis/lib/index.js:1599`（`inject` 定义）、`:1305-1343`（`_checkImpl`/`_setEpoch`/`_reload` 语义） | **启动恢复永不执行且无报错** |
| `list()` **返回 `SessionPersistenceSnapshot[]`**，header 在 `.header`（0.1.5 起；`0.1.2-alpha.5` 为 `SessionHeader[]`） | `lib/auto-resume.js:144,157`（`await persistence.list()` / `entries.filter(shouldResume)`） | `dsh-session-persistence/lib/types/index.d.ts:22-31`（快照类型）、`:155`（list 签名） | **启动恢复静默无动作**：`h.id` 为 `undefined` → 过滤结果恒空（2026-09-10 实测故障） |
| `SessionHeader` 字段集 = `version/id/createdAt/cwd?/parentSession?/isSeeded/origin?'subagent'/delegationDepth?/agentPreset?`；**无 `seedLength`**（`0.1.2-alpha.5` 起即如此） | `lib/auto-resume.js:60,66`（`shouldResume()` 读 `entry.header.*` 与 `entry.eventCount === 0`） | `dsh-session/lib/types/types.d.ts:58-95` | 空白会话过滤**恒不生效**（插件容忍缺失，无硬断裂） |
| `ctx.get('agentDefaultModel')` | `lib/auto-resume.js:9` | `packages/core/agent-default-model` | resume 缺少模型选择 |
| `ctx.get('sessionTitle')` / `ctx.get('workspaceRegistry')`（**调用时惰性读取**，0.1.9 起） | `lib/peer-message.js:27`（title）、`:78`（workspace） | `packages/session/session-title`、`packages/workspace/workspace` | 工具返回退化（标题/工作区名丢失） |
| `timer` 服务（`inject: ['timer']`） | `lib/web-restart.js:5`、`lib/global-prompt.js:5` | `packages/util/time` | 定时轮询不执行；apply 挂起 |
| ⭐ **本插件自注册路由的「来源守卫」**（Origin 比对 + Host fence + `sec-fetch-site`） | `lib/request-guard.js`（`isSameOriginRequest` 纯函数 / `originGuard` HTTP 薄层）；调用点 `lib/web-restart.js:150`、`lib/global-prompt.js:289`，**绑定字面量取自 `webServer.host`** | 与 harness 自己的 `packages/client/connection/src/api-request-trust.ts:91` `isTrustedApiRequest` **同构**（三道栅栏：Host fence · `sec-fetch-site !== 'cross-site'` · Origin 比对）；loopback 谓词口径对齐 `packages/client/connection/src/loopback-hostname.ts:12` | 两条路由用 `webServer.register()` 直注册，**绕过了覆盖整个 `/api/` 前缀的鉴权网关**（实测：**不存在的** `/api/xxx` ⇒ 401，而 `/api/restart`、`/api/session-toolkit/state` ⇒ 200）⇒ 浏览器里任意页面可发**简单请求**（无自定义头 ⇒ 无预检）：`POST /api/restart` 是**改状态**的 ⇒ **可被跨站触发重启**（中断/DoS，不丢数据）；state 只读、响应无 CORS 头 ⇒ 跨域能发、读不到 |
| ⭐ `webServer.host` 的取值域（守卫条件化的依据） | 传参处 `lib/web-restart.js:150`、`lib/global-prompt.js:289` | `packages/host/webserver/src/index.ts:61` —— `host: '127.0.0.1' \| '0.0.0.0'`（注释：*the two supported values are loopback and all-interfaces*） | 栅栏 A **只在绑定非 `0.0.0.0` 时施加**，故条件写作 **`bindHost !== ALL_INTERFACES_BIND`**、**不是** `=== '127.0.0.1'`：**契约变宽时守卫应变严而非变松**——等值写法在出现第三种绑定模式时会**整个跳过栅栏 A**（fail-open 且静默；2026-09-22 D 实测 `bindHost='10.0.0.1'` + rebinding 形态 ⇒ 放行） |
| ⭐ **V4 会话消息来源**：写进会话的每条消息都必须带**生产者归属**的 `source.kind` | `lib/peer-message.js:109`（`source: { kind: 'agent-message', form: 'relay', senderSessionId: String(caller.id) }`） | 准入规则 `packages/session/session-format-v3-to-v4/src/message-sources.ts:9`（**只拒绝 `kind === 'plugin'`**，其余非空字符串一律放行）；`agent-message` 的形状 `packages/subagent/subagent/src/continuation-messages.ts:16`（**恰好三键**）、校验 `packages/session/session-format-v2-to-v3/src/payload.ts:115-120`（`form` 必须 `'relay'`、`senderSessionId` 非空）；GUI 渲染 `packages/client/ui-chat/src/client/chat/turn-trigger.ts:35`（`message.trigger.agent`） | **整次发送被拒**（`format v4 message requires a producer-owned source kind`）。⚠️ 注意反向陷阱：写 `kind:'user'` **能通过准入**（不是 `'plugin'`），但把「另一个 Agent 发来的消息」记成「人类用户发的」——**V4 这次升级要消灭的正是这种失真**，所以判据是**语义正确**而不是"没报错"（2026-09-22 由 A 发现、B 落地） |
| `inject` 服务并集 | `lib/index.js:60-72` | 各 provider 包 | 缺一服务会**拖慢整包 apply**（`README.zh.md:246` 已知限制） |
| ⭐ `ctx.get('agentPresets')` → **`resolve(id?)` / `mount(ctx, id?)`**（G5 补行） | `lib/auto-resume.js:89,104`、`lib/session-admin.js:249,254,258` | `packages/preset/agent-preset-registry/src/index.ts:185`（`resolve`）、`:243`（`mount`） | **新建/恢复出来的会话不 mount preset ⇒ 它的工具、提示词段、skill 全部从"空全局层"解析**——而返回仍是 `ok:true`，即**一个"成功但残缺"的会话**。插件对两种情形分开处置：**服务缺失**=合法降级（带说明性 note）；**服务在但默认 preset 解析失败**=环境坏了（建会话之前就报 `PRESET_RESOLVE_FAILED`，不产生残缺会话） |
| ⭐ `ctx.get('sessionQuery').observeSession(sessionId)`（G5 补行） | `lib/auto-resume.js:94`（取 `observation.projections?.values.agentPreset ?? observation.header.agentPreset`） | `packages/session-query/session-query/src/index.ts:140`（另有 `observationSymbol.dispose()` 需释放） | 恢复时 **preset 取错**：`header.agentPreset` 只是**创建时**的值，会话可在 blank 期改 preset，真值在 projection 里 |
| ⭐ `ctx.agents.requireInitiator()`（G5 补行；**README 早已声明、表里却一直缺**） | `lib/peer-message.js:68`（`exec.agent === undefined` 时的兜底取发送方） | `packages/core/agent/src/index.ts:308` | 取不到发送方 ⇒ **`source.senderSessionId` 为空** ⇒ V4 直接拒绝该消息（见 §B 的 `agent-message` 一行） |
| ⭐ `ctx.get('sessions').get(id)`（G5 补行） | `lib/session-admin.js:291`（`rename` 需要 **live `Session` 对象**，不是 id） | `packages/core/session/src/index.ts:1209`（`get(id: SessionId): Session \| undefined`；同类另有 `create/prepare/enter/announce/list/fork`） | 改标题失败（回落 `agent.session` 也拿同一个 live 对象，两者皆缺时才报 `SESSION_UNAVAILABLE`） |
| ⭐ `ctx.get('settings').update(ns, patch, expectedRevision?)`（G5 补行） | `lib/global-prompt.js:145-148`（把发现的工作区写回本条目 config） | `packages/settings/settings/src/index.ts:347`——**逐键深合并**（`mergeLayers` 在 `:175`，会**递归进嵌套 plain object**） | 发现的新工作区不写回 config ⇒ 工作区列表永不更新；**「深合并」是"不会抹掉用户 `workspacePrompt.removed`"的前提**——若哪天改成 `replace`，用户手动移除过的路径会全部自己回来 |
| 引用文件读取上限（`maxFileBytes` / `maxTotalBytes`）+ 按 `mtimeMs`/size 缓存 + 投影不重建 | `lib/global-prompt.js`（`readPromptFiles`、`recordStatus`） | 本插件自身（`runtime.fileStatus` 是进程内投影，经 `GET /api/session-toolkit/state` 送出） | 每个模型步一次无谓重建/落盘 + 超大文件同步阻塞组装/撑爆提示词 |

**红线（改 host 必读）**：DSH 的 `scope.get()` 返回值被 `deepFreeze`。写入前必须先 `{ ... }` 拷贝（数组 `.slice()`），再 `update()`。这是「工作区列表空」的根因，见 `README.zh.md:297`「frozen 配置铁律（红线）」。

### A.1 残余限制与须并联读的判据（**不得只读上表就以为"已加固"**）

**残余限制四条**（守卫的射程之外）：

1. **绑定 `0.0.0.0` 时 DNS rebinding 仍未挡住** —— 那种部署下没有"名字"可判别，施加 loopback 限制会把局域网正当客户端一起拒掉。**本机绑定是 `127.0.0.1`（`lsof` 实测 `TCP 127.0.0.1:3080 (LISTEN)`）⇒ 在本部署下栅栏 A 生效、该洞已堵。**
2. **守卫只针对"浏览器里的第三方页面"** —— 能伪造 `Host`/`Origin` 的**非浏览器客户端本就不在射程内**（能伪造 Host 的也能伪造 Origin）。
3. **`0.0.0.0` 下若要用"允许的对外名字"白名单，需要 harness 先暴露 `trustedHosts`**（本插件读不到；harness 原文：*a non-loopback (0.0.0.0) deployment must declare the names it is reached by*）。
4. **任何非 `0.0.0.0` 的第三种绑定模式都会被施加 loopback 限制** ⇒ 该部署下局域网正当客户端会被拒。**这是有意的 fail-closed**：**偏严会被立刻发现，偏松不会**。
5. ⭐ **「无 `Origin` ⇒ 放行」不是无条件的，而且两种绑定模式下行为不同** —— 本条的准确形态（2026-09-22 由 D 实测、A 复核两模式后改写）：
   - **绑定非 `0.0.0.0`**（含缺省 fail-closed）：**以「有合法 `Host`」为前提** —— 栅栏 A 的 `no-host` 判定**在规则 3 之前**。实测 `req={}` / `{headers:{}}` / `host:''` **一律拒**（`reason: no-host`）；只有"带合法 `Host` 且无 `Origin`"才放行。
   - **绑定 `0.0.0.0`**：栅栏 A 不跑 ⇒ **规则 3（无 `Origin` 即放行）先返回，规则 4 的 `no-host` 够不着** ⇒ **无 `Host` 且无 `Origin` 也放行**。
   ⇒ **本表原先把这条写成了无条件的一句，是错的**：它只在非 `0.0.0.0` 下成立。⇒ 要测这条，**必须两种绑定模式都跑**。

**须与守卫一起读的判据三条**：

- **`sec-fetch-site` 不是 rebinding 的解药**：rebinding 的请求在浏览器看来是**同源**（发 `same-origin`）⇒ 该栅栏只是纵深防御。**`same-site` 必须放行**——它正是 rebinding 的形态，拒了会误伤本机正当访问，**只能靠栅栏 A 挡**。
- **将来会静默失效的点**：`isLoopbackHostname` 现额外宽容三条**当前不可达**的输入（大写 `LOCALHOST` / 带空白 `" localhost "` / 裸 `::1`）。**若有人改去判原始 `Host` 字符串，这三条立刻变成真实宽容。**
- **装置层面（本次安全复核留下，适用于本表任何"有负向对照"的门）**：
  ① **变异锚会随被测对象漂移而静默失效** ⇒ 靠装置内「**变异未生效即判失败**」兜住；
  ② **结构锚的代价**是条件被重写时失配，兜法同样是"未生效即失败"而不是静默跳过；
  ③ **一个对照要成立须同时满足三件事**：**变异真的改到了对象上** · **输入集真的能分辨这道防御** · **未被点名的用例保持原状**。三者缺一，**"它红/它绿"都不携带信息**。

## B. Client 契约

| 契约点 | 本仓库使用位置 | harness 真源 | 断裂症状 |
|---|---|---|---|
| `window.__ModuleLoader__.load({ id, factory })` | `client/client.js:1` | `packages/client/modules` | client 半完全不加载；无 UI 贡献 |
| ⭐ **`STATE_URL`（`/api/session-toolkit/state`）——同一个字符串在两侧各写一次**（G5 补行） | host 注册：`lib/global-prompt.js:283`（`webServer.register({ kind:'exact', path: STATE_ROUTE, handler })`）；client 轮询：`client/client.js:17` | 本插件自有路由（与 `/api/restart` 同机制）；`WebRoute` 契约在 `packages/host/webserver/src/index.ts:42-48`（`'exact' \| 'prefix'`、绝对路径无尾斜杠、`handler(req,res)`） | **改一边就静默断**：客户端 `fetch` 404 ⇒ 活跃工作区与引用文件状态**恒为空**（`stateStore` 只在无人订阅时停轮询，不报错）；G5 之前本表**没有这一行**，而 §D.3 的抽取命令**已经把它抽出来了** —— 抽出来却无处落地 |
| ⭐ **浏览器宿主面**（G5 补行，**只列与 shell DOM 结构或权限策略耦合的**：`navigator.clipboard.writeText` · 四处同形态的 CSS 注入 `document.getElementById` + `head.appendChild`） | `client/client.js`（复制按钮、`injectCss()` 的四处模块） | **不是 DSH 契约**：标准 Web API 不随 harness 漂移 ⇒ **刻意不列** `createElement` / `mousedown·mousemove·mouseup·resize` / `innerWidth` / `setTimeout`（列进去会把本表变成"Web 平台手册"，稀释真正会漂移的行；§E 自己写着"摩擦是刻意的"） | 剪贴板**权限失败会静默不复制**（无 toast 的话用户以为成功）；**shell DOM 结构变了则样式静默失效**（选择器还在、元素没了） |
| `ctx.get('slots')` → `slots.register(meta, render)` / `slots.inject(name, fn)`（低 priority 遮蔽） | `client/client.js:1040,1041,1060,1061,1803,1804,2135,2136,2317,2318,2327,2328,2422,2430,2483`（**2026-09-22 重抽 / 同年补第 15 个：侧栏菜单项**；旧值 17 个已整组陈旧，错位 +322~+335） | **由 web shell 以模块表种子提供**：`dsh-web-frontend/dist/assets/index-*.js` 内含 `"@deepseek-ai/dsh-client-ui-slots":<instance>`；`packages/client/ui-slots` 仍在 checkout，但**该 npm 包不在已装 profile 中** | 按钮/设置页整体消失；遮蔽失效则官方 Session log 按钮重现 |
| `ctx.get('configForms').get('session-toolkit')` → `{ getSnapshot()/.value/.status, subscribe, set(field, v), unset(field), mutate(ops, expectedRevision) }`；snapshot 形状与旧 scope 对齐(`status: 'loading'\|'ready'\|'unavailable'`、`value` 为对应 config 子树) | `client/client.js:1160,1889,2493`（三条 `inject` 数组含 `'configForms'`；读取/适配层在 `:10,11,16,29`；`sectionOf(form, ['identity'\|'autoResume'\|'globalPrompt'\|'workspacePrompt'])`） | `packages/client/ui-settings/src/client/config-form-types.ts`（`ConfigFormSnapshot`）、`schema.ts`（`isVolatilePath`） | 「设置服务不可用」——设置页整体空白；UI 旋钮回落兜底值 |
| `ctx.get('locale')` → `register(ns, { zh, en })` / `bind(ns)` | `client/client.js:1026,1033,1034,1787,1794,1795,2127,2132,2133,2314,2416,2419,2420`（**2026-09-22 重抽**） | `packages/client/locale` | UI 文案退回 key；中英切换失真 |
| `ctx.get('sessionLogDownload')` → controller `{ store, download(id), dismiss(id), dispose() }` | `client/client.js:2261,2334,2338,2341,2347`（**2026-09-22 重抽**）（配套 host 侧 `lib/log-reposition.js`） | `dsh-session-log-export/lib/types/client/index.d.ts:7`、`controller.d.ts:31-58`；**0.1.6 的官方 UI 已改为「⋯ 更多操作」菜单** | 平移后的 Session log 入口失效（`README.zh.md:310` 已声明风险；官方 UI 改版必须人工同步复刻件） |
| ⭐ **侧栏会话行「⋯」菜单项（扩展点）** | `client/client.js:2483`（`slots.inject('sidebar.workspaces.session.menu.item', …)` → `register({ name, id: 'dsh-session-toolkit.copy-session-id', order: 500 })`，渲染 `primitives.MenuItemButton`） | **平台声明的槽位**：`packages/client/ui-workspace/lib/types/client/contract/slots.d.ts:127`（契约体 `:128-137`：`kind:'list'` / `scope:'root'` / `hookContext: MenuOpenState`）；官方示例 `:113-124`（`id:'copy-session-id'`、`order:500`）；宿主把 `hookContext.menuOpenState` 按 `standardHookPropName`（`ui-slots/lib/index.js:7-9`，`use` + 首字母大写）转成渲染 prop `useMenuOpenState`；渲染点 `ui-workspace/lib/client.js:1702` | **槽位名写错不报错、只是什么都不发生**（与 `primitives.X` 缺名、与 `react` 缺绑定同族：**静默失效**）⇒ 改动时必须对着上面的声明核。**`id` 必须包名命名空间**：裸名会在另一 priority 上**遮蔽官方那一行** |
| ⚠️ 该菜单项渲染函数里的**条件式 hook 调用**（有意为之，改动前先读） | 同上（`client/client.js:2494` 一带） | React 的 Rules of Hooks | `useMenuOpenState` 的调用写在 `if (typeof hook === 'function')` 分支里 ⇒ **字面上违反 Rules of Hooks**。**这是有意为之**：本槽位的契约**保证**该 prop 存在，故分支每次渲染都相同（React 的顺序检查不会触发）；而**无条件调用**会在宿主不再提供它时**渲染期抛错 → 被 slot 错误边界吞掉 → 静默消失** —— 本插件已两次栽在那一形态上（图标改名致整页空白、`require('react')` 缺失致整块崩掉）。 |
| `ctx.effect(fn, label)` | `client/client.js:1033,1794,2132,2314,2419,2484`（**2026-09-22 重抽**；`:2379` = UI 旋钮订阅） | `packages/core/scope` | locale 重复注册 / UI 旋钮订阅泄漏 |
| 模块表种子词（`require` 目标） | `client/client.js:161,1170,1171,1898,1899,`**`2124-2127`**`,2299-2301`（**2026-09-22 重抽 + C 的 `react` 补 require 后平移**；`:2124-2127` 为**模块 4（log-reposition）**的 require 头（`:2124` 是 2026-09-22 补的 `var react = require('react')`），`:2299-2301` 为**模块 5（peer-message）**——**旧注把 `:2122-2124` 说成 peer-message 模块，是错的**；**已移除 schemastery 的 `try/catch` 导入**。旧值 `:41,798,799,…` 整组陈旧——`:41` 现在是 `function sub(value) {`） | `packages/client/modules` + `packages/client/tsdown.client.ts`（默认 externals） | 单个 `require` 抛错即该 UI 模块失效 |
| ⭐ **`@deepseek-ai/dsh-client-ui-primitives` 的「导出名面」**：插件引用的**每一个** `primitives.X` 必须真的在已装 harness 的导出里 | `client/client.js` 共 12 个成员：`Button` · `DisclosureRow` · `Menu` · `Modal` · `Pill` + 7 个图标 `IconArchiveOutlineRegular` · `IconCheckOutlineRegular` · `IconCopyOutlineRegular` · `IconDownloadOutlineRegular` · `IconEllipsisOutlineRegular` · `IconFolderOpenOutlineRegular` · `IconGlobeOutlineRegular` | `packages/client/ui-primitives/lib/index.js` 的 `export { … }`；**图标命名于 `4937343a5e`（2026-09-17, feat(web): unify the client visual language）由 `IconXxxOutline<尺寸数>` 改为 `IconXxxOutline{Regular\|Medium}`**（`ICON_REGULAR_STROKE = 1` / `ICON_MEDIUM_STROKE = 1.3`；Artwork 保留旧默认 size，故显式的 `size` 属性仍然有效） | ⚠️ **整片空白 = `React.createElement(undefined, …)` 抛错 ⇒ 该 section/组件子树渲染失败；而左侧导航行仍照常出现（注册与渲染是两件事）**。**2026-09-22 实测**：7 个旧名在 `apps/web/dist/assets/index-*.js`（606157 B）中**全部 0 命中**、7 个新名各 1 命中 ⇒ 浏览器里就是 `undefined`。此缺陷类是**静默**的（语法门、打包门、锚门全绿），**必须靠「导出名面」这一行守**：门见 `scripts/primitives-export.assert.mjs`（§D.9） |
| slot id 集合 | 见 `README.zh.md:91-98` 表（**2026-09-22 重抽**；旧值 `:65-76` 指的是「兼容性」散文，**不是槽位表**——槽位表在 `### 注册的 Slots` 之下） | `packages/client/ui-settings`、`ui-settings-general`、`ui-conversation` | 对应页面/按钮不出现 |

**模块表种子的真实 require 集合**（升级时逐个核）：`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-primitives`。**2026-09-18 起不再 require `@deepseek-ai/schemastery`**：client 条目拿不到 config，自带 `Config` 也无意义，UI 旋钮改走 `session-toolkit-ui` 命名空间（见 §A）。
`dsh.client.inject` 是**信息性**边（loading/prefetch 元数据，绝不参与 apply 排序，见 `packages/client/ui-workspace/src/client/index.ts:57`），**不是** npm 依赖声明——不要把它当依赖清单核。

**已登记的声明问题（2026-09-10；本段曾被 Tech Lead 写错，以下为更正后版本）**：`package.json` 的 `peerDependencies` 曾点名 3 个包——`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-slots`。
1. **更正**：旧版本段称这三者「不是 npm 可装的 peer」——**错**。三者都已在 registry 发布且匿名 `npm pack` 可下载。**错误来源**：Tech Lead 用 `npm view <pkg> version` 取版本，而该命令**只返回 `latest` 标签**（不是版本列表）；这三个包的 `latest` 指向受限的 `0.0.1-rc.1`，于是被误读为「不存在」。真实情况：`@deepseek-ai/dsh-client-store` 有 9 个版本（`latest` = `0.1.2-alpha.2`）；`@deepseek-ai/dsh-client-ui-primitives` 与 `@deepseek-ai/dsh-client-ui-slots` 各有 20 个版本，其中 **`0.1.2-alpha.5` 公开且满足 `^0.1.2-alpha.1`**。**取版本必须用 `npm view <pkg> versions --json`**（见 §D.6）。
2. **实际报错原因因此不同**：它们**不在已装 profile 中**——由 web shell 以模块表种子提供；而本 profile 为 `autoInstallPeers: false` ⇒ 产生**持续安装告警**；只有 `strict-peer-dependencies=true` 的环境才会升级为**安装失败**。
3. **本轮已落盘**（`package.json` 锚见 §0）：**只删 `@deepseek-ai/dsh-client-ui-slots`**——它是**死声明**，`client/client.js` **从未 require 它**（它只经 `ctx.get('slots')` 使用，而 slots 服务由 shell 种子提供）。**`store`/`primitives` 保留**：它们确实被 `client/client.js` 裸 `require`，删掉只是让它们**从「有声明」变成「无声明」**，不是更正确。
4. **未决（不属本轮，禁止顺手改）**：把 `store`/`primitives` 改声明为 `dsh.client.external`（harness 原生的「由 shell 提供」表述）可能比 `peerDependencies` 更贴切；但 **`external` 的消费语义尚未对 harness 源码核实**，属「猜着改」，与本轮修复分离，待单独裁定。

## C. 包元数据契约

| 契约点 | 位置 | harness 真源 | 断裂症状 |
|---|---|---|---|
| `dsh.bundle.patch` → `cordis.patch.yml`（bundle 层注册） | `package.json:42`、`cordis.patch.yml` | `dsh-app-boot/lib/types/profile.js:7-13,37`、`lib/index.js:851-853`。0.1.5 原文层序：各 bundle 按其 patch 列表在**空条目表**上依次叠加 → **profile 自身 patch**（`cordis.patch.yml`）→ 启动器层（`--patch` 与 flag 派生）。**未见与「home patch」对齐的第四个具名阶段**，旧措辞据此改写 | 插件不注册；`dsh plugin add` 后无任何效果 |
| `exports["./client"]` 必须存在（声明 `dsh.client` 时） | `package.json` | `dsh-client-modules/lib/index.js:655`（0.1.2 时为 `src/index.ts:767`） | boot 激活审计大声失败 |
| `dsh.client.platform` 必须是字符串；`dsh.client.{inject,external}` 必须是字符串数组 | `package.json` | `dsh-client-modules/lib/index.js:144`（platform）、`:49`（string array）、`:650`（仅审计 `platform==='web'`） | 声明被拒 / `client-modules` 抛错 |
| `main`、`exports["."]`、`files` 白名单 | `package.json` | npm 打包规则 | 干净安装后入口不可达 |

## D. 升级核对流程

1. 拉取目标 harness 版本，取 `docs/capability-seams.md`、`docs/tool-catalog.md`、`docs/subsystem/core.md`、`docs/module-graph.md` 四份目录文档的对应版本。
2. 按 A/B/C 三节逐行核：真源包是否存在、API 签名是否变化、返回契约是否变化。
3. 全仓库重新抽取一次集成点，与本表 diff（避免本表本身过期）：
   ```powershell
   # host：服务与生命周期
   rg -n "ctx\.get\('|ctx\.[a-zA-Z]+\.|settings\.register\(|systemPrompt\.section|defineTool\(|tools\.register\(" lib
   # client：槽位与 scope
   rg -n "slots\.(register|inject)\(|ctx\.get\('|configForms|locale\.(register|bind)\(|STATE_URL" client/client.js
   ```
4. 跑 `pnpm verify`（语法门 + 打包契约）。
5. 端到端：`dsh plugin --profile web add <本仓库路径>` → 重启 GUI → 逐条核 `README.zh.md` 承诺的功能。**POSIX 重启的验收**：`curl -s localhost:<端口>/api/restart` 应得到 `available:true` 且 `mode` 为 `posix-relaunch`（未配置脚本）或 `posix-script`；点「重启服务」后覆盖层应走完「中断 → 恢复 → 自动刷新」，且 `<DSH_HOME>/autostart/dsh-web-restart.log` 出现新进程输出。脚本缺失/无法自重启时点按钮应**立即**看到错误行（而不是 90 秒超时）。
6. **重落锚**：§0 中**任何已变动的文件**，逐行核完本表后重算其 SHA256 并改写 §0（**必须先核后锚**，不许先把锚改成新值把门刷绿）。**取版本的唯一正确命令**：`npm view <pkg> versions --json`（**不要**用 `npm view <pkg> version`，它只给 `latest`，会造出「包不存在」这类假结论，见 §B）。
7. **改依赖区间后必须重启 GUI 再实测偏斜**（§F）——区间不会热生效。量测一律用 `node scripts/dependency-skew.measure.mjs --profile <DSH_HOME>/profiles/web`（相对判据：插件侧 vs 宿主侧各自解析同一个包；期望 `SKEW_COUNT=0`）。该工具自带 `--selftest`（造一个不同版本的宿主树，断言必须判 SKEW）。
8. **官方 UI 复刻件的复核**（§E）：`node scripts/dsh-log-ui.drift.mjs --harness <deepseek-harness 路径>`，按同一组锚点审计官方侧与本插件侧；输出 `DRIFT` 即必须同步 `client/client.js` 的 log-reposition 模块。该工具自带 `--selftest`（变异副本必须报 DRIFT）。
9. ⭐ **导出名面核对**（§B 那一行的门，2026-09-22 新立——起因见下）：`node scripts/primitives-export.assert.mjs --harness <deepseek-harness 路径>`，核 `client/client.js` 引用的**每一个** `primitives.X` 都在已装 harness 的 `@deepseek-ai/dsh-client-ui-primitives` 导出里；缺任一即 **exit 1** 并列出缺哪几个。**自带 `--selftest`**（缺名必须报红）。
   **为什么新立**：harness `4937343a5e` 把图标名从 `IconXxxOutline<尺寸数>` 改成 `IconXxxOutline{Regular|Medium}`，**7 个旧名一夜之间全部消失**，而**语法门 / 打包门 / 锚门 / 全部契约门当时都是绿的**——本表原来的 `client` 侧行只覆盖了 `slots`/`configForms`/`locale`/`sessionLogDownload`，**没有一行覆盖「primitives 的导出名面」**。⇒ 它一路穿到人类所有者眼前，表现为**设置页整片空白**（`React.createElement(undefined, …)` 抛错；导航行仍在）。**这一行就是为了让同一形态下次在升级核对里被机械地挡住，而不是靠用户开页面发现。**
10. 上述两条工具都需要**外部输入**（已装 profile / harness checkout），因此**不挂 CI**——CI 只有插件仓库本身，挂上去只会得到「未完成验证（exit 3）」的假红。它们属于升级/发布前的人工验收步骤。
11. ⭐ **本插件自注册路由的「来源守卫」核对**（§A 那两行的门，2026-09-22 新立）：`node scripts/request-guard.assert.mjs`，**四节**——① **正向 49 条用例**（**两种绑定模式都跑到**；其中「缺 `Host`」必须**按绑定模式分开测**：`0.0.0.0 + 缺 Host + 缺 Origin ⇒ 放行(no-origin)` 与 `loopback/缺省 + 缺 Host + 缺 Origin ⇒ 拒(no-host)` 两格**合起来才是一组**，任一行单独抬成「无 `Host` 一律如何」都是错的 —— 这正是 §A.1 第 5 条那个越界的对照）；② **4 条结构断言**（含「谓词 `isLoopbackHostname` 只有 1 个调用点且落在栅栏 A 的块内」「栅栏 B 的注释写明它**不是** rebinding 的解药」）；③ **变异对照 7 条**（**仅 `--selftest` 跑**；含 `D1` = 谁把 `!== ALL_INTERFACES_BIND` 翻回等值判断即红）；④ **薄层**：把真 `originGuard` 挂到**临时 HTTP 服务器**（`127.0.0.1` 随机端口，**从不碰活端口**）核状态码。自带 `--selftest`、`--target <path>`（对副本做负向对照）、`--verbose`；退出码 **0/1/64**。
    **它带两条自保**（2026-09-22 那次安全复核的产物，**任何"有负向对照"的门都该有**）：① **变异未生效即判失败**（`replace` 没改到源码 ⇒ 报红，**不许静默跳过**）；② **未被点名的用例必须保持原状**（连带翻转**要么写清因果并登记、要么报红**——**能说清因果的是耦合，说不清的是故障**）。
    ⭐ **它不证什么**（写在正文与 `--help` 里）：**真实浏览器的跨域/rebinding 被拦仍是推断**（零浏览器自动化、无第二 origin、无可控 DNS）；薄层验的是「**服务器对给定请求头返回预期状态码**」。
    **与 §A.1 的关系**：本门把 §A.1 的**四条残余限制**各自变成可执行断言（尤其「`0.0.0.0` 下不施加 loopback 限制」= **局域网正当客户端必须放行**，那正是残余限制第 1 条的用例证据），并给第 5 条（无 `Origin` 的放行以合法 `Host` 为前提）留下用例。⇒ **改 `lib/request-guard.js` 而本门绿，才算改完。**
    **它不需要任何外部输入**（不依赖已装 profile 或 harness checkout）⇒ **与上面两条不同，它可以挂 CI**。
12. ⭐ **client 半「标识符作用域」核对**（2026-09-22 新立；起因是 `react` 缺绑定那一形态 —— 见下面"为什么新立"）：`node scripts/scope-identifiers.assert.mjs`，**三节**——① 切分 `client/client.js` 的各 IIFE 块；② **逐块**判定「块内用到、而**该块未绑定**的**模块别名**」；③ 变异对照（**仅 `--selftest`**）。`--target <path>`（对副本做负向对照）、`--help`，退出码 **0/1/64**。
    ⭐ **判据必须逐块做**：**"全文件声明过该别名"不算已绑定** —— 本项目的这个 bug 恰好是**跨块**的（全文件早有 4 处绑定：模块 1/2 的 `React`、模块 3 的 `react`，而**模块 4 是独立 IIFE，它的 `react` 必须自己 `require`**）。⇒ **写成"全文件抽一次"会漏掉它**。（D 用缺陷版 `c313af5^` 实测：逐块 ⇒ **恰在模块 4 报出 `react`（首个使用点 `:2203`）**；修复版 ⇒ **0 处**。A 独立复跑同一对）
    **内建三道自保**：① **切分命中数与基线不符即报红**（含"**一个块都没切出来**"——**那种情况不是"没有问题"**）；② **变异未生效即判失败**；③ **惰性改动（只改注释）必须不报红**。
    **覆盖边界（照实，写在门正文与 `--help`）**：**不覆盖"非 `require` 绑定的未声明标识符"**（那需要真正的作用域分析；人类所有者 2026-09-22 裁定**暂不宽做**）；**不证**"按钮在浏览器里渲染出来了"。
    **为什么进 `publish-npm.needs`**：它的红有**两种、都不可被合理驳回** —— ① 真有块用到未绑定别名（= 本次形态：**用户看到的是"按钮不见了"，而没有任何报错**）；② **切分失配**（门需维护）。**两者都只有"修它"一个动作** ⇒ 与 `request-guard` 同构，故同判（**与裁定 #53 不冲突**：`clamp-call` 是探测器，它的红在合法重构下可被讨论）。**不接的代价**：**这个形态在代码里活了 4 天、穿过了当时全部门、靠人打开控制台才发现。**
    **为什么新立（本条的门就是为它立的）**：`3e44642`（2026-09-18）给模块 4 加了 `react.useState`/`react.useEffect`，**却没给那个 IIFE 加 `require('react')`**（`react/jsx-runtime` **不提供** `react`）⇒ 渲染 `SessionLogDownloadHeaderAction` 时 `ReferenceError` ⇒ **slot 渲染器吞掉抛错、整条 entry 消失** ⇒ **症状是"按钮静默不见"**。**它穿过了语法门 / 打包门 / 锚门 / `primitives-export`**（后者只核 `primitives.X` 的成员是否存在）。2026-09-22 修（`c313af5`）。

## E. 已知脆弱点（我们依赖了官方内部接口）

| 脆弱点 | 位置 | 说明 |
|---|---|---|
| Session log 入口平移到依赖官方 `sessionLogDownload` controller 接口 | `client/client.js:1996`、`lib/log-reposition.js` | 官方改接口即失效，需同步 |
| **复刻件会随官方 UI 改版漂移**（0.1.6 官方已从胶囊按钮改为「⋯ 更多操作」菜单；2026-09-18 已同步，但仍是被动跟随） | `client/client.js:1919-1969`（组件）、`:1780-1790`（CSS/文案）；漂移探测见 `scripts/dsh-log-ui.drift.mjs`（§D 步骤 8） | 官方 UI 变更后本插件仍渲染旧形态；官方在同一 cell 新增菜单项时还会被遮蔽吞掉 |
| 遮蔽依赖 cell shadowing 语义（更低 priority 重注册） | `client/client.js:1979-1990` | 遮蔽崩溃时官方条目会优雅回退（abdicate），症状是「按钮重复出现」而非报错 |
| 重启探测窗口是启发式 | `client/client.js`（`uiCfg.restartFailThreshold`/`uiCfg.restartPollMs`） | relaunch 落在窗口内会误报 `noRestart`（`README.zh.md:315`「重启探测窗口」） |
| 标题就绪无信号，只能靠 `restartSettleMs` 等待 | `client/client.js` | 会话标题可能 fallback 为工作区名（`README.zh.md:189` = `client.restartSettleMs`） |
| UI 旋钮与全部用户数据依赖 `ctx.configForms` 表单（0.1.7 起取代 `session-toolkit-ui` 命名空间） | `client/client.js`（`configForm` / `sectionOf` / `readUiCfg` / `stateStore`）、`lib/index.js`（`.volatile()` 声明） | 表单不可用（旧内核 / 远端 memory 模式）时 UI 旋钮回落冻结兜底值；旧内核（<0.1.7）没有 `configForms`，客户端条目停在 pending、web boot 报 `Failed to load plugins`（响亮失败） |
| 旧内核缺 `interpolate` 字段时靠 `lib/prompt-literal.js` 兜底 | `lib/prompt-literal.js:20-30` | 兜底缺失 ⇒ 用户文本里的 `{{...}}` 触发未注册变量 → 该轮组装抛错（历史形态） |

## F. 依赖解析偏斜（2026-09-10 实测；**2026-09-18 已处理，待安装侧实测确认**）

**本轮的处置（2026-09-18）**

1. **根因确认**：插件侧之所以拿到更旧的副本，直接原因是声明区间 `^0.1.2-alpha.1` —— caret 不跨 minor，且 semver 的后置规则要求「比较器集中必须有一个比较器指明同一 `major.minor.patch` 的前置版本」，所以该区间**永远匹配不到 0.1.5/0.1.6**，解析器只能在 0.1.2 代里挑（实测 `0.1.2-rc.1` / `0.1.2-alpha.5`）。这不是 registry 缺版本，是**声明写错**。
2. **区间改为前置版本并集**（`package.json`，锚见 §0）：harness 提供的包一律写成
   `^0.1.2-alpha.5 || ^0.1.6-alpha.2`（`dsh-tools`、`dsh-home-paths`；客户端 `client-locale` / `client-store` / `client-ui-primitives` 用 `^0.1.2-alpha.2 || ^0.1.6-alpha.2`）。
   **为什么是这两条**：0.1.2-alpha.5 是本仓库 lockfile 里**确实解析过**的版本（registry 存在性有据），0.1.6-alpha.2 是 §0 基线版本；**没有**把 0.1.5 写进去是因为该线在 registry 上的存在性无法在本环境核实（`npm view` 需网络），写一个匹配不到任何已发布版本的区间会导致**安装直接失败**，比偏斜更糟。`@deepseek-ai/dsh-client-ui-slots` 的 peer 声明一并删除（`slots` 由 shell 播种，声明是死重，见 §B）。
3. **量测门**：`scripts/dependency-skew.measure.mjs`（用法见 §D 步骤 7）——相对判据、不写死期望版本，逐包比较插件侧与宿主侧的 realpath 与版本，输出 `SKEW_COUNT=`；`--selftest` 用临时造物证明「不同版本必判 SKEW、同版本不同实例不误报」。

**验收标准**（必须在**装好的 profile** 上跑，本仓库无法替代）：

```bash
node scripts/dependency-skew.measure.mjs --profile <DSH_HOME>/profiles/web
```

- 期望 `SKEW_COUNT=0`；`DE-INSTANCE`（同版本、不同实例，通常来自 pnpm peer 上下文不同）**不判失败**——插件对这两个包只用 `defineTool` / `dshHomePath`，同版本不同实例无观测差异。
- 若仍是 SKEW：先确认宿主版本是否落在上表并集内；若宿主是其它发行线（例如 0.1.5），需要**先确认该线在 registry 存在**，再把该线并入区间，然后**重启 GUI 重新量测**（区间只在安装期生效）。

**测法（相对判据）**：不写死期望版本，而是**让插件与其宿主各自解析同一个包，比对实际落点**——硬编码期望版本会把「基线已漂移」误报成「解析错」（已发生一次，勿重犯）。

**实测结果**（已装 profile `web`，harness `0.1.5-alpha.1`）：

| 包 | 插件侧解析到 | 宿主侧解析到 | 判定 |
|---|---|---|---|
| `@deepseek-ai/dsh-tools` | `0.1.2-rc.1`（`profiles/web/node_modules` 下的**嵌套副本**） | `0.1.5-alpha.1`（junction → `D:\deepseek-harness\packages\…`） | **SKEW** |
| `@deepseek-ai/dsh-home-paths` | `0.1.2-rc.1`（同上嵌套副本） | `0.1.5-alpha.1`（同上） | **SKEW** |
| `@deepseek-ai/dsh-client-locale` | 同一实例 | 同一实例 | SAME-INSTANCE |
| `@deepseek-ai/schemastery` | `3.18.2` | `3.18.2` | **同版本、不同实例**（独立已知项，非区间问题） |

`SKEW_COUNT=3`。**为什么尚未处理**：当前**实测良性**——插件只用到 `defineTool`（`dsh-tools`）与 `dshHomePath`（`dsh-home-paths`），两版行为一致。**这是结构性错误，但无观测症状**；故与行为修复**分离**，避免一次改两个变量导致无法归因。

**改动前必须知道的三件事**：
1. **共享解析岛**：lockfile 的 peer 上下文显示另有第三方插件（`@kenz1117/dsh-ui-usage-billing`、`@wxg-prc-cpg/browser-skill-dsh-plugin`）**同样**落到 `dsh-tools@0.1.2-rc.1`。⇒ **改本插件的区间不一定能挤掉嵌套副本**；验收必须**重启后实测**，不能推演。
2. **semver 前置版本规则**：`^0.1.2-alpha.1` **不**匹配 `0.1.5-alpha.1`；`>=0.1.2-alpha.1 <0.2.0` **同样不**匹配——比较器集中若没有任何一个比较器指明同一 `major.minor.patch` 的前置版本，前置版本一律不匹配。⇒ 「同时覆盖 0.1.2 代与 0.1.5」**必须**写成**并集**，例如 `^0.1.2-alpha.2 || ^0.1.5-alpha.1`。**不修这条就会写成"看起来能覆盖、实际不覆盖"**。
3. **声明下限 `^0.1.2-alpha.1` 是虚构的**（该版本从未发布，见文首旧基线注）；改成真实下限时**必须写明是刻意取舍**，不要把「从未存在的版本」留在声明里当既成事实。

## G. 修复窗口（2026-09-18，v0.1.9）

**性质**：对照 `dsh-v0.1.6-alpha.2` 的整体 review 后的第一轮修复。基线仍以 §A/§B 的 harness 真源为准；本节只登记「这一轮改了什么、哪些仍是已知缺口」。

| # | 修复 | 位置 | 触发的问题形态 |
|---|---|---|---|
| 1 | 去重不再吃掉空行（空行/纯空白行原样保留，只对非空行做行级去重） | `lib/prompt-dedup.js` | 默认开启的去重把第一段之后的**每一段空行**都删掉 → markdown 段落/列表分隔静默消失 |
| 2 | 三段自有提示词按字面渲染：注册带 `interpolate: false`；旧内核由 waterfall 兜底空格化 `{` 串 | `lib/identity.js`、`lib/global-prompt.js`、`lib/prompt-literal.js`、`lib/sanitize.js` | 此前用 `sanitize()` 无条件改写用户文本（`{{` 被空格化），JSON/代码/模板内容不可逆损坏 |
| 3 | 引用文件加单文件/合计字节上限 + `mtimeMs`/size 缓存；投影只在状态变化时写 | `lib/global-prompt.js`、`lib/index.js`（Config） | 每个模型步一次同步读盘 + 一次 `settings.yaml` 加锁原子写；超大文件阻塞事件循环并撑爆提示词 |
| 4 | 自动恢复优先走官方链路 `ctx.sessionController.resolveAgent` | `lib/auto-resume.js` | 手工 `ctx.agents.resume` 丢掉会话模型/effort 选择（重启后回落默认模型），并绕开归属校验与后续官方 resume 步骤 |
| 5 | 可选服务改用 `ctx.inject`（`tools` / `webServer`），`sessionTitle`/`workspaceRegistry` 改为调用时惰性读取 | `lib/peer-message.js`、`lib/web-restart.js` | loader 并发创建条目，apply 时刻 `ctx.get` 无顺序保证 → 工具/路由**永久静默消失** |
| 6 | UI 旋钮改走 `session-toolkit-ui` 命名空间（`config.client` 作为 base）——**0.1.7 起由本条替代**：全部用户数据与 `client.*` 改为条目 Config 的 `.volatile()` 字段，浏览器半经 `ctx.configForms.get('session-toolkit')` 读写 | 当时：`lib/ui-config.js`、`client/client.js`；现在：`lib/index.js`、`lib/identity.js`、`lib/global-prompt.js`、`lib/auto-resume.js`、`client/client.js` | client 条目无 config 通道、bundle 无 schemastery → 此前所有 `client.*` 配置键都是死键；0.1.7 的 harness 取消命名空间通道后，旧写法让设置面整体失效 |
| 7 | 重启链路明确 Windows 专有：`GET /api/restart` 回报 `available`，client 探测后隐藏入口，非 Windows `POST` 返回 501 | `lib/web-restart.js`、`client/client.js` | 非 Windows 平台入口照常显示，点一次后覆盖层空转 90s 才报「未检测到重启」 |
| 8 | Session log 复刻件对齐官方 0.1.6 形态（「⋯ 更多操作」菜单 + 本地化文案） | `client/client.js`（log-reposition 模块） | 复刻的是旧版胶囊按钮，与官方 UI 分叉；且硬编码英文标签 |
| 9 | 客户端订阅修复：`sessionId` 进依赖；工作区/全局页的订阅只在「本地未编辑」时接受外部变更；工作区列表改为「活跃投影 ∪ 已配置」（`inactive` 分支不再是死代码），Remove 有可见提示、重新启用会清 `removed` | `client/client.js` | 切会话后浮层/开关读到别的会话状态；autosave 落地回退正在输入的内容；Remove 看起来没生效 |
| 10 | 新增提示词管线契约门（含 2 条负向对照），CI 新 job + 发布依赖 | `scripts/prompt.contract.selftest.mjs`、`.github/workflows/npm-publish.yml` | 上述 1/2/3 此前没有任何自动化门 |
| 11 | auto-resume 契约门新增「官方链路优先」断言与灵敏度对照 | `scripts/auto-resume.contract.selftest.mjs` | 新分支此前无覆盖 |

### 第二批（同日，使用者逐项裁定后追加）

| # | 修复 | 位置 | 说明 |
|---|---|---|---|
| 12 | `link:` 依赖改回可发布的 **semver 前置版本并集**（`^0.1.2-alpha.5 \|\| ^0.1.6-alpha.2` 等），并同步 `pnpm-lock.yaml` 的 importer specifier | `package.json`、`pnpm-lock.yaml` | `link:` 形态 tgz 内无本地路径，发布即产不出可安装的包；lock 与 manifest 不一致也会让 `--frozen-lockfile` 失败 |
| 13 | §F 依赖偏斜处置：根因是 caret 不跨 minor + 前置版本规则，区间已改；新增相对判据量测门 `scripts/dependency-skew.measure.mjs`（含 `--selftest`） | `package.json`、`scripts/dependency-skew.measure.mjs`、§F | 安装侧验收：`--profile <DSH_HOME>/profiles/web` 期望 `SKEW_COUNT=0` |
| 14 | **macOS/Linux 服务重启可用**：无配置时按当前 argv 自重启（生成一次性 `/bin/sh`：SIGTERM→等 10s→SIGKILL→`cd` 原 CWD→`exec` 原命令，输出进 `dsh-web-restart.log`）；配置 `webRestart.scriptPath` 则交给用户脚本；`GET` 回报 `available`/`mode`/`platform`，脚本缺失或无法自重启时 `POST` **500 快速失败** | `lib/web-restart.js`、`client/client.js`、两份 README | 之前非 Windows 平台入口形同虚设；现在 client 只在 **202** 进覆盖层，其余状态就地报错 |
| 15 | Session log 复刻件增加**双向漂移探测器** `scripts/dsh-log-ui.drift.mjs`（官方侧 7 条 + 插件侧 6 条锚点，`--selftest` 证明能报红） | `scripts/dsh-log-ui.drift.mjs`、§D 步骤 8、§E | 复刻件无法消除（插件不能 import 其它插件组件），因此把「静默过期」变成「升级时点名报错」 |

**本轮明确未做（保持与行为修复分离，逐条都有理由）**：

1. **不把 `dsh-tools` / `dsh-home-paths` 改成 peerDependency**：peer 只在 `autoInstallPeers:false` 的宿主里才等价于「用宿主那份」，而在 pnpm isolated 布局下能否解析到宿主实例取决于宿主 manifest 是否直接声明该包，**本环境无法验证**；改错会让插件在 import 期直接崩（拖垮整个 host 半，包括设置页）。区间并集先把「必然解析错版本」消掉，是否进一步改成 peer/external 留待装好的 profile 实测后再定（§B 已登记的同类未决项）。
2. **未把 0.1.5 发行线写进区间**：该线在 registry 的存在性无法离线核实，写进去有「安装直接失败」的风险，高于偏斜本身。
3. 两个安装侧工具（§D 步骤 7/8）**不挂 CI**：CI 只有插件仓库，没有已装 profile 与 harness checkout，挂上去只会得到 exit 3 的假红。
4. Session log 仍是**复刻件**（不是复用官方组件）：受限于插件无法 import 其它插件组件；本轮把它与官方 0.1.6 形态对齐，并加了漂移门。
