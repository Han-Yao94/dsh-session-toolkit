# 集成点契约清单

**用途**：本插件把自身挂在 DSH 的若干内部集成点上；升级 DSH 时，「哪些点会断、断了表现为什么」必须有唯一真源。本文件就是那份真源。
**维护规则**：任何触及集成点的改动，必须同步本表（含 §0 的锚）；`QA Engineer` 的唯一产出载体就是本文件的补丁文本（由 `Tech Lead` 落盘）。
**基线**：`dsh-v0.1.5-alpha.1`（cordis `4.0.2`、schemastery `3.18.2`；2026-09-10 由 `QA Engineer` 对**已装 profile** 实测）。

> **旧基线不可复核（2026-09-10 核实）**：`@deepseek-ai/dsh-session@0.1.2-alpha.1` **从未发布**（registry 最早 `0.1.2-alpha.3`）。凡以「0.1.2-alpha.1 时点」为前提的断言都不可核；历史对照只能取 `0.1.2-alpha.3/.5`。**`package.json` 里写的 `^0.1.2-alpha.1` 下限是虚构的**——全部相关包最早只有 `0.1.2-alpha.2`（见 §F）。
> **版本范围**：「0.1.2 代…」类表述在本表中指 **`0.1.2-alpha.3` / `0.1.2-alpha.5`** 实测行为，**不含** `0.1.2-alpha.1`；本表的契约断言一律以**基线版本实测**为准，跨代兼容靠插件容错（如 `lib/auto-resume.js` 的 `normalizeEntry()`），**不构成契约**。

> **行号是本表最易腐的部分（2026-09-10 实测，两次静默失效）**：表中 harness 行号是 **0.1.5-alpha.1** 时点的定位提示；本仓库自身行号则会**随被引文件的任何一次编辑而静默失效**。
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

**机制**：陈旧的本质是「内容整体移了 k 行」。要检出 k，窗口必须 **W < k**；但 W 一小，邻近无关行里的同名 token 立刻造成误报——**同一把尺子不可能既灵敏又不误报**。且「用表正文的 token 去判代码行」本身错位：W=±15 的误报集中在 `client/client.js:1820-1830` 的连续 11 行。**要机械化只能回到「作者为每行声明 token」，那正是裁定 #49 否掉的逐行锚方案。**

**限定条件（不要把上表读成「永久不可能」）**：该否证成立于**当前无基线提交**的状态。若将来 `lib/**`、`client/client.js`、`README*.md` 入库，位移可由 `git diff` 的行映射**精确求出**（旧内容在提交里，映射是确定的）——**因此这一层是「被未提交基线阻塞」，不是「本质上不可机械」**。该替代手段**尚未验证**，登记为候选，不得当作已成立的手段使用。

## 0. 内容锚（机器核，唯一判据）

被引文件的 SHA256 + 字节数。**任一不匹配 ⇒ 本表对应引用自动作废，必须逐行重核后重新落锚**（重核 = 按 §D.3 重新抽取 + 人工过一遍行号）。

| 被引文件 | SHA256（2026-09-11 重落锚） | 字节 |
|---|---|---|
| `lib/index.js` | `417A0E7EBD50736DC84CF965A2CF97DD3E21B7494C2D42D68C8AED1C624EE6F3` | 3629 |
| `lib/identity.js` | `BB9AF687BAC5592462A3B7E0CBFA31049C155F5D679060B18D1B59ECAF4E04FD` | 2726 |
| `lib/global-prompt.js` | `CB52396F9F9A76C011435FC1E1642D0AE6120CC8DB45E90DACB928FE315550F7` | 10324 |
| `lib/auto-resume.js` | `1A08121075517CEF34C05075D174409330C94AD332848358EE339DE7FCB821D5` | 9307 |
| `lib/prompt-dedup.js` | `6D97DED1B7A7C043C74F4F3D5DAE7F9EDD765EC51E98050757FFE79A5224C481` | 2681 |
| `lib/web-restart.js` | `46BED0C1760FBEB92CAFB8270B3234CFC8C46D60DC934F32114017920DE75E26` | 4625 |
| `lib/peer-message.js` | `861E7BCDE1197D098E14784DB7C531DE04337A3286A35F3DCE0B006F1E08D9D1` | 5959 |
| `lib/log-reposition.js` | `491282BF9C233C5449E96C3F203663B59B63A229AA22CEF48E5931E49CD0B03E` | 280 |
| `client/client.js` | `3BBB8F1E2367F74930535C1C0C203CB30F53B618221B35BF91BB848414E70FBA` | 109500 |
| `package.json` | `092EFBD98BDADDDAF913DE6266A08D1885855A3F8D8AD7BF44609547CD508E66` | 1611 |
| `README.zh.md` | `57FDA23F73BF712ADE5DA598145FC250AF8C55E4CFAC8BE2ABE68CA4BAE2F88C` | 22944 |
| `cordis.patch.yml` | `9CB32E70D0C4C98255D83F7BF7D1D67F0B2803E88676B864D9FA84E4A4C2D826` | 285 |

**为什么锚这 12 个**：它们就是本表用行号引用的全部仓库内文件。**`README.md` 未锚**（本表只用行号引 `README.zh.md`；`README.md` 的一致性由 `pnpm verify` 的双语版本断言守）。**`docs/agents/**` 自身不锚**（本表是锚的**持有者**，自锚会自引用）。
**摩擦是刻意的**：任何一次对上述文件的合法改动都会让锚报红，迫使「改被引文件 ⇒ 重核本表」。`README.zh.md` 与 `package.json` 是高churn 项，报红最频繁属预期。
**已核、非缺口**：`lib/plaintext.js`、`lib/sanitize.js` 是仓库内的另外两个 `lib/` 文件，但它们**零 `ctx.`、零 `require`、零 `import`**（纯模块），不挂任何集成点，故不在本表内——**这是核过的结论，不是遗漏**。

## A. Host 契约

| 契约点 | 本仓库使用位置 | harness 真源 | 断裂症状 |
|---|---|---|---|
| `ctx.settings.register(ns, schema, { applies: 'live' })` → scope `{ get / watch / update / replace }`（**无 `set`**；`get()` 返回 deepFreeze 值） | `lib/identity.js:10`、`lib/global-prompt.js:127,134,144,152`、`lib/auto-resume.js:10` | `dsh-settings/lib/types/index.d.ts:216`（register）、`:84-110`（scope 方法集，确无 `set`）、`:21`（`SettingsApply = 'live' \| 'restart'`） | 设置页空白 / `Settings service unavailable`；或写回抛 `object is not extensible` |
| `ctx.systemPrompt.section({ name, order, text })` | `lib/identity.js:51`、`lib/global-prompt.js:157,172` | `packages/core/system-prompt` | 提示词段消失或顺序错乱（身份→全局→工作区应为 40→50→60） |
| `ctx.on('system-prompt/assemble', …, next)`（waterfall） | `lib/prompt-dedup.js:19` | `packages/core/system-prompt` | 提示词去重静默失效（无报错，只有重复行回归） |
| `ctx.agents.get(id)` / `ctx.agents.resume({ resumeSessionId, agentOptions })` / `ctx.agents.roots()` | `lib/auto-resume.js:66,79`、`lib/global-prompt.js` | `dsh-agent/lib/types/index.d.ts:139`（`get` 返回裸 Agent）、`:287`（`resume`）、`:362`（`roots`）、`:110-129`（`ResumeAgentOptions`，形状未变） | 自动上线失效；工作区列表空（**历史根因**：见 `README.zh.md:212` 冻结设置铁律） |
| `ctx.on('session/created', …)` | `lib/global-prompt.js:208` | `packages/core/session` | 工作区回填不触发 |
| `ctx.effect(fn)`（生命周期绑定） | `lib/identity.js:51`、`lib/global-prompt.js:157,172`、`lib/web-restart.js:24` | `packages/core/scope` | 热重载重复注册 / 卸载残留 |
| `ctx.get('webServer').register({ kind: 'exact', path, handler })` | `lib/web-restart.js:13,24` | `packages/host/webserver` | 重启路由 404，前端覆盖层超时 |
| `ctx.get('tools')` + `defineTool({...})` + `tools.register(tool)` | `lib/peer-message.js:13,42,111,113,128` | `packages/core/tools`、`@deepseek-ai/dsh-tools` | `send_to_session` / `list_sessions` 从工具面消失 |
| **`ctx.inject(['sessionPersistence'], cb)`**（0.1.5 起改用注入；服务晚到会补跑，永不到则静默不执行） | `lib/auto-resume.js:120`（`childCtx.get` 在 `:121`） | `cordis/lib/index.js:1599`（`inject` 定义）、`:1305-1343`（`_checkImpl`/`_setEpoch`/`_reload` 语义） | **启动恢复永不执行且无报错** |
| `list()` **返回 `SessionPersistenceSnapshot[]`**，header 在 `.header`（0.1.5 起；`0.1.2-alpha.5` 为 `SessionHeader[]`） | `lib/auto-resume.js:90,103`（`await persistence.list()` / `entries.filter(shouldResume)`） | `dsh-session-persistence/lib/types/index.d.ts:22-31`（快照类型）、`:155`（list 签名） | **启动恢复静默无动作**：`h.id` 为 `undefined` → 过滤结果恒空（2026-09-10 实测故障） |
| `SessionHeader` 字段集 = `version/id/createdAt/cwd?/parentSession?/isSeeded/origin?'subagent'/delegationDepth?/agentPreset?`；**无 `seedLength`**（`0.1.2-alpha.5` 起即如此） | `lib/auto-resume.js:44,50`（`shouldResume()` 读 `entry.header.*` 与 `entry.eventCount === 0`） | `dsh-session/lib/types/types.d.ts:58-95` | 空白会话过滤**恒不生效**（插件容忍缺失，无硬断裂） |
| `ctx.get('agentDefaultModel')` | `lib/auto-resume.js:9` | `packages/core/agent-default-model` | resume 缺少模型选择 |
| `ctx.get('sessionTitle')` / `ctx.get('workspaceRegistry')` | `lib/peer-message.js:15,16` | `packages/session/session-title`、`packages/workspace/workspace` | 工具返回退化（标题/工作区名丢失） |
| `timer` 服务（`inject: ['timer']`） | `lib/web-restart.js:5`、`lib/global-prompt.js:5` | `packages/util/time` | 定时轮询不执行；apply 挂起 |
| `inject` 服务并集 | `lib/index.js:52-60` | 各 provider 包 | 缺一服务会**拖慢整包 apply**（`README.zh.md:226` 已知限制） |

**红线（改 host 必读）**：DSH 的 `scope.get()` 返回值被 `deepFreeze`。写入前必须先 `{ ... }` 拷贝（数组 `.slice()`），再 `update()`。这是「工作区列表空」的根因，见 `README.zh.md:212`。

## B. Client 契约

| 契约点 | 本仓库使用位置 | harness 真源 | 断裂症状 |
|---|---|---|---|
| `window.__ModuleLoader__.load({ id, factory })` | `client/client.js:1` | `packages/client/modules` | client 半完全不加载；无 UI 贡献 |
| `ctx.get('slots')` → `slots.register(meta, render)` / `slots.inject(name, fn)`（低 priority 遮蔽） | `client/client.js:639,653,673,1341,1358,1652,1659,1814,1815,1824,1825,1920,1928` | **由 web shell 以模块表种子提供**：`dsh-web-frontend/dist/assets/index-*.js` 内含 `"@deepseek-ai/dsh-client-ui-slots":<instance>`；`packages/client/ui-slots` 仍在 checkout，但**该 npm 包不在已装 profile 中** | 按钮/设置页整体消失；遮蔽失效则官方 Session log 按钮重现 |
| `ctx.get('settingsScope').bind({ namespace })` → `{ getSnapshot(); subscribe(); set(field, v); unset(field); mutate(ops, expectedRevision?) }`；snapshot = `{ status:'loading'\|'ready'\|'unavailable', value, base, user, revision, writable, mode }` | `client/client.js:649,652,1351,1353,1355,1357` | `dsh-client-ui-settings/lib/types/client/settings-contract.d.ts:34-85`、`settings-scope.d.ts:139`（`bind`） | 「Settings service unavailable」——这正是 `dsh.client.inject` 必须点名 `@deepseek-ai/dsh-client-ui-settings` 的原因 |
| `ctx.get('locale')` → `register(ns, { zh, en })` / `bind(ns)` | `client/client.js:638,645,646,1340,1347,1348,1651,1656,1657,1811,1914,1917,1918` | `packages/client/locale` | UI 文案退回 key；中英切换失真 |
| `ctx.get('sessionLogDownload')` → controller `{ store, download(id), dismiss(id), dispose() }` | `client/client.js:1831,1844`（配套 host 侧 `lib/log-reposition.js`） | `dsh-session-log-export/lib/types/client/index.d.ts:7`、`controller.d.ts:31-58` | 平移后的 Session log 按钮失效（`README.zh.md:224` 已声明风险） |
| `ctx.effect(fn, label)` | `client/client.js:645,1347,1656,1811,1917` | `packages/core/scope` | locale 重复注册 |
| 模块表种子词（`require` 目标） | `client/client.js:11,27,783,784,1452,1453,1709-1711,1860-1862` | `packages/client/modules` + `packages/client/tsdown.client.ts`（默认 externals） | 单个 `require` 抛错即该 UI 模块失效 |
| slot id 集合 | 见 `README.zh.md:62-71` 表 | `packages/client/ui-settings`、`ui-settings-general`、`ui-conversation` | 对应页面/按钮不出现 |

**模块表种子的真实 require 集合**（升级时逐个核）：`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/schemastery`（后者在 `try/catch` 内，允许缺失）。
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
   rg -n "slots\.(register|inject)\(|ctx\.get\('|settingsScope\.bind\(|locale\.(register|bind)\(" client/client.js
   ```
4. 跑 `pnpm verify`（语法门 + 打包契约）。
5. 端到端：`dsh plugin --profile web add <本仓库路径>` → 重启 GUI → 逐条核 `README.zh.md` 承诺的功能。
6. **重落锚**：§0 中**任何已变动的文件**，逐行核完本表后重算其 SHA256 并改写 §0（**必须先核后锚**，不许先把锚改成新值把门刷绿）。**取版本的唯一正确命令**：`npm view <pkg> versions --json`（**不要**用 `npm view <pkg> version`，它只给 `latest`，会造出「包不存在」这类假结论，见 §B）。
7. **改依赖区间后必须重启 GUI 再实测偏斜**（§F）——区间不会热生效。

## E. 已知脆弱点（我们依赖了官方内部接口）

| 脆弱点 | 位置 | 说明 |
|---|---|---|
| Session log 按钮平移到依赖官方 `sessionLogDownload` controller 接口 | `client/client.js:1831`、`lib/log-reposition.js` | 官方改接口即失效，需同步 |
| 遮蔽依赖 cell shadowing 语义（更低 priority 重注册） | `client/client.js:1814-1830` | 遮蔽崩溃时官方条目会优雅回退（abdicate），症状是「按钮重复出现」而非报错 |
| 重启探测窗口是启发式 | `client/client.js`（`restartFailThreshold`/`restartPollMs`） | relaunch 落在窗口内会误报 `noRestart`（`README.zh.md:228`） |
| 标题就绪无信号，只能靠 `restartSettleMs` 等待 | `client/client.js` | 会话标题可能 fallback 为工作区名（`README.zh.md:136`） |
| client 侧 schema 依赖 schemastery 在模块表可用 | `client/client.js:11-21` | 不可用时优雅降级（不导出 `Config`），host 侧仍校验 |

## F. 依赖解析偏斜（2026-09-10 实测；**已登记，尚未处理**）

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
