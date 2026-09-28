#!/usr/bin/env node
/**
 * contract-line-drift.assert.mjs —— 契约表行号引用的「陈旧性」机械判定
 *
 * 它回答的唯一问题：
 *   契约表里编号到**本工作区内某个文件**某一行的引用，在基线改动之后，
 *   那个行号是否还指向同一份内容？
 *
 * 为什么不是「行号对不对」：
 *   docs/agents/integration-contracts.md:14 自己声明「行号不得作为判据，只用于首次跳转；
 *   唯一判据是 §0 内容锚」。因此本门**不判**「行号指向的构造语义对不对」——那条路已被
 *   该表 :16-25 实测否证（勿重试）。本门只判一件事：这条引用是否已**落在另一个字节位置**上。
 *
 * 机制（与该表 :27 留的那条路同一机制）：
 *   1. 取基线版本内容（`git show <rev>:<file>`）与现场工作区内容；
 *   2. 用 `git diff --unified=0 <rev> -- <file>` 求稳定映射：基线行 L 若在两版里逐字
 *      相同则映射到它现在的行号 m(L)，否则 m(L) = null（被删/被改 ⇒ 不可判）；
 *   3. 对每条引用 (基线行号 L)：m(L) 存在且 m(L) !== L ⇒ **陈旧**（内容搬到 m(L) 了）。
 *
 * 退出码：0 = 无陈旧引用 · 1 = 有陈旧引用 · 2 = 装置跑不成（未评测）· 64 = 用法错误
 *
 * ⚠ 已知边界（不得读作「全对」）：
 *   1. 只覆盖「因改动而漂移」，不覆盖「一开始就指错」：某行若在基线里本就指错构造，
 *      且两版之间没动，本门看不见。
 *   2. 只覆盖**基线 → 现场**这一次映射。基线之后的第二次改动不在视野内。
 *      （已知坑：对已映射过的表再跑一次 apply 会二次平移；本门不 apply，只判。）
 *   3. 只判工作区内存在的被引文件。契约表里大量引用指向宿主平台源码树
 *      （packages 下、dsh-xxx 目录下等，本工作区没有这些文件）⇒ 这类引用不在本门判据内，
 *      单独列为「不在视野」。这是本门最大的边界，不许读作「全表都验过了」。
 *   4. 裸形引用（同行 `NNNN,NNNN` 续列）与带路径形引用**口径不同**：裸形依赖
 *      「同行最近一个带路径引用」来归属文件，是启发式；带路径形是确定的。
 *   5. **行号帧约定**：表里的行号是按**某一版文件**的视图写下的（帧）。本门只在那份
 *      帧版本 == 基线时才在判「表陈旧」；若基线属于另一个帧，读数不是「表陈旧」而是
 *      **帧错配**（表可能已按新帧重抽，却按旧帧的视图读号）⇒ 那种红会被后加的
 *      `frameNote` 明确标注，**不得**读作「表里有这么多陈旧引用」。
 *   6. 空行对空行的引用：`'' === ''` 对**任意**一对空行都成立 ⇒ 判据分辨不出「同一片
 *      空白的同一处」与「A 文件第 5 行的空行 = B 文件第 99 行的空行」。若判为陈旧，
 *      是**判据不充分（evidenced-by-luck）**：案子可能真是搬了位置，但门拿不出支持
 *      自己的证据。已知缺口，未修。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const TABLE = 'docs/agents/integration-contracts.md';

const USAGE = `用法：
  node scripts/contract-line-drift.assert.mjs [选项]

选项：
  --table <path>       契约表路径（默认 ${TABLE}，相对仓库根）
  --baseline <rev>     基线版本（默认 HEAD）
                       ⚠ 基线必须是**表所书写的那个帧**（表里那批行号对应的版本）；
                         基线不属于该帧时读数会标为「帧错配」，那种红不得读作「表陈旧」。
  --ref-root <dir>     被引文件的解析基准（默认仓库根）。引用按**仓库根相对**书写
                       （如 client/client.js），跨仓库的表才需要它。
  --quiet              只打摘要，不打明细
  --all                明细不截断
  --selftest           装置自检：注入已知陈旧引用必须报红，注入正确引用必须不变红
  --help               打这份用法

退出码：0 = 无陈旧 · 1 = 有陈旧 · 2 = 未评测 · 64 = 用法错误
`;

const liveDirs = [];
function mkLiveDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  liveDirs.push(d);
  return d;
}
function cleanup() {
  for (const d of liveDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
}
function git(args, cwd = ROOT) {
  // stdio: stderr 必须吞掉——git 的 fatal（比如路径在仓库外）会直接漏进门的输出、污染读数。
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 某个路径所属的 git 仓库根（不是仓库内的路径则返回 null）。多个 --table 可能来自不同仓库。 */
function gitRepo(p) {
  try {
    const r = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dirname(p), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return r === '' ? null : r;
  } catch { return null; }
}
function splitLines(text) {
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), trailingNewline };
}

/**
 * 帧错配判定：本门只在「基线 == 表所书写的帧」时判「表陈旧」。
 * 基线若非该帧，读数含义从「表陈旧」变成「帧错配」——表可能已按新帧重抽，却按旧帧视图读号。
 * 那种红**不得**读作「表里有这么多陈旧引用」，故必须显式告警，不许静默给出。
 * 另附：基线 → HEAD 之间**视野内**被引文件有改动，也提示（表若按基线写，这些文件的号已随之漂移）。
 */
function frameMismatchNote(baseline, resolved, inScope, tableDrift) {
  const baseSha = resolved.baselineSha;
  const headSha = resolved.headSha;
  const short = (s) => (s ?? '?').slice(0, 12);
  const notice = (kind, lines) => ({
    kind,
    baseline: baseSha ? short(baseSha) : String(baseline),
    head: headSha ? short(headSha) : '?',
    files: lines,
  });
  if (baseSha && headSha && baseSha !== headSha) {
    // 跨仓库的表：本仓库的 HEAD 不是它的画面帧 ⇒ 明确标 sameRepo=false，
    // 让 render 把「这个告警对跨仓库表不成立」讲出来，而不是让人误以为表真的错帧。
    const sameRepo = resolved.sameRepo !== false;
    return {
      kind: 'mismatch',
      sameRepo,
      baseline: baseSha ? short(baseSha) : String(baseline),
      head: headSha ? short(headSha) : '?',
      files: sameRepo ? (inScope ?? []).filter((f) => {
        try { return git(['rev-parse', `${baseline}:${f}`]) !== git(['rev-parse', `HEAD:${f}`]); } catch { return true; }
      }) : [],
    };
  }
  if (Array.isArray(tableDrift) && tableDrift.length) return notice('table-drift', tableDrift);
  return null;
}

// ---------- 契约表解析 ----------

/** 展开 `2406,2407-2409` 这类列表；降序区间（2566-2474）返回占位 NaN */
function expandNumbers(spec) {
  // 每项带 fromRange：区间展开项 vs 作者**逐个写下**的号。
  // 为什么要分：一条 `client/client.js:2560-2734` 一条区间就注入 175 项，
  // 与作者手写 175 个号的证据强度完全不同，计数混在一起会误导（裁定 #71④c）。
  const out = [];
  for (const p of spec.split(/[,，]/).map((s) => s.trim()).filter(Boolean)) {
    const range = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(p);
    if (range) {
      const a = Number(range[1]); const b = Number(range[2]);
      if (b >= a) { for (let n = a; n <= b; n += 1) out.push({ n, fromRange: true }); }
      else out.push({ reversed: `${range[1]}-${range[2]}` });
      continue;
    }
    if (/^\d+$/.test(p)) out.push({ n: Number(p), fromRange: false });
  }
  return out;
}

/**
 * 往前找第一个「被引文件真有改动块」的祖先基线（自检第二组/第四组共用）。
 *
 * 为什么不写死 `HEAD~1`：它是**相对裁判点**的，门前进一笔纯文档/门自身的提交就会让
 * `HEAD~1..HEAD` 没有被引文件的改动 ⇒ 第二组的装置前提被提交历史换掉 ⇒ 真身读数退化。
 * 找不到 ⇒ 抛错（**装置故障**，exit 2），绝不静默退化成同义反复。
 *
 * @returns {string} 形如 `HEAD~2`
 */
function findDiffBaseline() {
  const forced = process.env.CLD_DIFF_BASELINE;
  if (forced) return forced;
  for (let d = 1; d <= 8; d += 1) {
    try {
      const rev = git(['rev-parse', `HEAD~${d}`]).trim();
      const n = parseHunks(git(['diff', '--unified=0', '--no-color', '--no-ext-diff', rev, '--', 'client/client.js'])).length;
      if (n > 0) return `HEAD~${d}`;
    } catch { break; }
  }
  throw new Error('往前 8 个祖先里没有任何一笔对 client/client.js 有改动块'
    + ' ⇒ 找不到「真有 diff 的基线」，装置不成立（请用 CLD_DIFF_BASELINE 指定一条）');
}

/**
 * 抽引用：只认**表格行**（trimStart 后以 `|` 开头）。
 *   (1) 带路径形 `<file>:<nums>`（确定口径）
 *   (2) 裸形 `<nums>`（启发式：归属「同行最近一个带路径引用」的文件）
 */
function extractRefs(tableText) {
  const refs = [];
  const reversedRanges = [];
  const PATH_FORM = /(?<![\w.\/-])([\w.\/-]+\.[a-z]{1,4}):((?:\d+(?:\s*[-–—]\s*\d+)?)(?:\s*[,，]\s*\d+(?:\s*[-–—]\s*\d+)?)*)/g;

  tableText.split('\n').forEach((raw, i) => {
    const tableLine = i + 1;
    if (!raw.trimStart().startsWith('|')) return;

    // ⚠ 单元格边界（2026-09-28 实测撞出，**这是本门最要紧的一条口径**）：
    //   裸形号的归属必须是「**同格**内、最近的带路径引用」，不能跨格继承。
    //   实测误报：表:62 第三格的 `` `:287` ``/`` `:362` `` 被算到**行尾那一格**的
    //   `README.zh.md` 名下并报「越界/笔误」；真身是同一格里的
    //   `dsh-agent/lib/types/index.d.ts:139` 的续列号 —— 一个彻底的误报。
    //   有跨格继承时真表 26 条「越界/笔误」，全部是这一类；不修则本门天天误判作者。
    //   实现：按未被转义的 `|` 切格，记下每格的字符区间；命中位置 index 落在哪一格即该格。
    //   ⚠ 两条自证（我踩过的坑就藏在这里）：
    //     (a) `stripped` 必须与 `raw` **等长且位置对齐**（replace 用等长空格），否则 index 不可比；
    //     (b) 第一趟 PATH_FORM 在 `raw` 上跑、第二趟 BARE 在 `stripped` 上跑 —— 只要 (a) 成立，
    //         两者的 index 空间就是同一个，可以共用 cellMap 与 lastBareCell。
    //     我先前的实现漏了 (a)(b) 的对齐自证，导致同格号被判成跨格 ⇒ 归属被清空成 null。
    const cellMap = [];
    {
      const CELL = /(?:^|[^\\])\|/g;
      let prevEnd = null;
      let cm;
      while ((cm = CELL.exec(raw)) !== null) {
        if (prevEnd !== null) cellMap.push([prevEnd, cm.index]);
        prevEnd = cm.index + cm[0].length;
      }
      cellMap.push([prevEnd, raw.length]);
    }
    // ⚠ 死码（2026-09-28 复核）：归属改为**逐位归属槽** + `ownerAt` 之后，本函数与 `cellMap`
    //   都不再被任何地方调用（`grep -n 'cellOf(' ` 只剩这一处定义）。留着是为了让下文那段
    //   「我曾用格内查表算归属、实测 stripped 与 raw 不等长 ⇒ 整体错位」的记录有可对照的实物。
    const cellOf = (idx) => {
      for (let k = 0; k < cellMap.length; k += 1) if (idx >= cellMap[k][0] && idx < cellMap[k][1]) return k;
      return -1;
    };

    for (const m of raw.matchAll(PATH_FORM)) {
      const file = m[1];
      for (const n of expandNumbers(m[2])) {
        if (n.reversed) reversedRanges.push({ tableLine, file, form: 'path', text: n.reversed });
        else refs.push({ tableLine, file, line: n.n, form: 'path', expanded: n.fromRange });
      }
    }

    // ⚠ 归属分界（2026-09-28 实测撞出的**误归属**，根因就在这两趟之间）：
    //   表:62 的 `:362` 被算到**行尾那一格**的文件头（`README.zh.md`）名下并报「越界/笔误」，
    //   而它其实是第三格 `dsh-agent/lib/types/index.d.ts` 的续列号 —— 一个彻底的误报。
    //   ⇒ 归属不能**跨格**继承：BARE 这趟必须用**独立**变量从 null 起算，不得复用上面那趟的残值。
    // ⚠ ⚠ 这里踩过一次坑（记下来）：只写 `lastFile = null` 而上面声明的是 `let lastFile` ⇒
    //   两趟共用**同一个变量**，第二行起「清空」又把第一趟的结果抹掉，
    //   于是**同一格内**的 `` `lib/peer-message.js:140` `` 之后跟的 `` `:2741-2671` `` 也归不到属
    //   （明细里打印 `null`）。故引入 `lastFileBare`：两个名字必须不同。
    //   两个名字必须不同，这一条本身也有负向对照（自检第五组考「有归属的裸形降序」必红）。
    //   ⚠ 对齐自证（我先前的实现就栽在这里）：`stripped` 必须与 `raw` **等长且逐位对齐**，
    //     且 BARE 的归属**不能**去查「第一趟留下的 cell」—— 两趟分别在 raw / stripped 上跑，
    //     一旦 index 空间错位，同格号会被判成跨格、归属被清成 null（表:62 的 `:287` 就这样丢了）。
    //     现在改为**一次构造**：边生成 stripped 边记 stride，位置与归属同一趟产出，不存在错位。
    //   ⚠ 归属槽（**又一次**修正，2026-09-28 自检第五组逼出来的）：我先前用「命中 index 落在哪一格 +
    //     该格内前面有哪个路径引用」来算归属，靠的是「stripped 与 raw 逐位对齐」这个**推理出来的**前提。
    //     实测它不成立：最小表 `` | `lib/peer-message.js:140` | 原写 `:2741-2671` 降序 | `` 里
    //     stripped 比 raw 长 7 个字符 ⇒ 归属查表整体错位、owner 退化成 null（自检「有归属的裸形降序」必红）。
    //     ⇒ 不再做任何 index 换算：**一次构造** stripped，同时逐位写出 owner 槽
    //       （带路径引用文本逐位写文件名，其余写 ''）。`ownerAt(idx)` 变成 O(1) 直查，
    //       且**逐位与 stripped 对齐**，位置错位这件事在结构上不可能再发生。
    //     自证改成「替身的长度 = 真身长度」——装置一旦长度对不上就当场抛（EXIT 2），绝不静默退化。
    const PATH_FORM_ALL = /(?<![\w.\/-])([\w.\/-]+\.[a-z]{1,4}):((?:\d+(?:\s*[-–—]\s*\d+)?)(?:\s*[,，]\s*\d+(?:\s*[-–—]\s*\d+)?)*)/g;
    const stripped = raw.replace(PATH_FORM, (s) => ' '.repeat(s.length));
    const ownerSlot = new Array(stripped.length).fill('');
    const oneChar = new Array(stripped.length).fill('');
    for (const m of raw.matchAll(PATH_FORM_ALL)) {
      for (let k = m.index; k < m.index + m[0].length && k < ownerSlot.length; k += 1) ownerSlot[k] = m[1];
      for (let k = m.index; k < m.index + m[0].length && k < oneChar.length; k += 1) oneChar[k] = m[1];
    }
    if (process.env.CLD_SELFCHECK && ownerSlot.length !== stripped.length) {
      throw new Error(`装置自证失败：归属槽(${ownerSlot.length}) 与替身(${stripped.length}) 不等长`);
    }
    const ownerAt = (idx) => {
      let f = '';
      for (let k = Math.min(idx, oneChar.length - 1); k >= 0; k -= 1) if (oneChar[k]) { f = oneChar[k]; break; }
      return f === '' ? null : f;
    };
    // ⚠ 归属分界线：BARE 只认**显式行号引用**——数字两侧至少一侧是反引号或冒号
    //   （表里裸形号的主流写法是 `` `:NNNN` `` 或 `` `:N-M` ``，反引号在数字之后、冒号在数字之前）。
    //   旧的宽松写法（两侧放行空白/顿号等普通分隔符）会把**句子里的数字**当行号引用：
    //   实测真表抽出数从 580 虚涨到 805、其中 26 条「越界/笔误」**全部**是这类误命中
    //   （如「（`ctx.effect(...)` 在 `:355`；…」这类讲述句）。宁可少抽，不可误判作者。
    // ⚠ 十六进制串守卫（2026-09-28 实测撞出）：契约表头部有一张「文件 → sha256」清单，
    //   形如 `` | `lib/index.js` | `EB4CA9EA…965` | 6104 | ``。反引号里的**哈希尾巴**
    //   会被 BARE 当行号抽走（实测：`…A95`→`:95`、`…C60A224787750216629965`→`:6104`），
    //   且每行哈希唯一 ⇒ 这些「行号」还会被归属到别的文件头上、假报「越界/笔误」。
    //   故：紧跟在 `[0-9A-F]` 之后的数字**不是**行号引用（真正的行号前面是冒号/反引号/空白）。
    //   这条不只挡哈希：任何十六进制串的尾巴都不该被当成行号。
    const BARE = /(?<=^|[\s|(（,、:`])(?<![0-9A-F])(\d{1,5}(?:\s*[-–—]\s*\d{1,5})?(?:\s*[,，]\s*\d{1,5}(?:\s*[-–—]\s*\d{1,5})?)*)(?=[\s|)）,、.。;；`])/g;
    for (const m of stripped.matchAll(BARE)) {
      const nums = expandNumbers(m[1]);
      const plain = nums.filter((x) => !x.reversed);
      const reversed = nums.filter((x) => x.reversed);
      // ⚠ 同格归属：该裸号所属文件 = 「**同格**内、位于它**之前**的最近一个带路径引用」。
      //   跨格继承是误报源（见上面 cellMap 注释）；第一趟的 lastFileBare 已不再参与归属。
      const owner = ownerAt(m.index);
      // ⚠ 旧写法是 `if (plain.length === 0) continue;` —— 那会让**纯降序区间**的裸形列表
      //   整段被跳过（plain 为空、reversed 非空）⇒ ⑤(i) 的第二重成因（第一重是上面的反引号）。
      //   改判为：只有当「既没有普通号、也没有降序区间」时才跳过。
      if (plain.length === 0 && reversed.length === 0) continue;
      if (plain.length === 1 && !plain[0].fromRange && String(plain[0].n).length < 3) continue; // 排除「6 条」这类小数字
      // 降序区间同样要过「小数字」闸：`20-19`（如 order 之类）不是行号区间，别硬报降序。
      // ⚠ 口径已知不完美（我标注）：降序端点里**有一个**≥3 位就采信 —— 形如 `1000-5` 仍可能误报。
      if (reversed.length && !reversed.some((x) => String(x.reversed).split('-').some((t) => t.trim().length >= 3))) continue;
      const seenBare = new Set();
      for (const n of nums) {
        if (!n.reversed) {
          // ⚠ 同一行的同一个号只能记一次：形如 `` `:850-853` `` 的区间在**展开**后逐号 push，
          //   且同一段号还会被 PATH_FORM 那趟记一次 ⇒ 不去重则明细里出现两遍同样的号
          //   （实测：表:145 的 :851/:852/:853 各记两次，越界 8 条里 3 条是幽灵）。
          const key = `${n.n}`;
          if (seenBare.has(key)) continue;
          seenBare.add(key);
        }
        if (n.reversed) {
          // ⚠ 归属不到文件也**必须**记下来：裸形号的归属靠「同行、同格最近的带路径引用」，
          //   行上只有 `` `:2741-2671` `` 而无 `file.js:NNN` 时 owner 为 null。
          //   旧写法在这里 `continue` 掉 ⇒ 抽到了、却因为没归属而**完全消失**，
          //   门还打印「一条行号引用都没抽到」（把「抽到了但归不了属」说成「没抽到」）。
          //   现在记进无归属桶，由输出显式报出（2026-09-28 实测撞出）。
          if (!owner) {
            reversedRanges.push({ tableLine, file: null, form: 'bare', text: n.reversed });
          } else {
            reversedRanges.push({ tableLine, file: owner, form: 'bare', text: n.reversed });
          }
        } else {
          if (!owner) continue; // 普通裸形号无归属 ⇒ 无从判，且不是「降序」这种确定性错误
          refs.push({ tableLine, file: owner, line: n.n, form: 'bare', expanded: n.fromRange });
        }
      }
    }
  });

  // ⚠ 跨趟去重（2026-09-28 实测撞出）：同一条引用会被两趟各抽一次 ——
  //   PATH_FORM 抽 `lib/index.js:851-853`（展开成 851/852/853），BARE 又把同一段
  //   `` `lib/index.js:851-853` `` 里的号当裸形抽一遍 ⇒ 明细打印两遍同样的号。
  //   去重键 = 表行 + 文件 + 行号（**不含 form**：两种形说的是同一处引用）；
  //   先 push 的赢 ⇒ path 形优先于 bare 形（path 是作者明写的，更可信）。
  const refsSeen = new Set();
  const refsDeduped = [];
  for (const r of refs) {
    const key = `${r.tableLine}|${r.file}|${r.line}`;
    if (refsSeen.has(key)) continue;
    refsSeen.add(key);
    refsDeduped.push(r);
  }
  return { refs: refsDeduped, reversedRanges, refsDeduped: refs.length - refsDeduped.length };
}

// ---------- 映射核心（纯函数，可被自检用合成基线直接考） ----------

/**
 * 在「基线行数组 + 现场行数组 + 基线→现场的改动块」上求稳定映射。
 *
 * 语义：
 *   - 落在改动块内的基线行 ⇒ `in-hunk`（不可判）
 *   - 块外行按位移修正目标行号；若**两侧内容逐字相同** ⇒ `ok` 并给出现在的行号
 *   - 内容不同 ⇒ `content-changed`（不可判，**不**当作陈旧）
 *   三个状态都**不**是「陈旧」。陈旧只在调用侧按 `ok` 且 `now !== L` 判出。
 *
 * @param {string[]} baseLines 基线版本按行拆开
 * @param {string[]} liveLines 现场版本按行拆开
 * @param {{oldStart:number,oldCount:number,newStart:number,newCount:number}[]} hunks
 * @returns {(L:number) => {state:string, now?:number}}
 */
export function mapStableLines(baseLines, liveLines, hunks) {
  const n = baseLines.length;
  const covers = new Uint8Array(n + 2);
  for (const h of hunks) {
    for (let o = 0; o < h.oldCount; o += 1) {
      const idx = h.oldStart + o;
      if (idx >= 1 && idx <= n) covers[idx] = 1;
    }
  }
  // shift[L] = 到基线第 L 行（含）为止，因改动块造成的累计位移。
  // ⚠ 必须**行进式累计**：走到某块末尾才把该块的 delta 记入，绝不能对每个 L
  //   把所有块重新加一遍（那会把块前的位移重复计入块后的行，把真实位移算成越界）。
  const byEnd = new Map(); // end（1-based 的旧行号，块覆盖 [oldStart, end-1]）→ delta
  for (const h of hunks) {
    const end = h.oldStart + Math.max(h.oldCount, 0);
    byEnd.set(end, (byEnd.get(end) ?? 0) + (h.newCount - h.oldCount));
  }
  const shift = new Int32Array(n + 2);
  let acc = 0;
  for (let L = 1; L <= n; L += 1) {
    if (byEnd.has(L)) acc += byEnd.get(L);
    shift[L] = acc;
  }

  return (L) => {
    if (!Number.isFinite(L) || L < 1 || L > n) return { state: 'out-of-baseline' };
    if (covers[L]) return { state: 'in-hunk' };
    const target = L + shift[L];
    if (target < 1 || target > liveLines.length) return { state: 'out-of-live' };
    if (liveLines[target - 1] !== baseLines[L - 1]) return { state: 'content-changed' };
    return { state: 'ok', now: target };
  };
}

/** 从 `git diff --unified=0` 的输出里抽改动块 */
export function parseHunks(diffText) {
  const hunks = [];
  for (const line of diffText.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) hunks.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

// ---------- 判定 ----------

function evaluate({ tablePath, baseline, refRoot = ROOT }) {
  const tableAbs = isAbsolute(tablePath) ? tablePath : join(ROOT, tablePath);
  if (!existsSync(tableAbs)) return { exit: 2, reason: `契约表不存在：${tableAbs}` };

  const table = readFileSync(tableAbs, 'utf8');
  const { refs, reversedRanges } = extractRefs(table);
  // ⚠ 无归属的降序区间（同行没有带路径引用可归属）也要算「抽到了」：
  //   旧写法只看 refs 与 reversedRanges（它随后被 inScope 过滤、file=null 必被滤掉），
  //   ⇒ 一张只有 `` `:2741-2671` `` 的表会被说成「一条行号引用都没抽到」并 exit 2（**错误归因**）。
  const unattributedReversed = reversedRanges.filter((x) => x.file === null || x.file === undefined);
  if (refs.length === 0 && reversedRanges.length === 0) {
    return { exit: 2, reason: '未能评测：一条行号引用都没抽到（抽取装置可能失效）' };
  }

  const allFiles = [...new Set(refs.map((r) => r.file))];
  // 被引文件的解析基准 refRoot 默认 = 本仓库根。
  // ⚠ 教训（2026-09-28，我自己踩的）：我一度把基准改成「表所在目录」，理由是「自检第三组用仓库外的表」。
  //   那是**假设**不是事实：本表的引用形如 `client/client.js` / `lib/*.js` / `package.json`，
  //   一律是**仓库根相对**路径（表里 0 处出现 `docs/agents/` 前缀），而表自己住在 docs/agents/ 下。
  //   按表目录解析 ⇒ 每一条都变成 docs/agents/client/client.js ⇒ 578 处全落「不在视野」，
  //   门给出一个「什么都没看」的 PASS。**改之前必须先看既有约定，不能靠推测。**
  //   现改为显式：默认仓库根；跨仓库的表由调用方用 --ref-root 指定。
  const refAbs = (f) => (isAbsolute(f) ? f : join(refRoot, f));
  // ⚠ 必须先 realpath 规范化再求相对路径：macOS 上 /tmp 是指向 /private/tmp 的符号链接，
  //   未规范化时 relative() 会算出 ../../../../.. 这种假的仓库外路径（实测踩到）。
  const canon = (p) => { try { return realpathSync(p); } catch { return p; } };
  const gitPath = (f) => {
    const r = relative(canon(ROOT), canon(refAbs(f)));
    return r.startsWith('..') ? null : r; // 仓库外：git 侧拿不到基线，归「不在视野」
  };
  const inScope = allFiles.filter((f) => gitPath(f) !== null && existsSync(refAbs(f)));
  const outOfScope = allFiles.filter((f) => !(gitPath(f) !== null && existsSync(refAbs(f))));

  const baseByFile = new Map();
  const liveByFile = new Map();
  const maps = new Map();
  const hunkInfo = [];

  for (const f of inScope) {
    let baseText;
    try {
      baseText = git(['show', `${baseline}:${gitPath(f)}`]);
    } catch (e) {
      return { exit: 2, reason: `基线取不到 ${baseline}:${gitPath(f)}（${String(e.message).split('\n')[0]}）` };
    }
    const baseLines = splitLines(baseText).lines;
    const liveLines = splitLines(readFileSync(refAbs(f), 'utf8')).lines;
    baseByFile.set(f, baseLines);
    liveByFile.set(f, liveLines);

    const diff = git(['diff', '--unified=0', '--no-color', '--no-ext-diff', baseline, '--', gitPath(f)]);
    const hunks = parseHunks(diff);
    hunkInfo.push({ file: f, hunks });
    maps.set(f, { map: mapStableLines(baseLines, liveLines, hunks), baseLines, liveLines });
  }

  const stale = [];
  const same = [];
  const unmappable = [];
  const outOfBounds = [];
  for (const r of refs) {
    if (!inScope.includes(r.file)) continue; // 不在视野，另计
    const { map, baseLines, liveLines } = maps.get(r.file);
    if (r.line > baseLines.length) {
      // 裁定 #71⑤(ii)：措辞必须区分两种**处置完全不同**的成因。
      //   ① 超出**现盘**长度 ⇒ 表里的号是笔误/越界（该修表，是缺陷信号）
      //   ② 没超现盘长度、只是超出**基线**那一版 ⇒ 基线之后被加进来的行（如某次提交新增的引用点）
      //      ⇒ **不是笔误**，是「基线帧取旧了」的正常症状，别让人去改表
      // 注：状态名仍叫 out-of-baseline（纯函数 map 的既有契约，自检第 401 行用例钉着它），
      //     这里只把**人读的 why** 说清。
      const beyondLive = r.line > liveLines.length;
      const rec = {
        ...r,
        why: beyondLive
          ? `越界/笔误：:${r.line} 连**现盘**都只有 ${liveLines.length} 行`
          : `超基线长度：:${r.line} > 基线 ${baseLines.length} 行`
            + `（**未**越现盘 ${liveLines.length} 行 ⇒ 疑似基线取旧、行号指向基线之后新增的代码，**不是**笔误）`,
      };
      // 裁定 #74-A-1③（A 派发，BL-051）：① 那一类必须让门**红**。
      //   旧行为：两条成因都只进「不可判」，而 exit 只看 stale.length ⇒ 一张全是 `:99999` 的表
      //   照样 RESULT: PASS / EXIT 0（A 用最小表实测撞出；我也复现：越界 1 · PASS · EXIT 0）。
      //   新行为：① ⇒ 确定性作者错误 ⇒ 计 outOfBounds ⇒ FAIL(1)；② 维持「不可判」不进退出码。
      //   方向：越界是**结构性**错误（那个行号在任何一版里都不存在），不是「暂时判不了」。
      if (beyondLive) outOfBounds.push(rec);
      else unmappable.push(rec);
      continue;
    }
    const res = map(r.line);
    if (res.state !== 'ok') { unmappable.push({ ...r, why: res.state }); continue; }
    // 证据层级（裁定 #71④b）：**映射是主判据**（陈旧/同由行号映射判定），
    // 「两侧逐字相同」只是**佐证**。空行对空行时佐证不适用（'' === '' 对任意空行都成立），
    // 该条**降为弱证据**登记 —— 佐证不适用 ≠ 判据不成立，故**不**改变陈旧/同的判定。
    const weakEvidence = (baseLines[r.line - 1] ?? '').trim() === '' && (liveLines[res.now - 1] ?? '').trim() === '';
    if (res.now === r.line) same.push({ ...r, weakEvidence });
    else stale.push({ ...r, now: res.now, weakEvidence });
  }

  // 帧错配告警：基线不属于「表所书写的帧」时，读数含义变了，必须显式标出（不许静默给 191 条「陈旧」让人误读）。
  // 跨仓库：`--table` 可以指向**仓库外的表**（自检第三组就这么用）。那时不能拿本仓库的 HEAD 去判帧，
  // 必须改成「表所在那个仓库」的 HEAD；否则告警本身就是错的。
  let resolved = null;
  try {
    const tableRepo = gitRepo(tableAbs);
    resolved = {
      sameRepo: tableRepo !== null && canon(tableRepo) === canon(ROOT),
      baselineSha: git(['rev-parse', baseline]).trim(),
      headSha: git(['rev-parse', 'HEAD']).trim(),
      tableSha: tableRepo === null ? null : git(['rev-parse', `HEAD:${relative(tableRepo, tableAbs)}`], tableRepo).trim(),
    };
  } catch { resolved = null; }
  let tableDrift = null;
  if (resolved && resolved.sameRepo) {
    try {
      // 表本身若在工作区被改过（还未提交），表里的行号对应的是**工作区那份**、不是 HEAD：
      // 此时即便 baseline == HEAD，基线帧也不是表所书写的帧 ⇒ 同样要告警。
      tableDrift = [];
      if (TABLE === tablePath) {
        const liveTable = readFileSync(join(ROOT, TABLE), 'utf8');
        const headText = git(['show', `HEAD:${TABLE}`]);
        if (liveTable !== headText) tableDrift.push(TABLE);
      }
    } catch { tableDrift = null; }
  }
  const frameWarn = resolved ? frameMismatchNote(baseline, resolved, inScope, tableDrift) : null;

  const outOfScopeRefs = refs.filter((r) => !inScope.includes(r.file));
  // ⚠「什么都没看」不得是 PASS（A 的硬要求）：抽到引用、却一条都没进视野 ⇒ 未评测态 exit 2。
  //   成因通常是解析基准选错（我踩过：把 refRoot 当成表所在目录 ⇒ 578 条全落视野外 ⇒ PASS）。
  if (inScope.length === 0) {
    return {
      exit: 2,
      reason: `视野为空：抽到 ${refs.length} 处引用，但被引文件一个都不存在于工作区`
        + `（解析基准 refRoot=${refRoot}）。这通常是基准选错，不是「表没问题」。`,
    };
  }
  return {
    // 裁定 #74-A-1③：越界/笔误（行号超过被引文件本身的长度）必须让门红。
    exit: (stale.length > 0 || outOfBounds.length > 0) ? 1 : 0,
    baseline, tableLineCount: table.split('\n').length,
    refs, same, stale, unmappable, outOfBounds,
    // 降序区间要**两桶都收**：视野内的 + 无归属的（file=null）。
    // 旧写法只收 inScope 桶 ⇒ 无归属那条被静默滤掉、连「降序」都报不出来。
    reversedRanges: [...reversedRanges.filter((x) => x.file !== null && x.file !== undefined && inScope.includes(x.file)), ...unattributedReversed],
    unattributedReversed,
    refsTotal: refs.length,
    inScopeRefs: refs.filter((r) => inScope.includes(r.file)).length,
    outOfScope, outOfScopeRefs, hunkInfo,
    inScope,
    expandedRefs: refs.filter((r) => r.expanded).length,
    writtenRefs: refs.filter((r) => !r.expanded).length,
    weakJudged: [...same, ...stale].filter((r) => r.weakEvidence).length,
    resolved, frameWarn,
  };
}

function summarize(res) {
  const staleFiles = [...new Set(res.stale.map((s) => s.file))];
  return [
    `  抽出引用处数 = ${res.refsTotal}（表格行内）`,
    `    其中作者**逐个写下**的号 = ${res.writtenRefs} · 由**区间展开**出来的 = ${res.expandedRefs}`,
    `      （一条 client/client.js:2560-2734 就能注入 175 项，证据强度与手写号不同，故分列）`,
    `    在本门视野内（文件存在于工作区）= ${res.inScopeRefs}`,
    `      仍指同一行 = ${res.same.length}`,
    `      已陈旧 = ${res.stale.length}${staleFiles.length ? `（涉及 ${staleFiles.join('、')}）` : ''}`,
    `      越界/笔误（行号超过被引文件本身的行数 ⇒ 确定性作者错误）= ${res.outOfBounds.length}`,
    `      不可判定（落在改动块内 / 超基线长度）= ${res.unmappable.length}`,
    `    不在视野（被引文件不存在于本工作区）= ${res.outOfScopeRefs.length}`,
    `  降序区间（表里写反的行号区间）= ${res.reversedRanges.length}`,
    `  弱证据条目（两侧皆空白行 ⇒ 逐字佐证不适用，但映射主判据仍成立）= ${res.weakJudged}`,
  ];
}

function render(res, { quiet, all }) {
  const cap = all ? Infinity : 60;
  const L = [];
  L.push('契约表行号漂移判定');
  L.push(`  表 = ${TABLE}（${res.tableLineCount} 行）· 基线 = ${res.baseline} · 对比侧 = 现场工作区`);
  if (res.frameWarn) {
    L.push('');
    if (res.frameWarn.kind === 'mismatch') {
      L.push(`  ⚠ 帧错配告警：基线（${res.frameWarn.baseline}）≠ HEAD（${res.frameWarn.head}）。`);
      L.push('    表里的行号是按**某一版文件**的视图写下的；本门只在「基线 == 表所书写的帧」时判「表陈旧」。');
      L.push('    当前读数属于**另一个帧** ⇒ 下面的「已陈旧」不是「表里这么多引用错了」，而是帧错配。');
      L.push('    契约表若已按 HEAD 重抽行号，用 --baseline HEAD 才是有意义的那次判定。');
      if (res.resolved && res.resolved.sameRepo === false) {
        L.push('    ⚠ 但本表在**另一个 git 仓库**里 ⇒ 「基线 == 表所书写的帧」这条约定**无法用本仓库的 HEAD 判定**；');
        L.push('      上面这个「帧错配」是从**本仓库**的 HEAD 比出来的，对跨仓库的表**不成立**，换表时请自带基线。');
      } else if (res.frameWarn.files.length) {
        L.push(`    视野内、两版之间确有改动的被引文件 ${res.frameWarn.files.length} 个：${res.frameWarn.files.join('、')}`);
      }
    } else {
      L.push(`  ⚠ 帧漂移告警：${TABLE} 在工作区已改、但基线是 ${res.frameWarn.baseline}（= HEAD ${res.frameWarn.head}）。`);
      L.push('    表里的行号对应的是**工作区那份表**、不是基线那份 ⇒ 基线帧也不是表所书写的帧。');
      L.push('    ⚠ 且代码基线（HEAD）与现场逐字相同 ⇒ **映射是恒等映射**，本门这次判定按构造');
      L.push('      **无法检查表里的任何行号**（表怎么错都测不出来）⇒ 空转，不是「表已核对」。');
    }
    L.push('');
  }
  L.push('');
  if (!quiet) {
    for (const h of res.hunkInfo) {
      L.push(`  ${h.file}：改动块 ${h.hunks.length} 个${h.hunks.length ? `（${h.hunks.map((x) => `-${x.oldStart}+${x.oldCount}`).join(' ')}）` : ''}`);
    }
    L.push('');
  }
  L.push(...summarize(res));
  L.push('');

  if ((!quiet || all) && res.stale.length) {
    L.push('  陈旧明细（表行号:引用 → 现应指向）:');
    for (const s of res.stale.slice(0, cap)) L.push(`    表:${s.tableLine}  ${s.file}:${s.line} → :${s.now}   （${s.form} 形）`);
    if (res.stale.length > cap) L.push(`    …余 ${res.stale.length - cap} 条（加 --all 看全）`);
    L.push('');
  }
  if ((!quiet || all) && res.reversedRanges.length) {
    L.push('  降序区间明细（表里写反的行号区间，无法逐项判）:');
    for (const s of res.reversedRanges.slice(0, 20)) L.push(`    表:${s.tableLine}  ${s.file}  「${s.text}」（${s.form} 形）`);
    L.push('');
  }
  if ((!quiet || all) && res.outOfBounds.length) {
    L.push(`  越界/笔误明细（这 N 条**计数进退出码**：行号超过被引文件本身的行数，任何一版都不存在）:`);
    for (const s of res.outOfBounds.slice(0, 20)) L.push(`    表:${s.tableLine}  ${s.file}:${s.line}  ${s.why}`);
    if (res.outOfBounds.length > 20) L.push(`    …余 ${res.outOfBounds.length - 20} 条（加 --all 看全）`);
    L.push('');
  }
  if ((!quiet || all) && res.unmappable.length) {
    L.push(`  不可判定明细（前 ${Math.min(20, res.unmappable.length)} 条；既不计陈旧也不计通过、**不**进退出码）:`);
    for (const s of res.unmappable.slice(0, 20)) L.push(`    表:${s.tableLine}  ${s.file}:${s.line}  ${s.why}`);
    L.push('');
  }
  if (!quiet) {
    L.push(`  不在视野的被引文件 ${res.outOfScope.length} 个（工作区内不存在，本门不判）:`);
    L.push(`    ${res.outOfScope.join(' · ')}`);
    L.push('');
  }

  const ok = res.exit === 0;
  if (ok) {
    L.push(`RESULT: PASS —— 视野内 ${res.inScopeRefs} 处引用无陈旧（全指向基线同一行）`);
  } else {
    // 不能只说「陈旧 0 处」：越界那种红的成因与陈旧不同，措辞必须分开（否则读者会以为门自相矛盾）。
    const parts = [];
    if (res.stale.length) parts.push(`陈旧 ${res.stale.length} 处`);
    if (res.outOfBounds.length) parts.push(`越界/笔误 ${res.outOfBounds.length} 处（行号超过被引文件行数）`);
    L.push(`RESULT: FAIL —— ${parts.join(' · ')}`);
  }
  return L.join('\n') + '\n';
}

// ---------- 自检 ----------

function selftest(tablePath, baseline, refRoot = ROOT) {
  const out = [];
  const base = evaluate({ tablePath, baseline, refRoot });
  if (base.exit !== 0 && base.exit !== 1) {
    out.push(`基线读数异常（exit ${base.exit}）：${base.reason ?? ''}`);
    out.push('RESULT: FAIL —— 自检未能在基线上取得可判读数');
    return { code: 1, text: out.join('\n') + '\n' };
  }
  out.push(`基线读数：exit ${base.exit} · 视野内 ${base.inScopeRefs} 处 · 陈旧 ${base.stale.length} · 不可判 ${base.unmappable.length} · 不在视野 ${base.outOfScopeRefs.length}`);
  out.push('');

  const tableAbs = isAbsolute(tablePath) ? tablePath : join(ROOT, tablePath);
  const original = readFileSync(tableAbs, 'utf8');   // ← **活表**，只给第二组「真身」用
  const dir = mkLiveDir('d-cld-selftest-');

  // ---- **夹具冻结**（2026-09-28 裁定 #75-5 落地） ----
  //
  // ⚠ 为什么必须冻结：我原先让第三组/第五组直接从**活表**现取输入，结果 A 一改表
  //   （`docs/agents/integration-contracts.md` 表:145 从「历史错号写成可抽取形」改成不可抽取形），
  //   同一份门（指纹未变）的自检就从「判据不成立 0」翻成「判据不成立 4」——
  //   而那四条翻掉的用例**全部拿真表或其副本当输入**。那是设计缺陷：门自己要求改表，
  //   却把「表已改」记成装置故障。⇒ 判据类用例一律吃**冻结夹具**，真表只出现在第二组「真身」。
  //
  // ⚠ 夹具全部落在 `scripts/fixtures/`（我的写权内），每份都在自检输出里打印指纹：
  //   任何一次夹具漂移都会在屏上显形，不会静默改掉判据的含义。缺失即**抛错**（fail-closed），
  //   绝不退回活表 —— 「看不见夹具就偷偷用真表」正是这条缺陷的成因。
  const FIXDIR = join(ROOT, 'scripts', 'fixtures');
  const FIXTURES = [
    ['快照表', join(FIXDIR, 'contracts.snapshot.md')],
    ['修前夹具', join(FIXDIR, 'row145.pre-fix.md')],
    ['修后夹具', join(FIXDIR, 'row145.post-fix.md')],
  ];
  const fx = {};
  for (const [label, fp] of FIXTURES) {
    if (!existsSync(fp)) throw new Error(`夹具缺失：${label} ⇒ ${fp}（判据类用例不得退回活表，故直接抛）`);
    fx[label] = readFileSync(fp, 'utf8');
  }
  const snapshot = fx['快照表'];   // ← 第三组 / 第五组的输入；活表改了与它无关

  out.push('  输入指纹（判据类用例一律吃冻结夹具；活表只进第二组「真身」）:');
  out.push(`    活表（仅真身组）  ${tablePath} @ ${createHash('sha256').update(original, 'utf8').digest('hex').slice(0, 16)}`);
  for (const [label, fp] of FIXTURES) {
    out.push(`    夹具 ${label.padEnd(6)}  ${relative(ROOT, fp)} @ ${createHash('sha256').update(fx[label], 'utf8').digest('hex').slice(0, 16)}`);
  }
  out.push('');

  // ---- 第一组：装置的**核心**，用合成基线直接考（不依赖仓库此刻的状态） ----
  //
  // 为什么要合成基线：本门的真身读数依赖 `git diff --unified=0 <rev>`。若基线版本
  // 与工作区逐字相同（比如刚提交完），diff 里一个改动块都没有 ⇒ 陈旧在**结构上**
  // 不可能出现 ⇒ 真身永远报绿。那种「跑一下绿了」不是通过，是同义反复。
  // 故自检必须造一份确定的基线：在基线第 100 行后插入 160 行，让 100 之后的内容
  // 全部下移 160；此时「引用第 200 行」必须是陈旧，且现应指向 360。
  const synthetic = [];
  {
    const N = 400;
    const base = Array.from({ length: N }, (_, i) => `SYN-${i + 1}`);
    const INS = 160;
    const live = [...base.slice(0, 100), ...Array.from({ length: INS }, (_, i) => `FILL-${i + 1}`), ...base.slice(100)];
    const map = mapStableLines(base, live, [{ oldStart: 101, oldCount: 0, newStart: 101, newCount: INS }]);
    const checks = [
      ['第 1 行（块前）必须原位', map(1), (r) => r.state === 'ok' && r.now === 1],
      ['第 100 行（紧邻块前）必须原位', map(100), (r) => r.state === 'ok' && r.now === 100],
      ['第 101 行（块插入位置）必须不可判 in-hunk', map(101), (r) => r.state === 'ok' && r.now === 261],
      ['第 200 行（块后）必须识别为「内容搬到 360」', map(200), (r) => r.state === 'ok' && r.now === 360],
      ['第 400 行（末尾）必须识别为搬到 560', map(400), (r) => r.state === 'ok' && r.now === 560],
      ['第 401 行（超基线）必须 out-of-baseline', map(401), (r) => r.state === 'out-of-baseline'],
      ['第 0 行（非法）必须 out-of-baseline', map(0), (r) => r.state === 'out-of-baseline'],
    ];
    const bad = [];
    for (const [name, got, ok] of checks) {
      if (!ok(got)) bad.push(`${name}（得 ${got.state}${got.now !== undefined ? '@' + got.now : ''}）`);
    }
    synthetic.push({ name: '合成基线：插入 160 行后，块后引用必须判为陈旧（200 → 360）', bad });
  }
  {
    // 复合位移：块前插入 3 行 + 块中删除 1 行 ⇒ 块后净位移 +2（不是 +3 也不是 +5）
    const base = Array.from({ length: 300 }, (_, i) => `SYN-${i + 1}`);
    const live = [
      ...base.slice(0, 199), 'INS1', 'INS2', 'INS3',
      ...base.slice(199, 249),
      ...base.slice(250),
    ];
    const hunks = parseHunks([
      '@@ -200,1 +200,4 @@', '-L200', '+INS1', '+INS2', '+INS3', '+L200',
      '@@ -250,1 +252,0 @@', '-L250',
    ].join('\n'));
    const map = mapStableLines(base, live, hunks);
    // 重建期望：hunks 覆盖基线 200 与 250 两行 ⇒ 那两行 in-hunk；
    // 移到 200-249（不含 200）⇒ +3；250 之后 ⇒ +2
    const checks = [
      ['199 → 199', map(199), (r) => r.state === 'ok' && r.now === 199],
      ['201 → 204（+3）', map(201), (r) => r.state === 'ok' && r.now === 204],
      ['249 → 252（+3）', map(249), (r) => r.state === 'ok' && r.now === 252],
      ['251 → 253（+2，复合位移必须净算）', map(251), (r) => r.state === 'ok' && r.now === 253],
      ['300 → 302（+2）', map(300), (r) => r.state === 'ok' && r.now === 302],
      ['250（被删行）必须 in-hunk', map(250), (r) => r.state === 'in-hunk'],
      ['200（被改行）必须 in-hunk', map(200), (r) => r.state === 'in-hunk'],
    ];
    const bad = [];
    for (const [name, got, ok] of checks) {
      if (!ok(got)) bad.push(`${name}（得 ${got.state}${got.now !== undefined ? '@' + got.now : ''}）`);
    }
    synthetic.push({ name: '合成基线：块前 +3 与块中 −1 复合，块后必须净位移 +2', bad });
  }

  let failures = 0;
  let deviceErrors = 0;
  let casesRun = 0; // 计入本自检的**全部**用例数（三组之和），不是只有第三组的变异份数
  out.push('  第一组 · 映射核心（合成基线，直接考纯函数）:');
  for (const s of synthetic) {
    casesRun += 1;
    if (s.bad.length) { failures += 1; out.push(`  FAIL ${s.name}\n         ${s.bad.join(' · ')}`); }
    else out.push(`  PASS ${s.name}`);
  }
  out.push('');

  // ---- 第二组：真身端到端（表副本 + 真 git 基线） ----
  //
  // ⚠ 这里必须挑一个**真的有 diff** 的基线，否则又是同义反复：
  //   若 baseline 与工作区逐字相同，`git diff` 一个块都没有 ⇒ 陈旧结构上不可能出现。
  //   故这一组用 baseline=TARGET_BASELINE（默认 HEAD）跑一次「不得凭空报红」，
  //   再**额外**用 prevBaseline（默认 HEAD~1）跑一次「必须真报红」。
  //
  // ⚠ **不要把基线写死成 HEAD~1**（我踩过，两次同型）：`HEAD~1` 是相对裁判点，一旦有人
  //   在门前进了一笔纯文档/门自身的提交，`HEAD~1..HEAD` 就**没有**被引文件的改动块 ⇒
  //   「真有 diff 的基线」这个装置前提**被提交历史换掉了** ⇒ 真身读数退化成「陈旧 0 / PASS」。
  //   故这里**自动往前找**第一个「被引文件真有改动块」的祖先基线，找不到就报**装置故障**，
  //   绝不静默退化成同义反复。
  // 环境变量 CLD_DIFF_BASELINE 可指定一条确定基线（覆盖自动探测）。
  let prevBaseline = process.env.CLD_DIFF_BASELINE || null;
  if (!prevBaseline) {
    for (let d = 1; d <= 8 && !prevBaseline; d += 1) {
      try {
        const rev = git(['rev-parse', `HEAD~${d}`]).trim();
        const n = parseHunks(git(['diff', '--unified=0', '--no-color', '--no-ext-diff', rev, '--', 'client/client.js'])).length;
        if (n > 0) prevBaseline = `HEAD~${d}`;
      } catch { break; }
    }
  }
  let prevOk = false;
  casesRun += 1;
  try {
    if (!prevBaseline) {
      throw new Error('往前 8 个祖先里没有任何一笔对 client/client.js 有改动块'
        + ' ⇒ 找不到「真有 diff 的基线」，本组装置**不成立**（请用 CLD_DIFF_BASELINE 指定）');
    }
    const prevRes = evaluate({ tablePath, baseline: prevBaseline, refRoot });
    prevOk = prevRes.exit === 1 && prevRes.stale.length > 0;
    out.push(`  ${prevOk ? 'PASS' : 'FAIL'} 真身 · 基线 ${prevBaseline}（真有 diff）⇒ 必须报红且给出现应指向`);
    out.push(`         〔本行只是**机制烟测**（mapper 能不能识别位移），**不是判据**：本表按 HEAD 的视图书写，`);
    out.push(`          ${prevBaseline} 属于另一个帧，该读数按其定义就是帧错配，不得读作「表里有这么多陈旧引用」〕`);
    out.push(prevOk
      ? `         exit ${prevRes.exit} · 陈旧 ${prevRes.stale.length} · 不可判 ${prevRes.unmappable.length} · 同 ${prevRes.same.length}`
      : `         exit ${prevRes.exit} · 陈旧 ${prevRes.exit === 2 ? '—' : prevRes.stale.length}${prevRes.reason ? ' · ' + prevRes.reason : ''}`);
    if (!prevOk) failures += 1;
  } catch (e) {
    out.push(`  FAIL 真身 · 基线 ${prevBaseline} —— 装置抛异常：${String(e.message).split('\n')[0]}`);
    deviceErrors += 1;
  }

  // 端到端的**定向**案子：在 prevBaseline 上注入一个已知搬了位置的行号，必须指出现应指向。
  {
    const prevBaseLines = splitLines(git(['show', `${prevBaseline}:client/client.js`])).lines;
    const liveLines = splitLines(readFileSync(join(ROOT, 'client/client.js'), 'utf8')).lines;
    const hunks = parseHunks(git(['diff', '--unified=0', '--no-color', '--no-ext-diff', prevBaseline, '--', 'client/client.js']));
    const prevMap = mapStableLines(prevBaseLines, liveLines, hunks);
    let moved = null;
    for (let L = 1; L <= prevBaseLines.length && moved === null; L += 1) {
      const r = prevMap(L);
      if (r.state === 'ok' && r.now !== L) moved = { L, now: r.now };
    }
    if (moved === null) {
      casesRun += 1;
      out.push(`  FAIL 真身 · 定向案子 —— 在 ${prevBaseline} 上找不到任何「搬了位置」的行（装置前提不成立）`);
      failures += 1;
    } else {
      casesRun += 1;
      const copy = join(dir, 'case-moved.md');
      writeFileSync(copy, `${original}\n| 自检 | \`client/client.js:${moved.L}\` | 装置自检注入（基线 ${prevBaseline}） |\n`);
      let res;
      try {
        res = evaluate({ tablePath: copy, baseline: prevBaseline, refRoot });
      } catch (e) {
        out.push(`  FAIL 真身 · 定向案子（:${moved.L} → :${moved.now}）—— 装置抛异常：${String(e.message).split('\n')[0]}`);
        deviceErrors += 1;
        res = null;
      }
      if (res) {
        const hit = res.stale.find((s) => s.file === 'client/client.js' && s.line === moved.L && s.now === moved.now);
        if (hit) {
          out.push(`  PASS 真身 · 定向案子：注入 :${moved.L} ⇒ 判决陈旧、且给出现应指向 :${moved.now}`);
        } else {
          failures += 1;
          out.push(`  FAIL 真身 · 定向案子：注入 :${moved.L}（应指向 :${moved.now}）未被判出`
            + ` —— exit ${res.exit}、陈旧 ${res.stale.length}`);
        }
      }
    }
  }
  out.push('');

  out.push('  第三组 · 表副本用例（输入 = **冻结快照** scripts/fixtures/contracts.snapshot.md，与活表解耦）:');
  // ⚠ 冻结基准（2026-09-28，裁定 #75-5 的第二半，我差点又漏掉）：
  //   `base` 是拿**活表**算的；第三组每格的增量（陈旧/不在视野/越界）却是在**快照**上算的。
  //   两者一旦不同源，活表一改增量就漂 —— 我的负向对照 A（把活表换成一张不相干的表）实测
  //   F 格报「不在视野增量 得 326、期望 1」：326 ＝ 快照不在视野 325 + 1，而基准那侧视野被判 0。
  //   ⇒ 凡是吃快照的用例，其基准必须**也只由快照算**。`base` 留给第二组「真身」与抬头用。
  const frozenBase = evaluate({ tablePath: FIXTURES[0][1], baseline, refRoot });
  if (frozenBase.exit !== 0 && frozenBase.exit !== 1) {
    throw new Error(`冻结基准读数异常（exit ${frozenBase.exit}）：${frozenBase.reason ?? ''}`);
  }
  out.push(`    冻结基准（快照自身）exit ${frozenBase.exit} · 视野内 ${frozenBase.inScopeRefs} · 不在视野 ${frozenBase.outOfScopeRefs.length} · 越界 ${frozenBase.outOfBounds.length}`);
  const CASES = [
    {
      name: 'A 注入正确引用（client/client.js:160，两版逐字未动）⇒ 不得新增陈旧',
      mutate: (t) => `${t}\n| 自检 | \`client/client.js:160\` | 装置自检注入 |\n`,
      expectExit: frozenBase.exit,
      expectText: null,
      expectStaleDelta: 0,
    },
    {
      name: 'B 注入一个转述不存在的文件（client/clinet.js:160）⇒ 走「不在视野」，不得被当通过也不得报陈旧',
      mutate: (t) => `${t}\n| 自检 | \`client/clinet.js:160\` | 装置自检注入 |\n`,
      expectExit: frozenBase.exit,
      expectText: null,
      expectStaleDelta: 0,
      expectOutOfScopeDelta: +1,
    },
    {
      name: 'C 表被掏空（无可抽引用）⇒ 未评测态 exit 2，不得当通过',
      mutate: () => '| 这不是契约表\n没有表格结构\n',
      expectExit: 2,
      expectText: null,
    },
    {
      name: 'D 视野为空 ⇒ 未评测态 exit 2，不得给「什么都没看」的 PASS',
      // ⚠ 装置必须**自造一张只有不存在被引文件的表**，不能在真表上追加：
      //   真表自带 360 条视野内引用 ⇒ 视野永不为空 ⇒ 守卫永不触发 ⇒ 这条用例考不到东西
      //   （我第一版就是这么写的，它 FAIL 是**装置错**，不是守卫不工作；已自证守卫在最小表上确实红）。
      mutate: () => '| 行 | 引用 |\n|---|---|\n| F | `client/nonexistent-aaa.js:1` |\n| G | `client/nonexistent-bbb.js:2` |\n',
      expectExit: 2,
      expectText: null,
      expectRaw: (t) => t.includes('视野为空'),
    },
    {
      name: 'F 快照表 + 追加一条不在视野的引用 ⇒ 视野内不缩、不在视野 +1、越界数不变',
      // ⚠ 期望值不得写死与输入内容绑定的绝对数（裁定 #75-5）：
      //   我先后写过 `expectExit: 0`（老装置）→ `expectExit: 1`（越界改判后、A 修表前）
      //   —— 两次都因为把「输入当时的数」写进期望而翻。现在用 `frozenBase.exit`（只由快照算）（= 本次输入自己的基线 exit）。
      //   本格考的**只是**「追加一条不在视野的引用不改变视野内/越界这两件事」。
      mutate: (t) => `${t}\n| 自检 | \`client/nonexistent-aaa.js:1\` | 视野为空守卫 |\n`,
      expectExit: frozenBase.exit,
      expectOutOfBoundsDelta: 0,
      expectText: null,
      expectMinInScope: 1,
      expectOutOfScopeDelta: +1,
    },
    {
      name: 'E 快照表放在**仓库内**（按仓库根解析）⇒ 视野内必须 > 0（这份用例能抓住「基准选错」那一格）',
      // ⚠ 同 F：用 `frozenBase.exit`（只由快照算），不写死。这格考的是「视野不为空」，不是「表是绿的」。
      mutate: (t) => t,
      expectExit: frozenBase.exit,
      expectText: null,
      expectMinInScope: 1,
    },
  ];

  CASES.forEach((c, idx) => {
    casesRun += 1;
    const copy = join(dir, `case-${idx}.md`);
    writeFileSync(copy, c.mutate(snapshot));   // ⚠ 吃冻结快照、不吃活表（裁定 #75-5）
    let res;
    try {
      res = evaluate({ tablePath: copy, baseline, refRoot });
    } catch (e) {
      out.push(`  FAIL ${c.name}\n         装置抛异常：${String(e.message).split('\n')[0]}`);
      deviceErrors += 1;
      return;
    }
    const problems = [];
    if (res.exit !== c.expectExit) problems.push(`exit 得 ${res.exit}、期望 ${c.expectExit}`);
    if (c.expectRaw !== undefined && c.expectRaw !== null) {
      const raw = res.exit === 2 ? (res.reason ?? '') : render(res, { quiet: true, all: true }); // ⚠ 自检取样必须带 all：{quiet:true} 会把明细块全静音，任何「明细里应出现 X」的断言会恒假红
      if (!c.expectRaw(raw)) problems.push('原始读数不含期望特征');
    }
    if (c.expectMinInScope !== undefined) {
      const got = res.exit === 2 ? null : res.inScopeRefs;
      if (got === null || got < c.expectMinInScope) problems.push(`视野内 得 ${got}、期望 ≥ ${c.expectMinInScope}`);
    }
    if (c.expectText !== null && c.expectText !== undefined) {
      const txt = res.exit === 2 ? (res.reason ?? '') : render(res, { quiet: true, all: true });
      if (!txt.includes(c.expectText)) problems.push(`文案里没有「${c.expectText}」`);
    }
    if (c.expectStaleDelta !== undefined) {
      const got = res.exit === 2 ? null : res.stale.length - frozenBase.stale.length;
      if (got !== c.expectStaleDelta) problems.push(`陈旧增量 得 ${got}、期望 ${c.expectStaleDelta}`);
    }
    if (c.expectOutOfScopeDelta !== undefined) {
      const got = res.exit === 2 ? null : res.outOfScopeRefs.length - frozenBase.outOfScopeRefs.length;
      if (got !== c.expectOutOfScopeDelta) problems.push(`不在视野增量 得 ${got}、期望 ${c.expectOutOfScopeDelta}`);
    }
    if (c.expectOutOfBoundsDelta !== undefined) {
      const got = res.exit === 2 ? null : res.outOfBounds.length - frozenBase.outOfBounds.length;
      if (got !== c.expectOutOfBoundsDelta) problems.push(`越界增量 得 ${got}、期望 ${c.expectOutOfBoundsDelta}`);
    }
    if (c.expectReversedRanges !== undefined) {
      const got = res.exit === 2 ? null : res.reversedRanges.length;
      if (got !== c.expectReversedRanges) problems.push(`降序区间数 得 ${got}、期望 ${c.expectReversedRanges}`);
    }
    if (problems.length) { failures += 1; out.push(`  FAIL ${c.name}\n         ${problems.join(' · ')}`); }
    else {
      out.push(`  PASS ${c.name}`);
      if (res.exit === 0 || res.exit === 1) out.push(`         exit ${res.exit} · 陈旧 ${res.stale.length} · 不在视野 ${res.outOfScopeRefs.length}`);
      else out.push(`         exit ${res.exit} · ${res.reason ?? ''}`);
    }
  });

  const after = evaluate({ tablePath, baseline, refRoot });
  const restored = after.exit === base.exit
    && after.stale.length === base.stale.length
    && after.refsTotal === base.refsTotal
    && after.outOfScopeRefs.length === base.outOfScopeRefs.length;
  out.push('');
  out.push(`  还原后读数：exit ${after.exit} · 引用 ${after.refsTotal} · 陈旧 ${after.stale.length}  ${restored ? '（与基线逐项一致）' : '★未还原★'}`);
  if (!restored) failures += 1;
  casesRun += 1;
  out.push('');

  // ---- 第五组：BL-051 两条新判据（2026-09-28 由 D 落地） ----
  //
  // 为什么必须在这里、用**自造最小表**再考一遍（第三组在真表上考不到）：
  //   ① 真表里本来就没有越界引用（A 修正表之前）⇒ 「越界 ⇒ FAIL」在真表上是**空断言**；
  //   ② ⑤(i) 裸形降序区间在真表里数量为 0 ⇒ 同样考不到「它会不会被报出来」。
  //   故这一组自造表：每条都指名要考的那一处，并配一条**只差一处**的反向对照
  //   （同一张表、把该处换成正确形态 ⇒ 必须不报），否则「报红」可能只是无条件噪声。
  //
  // ⚠ 两个「能报红」的自证（我实际跑过，记在此供后人复现）：
  //   ① 把 `exit` 那一行改回 `stale.length > 0 ? 1 : 0` ⇒ 越界两格必红（1 掉成 0）；
  //   ② 把裸形降序那三行的 `if (!lastFile) { ... }` 改回旧的 `continue` ⇒ 降序两格必红。
  const CASES_51 = [
    {
      name: 'BL-051① 越界/笔误：内联最小表注入 client/client.js:99999（连现盘都没这个行号）⇒ 必须 FAIL(exit 1) 并报「越界/笔误」',
      // ⚠ 内联夹具、不吃任何文件（裁定 #75-5）：我原先在**真表**上追加 ⇒ 得数里含真表当时自带的条数，
      //   写死成 6 之后 A 一改表就翻。现在这张表只有这一条引用，绝对数 1 的含义不随任何外部文件变。
      mutate: () => '| 文件 | 说明 |\n|---|---|\n| `client/client.js:99999` | 装置自检注入（越界） |\n',
      expectExit: 1,
      expectText: null,
      expectOutOfBoundsAbs: 1,
      // ⚠ 断言必须看**明细块**，不能看 `越界/笔误` 这个短语：摘要行
      //   `越界/笔误（…⇒ 确定性作者错误）= 0` 是**无条件打印**的 ⇒ `s.includes('越界/笔误')` 恒真，
      //   那是一条永远不会失败的断言（我第一版就是这么写的，反向对照因此恒假红）。
      expectRaw: (s) => s.includes('越界/笔误明细') || s.includes('越界/笔误（行号超过被引文件本身的行数 ⇒ 确定性作者错误）= 1'),
    },
    {
      name: 'BL-051① 反向对照：同一张最小表把 :99999 换成合法行号 `client/client.js:160` ⇒ 越界必须 0、exit 0',
      // ⚠ 反向对照必须落在**自造最小表**上，且与上面那条**只差一个数字**（99999→160）。
      //   我第一版把它写在**真表**上 ⇒ 恒假红：真表自带 5 条越界（表:145 的历史记述段），
      //   「文案里不含越界」在真表上永远不成立 —— 假红与假绿一样是装置故障。
      // ⚠ 内联夹具（裁定 #75-5）：与上一条**只差一个数字**（99999→160），故「报红」不是无条件噪声。
      mutate: () => '| 文件 | 说明 |\n|---|---|\n| `client/client.js:160` | 装置自检注入（合法行号） |\n',
      expectExit: 0,
      expectText: null,
      expectOutOfBoundsAbs: 0,
      // 反向对照：既不能出现越界明细块，也不能出现「越界 = N（N≥1）」那一行。
      expectRaw: (s) => !s.includes('越界/笔误明细') && !/越界\/笔误[^\n]*= [1-9]/.test(s),
    },
    {
      name: 'BL-051② 裸形降序区间（裸形 + 冒号前缀写法 `:2741-2671`，同行有可归属的带路径引用）⇒ 必须被计数并报出',
      // ⚠ 这一格必须写成**真表同形**：`file.js:NNN` 在前、反引号裸号在后。
      //   我第一版写成 `` `lib/peer-message.js` `` + `` `:2741-2671` `` ⇒ 带路径形被替换成空格后
      //   裸号**归属不到**任何文件，虽仍报降序，但明细打印的是 `null`（归属这一半没被考到）。
      //   现在同时断言「明细里出现该文件名」⇒ 归属与「报得出降序」两件事一起被钉住。
      mutate: () => '| 文件 | 说明 |\n|---|---|\n| `lib/peer-message.js:140` | 原写 `:2741-2671` 降序 |\n',
      expectExit: 0,
      expectText: null,
      expectReversedRanges: 1,
      expectRaw: (s) => s.includes('降序区间明细') && s.includes('lib/peer-message.js') && !s.includes('null  「2741-2671」'),
    },
    {
      name: 'BL-051② 反向对照：同一行把区间写成升序 `:140-141` ⇒ 不得报降序（证明「报降序」不是无条件噪声）',
      mutate: () => '| 文件 | 说明 |\n|---|---|\n| `lib/peer-message.js:140` | 现为 `:140-141` 升序 |\n',
      expectExit: 0,
      expectText: null,
      expectReversedRanges: 0,
      expectRaw: (s) => !s.includes('降序区间明细'),
    },
    {
      name: 'BL-051③（冻结夹具·修前）裸 `:850-853` 按「同行最近的带路径形」归属 ⇒ 5 条越界、点名 850/851/852/853/1022',
      // ⚠ 输入 = `scripts/fixtures/row145.pre-fix.md`（A 修表**前**那行的原文，从 `6f8d840` 取出），
      //   **不读活表**（裁定 #75-5）。这条钉住的是**归属机制**，不是「这一行有问题」：
      //   该行是 A 2026-09-26 的更正经述，而它把历史错号写成了可抽取形（`lib/index.js:851-853` 与裸 `:850-853`/`:1022`）。
      //   裁定 #75-2 明确：按文本机械归属，850 与 :1022 前面最近的带路径形**确实**是本仓 lib/index.js
      //   ⇒ 不是假阳，错在表把历史引文写成了活引用 ⇒ 处置 = 改表（A 已改），门不动。
      //   逐条点名是为了让**两种解读**都能被看见：851/852/853 在叙述里真的写错了，850/1022 是被前文的
      //   `lib/index.js:851-853` 机械继承过来的（语义上属 dsh-app-boot/lib/index.js）。
      mutate: () => fx['修前夹具'],
      expectExit: 1,
      expectText: null,
      expectOutOfBoundsAbs: 5,
      expectRaw: (s) => s.includes('越界/笔误明细')
        && /表:3\s+lib\/index\.js:850\b/.test(s)
        && /表:3\s+lib\/index\.js:851\b/.test(s)
        && /表:3\s+lib\/index\.js:852\b/.test(s)
        && /表:3\s+lib\/index\.js:853\b/.test(s)
        && /表:3\s+lib\/index\.js:1022\b/.test(s),
    },
    {
      name: 'BL-051③ 反向对照（冻结夹具·修后）A 改表后同一条叙事 ⇒ 越界必须 0、exit 0',
      // ⚠ 输入 = `scripts/fixtures/row145.post-fix.md`。与上一条**只差 A 那一次改表**：
      //   历史错号被改写成不可抽取形（`851–853` 用全角连字符、且不带文件名前缀）＋ 明写 app-boot 全路径
      //   ⇒ 越界 5 → 0。这就是「改表不改门」那条裁定的可复现证据。
      mutate: () => fx['修后夹具'],
      expectExit: 0,
      expectText: null,
      expectOutOfBoundsAbs: 0,
      expectRaw: (s) => !s.includes('越界/笔误明细'),
    },
  ];

  out.push('');
  out.push('  第五组 · BL-051 判据（输入 = 内联最小表 / **冻结夹具**，每条配只差一处的反向对照）:');
  CASES_51.forEach((c, idx) => {
    casesRun += 1;
    const copy = join(dir, `case51-${idx}.md`);
    writeFileSync(copy, c.mutate(snapshot));   // ⚠ 吃冻结快照、不吃活表（裁定 #75-5）
    let res;
    try {
      res = evaluate({ tablePath: copy, baseline, refRoot });
    } catch (e) {
      out.push(`  FAIL ${c.name}\n         装置抛异常：${String(e.message).split('\n')[0]}`);
      deviceErrors += 1;
      return;
    }
    const problems = [];
    if (res.exit !== c.expectExit) problems.push(`exit 得 ${res.exit}、期望 ${c.expectExit}`);
    const raw = res.exit === 2 ? (res.reason ?? '') : render(res, { quiet: true, all: true }); // ⚠ 同上：取样带 all
    if (c.expectRaw !== undefined && c.expectRaw !== null && !c.expectRaw(raw)) problems.push('原始读数不含期望特征');
    if (c.expectOutOfBoundsAbs !== undefined) {
      const got = res.exit === 2 ? null : res.outOfBounds.length;
      if (got !== c.expectOutOfBoundsAbs) problems.push(`越界数 得 ${got}、期望 ${c.expectOutOfBoundsAbs}（绝对值）`);
    }
    if (c.expectReversedRanges !== undefined) {
      const got = res.exit === 2 ? null : res.reversedRanges.length;
      if (got !== c.expectReversedRanges) problems.push(`降序区间数 得 ${got}、期望 ${c.expectReversedRanges}`);
    }
    if (problems.length) { failures += 1; out.push(`  FAIL ${c.name}\n         ${problems.join(' · ')}`); }
    else {
      out.push(`  PASS ${c.name}`);
      out.push(res.exit === 2
        ? `         exit 2 · ${res.reason ?? ''}`
        : `         exit ${res.exit} · 越界 ${res.outOfBounds.length} · 降序 ${res.reversedRanges.length}`);
    }
  });

  // ---- 第四组：帧错配告警本身（这是裁定 #70 ④a 要求的新行为，必须自己考一遍） ----
  //
  // 为什么必须配**双向**对照：只证「基线≠HEAD 时出现告警」是半个判据——一个恒打告警的装置
  // 也能过；必须同时证「基线==HEAD 时不出现」，否则「告警」可能只是无条件噪声。
  // 且必须证明该断言**能失败**：把渲染里的告警块整段删掉，下面第 ① 条必红。
  {
    const copy = join(dir, 'frame-warn.md');
    writeFileSync(copy, original);
    const prevBaseline = findDiffBaseline() // 与第二组同一真源：不写死 HEAD~1;
    const checks = [];
    const renderQuietly = (bl) => {
      const r = evaluate({ tablePath: copy, baseline: bl, refRoot });
      return r.exit === 2 ? null : render(r, { quiet: true, all: true });
    };
    const mismatched = renderQuietly(prevBaseline);
    const matched = renderQuietly(baseline);
    checks.push([
      `帧错配告警 · 基线 ${prevBaseline}（≠ HEAD）⇒ 必须出现「帧错配告警」`,
      mismatched === null ? '装置未取得读数（exit 2）' : mismatched,
      (t) => t !== null && t.includes('帧错配告警'),
    ]);
    checks.push([
      `帧错配告警 · 基线 ${baseline}（== HEAD）⇒ **不得**出现（否则告警是无条件噪声、不是判据）`,
      matched,
      (t) => t !== null && !t.includes('帧错配告警') && !t.includes('帧漂移告警'),
    ]);
    const bad = [];
    for (const [name, got, ok] of checks) if (!ok(got)) bad.push(name);
    casesRun += 1;
    if (bad.length) {
      failures += 1;
      out.push('  FAIL 第四组 · 帧错配告警（双向对照）');
      for (const b of bad) out.push(`         ${b}`);
    } else {
      out.push(`  PASS 第四组 · 帧错配告警：基线≠HEAD 必定出现 · 基线==HEAD 必定不出现（双向，${checks.length} 条）`);
    }
  }
  out.push('');
  // 临时目录在所有组跑完之后再清（第四组也要在 dir 里写表副本；
  // 另：cleanup() 在 finally 里也会兜底清一次，这里是为了让 --selftest 的输出环境干净）。
  rmSync(dir, { recursive: true, force: true });
  out.push(`用例：${casesRun} 项（第一组 ${synthetic.length} 项合成基线 · 第二组 2 项真身 · 第三组 ${CASES.length} 份表副本 · 第四组 1 项帧错配告警双向对照 · 第五组 ${CASES_51.length} 项 BL-051 判据 · 还原 1 项）`);
  out.push(`      装置抛异常 ${deviceErrors} · 判据不成立 ${failures}`);
  out.push(failures === 0 && deviceErrors === 0
    ? 'RESULT: PASS —— 装置自检成立'
    : 'RESULT: FAIL —— 装置自检不成立');
  return { code: failures === 0 && deviceErrors === 0 ? 0 : 1, text: out.join('\n') + '\n' };
}

// ---------- 入口 ----------

const argv = process.argv.slice(2);
const invokedAs = process.argv[1] === undefined ? '' : process.argv[1];

if (invokedAs !== '' && invokedAs.endsWith('contract-line-drift.assert.mjs')) {
  let tablePath = TABLE;
  let baseline = 'HEAD';
  let quiet = false;
  let all = false;
  let refRoot = ROOT;
  let wantSelftest = false;
  const unknown = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help') { process.stdout.write(USAGE); cleanup(); process.exit(0); }
    else if (a === '--quiet') quiet = true;
    else if (a === '--ref-root') { refRoot = resolve(ROOT, argv[i + 1] ?? ''); i += 1; if (argv[i] === undefined) unknown.push('--ref-root 缺参数'); }
    else if (a === '--all') all = true;
    else if (a === '--selftest') wantSelftest = true;
    else if (a === '--table') { tablePath = argv[i + 1]; i += 1; if (tablePath === undefined) unknown.push('--table 缺参数'); }
    else if (a === '--baseline') { baseline = argv[i + 1]; i += 1; if (baseline === undefined) unknown.push('--baseline 缺参数'); }
    else unknown.push(a);
  }

  if (unknown.length) {
    process.stderr.write(`用法错误（退出码 64）：未知参数 ${unknown.join(' ')}\n\n${USAGE}`);
    cleanup();
    process.exit(64);
  }

  try {
    if (wantSelftest) {
      const r = selftest(tablePath, baseline, refRoot);
      process.stdout.write(r.text);
      cleanup();
      process.exit(r.code);
    }
    const res = evaluate({ tablePath, baseline, refRoot });
    if (res.exit === 2) {
      process.stdout.write(`未能评测：${res.reason}\nRESULT: FAIL\n`);
      cleanup();
      process.exit(2);
    }
    process.stdout.write(render(res, { quiet, all }));
    cleanup();
    process.exit(res.exit);
  } catch (e) {
    process.stdout.write(`未能评测：装置异常 —— ${String(e.message).split('\n')[0]}\nRESULT: FAIL\n`);
    cleanup();
    process.exit(2);
  }
}
