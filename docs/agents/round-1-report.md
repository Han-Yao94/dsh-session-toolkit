# 首轮团队运行台账（2026-09-10）

**基线**：`HEAD = 25c5626c`，工作区 `version = 0.1.7`
**机制**：4 个角色均为**独立顶层会话**（`list_sessions` / `send_to_session`），非 subagent
**本轮性质**：只读回报 + 一处文档改动。**无源码改动**，无 `lib/**`、`client/client.js` 变更。

---

## 1. 回报核验结果（4/4 全部到齐并通过）

| 角色 | 回报 | 核验方式 | 结论 |
|---|---|---|---|
| Host Dev | 零写入 + 5 项风险 | `git status --porcelain -- lib/` 空；`lib/**` 与 HEAD 字节一致；mtime 早于今日 8 天 | 通过 |
| Client Dev | 零写入 + 1 项方法论修正 | SHA256 `3BBB8F1E…` 与基线逐位相等；`rev-parse HEAD:client/client.js == hash-object` | 通过 |
| Tech Writer | 零写入 + 硬缺陷 g-1 | 我独立跑 `git show 3ef91ce:{package.json,README.md,README.zh.md}` + registry `gitHead` | 通过 |
| QA Engineer | 零写入 + L1 exit=0 + 负向矩阵 11/12 | 我复核 mtime 分段与远端默认分支 | 通过 |

**编排失误（记账，不掩饰）**：首轮我把「成员」误判为 subagent，`list_agents` 返回 `no subagents` 后据此下了错误结论。成员实为顶层会话，正确工具是 `list_sessions` / `send_to_session`。已修入协议 §1。

## 2. 已确认缺陷（按严重度）

### D1 · 已发布 npm 0.1.7 包内 README 自述 0.1.4【公开可见】
- `3ef91ce` 的 `package.json` = `0.1.7`，而同一 commit 的两份 README = `0.1.4`。
- registry `0.1.7.gitHead = 3ef91ce…`（与本地 commit 逐字符相同）；发布时间 `05:36:29Z`，而 README bump commit `25c5626` 提交于 `05:38:11Z` —— **bump 比发布晚 2 分 22 秒，从未进入任何已发布版本**。
- npm 网页正文（registry `readme` 字段）即那份 0.1.4 的 README。
- **撤回重发已无可能**：发布于 2026-09-03，已超 npm 的 72 小时 unpublish 窗口。
- 发现者 Tech Writer；我独立证实。

### D2 · 工作区新增的验证门段落，对 npm 消费者不可达【已修】
新增的 +9 行指引读者跑 `pnpm check` / `pnpm verify`，并在末句指向 `docs/agents/integration-contracts.md`；但 `files` 白名单不含 `scripts/` 与 `docs/`，**同一段里有两个消费侧不可达引用**。
- 更隐蔽的后果：已发布 0.1.7 的 `package.json` 连 `scripts` 字段都没有（registry 记录确认）；**下一次发布后**失败形态会从「命令不存在」变成「命令存在、脚本文件缺失」。
- 处置：`README.md` / `README.zh.md` L164 整行替换为范围限定句（裁定 #4）；EN/ZH 成对；numstat 保持 9/0 与 9/0；未加小标题、未改 L171。

### D3 · CI push 触发分支写错【待修】
`on.push.branches: [main]`，但 `refs/remotes/origin/HEAD -> origin/master`，`git branch -a` 中**不存在 `main`** → push 永不触发 verify。
（边界：`git ls-remote` 网络不可达，结论基于本地 remote-tracking refs，未做远端实时确认。）

### D4 · `scripts/` 未入库 → CI 首次必红【待人类决策】
CI 执行 `node scripts/verify.mjs`，而 `scripts/` 是 `?? scripts/`。同时 `docs/agents/**`（规则真源）也在 untracked。三个角色独立提出。

### D5 · `verify.mjs` 的 skip 假绿【待修】
pack 段 skip 时仍打印「全部检查通过」并 `exit 0` —— 最强的打包契约被静默跳过。假绿比缺检查更糟。

### D6 · 协议 §2 写权划分「不相交但不覆盖全仓库」
`cordis.patch.yml`、`.gitignore`、`pnpm-lock.yaml`、`LICENSE` 曾无主。发现者 Host Dev。已在协议 §2 补齐 + 确立「未列名文件 = 无主 = 禁写」。

### D7 · 工作流注入面与版本比对过宽【待修】
`TAG="${{ github.event.release.tag_name }}"` 直接内插 shell；`case "$TAG" in *"$VERSION"*)` 为子串匹配（`v0.1.70` 会误判一致）。发现者 QA Engineer。

## 3. 三条「测量仪器缺陷」（共同根因：验证手段本身未被验证）

| # | 表现 | 根因 | 发现者 |
|---|---|---|---|
| I1 | 整体指纹显示 `FP_EQUAL=False`，像有隐藏写路径 | `git status --porcelain` 每次调用改 `.git` 目录 mtime（短暂建删锁文件）→ 观测者效应 | Client Dev |
| I2 | 扫同形字得 27 个命中，**全是假阳性** | 本机为 Windows PowerShell 5.1，`Get-Content` 默认按系统 ANSI（GBK）解码 UTF-8 中文注释，字节落进西里尔区 | Tech Lead |
| I3 | 4 个负向用例 `exit=1`，但并非被测检查报红 | `Set-Content -Encoding utf8` 在 PS 5.1 上写 BOM，`JSON.parse` 抛 `\ufeff` → **退出码 1 ≠ 检查生效** | QA Engineer |

**由此确立**：任何负结果的「零命中/全绿」必须先有**阳性对照**；任何判定手段必须先证明**能报红**且**不改变被测对象**。

## 4. 协调机制缺陷

- **消息交叉 3 次**：Tech Writer 与我之间 3 次在途交叉，每次导致返工。根因是我在其交付在途时改口径。
  处置：**裁定编号**（#1–#5），成员按收到的最高序号执行并回执写明执行的是哪一条。
- **「未回复」≠「未在途」**：我据 `idle` + 零回复补投一次，事后证明其原报告已在途。正确做法是多等一轮。
- **角色简报基线漂移**：简报称「0.1.7 位于两份 README 的 L7 与 L166」，而工作区是 L7/L175 —— **简报按已发布 tarball 旧布局撰写**。
  含义：**每个成员都可能在带过期事实工作**。简报非 Tech Lead 文件族，**已上报，未处置**。

## 5. 待人类决策（已按 §6.4 停止追问）

| # | 事项 | 不做的话，代价是什么 |
|---|---|---|
| P1 | 是否补发 `0.1.8` | npm 网页会一直挂着自述 0.1.4 的 README |
| P2 | 是否做基线 commit | 规则真源 + 唯一验证门裸在 untracked，一次 `git clean -fd` 同时抹掉，而 `package.json` 指向缺失脚本 → 报「模块找不到」而非「代码有问题」 |
| P3 | 是否向「Agent团队组建与协作方案」追认那批未提交改动的归属 | `package.json`（Tech Lead 独占）上留一笔来源不明的改动 |
| P4 | 是否重生成 4 份过期角色简报 | 4 个成员继续拿过期基线开工 |

## 6. 未提交改动归属（mtime 分段结论）

- **09-04 簇**：`pnpm-lock.yaml` 10:15:09、`.gitignore` 12:01:25 → 属 09-04 的另一会话
- **09-10 簇**：`package.json` 13:42:31、`scripts/verify.mjs` 13:43:06、`.github/workflows/npm-publish.yml` 13:43:54、`docs/agents/collaboration-protocol.md` 13:55:15 → 属 09-10 的团队组建会话
- 共享 checkout 下**无法从产物判定写者**；分段只把范围缩小到「哪个时段」，不作归因。

---

## 7. 批次 B/C 结果与首轮收口（2026-09-10）

### 7.1 交付与验证（全部第一手）
| 项 | 结果 |
|---|---|
| L1 `pnpm verify` | **EXIT=0**（Tech Lead 在最终状态自跑，真实 tgz 18 文件） |
| 自测门 `verify.selftest.mjs` | **24/24，EXIT=0**（1 控制 + 19 报红 + 4 路径契约） |
| 登记处全量审计 | **27/27 登记值 = 当场重算值** |
| QA 三文件登记 | 按**三方一致**入册（报告值 ∩ TL 当场重算 ∩ 停手声明后重算） |

### 7.2 已修缺陷（对照最严重者）
- **验证门 skip 假绿**：修前 `exit=0` 且打印「全部检查通过」，修后 `exit=2` 且末行「未完成验证…不得读作通过」。
- **`docs` 检查集合包含语义**（`#6-EXT-1`）：修前「安装片段写旧版 + 他处写新版」可蒙过，修后**定向断言**在三种声明位逐个比对 `package.json` version，命中 0 处即拒绝放行。
- **门自身偶发假红**：`run()` 曾把 stdout/stderr 绑同一 fd，npm 的 stderr 提示混进 JSON → `JSON.parse` 抛错。**此前两次自测的"通过"实为时序侥幸**，已改双 fd。
- **契约编码冲突**：`USAGE` 与 `INCOMPLETE` 都想用 2——**该冲突由 Tech Lead 引入**，QA 保住 skip=2 的唯一含义并把用法错误挪到 sysexits `EX_USAGE=64`。最终契约 `PASS=0 / FAIL=1 / INCOMPLETE=2 / USAGE=64`。

### 7.3 仪器与方法缺陷（**同一根因：验证手段本身未被验证**）
| # | 表现 | 发现者 |
|---|---|---|
| 1 | `.git` 目录 mtime 观测者效应（`git status` 自身改它），差点报假警报 | Client Dev |
| 2 | PS 5.1 `Get-Content` 按 GBK 解码 UTF-8 → 27 个同形字假阳性 | Tech Lead |
| 3 | PS 5.1 `Set-Content -Encoding utf8` 写 BOM → 4 用例 `exit=1` 来自 `JSON.parse` 而非被测检查 | QA Engineer |
| 4 | 坏对照物：`.replace('E5E5B','E5B')` 把对照值本身改坏 | Tech Writer |
| 5 | 检索式检查未先证明能命中 → 三处假阴性（差一步发假警报） | QA Engineer |
| 6 | `PATH` 未恢复致 `$LASTEXITCODE` 残留，差点把 `exit=0` 当通过 | QA Engineer |
| 7 | 手打登记值比对（违反「禁止手打」）+ 把 `HEAD:<path>` 列误当登记身份 → 5 条假 DIFF | Host Dev |
| 8 | PS 5.1 GBK 误读复发（已记类型） | QA Engineer / Tech Lead |
**该形态在全部五名参与者身上都出现过。** 这不是五次疏忽，是同一套方法缺口在五个位置各自显形。

### 7.4 编排者（Tech Lead）自己的违规与错误
1. **散文哈希错值并传播**：`README.zh.md` 的 `idx13` 把 `B` 写成 `C`（另一变体还在 `idx15` 把 `C` 写成 `A` 并插入空格），两处都通过了长度校验；**该错值被成员复制进其报告**——**发送方即污染源**。登记处内的值经程序化审计为正确。
2. **广播内容不一致**：§10 全节广播时按角色定制，两个角色只收到部分条款。**定制化不算广播。** 由 Tech Writer 审计发现。
3. **两次过度归因**：判 Tech Writer「报告不实」（实为后续裁定使其失效）；判「#24 疑似投递丢失」（实为交叉/延迟）。
4. **登记取自移动靶**：在 QA 重写文件期间测量并拟登记其值。
5. **在他人全工作区检查窗口内写入**：导致 QA 自测门首次运行假失败。

### 7.5 交叉与通道（结论）
- 首轮消息**交叉 ≥ 8 次**（Tech Lead ↔ QA 约 5 次、↔ Tech Writer 3 次）。
- **无任何一例消息丢失**：所有"未回复/未送达"事后全部归入**交叉或延迟**。
- **有效实践**（QA 提出、已采纳）：**授权类裁定以「成员引用该裁定编号的动作消息」为生效凭据**，而不是"成员说没收到"——后者不可证伪（成员无法回读入站记录原貌）。
- 编号机制把"交叉 → 返工"降为"交叉 → 一次澄清"，但澄清本身仍有成本。

### 7.6 未消除风险（书面）
| # | 风险 |
|---|---|
| R1 | `scripts/**` 与 `docs/**` **仍未入库** → CI 首次必红，且一次 `git clean -fd` 可同时抹掉真源、验证门、自测门与台账 |
| R2 | 本沙箱**无可用 POSIX shell** → 一切依赖 bash 的 CI 逻辑无法本地预验证；Tag guard matrix 首次证据只能来自 CI |
| R3 | 自测门护栏**无法区分自写与他写**，会产出保守假失败 |
| R4 | 双语结构对等**无机械校验**（`verify.mjs` 只比版本集合与「本包当前版本」声明位） |
| R5 | 已发布 npm `0.1.7` 内 README 自述 `0.1.4` **未修复**（72h unpublish 窗口已过；补发阻塞在人工审批） |
| R6 | `.gitattributes` 缺位 → CI（LF）与本地（checkout 后 CRLF）走不同字节 |
| R7 | 角色简报按**已发布快照**撰写（引用 `L166` 而非工作区 `L175`），四名成员可能在带过期事实工作 |
| R8 | `baseline-registry.md` 自指缺口：**不登记自身哈希**，纳入版本控制前无机械保障 |
| R9 | 门与自测门的**作者即使用者**（自证），补偿控制为：逐条负向测试 + 退出码与原始输出为准 + 自测门自身可被证伪 + Tech Lead 保留推翻权（本表即书面记录） |

---

## 8. 首轮之后：auto-resume 契约断裂（2026-09-10 下午）

**触发**：用户报告「会话重启自动上线不管用了」。

**根因（静态契约确认 + 真实后端复现）**：`sessionPersistence.list()` 在 harness `0.1.5-alpha.1` 返回 `SessionPersistenceSnapshot[]`（header 在 `.header`），而插件按 `0.1.2` 的 `SessionHeader[]` 读 → `h.id` 为 `undefined` → `enabled["undefined"]` → 过滤结果恒空 → **启动恢复静默无动作（无异常、无报错、无日志）**。
**次要漂移**：`SessionHeader` **从无 `seedLength`**（`0.1.2-alpha.5` 即如此，前缀长度改为 `inheritedEventCount`）→ "空白会话不恢复"这条判据**从未生效**（插件容忍缺失，无硬断裂）。

**修复（Host Dev，`lib/auto-resume.js`，新身份 `8ABCB27DC493B322…`，7793 B）**：按形状归一化 `normalizeEntry()`（显式兼容新旧两契约，理由：同一份已发布代码会被新旧 harness 同时安装）；服务获取改为 `ctx.inject(['sessionPersistence'], cb)`（源码判据 `cordis/lib/index.js:1599`、`:1305-1343`）；未识别形状输出可诊断告警（治"静默"）。

**验证（Tech Lead 第一手）**：
- 合成探针（Host Dev 作者，**TL 亲手复跑**）：旧代码 `FAIL EXIT=1` / 新代码 `PASS EXIT=0`。
- 持久契约门（QA 作者，**TL 亲手复跑三态**）：旧代码 `6/8 EXIT=1`（红的两条正是契约违反）/ 新代码 `8/8 EXIT=0` / 用法错误 `EXIT=64`。**性质：按形状契约判别，不按代码身份判别**（旧代码在裸 header 那条仍 PASS）。
- 真实后端复现（Host Dev 证据，**TL 未复跑**）：真 jsonl 后端读 `~/.dsh/sessions` **副本** → 旧代码 targets=0、新代码 targets=10（10 条开关全部命中）。
- L0/L1：`pnpm check` 0、`pnpm verify` 0（TL 跑）。

**持久化**：`scripts/auto-resume.contract.selftest.mjs`（QA 作者，`1A8CCE65…`，15993 B）——**它是 `lib/**` 的非作者，且被明确要求不许照抄 Host Dev 的探针**。CI 新增独立 job，`publish-npm.needs = [verify, selftest, auto-resume-contract]`。

**已登记限制（非待办）**：① 已装 jsonl 后端不提供 `eventCount` → 空白会话判据**惰性**（不是回归，它从来没生效过）；**禁止发明 `sizeBytes` 阈值**（无测量支撑不上线）。② `ctx.inject` 的**真实时序**不在门覆盖范围（门用同步回调模拟"服务已在"）→ 归 L3。③ 门的已知未覆盖 5 项（含 `scope.watch` 的 false→true 路径、真实持久化后端）。

**本轮新增缺陷（已修，Tech Lead 的 `package.json`，新身份 `92EAC06EE85EEEC04AFD5F325784FFAD5338EEF8CD6B218CBBFC14F7E4AE9543`，1611 B）**：`peerDependencies` 曾点名 3 个在已装 profile 中**不存在**的包（`dsh-client-store` / `dsh-client-ui-primitives` / `dsh-client-ui-slots`）——它们由 shell 模块表种子提供，故 profile 内无实体。告警级；`strict-peer-dependencies=true` 时会变成安装失败。
**修法与理由（更正后）**：**只删 `@deepseek-ai/dsh-client-ui-slots`**——它是**死声明**（`client/client.js` 从未 `require` 它，只用 `ctx.get('slots')`，该服务由 shell 种子提供）。**`store` / `primitives` 保留**：二者确实被裸 `require`，且**在 registry 上公开可满足**（`0.1.2-alpha.5` 满足 `^0.1.2-alpha.1`），删掉只会让它们**从「有声明」变成「无声明」**。**未决**：改用 `dsh.client.external` 是否更贴切——因该键语义未对 harness 源码核实，不在本轮。

**契约表**：基线升为 `dsh-v0.1.5-alpha.1`（cordis `4.0.2`、schemastery `3.18.2`）；并注明旧基线 `0.1.2-alpha.1` 的 `dsh-session` **从未发布**，相关断言不可复核。

**方法论记录（本轮编排者自身）**：Tech Lead 在本轮犯下 **4 处**同形态错误——① 声称「已派发」而实际未发（虚假动作陈述）；② 用**自己会话的 TEMP** 搜探针 → 假阴性后宣称"探针可能已丢"；③ 散文哈希错值并传播给成员；④ 在成员写入窗口内测量并拟登记在飞值。

---

## 9. 编排者自身错误（第二轮登记，2026-09-10 晚）

§7.4 登记首轮 5 处，§8 尾登记首轮 4 处。本表登记**本轮新增**的 4 处，**全部为 Tech Lead 本人**，供 §10.3「Tech Lead 必须能被判错」对账：

| # | 错误 | 性质 | 处置 |
|---|---|---|---|
| E1 | 用 `npm view <pkg> version` 取版本——该命令**只返回 `latest` 标签**（不是版本列表）；这三个包的 `latest` 指向受限的 `0.0.1-rc.1`，于是得出「它们不是 npm 可装的 peer」 | **发送方即污染源（第二例）**：错结论被写进 `integration-contracts.md` §B 并对外广播 | 已改用 `npm view <pkg> versions --json` 重取；§B 改为「更正后版本」；取版本的唯一正确命令写进契约表 §D.6 |
| E2 | 以数值吻合（「83 = 83」）自称"独立复核通过" | **把同一仪器的两次执行当成两个来源**：两次都走 `Get-Content`，共享同一 GBK 缺陷 | 结论**撤回**；判据写入协议 §10.2-6——独立 = **方法独立**，两条路径须能**各自独立报红** |
| E3 | 契约表 **8 处**行号陈旧，其中 `README.zh.md` 的 4 处（`:203/:215/:217/:219` 全部 +9）**最初未被发现** | **清单式修补不完备**：成因是「被引文件任何一次编辑」，不是一次性事故 | 改为**每文件内容锚**（契约表 §0，12 条断言）；「锚绿 ≠ 行号正确」写入表头 |
| E4 | 我自己的编辑造成**第 3 次**行号位移（`package.json` 删 1 行 → 表内 `:43` 应作 `:42`） | 与 E3 同根因 | **本轮同批自查抓到并改正**——新机制（锚 + 删改后重核）的第一个实证 |
| E5 | 在 #52 广播中发出了 `integration-contracts.md` 的身份值 `59DC411A…`，**随后又编辑了该文件**（把 QA 的否证写进 §0） | **违反 §10.2-8**（身份值只在**已由带编号裁定定稿**后才外发）——我把「我此刻以为定稿」当成了「已定稿」 | 已在 #54 **同轮就地作废**该值并给出新值；代价是 Tech Writer 按旧值对拍得 MISMATCH、多花一轮 |
| E6 | 广播里的哈希**用了缩写**（`92EAC06E…4AE9543`），且**后缀长度不一致**（7/6/6/6 字符） | **违反 §10.2-9 的「禁转述 / 禁插分隔符」**：缩写本身就是转述 | Tech Writer 的 `Substring(56,8)` 比对因此**构造性失败**（四值全 DIFF）——**这一处不是它的错，是我的格式错**；已升级为协议明文（§10.2-9 补充） |

**E5 的代价由正确的一方承担，且它做对了**：Tech Writer 收到 MISMATCH 后**没有把它当噪声压掉**，而是**停手报告**并要求裁定。**那条报告是正确的**——那是一次**真写入**，不是假漂移。若我把它读作"报告干扰"，就会用"已作废"掩盖掉一个真实的观测。**该行为须予肯定。**
**新登记的方法缺口（非 Tech Lead 独有）**：Tech Writer 在 §六 核验时**读到了我的写入中间态**（`total 135` 行 vs 定稿 **148** 行）。**§六 的核验读取同样是测量**，与写入窗口重叠时读到的必然是中间态——**它随后的处置（报告为「不确定」、不据此下结论、不重读追逐移动目标）是正确形态**。该性质已补入协议 §10.2-10。
**135 → 148 已由算术闭合**：我的 `write` 产出 135 行，随后的 `edit` 替换 1 行、写入 14 行（净 **+13**）→ 148 行。**无异常——是我的两次写入跨过了它的读取。**

**E1 与 §7.4-1 同形**（错值 → 被文档/成员复制 → **发送方即污染源**）。该形态已出现**两次，且两次都在 Tech Lead 身上**。**已登记的补偿控制**：身份值只在带编号裁定定稿后外发（§10.2-8）、哈希程序化取值且**禁缩写**（§10.2-9）、取版本用 `versions --json`（契约表 §D.6）。
