# 集成点契约清单

**用途**：本插件把自身挂在 DSH 的若干内部集成点上；升级 DSH 时，「哪些点会断、断了表现为什么」必须有唯一真源。本文件就是那份真源。
**维护规则**：任何触及集成点的改动，必须同步本表（含 §0 的锚）；`QA Engineer` 的唯一产出载体就是本文件的补丁文本（由 `Tech Lead` 落盘）。
**基线**：`dsh-v0.2.0-rc.1`（cordis `4.0.4`、schemastery `3.18.4`；人类所有者裁定「全切 rc1」后，由执行者对本仓已装 `node_modules` 与 `~/.dsh/profiles/web` 实测；此前基线为 `dsh-v0.1.7-alpha.1`（cordis `4.0.3`、schemastery `3.18.3`），2026-09-22 实测）。**最低支持版本即此版本**：settings 数据面在 0.1.7 改为「条目 Config 的 volatile 字段 + `ctx.configForms`」，0.1.6 及更早内核上客户端条目停在 pending。

> **旧基线不可复核（2026-09-10 核实）**：`@deepseek-ai/dsh-session@0.1.2-alpha.1` **从未发布**（registry 最早 `0.1.2-alpha.3`）。凡以「0.1.2-alpha.1 时点」为前提的断言都不可核；历史对照只能取 `0.1.2-alpha.3/.5`。**`package.json` 里写的 `^0.1.2-alpha.1` 下限是虚构的**——全部相关包最早只有 `0.1.2-alpha.2`（见 §F）。
> **版本范围**：「0.1.2 代…」类表述在本表中指 **`0.1.2-alpha.3` / `0.1.2-alpha.5`** 实测行为，**不含** `0.1.2-alpha.1`；本表的契约断言一律以**基线版本实测**为准，跨代兼容靠插件容错（如 `lib/auto-resume.js` 的 `normalizeEntry()`），**不构成契约**。

> **行号是本表最易腐的部分（2026-09-10 实测，两次静默失效）**：表中 harness 行号是 **0.1.5-alpha.1** 时点的定位提示；本仓库自身行号则会**随被引文件的任何一次编辑而静默失效**。
> ⚠️ **本表"仓库内行号"的时点 = 2026-09-22 那次提交**（v0.1.7 适配）。此前由 D 按 §D.3 抽样 15 条，**10 条已陈旧**（例：`require` 整组 `:41,798,799,…` 实际已移到 `:161,1106,1107,…`；`slots` 的 17 个陈旧行号纠正为 **14 个调用点**；「slot id 集合」的指针由 `README.zh.md:65-76`（那是"兼容性"散文，不是槽位表）纠正为 `:91-98`；该槽位表在 2026-09-28 重落锚④ 后位于 `:83-91`）。⇒ **这些数字只保证"在该提交那一刻对"**，此后照旧会腐；**判据永远是 §0 的内容锚，不是行号**。**2026-09-24 补充（D 报 F3）**：本表此后有多次正文改动（`:11`/`:43`/`:47`/`:68`/`:79`/`§B` 等区），**均不触碰数字字段**，且改动时逐条复核过行号仍命中磁盘 ⇒ **时点前移、值未变**；这条本身也是「时点声明会腐」的实例。**2026-09-26 更正（A 报，随重落锚③）**：上述「改动时逐条复核过行号仍命中磁盘」在写下时**已经不成立** —— 本表对 `lib/global-prompt.js` 的 7 个行号文本（共 9 处：`inject`、`agents.roots()`、`section()`、`webServer.register`、`originGuard`、`session/created`、写回块；其中 `:232,250`（修复前）与 `:289`（修复前）各被 §A 的两格引用（紧接下文给的是修复后的值；两套同形，故加标记））与对 `lib/web-restart.js`、`package.json` 的两个引用（分别 `:5` 与 `:42`；`package.json` 现为 `:46`；`lib/web-restart.js` 本身已于 0.1.13 随「重启服务」整功能移除删除）**当时均已陈旧**（用 §0 锚的那一份 `F5ED7AFD…`（`split('\n').length` 口径 301 行）逐行实测：`inject` 在 `:4`、`agents.roots()` 在 `:41`、`section(` 在 `:218`/`:237`、`session/created` 在 `:273`、`webServer.register` 在 `:282`；同一批构造在**修复后的现盘**文件里分别是 `:4` / `:41` / `:234`/`:253` / `:289` / `:298`）。**教训：复核「这次改动碰过的行」不等于复核「本表全部引用」**；已在本轮一并纠正。**同日续核**：逐条解析本表全部 64 条本仓库行号引用后，又发现并纠正 8 个引用文本（11 处行号值）的陈旧引用 —— `lib/auto-resume.js` 的 `:112,133`→`:110,131`、`:17`→`:15`、`:117`→`:115`、`:174`→`:172`、`:144,157`→`:142,155`、`:60,66`→`:57-63`、`:9`→`:7`；`lib/web-restart.js` 的 `:30`→`:143`。**「单次插入约 2 行」这个假设已被实测否掉**：同一批构造在不同历史版本上的位移量并不恒定（现场实测，`split('\n').length` 口径：`3e44642`（290 行）`agents.roots()` 在 `:35`、`section(` 在 `:232`/`:250`；`633e83e`（296 行）`:40`、`:217`/`:236`；`c5a957b`（301 行）`:41`、`:218`/`:237` —— 同一版内两个构造一个位移 +5、另一个 −15）⇒ 本表行号只作指路，不作判据（判据见 §0 内容锚）。 **2026-09-28 时点更正（A，随重落锚⑦）**：本行开头那句「本表仓库内行号的时点 = 2026-09-22 那次提交（v0.1.7 适配）」**写下时是对、此后已失效** —— 本表仓库内行号已在重落锚③/④/⑥/⑦ 四轮里逐批重抽；**本表不再自称任何「当前」时点**：行号随时变，唯一判据 = §0 内容锚（`client/client.js` 那一行的值随最后一次重抽更新，即重落锚⑦；此前写在此处的 `61FDB543…` / 151,851 B / 2,720 行是那一轮**之前**的时点，仅作历史）。
> **2026-09-28 重落锚⑧（A，随 #77-C-1「新建组必须点按钮」修正）**：`client/client.js` 那一行的值 = `59D5DF9FA142DC8731C88D3E0BF5B78E0F1CE5701311A51C5B14589916E4114B` / 162,328 B；改动只发生在 `:2362` 一行内（删掉一个属性，`git diff --numstat` = `1 1`），文件行数未变（2,880 行）⇒ **本表其余指向该文件的行号引用不需要平移**（无位移）。
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

**机制**：陈旧的本质是「内容整体移了 k 行」。要检出 k，窗口必须 **W < k**；但 W 一小，邻近无关行里的同名 token 立刻造成误报——**同一把尺子不可能既灵敏又不误报**。且「用表正文的 token 去判代码行」本身错位：W=±15 的误报集中在 `client/client.js:1895-1905` 的连续 11 行（**该区间为那次测量时点的位置**，此后该段已被会话选择器重写）。**要机械化只能回到「作者为每行声明 token」，那正是裁定 #49 否掉的逐行锚方案。**

**限定条件（不要把上表读成「永久不可能」）**：该否证成立于**当前无基线提交**的状态。若将来 `lib/**`、`client/client.js`、`README*.md` 入库，位移可由 `git diff` 的行映射**精确求出**（旧内容在提交里，映射是确定的）——**因此这一层是「被未提交基线阻塞」，不是「本质上不可机械」**。该替代手段**尚未验证**，登记为候选，不得当作已成立的手段使用。

## 0. 内容锚（机器核，唯一判据）

被引文件的 SHA256 + 字节数。**任一不匹配 ⇒ 本表对应引用自动作废，必须逐行重核后重新落锚**（重核 = 按 §D.3 重新抽取 + 人工过一遍行号）。

| 被引文件 | SHA256（2026-09-22 重落锚：settings 数据面迁移到条目 Config；**2026-09-24 重落锚①：0.1.12 版本位变动** ⇒ 仅 `package.json` 与 `README.zh.md` 两行；**重落锚②：两 README 的发布承诺句均改文**（版本号改 0.1.12 + 沿革句改为「`0.1.11` 是 `0.1.8` 之后第一个发布的版本」），**其中仅 `README.zh.md` 被锚** ⇒ 仅 `README.zh.md` 一行更新；**2026-09-26 重落锚③：`lib/global-prompt.js` 工作区提示词取值层修复（`workspaceCfg.workspaces` 直接取字典 + 独立 `removed` ref + 只写增量）+ `package.json` 新增 workspace-prompt 门脚本** ⇒ 仅 `lib/global-prompt.js` 与 `package.json` 两行；同一轮把 §A 里 10 处陈旧行号重核纠正）；**2026-09-28 重落锚④：0.1.13 整功能移除「重启服务」**（删 `lib/web-restart.js` 锚行 ⇒ 14 条变 **13 条**；重落 `lib/index.js`/`lib/global-prompt.js`/`lib/request-guard.js`/`client/client.js`/`package.json`/`README.zh.md` 六行；同一轮重抽 §A/§C/§D 中因删除而位移的行号，并给两处历史条目加「0.1.13 整功能移除」标注）；**2026-09-28 重落锚⑤：0.1.13 发布落 npm 后，按章程 §10.4 第 4 步把两 README 的「最新已发布版本」承诺句改成事实（`0.1.12`→`0.1.13`，等长替换）⇒ 表内只锚 `README.zh.md`，仅该行更新**；**2026-09-28 重落锚⑥：组提示词（第三段 order 55）落地 + 六个文件重算**（`lib/index.js` / `lib/global-prompt.js` / `lib/prompt-dedup.js` / `client/client.js` / `package.json` / `README.zh.md`；同轮重抽 §A / §B / §E 中因组提示词与 client 大改而位移的行号）；**2026-09-28 重落锚⑦：设置页观感对齐整改**（`client/client.js`：布局去拉伸、切页归位、会话勾选本地乐观态 + 防抖写，详见 §B）⇒ **仅 `client/client.js` 一行**（同轮按 `git diff -U0` 行映射重抽 §B/§E 的 15 行 52 处 `client/client.js:` 引用 + 该批行内 47 处裸 `:NNNN` 指代，其中实际变值 31 处）；**2026-09-28 重落锚⑨：`lib/peer-message.js` 的 `inbox_check` 工具面 + 提示词段 `peer-inbox-discipline`（order 45）落地**（B 的 `#79-B-1`/`#80-B-1` 交付 ⇒ 该行哈希/字节重落：`6A812DED…`/10376 B → `2AE89B73…`/20402 B；同轮已按记号名重抽本表 §A/§B 内该文件的全部行号引用）**+ `package.json` 版本位 0.1.14 → 0.1.15**（等长替换 ⇒ 字节仍为 2038、仅哈希变：`9BEE8D80…` → `B268845A…`）；**2026-09-28 重落锚⑩：CI `verify` 门要求「本包当前版本」声明位与 `package.json` 一致**（D 的 §14 复核第 1 条阻塞）⇒ 两 README 的**版本位**改 `0.1.14` → `0.1.15`（`README.md:7` 英文 `Current version:` 与 `README.zh.md:7` 中文 `当前版本:` 各一处，均**等长替换**）；表内只锚 `README.zh.md` ⇒ 仅该行更新（**字节仍 40188**，仅哈希变：`D3B4A657…` → `32269F4A…`）；两 README 里**未改**的「最新已发布版本 v0.1.14」两句（各 2 处命中）属**发布后**才改的事实声明（先例锚⑤）；**2026-09-28 重落锚⑪：0.1.15 发布落 npm 后，按章程 §10.4 第 4 步把两 README 的「最新已发布版本」承诺句改成事实（`0.1.14` → `0.1.15`，等长替换）⇒ 表内只锚 `README.zh.md`，仅该行更新（**字节仍 40188**，仅哈希变：`32269F4A…` → `3232208F…`，先例锚⑤/⑩）；**2026-09-28 重落锚⑫：人类所有者裁定「全切 rc1」**（`dependencies` 与 `peerDependencies` 的代位全部抬高：harness 包 `^0.2.0-rc.1`、`cordis ~4.0.4`、`schemastery ^3.18.4`；两 README 的 10 处宿主版本声明同步抬高；`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 由 alpha.1 代 13 条换成 rc1 代 24 条；**`version` 位不动，仍为 0.1.15**）⇒ 表内被锚文件里只有两行变值（即 `package.json` 与 `README.zh.md`，哈希与字节数见本表所列）；`pnpm-workspace.yaml` / `pnpm-lock.yaml` / `README.md` 不在本表内）；**2026-09-28 重落锚⑬：`package.json` 的版本位 0.1.15 → 0.1.16，两 README 的「本包当前版本」声明位同步改动**（均为等长替换）—— 表内被锚文件里只有两行变值（`package.json` 与 `README.zh.md`；两者字节数均未变，仅哈希变），`README.md` 仍不在本表内）；**2026-09-28 重落锚⑭：0.1.16 发布落 npm 后，按章程 §10.4 第 4 步把两 README 的「最新已发布版本」承诺句改成事实（`0.1.15` → `0.1.16`，两 README 各 2 处、共 4 处，均等长替换）⇒ 表内只锚 `README.zh.md`，仅该行更新（**字节仍 39953**，仅哈希变：`17A042C1…` → `0C7425F8…`，先例锚⑤/⑩/⑪）** | 字节 |
|---|---|---|
| `lib/index.js` | `EB4CA9EA9C83E80B260E939449D3E686CE47FA9593C60A224787750216629965` | 6104 |
| `lib/identity.js` | `87522FC6863EE9E5FE6459906AE335AA09966E09891CC76323B3DAD5F7CF273E` | 2980 |
| `lib/global-prompt.js` | `5865D30C3A2E78265E402094262858C0B5EF78DDC96BF75C44118AACC7FFA4A6` | 23401 |
| `lib/auto-resume.js` | `8BC2376B9DEDCE352C7A4C7A7E35F46BF3FC7A11E33E9C4A7DE0BD9D828AE4CF` | 10648 |
| `lib/prompt-dedup.js` | `FA70484ED33F998AADF03DF5A54FF6294883A3566E6B68DFA1CE372BEF6CAAE8` | 3100 |
| `lib/prompt-literal.js` | `8DFA38720ABE9DC93ED8D4ECC79E3B170452FE036724EBC16E51DBA14503721C` | 1871 |
| `lib/request-guard.js` | `8CD93625A110DD2E00A1C55F88664AD910909CE643CFBB2235650208CD2D4BE9` | 9547 |
| `lib/peer-message.js` | `2AE89B736808E05575EF9D955AA0222926DBFADED3E3671E3D290B00007DF1B8` | 20402 |
| `lib/log-reposition.js` | `491282BF9C233C5449E96C3F203663B59B63A229AA22CEF48E5931E49CD0B03E` | 280 |
| `client/client.js` | `59D5DF9FA142DC8731C88D3E0BF5B78E0F1CE5701311A51C5B14589916E4114B` | 162328 |
| `package.json` | `944EA74D91C90E4232900310CA030CDD9275D4E3DB8E62E696CB6B393BB96524` | 2023 |
| `README.zh.md` | `0C7425F8BD6C1A46E6B86F6D57AE1C3541213D4325EA7F0F3FE0520F209562CA` | 39953 |
| `cordis.patch.yml` | `9CB32E70D0C4C98255D83F7BF7D1D67F0B2803E88676B864D9FA84E4A4C2D826` | 285 |

**为什么锚这 13 个**：它们就是本表用行号引用的全部仓库内文件（2026-09-22 调整：删去已不存在的 `lib/ui-config.js`——设置通道迁移后该文件已删除；2026-09-28 调整：删去随 0.1.13「重启服务」整功能移除的 `lib/web-restart.js`；`lib/prompt-literal.js` 自 2026-09-18 起在表内）。**`README.md` 未锚**（本表只用行号引 `README.zh.md`；`README.md` 的一致性由 `pnpm verify` 的双语版本断言守）。**`docs/agents/**` 自身不锚**（本表是锚的**持有者**，自锚会自引用）。
**摩擦是刻意的**：任何一次对上述文件的合法改动都会让锚报红，迫使「改被引文件 ⇒ 重核本表」。`README.zh.md` 与 `package.json` 是高churn 项，报红最频繁属预期。
**已核、非缺口**：`lib/plaintext.js`、`lib/sanitize.js` 是仓库内的另外两个 `lib/` 文件，但它们**零 `ctx.`、零 `require`、零 `import`**（纯模块），不挂任何集成点，故不在本表内——**这是核过的结论，不是遗漏**。

## A. Host 契约

| 契约点 | 本仓库使用位置 | harness 真源 | 断裂症状 |
|---|---|---|---|
| **条目 Config 的 `volatile()` 字段 + `.get()`**（用户数据：身份、全局/工作区提示词、自动上线开关、`client.*`），提交后 `ctx.on('loader/volatile-update', …)` 通知，**不重挂插件** | `lib/identity.js`（`cfg.default/sessions`）、`lib/global-prompt.js`（`hostCfg.enabled/content/files`、`workspaceCfg.workspaces`、`workspaceCfg.removed`）、`lib/auto-resume.js`（`cfg.sessions` + volatile-update 差分）、`lib/index.js`（Config 声明） | `vendor/schemastery`（`.volatile()` ≥3.18.3；`createVolatile`/`isVolatile` 经 `Symbol.for('cosmokit.volatile.write')` 跨副本识别）、`vendor/loader/src/config/entry.ts`（`_commitVolatile` → `fiber.ctx.emit(self, 'loader/volatile-update', paths)`） | 配置改动不生效（或直接抛 `volatile is not a function` / `object is not extensible`）；设置页空白 |
| **`ctx.get('configForms').get('session-toolkit')`**：浏览器半读写的就是同一条目 Config 的 volatile 字段 | `client/client.js`（`configForm` / `sectionOf` / `readUiCfg`） | `packages/client/ui-settings/src/client/config-form.ts`（`ConfigForms.get`/`ConfigForm.mutate`）、`packages/settings/settings/src/index.ts`（`describe`/`mutate` 的 volatile 路径校验与 `configEditor.edit`） | 设置页空白 / 写入被拒；UI 旋钮回落 `UI_FALLBACK` |
| `ctx.systemPrompt.section({ name, order, text, interpolate })` | `lib/identity.js:50`、`lib/global-prompt.js:304,320,358`（均带 `interpolate: false`）、`lib/prompt-literal.js:20`（旧内核兜底 waterfall） | `packages/core/system-prompt`（0.1.6 起 `PromptSection.interpolate`） | 提示词段消失或顺序错乱（身份→全局→组→工作区应为 40→50→**55**→60）；**旧内核缺兜底则 `{{...}}` 抛错、整轮组装失败** |
| `ctx.on('system-prompt/assemble', …, next)`（waterfall） | `lib/prompt-dedup.js:20`、`lib/prompt-literal.js:20` | `packages/core/system-prompt` | 提示词去重/按字面渲染静默失效（无报错，只有重复行或花括号被改写） |
| `prompt-dedup` 的**去重范围** | `lib/prompt-dedup.js:14`（`const TARGET_NAMES = ['session-identity', 'global-prompt', 'group-prompt', 'workspace-prompt']` —— 组段**在列**；数组顺序即段优先级 40/50/55/60） | 内核 `system-prompt/assemble` waterfall（`lib/prompt-dedup.js:20` 挂载、`:22` 先 `await next()` 取权威结果） | 组段**不在**去重范围 ⇒ 组提示词与全局段重复的行**不被去重**（同一行被注入两次，token 翻倍）；反向：把组段加进去却漏了 `await next()` ⇒ 前序 replacement 被丢弃 |
| `ctx.agents.get(id)` / `ctx.agents.resume({ resumeSessionId, agentOptions, setup })` / `ctx.agents.roots()` | `lib/auto-resume.js:110,131`、`lib/global-prompt.js:41` | `dsh-agent/lib/types/index.d.ts:139`（`get` 返回裸 Agent）、`:287`（`resume`）、`:362`（`roots`）、`:110-129`（`ResumeAgentOptions`，形状未变） | 自动上线失效；工作区列表空（**历史根因**：见 `README.zh.md:283`「frozen 配置铁律（红线）」= `volatile` 的 `ref.get()` 返回 `deepFreeze` 快照） |
| **`ctx.sessionController.resolveAgent(id)`**（0.1.6 起）：官方恢复链路 = composeAgent（`installSelection` + mount preset）+ 归属校验 + 并发去重 | `lib/auto-resume.js:15`（`ctx.inject(['sessionController'], …)`）、`:115`（优先调用） | `packages/api/session-controller/src/index.ts:170`、`src/agent.ts:381`（composeAgent）、`:283`（selectionFor） | 手工 `ctx.agents.resume` 会丢掉会话自己的模型/effort 选择（重启后回落默认模型），并绕开后续官方在 resume 链上追加的步骤 |
| `ctx.on('session/created', …)` | `lib/global-prompt.js:390` | `packages/core/session` | 工作区回填不触发 |
| `ctx.effect(fn)`（生命周期绑定） | `lib/identity.js:50`、`lib/global-prompt.js:298,317,355` | `packages/core/scope` | 热重载重复注册 / 卸载残留 |
| `ctx.inject(['webServer'], cb)` → `webServer.register({ kind: 'exact', path, handler })` | `lib/global-prompt.js:396`（`ctx.inject(['webServer'], …)`；`register` 调用在 `:399`，`path: STATE_ROUTE` 在 `:401`） | `packages/host/webserver` | 只读状态路由 404（设置页那两项运行时投影恒为空）；**apply 时刻一次性 `ctx.get` 会在服务晚到时静默失效**（loader 并发创建条目，无顺序保证） |
| `ctx.inject(['tools'], cb)` + `defineTool({...})` + `tools.register(tool)` | `lib/peer-message.js:92`（`ctx.inject(['tools'], cb)`）、`:128,141`（send 的 `name`/`execute`）、`:233,242`（list）、`:251,260`（`inbox_check`）（**四次更正**：本行原写 :123/:125/:140，比真实值小 5；2026-09-24 补 `wakingAfterAbort` 注释（+7 行）后成 :144/:146/:161；同日再改「不排队」文案（+14/−7，全部落在 :126 之后）⇒ :137/:139/:154 那批再 +7 成 :151/:153/:168；**2026-09-28 第四次**：B 的 `inbox_check` 交付使该文件 316 → 371 行，:15/:27/:51/:68/:78/:114 也全部漂移 ⇒ 上面这些历史行号一律作废，**权威是记号名**（本次按记号名重查，不按偏移推算）。⚠️ 历史行号**故意不裹反引号** —— 让 `prompt-contract` 与 `contract-line-drift` 两个门都看不见它们） | `packages/core/tools`、`@deepseek-ai/dsh-tools` | `send_to_session` / `list_sessions` 从工具面消失 |
| **`ctx.inject(['sessionPersistence'], cb)`**（0.1.5 起改用注入；服务晚到会补跑，永不到则静默不执行） | `lib/auto-resume.js:172` | `cordis/lib/index.js:1599`（`inject` 定义）、`:1305-1343`（`_checkImpl`/`_setEpoch`/`_reload` 语义） | **启动恢复永不执行且无报错** |
| `list()` **返回 `SessionPersistenceSnapshot[]`**，header 在 `.header`（0.1.5 起；`0.1.2-alpha.5` 为 `SessionHeader[]`） | `lib/auto-resume.js:142,155`（`await persistence.list()` / `entries.filter(shouldResume)`） | `dsh-session-persistence/lib/types/index.d.ts:22-31`（快照类型）、`:155`（list 签名） | **启动恢复静默无动作**：`h.id` 为 `undefined` → 过滤结果恒空（2026-09-10 实测故障） |
| `SessionHeader` 字段集 = `version/id/createdAt/cwd?/parentSession?/isSeeded/origin?'subagent'/delegationDepth?/agentPreset?`；**无 `seedLength`**（`0.1.2-alpha.5` 起即如此） | `lib/auto-resume.js:57-63`（`shouldResume()` 读 `entry.header.*` 与 `entry.eventCount === 0`） | `dsh-session/lib/types/types.d.ts:58-95` | 空白会话过滤**恒不生效**（插件容忍缺失，无硬断裂） |
| `ctx.get('agentDefaultModel')` | `lib/auto-resume.js:7` | `packages/core/agent-default-model` | resume 缺少模型选择 |
| `ctx.get('sessionTitle')` / `ctx.get('workspaceRegistry')`（**调用时惰性读取**，0.1.9 起） | `lib/peer-message.js:104`（title）、`:154`（workspace）（2026-09-28 重指：原 27/78 行随文件增长漂移，历史值不裹反引号） | `packages/session/session-title`、`packages/workspace/workspace` | 工具返回退化（标题/工作区名丢失） |
| ⭐ **`workspaceRegistry` 的写侧**：`resolveByPath(cwd)` ⇒ `workspace.attachSession(sessionId)`（新建会话之后必须把它挂到工作区） | `lib/session-admin.js:339`（调用时惰性读取）、`:349`（`resolveByPath`）、`:364`（`attachSession`）；五态判据注释 `:324-327` | `packages/workspace/workspace/src/index.ts:498`（`resolveByPath` **实现**）、`packages/workspace/workspace/src/entity.ts:109`（**`attachSession` 实现**）、`packages/workspace/workspace/src/types.ts:111`（**`attachSession` 接口**）、`packages/core/agent/src/index.ts:596`（`agents.roots()`） | 会话建出来了但**不属于任何工作区** ⇒ GUI 侧栏落到「未分组」（人类所有者 2026-09-24 前一直看到的现象；修复提交 `07702cb`）。**该行是 2026-09-24 补的缺行** —— 表原有 `workspaceRegistry` 一行只覆盖**读**、没覆盖**写**。⚠️ 易错：`attachSession` **不在 `index.ts` 里**，实现与接口分居 `entity.ts` / `types.ts`（2026-09-24 B 按实测纠正了 A 派发文本里的错路径） |
| `timer` 服务（`inject: ['timer']`） | `lib/global-prompt.js:4` | `packages/util/time` | 定时轮询不执行；apply 挂起 |
| ⭐ **组提示词段（第三段，order 55）** | `lib/global-prompt.js:355-383`（`ctx.effect(() => ctx.systemPrompt.section({…}))` 在 `:355`；`name: 'group-prompt'` 在 `:356`；`order: groupSectionOrder` 在 `:357`；`interpolate: false` 在 `:358`）。判**命中键** = `agent.session.header.id`（`const sessionId = typeof header.id === 'string' ? header.id : ''` 在 `:364`，空则整段 `return ''`）；`for (const groupKey of Object.keys(groups))` 在 `:369` ⇒ **拼接按 config 字典键序，不是声明序**；`if (!rec \|\| rec.enabled !== true) continue` 在 `:371`（`enabled: false` ⇒ 不注入）；`if (members.indexOf(sessionId) === -1) continue` 在 `:373`（会话不在该组 `sessions` 里 ⇒ 不注入）；`rec.content` 先 `.trim()`（`:374`）；`content` 与 `files` 皆空则跳过（`:376`）；块 = `content` 与引用文件正文以 `'\n'` 相接（`:380`）、**块间以 `'\n\n'` 拼接**（`:383`） | config 真源 `lib/index.js:62-71`（`groupPrompt.sectionOrder` 默认 **55** 在 `:65`，**非 volatile**；`groupPrompt.groups` 为 `z.dict(z.object({ enabled / content / files / sessions }))`，**整个 dict 标 `.volatile()`** 在 `:71`） | **所有组都不命中 ⇒ 注入空串（不报错）**；组名写错、会话 id 写错、`enabled` 忘开——**三种都静默无注入**（与「槽位名写错不报错」同族）；工作区提示词按 cwd 前缀命中、而组**按会话 id 精确相等**，两者判键不同，混用即静默漏注入 |
| ⭐ **本插件自注册路由的「来源守卫」**（Origin 比对 + Host fence + `sec-fetch-site`） | `lib/request-guard.js`（`isSameOriginRequest` 纯函数 / `originGuard` HTTP 薄层）；调用点（现存唯一）`lib/global-prompt.js:406`（`originGuard` 由 `lib/request-guard.js` 导出，`import` 在 `:2`），**绑定字面量取自 `webServer.host`** | 与 harness 自己的 `packages/client/connection/src/api-request-trust.ts:91` `isTrustedApiRequest` **同构**（三道栅栏：Host fence · `sec-fetch-site !== 'cross-site'` · Origin 比对）；loopback 谓词口径对齐 `packages/client/connection/src/loopback-hostname.ts:12` | 本插件现只剩一条自注册路由用 `webServer.register()` 直注册，**绕过了覆盖整个 `/api/` 前缀的鉴权网关**（实测：**不存在的** `/api/xxx` ⇒ 401，而 `/api/session-toolkit/state` ⇒ 200）⇒ 浏览器里任意页面可发**简单请求**（无自定义头 ⇒ 无预检）：`/api/session-toolkit/state` 只读、响应无 CORS 头 ⇒ 跨域能发、读不到。**（原第二条自注册路由 `POST /api/restart` 是**改状态**的 ⇒ 可被跨站触发重启（中断/DoS，不丢数据），已于 0.1.13 随「重启服务」整功能移除。）** |
| ⭐ `webServer.host` 的取值域（守卫条件化的依据） | 传参处 `lib/global-prompt.js:406` | `packages/host/webserver/src/index.ts:61` —— `host: '127.0.0.1' \| '0.0.0.0'`（注释：*the two supported values are loopback and all-interfaces*） | 栅栏 A **只在绑定非 `0.0.0.0` 时施加**，故条件写作 **`bindHost !== ALL_INTERFACES_BIND`**、**不是** `=== '127.0.0.1'`：**契约变宽时守卫应变严而非变松**——等值写法在出现第三种绑定模式时会**整个跳过栅栏 A**（fail-open 且静默；2026-09-22 D 实测 `bindHost='10.0.0.1'` + rebinding 形态 ⇒ 放行） |
| ⭐ **V4 会话消息来源**：写进会话的每条消息都必须带**生产者归属**的 `source.kind` | `lib/peer-message.js:190`（`source: { kind: 'agent-message', form: 'relay', senderSessionId: String(caller.id) }`）（**两次更正**：本行原写 :109，复核时为 :114；2026-09-28 因该文件 316 → 371 行重指为 :190（历史值不裹反引号）） | 准入规则 `packages/session/session-format-v3-to-v4/src/message-sources.ts:9`（**只拒绝 `kind === 'plugin'`**，其余非空字符串一律放行）；`agent-message` 的形状 `packages/subagent/subagent/src/continuation-messages.ts:16`（**恰好三键**）、校验 `packages/session/session-format-v2-to-v3/src/payload.ts:115-120`（`form` 必须 `'relay'`、`senderSessionId` 非空）；GUI 渲染 `packages/client/ui-chat/src/client/chat/turn-trigger.ts:35`（`message.trigger.agent`） | **整次发送被拒**（`format v4 message requires a producer-owned source kind`）。⚠️ 注意反向陷阱：写 `kind:'user'` **能通过准入**（不是 `'plugin'`），但把「另一个 Agent 发来的消息」记成「人类用户发的」——**V4 这次升级要消灭的正是这种失真**，所以判据是**语义正确**而不是"没报错"（2026-09-22 由 A 发现、B 落地） |
| ⭐ **peer 消息的投递队列**（2026-09-24 裁定 #12 改） | `lib/peer-message.js:216-217`（`wakeup === false ⇒ target.inject`；否则 **`target.steer`** —— **改前是 `target.followup`**）（**三次更正**：本行原写 :126-127，补 `wakingAfterAbort` 注释后 +7 成 :133-134；同日再改「不排队」文案后 +7 成 :140-141；2026-09-28 因该文件 316 → 371 行再 +76 成 :216-217（历史值不裹反引号）） | 内核三个相邻方法 `packages/core/agent-loop/src/agent.ts:160-174`（`followup` = `'next-turn'` + 唤醒 / **`steer` = `'next-step'` + 唤醒** / `inject` = `'next-step'` 不唤醒）；消费时机 `packages/core/agent-loop/src/inbox.ts:109-114`（`claim` **每个步边界都先抽干 `next-step`**，**只有轮次首步**才额外吃一条 `next-turn`）；循环 `agent.ts:312-347`（`while (true)` 本体；`:310` 是 `let target = 'next-turn'`、**`:346` 才是 `target = 'next-step'`**）（**2026-09-24 复核更正**：本处原写 `:295-325`，而该区间内 `next-step` 计数为 **0** ⇒ **判据不可复现**——复现 `awk 'NR>=312 && NR<=347' packages/core/agent-loop/src/agent.ts | grep -c "next-step"`（路径相对 harness 仓库根）应得 **1**）；**官方同法** `packages/experimental/agent-team/src/mailbox.ts:251`（给运行中的队友投递用 `root.steer(input)`） | 用 `followup` ⇒ 目标**正在执行**时消息只能等本轮跑完 ⇒ **消息排队**（人类所有者 2026-09-24 报的现象）。**实测基线**：B 的会话日志 `seq=4058 target="next-turn" ids=[peer-muck01kt-…]` → `seq=4060 removed=1`（等了整轮）；对照 `seq=4055 target="next-step"` → `seq=4056 removed=1`（下一个步边界就进上下文）。⚠️ 两点固有性质：**`steer` 不打断当前步**，只在**下一个步边界**进入；**它不新开 turn** —— 对方会在同一轮里转向处理该消息。**版本安全**：`steer` 自 `fbf87e660c`（2026-07-28）存在，远早于依赖下限。⚠️ **`steer` 不是"必定不排队"的保证**：`send()` 里有 `wakingAfterAbort` 重分类（`agent.ts:153-159` —— `wakeup && phase.kind !== 'idle' && phase.abort.signal.aborted` ⇒ `resolvedTarget = 'next-turn'`），即**上一个活动正在被取消时会静默降级成 `next-turn`**（内核注释：*Waking input cannot join an aborted activity*）。这是内核有意的安全设计，不是缺陷（2026-09-24 由 D 读源码发现、A 复核并落表）。⚠️⭐ **`target` 是「声明」，不是「行为」**：目标**空闲**时 `steer` 仍声明 `next-step`（它走的是唤醒路径），但从**消费时机**看就是 `queued` ⇒ **只看 `target` 字段会把这一格误读成「插入」** —— 这是本集成点最容易犯的误读（2026-09-24 B 在实战中指出，E77：同一份日志里 `peer-mufc7pen-…` 落 `next-step`、却被尺子判 `queued` 并额外报「声明与行为不一致」，**两者都对**）⇒ 判据必须是**三值 ＋「投递那一刻还有没有 `step` 边界（= 有没有轮在跑）」**，不能只看 `target`。⚠️⭐ **同一天的第二处更正（A 的判据过宽）**：本行原先把决定条件写成「投递→消费之间有没有新 `turn/start`」——**那是过宽的**：反例 `peer-mufc7pen-8otia2xlb6`（投递时有轮=false、`turn/start` 与消费同刻、等 0 秒）并没插进任何轮，却被旧写法判成插入。**决定条件是「投递那一刻还有没有 step 边界」**（源码：`inbox.ts:109-114` 的 `claim` 在每个步边界**无条件**排空 `next-step`；`agent.ts:310` 轮首是 `next-turn`、`:346` 第一步之后才切 `next-step`）—— 由 D 实测指出、A 复核后更正 |
| ⭐ **投递队列的手动复核尺子**（非 CI 门） | `scripts/inbox-queue.verify.mjs`（D 建；**会漂，请现算** —— 2026-09-28 21:0x 实测 `cc876bdaaaf30d81…` / 27,731 B / 418 行；旧注记 25387 B / 392 行为历史值、非引用；非 §0 锚行） | 只看 `agent/inbox/spliced` 的**可折叠投影**（`packages/experimental/agent-team/src/session-message.ts:12-19`）＋消费产物，**不依赖 `agent/inbox/claimed`——它在会话日志里根本不存在**（该事件只走内核内存 dispatch，不落盘；D 普查 B 的日志：88 条 `spliced` / **0 条 `claimed`**） | 判据是**三值**不是二值，**且决定条件是「投递那一刻有没有轮在跑」（不是「有没有新 turn」）**：`queued`（消费前有新 `turn/start` ⇒ 等下一轮）· `inserted-live`（投递时有轮在跑**且**消费前无新 turn）· **`delivered-idle`**（消费前无新 turn，**但投递那一刻没有轮在跑** ⇒ **只该单列，不许读成"插入"**；二值判据在这里会**假绿**）。退出码 **0 通过 / 1 真的排队了 / 2 尺子没跑成 / 64 用法错**。**不进 CI**：它要读 `~/.dsh` 下的会话日志（外部输入），CI 里只会得到 `exit 2` 的假红——与 `dependency-skew`（要 profile）· `dsh-log-ui.drift`（要 harness checkout）同类 |
| `inject` 服务并集 | `lib/index.js:92-101`（八个子模块的 `inject` 并集：identity / globalPrompt / autoResume / peerMessage / sessionAdmin / logReposition / promptDedup / promptLiteral） | 各 provider 包 | 缺一服务会**拖慢整包 apply**（`README.zh.md:291` 已知限制） |
| ⭐ `ctx.get('agentPresets')` → **`resolve(id?)` / `mount(ctx, id?)`**（G5 补行） | `lib/auto-resume.js:89,104`、`lib/session-admin.js:249,254,258` | `packages/preset/agent-preset-registry/src/index.ts:185`（`resolve`）、`:243`（`mount`） | **新建/恢复出来的会话不 mount preset ⇒ 它的工具、提示词段、skill 全部从"空全局层"解析**——而返回仍是 `ok:true`，即**一个"成功但残缺"的会话**。插件对两种情形分开处置：**服务缺失**=合法降级（带说明性 note）；**服务在但默认 preset 解析失败**=环境坏了（建会话之前就报 `PRESET_RESOLVE_FAILED`，不产生残缺会话） |
| ⭐ `ctx.get('sessionQuery').observeSession(sessionId)`（G5 补行） | `lib/auto-resume.js:94`（取 `observation.projections?.values.agentPreset ?? observation.header.agentPreset`） | `packages/session-query/session-query/src/index.ts:140`（另有 `observationSymbol.dispose()` 需释放） | 恢复时 **preset 取错**：`header.agentPreset` 只是**创建时**的值，会话可在 blank 期改 preset，真值在 projection 里 |
| ⭐ `ctx.agents.requireInitiator()`（G5 补行；**README 早已声明、表里却一直缺**） | `lib/peer-message.js:144`（`exec.agent === undefined` 时的兜底取发送方）、`:263`（`inbox_check` 的同款兜底） | `packages/core/agent/src/index.ts:308` | 取不到发送方 ⇒ **`source.senderSessionId` 为空** ⇒ V4 直接拒绝该消息（见 §B 的 `agent-message` 一行） |
| ⚠️ **文档化但本插件未挂载的内核扩展点：`agent/turn-stopping`**（#80-B-1 侦察结论） | 本插件**未挂**：`grep -c "agent/turn-stopping" lib/*.js` = 0（可复现） | `packages/core/agent-loop/src/agent.ts:340-346`（`if (turnEnds && this.inbox.nextStep.length === 0) { await this.dispatch.serial('agent/turn-stopping', { turn, signal }); signal.throwIfAborted() }`，紧接 `break` / `target = 'next-step'`）＋ `packages/core/agent/README.md:67`「runs before an otherwise completed turn closes and can steer to keep it open」 | **现在没有「收尾前拦住模型」的硬保证** —— 入站 peer 消息的处置只有**工具 + 纪律**（弱保证）。若将来要挂：它只能 `steer` 再开一步、**无法验证模型是否真的回了**；台账是会话级粗粒度、自动 steer 会把 `wakeup:false` 的纯登记类也逼成待处置 ⇒ 必须加「每条至多提醒一次」的闸 |
| ⭐ **`inbox_check` 工具面**（#80-B-1，入站 peer 消息台账） | `lib/peer-message.js:251,260`（`name`/`execute`；`:330` 段名常量、`:334` 纪律段正文） | 内核 `caller.inbox.nextStep` / `.nextTurn`（尚未取走的消息 ⇒ `queued:true`）＋**本进程内**台账 `pendingPeer`（`lib/peer-message.js` 模块级 Map ⇒ `queued:false` = 已进上下文、此后没回过任何出站） | 只读、无参数、目标恒为**调用者自己**（拿不到 caller ⇒ 返回 `NO_CALLER` 明确报错，不猜）。返回 `{count, items[]}`，每条含 `messageId`/`from`/`preview`/`queued`。⚠️ 两条已知限度：台账是**进程内**的（内核重启 ⇒ `queued:false` 那半为空）· 粒度是**会话级**（回任意一条出站即全清）⇒ 它是**提醒器**，不是审计；内核若改 `inbox` 形态 ⇒ 第一半**静默降级**（只留台账） |
| ⭐ **提示词段 `peer-inbox-discipline`（order 45）**（#80-B-1） | `lib/peer-message.js:330`（段名常量）、`:334`（正文）、`:352-358`（`ctx.inject(['systemPrompt'], …)` + `promptCtx.effect(() => systemPrompt.section({…}))`） | 段顺序面（章程 §3.2 对外可见面）：身份 **40** → **本段 45** → 全局 **50** → 组 **55** → 工作区 **60** | 段不注入 ⇒ 模型不知道「收尾前先查 inbox」这条纪律；`name`/`order` 改名改序要同步本行；`interpolate: false`；**subagent 不注入本段**是 B 的判断（未获确认） |
| ⭐ `ctx.get('sessions').get(id)`（G5 补行） | `lib/session-admin.js:289`（`rename` 需要 **live `Session` 对象**，不是 id） | `packages/core/session/src/index.ts:1209`（`get(id: SessionId): Session \| undefined`；同类另有 `create/prepare/enter/announce/list/fork`） | 改标题失败（回落 `agent.session` 也拿同一个 live 对象，两者皆缺时才报 `SESSION_UNAVAILABLE`） |
| ⭐ `ctx.get('settings').update(ns, patch, expectedRevision?)`（G5 补行） | `lib/global-prompt.js:217`（把**本次新增**的工作区增量写回本条目 config；只传差集，见重落锚③） | `packages/settings/settings/src/index.ts:347`——**逐键深合并**（`mergeLayers` 在 `:175`，会**递归进嵌套 plain object**） | 发现的新工作区不写回 config ⇒ 工作区列表永不更新；**「深合并」是"不会抹掉用户 `workspacePrompt.removed`"的前提**——若哪天改成 `replace`，用户手动移除过的路径会全部自己回来 |
| 引用文件读取上限（`maxFileBytes` / `maxTotalBytes`）+ 按 `mtimeMs`/size 缓存 + 投影不重建 | `lib/global-prompt.js`（`readPromptFiles`、`recordStatus`） | 本插件自身（`runtime.fileStatus` 是进程内投影，经 `GET /api/session-toolkit/state` 送出） | 每个模型步一次无谓重建/落盘 + 超大文件同步阻塞组装/撑爆提示词 |

**红线（改 host 必读）**：DSH 的 `scope.get()` 返回值被 `deepFreeze`。写入前必须先 `{ ... }` 拷贝（数组 `.slice()`），再 `update()`。这是「工作区列表空」的根因，见 `README.zh.md:283`「frozen 配置铁律（红线）」。

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
| ⭐ **`STATE_URL`（`/api/session-toolkit/state`）——同一个字符串在两侧各写一次**（G5 补行） | host 注册：`lib/global-prompt.js:399`（`webServer.register({ kind:'exact', path: STATE_ROUTE, handler })`；`path: STATE_ROUTE` 在 `:401`）；client 轮询：`client/client.js:17` | 本插件自有路由（0.1.13 起本插件唯一自注册路由——原与它同机制的 `/api/restart` 已随「重启服务」整功能移除）；`WebRoute` 契约在 `packages/host/webserver/src/index.ts:42-48`（`'exact' \| 'prefix'`、绝对路径无尾斜杠、`handler(req,res)`） | **改一边就静默断**：客户端 `fetch` 404 ⇒ 活跃工作区与引用文件状态**恒为空**（`stateStore` 只在无人订阅时停轮询，不报错）；G5 之前本表**没有这一行**，而 §D.3 的抽取命令**已经把它抽出来了** —— 抽出来却无处落地 |
| ⭐ **`GET /api/session-toolkit/state` 的 `sessions` 数组**（0.1.14 起，供组提示词的会话选择器） | `lib/global-prompt.js:413`（`res.end(JSON.stringify({ ok: true, active: runtime.active, fileStatus: runtime.fileStatus, sessions: collectSessions(ctx) }))`；`collectSessions` 定义在 `:64`；形状 = `{ id, cwd: string\|null, title: string\|null }`，`cwd` 非法则 `null`（`:90`）、`title` 由可选服务 `sessionTitle.get(session)` 提供且**包在 `try/catch` 内**（`:81-88`），异常仅 `console.warn('[dsh-global-prompt] sessionTitle.get failed: …')`）⇒ **服务缺失或抛错都只降级为 `null`，绝不让路由失败**） | 浏览器半读同一 URL（`client/client.js:17` 的 `STATE_URL`）；消费方 = 组提示词的会话选择器 | 形状变更即静默退化：客户端按 `id` 取值、按 `title` 显示、按 `cwd` 分组 ⇒ **字段改名/缺失不报错**，只表现为选择器空或标签「未在线」 |
| ⭐ **浏览器宿主面**（G5 补行，**只列与 shell DOM 结构或权限策略耦合的**：`navigator.clipboard.writeText` · 四处同形态的 CSS 注入 `document.getElementById` + `head.appendChild`） | `client/client.js`（复制按钮、`injectCss()` 的四处模块） | **不是 DSH 契约**：标准 Web API 不随 harness 漂移 ⇒ **刻意不列** `createElement` / `mousedown·mousemove·mouseup·resize` / `innerWidth` / `setTimeout`（列进去会把本表变成"Web 平台手册"，稀释真正会漂移的行；§E 自己写着"摩擦是刻意的"） | 剪贴板**权限失败会静默不复制**（无 toast 的话用户以为成功）；**shell DOM 结构变了则样式静默失效**（选择器还在、元素没了） |
| `ctx.get('slots')` → `slots.register(meta, render)` / `slots.inject(name, fn)`（低 priority 遮蔽） | `client/client.js:1039,1059,2423,2695,2705,2800,2808,2823`（**2026-09-28 重抽：8 处 `slots.inject(`**——其中 `:1039`/`:1059`/`:2423`/`:2695`/`:2705` 的 `slots.register(` 紧随下一行（`:1040`/`:1060`/`:2424`/`:2696`/`:2706`），`:2800`/`:2808`/`:2823` 是 `inject(…, () => slots.register({ … }))` 单行同址；组提示词标签页新增 `sidebar.workspaces.session.menu.item` 一处。旧值整组已陈旧） | **由 web shell 以模块表种子提供**：`dsh-web-frontend/dist/assets/index-*.js` 内含 `"@deepseek-ai/dsh-client-ui-slots":<instance>`；`packages/client/ui-slots` 仍在 checkout，但**该 npm 包不在已装 profile 中** | 按钮/设置页整体消失；遮蔽失效则官方 Session log 按钮重现 |
| `ctx.get('configForms').get('session-toolkit')` → `{ getSnapshot()/.value/.status, subscribe, set(field, v), unset(field), mutate(ops, expectedRevision) }`；snapshot 形状与旧 scope 对齐(`status: 'loading'\|'ready'\|'unavailable'`、`value` 为对应 config 子树) | `client/client.js:1159,2555,2875`（三条 `inject` 数组含 `'configForms'`；`var SETTINGS_SERVICE = 'configForms'` 在 `:16`；`function configForm(ctx)` 在 `:27`、`sectionOf(form, basePath)` 在 `:36`、`readUiCfg(form)` 在 `:145`；`sectionOf` 的 `groupPrompt` 调用点在 `:2419`） | `packages/client/ui-settings/src/client/config-form-types.ts`（`ConfigFormSnapshot`）、`schema.ts`（`isVolatilePath`） | 「设置服务不可用」——设置页整体空白；UI 旋钮回落兜底值 |
| `ctx.get('locale')` → `register(ns, { zh, en })` / `bind(ns)` | `client/client.js:1025,1032,2405,2412,2692,2794,2797`（`ctx.get('locale')` 在 `:1025`/`:2405`/`:2794`；`locale.register` 在 `:1032`/`:2412`/`:2797`，另 `:2692` 走 `ctx.locale.register`） | `packages/client/locale` | UI 文案退回 key；中英切换失真 |
| `ctx.get('sessionLogDownload')` → controller `{ store, download(id), dismiss(id), dispose() }` | `client/client.js:2698,2708,2712,2716,2719`（`id: 'session-log-download'` 在 `:2698`、平移件 `id: 'session-log-download-moved'` 在 `:2708`、`ctx.get('sessionLogDownload')` 在 `:2712`、降级 `console.warn` 在 `:2716`、兜底 hooks 在 `:2719`）（配套 host 侧 `lib/log-reposition.js`） | `dsh-session-log-export/lib/types/client/index.d.ts:7`、`controller.d.ts:31-58`；**0.1.6 的官方 UI 已改为「⋯ 更多操作」菜单** | 平移后的 Session log 入口失效（`README.zh.md:289` 已声明风险；官方 UI 改版必须人工同步复刻件） |
| ⭐ **侧栏会话行「⋯」菜单项（扩展点）** | `client/client.js:2823-2825`（**2026-09-28 重抽**；`ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: …, id: 'dsh-session-toolkit.copy-session-id', order: 500 }))`，渲染 `primitives.MenuItemButton` 在 `:2845`） | **平台声明的槽位**：`packages/client/ui-workspace/lib/types/client/contract/slots.d.ts:127`（契约体 `:128-137`：`kind:'list'` / `scope:'root'` / `hookContext: MenuOpenState`）；官方示例 `:113-124`（`id:'copy-session-id'`、`order:500`）；宿主把 `hookContext.menuOpenState` 按 `standardHookPropName`（`ui-slots/lib/index.js:7-9`，`use` + 首字母大写）转成渲染 prop `useMenuOpenState`；渲染点 `ui-workspace/lib/client.js:1702` | **槽位名写错不报错、只是什么都不发生**（与 `primitives.X` 缺名、与 `react` 缺绑定同族：**静默失效**）⇒ 改动时必须对着上面的声明核。**`id` 必须包名命名空间**：裸名会在另一 priority 上**遮蔽官方那一行** |
| ⚠️ 该菜单项渲染函数里的**条件式 hook 调用**（有意为之，改动前先读） | （同上（`client/client.js:2828-2838` 一带；`var hook = props && props.useMenuOpenState;` 在 `:2830`） | React 的 Rules of Hooks | `useMenuOpenState` 的调用写在 `if (typeof hook === 'function')` 分支里 ⇒ **字面上违反 Rules of Hooks**。**这是有意为之**：本槽位的契约**保证**该 prop 存在，故分支每次渲染都相同（React 的顺序检查不会触发）；而**无条件调用**会在宿主不再提供它时**渲染期抛错 → 被 slot 错误边界吞掉 → 静默消失** —— 本插件已两次栽在那一形态上（图标改名致整页空白、`require('react')` 缺失致整块崩掉）。 |
| `ctx.effect(fn, label)` | `client/client.js:1032,2412,2692,2797,2866`（**2026-09-28 重抽**；`:2692` 是模块 3 的 `ctx.locale.register`；组提示词标签页新增 `ctx.effect(` 在 `:2866`，其内 `form.subscribe` 订阅按钮状态） | `packages/core/scope` | locale 重复注册 / UI 旋钮订阅泄漏 |
| 模块表种子词（`require` 目标） | `client/client.js:160,1169,1170,2566,2567,2568,2569,2741,2742,2743`（**2026-09-28 重抽**；`:2566-2569` 为**模块 3（log-reposition）**的 4 条 require 头、`:2741-2743` 为**模块 4（peer-message）**的 3 条；**已移除 schemastery 的 `try/catch` 导入**） | `packages/client/modules` + `packages/client/tsdown.client.ts`（默认 externals） | 单个 `require` 抛错即该 UI 模块失效 |
| ⭐ **`@deepseek-ai/dsh-client-ui-primitives` 的「导出名面」**：插件引用的**每一个** `primitives.X` 必须真的在已装 harness 的导出里 | `client/client.js` 共 12 个成员：`Button` · `DisclosureRow` · `Menu` · `Modal` · `Pill` + 7 个图标 `IconArchiveOutlineRegular` · `IconCheckOutlineRegular` · `IconCopyOutlineRegular` · `IconDownloadOutlineRegular` · `IconEllipsisOutlineRegular` · `IconFolderOpenOutlineRegular` · `IconGlobeOutlineRegular` | `packages/client/ui-primitives/lib/index.js` 的 `export { … }`；**图标命名于 `4937343a5e`（2026-09-17, feat(web): unify the client visual language）由 `IconXxxOutline<尺寸数>` 改为 `IconXxxOutline{Regular\|Medium}`**（`ICON_REGULAR_STROKE = 1` / `ICON_MEDIUM_STROKE = 1.3`；Artwork 保留旧默认 size，故显式的 `size` 属性仍然有效） | ⚠️ **整片空白 = `React.createElement(undefined, …)` 抛错 ⇒ 该 section/组件子树渲染失败；而左侧导航行仍照常出现（注册与渲染是两件事）**。**2026-09-22 实测**：7 个旧名在 `apps/web/dist/assets/index-*.js`（606157 B）中**全部 0 命中**、7 个新名各 1 命中 ⇒ 浏览器里就是 `undefined`。此缺陷类是**静默**的（语法门、打包门、锚门全绿），**必须靠「导出名面」这一行守**：门见 `scripts/primitives-export.assert.mjs`（§D.9） |
| slot id 集合 | 见 `README.zh.md:86-94` 表（**2026-09-28 重抽**；`### 注册的 Slots` 在 `:84`、表头 `:86`、末行 `:94`；英文侧 `### Registered slots` 在 `README.md:82`、表头 `:84`、末行 `:92`） | `packages/client/ui-settings`、`ui-settings-general`、`ui-conversation` | 对应页面/按钮不出现 |

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
| `dsh.bundle.patch` → `cordis.patch.yml`（bundle 层注册） | `package.json:46`、`cordis.patch.yml` | `dsh-app-boot/lib/types/profile.js:7-13,37`、`dsh-app-boot/lib/index.js:1022-1029`（后者 2026-09-26 由 A 改正：原文把层序写成不带包名、也不带 app-boot 前缀的裸号（851–853，看上去像本仓库的文件）——按**本仓库** `lib/index.js`（仅 126 行）解析即越界；`dsh-app-boot/lib/index.js:850-853` 是 `normalizeShippedProfile` 的注释、不是层序；层序真身在 `dsh-app-boot/lib/index.js:1022` 起的 `readProfilePatches` 的 `patches = structuredClone([...])`）。0.1.5 原文层序：各 bundle 按其 patch 列表在**空条目表**上依次叠加 → **profile 自身 patch**（`cordis.patch.yml`）→ 启动器层（`--patch` 与 flag 派生）。**未见与「home patch」对齐的第四个具名阶段**，旧措辞据此改写 | 插件不注册；`dsh plugin add` 后无任何效果 |
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
5. 端到端：`dsh plugin --profile web add <本仓库路径>` → 重启 GUI → 逐条核 `README.zh.md` 承诺的功能。（原「重启服务」功能的验收步骤已于 0.1.13 随整功能删除；历史见本表末尾两条历史条目 7 与 14。）
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

13. ⭐ **设置页「原生观感」对齐件的核对**（§B 那一行的门，2026-09-28 新立；起因见下）：`node scripts/settings-layout.assert.mjs`，核本插件设置面板（`client/client.js` 里 `.dsw-*` 规则）是否仍与**平台原生 section 模板**一致 —— **真源 = `packages/client/ui-settings-plugins/src/client/PluginsSettingsSection.module.css`**：`.section` `:3-9`（`gap: 12px` / `max-width: 760px` / `color: var(--dsw-alias-label-primary)`）· `.heading` `:11-15`（18px/600）· `.intro` `:17-21`（13px + `label-tertiary`）· `.tabs` `:23-28`（`border-bottom: 0.5px solid var(--dsw-alias-border-l2)`）· `.tab` `:31-41`（**`font-size: 13px` 的硬出处 = `:38`**；`border: 0` / `padding: 7px 1px 9px` / `line-height: 20px` / 常态 `label-tertiary`）· `.tab:hover, .tab[data-active='true']` `:43-46` · `.tab[data-active='true']::after` `:48-58`（2px 激活条）· `.tab:focus-visible` `:60-65`。⚠ **上面这份行号是 2026-09-28 的快照、会烂**（与 `:10-14` 同一条纪律）；判据要的是「这几条声明仍在、且形态相同」，不是行号本身。自带 `--selftest`（变异副本必须报红）。
    **它不证什么**（门文件头 `scripts/settings-layout.assert.mjs:9-15` 的「本门不能证明什么」四段；⚠ `--help` 只印用法与退出码，不印边界）：只证**源码文本结构** —— **不验层叠结果、不验 token 的真实取值、不验 `client/client.js` 之外的样式来源、不验真机观感**。真机观感只能由人类所有者复验（本机 GUI 端口裸访问得 `401`，与第 10 条同类约束）。
    **为什么进 `publish-npm.needs`**：按第 12 条同一标准 —— 它的红只有「修」一个动作（要么我们的样式漂了、要么门自身要维护，后者同样得改门）。
    **升级时的连带动作（本条一半的价值在这里）**：harness 升级时**必须重读上面那份原生文件** —— 我们是从它**复刻**声明的，**平台侧改了而我们的门不会自动红**（门只钉我们自己的文本）。它与第 8 条（官方 UI 复刻件的 drift 审计）是同一形态的两个实例。
    **为什么新立**：人类所有者 2026-09-28 指出设置页「布局很有问题、交互也不流畅」（三症状：面板一打开被撑高留白、切页后要滚很久才看到内容、会话勾选有延迟）；整改后需要一把**能机械挡住「观感再次漂离原生」**的尺子 —— 之前全部门都不读设置页的样式声明。

14. ⭐ **会话选择器契约门的核对**（§B 那一行的门，2026-09-28 新立）：`node scripts/session-picker.assert.mjs`（`--selftest` 自检；越权参数退出码 `64`），核组提示词「生效会话」选择器的**结构契约**，判据 6 条、全部钉在 `client/client.js` 的源码文本上：① 会话按 `cwd` 分组、每组标题含「已选/总数」；② 每组「全选本组/取消本组」的 id 列表派生自**该组 items**（不是全量在线列表）—— 否则「全选本组」会静默选中别的组；③ 过滤框 +「已选 N / 共 M」+「清空选择」，且过滤状态 setter **确实**在 `input.onChange` 体内（只判「有输入框 + 有 needle」是空断言：把 `onChange` 体掏空仍会全绿）；④ 离线成员被渲染成行、行内不得有可勾复选框、必须有带可访问名的显式移除控件，且离线集合仍是「已选 − 在线」的派生（裁定 #66 的行为契约）；⑤ 组内开关用 `groupEnableLabel`、`GroupRow` 体内不得再出现 `enableLabel`（组页曾整段沿用全局页的「启用全局提示词」文案）；⑥ 选择器作用域内不得出现 `overflow:auto|scroll` 规则（平台约定「滚动归外壳」）。**CI**：新 job `session-picker-assert`（`node scripts/session-picker.assert.mjs --selftest`），`publish-npm.needs` 10 → **11**（`.github/workflows/npm-publish.yml`）。
    **它不证什么**：只证**源码文本结构** —— **不证勾选时序/延迟、不证 Pill 与开关的真实像素观感、不证浏览器端到端**（`/api/*` 对裸访问一律 `401`，取不到带 token 的渲染）。真机观感只能由人类所有者复验（与第 10/13 条同一约束）。
    **为什么进 `publish-npm.needs`**：按第 12 条同一标准 —— 零外部输入（只读本仓库 `client/client.js`，破坏在 `os.tmpdir()` 副本上做），它的红只有**一个动作**（要么选择器漂了、要么门自身要维护），故与 `request-guard` / `scope-identifiers` 同判。
    **升级时的连带动作**：本门钉的是**我们自己**的文本 ⇒ 平台侧改（`ui-primitives` 的 `Checkbox` / `Switch` / `Pill` / `Menu` 形态或槽位契约变了）本门**不会自动红**；升级时须连带复看第 13 条那份原生快照，并复看第 4 条的真源文件。
    **为什么新立**：人类所有者 2026-09-28 指出组提示词页「还是很简陋…会话选择是直接显示的目前所有的在线会话」（原文见 `docs/agents/board/a.md` §215.1）；整改后需要一把能机械挡住「选择器结构再次退化」的尺子 —— 此前只有第 13 条管观感面，**没有任何门读选择器的结构**。

## E. 已知脆弱点（我们依赖了官方内部接口）

| 脆弱点 | 位置 | 说明 |
|---|---|---|
| Session log 入口平移到依赖官方 `sessionLogDownload` controller 接口 | `client/client.js:2712`（`ctx.get('sessionLogDownload')`）、平移件 `id: 'session-log-download-moved'` 在 `:2708`、`lib/log-reposition.js` | 官方改接口即失效，需同步 |
| **复刻件会随官方 UI 改版漂移**（0.1.6 官方已从胶囊按钮改为「⋯ 更多操作」菜单；2026-09-18 已同步，但仍是被动跟随） | `client/client.js:2560-2734`（log-reposition 模块整体；`primitives.Modal` 在 `:2623`、`primitives.Menu` 在 `:2652`、`IconEllipsisOutlineRegular` 在 `:2672`；遮蔽注册 `id: 'session-log-download'` 在 `:2698`）；漂移探测见 `scripts/dsh-log-ui.drift.mjs`（§D 步骤 8） | 官方 UI 变更后本插件仍渲染旧形态；官方在同一 cell 新增菜单项时还会被遮蔽吞掉 |
| 遮蔽依赖 cell shadowing 语义（更低 priority 重注册） | `client/client.js:2652,2672`（`primitives.Menu` / `IconEllipsisOutlineRegular`，**2026-09-28 重抽**） | 遮蔽崩溃时官方条目会优雅回退（abdicate），症状是「按钮重复出现」而非报错 |
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
| 5 | 可选服务改用 `ctx.inject`（`tools` / `webServer`），`sessionTitle`/`workspaceRegistry` 改为调用时惰性读取 | `lib/peer-message.js`（2026-09-28：`lib/web-restart.js` 已随 0.1.13 整功能移除） | loader 并发创建条目，apply 时刻 `ctx.get` 无顺序保证 → 工具/路由**永久静默消失** |
| 6 | UI 旋钮改走 `session-toolkit-ui` 命名空间（`config.client` 作为 base）——**0.1.7 起由本条替代**：全部用户数据与 `client.*` 改为条目 Config 的 `.volatile()` 字段，浏览器半经 `ctx.configForms.get('session-toolkit')` 读写 | 当时：`lib/ui-config.js`、`client/client.js`；现在：`lib/index.js`、`lib/identity.js`、`lib/global-prompt.js`、`lib/auto-resume.js`、`client/client.js` | client 条目无 config 通道、bundle 无 schemastery → 此前所有 `client.*` 配置键都是死键；0.1.7 的 harness 取消命名空间通道后，旧写法让设置面整体失效 |
| 7 | （**0.1.13 整功能移除**）重启链路明确 Windows 专有：`GET /api/restart` 回报 `available`，client 探测后隐藏入口，非 Windows `POST` 返回 501 | （原 `lib/web-restart.js`，0.1.13 已删）、`client/client.js` | 非 Windows 平台入口照常显示，点一次后覆盖层空转 90s 才报「未检测到重启」 |
| 8 | Session log 复刻件对齐官方 0.1.6 形态（「⋯ 更多操作」菜单 + 本地化文案） | `client/client.js`（log-reposition 模块） | 复刻的是旧版胶囊按钮，与官方 UI 分叉；且硬编码英文标签 |
| 9 | 客户端订阅修复：`sessionId` 进依赖；工作区/全局页的订阅只在「本地未编辑」时接受外部变更；工作区列表改为「活跃投影 ∪ 已配置」（`inactive` 分支不再是死代码），Remove 有可见提示、重新启用会清 `removed` | `client/client.js` | 切会话后浮层/开关读到别的会话状态；autosave 落地回退正在输入的内容；Remove 看起来没生效 |
| 10 | 新增提示词管线契约门（含 2 条负向对照），CI 新 job + 发布依赖 | `scripts/prompt.contract.selftest.mjs`、`.github/workflows/npm-publish.yml` | 上述 1/2/3 此前没有任何自动化门 |
| 11 | auto-resume 契约门新增「官方链路优先」断言与灵敏度对照 | `scripts/auto-resume.contract.selftest.mjs` | 新分支此前无覆盖 |

### 第二批（同日，使用者逐项裁定后追加）

| # | 修复 | 位置 | 说明 |
|---|---|---|---|
| 12 | `link:` 依赖改回可发布的 **semver 前置版本并集**（`^0.1.2-alpha.5 \|\| ^0.1.6-alpha.2` 等），并同步 `pnpm-lock.yaml` 的 importer specifier | `package.json`、`pnpm-lock.yaml` | `link:` 形态 tgz 内无本地路径，发布即产不出可安装的包；lock 与 manifest 不一致也会让 `--frozen-lockfile` 失败 |
| 13 | §F 依赖偏斜处置：根因是 caret 不跨 minor + 前置版本规则，区间已改；新增相对判据量测门 `scripts/dependency-skew.measure.mjs`（含 `--selftest`） | `package.json`、`scripts/dependency-skew.measure.mjs`、§F | 安装侧验收：`--profile <DSH_HOME>/profiles/web` 期望 `SKEW_COUNT=0` |
| 14 | （**0.1.13 整功能移除**）**macOS/Linux 服务重启可用**：无配置时按当前 argv 自重启（生成一次性 `/bin/sh`：SIGTERM→等 10s→SIGKILL→`cd` 原 CWD→`exec` 原命令，输出进 `dsh-web-restart.log`）；配置 `webRestart.scriptPath` 则交给用户脚本；`GET` 回报 `available`/`mode`/`platform`，脚本缺失或无法自重启时 `POST` **500 快速失败** | （原 `lib/web-restart.js`，0.1.13 已删）、`client/client.js`、两份 README | 之前非 Windows 平台入口形同虚设；现在 client 只在 **202** 进覆盖层，其余状态就地报错 |
| 15 | Session log 复刻件增加**双向漂移探测器** `scripts/dsh-log-ui.drift.mjs`（官方侧 7 条 + 插件侧 6 条锚点，`--selftest` 证明能报红） | `scripts/dsh-log-ui.drift.mjs`、§D 步骤 8、§E | 复刻件无法消除（插件不能 import 其它插件组件），因此把「静默过期」变成「升级时点名报错」 |

**本轮明确未做（保持与行为修复分离，逐条都有理由）**：

1. **不把 `dsh-tools` / `dsh-home-paths` 改成 peerDependency**：peer 只在 `autoInstallPeers:false` 的宿主里才等价于「用宿主那份」，而在 pnpm isolated 布局下能否解析到宿主实例取决于宿主 manifest 是否直接声明该包，**本环境无法验证**；改错会让插件在 import 期直接崩（拖垮整个 host 半，包括设置页）。区间并集先把「必然解析错版本」消掉，是否进一步改成 peer/external 留待装好的 profile 实测后再定（§B 已登记的同类未决项）。
2. **未把 0.1.5 发行线写进区间**：该线在 registry 的存在性无法离线核实，写进去有「安装直接失败」的风险，高于偏斜本身。
3. 两个安装侧工具（§D 步骤 7/8）**不挂 CI**：CI 只有插件仓库，没有已装 profile 与 harness checkout，挂上去只会得到 exit 3 的假红。
4. Session log 仍是**复刻件**（不是复用官方组件）：受限于插件无法 import 其它插件组件；本轮把它与官方 0.1.6 形态对齐，并加了漂移门。

## H. 已知边界（环境与标定类不确定性；**不是缺陷**，但影响判读）

> 登记时刻：2026-09-29 03:44:10 CST（裁定 #rc1-D-9②；`scripts/rc1-basis.assert.mjs` 的作者 D 在 `docs/agents/board/d.md` §100-D 主动提出、并声明他无法在 GitHub runner 上测）。

| # | 边界 | 来源与读数 | 对判读的影响 / 现有缓解 |
|---|---|---|---|
| 1 | **那道基座门的单条命令超时是「标定值」，依赖机器速度** —— 既没有单条耗时的上界读数，也无法在 CI 真实环境实测 | 该门原硬编码 300 秒；实测同一条命令在冷盘 / 并行跑两棵基座时取过 1099 秒 ⇒ 门曾**自己把命令掐断**，而对拍又把两侧残输出不同误读成「对依赖版本敏感」。现行：默认 600 秒 + `--timeout <秒>` 旋钮；CI 侧按裁定 #rc1-D-9① 用 1800 秒，并给该 job 加 `timeout-minutes: 90` | 若在更慢的机器上仍被掐断，门的输出会明确写「N 条命令两侧都被超时掐断（未对拍 ⇒ 未完成验证，不得读作通过）」并给**未完成（3）**，而不是冒充「对依赖版本敏感」。**读红条时先看它打印的当前超时值，再看差异**；只有一侧超时仍照旧判真差异 |
| 2 | 该门**真树形态的逐条耗时未被量化** | 2026-09-29 那次全绿真树跑漏了 `--verbose`，逐条明细一行未落盘（40 次执行的总 wall 为 2068 秒，其中 `TIMEOUT` 计数为 0） | **不得**用「总时间 ÷ 条数」反推单条上界（那是推断不是测量）；需要上界读数时重跑并带 `--verbose` |
