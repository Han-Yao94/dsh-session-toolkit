# 基线登记处（baseline-registry）

**用途**：本仓库的「真源在何时是什么」需要一个可对拍的真源。团队成员共享同一 checkout、无文件锁，因此**任何声称「我没改」或「真源是这样的」都必须能被独立核验**。本文件登记基线值，并规定对拍口径。

**权威性**：本文件低于代码与 README。基线变化后必须**同轮更新本表**，否则它就是过期真源（比没有更糟）。

---

## 1. 对拍口径（**必读，违反则结论无效**）

只比**内容**，分三类：

| 类别 | 判据 | 命令 |
|---|---|---|
| **已跟踪 · 未修改** | git blob 相等（= 与 HEAD 一致） | `git rev-parse HEAD:<path>` == `git hash-object <path>` |
| **已跟踪 · 已改未提交** | **`git hash-object` == 本表 §3.5 登记值** | `git hash-object <path>` |
| **未跟踪承重件** | 内容 SHA256 **+ 字节域声明** | `Get-FileHash -LiteralPath <path> -Algorithm SHA256` |

**适用性限定（勿混用）**：「blob 相等」只回答「**这个文件相对 HEAD 有没有被改**」。对**已改未提交**的文件，`HEAD:<path>` 与 `hash-object <path>` **本来就应不相等**——这不是漂移，是设计。把「两值不等」读成「内容漂移」会得出错误结论（2026-09-10 实测：`HEAD:README.md` = `bcf54675…`，`hash-object README.md` = `18091f24…`，不等且正确）。
**真正的漂移判据只有一个**：当前身份 ≠ 本表登记的身份。

**为什么跟踪文件用 `git hash-object` 而不是 raw-byte SHA256（实测）**：本仓库 `core.autocrlf = true` 且**没有 `.gitattributes`**。磁盘上现有文件是 LF，但任何一次 `git checkout -- <path>` / `git stash` / `git restore` / 切分支或 tag，都会把磁盘字节变成 CRLF，而**内容未变**。raw-byte SHA256 会因此在下次 checkout 后**假报红**。
`git hash-object` 经 clean 过滤器把 CRLF 归一为 LF，**跨 checkout 稳定**。阳性对照（`%TEMP%` 临时仓库，同一文件先写 LF 再写 CRLF）：两次 `hash-object` 均为 `c0d0fb45c382919737f8d0c20aaf57cf89b74af8`，`STABLE_ACROSS_EOL = True`（且盘上确为 14 字节，证明第二次真是 CRLF）。
未跟踪文件没有 clean 过滤器，只能用 raw-byte SHA256——此时**必须声明字节域**：UTF-8、LF、raw bytes。

**永不把 `.git` 目录 mtime 纳入判据。** 理由（实测）：`git status --porcelain` 每次调用都会在 `.git` 内短暂建删锁文件，**只改目录 mtime，不留条目、不留 `*.lock`、`index` 内容与 mtime 均不变**。用 mtime 做跳变检测会把 git 自身的正常调用判成告警——假警报比漏报更贵，因为它让人开始忽略告警。

**也不要只信 `git diff` 为空**：CRLF 规范化可让 `git diff` 对字节差异沉默。blob 相等才是内容相等；而**跨 checkout 稳定的身份**只有 `git hash-object`。

**未跟踪文件登记有两类值**，用途不同：
- **SHA256（本文件登记）**：跨工具、跨会话可复核，用于「自某时点起未被改动」。
- **文件名 + 大小 + mtime**：仅用于**分时段**（缩小到「哪个时间窗」），**不用作判定写者**——共享 checkout 下无法从产物归因写者。

**基线测量必须与写者串行（2026-09-10 实测教训）**：写权排他只保证「同一文件族同一时刻只有一个**写者**」；它**不能**阻止 Tech Lead 在别人写入期间去**测量**那个文件族。本次实测：我在 QA Engineer 重写 `.github/workflows/npm-publish.yml` 期间跑了 `git hash-object`，把一个**在飞状态**当作基线记入本表——差一步就发布了一个取自移动靶的身份。
规则：**登记任何身份之前，必须先确认「该写者的全部文件族」都不在写入窗口内**（判据：mtime 是否落在最近一次已授权写入窗口内；或直接等到写者回执落地）。**测量与写入同样需要串行化。**
**粒度修正（2026-09-10 实测，由 Tech Writer 指出）**：原表述写的是「确认目标**文件族**」——粒度错了。**同一写者可以拥有多个文件族**（§2：QA Engineer = `scripts/**` + `.github/**`），按文件族确认必然漏掉兄弟族。本次实测形态：只标了 `.github/` 的在飞、漏标 `scripts/`，导致下一个读者拿 `scripts/verify.mjs` 对拍会得到 `MISMATCH → 停手报真源漂移`——**而真因只是该写者正在被授权写入**。这是登记处自身制造的假漂移。

**全工作区内容检查期间，所有写者（含 Tech Lead）必须静默（2026-09-10 实测）**：`scripts/verify.selftest.mjs` 的护栏会对**整个工作区**做跑前/跑后内容对拍（排除 `.git`/`node_modules`），用于证明自测门自己没有写入。该护栏**无法区分「自测门写了」与「别人写了」**。实测：我在 QA Engineer 的一次 141.7s 自测运行窗口内修改了本文件，**导致它的首次自测以 exit=1 失败**——一次由我制造的假失败（安静窗口复跑 20/20 通过）。
规则：**任何人对「全工作区内容」类检查的运行窗口，都是全局互斥区**。测前必须确认所有写者（**包括 Tech Lead 自己**）已停手。这条与本文件 §1 的「测量与写入串行」是同一条原则的两种表现。

**哈希的可采信口径 = 可复现校验，不是长度校验（2026-09-10 实测，由 QA Engineer 指出）**：长度校验（SHA256 = 64 位十六进制）**必要但不充分**——它抓不到一个字符的错。
实测两起反例，同一位（`idx13`：`B` → `C`）：一次在 QA Engineer 的报告字面值里，一次在 Tech Lead 的散文转述里（后者还在 `idx15` 另有 `C` → `A`，并插入了空格分隔）——**两处都通过了长度与字符集校验**。
规则：
1. **判据是「当场在来源文件上重算并与登记值 MATCH」**，不是与任何流转文本中的字面值比对。可执行形式：**程序解析本表登记值** → `Get-FileHash` / `git hash-object` 重算 → 逐项比对并定位逐位差异。**禁止手打登记值**。
2. **哈希一律程序化取值后原样粘贴**：禁止手打、禁止转述、禁止插入空格或分隔符。
3. **长度/字符集校验降级为粗筛**，不得作为采信依据——抓不到单字符错的校验不是校验（§5 在哈希上的同构）。
4. **实测污染链**：Tech Lead 散文中的错误字面值被成员复制进其报告 → **发送方即污染源**。故第 2 条对 Tech Lead 与对成员同等适用。
5. 本条规则的执行结果（2026-09-10）：**程序化全量审计 27 个登记值 → OK=27，DIFF=0**。

**「回执落地」不等于「停手」——登记的关闭条件必须是三方一致（2026-09-10 实测，由 QA Engineer 的一次实际写入证明）**：
原规则写的是「待写者**回执**落地后一次性重登记」。实测反例：QA Engineer 宣布「三个文件均已改完」并给出哈希（mtime 14:35:19 / 14:39:46），Tech Lead 当场重算一致后完成登记；**两分钟后它又写了两次**（14:43:08 / 14:43:20），使报告值与登记值同时失效。
连带后果：Tech Lead 在该窗口内运行 `verify.selftest.mjs`，其护栏命中「工作区内容变化」，两条路径用例退出码异常（读到了变化中的文件）——**该次运行双向无效，不能作为任何一方的证据**。
**修正后的登记关闭条件（三方一致）**：
1. ① 成员报告值 ∩ ② Tech Lead 当场重算 ∩ ③ **成员明确声明停手之后的再次重算** —— 三者一致，方可登记。② ≠ ③ 即判定窗口未闭。
2. **对称要求**：**宣布交付之后的任何写入，必须先声明「我恢复写入」**。原规则只要求"回执"，漏了"回执之后不得再写"这半句。
3. **操作约束**：**自测门（及任何全工作区内容检查）只能在真正静默的窗口运行**。两次实测命中均来自外部写者（第一次是 Tech Lead 自己，第二次是 QA Engineer），非自测门自写——护栏作出的是**保守假失败**，方向正确，不修改。

6. **本条规则的闭合记录（2026-09-10）**：QA Engineer 宣布交付后又写入两次（14:43，实为实现迟到的裁定 #11）、再第三次（14:47，修门自身缺陷）。其停手声明 + Tech Lead 运行前/运行后两次重算 + 报告值 **三者一致**后登记完成。**「回执」被实际证伪，「停手声明」才是关闭条件。**
7. **附带发现（缺陷类）**：该门的 `run()` 曾把 stdout 与 stderr 绑到同一个 fd，使 npm 的 stderr 提示混进机器可读 JSON → `JSON.parse` 抛错 → **偶发假红**；此前两次自测靠时序侥幸通过，即**"通过"曾是运气而非证据**。已改为双 fd（L92/L93）并只解析 stdout。
8. **首轮收口记录（2026-09-10）**：共记录 **8 例仪器/方法缺陷**，同一根因（**验证手段本身未被验证**），且**在全部五名参与者身上都出现过**——清单见 `round-1-report.md` §7.3；编排者（Tech Lead）自身的 5 项违规见 §7.4。
9. **通道结论**：首轮消息**交叉 ≥ 8 次**，**无任何一例消息丢失**（所有"未回复/未送达"事后全部归入交叉或延迟）。**有效实践**：授权类裁定以「**成员引用该裁定编号的动作消息**」为生效凭据——那条消息本身即回执，而"说没收到"不可证伪（成员无法回读入站记录原貌）。
10. **本表登记值的一次全量审计（2026-09-10）**：程序化解析本表 → 逐项 `Get-FileHash` 重算 → **OK=27，DIFF=0**。判定依据不是任何人转述的字面值。

## 2. 基线指针

| 项 | 值 |
|---|---|
| HEAD | `25c5626c0d80d7568cf331c16477c01067b50282` |
| 工作区分支 | `master`（远端默认分支亦为 `master`；**不存在 `main`**） |
| `package.json` 版本 | `0.1.7` |
| 已跟踪文件 | 21 个；与 HEAD 逐字节相同 **15** 个；不同 **6** 个 |
| 未跟踪承重件 | **8 个**（`git status --porcelain -uall` 实测）：`docs/agents/*.md` ×4、`pnpm-lock.yaml`、`scripts/verify.mjs`、`scripts/verify.selftest.mjs`、`scripts/auto-resume.contract.selftest.mjs` → 见 §3.0 与 §3 |
| 登记时点 | 2026-09-10（首轮团队运行收口时） |

## 3. 登记值（SHA256）

### 3.0 在飞清单（**按写者**，不是按文件族）

**任何写者处于已授权写入窗口内时，其全部文件族的身份都不得登记、也不得用于对拍。** 判据按**写者**确认（见 §1 粒度修正）。

| 写者 | 状态 | 涉及文件族 | 窗口证据（mtime） |
|---|---|---|---|
| QA Engineer | **窗口已关闭**（2026-09-10）—— 该写者曾在其交付声明之后**又写入三次**（14:43、14:47、**15:02:45**），每一次都由其**停手声明 + 三方一致**核验后关闭 | `scripts/**`、`.github/**` | 关闭判据：报告值 ∩ TL 两次重算（间隔 ≥15 s）逐位相同。末次窗口 T0 `15:04:23` == T1 `15:04:38`；`pnpm verify` EXIT=0、`selftest` 24/24 EXIT=0 |
| Host Dev / Client Dev / Tech Writer | 无写入窗口 | — | 常态规则：除带编号派发外不写任何文件 |

**处置规则（长期有效）**：任何写者处于已授权写入窗口内时，其全部文件族的身份**不登记、不参与对拍**；待其**明确声明停手**后由 Tech Lead **一次性重登记其全部文件族**。
**本表记录事件，不声称现状（2026-09-10 修订，由 Host Dev 指出）**：原 §3.0 曾写「当前状态：…未确认停手」——该句与同表行的「窗口已关闭」以及 §3.1/§3.2 的实际登记**互相矛盾**，且**「当前状态」句天然会过期**（写下即开始腐坏），与本表自述的「不更新 = 过期真源，比没有更糟」冲突。故此后只记 **关闭时点 + 关闭判据**，不写"当前"。
**最近一次关闭**：2026-09-10 收口轮 —— QA Engineer 于 `15:42:26` 停手（`scripts/**` + `.github/**`）；Host Dev 于 `15:35:50` 停手（`lib/**`）；Tech Lead 于本轮 `docs/agents/**` 写入后停手。更早窗口：QA `15:04`。

### 3.1 与 HEAD 不同的已跟踪文件（6 个）
| 文件 | HEAD blob | 工作区 blob | SHA256 |
|---|---|---|---|
| `.github/workflows/npm-publish.yml` | `2a4766d3…` | `ac63304e…` | `6A79E9CBE2F3FD1104A82319B1D6AB8D97EB5BFE08D8BFDD590CA477869A7B28`（5067 B） |
| `.gitignore` | `46dcacfb…` | `c7f0b67b…` | `09B4119A78DF477B6BD65247E11FBE2F45717033E24CC14271D6F9FAA572A230` |
| `README.md` | `bcf54675…` | （见下） | `0F4FC4166611663892013CD98E4839D7702BB5C5E5B27E678D10BE5203833031` |
| `README.zh.md` | `eae454fa…` | （见下） | `4AC4FA397A965BDCBA9D84395BBA157C54EA53EC9EABC2805AC3EF0B51F6DD77` |
| `package.json` | `b8677d06…` | `12afa286…` | `3BEE832B01B5937E175908E74C902A8D0D2BE903DA78C840868FB857D162E6A4` |
| `lib/auto-resume.js` | `c3a03842…` | `e5c39ea6…` | `8ABCB27DC493B32293539AC1FE72C7177428F4339336183AE955D0EDD35FE733`（7793 B；2026-09-10 裁定 #31 修复 auto-resume 契约断裂） |

> **在飞说明（2026-09-10，已闭合）**：该文件在 QA Engineer 的裁定 #6/#10/#11 批次中曾被反复写入。中间值 `8FD28A02…` 与 `D6C2BDD6…` **一律作废，不得用于对拍**（它们分别是批次前与改写在途的状态）。
> 现值 `6A79E9CB…`（5067 B，mtime 15:42:26）由 QA Engineer 在裁定 #35 落盘（新增 `auto-resume-contract` job + `publish-npm.needs` 三项），Tech Lead 于 15:43:38 当场重算一致 —— 该行**有效**；`4DD5CC48…` **已作废**。

### 3.2 未跟踪承重件（缺一即无法核验「未被改动」）
| 文件 | SHA256 |
|---|---|
| `docs/agents/collaboration-protocol.md` | `6B31E2AF14EA9336B2E6222F424DA240D8A5EB1FE7F229247BCC1A04357B5AD2`（20027 B） |
| `docs/agents/integration-contracts.md` | `6643588ABB7238F0A67E4D667C620833F553BB488FFBE76090B3D7AADC7C4163`（11817 B） |
| `docs/agents/round-1-report.md` | `36D652C5818FA810EF4AFF481E89551649D7DFC9F4CB641D662B739A76B7B809`（15337 B） |
| `scripts/verify.mjs` | `AC95C1EDE366B8C44F85E353CF4BB997F87EB7DD67AE413CD52DA097F5A5B3FA`（16569 B，mtime 14:47:26） |
| `scripts/verify.selftest.mjs` | `2A8428EED00852779AA2BCB157F095301935AB08CED7A87B0C4F67956AD2A614`（18782 B，mtime 15:02:45） |
| `scripts/auto-resume.contract.selftest.mjs` | `1A8CCE6577BE273B881A52F565B3EBDDA583196E9C80C52E9BF274DCEEA08ECA`（15993 B，mtime 15:40:24） |
| `pnpm-lock.yaml` | `CEEE50CC2F7EAD1FA09C3B8592340B0038653216FECE392FAC832BE8BC7F818B` |

### 3.3 与 HEAD 相同的已跟踪文件（15 个，供「未被改动」核验）
| 文件 | SHA256 |
|---|---|
| `client/client.js` | `3BBB8F1E2367F74930535C1C0C203CB30F53B618221B35BF91BB848414E70FBA` |
| `cordis.patch.yml` | `9CB32E70D0C4C98255D83F7BF7D1D67F0B2803E88676B864D9FA84E4A4C2D826` |
| `lib/dsh-web-restart-launcher.vbs` | `4A5A6D5724037B7C461E0A5D7A7CB5E7C610BD50F81AF143A7A56A825FEA0996` |
| `lib/global-prompt.js` | `CB52396F9F9A76C011435FC1E1642D0AE6120CC8DB45E90DACB928FE315550F7` |
| `lib/identity.js` | `BB9AF687BAC5592462A3B7E0CBFA31049C155F5D679060B18D1B59ECAF4E04FD` |
| `lib/index.js` | `417A0E7EBD50736DC84CF965A2CF97DD3E21B7494C2D42D68C8AED1C624EE6F3` |
| `lib/log-reposition.js` | `491282BF9C233C5449E96C3F203663B59B63A229AA22CEF48E5931E49CD0B03E` |
| `lib/peer-message.js` | `861E7BCDE1197D098E14784DB7C531DE04337A3286A35F3DCE0B006F1E08D9D1` |
| `lib/plaintext.js` | `A9A0C0F45DD4F5F92E7FB14C047A4C578627D6FC0C5DEBEF653AE8F886672637` |
| `lib/prompt-dedup.js` | `6D97DED1B7A7C043C74F4F3D5DAE7F9EDD765EC51E98050757FFE79A5224C481` |
| `lib/sanitize.js` | `4994CCEC02236F623D39292D0C8C92C18A46F6D9C73CEF50A3385B1F786B7053` |
| `lib/web-restart.js` | `46BED0C1760FBEB92CAFB8270B3234CFC8C46D60DC934F32114017920DE75E26` |
| `LICENSE` | `41380201A8F1D3E6C57844E0A601A3E481DF6FB4E00B78536FAD17984E642FC0` |
| `README.i18n.yaml` | `8A929D3E428EA93432B8186A784A1A2BE4960E99476E800F1129E5FD308A9D90` |
| `.github/workflows/npm-publish-github-packages.yml` | `77DEB19D44EB033B049C828180B0C85824B4F0C2C1AC5E7392EF2D3BE5CE0BF2` |

### 3.4 自指说明
本文件**不登记自身的哈希**——它无法把自己写进自己。该缺口**是现在时，不是将来时**：本文件此刻仍未跟踪（`?? docs/agents/baseline-registry.md`），所以它的完整性**现在就没有机械保障**，属未消除风险。纳入版本控制后才由 §1 的 blob 对拍覆盖。

### 3.5 已改未提交文件的**稳定身份**（`git hash-object`，跨 checkout / CRLF 翻转不变）
本轮的 **6** 个已改文件，其 `hash-object` 与 `HEAD:<path>` 天然不等（见 §1 适用性限定）。**判漂移请用本表**：

| 文件 | `git hash-object`（登记身份） | `HEAD:<path>`（仅供判断是否被改） |
|---|---|---|
| `.github/workflows/npm-publish.yml` | `ac63304e63b319b73c1e20be87c14fe9d16ff04c` | `2a4766d38913eac7de6ddc5ef138ca76d8d2c302` |
| `.gitignore` | `c7f0b67be3b09e74a0f92d5f7ed9b18bdade91c8` | `46dcacfbee20bd20df99f82d243d5eb711934b72` |
| `README.md` | `18091f24de3c9742804cb2937b2c2f4485cc4680` | `bcf54675374b39d7ab0206926112908e3dd4f6cd` |
| `README.zh.md` | `7c3d2d2c15a746b6d3b885b4cd43913cfc915816` | `eae454fa33ca8c17852ff792220a1abd1ef0219f` |
| `package.json` | `12afa286c12993de90045bac11ee622677cce93d` | `b8677d06fbe241cbf1def901630ff1d0462a5125` |
| `lib/auto-resume.js` | `e5c39ea6beaac63d0dfdc66c4d296a9d03f79dfd` | `c3a038429908ea58227ae1e11ea7b86ab9436a2f` |

### 3.6 已知缺口：`.gitattributes` 缺位（未处置）
本仓库**没有 `.gitattributes`**，因此行尾策略完全依赖各机器的 `core.autocrlf`（本机 = `true`）。后果：
1. 已由 §1 的 `git hash-object` 口径吸收（登记处不再因此假报红）；
2. **未消除**：CI（ubuntu，LF）与本地（checkout 后 CRLF）走不同字节。任何将来基于**内容比较**的断言都可能因此分化。Host Dev 与 QA Engineer 各自独立提出过这一点。
3. `.gitattributes` 在协议 §2 的写权表中**原无归属**（属「未列名 = 无主 = 禁写」）。本处仅登记该缺口，**不代表已授权创建**——是否引入行尾归一化是仓库级字节变更，需单独决策。
## 4. 变更记录（相对首轮会话起点的漂移）

首轮基线固化于 2026-09-10 团队运行开始时。此后**唯一经授权的改动**：

| 文件 | 起点 SHA256 | 现 SHA256 | 原因 | 授权 |
|---|---|---|---|---|
| `README.md` | `5A0B6B3F…` | `0F4FC416…` | L164 加入范围限定句 | 裁定 #4（Tech Writer 落盘） |
| `README.zh.md` | `1E7CDE53…` | `4AC4FA39…` | 同上，EN/ZH 成对 | 裁定 #4 |
| `docs/agents/collaboration-protocol.md` | `B598160E…` | `37C2758D…` | 补 §1 机制事实、§2 写权覆盖 + **读权公共** + `.gitattributes` 归属、§5 仪器验证铁律、§6 裁定编号与对拍口径、§10 证据与协作纪律（12 条）、**§10.1-1 广播须同一份内容 + 摘要须明示** | Tech Lead（本文件族） |
| `docs/agents/round-1-report.md` | （新增） | `35AFA888…` | 首轮台账 + **§7 批次 B/C 结果、8 例仪器缺陷、编排者违规、交叉与"无丢失"结论、R1–R9 未消除风险** | Tech Lead（本文件族） |
| `.github/workflows/npm-publish.yml` | `8FD28A02…` | `4DD5CC48…` | W1 注入面、W2 显式枚举、W3 删 `id-token`、W4 permissions、D3 分支名、新增 selftest job 与 tag guard matrix | 裁定 #6/#10/#11（QA 落盘） |
| `scripts/verify.mjs` | `B7B3BC0B…` | `AC95C1ED…` | 退出码四态契约（skip → exit 2，不再假绿）、异常路径收口、docs 定向断言、**双 fd 修复偶发假红** | 裁定 #6/#10/#11/#6-EXT-1（QA 落盘） |
| `scripts/verify.selftest.mjs` | （新增） | `2A8428EE…` | **24 条自测门**（1 控制 + 19 报红 + 4 路径契约）；含 A/B 两处文档修正 | 裁定 #6/#11/#6-EXT-1/#24/#26（QA 落盘） |
| `lib/auto-resume.js` | `E45D9F6B…` | `8ABCB27D…` | **auto-resume 契约断裂修复**：`list()` 快照形状归一化（显式兼容新旧两契约）+ 服务获取改 `ctx.inject` + 未识别形状告警 | 裁定 #31（Host Dev） |
| `scripts/auto-resume.contract.selftest.mjs` | （新增） | `1A8CCE65…` | **启动恢复契约门**（三态可证伪：旧代码红 / 新代码绿 / 变异体红）；按形状契约判别，不按代码身份 | 裁定 #34（QA 落盘） |
| `.github/workflows/npm-publish.yml` | `4DD5CC48…` | `6A79E9CB…` | 新增 `auto-resume-contract` job；`publish-npm.needs` 升为三项 | 裁定 #35（QA 落盘） |
| `docs/agents/integration-contracts.md` | `C73D5740…` | `6643588A…` | 基线升 `dsh-v0.1.5-alpha.1`；§A 拆出 `ctx.inject`/`list()` 形状/`SessionHeader` 三行；§B/§C 逐行更新；登记 peer 声明缺陷 | 裁定 #32（QA 供文本，Tech Lead 落盘） |
| `docs/agents/round-1-report.md` | `35AFA888…` | `36D652C5…` | 增 §8：auto-resume 契约断裂全过程与已登记限制 | Tech Lead |

**自起点起发生变化的文件（全部经授权）**：`README.md`、`README.zh.md`（Tech Writer，裁定 #4）；`collaboration-protocol.md`、`baseline-registry.md`、`round-1-report.md`（Tech Lead，本文件族）；`.github/workflows/npm-publish.yml`、`scripts/verify.mjs`、`scripts/verify.selftest.mjs`（QA Engineer，裁定 #6/#10/#11/#6-EXT-1）。
**其余文件自起点起逐字节未变**，其中 `client/client.js` 与 `lib/**` 全部与 HEAD 相同——两个开发面本轮零改动。
`docs/agents/integration-contracts.md` 与 `scripts/verify.mjs` 的哈希由 **Client Dev 与我两个独立方在不同时点取得同一组值**，构成第三方交叉确认。

**注意**：`.gitignore` 与 `pnpm-lock.yaml` 属 **09-04 簇**（mtime 09-04 10:15 / 12:01），与 09-10 的团队组建批次（13:42–13:55）不同源。分段只缩小时间窗，**不作写者归因**。

## 5. 使用规则

1. **动手前读真源**：成员执行任何任务前读本目录 `docs/agents/**`，并在回报里**附上所读文件的 SHA256**。
2. **不一致即停手**：哈希与本表不符时**停止执行并报告**，不得按磁盘版或记忆版自行取舍。
3. **Tech Lead 维护**：任何经授权的改动落地后，同轮更新 §3 与 §4。**未更新 = 本表已失信**。
4. **对拍不是归因**：本表能证明「文件变没变、变成什么」，**不能证明「谁改的」**。共享 checkout 下写者归因只能靠各会话自报 + 时序分段。
