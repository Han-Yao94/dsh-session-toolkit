#!/usr/bin/env node
// 规程 ↔ 源码对拍门（A 派发 #80-D-1；真源 docs/agents/board/a.md §232；backlog = BL-055）。
//
// 要治的病：协作规程（docs/agents/**）里的**源码引文、行号、行数字面量**没有任何门在看。
// 实证（A 2026-09-28 现测）：章程写客户端 2,209 行（现盘 2,880）· lib/*.js 1,579 行（现盘 1,700）
// ·「7 个门 / 2083 行」（现盘 19 个顶层 scripts/*.mjs）· 引 lib/peer-message.js:112-113（真身在 :140-141）
// · followup 投递口径已废 4 天无人发现。
//
// ── 三类判据（只做机器可判定的部分）────────────────────────────────────────────
//   C1 文件:行号引用合法性 —— 被引文件须存在 · 区间不得倒序 · 端点不得越界（现盘行数一律现算）。
//      **不判**「引用的内容对不对」（那是人工判断，门不得代判）。
//   C2 行数字面量现算 —— 同一行同时出现「本仓库某文件路径」与「N 行」时，现算实际值比对。
//   C3 已废口径残留 —— followup 只允许出现在删除线或含豁免词的行；作废句式出现即 FAIL。
//
// ── 读法警告（我实测踩到，2026-09-28）────────────────────────────────────────
//   `--scan-root` **不是独立沙箱**：它只换扫描根，而花名册登记项、外部路径豁免、`文件:行号`
//   的提交号解释**一律按仓根解析**。所以拿一棵临时树当扫描根时，会同时冒出与被动判据无关的红
//   （实测 82~84 条 `[登记项已陈旧]` / `[外部豁免已陈旧]` / `[登记条数与命中数不符]` / `[本仓无此文件]`）。
//   ⇒ 判读任何"红"之前先确认**被测对象在不在视野里**，不要拿「有没有红」当作「判据有没有生效」的证据。
//
// ── 口径（每条都有实测依据，见 docs/agents/board/d.md §81）──────────────────
//   · 行数口径 = `wc -l`（数换行符）。**本仓文档里的行数字面量用的就是这个口径**（2026-09-28 逐条实测：
//     `lib/*.js` 字面写 1,700 而 `cat lib/*.js | wc -l` = 1700 · `client/client.js` 字面写 2,880 而
//     `wc -l` = 2880；boot/d-qa.md 自己也注明现测口径就是 `wc -l`）。若改用 `split('\n').length`，
//     同一批数字会**整体 +1 判红** —— 那是口径错，不是文档错。
//   · C1 视野 = `docs/agents/**/*.md`，**排除** `board/archive/**` 与 `.snapshots/**`：前者是快照归档
//     （行号本就按归档时点，不对齐现盘；实测 26 片里 6 处「越界」全是快照行号），后者是 A 的临时快照目录。
//     实测代价：排除掉 archive 会少 319 条合法引用与 12 条噪声，且规格点名的文件清单里没有它们。
//   · C1 解析：路径首段必须是**本仓顶层实体**才进入视野（`TOP.has(seg)` 或 `.github`），
//     解析顺序 = 仓根 → 本文所在目录 → `docs/agents` → `docs/agents/board`；无斜杠的裸 basename
//     才允许在上述目录里解析；其余一律「不在本仓视野」跳过，不算违规也不算通过。
//     实测：不做这层收紧时会凭空多出 26 条假越界（`dsh-app-boot/lib/index.js:1022` 被**同名**映射到
//     本仓 `lib/index.js`（126 行）—— 那是另一个包的路径，不是错号）。
//   · C2 判据收成**紧邻配对**：反引号里的路径之后（最多隔一层括号）紧接着 `N 行`。
//     撒成「同一行」实测假红一片（91 处）——字节数（`162,328 B`）、累计新增行数（`+16,145 行`）、
//     快照/峰值行数（`3,869 行`）、锚条数（`13 行之一`）都会被当成「该文件现在多少行」。
//   · C2 豁免词（三选一即可）：`会漂` / `现测` / `原写` —— 规程里用它们标注历史对照值。
//   · C2 另一条出路：**同一行出现的提交号当机器前提** —— 该行写 `N 行` 且同行某个对象里该文件恰好
//     `N` 行 ⇒ 那是历史快照的忠实转述，不是陈旧。实测：`docs/agents/backlog.md:47` 写
//     `scripts/group-prompt.contract.assert.mjs` 992 行，`git show 71f0a44…:<该门>` = 992 行 ⇒ 合法
//     （现盘 1,104 行是后来 `b72023b` 变多的）；`docs/agents/backlog.md:52` 写 `scripts/board-rotate.mjs`
//     2211 行，`049ced6`/`689f7e4` 时该文件 = 2211 行 ⇒ 合法。
//   · C3 作废句式只判**宣称口径**的形态（见 DEPRECATED 的定义），引述旧规则必须放行 ——
//     否则门会把「引述」判成「残留」（实测：`workflow-review-2026-09-28.md:97` 是在**转述**旧语义）。
//
// ── 本门能证明什么 ──────────────────────────────────────────────────────────
//   只证明：① 规程里每个 `path:NNN` 形引用在**现盘**可解析且不越界/不倒序；② 紧邻形态的 `N 行`
//   字面量与现盘一致（或有提交号/豁免词作前提）；③ 已废的 followup / 默认 inject 口径没有以
//   **宣称**形态残留在活动件里；④ 登记项本身没陈旧（花名册不是永久豁免区）。
// ── 本门不能证明什么（边界，不得读作通过）───────────────────────────────────
//   1) **不判引用的内容对不对** —— 例如「`:140-141` 真的是 followup 判据吗」只有人读得出来。
//   2) 不判裸形行号（`` `:140-141` `` 这类无路径前缀的），实测 1,427 处，且其归属靠「同行最近带路径形」
//      推断（该口径本身还有一笔待裁定），不能当判据。
//   3) 不扫 `board/archive/**` 与 `.snapshots/**`（理由见上）。
//   4) 不判「哪一行是谁写的」（EN-05 的另一半）—— 本门无会话日志，如实列为不可判定。
//
// 退出码：0 = 全部判据成立 · 1 = 有判据不成立（缺陷）· 2 = 装置没跑成 / 未评测态 · 64 = 用法错。

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, relative, dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const DOCROOT = join(ROOT, 'docs', 'agents');
const INVOKED_AS = process.argv[1] ?? '';
const SELF = 'prompt-contract.assert.mjs';
const SKIP_DIRS = new Set(['archive', '.snapshots']);

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_DEV = 2;
const EXIT_USAGE = 64;

// ── 花名册（C1 的元语言站点）───────────────────────────────────────────────────
// 为什么需要它：规程里有一批**正在引述/讨论一个错号**的站点（「这个号在 HEAD 里本来就不存在」
// 「我的对照 `client/client.js:300-200`」「转述不存在的文件」「负向对照 `client/client.js:99999`」）。
// 纯词法豁免不可行：同样形态的真陈旧站点（「本仓 `lib/index.js` **只有 108 行**」）与前缀完全一样 ——
// 实测两版启发式假阳性 ~80%，已撤。故改用**词法零容忍 + 显式登记**。
//
// 登记项按 **(文件, 记号, ctx)** 匹配，**不钉行号**（行号只作诊断信息）：
//   · `ctx` = 命中行 ±3 行窗口内必须出现的一段站点特有文本；「站点特有」由生成器实测（不在任何**其它**
//     站点的窗口里出现；允许出现在同站点的窗口里）。
//   · 行号一改就假红的那版已按裁定 #81① 废弃 —— 实测它多抓不到任何真缺陷（站点内容变了 ctx 自然失配），
//     却会在维护者每次编辑 board/a.md、backlog.md 之后假红，而假红会让门被忽略。
//   · **计数**：每个 (文件, 记号, ctx) 的登记**条数**必须与扫描命中数相等。这是为文本上不可区分的
//     站点对留的唯一区分手段 —— 实测有两对（`backlog.md` 的 `lib/index.js:851-853` ×2、
//     `board/d.md` 的 `README.zh.md:1021` ×2）连 ±3 行窗口都是同一段文本，任何 ctx 都会互相命中。
//   · 每条登记项必须**至少消费掉一个真命中**（ctx 在某个命中的窗口里出现过），否则报红（fail-closed）——
//     站点被改写（ctx 消失）或删除 ⇒ 必红；无关编辑（同文件别处增删行）⇒ 仍绿。
//   · `ctx` 为空 ⇒ 装置配置错，`validateRegistry()` 拒绝（自检必须证明这一点）。
//   · 登记项所在文件**不在视野里**（忠实 CI 语料只有 1 份 .md）⇒ **跳过并计数**，绝不读取（否则崩溃）。
//
// 登记表**由枚举结果生成**，不手写（9 个 (文件,记号) 里有一个 token 跨 5 行、count 2/3/6 三种，
// 手写必然再错一次）。生成器与逐条 ctx 的唯一性验证见 docs/agents/board/d.md §82。
const META_ENTRIES = [
  // 17 处站点 = 13 个可区分签名 + 2 对文本不可区分（各按 2 条登记）
  { file: 'docs/agents/backlog.md', token: 'lib/index.js:851-853', ctx: "| **BL-030** | 2026-09-26 22:06:31 CST", why: '越界', note: '省略包名的裸路径（实指另一个包 dsh-app-boot）在本仓同名文件里越界' },
  { file: 'docs/agents/backlog.md', token: 'lib/index.js:851-853', ctx: "| **BL-031**<br>✅ **已关闭** | 2026-09-26 22:40:03 CST", why: '越界', note: '同上（与 BL-030 那处文本不可区分，靠条数区分）' },
  { file: 'docs/agents/backlog.md', token: 'client/client.js:99999', ctx: '（行号超出被引文件自身行数）此刻判 PASS/EXIT 0 ⇒ 改判 **FAI', why: '越界', note: '负向对照用例：故意写的越界号' },
  { file: 'docs/agents/board/a.md', token: 'README.zh.md:1021', ctx: ' 全 0）⇒ 它们是 **D §53.3 替代表里的条目标识**、从未进过表体 ', why: '越界', note: '元语言：该号在 HEAD 里本来就不存在' },
  { file: 'docs/agents/board/a.md', token: 'client/client.js:300-200', ctx: '5. 我核出的两处门边界：(i) **裸形降序区间漏检** —— 全表 26 个', why: '区间倒序', note: '负向对照：故意写的降序区间' },
  { file: 'docs/agents/board/a.md', token: 'lib/index.js:851-853', ctx: ' —— 那在本仓库同名文件里越界，且 app-boot 的 ', why: '越界', note: '元语言：引旧错号并说明它越界' },
  { file: 'docs/agents/board/d.md', token: 'lib/index.js:851-853', ctx: ' | （**保留**——这是**历史引用**，括注的是「当时写错的那个串」；**', why: '越界', note: '元语言：表内该行「原写不带包名的裸…」' },
  { file: 'docs/agents/board/d.md', token: 'README.zh.md:1021', ctx: '**但我必须修正 A 这份清单里的一项措辞**', why: '越界', note: '元语言：纠正「补丁清掉了它」的误读' },
  { file: 'docs/agents/board/d.md', token: 'README.zh.md:1021', ctx: '**但我必须修正 A 这份清单里的一项措辞**', why: '越界', note: '同上（两处文本不可区分，靠条数区分）' },
  { file: 'docs/agents/board/d.md', token: 'lib/index.js:851', ctx: ' 共 2 处（**表行 62**、**表行 89**）指向**空行**；该构造「', why: '越界', note: '转引表体自述的旧写法（短形）' },
  { file: 'docs/agents/board/d.md', token: 'lib/index.js:851', ctx: '- 能定位但该行是**空行** **3**（F-1 的 ', why: '越界', note: '同上' },
  { file: 'docs/agents/board/d.md', token: 'lib/index.js:851', ctx: ' 那个「越界」不是我的误报 —— 表行 145 **自己写着**那是「改正前」的', why: '越界', note: '同上' },
  { file: 'docs/agents/board/d.md', token: 'lib/index.js:851-853', ctx: ' 不是我的 bug**，是表行 145 自己明文标注的**改正记录**（原文：「', why: '越界', note: '讨论抽取器的幽灵条目' },
  { file: 'docs/agents/board/d.md', token: 'lib/index.js:851-853', ctx: ' 不是我的 bug**，是表行 145 自己明文标注的**改正记录**（原文：「', why: '越界', note: '同一行上出现两个反引号记号（实测位置 12 与 83），同一处站点记 2 条' },
  { file: 'docs/agents/board/d.md', token: 'lib/index.js:851-853', ctx: '（实测位置 12 与 83，同一 token ', why: '越界', note: '§82.3 引用该记号（自指：报告在写它自己）' },
  { file: 'docs/agents/board/d.md', token: 'lib/index.js:851-853', ctx: '（其中引了两次 ', why: '越界', note: '§82.7.1 自指复述' },
  { file: 'docs/agents/board/d.md', token: 'client/client.js:300-200', ctx: '- **⑤(i) 裸形降序区间漏检**：A 已准「另开一笔」，理由与他同（动抽取', why: '区间倒序', note: '转述那笔负向对照' },
  { file: 'docs/agents/board/d.md', token: 'lib/index.js:851-853', ctx: '）各记一次 ⇒ 明细打两遍（越界 8 条里 3 条是幽灵）。去重键 ', why: '越界', note: '讨论裸号归属口径的假阳' },
  { file: 'docs/agents/board/d.md', token: 'lib/index.js:851-853', ctx: ' | **真作者错误（3 条）** | 该行是 A 2026-09-26 的更正', why: '越界', note: '同上' },
  { file: 'docs/agents/board/d.md', token: 'lib/index.js:851-853', ctx: '（**符合「同行最近带路径形」的口径**），而它们语义上属于 app-boot。', why: '越界', note: '同上' },
];
// 登记项所在文件不在视野里时跳过并计数（忠实 CI 语料只有 1 份 .md ⇒ 现行版会直接 ENOENT 崩溃）
function validateRegistry() {
  const bad = [];
  for (const [i, e] of META_ENTRIES.entries()) {
    if (typeof e.ctx !== 'string' || e.ctx.length === 0) bad.push(`META_ENTRIES[${i}] ${e.file} 「${e.token}」 的 ctx 为空`);
    if (typeof e.token !== 'string' || e.token.length === 0) bad.push(`META_ENTRIES[${i}] 的 token 为空`);
  }
  for (const [i, e] of ALLOW_EXTERNAL.entries()) {
    if (typeof e.token !== 'string' || e.token.length === 0) bad.push(`ALLOW_EXTERNAL[${i}] 的 token 为空`);
  }
  return bad;
}function metaAllows() {
  const m = new Map();
  for (const [i, e] of META_ENTRIES.entries()) {
    if (!m.has(e.file)) m.set(e.file, []);
    m.get(e.file).push({ e, i });
  }
  return m;
}
// ── 外部路径豁免（C1「本仓无此文件」的登记项）──────────────────────────────────
// 为什么是登记而不是「放宽分类器」：现盘 17 处「本仓无此文件」**逐条看过，全是元语言站点或另一个包的产物**，
// 无一缺陷；但它们无法用「扩展名」类规则切干净 —— 本仓 `.ts`/`.tsx`/`.css` 各有 **0** 个文件，所以
// 「本仓没有这种文件类型」确实能把 `observation.ts`/`Button.tsx`/`PluginManagerPage.module.css` 类站点排除，
// 可 `lib/web-restart.js` 是**本仓删了的**文件、`peer-message.js`/`prompt-literal.js`/`global-prompt.js` 是
// **省略目录的裸 basename**（前者会随删除而误报，后两者随目录调整而误报）。与其造一条「会随仓库状态变脸」的
// 分类器，不如把它们**点名列清**，并要求每条登记项**至少消费掉一个真命中**，否则本门报红（fail-closed）——
// 这样将来路径真被写错时，登记项与站点不再匹配，门立刻红。
const ALLOW_EXTERNAL = [
  // 本仓没有这种文件类型（`.ts`/`.tsx`/`.css`/`.d.ts` 在本仓各 0 个）—— 引用的是另一个包（DSH harness）的源码/产物
  { file: 'docs/agents/board/b.md', token: 'observation.ts:44-49', note: '另一个包的源码' },
  { file: 'docs/agents/board/c.md', token: 'Button.tsx:11-15', note: '另一个包的源码' },
  { file: 'docs/agents/board/c.md', line: 746, token: 'PluginManagerPage.module.css:20', why: '另一个包的产物', note: '另一个包的产物（本仓无 .css）' },
  { file: 'docs/agents/board/c.md', line: 889, token: 'PluginManagerPage.module.css:20', why: '另一个包的产物', note: '同上（跨两行各一处）' },
  { file: 'docs/agents/integration-contracts.md', token: 'agent.ts:153-159', note: '另一个包的源码（同行 4 处并列，逐条登记）' },
  { file: 'docs/agents/integration-contracts.md', token: 'agent.ts:310', note: '同上' },
  { file: 'docs/agents/integration-contracts.md', token: 'agent.ts:312-347', note: '同上' },
  { file: 'docs/agents/integration-contracts.md', token: 'inbox.ts:109-114', note: '同上；同表带全路径的 `packages/core/agent-loop/src/agent.ts:160-174` 能正经解析' },
  { file: 'docs/agents/integration-contracts.md', token: 'controller.d.ts:31-58', note: '同上' },
  { file: 'docs/agents/workflow-review-2026-09-28.md', token: 'mailbox.ts:251', note: '同上' },
  // 被引的是「本仓的文档」但用了相对 docs/agents 的裸 basename
  { file: 'docs/agents/board/d.md', token: 'system-prompts.md:161-163', note: '实指 docs/agents/prompts/system-prompts.md（登记记号按真身原样）' },
  { file: 'docs/agents/board/d.md', token: 'c-client.md:18', note: '实指 docs/agents/boot/c-client.md' },
  { file: 'docs/agents/board/d.md', token: 'c-client.md:26', note: '同上' },
  { file: 'docs/agents/board/d.md', line: 1594, token: 'b-host.md:22', why: '裸 basename', note: '实指 docs/agents/boot/b-host.md（同一记号跨两行各一处）' },
  { file: 'docs/agents/board/d.md', line: 1596, token: 'b-host.md:22', why: '裸 basename', note: '同上' },
  // 元语言 / 负向对照站点
  { file: 'docs/agents/board/d.md', token: 'lib/web-restart.js:5', note: '该文件**已随「重启服务」整功能删除**，原文正是在记录它「已消失」' },
  { file: 'docs/agents/board/d.md', token: 'client/clinet.js:160', note: '负向对照：故意拼错的文件名（`clinet`）' },
];// ── 作废句式（C3）─────────────────────────────────────────────────────────────
// 「默认 inject」必须与「默认」同现才算**宣称**；「全队只有你用」是旧口径的独有字面。
const DEPRECATED = [
  { re: /默认\s*`?inject`?/, label: '默认 inject' },
  { re: /全队只有你(用|对)/, label: '全队只有你用 followup' },
];
// 引述/作废标记：命中行 ±2 行内出现任一，即认为是在**转述旧口径**或**宣告其作废**
const DEPRECATED_EXEMPT = /作废|已废|已不使用|已不用|不再有|不再使用|旧版|旧语义|原写|曾是|此前|当时|转述|引述|的原文|修正为|更正|旧规则|同族陈旧|口径已统一|已统一|已修正|改前是|仍写|未改文档|已改成|已改成/;
// followup 的豁免：删除线（偶数个 ~~）或含豁免词
const FOLLOWUP_EXEMPT = /已不使用|已不用|不再使用|已废|作废|口径已统一|已统一|已修正/;
// 「followup 是唯一通道」的宣称标记 —— 命中行 ±2 行内出现任一才算**宣称口径**。
// 为什么不能见 `followup` 就红（2026-09-28 实测：14 处命中**全是假阳**）：这个词在本仓既指
// **投递参数的值**（`` `wakeup:false` `` 与 `target.followup` 在代码里仍存在）、又指**历史记录里已发生的
// 一次投递**（`（followup，wakeup:false）`）、还是**评审文本里的提议**（`给 A 投一条 followup tick`）。
// 它们都不是「说 followup 是现在的通道」。真正的缺陷形态只有一个 —— **宣称它是现行/唯一通道**。
const FOLLOWUP_CLAIM = /只有|唯一|仅此|只能|专用|只给|独有/;
// 反引号内的内容不算「宣称」（那是字面量/标识符）。
// 注意**不能**直接把反引号内容替换掉再跑正则：那样连反引号本身也没了，
// `默认 \`inject\`` 这类句式就永远匹配不上（实测：自检 ④ 因此假绿）。
// 故改成保留原文、另交出「哪些位置落在反引号内」的遮罩。
function codeRanges(line) {
  const rs = [];
  const re = /`[^`]*`/g;
  let m;
  while ((m = re.exec(line))) rs.push([m.index, m.index + m[0].length]);
  return rs;
}
const inCode = (rs, i) => rs.some(([a, b]) => i >= a && i < b);

const C1_DIRECT = /`([\w.\/-]+\.[a-z]{1,5}):(\d{1,5})(?:\s*[-–—]\s*(\d{1,5}))?`/g;
const C1_LINK = /\]\(([^)\s]*?\.[a-z]{1,5}[^)\s]*?)#L(\d{1,5})(?:-L?(\d{1,5}))?\)/g;
const C2_RE = /`([\w.\/-]+\.[a-z]{1,5})`(?:\s*（[^）]{0,40}）)?\s*([0-9][0-9,]?)\s*行/g;
const C2_EXEMPT = /会漂|现测|原写|当时值|历史值|请现算/;
// ── C2 第二种形态：结构化统计注记「`路径`（指纹… / N B / N 行）」（裁定 #84③，2026-09-28）
//   与第一种形态的区别：行数**包在括号体里**（而 C2_RE 要求行数紧跟在「路径（可有可无的短括注）」之后），
//   所以 C2_RE 抓不到它。括号体必须是**紧随该路径**的那一个（A 的构造行实验：贪心/首个括号体版会命中
//   描述格，把 `backlog.md:110` 这种整行 3000+ 字符的表格行数错）。判据三件套齐全才判 —— 只有
//   「路径 + N B + N 行」三者同时在同一个括号体里才算「宣称该文件现在的指纹/字节/行数」。
//
//   ⚠️ 负向对照的教训（裁定 #84④ 要求写进门里，2026-09-28 实测踩到）：
//   负对照必须证明「被打中的正是判据指向的那个对象」，否则只证明了豁免有效 —— 甚至什么都证明不了。
//   三次实测：① 去掉某处「当时值」标记 ⇒ 该处被点名（有效）；② 把注记目标换成树内另一个文件
//   ⇒ 报红项正是那一处（有效）；③ 而用 `--scan-root` 指向一棵临时树想测「跳过」档时，花名册/外部豁免/
//   提交号解释都按**仓根**解析，于是同一跑里冒出 82~84 条与本档位无关的红（`[登记项已陈旧]`、
//   `[外部豁免已陈旧]`、`[登记条数与命中数不符]`、`[本仓无此文件]`）。
//   ⇒ 判读任何"红"的输出，先确认视野里有没有被测对象；对「我看的是不是那个对象」要单独取证，
//   不要用「有没有红」来代替。`--scan-root` 不是独立沙箱，它是"换一个扫描根，其余仍按仓根解析"。
const C2_NOTE_RE = /`([\w.\/-]+\.[a-z]{1,5})`（([^）]*)）/g;
const NOTE_FP = /[0-9a-f]{8,64}…/;
const NOTE_BYTES = /([0-9][0-9,]{3,})\s*B/;
const NOTE_LINES = /([0-9][0-9,]{1,})\s*行/;
const num = (s) => Number(String(s).replace(/,/g, ''));
/**
 * 从一行里抽出「结构化统计注记」，返回数组（一行可能多注记）。
 * 注记的语义 = 该括号体是**对现盘的宣称**；若括号体带历史/快照类标识（当时值·历史值·会漂·请现算），
 * 或该行整体带豁免词，则不算宣称（由调用方按 C2_EXEMPT 判定）。
 */
function noteForms(L) {
  const out = [];
  C2_NOTE_RE.lastIndex = 0;
  let m;
  while ((m = C2_NOTE_RE.exec(L))) {
    const body = m[2];
    const fp = body.match(NOTE_FP); const by = body.match(NOTE_BYTES); const li = body.match(NOTE_LINES);
    if (!fp || !by || !li) continue; // 三件套不全 ⇒ 不是这种「统计注记」
    out.push({ p: m[1], fp: fp[0], bytes: num(by[1]), lines: num(li[1]) });
  }
  return out;
}
const HASH_RE = /(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/g;

function wcLines(p) {
  return (readFileSync(p, 'utf8').match(/\n/g) ?? []).length;
}
function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}
function walkDocs(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const q = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkDocs(q, out); }
    else if (q.endsWith('.md')) out.push(q);
  }
  return out;
}
let TOP_CACHE = null;
function topLevel() {
  if (TOP_CACHE) return TOP_CACHE;
  TOP_CACHE = new Set(readdirSync(ROOT, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).map((e) => e.name));
  return TOP_CACHE;
}
// 解析一条被引路径：返回绝对路径（本仓内）· null（路径形但本仓无此文件）· undefined（不在本仓视野，跳过）
function resolveRef(p, docAbs) {
  const seg = p.split('/')[0];
  const cands = [];
  if (topLevel().has(seg) || seg === '.github') {
    cands.push(join(ROOT, p), join(dirname(docAbs), p), join(DOCROOT, p), join(DOCROOT, 'board', p));
  } else if (!p.includes('/')) {
    cands.push(join(DOCROOT, p), join(DOCROOT, 'board', p), join(ROOT, p));
    if (!p.includes('.')) return undefined; // 无扩展名的裸词（`client` / `scripts`）不当作文件引用
  } else {
    return undefined; // 首段不是本仓顶层实体 ⇒ 另一个包/另一棵树，不在本仓视野
  }
  for (const c of cands) if (isFile(c)) return c;
  // 裸 basename 的兜底：规程里普遍用省略路径的写法（`verify.selftest.mjs:78` 实指 `scripts/verify.selftest.mjs`、
  // `npm-publish.yml:252` 实指 `.github/workflows/npm-publish.yml`）。2026-09-28 实测：不兜底会凭空造出 22 条
  // 「本仓无此文件」假红。故**只在全仓恰好唯一命中**时算解析成功；命中 0 或 >1 一律仍判「本仓无此文件」。
  if (!p.includes('/')) {
    const hits = basenameIndex().get(p) ?? [];
    if (hits.length === 1) return hits[0];
  }
  return null;
}
let BASE_INDEX = null;
function basenameIndex() {
  if (BASE_INDEX) return BASE_INDEX;
  BASE_INDEX = new Map();
  const stack = [ROOT];
  const seen = new Set();
  while (stack.length) {
    const d = stack.pop();
    if (seen.has(d)) continue;
    seen.add(d);
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const q = join(d, e.name);
      if (e.isDirectory()) stack.push(q);
      else if (e.isFile()) {
        if (!BASE_INDEX.has(e.name)) BASE_INDEX.set(e.name, []);
        BASE_INDEX.get(e.name).push(q);
      }
    }
  }
  return BASE_INDEX;
}
function tokenOf(ref) {
  // 记号是**被引路径**:行号（不是引用所在的文档！），否则花名册永远对不上
  return `${ref.p}:${ref.a}${ref.b !== null ? '-' + ref.b : ''}`;
}
function gitShow(rev, relPath) {
  return execFileSync('git', ['show', `${rev}:${relPath}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}
function gitHasCommit(rev) {
  try { execFileSync('git', ['cat-file', '-e', `${rev}^{commit}`], { cwd: ROOT, stdio: 'ignore' }); return true; } catch { return false; }
}

// ── 扫描 ──────────────────────────────────────────────────────────────────────
function scan({ scratchDir = null, scanRoot = null } = {}) {
  const root = scanRoot ?? DOCROOT;
  const files = walkDocs(root).sort();
  const c1 = { violations: [], missing: [], outside: [], refs: 0, links: 0 };
  const c2 = { bad: [], verified: [], exempt: [], judged: 0, judgedNote: 0, noteOk: [], noteBad: [], noteUndecidable: [], exemptNote: 0 };
  const c3 = { bad: [] };

  for (const abs of files) {
    const rel = relative(ROOT, abs).split('\\').join('/');
    const lines = readFileSync(abs, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      // C1
      for (const [re, kind] of [[C1_DIRECT, 'backtick'], [C1_LINK, 'link']]) {
        re.lastIndex = 0; let m;
        while ((m = re.exec(L))) {
          const p = m[1]; const a = +m[2]; const b = m[3] ? +m[3] : null;
          if (!/[\w.\/-]+\.[a-z]{1,5}$/.test(p)) continue;
          const r = resolveRef(p, abs);
          if (r === undefined) { c1.outside.push({ file: rel, ln: i + 1, p, a, b, kind }); continue; }
          if (r === null) { c1.missing.push({ file: rel, ln: i + 1, p, a, b, kind, snippet: L.trim().slice(0, 120) }); continue; }
          const n = wcLines(r);
          let reason = null;
          if (b !== null && b < a) reason = '区间倒序';
          else if (a < 1 || b === 0) reason = '端点非法';
          else if (a > n || (b !== null && b > n)) reason = `越界（现盘 ${n} 行）`;
          if (kind === 'link') c1.links += 1; else c1.refs += 1;
          if (reason) c1.violations.push({ file: rel, ln: i + 1, p, a, b, kind, n, reason, snippet: L.trim().slice(0, 120), count: 1 });
        }
      }
      // C2
      C2_RE.lastIndex = 0; let m2;
      while ((m2 = C2_RE.exec(L))) {
        const p = m2[1]; const t = join(ROOT, p);
        if (!isFile(t)) continue;
        const v = +m2[2].replace(/,/g, ''); const n = wcLines(t);
        if (v === n) continue;
        c2.judged += 1;
        const rec = { file: rel, ln: i + 1, p, v, n, snippet: L.trim().slice(0, 160) };
        if (C2_EXEMPT.test(L)) { c2.exempt.push(rec); continue; }
        let rev = null;
        HASH_RE.lastIndex = 0; let h;
        while ((h = HASH_RE.exec(L))) {
          if (!gitHasCommit(h[0])) continue;
          try { if (wcText(gitShow(h[0], p)) === v) { rev = h[0]; break; } } catch { /* 该对象里没有这个文件 */ }
        }
        if (rev) c2.verified.push({ ...rec, rev }); else c2.bad.push(rec);
      }
      // C2（第二种形态）：结构化统计注记 —— 「路径」（指纹… / NNN B / NNN 行）三件套在同一括号体里
      for (const nf of noteForms(L)) {
        const t = join(ROOT, nf.p);
        // fail-closed 一档（裁定 #86⒝，2026-09-28 收口）：**本门不做「扫描根外跳过」**。
        //   路径一律按 ROOT 解析 ⇒ 解析不到**普通文件**的目标没有第二种正当语义：
        //   不存在（作者写错路径 / 目标被删）与存在但非普通文件（目录 / FIFO 之类，我原先误称
        //   「不在扫描根」—— 那是个不存在的语义，`--scan-root` 只换扫描根、不换解析基准）
        //   ⇒ 一律进「不可判定」臂 ⇒ EXIT 2，不得读作通过、也不得静默跳过。
        if (!isFile(t)) {
          c2.noteUndecidable.push({ file: rel, ln: i + 1, p: nf.p, why: existsSync(t) ? '存在但非普通文件' : '全仓不存在', snippet: L.trim().slice(0, 160) });
          continue;
        }
        const buf = readFileSync(t);
        const real = {
          hash: createHash('sha256').update(buf).digest('hex'),
          bytes: buf.length,
          lines: (buf.toString('utf8').match(/\n/g) ?? []).length, // wc -l 口径（与 wcLines 同）
        };
        const which = [!real.hash.startsWith(nf.fp.replace('…', '')) && '指纹', real.bytes !== nf.bytes && '字节', real.lines !== nf.lines && '行数'].filter(Boolean);
        c2.judgedNote += 1;
        const recNote = {
          file: rel,
          ln: i + 1,
          p: nf.p,
          fp: nf.fp,
          bytes: nf.bytes,
          lines: nf.lines,
          real,
          which,
          snippet: L.trim().slice(0, 160),
        };
        if (C2_EXEMPT.test(L)) { c2.exemptNote += 1; continue; }
        if (which.length === 0) c2.noteOk.push(recNote); else c2.noteBad.push(recNote);
      }
      // C3
      const inStrike = ((L.match(/~~/g) ?? []).length % 2) === 0 && L.includes('~~');
      const window3 = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
      const ranges = codeRanges(L);
      // 「followup 是唯一通道」的宣称：反引号外出现 followup + 窗口内有排他词 + 删除线/豁免词都不在
      const fu = /\bfollowup\b/.exec(L);
      if (fu && !inCode(ranges, fu.index) && FOLLOWUP_CLAIM.test(window3) && !inStrike && !FOLLOWUP_EXEMPT.test(L)) {
        c3.bad.push({ file: rel, ln: i + 1, kind: '作废句式「followup 是唯一通道」', snippet: L.trim().slice(0, 160) });
      }
      // 「默认 inject」：反引号内的 inject 字面量不影响判定（句式本身就带反引号），
      // 但不落在直引号/书名号引文里，窗口内又无引述/作废标记
      for (const d of DEPRECATED) {
        const mm = d.re.exec(L);
        let quoted = false;
        if (mm) {
          const before = L.slice(0, mm.index);
          const openQ = Math.max(before.lastIndexOf('「'), before.lastIndexOf('『'), before.lastIndexOf('“'));
          const closeQ = Math.max(before.lastIndexOf('」'), before.lastIndexOf('』'), before.lastIndexOf('”'));
          quoted = openQ > closeQ; // 命中点落在未闭合的引号里 ⇒ 是在引述旧文
        }
        if (mm && !quoted && !DEPRECATED_EXEMPT.test(window3)) {
          c3.bad.push({ file: rel, ln: i + 1, kind: `作废句式「${d.label}」`, snippet: L.trim().slice(0, 160) });
        }
      }
    }
  }
  return { files: files.map((f) => relative(ROOT, f).split('\\').join('/')), c1, c2, c3 };
}
function wcText(t) { return (t.match(/\n/g) ?? []).length; }

// ── 评测（把花名册应用到扫描结果；未消费的登记项 = 陈旧）──────────────────────
// 口径（裁定 #81①）：登记项 = **(文件, 记号, ctx)**，行号只作诊断。匹配步骤：
//   ① 按 (文件, 记号) 找**还有余量**的登记项（条数 = 站点数，见 META_ENTRIES 头注）；
//   ② 要求该命中的 ±3 行窗口里出现 ctx —— 这才是「是同一个站点」的证据；
//   ③ 消费掉该登记项（余量 -1）。余量 >1 是给文本不可区分的站点对留的唯一区分手段。
// 结果：无关编辑（同文件别处增删行）不影响读数；ctx 消失或站点被删 ⇒ 登记项消费不掉 ⇒ 必红。
// 同一行同一记号出现多次（实测 `board/d.md:2897` 上有两个反引号记号，同一 token）⇒ **算一处站点**，
// 但记下出现次数：登记表只给这一处一条登记项，消费次数按 count 累加。这不是「幽灵条目」——
// 我上一版按 (文件,行,记号) 去重时把它当成幽灵，结果门里留了一条永远消费不掉的登记项。
function collapseViolations(violations) {
  const m = new Map();
  for (const v of violations) {
    const k = `${v.file}|${v.ln}|${tokenOf(v)}|${v.kind}`;
    if (m.has(k)) m.get(k).count += 1;
    else m.set(k, { ...v, count: 1 });
  }
  return [...m.values()];
}
function evaluate(scanResult) {
  const perFile = metaAllows();
  const hits = collapseViolations(scanResult.c1.violations);
  const needBySig = new Map(); // (文件|记号) → 该签名的登记条数（按行归并后应等于站点数）
  for (const e of META_ENTRIES) {
    const k = `${e.file}|${e.token}`;
    needBySig.set(k, (needBySig.get(k) ?? 0) + 1);
  }
  const countBySig = new Map();
  for (const h of hits) {
    const k = `${h.file}|${tokenOf(h)}`;
    countBySig.set(k, (countBySig.get(k) ?? 0) + h.count);
  }
  const countMismatch = [];
  for (const [k, need] of needBySig) {
    const f = k.split('|')[0];
    if (!existsSync(join(ROOT, f))) continue; // 不在视野：跳过（不读、不判）
    const got = countBySig.get(k) ?? 0;
    if (need !== got) countMismatch.push(`${k}：登记 ${need} 条 vs 扫描命中 ${got} 处`);
  }
  // 剩余额度按**签名**（文件|记号）算：同签名登记了 N 条就允许消费 N 次 ——
  // 这是「同一行同一记号出现多次（如实测 2 次）」与「文本不可区分的站点对」共用的机制。
  const remaining = new Map(); // 签名 → 还能消费几次
  for (const arr of perFile.values()) {
    for (const { e } of arr) {
      const k = `${e.file}|${e.token}`;
      remaining.set(k, (remaining.get(k) ?? 0) + 1);
    }
  }
  const consumed = new Set();
  const kept = [];
  const linesCache = new Map();
  for (const v of hits) {
    const tok = tokenOf(v);
    let hit = -1;
    const sig = `${v.file}|${tok}`;
    for (const { e, i } of perFile.get(v.file) ?? []) {
      if (e.token !== tok || (remaining.get(sig) ?? 1) <= 0) continue;
      if (!linesCache.has(v.file)) {
        const fp = join(ROOT, v.file);
        linesCache.set(v.file, existsSync(fp) ? readFileSync(fp, 'utf8').split('\n') : []);
      }
      const win = linesCache.get(v.file).slice(Math.max(0, v.ln - 4), v.ln + 3).join('\n');
      if (win.includes(e.ctx)) { hit = i; break; }
    }
    if (hit >= 0) {
      // 命中一处站点：额度扣（出现次数）次；同时把该签名下**尚未消费**的登记项逐条标为已消费
      const sig = `${v.file}|${tok}`;
      remaining.set(sig, (remaining.get(sig) ?? 0) - (v.count ?? 1));
      for (const { i } of perFile.get(v.file) ?? []) {
        if (consumed.has(i)) continue;
        if (META_ENTRIES[i].token !== tok) continue;
        consumed.add(i);
        if ((remaining.get(sig) ?? 0) <= 0) break;
      }
      continue;
    }
    kept.push(v);
  }
  const skippedMetaList = META_ENTRIES.filter((e) => !existsSync(join(ROOT, e.file)));
  const skippedMeta = skippedMetaList.length;
  // 跳过 ≠ 陈旧：所在文件不在视野（忠实 CI 语料里 docs/agents/** 全树未入库）就不该判红
  const stale = META_ENTRIES.filter((e, i) => !consumed.has(i) && existsSync(join(ROOT, e.file)));
  const externalFiles = new Set(ALLOW_EXTERNAL.map((e) => e.file));
  const skippedExternal = [...externalFiles].filter((f) => !existsSync(join(ROOT, f))).length;
  const consumedExt = new Map(); // 登记项下标 → 已消费次数
  const missingKept = [];
  for (const r of scanResult.c1.missing) {
    const tok = tokenOf(r);
    let hit = -1;
    for (const [i, e] of ALLOW_EXTERNAL.entries()) {
      if ((consumedExt.get(i) ?? 0) >= 1) continue;
      if (e.file !== r.file || e.token !== tok) continue;
      if (e.line !== undefined && e.line !== r.ln) continue; // 有行号的条目要求行号也对上
      hit = i; break;
    }
    if (hit >= 0) { consumedExt.set(hit, (consumedExt.get(hit) ?? 0) + 1); continue; }
    missingKept.push(r);
  }
  const staleExternal = ALLOW_EXTERNAL.filter((e, i) => (consumedExt.get(i) ?? 0) < 1 && existsSync(join(ROOT, e.file)));
  return { kept, stale, missingKept, staleExternal, skippedMeta, skippedExternal, countMismatch };
}

function fmtRef(v) {
  return `${v.file}:${v.ln} 「${v.p}:${v.a}${v.b !== null ? '-' + v.b : ''}」 ${v.reason} · 原文片段：${v.snippet}`;
}

function report(scanResult, ev) {
  const missingKept = ev.missingKept;
  const { c1, c2, c3 } = scanResult;
  const out = [];
  out.push(`扫描视野：${scanResult.files.length} 份 .md（docs/agents/**，排除 archive/.snapshots）`);
  out.push(`C1 抽取：带行号引用 ${c1.refs} 处 · markdown 链接形 ${c1.links} 处 · 不在本仓视野跳过 ${c1.outside.length} 处 · 本仓无此文件 ${c1.missing.length} 处`);
  out.push(`C2 现算：命中「路径 + N 行」不一致 ${c2.judged} 处 ⇒ 豁免词 ${c2.exempt.length} · 同行提交号可解释 ${c2.verified.length} · 无法解释 ${c2.bad.length}`);
  out.push(`C2 注记现算：命中「路径 + 指纹/字节/行数」三件套 ${c2.judgedNote} 处 ⇒ 与现盘符 ${c2.noteOk.length} · 豁免词 ${c2.exemptNote} · 对不上 ${c2.noteBad.length}（逐项列在问题清单）· 目标不可判定（不存在或非普通文件）${c2.noteUndecidable.length}`);
  out.push(`C3 已废口径：命中 ${c3.bad.length} 处`);
  out.push(`花名册（元语言站点）：登记 ${META_ENTRIES.length} 处 · 本轮消费 ${META_ENTRIES.length - ev.stale.length} 处 · 陈旧 ${ev.stale.length} 处 · 跳过 ${ev.skippedMeta} 条登记项（所在文件不在视野）`);
  out.push(`外部路径豁免：登记 ${ALLOW_EXTERNAL.length} 条 · 跳过 ${ev.skippedExternal} 条（所在文件不在视野）`);
  const problems = [];
  for (const r of missingKept) problems.push(`[本仓无此文件] ${r.file}:${r.ln} 「${r.p}:${r.a}${r.b !== null ? '-' + r.b : ''}」 · 原文片段：${r.snippet}`);
  for (const e of ev.staleExternal) problems.push(`[外部豁免已陈旧] ${e.file} 「${e.token}」 的登记项在本轮一个命中都没消费到（理由：${e.note}）⇒ 该站点已消失或路径被改动，请从 ALLOW_EXTERNAL 移除`);
  for (const v of ev.kept) problems.push(`[引用不合法] ${fmtRef(v)}`);
  for (const r of c2.bad) problems.push(`[行数字面量陈旧] ${r.file}:${r.ln} 「${r.p}」写 ${r.v} 行 · 期望 ${r.n}（现盘 wc -l） · 原文片段：${r.snippet}`);
  for (const r of c2.noteBad) problems.push(`[统计注记与现盘不符] ${r.file}:${r.ln} 「${r.p}」注记 = ${r.fp} / ${r.bytes} B / ${r.lines} 行 · 现盘 = ${r.real.hash.slice(0, 16)}… / ${r.real.bytes} B / ${r.real.lines} 行 · 对不上项：${r.which.join('+')} · 原文片段：${r.snippet}`);
  for (const r of c2.noteUndecidable) problems.push(`[统计注记目标不可判定] ${r.file}:${r.ln} 「${r.p}」⇒ ${r.why}（既不是"通过"也不是"跳过"） · 原文片段：${r.snippet}`);
  for (const r of c3.bad) problems.push(`[已废口径残留] ${r.file}:${r.ln} ${r.kind} · 原文片段：${r.snippet}`);
  for (const m of ev.countMismatch) problems.push(`[登记条数与命中数不符] ${m} ⇒ 站点被增删/改写，或登记多半条少半条`);
  for (const e of ev.stale) problems.push(`[登记项已陈旧] ${e.file}${e.line ? ':' + e.line : ''} 「${e.token}」（ctx=${JSON.stringify(e.ctx)}）在本轮一个命中都没消费到 ⇒ 该行已被改动或该站点已消失；若站点仍在（例如只是行号漂了），请把登记项的行号重新对齐，否则从 META_ENTRIES 移除`);
  return { out, problems };
}

function mainScan(scanRoot) {
  const cfgBad = validateRegistry();
  if (cfgBad.length) {
    console.log(`EXIT=2 装置配置错：${cfgBad.length} 处登记项不合法（ctx/token 不得为空）—— 这不是判据红，是装置没跑成`);
    for (const b of cfgBad) console.log('  ' + b);
    return EXIT_DEV;
  }
  const scanResult = scan({ scanRoot });
  if (scanResult.c1.refs + scanResult.c1.links === 0) {
    console.log('EXIT=2 未评测态：视野内一条带行号的引用都没抽到 ⇒ 判据按构造无法成立（fail-closed，不得读作通过）');
    return EXIT_DEV;
  }
  const ev = evaluate(scanResult);
  const { out, problems } = report(scanResult, ev);
  for (const l of out) console.log(l);
  // fail-closed（裁定 #86⒝，2026-09-28 合并为一档）：统计注记的路径按 ROOT 解析后不是普通文件
  // —— 不存在（作者写错 / 目标被删）或存在但非普通文件（目录 / FIFO 之类）—— 一律不可判定。
  // 这不是「通过」，也不是「跳过」：本门不做「扫描根外跳过」，「属于视野但不该判」在本门不可表达。
  // 处置权在引用者（改路径或加豁免词），不靠装置开口子。
  if (scanResult.c2.noteUndecidable.length) {
    console.log(`EXIT=2 不可判定：${scanResult.c2.noteUndecidable.length} 处统计注记的目标不是普通文件（不存在或非普通文件）⇒ 无法核对指纹/字节/行数（fail-closed，不得读作通过）`);
    for (const r of scanResult.c2.noteUndecidable) console.log(`  ${r.file}:${r.ln} 「${r.p}」⇒ ${r.why}`);
    return EXIT_DEV;
  }
  if (problems.length === 0) {
    console.log('RESULT: PASS —— 三类判据全部成立');
    return EXIT_PASS;
  }
  console.log(`RESULT: FAIL —— ${problems.length} 条判据不成立`);
  for (const p of problems) console.log('  ' + p);
  return EXIT_FAIL;
}

// ── 自检 ──────────────────────────────────────────────────────────────────────
function fixturePath(dir, rel) { return join(dir, rel); }
function writeFixture(dir, rel, text) {
  const p = fixturePath(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}
const SRC_FOR_C = { 'lib/mod.js': Array.from({ length: 20 }, (_, i) => `const x${i + 1} = ${i + 1};`).join('\n') + '\n' };

const PROBE_REL = `docs/agents/.d-${process.pid}-probe.md`;
const PROBE_SRC_REL = `scripts/.d-${process.pid}-src.js`;
const PROBE_SCRATCH = pathResolve('/tmp', `d-prompt-contract-${process.pid}`);
function probeCleanup() {
  for (const rel of [PROBE_REL, PROBE_SRC_REL]) {
    const p = join(ROOT, rel);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  if (existsSync(PROBE_SCRATCH)) rmSync(PROBE_SCRATCH, { recursive: true, force: true });
}
function runSelftest() {
  const cases = [];
  const devErrors = [];
  const scratch = PROBE_SCRATCH;
  const add = (name, ok, detail) => cases.push({ name, ok, detail });
  try {
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    // 造一份「假源树」：docs/agents 下放引用与字面量，被测源文件放在仓根同名相对路径下 ⇒ 用真仓的 ROOT 解析
    // （简化：C1/C2 的解析根是仓根，故测试用的被引文件必须**真的存在**于仓根 —— 用一个临时可写文件，
    //  路径取 `docs/agents/.d-prompt-contract-probe.md` 之外的**仓内**临时文件，测完删）
    const probeRel = PROBE_REL;
    const probeAbs = join(ROOT, probeRel);
    const srcRel = PROBE_SRC_REL;
    const srcAbs = join(ROOT, srcRel);
    // 被引源文件：10 行
    writeFileSync(srcAbs, Array.from({ length: 10 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
    const write = (body) => writeFileSync(probeAbs, body + '\n');
    const run = () => {
      const scanResult = scan({ scanRoot: DOCROOT });
      const ev = evaluate(scanResult);
      return { scanResult, ev, ...report(scanResult, ev) };
    };
    // ⑩ 正样本：一份干净引用（10 行文件的 :1-10）+ 一个合法字面量 ⇒ 本组不得报红
    write(`# probe\n\n- 引用 \`${srcRel}:1-10\`（合法）\n- \`${srcRel}\` 现测 10 行\n`);
    let r = run();
    const cleanOk = r.problems.filter((p) => p.includes(probeRel)).length === 0;
    add('⑩ 正样本：合法引用 + 合法字面量 ⇒ 无问题（负向对照的前提）', cleanOk, r.problems.filter((p) => p.includes(probeRel)).join(' | '));

    // ① 行号改越界 ⇒ 必红
    write(`# probe\n\n- 引用 \`${srcRel}:1-11\`（越界）\n`);
    r = run();
    const oob = r.problems.find((p) => p.includes(probeRel) && p.includes('引用不合法'));
    add('① 行号越界 ⇒ 必红', !!oob && /越界/.test(oob), oob ?? '（没报红）');

    // ①b 区间倒序 ⇒ 必红
    write(`# probe\n\n- 引用 \`${srcRel}:8-3\`（倒序）\n`);
    r = run();
    const rev = r.problems.find((p) => p.includes(probeRel) && p.includes('引用不合法') && p.includes('倒序'));
    add('①b 区间倒序 ⇒ 必红', !!rev, rev ?? '（没报红）');

    // ①c 被引文件不存在 ⇒ 必红
    write(`# probe\n\n- 引用 \`scripts/.d-no-such-file-${process.pid}.js:1\`（不存在）\n`);
    r = run();
    const miss = r.problems.find((p) => p.includes(probeRel) && p.includes('本仓无此文件'));
    add('①c 被引文件不存在 ⇒ 必红', !!miss, miss ?? '（没报红）');

    // ①d 不在本仓视野（外部包路径）⇒ 既不判红也不判绿（跳过）
    write(`# probe\n\n- 引用 \`dsh-app-boot/lib/index.js:999999\`（外部包）\n`);
    r = run();
    const outsideOk = !r.problems.some((p) => p.includes(probeRel) && p.includes('引用不合法'));
    add('①d 外部包路径 ⇒ 跳过（不判红）', outsideOk, r.problems.filter((p) => p.includes(probeRel)).join(' | '));

    // ② 行数字面量陈旧 ⇒ 必红
    write(`# probe\n\n- \`${srcRel}\` 7 行（实际 10）\n`);
    r = run();
    const stale = r.problems.find((p) => p.includes(probeRel) && p.includes('行数字面量陈旧') && p.includes('期望 10'));
    add('② 行数字面量陈旧 ⇒ 必红', !!stale, stale ?? '（没报红）');

    // ③ 去掉豁免词 ⇒ 必红（同一份内容，只加豁免词就该放行）
    write(`# probe\n\n- \`${srcRel}\` 7 行（会漂，历史值）\n`);
    r = run();
    const exOk = !r.problems.some((p) => p.includes(probeRel) && p.includes('行数字面量陈旧'));
    add('③ 加豁免词「会漂」 ⇒ 放行（与 ② 成对：去掉豁免词必红）', exOk, r.problems.filter((p) => p.includes(probeRel)).join(' | '));

    // ③b 三个豁免词逐个生效
    for (const w of ['现测', '原写']) {
      write(`# probe\n\n- \`${srcRel}\` 7 行（${w}的历史值）\n`);
      r = run();
      const ok = !r.problems.some((p) => p.includes(probeRel) && p.includes('行数字面量陈旧'));
      add(`③b 豁免词「${w}」 ⇒ 放行`, ok, r.problems.filter((p) => p.includes(probeRel)).join(' | '));
    }

    // ④ 作废口径粘回 ⇒ 必红（默认 inject）
    write(`# probe\n\n- 发给 A 的消息默认 \`inject\`，只开两个例外。\n`);
    r = run();
    const dep = r.problems.find((p) => p.includes(probeRel) && p.includes('已废口径残留') && p.includes('默认 inject'));
    add('④ 作废句式「默认 inject」粘回 ⇒ 必红', !!dep, dep ?? '（没报红）');

    // ④b followup 残留 ⇒ 必红
    write(`# probe\n\n- 只有 D 对 A 用 followup 通道。\n`);
    r = run();
    const fu = r.problems.find((p) => p.includes(probeRel) && p.includes('已废口径残留') && p.includes('followup'));
    add('④b followup 未豁免 ⇒ 必红', !!fu, fu ?? '（没报红）');

    // ④c 删除线与豁免词分别放行
    write(`# probe\n\n- 旧规则 ~~followup~~ 已不使用。\n`);
    r = run();
    const fuOk = !r.problems.some((p) => p.includes(probeRel) && p.includes('followup'));
    add('④c followup 带删除线 + 「已不使用」 ⇒ 放行', fuOk, r.problems.filter((p) => p.includes(probeRel)).join(' | '));

    // ④d 引述旧口径放行（±2 行窗口内有「旧版」）
    write(`# probe\n\n- §4.13.3 的旧版让「发给 A 的消息默认 \`inject\`」以省轮次。\n`);
    r = run();
    const quoteOk = !r.problems.some((p) => p.includes(probeRel) && p.includes('已废口径残留'));
    add('④d 引述旧口径（窗口含「旧版」） ⇒ 放行', quoteOk, r.problems.filter((p) => p.includes(probeRel)).join(' | '));

    // ⑤ 空视野 ⇒ EXIT 2（fail-closed）。自己造两个空形态：完全空的目录、只有 .md 但一个引用都没有的目录
    const emptyDir = join(scratch, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    const emptyScan = scan({ scanRoot: emptyDir });
    add('⑤ 空视野（0 条引用） ⇒ 未评测态，不得读作通过', emptyScan.c1.refs + emptyScan.c1.links === 0, `refs=${emptyScan.c1.refs} links=${emptyScan.c1.links}`);
    const noRefDir = join(scratch, 'noref');
    mkdirSync(noRefDir, { recursive: true });
    writeFileSync(join(noRefDir, 'plain.md'), '# 没有任何带行号的引用\n\n普通正文。\n');
    const noRefScan = scan({ scanRoot: noRefDir });
    add('⑤b 有 .md 但 0 条引用 ⇒ 同样未评测态', noRefScan.files.length === 1 && noRefScan.c1.refs + noRefScan.c1.links === 0, `files=${noRefScan.files.length} refs=${noRefScan.c1.refs}`);

    // ⑥ 花名册登记项未消费 ⇒ 必红（花名册不是永久豁免区）
    const before = META_ENTRIES.length;
    META_ENTRIES.push({ file: probeRel, line: 999999, token: `${srcRel}:1`, why: '自检注入', note: '自检注入：行号不存在' });
    write(`# probe\n\n- 引用 \`${srcRel}:1\`（合法，但登记项消费不到）\n`);
    r = run();
    const staleEntry = r.problems.find((p) => p.includes('登记项已陈旧'));
    add('⑥ 花名册登记项未消费 ⇒ 必红（花名册不是永久豁免区）', !!staleEntry, staleEntry ?? '（没报红）');
    META_ENTRIES.pop();
    add('⑥b 花名册长度复原', META_ENTRIES.length === before, `now=${META_ENTRIES.length}`);

    // ⑦ 花名册命中 ⇒ 放行
    META_ENTRIES.push({ file: probeRel, line: 3, token: `${srcRel}:11`, ctx: '是故意写的越界号', why: '越界', note: '自检注入' });
    write(`# probe\n\n- 负向对照 \`${srcRel}:11\` 是故意写的越界号。\n`);
    r = run();
    const allowed = !r.problems.some((p) => p.includes(probeRel) && p.includes('引用不合法'));
    const staleNone = !r.problems.some((p) => p.includes('登记项已陈旧'));
    add('⑦ 花名册命中 ⇒ 放行且不报陈旧', allowed && staleNone, r.problems.filter((p) => p.includes(probeRel)).join(' | '));

    // ⑦a 负向对照（裁定 #81①d）：ctx 为空的登记项 ⇒ 装置配置错（EXIT 2），不得读作通过
    META_ENTRIES.push({ file: probeRel, line: 3, token: `${srcRel}:11`, why: '越界', note: '自检注入·无 ctx' });
    const noCtxCode = mainScan(DOCROOT);
    add('⑦a ctx 为空的登记项 ⇒ 装置配置错（EXIT 2，非判据红）', noCtxCode === 2, `EXIT=${noCtxCode}`);
    META_ENTRIES.pop();

    // ⑦b 负向对照：行号对得上但**记号不符** ⇒ 不得放行（证明「登记项不是按行号无脑免死」）
    META_ENTRIES.pop();
    META_ENTRIES.push({ file: probeRel, line: 3, token: `${srcRel}:12`, why: '越界', note: '自检注入：记号故意写错' });
    r = run();
    const stillRed = r.problems.some((p) => p.includes(probeRel) && p.includes('引用不合法'));
    add('⑦b 登记项记号不符 ⇒ 必红（登记项不是按行号无脑免死）', stillRed, r.problems.filter((p) => p.includes(probeRel)).join(' | '));
    META_ENTRIES.pop();

    // ⑧ 基线：真视野上本门必须 PASS
    // 清场：把探针从盘上撤掉再量基线，否则量的是「探针残留」而不是现盘基线
    // （实测：留着探针会让 ⑧ 报一条 [引用不合法] —— 那正是 ⑦ 里临时登记项放行的那一处）
    writeFileSync(probeAbs, '# probe（空壳，仅为清场前保持路径存在）\n');
    rmSync(probeAbs, { force: true });
    rmSync(srcAbs, { force: true });
    const base = scan({});
    const baseEv = evaluate(base);
    const baseRep = report(base, baseEv);
    add('⑧ 现盘基线 ⇒ 0 条判据不成立', baseRep.problems.length === 0, baseRep.problems.slice(0, 3).join(' | '));
    console.log('  —— 现盘基线：C1 带行号引用 ' + base.c1.refs + ' · 链接 ' + base.c1.links + ' · 不在视野 ' + base.c1.outside.length + ' · 本仓无此文件 ' + base.c1.missing.length
      + ' ｜ C2 不一致 ' + base.c2.judged + '（豁免 ' + base.c2.exempt.length + ' · 提交号可解释 ' + base.c2.verified.length + ' · 无法解释 ' + base.c2.bad.length + '）｜ C3 命中 ' + base.c3.bad.length);
  } catch (e) {
    devErrors.push(e.stack ?? String(e));
  } finally {
    probeCleanup();
  }
  console.log('── 自检用例 ──');
  let pass = 0;
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' —— ' + c.detail}`);
    if (c.ok) pass += 1;
  }
  const failed = cases.length - pass;
  console.log(`\n自检：${pass}/${cases.length} 项成立 · 装置抛异常 ${devErrors.length} 项 · 判据不成立 ${failed} 项`);
  for (const e of devErrors) console.log('装置异常：' + e.split('\n').slice(0, 3).join(' / '));
  if (devErrors.length) return EXIT_DEV;
  if (failed) return EXIT_FAIL;
  console.log('RESULT: PASS —— 装置自检成立');
  return EXIT_PASS;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function usage() {
  console.log(`用法：node ${SELF} [--selftest | --scan] [--scan-root <dir>] | --help
  --selftest       自检（含负向对照）
  --scan           对 docs/agents/** 跑三类判据（默认动作）
  --scan-root <dir> 换一个扫描根（用于自检/对照）
退出码：0 通过 · 1 判据不成立 · 2 装置没跑成/未评测态 · 64 用法错`);
}
function cli(argv) {
  let mode = 'scan'; let scanRoot = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { usage(); return EXIT_PASS; }
    if (a === '--selftest') { mode = 'selftest'; continue; }
    if (a === '--scan') { mode = 'scan'; continue; }
    if (a === '--scan-root') {
      const v = argv[++i];
      if (!v) { console.error('用法错：--scan-root 缺参数'); return EXIT_USAGE; }
      scanRoot = pathResolve(v); continue;
    }
    console.error(`用法错：未知参数 ${a}`);
    usage();
    return EXIT_USAGE;
  }
  if (!INVOKED_AS.endsWith(SELF)) {
    console.error(`装置未跑成：本脚本必须以 ${SELF} 之名被调用（现为 ${INVOKED_AS}）`);
    return EXIT_DEV;
  }
  if (mode === 'selftest') return runSelftest();
  return mainScan(scanRoot);
}
process.exit(cli(process.argv.slice(2)));
