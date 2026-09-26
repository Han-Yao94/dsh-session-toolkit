#!/usr/bin/env node
/**
 * board 分片轮换器（board-rotate.mjs）
 *
 * 守的是什么：`docs/agents/team-charter.md` §4.13.2b（2026-09-24 由人类所有者批准）。
 * 四片 board 各自会长到「整体读一遍已不现实」，本工具把「按节边界机械切分 + 出索引 + 自证无损」
 * 变成一条可复跑的命令——**禁止手抄**（工欲善其事的前提是它自己不会丢东西）。
 *
 * 核心判据只有一条：**无损**。切分前记「待归档区间」的 sha256，切分后把归档片按序拼接、
 * 去掉各片新增的片头，其 sha256 必须与切分前**逐字节相同**。对不上就必须回滚、EXIT≠0。
 * 判据优先级：**无损 > 切得漂亮**（切得难看只是不好读，丢一段就是事实源损坏）。
 *
 * 三条子命令：
 *   --plan    只读不改盘：算节区间、分类保留/归档、预告归档片与活动片尺寸。
 *   --apply   写归档片 + 重写活动片：先备份原文件，写后自动跑 --verify 的同一套校验，
 *             失败**回滚**且 EXIT≠0。目标归档片已存在 ⇒ 拒绝覆盖（归档片只增不改，§4.13.2b-4）。
 *   --verify  事后离线跑：①归档片去片头 sha ②活动片保留区间 sha ③拼接 == 全文件 sha。
 *
 * 退出码（沿用 scripts/verify.mjs 与 scripts/anchor.contract.selftest.mjs 的统一约定）：
 *   0  = 通过（--plan 则是「计划算成」；--verify 则是三条全绿）
 *   1  = 判据跑成且**不等**（有东西对不上：篡改 / 丢段 / 索引与实物不一致）
 *   2  = **没能验证**：前置条件不成立（文件不存在 / 解析不到节边界 / 归档片缺失 / 元数据块不在）
 *        —— 「我没能验证」不是「它坏了」，也**绝不与通过同形**
 *   64 = 用法错误（未知参数、参数不合法、参数互相冲突）
 *
 * 节边界语义（写死，免得各人对齐不同）：
 *   把文件按**行**排开，首行开始为 0；`--boundary` 正则**逐行**测试，命中的行视为一节的首行。
 *   带 `m` 标志执行——只写 `--boundary '^##'` 时，`### …` 也命中（`^` 后紧跟 `##`）。
 *   要只匹配二级标题请写 `'^##\\s'`。**逐行测试**是刻意的：段内换行不会制造节。
 *   首行之前的 `preamble` 单独记一节（标签 §0）——它是文件抬头，通常进保留区而不是归档区。
 *   末节的字节范围延伸到文件末尾（含末字节，无论是否有终结换行）。
 *
 * 子节切分（`--sub-boundary`，仅用于「单节超限」）：
 *   归档区里某一节**自身**超过 `--max-bytes` ⇒ 用 `--sub-boundary` 在该节内部再找边界，
 *   切成 §i.1/§i.2… 依次装片（仍不超限）。未传 `--sub-boundary` ⇒ **不切**，该节独占一片变胖
 *   （§4.13.2b-2「单节超限时该节独占一片」）。子节一律**不跨片**。
 *
 * 仪器约定（§5 新禁则）：读文本一律 Node `fs.readFileSync(p)` 取 Buffer、再按 utf8 解码用于**定位**；
 * **所有算数与哈希一律在 Buffer/字节上做**，绝不用字符串长度当字节数。
 * 哈希一律 `node:crypto`。不调用任何子进程（沙箱下带管道 stdio 的 spawn 会 EPERM；本工具无此需要）。
 * 无第三方依赖。
 */

import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, openSync, closeSync, writeSync, writeFileSync, readFileSync, statSync, rmSync, renameSync,
  readdirSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXIT = { PASS: 0, FAIL: 1, INCOMPLETE: 2, USAGE: 64 }

/** 章程 §4.13.2b 的硬数字：>131,072 B 触发轮换；单片与活动片均 ≤ 96 KiB。 */
const TRIGGER_BYTES = 131072
const MAX_BYTES = 98304

/**
 * 元数据块标记。索引不另存第二份真源文件——**元数据就写在活动片里**，
 * 它随活动片一起被读、被差分、被复核；另存一个 sidecar 就等于造第二个真源（§10.2-6）。
 * 用 HTML 注释包一层：Markdown 渲染时不可见，但 grep/程序可精确取用。
 */
const META_BEGIN = '<!-- board-rotate:begin -->'
const META_END = '<!-- board-rotate:end -->'
// 活动片的分段名常量（`piecesOf` 产出、`stampCurrentGeneration` 消费）。写成常量而不是各处的字面量：
// 「按名字取分段」如果名字拼错，取到 undefined 会静默变成「没有这一段」，而它本该当场炸。
const PIECE_META = '元数据块（board-rotate:meta：全文件摘要 + 片/区间索引，--verify 的唯一输入）'
const PIECE_PREAMBLE = '原文件抬头（preamble §0）及其后换行'
const PIECE_INDEX = '归档索引（含保留区间索引）'
const PIECE_README = '读法指示'

// 归档片片头里的两个自证字段（裁定 #29.5 / #29.6）。放在模块层，供「从盘上读回一片的元信息」共用。
const RE_SHARD_GEN = /^-\s*本片属于第\s*(\d+)\s*代（该代源 sha256\s*`([0-9A-Fa-f]{64})`\s*·\s*([\d,]+)\s*B）\s*$/m
const RE_SHARD_ORIG_RANGE = /^-\s*本片原始字节区间：([\d,]+)\.\.([\d,]+)/m
const RE_SHARD_HEADER_BYTES = /^-\s*片头字节数（校验时按此精确剥离片头）：([\d,]+)\s*$/m

/** 从盘上读一片归档片，解析出它的代归属与片头/正文字节数。读不到代标记就返回 generation:null。 */
function readShardFacts(absPath) {
  const raw = readFileSync(absPath)
  const head = raw.toString('utf8')
  const mg = RE_SHARD_GEN.exec(head)
  const mh = RE_SHARD_HEADER_BYTES.exec(head)
  const headerBytes = mh ? Number(mh[1].replace(/,/g, '')) : null
  return {
    raw,
    headerBytes,
    bodyBytes: headerBytes === null ? null : raw.length - headerBytes,
    generation: mg ? Number(mg[1]) : null,
    genSourceSha256: mg ? mg[2].toUpperCase() : null,
    genSourceBytes: mg ? Number(mg[3].replace(/,/g, '')) : null,
  }
}

// ------------------------------------------------------------------ 小工具
const sha = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase()
const bytesOf = (s) => Buffer.byteLength(s, 'utf8')

// ------------------------------------------------------------------ 自指纹（裁定 #33 三）
// 这一代是哪一版工具切的？台账里记 `toolSha256` 就是为回答这个问题（A 真的问过一次，
// 而当时的产物答不出来）。取不到自己时记 `null` —— **不补 64 个 0 的假 sha**。
const SELF_PATH = fileURLToPath(import.meta.url)
let TOOL_SHA256 = null
try {
  TOOL_SHA256 = sha(readFileSync(SELF_PATH))
} catch {
  TOOL_SHA256 = null
}
const fmt = (n) => n.toLocaleString('en-US')
const rel = (p, base) => {
  const r = path.relative(base, p)
  return r === '' ? '.' : r
}

/**
 * 行数口径（写死，免得各人数法不同）：**逻辑行数**。
 *   以 \n 结尾 ⇒ = \n 个数；不以 \n 结尾且非空 ⇒ = \n 个数 + 1（末行无终结符也是一行）；空文件 = 0。
 * 对「以 \n 结尾」的文本，本口径与 `wc -l` / `grep -c ''` / `awk 'END{print NR}'` 三者一致。
 * ⚠️ 与 `text.split('\n').length` **不等**：后者在末尾 \n 之后会多算一个空串（N 行变 N+1）。
 * 本仓库的 .github/workflows 里出现过 213 vs 212 的读数差，根因正是这个，不是换行符问题。
 */
function countLines(buf) {
  if (buf.length === 0) return 0
  let n = 0
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) n += 1
  return buf[buf.length - 1] !== 0x0a ? n + 1 : n
}

/** 二分找「包含字节偏移 off 的那一节」的下标（sections 按 startByte 升序且首尾覆盖全文件）。 */
function sectionIndexAt(sections, off) {
  let lo = 0
  let hi = sections.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (sections[mid].startByte <= off) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 逐行起点（字节偏移）表，最后一项是文件末尾，便于「行号区间 → 字节区间」。 */
function lineStarts(buf) {
  const starts = [0]
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) starts.push(i + 1)
  if (starts[starts.length - 1] === buf.length) starts.pop() // 末尾换行不产生新行
  return starts
}

function fail(code, why) {
  console.error(`⛔ ${why}`)
  process.exit(code)
}

// ------------------------------------------------------------------ 用法
function usage() {
  const L = [
    '用法：node scripts/board-rotate.mjs --file <path> [--plan | --apply | --verify] [选项]',
    '',
    '子命令（三选一，默认 --plan）：',
    '  --plan        只读。算区间/分类/尺寸预测，不改盘。',
    '  --apply       写归档片 + 重写活动片；写前备份、写后自动校验、失败回滚。',
    '  --verify      事后校验：归档片 sha / 保留区间 sha / 拼接 == 全文件 sha 三条。',
    '',
    '选项：',
    '  --file <path>          要轮换的分片（必填；绝对路径，或相对 --root 解析）',
    '  --root <dir>           相对路径解析根（默认：本脚本所在仓库根）',
    '  --archive-dir <path>   归档片目录（默认 <file 所在目录>/archive）',
    '  --boundary <regex>     节边界正则，逐行测试（默认 \'^##\\s\'）；可重复给出，任一命中即为边界',
    '  --sub-boundary <regex> 子节边界正则，仅在「单节超限」时于该节内部启用；可重复给出',
    '  --keep-sections <list> 保留哪些节，如 120-124 或 120,121,125（与 --keep-bytes 二选一）',
    '  --keep-bytes <n>       热区字节上限，自末尾向前逐节纳入（与 --keep-sections 二选一）',
    '  --max-bytes <n>        单片与活动片上限，默认 98304（96 KiB）',
    '  --trigger-bytes <n>    轮换触发线，仅用于 --plan 提示，默认 131072（128 KiB）',
    '  --force                允许对「已轮换过」的活动片再次 --apply（默认拒绝，防静默重切）',
    '  --help, -h             本帮助',
  ]
  console.error(L.join('\n'))
}

// ------------------------------------------------------------------ 解析参数
function parseArgs(argv) {
  const o = {
    root: ROOT_DEFAULT, file: null, archiveDir: null, mode: 'plan',
    boundaries: [], subBoundaries: [], keepSections: null, keepBytes: null,
    maxBytes: MAX_BYTES, triggerBytes: TRIGGER_BYTES, force: false,
  }
  let modeSet = false
  const need = (name) => {
    const v = argv.shift()
    if (v === undefined || v.startsWith('--')) {
      console.error(`未知或缺失参数：${name} 需要一个值`)
      usage(); process.exit(EXIT.USAGE)
    }
    return v
  }
  const num = (name, raw, { min = 1 } = {}) => {
    if (!/^\d+$/.test(raw)) {
      console.error(`参数 ${name} 需要非负整数，实得 ${JSON.stringify(raw)}`)
      process.exit(EXIT.USAGE)
    }
    const n = Number(raw)
    if (n < min) {
      console.error(`参数 ${name} 需要 ≥ ${min}，实得 ${n}`)
      process.exit(EXIT.USAGE)
    }
    return n
  }
  const setMode = (m) => {
    if (modeSet && o.mode !== m) {
      console.error(`子命令互相冲突：已给 --${o.mode}，又给 --${m}`)
      process.exit(EXIT.USAGE)
    }
    o.mode = m; modeSet = true
  }
  while (argv.length) {
    const a = argv.shift()
    const eq = a.indexOf('=')
    const key = eq > 0 ? a.slice(0, eq) : a
    const inline = eq > 0 ? a.slice(eq + 1) : null
    const val = () => (inline !== null ? inline : need(key))
    switch (key) {
      case '--plan': setMode('plan'); break
      case '--apply': setMode('apply'); break
      case '--verify': setMode('verify'); break
      case '--force': o.force = true; break
      case '--help': case '-h': usage(); process.exit(EXIT.PASS)
      case '--root': o.root = path.resolve(val()); break
      case '--file': o.file = val(); break
      case '--archive-dir': o.archiveDir = val(); break
      case '--boundary': o.boundaries.push(val()); break
      case '--sub-boundary': o.subBoundaries.push(val()); break
      case '--keep-sections': o.keepSections = val(); break
      case '--keep-bytes': o.keepBytes = num(key, val()); break
      case '--max-bytes': o.maxBytes = num(key, val(), { min: 64 }); break
      case '--trigger-bytes': o.triggerBytes = num(key, val(), { min: 64 }); break
      default:
        console.error(`未知参数 ${a}`)
        usage(); process.exit(EXIT.USAGE)
    }
  }
  if (!o.file) { console.error('缺少必填参数 --file'); usage(); process.exit(EXIT.USAGE) }
  if (o.keepSections !== null && o.keepBytes !== null) {
    console.error('--keep-sections 与 --keep-bytes 是二选一，不能同时给出（避免两条保留规则打架）')
    process.exit(EXIT.USAGE)
  }
  if (!o.boundaries.length) o.boundaries.push('^##\\s')
  o.boundariesRaw = o.boundaries.slice()
  o.subBoundariesRaw = o.subBoundaries.slice()
  o.boundaries = o.boundaries.map((s) => new RegExp(s, 'm'))
  o.subBoundaries = o.subBoundaries.map((s) => new RegExp(s, 'm'))
  for (const re of [...o.boundaries, ...o.subBoundaries]) void re
  return o
}

// ------------------------------------------------------------------ 切节
/**
 * 按行测试边界正则，切出字节区间。返回 [{ idx, num, label, startByte, endByte, startLine, endLine, hashes }]。
 * @param {Buffer} buf 原始字节
 * @param {RegExp[]} boundaries 逐行测试的边界正则（任一命中即为节首行）
 */
function splitSections(buf, boundaries) {
  const starts = lineStarts(buf)
  const lines = []
  for (let i = 0; i < starts.length; i += 1) {
    const s = starts[i]
    const e = i + 1 < starts.length ? starts[i + 1] : buf.length
    lines.push({ s, e, text: buf.subarray(s, e).toString('utf8') })
  }
  const headLine = []
  for (let i = 0; i < lines.length; i += 1) {
    if (boundaries.some((re) => re.test(lines[i].text))) headLine.push(i)
  }
  const out = []
  // preamble：首行到第一个节首行之前；若第一节就从 L0 开始，则没有 preamble
  if (headLine.length === 0) {
    if (buf.length > 0) {
      out.push({ idx: 0, num: 0, label: '§0', startByte: 0, endByte: buf.length, startLine: 0, endLine: lines.length - 1 })
    }
    return { sections: out, lines, preambleBytes: buf.length }
  }
  if (headLine[0] > 0) {
    const endByte = lines[headLine[0]].s
    out.push({ idx: 0, num: 0, label: '§0', startByte: 0, endByte, startLine: 0, endLine: headLine[0] - 1 })
  }
  for (let k = 0; k < headLine.length; k += 1) {
    const from = headLine[k]
    const to = k + 1 < headLine.length ? headLine[k + 1] : lines.length
    const startByte = lines[from].s
    const endByte = to < lines.length ? lines[to].s : buf.length
    const parent = out.length ? out[out.length - 1].num : 0
    out.push({
      idx: out.length, num: parent + 1, label: null,
      startByte, endByte, startLine: from, endLine: to - 1,
      title: lines[from].text.replace(/\r?\n$/, ''),
    })
  }
  return { sections: out, lines, preambleBytes: headLine[0] > 0 ? lines[headLine[0]].s : 0 }
}

/** 从节标题里取可读标签：优先题号，否则用序号（**不带 § 前缀**；拼 § 由下游模板自己负责）。 */
function labelFor(sec) {
  if (sec.ordinal !== null && sec.ordinal !== undefined) return `§${sec.ordinal}`
  return `§${sec.idx}`
}
/**
 * 工具**自己生成**的段（不是人类手写的正文节）：元数据块、归档索引、读法。
 * 判据用「字节级标记 + 固定标题」，不用「标题里有没有数字」—— 判据越依赖标题文本，
 * 越会在有人改措辞时静默失效（本文件刚因「片名取序号而非题号」栽过一次，见裁定 #42）。
 * ⚠ 这条闸门是**独立于** ordinalOf 正则的第二道：即使有人把正则放宽，生成段也拿不到题号。
 */
const GENERATED_SECTION_TITLES = [
  META_BEGIN,        // 元数据块：<!-- board-rotate:begin -->
  '## 归档索引',
  '## 读法（§4.13.2b）',
]
function isGeneratedSection(sec) {
  if (!sec) return false
  if (Number(sec.idx) === 0) return true                      // preamble（抬头），工具合成，从来不是正文节
  return GENERATED_SECTION_TITLES.includes(String(sec.title || '').trim())
}
/**
 * 从节标题里取题号：**只认 `## §N` 这种题号式**，且工具自生成的段一律豁免（返回 null ⇒ 回落序号标签）。
 * ⚠ 已知失效面（裁定 #43 的残留限制，写在这里免得下一个人重新发现）：`## 25. 标题` 这类
 * 「无 § 的旧式编号」**取不到题号**，会回落成序号 —— 这是**刻意的**：旧正则 `/^#{1,6}\s*§?\s*(\d+)/`
 * 会把 `## 152. 无 § 的题号式` 里的 152 当题号，而 152 在本板的语义里不是节号。
 * 若将来要认旧式编号，必须**同时**保证生成段豁免仍然生效，否则又会给生成段发号。
 */
function ordinalOf(sec) {
  if (!sec || isGeneratedSection(sec)) return null
  const m = /^#{1,6}\s*§\s*(\d+)(?:\s|$)/.exec(sec.title || '')
  return m ? Number(m[1]) : null
}

/** 在某一节内部按 sub-boundary 再切（仅用于单节超限）。不跨片。 */
function splitSub(buf, sec, subs) {
  if (!subs.length) return null
  const starts = lineStarts(buf)
  const lines = []
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i] < sec.startByte || starts[i] >= sec.endByte) continue
    const e = i + 1 < starts.length ? starts[i + 1] : buf.length
    lines.push({ s: starts[i], e: Math.min(e, sec.endByte), text: buf.subarray(starts[i], Math.min(e, sec.endByte)).toString('utf8') })
  }
  const head = []
  for (let i = 0; i < lines.length; i += 1) if (subs.some((re) => re.test(lines[i].text))) head.push(i)
  if (!head.length) return null
  const out = []
  if (head[0] > 0) out.push({ startByte: lines[0].s, endByte: lines[head[0]].s, startLine: sec.startLine })
  for (let k = 0; k < head.length; k += 1) {
    const from = head[k]
    const to = k + 1 < head.length ? head[k + 1] : lines.length
    out.push({
      startByte: lines[from].s,
      endByte: to < lines.length ? lines[to].s : sec.endByte,
      startLine: sec.startLine + from,
    })
  }
  return out
}

// ------------------------------------------------------------------ 分类：哪些留、哪些归档
function parseKeepSections(raw, maxIdx) {
  const set = new Set()
  for (const piece of raw.split(',')) {
    const t = piece.trim()
    if (!t) continue
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(t)
    if (m) {
      const a = Number(m[1]); const b = Number(m[2])
      if (a > b) { console.error(`--keep-sections 区间倒置：${t}`); process.exit(EXIT.USAGE) }
      for (let i = a; i <= b; i += 1) set.add(i)
    } else if (/^\d+$/.test(t)) {
      set.add(Number(t))
    } else {
      console.error(`--keep-sections 无法解析：${JSON.stringify(t)}（应为 12 或 12-20 或 12,14,20）`)
      process.exit(EXIT.USAGE)
    }
  }
  for (const i of set) {
    if (i < 0 || i > maxIdx) {
      console.error(`--keep-sections 给出的节序号 ${i} 超出范围 0..${maxIdx}`)
      process.exit(EXIT.USAGE)
    }
  }
  if (!set.size) { console.error('--keep-sections 解析后为空'); process.exit(EXIT.USAGE) }
  return set
}

// ------------------------------------------------------------------ 渲染
function renderMeta(md) {
  // `headerText` 与 `body` 两个字段必须在序列化时剔除，都不是风格问题：
  //   `headerText` —— 片头的副本（--apply 写归档片时原样照抄的那份文本），留在内存里即可，
  //                   写进 JSON 等于把「正在生成的归档片」内联进活动片；
  //   `body`       —— 该片的原文 Buffer。**漏掉这一个后果极重**：JSON.stringify 会把 Buffer
  //                   展开成长度 N 的数字数组，实测让真 a.md 的活动片从 27 KB 膨胀到 10.6 MB
  //                   （把整个源文件又抄了一遍，还伪装成一个「索引」）。
  //                   它是怎么溜进来的：预算收敛循环会把 meta.shards 整个换成 buildShards()
  //                   的新数组，那一数组的条目**带 body**，于是活动片里「索引」变成了「全文」。
  // --verify 只需要标量字段（sha/字节/行数/区间），剔除后信息不丢；另加一条 Buffer 形状兜底。
  const json = JSON.stringify(md, (k, v) => {
    if (k === 'headerText' || k === 'body') return undefined
    // `sourceRel` —— 裁定 #33 缺陷 A：这一项是「相对 --root 的路径」，本意只给人看，
    // 但它**照样被串进了产物**。实测：同一份真 a.md 放进两个长度不同的目录各跑一次 `--apply`
    // ⇒ 归档片目录逐字节相同，活动片却差 15 B（= 两个路径长度之差），连带 paneFrom/paneTo、
    // newGenBlockBytes 全部平移 ⇒ 判据「同源 + 同版本 ⇒ 同字节」当场不成立。
    // 所以它必须在**序列化这一层**被剔除（放在 `renderMeta` 而不是构造 `meta` 的地方，
    // 是为了让 stdout 报告仍能打印它、而产物里一定没有）。注释与实现必须一致。
    if (k === 'sourceRel') return undefined
    if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) return undefined
    return v
  }, 2)
  return [META_BEGIN, '```json', json, '```', META_END].join('\n')
}

function renderShardHeader(md, shard) {
  const L = []
  L.push(`# 归档片：${md.role}-${shard.seq3} —— 原节区间 §${shard.fromLabel}–§${shard.toLabel}`)
  L.push('')
  L.push(`> **归档片，只增不改**（\`team-charter.md\` §4.13.2b-4）。更正写进当前活动片 \`board/${md.role}.md\`，并注明「更正了 ${shard.file} 的 <哪一处>」。`)
  L.push('> 本片由 `scripts/board-rotate.mjs` 机械切出；**片头之后的正文 = 原文件的一段连续字节**，拼接校验见活动片的 `board-rotate:meta`。')
  L.push('> 取用：`grep` 本片，或按活动片索引定位；**不需要读整片**。')
  // 口径说明（裁定 #43-1）。为什么要写：片名/索引里的 §N 有**两种来源**（真题号 / 无题号时的本代序号），
  // 而在「归档段从文件中段开始」的代里两者会差很多（第 2 代实测：序号 1–20 ↔ 题号 122–139）。
  L.push('> **本节区间口径**：有 § 标题用其题号，无题号者用本代序号。**编号只作指路，不作判据**；判据是 §0 内容锚与字节/摘要。')
  L.push('')
  L.push(`- 源文件：\`${md.source}\``)
  // 裁定 #29.5：片头必须自证「本片属于第几代」，并带上该代的源指纹。
  // 为什么不能省：第二轮轮换的源是「已被重写过的活动片」，偏移原点与原始文件不同；
  // 没有代标记，第一批归档片就成了「没人能独立复算它属于哪个坐标空间」的中间态。
  // ⚠️ 这是**片头里的定值**（由 md.generation / md.sourceSha256 派生），不参与长度不动点迭代，
  // 因此不会重新引入「片头 → 摘要 → 片头」的自指。
  L.push(`- 本片属于第 ${md.generation} 代（该代源 sha256 \`${md.sourceSha256}\` · ${fmt(md.sourceBytes)} B）`)
  L.push(`- 源文件轮换前：sha256 \`${md.sourceSha256}\` · ${fmt(md.sourceBytes)} B · ${fmt(md.sourceLines)} 行`)
  L.push(`- 本片原始字节区间：${fmt(shard.startByte)}..${fmt(shard.endByte)}（字节下标左闭右开，含末字节）`)
  L.push(`- 本片原始行区间：L${fmt(shard.startLine + 1)}..L${fmt(shard.endLine + 1)}`)
  L.push(`- 本片正文：${fmt(shard.bodyBytes)} B · ${fmt(shard.bodyLines)} 行 · sha256 \`${shard.bodySha256}\``)
  L.push(`- 片头字节数（校验时按此精确剥离片头）：${fmt(shard.headerBytes)}`)
  L.push(`- 本片整文件：${fmt(shard.fileBytes)} B · ${fmt(shard.fileLines)} 行（**整文件 sha256 不在本行**：片头里写整片摘要会让「摘要」依赖「片头」、而「片头」又依赖「摘要」，即给 sha256 解不动点，**无确定解**（实测永不收敛）。整片摘要只记在活动片的归档索引与 \`board-rotate:meta\` 里，其值由 \`--apply\` **写出后实测**填回、由 \`--verify\` 与盘上字节对拍。）`)
  L.push('')
  L.push('---')
  L.push('')
  return L.join('\n')
}

function renderReadme() {
  const L = []
  L.push('## 读法（§4.13.2b）')
  L.push('')
  L.push('1. **本片片头**就是活状态 + 索引 + 读法 + 最近窗口；进任务先读这一段（通常 ≤ 60 行）。')
  L.push('2. 需要历史细节时：**按索引 `grep` 或读指定归档片**——`board/archive/<角色>-NNN-*.md`。')
  L.push('3. **「把某片整体读一遍」不再是任何流程的一步**；需要「全景」时读**四片的片头**。')
  L.push('4. §4.13.2「board 是唯一事实源；消息只是提示」不变——**归档片同样是事实源**，只是改为按索引取。')
  L.push('5. 归档片**只增不改**；后续更正写进本活动片，并注明更正了哪一片的哪一处。')
  L.push('')
  return L.join('\n')
}

function renderArchiveIndex(shards, m) {
  const L = []
  L.push('## 归档索引')
  L.push('')
  // 判据（A 裁定 #29.3）：**只读一行索引，就能唯一确定「读哪个文件、读它的哪一段」**。
  // 因此每行自足携带：片名（含 part k/m，唯一）· 原始节区间 · **该片在原始文件中的字节区间 start..end**
  // · 正文字节 · 正文行数 · 正文 sha256 · 整片 sha256。
  // 「读它的哪一段」= 字节区间列；「读哪个文件」= 片名列（part 标记保证它在多切时仍唯一）。
  // ⚠ 「原节区间」列的口径见下方 L.push 的口径句 —— 它是片头「本节区间口径」句的同一条，
  //    两处必须逐字一致（否则读者会以为片名与索引用的不是同一套编号）。
  L.push('> **原节区间口径**：有 § 标题用其题号，无题号者用本代序号。**编号只作指路，不作判据**；判据是 §0 内容锚与字节/摘要。')
  L.push('')
  L.push('| 片 | 段 | 原节区间 | 该片在原始文件中的字节区间 | 正文字节 | 正文行数 | 正文 sha256 | 整片 sha256 |')
  L.push('|---|---|---|---|---|---|---|---|')
  for (const s of shards) {
    // 整片 sha256 由 --apply 写出后实测填回；--plan 阶段这里是等长占位符（64 个 0）。
    // ⇒ 有无实测值都**不影响索引的行长与字节数**，所以 --plan 预告的尺寸就是 --apply 写出的尺寸。
    // 这也是为什么它只出现在「活动片里的索引」，不出现在归档片自己的片头里：片头里写整片摘要就是自指。
    const seg = s.partK ? `part ${s.partK}/${s.partM}` : '整节（不拆）'
    L.push(`| \`${s.file}\` | ${seg} | §${s.fromLabel}–§${s.toLabel} | ${fmt(s.startByte)}..${fmt(s.endByte)} | ${fmt(s.bodyBytes)} | ${fmt(s.bodyLines)} | \`${s.bodySha256}\` | \`${s.fileSha256}\` |`)
  }
  L.push('')
  L.push(`切片合计：**${shards.length}** 片 · ${fmt(shards.reduce((a, s) => a + s.bodyBytes, 0))} B（原始字节）。`)
  L.push('')
  L.push('<details><summary>保留区间索引（活动片自身，供 <code>--verify</code> 第 ②③ 条用）</summary>')
  L.push('')
  L.push('| 节 | 原标题 | 原始字节区间 | 字节 | 行数 | sha256 |')
  L.push('|---|---|---|---|---|---|')
  for (const r of m.retained) {
    L.push(`| §${r.label} | ${r.title || '（无标题/抬头）'} | ${fmt(r.startByte)}..${fmt(r.endByte)} | ${fmt(r.bytes)} | ${fmt(r.lines)} | \`${r.sha256}\` |`)
  }
  L.push('')
  L.push('</details>')
  L.push('')
  return L.join('\n')
}

/**
 * 由计划渲染出「活动片将来要写的完整内容」。--plan 与 --apply 共用它，
 * 所以 --plan 报的预测尺寸就是 --apply 会写出的尺寸（不是估算）。
 *
 * ⚠️ 布局不变量（--verify 第 ② 条依赖它）：**只有元数据块、preamble、归档索引、读法指示**
 * 这四段是本工具自己写的；它们之后的字节**按顺序、原封不动**地是各保留区间的原文，
 * 中间不得插入任何外来字节（不加「## 最近窗口」小标题、不改任何保留区间的换行）。
 * 「最近窗口」就是这些保留区间本身，标题由各自的 `## ` 行自带。
 * 因此「活动片里保留区间的偏移」可以精确算出（= 本函数前四段之后的累加偏移），
 * 并逐段用 sha256 与源字节对拍（见 main 里的偏移不动点迭代）；对不上就中止，不写盘。
 */
function renderActive(plan, keptSections, buf) {
  const L = []
  // ⑤ 抬头只出现一次（裁定 #31-⑥）：`§0` 在保留集合里时，抬头会**作为保留区间**在「最近窗口」里
  // 于原序位置渲染一次（就是此函数末尾那个 `for`）。若这里再单独渲染一遍，活动片里就会有
  // 两份逐字节相同的抬头 —— A 的独立检查器量到偏移 12,794 与 19,067 两处同一段 562 B，根因即此。
  // 判据：**§0 在保留集合里 ⇒ 不再单独渲染**；§0 不在保留集合里 ⇒ 仍单独渲染（否则抬头会在
  // 活动片里彻底消失，那比重复更糟 —— 章程把抬头列为活动片四部分之一）。
  const preambleRaw = Buffer.from(plan.preambleText, 'utf8')
  const zeroKept = keptSections.some((s) => s.idx === 0)
  L.push(renderMeta(plan.meta))
  L.push('\n')
  if (preambleRaw.length > 0 && !zeroKept) {
    L.push(plan.preambleText)
    if (!plan.preambleText.endsWith('\n')) L.push('\n')
  }
  L.push(renderArchiveIndex(plan.shards, plan.meta))
  L.push('\n')
  L.push(renderReadme())
  L.push('\n')
  for (const s of keptSections) {
    L.push(buf.subarray(s.startByte, s.endByte).toString('utf8'))
  }
  return L.join('')
}

/**
 * 与 `renderActive` **同一个顺序、同一个分隔符**地列出各段，供「构成账」使用。
 * 两处必须一起改：`piecesOf` 与 `renderActive` 的顺序一旦分叉，--plan 报的账就与实际写出的字节无关。
 * `piecesOf(...).map(p => p.text).join('')` 必须逐字节等于 `renderActive(...)` —— 调用处会断言这一点，
 * 不靠「两段代码长得像」来保证一致（首版的 2 B 对不上就是这么来的：账按一个布局算、字节按另一个布局写）。
 */
function piecesOf(plan, keptSections, buf) {
  const out = []
  out.push({ name: PIECE_META, text: `${renderMeta(plan.meta)}\n` })
  if (plan.preambleText.length > 0 && !keptSections.some((s) => s.idx === 0)) {
    out.push({ name: PIECE_PREAMBLE, text: plan.preambleText.endsWith('\n') ? plan.preambleText : `${plan.preambleText}\n` })
  }
  out.push({ name: PIECE_INDEX, text: `${renderArchiveIndex(plan.shards, plan.meta)}\n` })
  out.push({ name: PIECE_README, text: `${renderReadme()}\n` })
  out.push({ name: `最近窗口（${keptSections.length} 节的原文，逐字节等于源文件对应区间）`, text: keptSections.map((s) => buf.subarray(s.startByte, s.endByte).toString('utf8')).join('') })
  return out
}

// ------------------------------------------------------------------ 元数据解析
function parseMeta(text) {
  const i = text.indexOf(META_BEGIN)
  if (i < 0) return null
  const j = text.indexOf(META_END, i)
  if (j < 0) return null
  const block = text.slice(i + META_BEGIN.length, j)
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(block)
  if (!m) return null
  try {
    return { meta: JSON.parse(m[1]), index: i, end: j + META_END.length }
  } catch (e) {
    return { parseError: String(e && e.message ? e.message : e) }
  }
}

// ------------------------------------------------------------------ 校验
/**
 * 三条校验。返回 { ok, lines[], failures[] }。三条各打印期望值/实得值/是否相等。
 * 判据：①归档片去片头 sha ②活动片保留区间 sha ③「保留 + 归档（按原始顺序）」拼接 == 全文件 sha。
 */
function verifyAll({ meta, activeBuf, activePath, archiveDir, sourceBuf = null, readFile = readFileSync }) {
  const lines = []
  const failures = []
  const say = (s) => lines.push(s)

  // ① 归档片
  say('① 归档片：去片头后的 sha256 / 字节 / 行数 与索引对照')
  const bodies = []
  for (const s of meta.shards) {
    const p = path.isAbsolute(s.file) ? s.file : path.join(archiveDir, path.basename(s.file))
    if (!existsSync(p)) {
      failures.push(`归档片缺失：${s.file}（找的是 ${p}）`)
      say(`   [缺失] ${s.file}`)
      continue
    }
    const raw = readFile(p)
    if (raw.length < s.headerBytes) {
      failures.push(`归档片 ${s.file} 比记录的片头还短`)
      say(`   [异常] ${s.file}：文件 ${raw.length} B < 片头 ${s.headerBytes} B`)
      continue
    }
    const body = raw.subarray(s.headerBytes)
    const gotSha = sha(body)
    const gotBytes = body.length
    const gotLines = countLines(body)
    const ok = gotSha === s.bodySha256 && gotBytes === s.bodyBytes && gotLines === s.bodyLines
    // 整片 sha256：占位符（未实测）时**显式报「未核对」**，绝不与「相等」同形。
    // 是实测值时，与盘上整片字节对拍 —— 这是「索引 vs 盘上字节」唯一的一条独立核对路径
    // （片头里没有整片摘要，所以它不可能自指）。
    const wholeSha = sha(raw)
    const measured = s.fileSha256 && !/^0{64}$/.test(s.fileSha256)
    if (measured) {
      if (wholeSha !== s.fileSha256) {
        failures.push(`归档片 ${s.file} 整片 sha256 不等：索引 ${s.fileSha256} vs 实得 ${wholeSha}`)
      }
      say(`   ${wholeSha === s.fileSha256 ? '[相等]' : '[不等]'} ${s.file} 整片 sha 期望 ${s.fileSha256} / 实得 ${wholeSha} · 整片 ${fmt(s.fileBytes)}/${fmt(raw.length)} B`)
    } else {
      say(`   [未核对] ${s.file} 整片 sha：索引记的是占位符（本片尚未 --apply 写盘）⇒ 整片 sha256 本列为「未核对」，**不得读作相等**`)
    }
    if (!ok) {
      if (gotSha !== s.bodySha256) failures.push(`归档片 ${s.file} 正文 sha256 不等：索引 ${s.bodySha256} vs 实得 ${gotSha}`)
      if (gotBytes !== s.bodyBytes) failures.push(`归档片 ${s.file} 正文字节不等：索引 ${s.bodyBytes} vs 实得 ${gotBytes}`)
      if (gotLines !== s.bodyLines) failures.push(`归档片 ${s.file} 正文行数不等：索引 ${s.bodyLines} vs 实得 ${gotLines}`)
    }
    say(`   ${ok ? '[相等]' : '[不等]'} ${s.file}  sha 期望 ${s.bodySha256} / 实得 ${gotSha} · 字节 ${s.bodyBytes}/${gotBytes} · 行 ${s.bodyLines}/${gotLines}`)
    bodies.push({ ...s, body, localPath: p })
  }

  // ② 活动片保留区间
  say('② 活动片：保留区间（就地取字节）的 sha256 / 字节 / 行数 与索引对照')
  const activeBytes = activeBuf
  for (const r of meta.retained) {
    const a = r.activeStartByte
    const b = r.activeEndByte
    if (a === undefined || b === undefined || b > activeBytes.length || a > b) {
      failures.push(`保留区间 §${r.label} 的 activeStart/End 越界或缺失`)
      say(`   [异常] §${r.label}：active ${a}..${b}（活动片 ${activeBytes.length} B）`)
      continue
    }
    const slice = activeBytes.subarray(a, b)
    const gotSha = sha(slice)
    const gotBytes = slice.length
    const gotLines = countLines(slice)
    const ok = gotSha === r.sha256 && gotBytes === r.bytes && gotLines === r.lines
    if (!ok) {
      if (gotSha !== r.sha256) failures.push(`保留区间 §${r.label} sha256 不等：索引 ${r.sha256} vs 实得 ${gotSha}`)
      if (gotBytes !== r.bytes) failures.push(`保留区间 §${r.label} 字节不等：索引 ${r.bytes} vs 实得 ${gotBytes}`)
      if (gotLines !== r.lines) failures.push(`保留区间 §${r.label} 行数不等：索引 ${r.lines} vs 实得 ${gotLines}`)
    }
    say(`   ${ok ? '[相等]' : '[不等]'} §${r.label}  sha 期望 ${r.sha256} / 实得 ${gotSha} · 字节 ${r.bytes}/${gotBytes} · 行 ${r.lines}/${gotLines}`)
  }

  // ③ 拼接
  say('③ 拼接：「保留区间（按原始偏移升序）+ 归档片正文（按原始偏移升序）」== 全文件 sha256')
  const spans = [
    ...meta.retained.map((r) => ({ startByte: r.startByte, endByte: r.endByte, buf: activeBytes.subarray(r.activeStartByte, r.activeEndByte), tag: `保留 §${r.label}` })),
    ...bodies.map((s) => ({ startByte: s.startByte, endByte: s.endByte, buf: s.body, tag: s.file })),
  ].sort((x, y) => x.startByte - y.startByte)

  let cursor = 0
  let gapOrOverlap = null
  for (const sp of spans) {
    if (sp.startByte !== cursor) {
      gapOrOverlap = `期望下一段从 ${fmt(cursor)} 开始，实得 ${sp.tag} 从 ${fmt(sp.startByte)} 开始（${sp.startByte > cursor ? '缺' : '重叠'}了 ${fmt(Math.abs(sp.startByte - cursor))} B）`
      break
    }
    cursor = sp.endByte
  }
  if (!gapOrOverlap && cursor !== meta.sourceBytes) {
    gapOrOverlap = `拼完停在 ${fmt(cursor)} B，但源文件是 ${fmt(meta.sourceBytes)} B（${cursor < meta.sourceBytes ? '缺' : '多'}了 ${fmt(Math.abs(meta.sourceBytes - cursor))} B）`
  }
  if (gapOrOverlap) {
    failures.push(`拼接不连续：${gapOrOverlap}`)
    say(`   [不等] 区间不连续 —— ${gapOrOverlap}`)
  } else {
    const joined = Buffer.concat(spans.map((s) => s.buf))
    const gotSha = sha(joined)
    const ok = gotSha === meta.sourceSha256 && joined.length === meta.sourceBytes
    if (!ok) failures.push(`拼接 sha256 不等：期望 ${meta.sourceSha256} vs 实得 ${gotSha}（${joined.length} B vs ${fmt(meta.sourceBytes)} B）`)
    say(`   ${ok ? '[相等]' : '[不等]'} 拼接 sha 期望 ${meta.sourceSha256}`)
    say(`                  实得 ${gotSha} · 拼接后 ${fmt(joined.length)} B / 源文件 ${fmt(meta.sourceBytes)} B`)
  }

    // ④ 逐代复算（裁定 #29.5）
  //
  // 为什么必须有这一条：第二次轮换的源是「已被重写过的活动片」，它的偏移原点与原始文件**不是同一个**。
  // 只验当前代（①②③）会让第一代那批归档片变成「没人能独立复算的中间态」。
  // 这里对**每一代**复算不变式：该代归档片正文字节之和 + 该代保留区间字节之和 == 该代源文件字节数。
  //
  // 怎么算「该代归档正文」：**按元数据台账里记的那一代片清单**逐片读盘，
  // 用「盘上整片字节 − 片头自述的片头字节数」得正文。刻意不依赖「本片属于第 N 代」这条片头行 ——
  // 那是后加的字段，第一批归档片没有它；只认它的话第 1 代永远只能报「未核对」，等于没验。
  // 片头的另外两个自证字段（该代源 sha256/字节）**有则用作交叉印证**（旁证，缺了不算失败）。
  const gens = Array.isArray(meta.generations) ? meta.generations : []
  // 当代号：只有当代的生成块字节还在盘上（就在活动片开头），旧代的已被覆盖。
  const currentGen = meta.generation === undefined || meta.generation === null ? (gens.length ? gens[gens.length - 1].generation : null) : meta.generation
  if (gens.length) {
    say('④ 逐代复算（每代：归档正文 + 该代保留区间 == 该代源文件字节数）')
    for (const g of gens) {
      const listed = Array.isArray(g.shards) ? g.shards : []
      if (!listed.length) {
        say(`   [未核对] 第 ${g.generation} 代：台账里没记该代片清单 ⇒ **不得读作相等**`)
        continue
      }
      let bodyBytes = 0
      let missing = 0
      let nullHeader = 0
      let markerOk = 0
      let markerBad = 0
      // 裁定 #31-④：归档正文**逐字节读出**（不是只累加自述的字节数），供 sha256 级复算。
      // ⚠️ 正文切片必须用 `盘上整片字节 − 片头自述的片头字节数`，不能靠片头代标记认领 ——
      // 第一批归档片没有代标记，只认标记等于让第 1 代永远报「未核对」。
      const bodyParts = []
      // 当代的「保留原文」从**活动片自己**按台账记的偏移切片取（`--verify` 的第 ② 条已经在做同一件事）；
      // 旧代的保留原文已不在盘上 ⇒ 空数组，下面的长度断言会把「对不上」如实报出来。
      const keptActiveParts = (g.generation === currentGen && Array.isArray(meta.retained))
        ? meta.retained
          .filter((r) => Number.isInteger(r.activeStartByte) && Number.isInteger(r.activeEndByte))
          .map((r) => activeBytes.subarray(r.activeStartByte, r.activeEndByte))
        : []
      for (const f of listed) {
        const p = path.join(archiveDir, path.basename(f))
        if (!existsSync(p)) { missing += 1; continue }
        const facts = readShardFacts(p)
        if (facts.headerBytes === null || facts.bodyBytes === null) { nullHeader += 1; continue }
        bodyBytes += facts.bodyBytes
        const raw = readFileSync(p)
        bodyParts.push(raw.subarray(facts.headerBytes))
        if (facts.generation === g.generation) markerOk += 1
        else if (facts.generation !== null) markerBad += 1
      }
      if (missing || nullHeader) {
        failures.push(`第 ${g.generation} 代：台账记的 ${listed.length} 片里有 ${missing} 片在盘上找不到、${nullHeader} 片读不出片头字节数 ⇒ 该代无法复算`)
        say(`   [不等] 第 ${g.generation} 代：缺 ${missing} 片 / 片头不可读 ${nullHeader} 片（台账 ${listed.length} 片）`)
        continue
      }
      // 台账自报值 vs 盘上实得值（台账：该代源 − 该代保留）
      const declared = Math.max(0, g.sourceBytes - g.retainedBytes)
      const ok = bodyBytes === declared && bodyBytes === g.archivedBodyBytes
      if (!ok) {
        failures.push(`第 ${g.generation} 代不变式不成立：盘上归档正文 ${fmt(bodyBytes)} B vs 台账推算 ${fmt(declared)} B vs 台账记的 ${fmt(g.archivedBodyBytes)} B`)
      }
      const markerNote = markerBad
        ? `· ⚠ ${markerBad} 片的代标记**指向别代**（台账与片头不一致）`
        : (markerOk === listed.length ? '· 片头代标记全部一致' : `· 片头代标记 ${markerOk}/${listed.length}（其余是加该字段之前的旧片，无标记）`)
      const gotBodySha = sha(Buffer.concat(bodyParts))
      const bodyShaOk = g.archivedBodySha256 ? gotBodySha === g.archivedBodySha256 : null
      if (bodyShaOk === false) {
        failures.push(`第 ${g.generation} 代归档正文 sha256 不等：盘上 ${gotBodySha} vs 台账 ${g.archivedBodySha256}`)
      }
      say(`   ${ok ? '[相等]' : '[不等]'} 第 ${g.generation} 代：盘上归档正文 ${fmt(bodyBytes)} / 台账推算 ${fmt(declared)} B（${listed.length} 片）${markerNote}`)
      say(`        · 归档正文 sha256（盘上拼接）${gotBodySha}`)
      say(`        · 台账记的归档正文 sha256     ${g.archivedBodySha256 || '(未记)'} ⇒ ${bodyShaOk === null ? '[未核对]（该代台账里没记这条，**不得读作相等**）' : (bodyShaOk ? '[相等]' : '[不等]')}`)
      say(`        · 台账记的保留原文 sha256     ${g.retainedSha256 || '(未记)'} · 保留 ${fmt(g.retainedBytes)} B ⇒ ${g.retainedSha256 ? '[当代可由活动片字节复核，见下]' : '[未核对]'}`)
      if (markerBad) failures.push(`第 ${g.generation} 代：${markerBad} 片的片头代标记不等于该代号`)

      // ---- 当代三段的恒等式（裁定 #31-④ / 口径见 #32-③）
      //
      //   sha256(A_src ‖ 归档正文(原偏移序) ‖ 保留原文(原偏移序)) == 该代源 sha256
      //
      // 其中 A_src（生成块）= 元数据块 + 归档索引 + 读法 + 抬头，它**不含**归档正文与保留原文。
      // 判据拆成两条无自指的算术等式（生成块自身含台账 ⇒ 不能给自己记 sha，见台账注释）：
      //   ㈠ 归档正文 + 保留原文 + 生成块 == 该代源字节数
      //   ㈡ 归档正文 ‖ 保留原文 == 该代源文件的 后 N 字节（N = 该代源 − 生成块）
      // 当代才有「生成块字节数」，旧代只能报「不可再验」——**不得与「相等」同形**。
      if (g.generation === currentGen) {
        // ⚠️ `aSrc` 这一行**不能删**：删掉它下面的块会 `ReferenceError: aSrc is not defined`（实测踩过，
        // 而且 `node --check` 查不出来 —— 语法没问题，只是运行期未定义）。
        // ㈠ 的通用算式在**事后统计那一遍**里独立成立（那一遍不依赖本分支），这里保留的是当代专用的读法。
        const aSrc = g.sourceGenBlockBytes === null || g.sourceGenBlockBytes === undefined ? null : Number(g.sourceGenBlockBytes)
        if (aSrc === null) {
          say(`        · 恒等式：该代台账里没有 A_src 字节数（上一版元数据未记保留区间偏移）⇒ [不可再验]（**不得读作相等**）`)
        } else {
          const lhs = g.archivedBodyBytes + g.retainedBytes + aSrc
          const okA = lhs === g.sourceBytes
          if (!okA) failures.push(`第 ${g.generation} 代恒等式㈠不成立：归档正文 ${g.archivedBodyBytes} + 保留原文 ${g.retainedBytes} + A_src ${aSrc} = ${lhs} ≠ 该代源字节数 ${g.sourceBytes}`)
          say(`        · 恒等式㈠ 归档正文 ${fmt(g.archivedBodyBytes)} + 保留原文 ${fmt(g.retainedBytes)} + A_src ${fmt(aSrc)} = ${fmt(lhs)} / 该代源 ${fmt(g.sourceBytes)} ⇒ ${okA ? '[相等]' : '[不等]'}`)
          if (aSrc === 0) {
            say(`            （A_src = 0：第 1 代的源文件是人类手写的，开头没有生成块 —— 这是**观测**，不是假设）`)
          }
          // ⚠️ **不许写成 `Buffer.concat(bodyParts, N)`**：`Buffer.concat(list, totalLength)` 在
          // `totalLength` 大于各段之和时**用未初始化内存（本机表现为 \0）补齐到 N**，不报错。
          // 本行原来就是那个写法（N = 归档正文 + 保留原文），而 `bodyParts` 只装了**归档正文**那一段
          // ⇒ 尾部 30 B 全是 \0，sha256 每次都是另一个值、且与源文件毫无关系。
          // 症状极具误导性：长度看着正好是 43（对得上源文件），sha 不等，于是被读成「字节搬错了」。
          // 正确写法是先把两半各自拼出来、再拼一起，并**断言总长**。
          // ---- 规范拼接（裁定 #32-③ 的**字面**口径）----
          //
          //   sha256(该代每一节按**原始偏移升序**拼接、剥掉节边界之外的一切) == 该代源 sha256
          //
          // 为什么不能写成「归档正文 ‖ 保留原文」两段式：保留原文那一段原先是按台账偏移从**当代活动片**
          // 里切的，而活动片里的 §0（抬头）落在**生成块**区域（不是保留区）⇒ 切出来是 25 B 而不是 30 B，
          // 拼不出源文件。规范拼接不依赖活动片布局：每一节的字节都回到**该代源文件的坐标**去取。
          //   · 归档节的字节：从盘上归档片正文取（其内容按判据与源字节相等）
          //   · 保留节的字节：从该代源文件本身取（该代源就是当代活动片，现在还在盘上）
          // 于是既没有 §0 这个特例，也完全不需要 A_src 在前、保留原文在后的布局假设。
          const frags = []
          for (const f of listed) {
            const p0 = path.join(archiveDir, path.basename(f))
            const f0 = readShardFacts(p0)
            const m = RE_SHARD_ORIG_RANGE.exec(f0.raw.toString('utf8'))
            if (!m || f0.headerBytes === null) {
              failures.push(`第 ${g.generation} 代：归档片 ${path.basename(f)} 的片头里读不到「本片原始字节区间」/片头字节数 ⇒ 无法定位它在源文件里的坐标（**不得读作相等**）`)
              continue
            }
            frags.push({ from: Number(m[1].replace(/,/g, '')), to: Number(m[2].replace(/,/g, '')), buf: f0.raw.subarray(f0.headerBytes), what: path.basename(f) })
          }
          // 保留节的字节：回到**该代源文件的坐标**去取。
          //
          // ⚠️ 这里有个已经踩过的坑：不能拿**当代活动片**里那份 `meta.retained[].activeStartByte`
          // 去切片。那组偏移是相对**本轮新写出去的活动片**的（它在盘上是 4,835 B），而「该代源文件」
          // 是**上一版**活动片（tiny 的第 1 代源就是人类手写的那 43 B）。用新片的偏移去切旧源，
          // 切出来的是另一个节的字节，而且**长度可能碰巧对得上**（§2 那条切出 13 B = §1 的字节）
          // ⇒ 症状是「长度合理、sha 不等」，极难看出来。
          //
          // 正确的坐标是**源文件坐标**，台账里本来就记着：`meta.retained[].startByte / endByte`
          //（`meta.retained` 由 `kept.map(...)` 生成，那两个字段直接来自源文件的节切分）。
          // 当代时它描述的正是「该代源文件」——不是新片。
          // 保留节的字节：回到**该代源文件的坐标**去取（台账 `retainedSourceCoords` 就是那组坐标）。
          //
          // ⚠️ 不能用 `meta.retained[].activeStartByte` 那组偏移：它们是相对**本轮新写出去的活动片**的，
          // 而「该代源文件」是**上一版**活动片（tiny 第 1 代的源就是人类手写的那 43 B）。用新片偏移
          // 去切旧源，切出来是别的节，而且**长度可能碰巧相等**（实测 §2 那条切出 13 B = §1 的字节）
          // ⇒ 症状是「长度对得上、sha 不等」，极难看出。
          const retainedCoord = Array.isArray(g.retainedSourceCoords) ? g.retainedSourceCoords : null
          if (!retainedCoord) {
            say(`        · ⚠ 该代台账里没有「保留节源坐标表」（\`retainedSourceCoords\`，旧版元数据未记）⇒ [不可再验]（**不得读作相等**）`)
          }
          // 抬头（§0）补在最前面：它不在任何节里，保留节的坐标覆盖不到它，但它是该代源文件的第 0 段。
          //
          // ⚠️ 切片用的是 `preambleActiveStart/EndByte`（**本轮渲染结果**里的坐标），不是源文件里的
          // 0..preambleSourceBytes。理由见台账里那段注释：`--verify` 的 `activeBuf` 是刚重写过的活动片，
          // 它的 0..5 是元数据块的 `<!-- `，不是抬头。`activeBuf` 里这两组坐标（抬头与保留节）都还有效，
          // 而按判据它们与「该代源文件」里对应位置的字节相同 ⇒ 取新片、比旧代的 sha。
          // 切片用**该代源文件的字节**（`sourceBuf`），坐标用台账里那组**源坐标**。
          //
          // ⚠️ 这两个都不能换成别的东西（三个坑各踩过一次，症状都是「长度对得上、sha 不等」）：
          //   ① 不能用 `activeBuf`：`--verify` 的 `activeBuf` 是**刚刚重写过的活动片**（盘上那份已是新内容），
          //      拿它的 0..5 切出来是元数据块的 `<!-- `，不是抬头（实测）；
          //   ② 不能用活动片坐标 `activeStartByte`：那是相对**新一代**活动片的，而「该代源文件」是**上一版**，
          //      拿新片偏移切旧源会切出别的节，且长度可能碰巧相等（§2 那条切出 13 B = §1 的字节）；
          //   ③ 更不能在 `--apply` 里从盘上重读：源文件此刻**已被覆盖**。
          // 所以：`--apply` 把自己的源缓冲区传进来（`sourceBuf`），`--verify` 直接传球读到的字节。
          // 该代源文件的字节**并不总是拿得到**，所以这两条走**两条不同的路**，不许混：
          //   · 字节在手（`--apply`：源缓冲区 `sourceBuf` 就在内存里；或 `--verify` 跑在**当代**时，
          //     盘上那份活动片**就是**该代源）⇒ 真拼接，直接与该代源 sha256 对拍。
          //   · 字节不在手（`--verify` 跑在**旧代**：源文件已被后续轮换覆盖）⇒ 拼不出来。
          //     此时**不许**拿手上的别的东西凑一个字节串去比（那正是「长度凑巧相等、sha 不等」的来源）；
          //     改走**分片摘要路**：每个归档片正文与台账 `bodySha256` 对拍、每个保留节与台账
          //     `sha256` 对拍、抬头与该代源里的抬头 sha256 对拍，再核「各段字节数之和 == 该代源字节数」。
          //     这一路**不证明**整串 sha 相等 ⇒ 报告里必须写明它证的是什么，**不得读作恒等式㈡成立**。
          // ⚠️ 只认「**当代**的源缓冲区」：`--verify` 会把它自己读到的盘上活动片传进来，
          // 但那份只有在 g 是**当代**时才等于该代源文件；对旧代它是**后代**的字节，
          // 拿它当旧代的源切出来就是另一串（实测：旧代报 69C1A907，真值是 A9D97C52）。
          const src = g.generation === currentGen ? (sourceBuf || null) : null
          const preBytes = g.preambleSourceBytes === null || g.preambleSourceBytes === undefined ? null : Number(g.preambleSourceBytes)
          const haveBytes = !!src
          if (haveBytes) {
            if (preBytes) {
              if (preBytes > src.length) {
                failures.push(`第 ${g.generation} 代：抬头的源字节数 ${fmt(preBytes)} 超出源缓冲区长度 ${fmt(src.length)} ⇒ 台账与手上字节不符`)
              } else {
                frags.push({ from: 0, to: preBytes, buf: src.subarray(0, preBytes), what: `抬头 §0（该代源前 ${fmt(preBytes)} B）` })
              }
            }
            for (const r of (retainedCoord || [])) {
              if (!Number.isInteger(r.from) || !Number.isInteger(r.to)) {
                failures.push(`第 ${g.generation} 代：台账里保留节 ${r.label} 缺源坐标（from/to）⇒ 无法定位（**不得读作相等**）`)
                continue
              }
              if (r.to > src.length) {
                failures.push(`第 ${g.generation} 代：保留节 ${r.label} 的源坐标 ${fmt(r.from)}..${fmt(r.to)} 超出源缓冲区长度 ${fmt(src.length)} ⇒ 台账与手上字节不符`)
                continue
              }
              frags.push({ from: r.from, to: r.to, buf: src.subarray(r.from, r.to), what: `保留 ${r.label}` })
            }
            frags.sort((a, b) => a.from - b.from || a.to - b.to)
            let prev = 0
            for (const f of frags) {
              if (f.from !== prev) failures.push(`第 ${g.generation} 代：各节按原始偏移拼起来时在 ${fmt(prev)}..${fmt(f.from)} 处不连续（空隙或重叠 ${fmt(Math.abs(f.from - prev))} B）⇒ 恒等式㈡无从成立`)
              prev = f.to
            }
            if (prev !== g.sourceBytes) failures.push(`第 ${g.generation} 代：各节拼完停在 ${fmt(prev)} B，但该代源是 ${fmt(g.sourceBytes)} B（差 ${fmt(Math.abs(prev - g.sourceBytes))} B）`)
            const tail = Buffer.concat(frags.map((x) => x.buf))
            const okB = sha(tail) === g.sourceSha256
            if (!okB) failures.push(`第 ${g.generation} 代恒等式㈡不成立：各节按原始偏移拼接 ${fmt(tail.length)} B 的 sha256 ${sha(tail)} ≠ 该代源 sha256 ${g.sourceSha256}`)
            say(`        · 恒等式㈡ 各节按原始偏移拼接 ${fmt(tail.length)} B 的 sha256 ${sha(tail)}`)
            say(`                   该代源 sha256 ${g.sourceSha256} ⇒ ${okB ? '[相等]' : '[不等]'}`)
          } else {
            // ---- 分片摘要路（字节不在手）----
            let sum = 0
            let checked = 0
            let bad = 0
            const pad = []
            if (preBytes) {
              const want = g.preambleSourceSha256
              if (!want) { bad += 1; pad.push(`抬头 §0：台账里没记该代源里抬头的 sha256 ⇒ [未核对]`) }
              else { checked += 1; sum += preBytes; pad.push(`抬头 §0 ${fmt(preBytes)} B：该代源里记的 sha256 ${want}（字节已不在盘上 ⇒ **只能与台账对拍，不参与整串拼接**）`) }
            }
            // ⚠️ 台账 `generations[].shards` 是一串**文件名**（`"archive/…"`），不是对象 —— 首版按
            // 对象取 `f.bodyBytes` 直接取到 undefined、被 `continue` 吞掉，于是和算少了 13 B
            //（归档正文那一份），报「30 ≠ 43」。片的正文明细去 `meta.shards` 里按文件名查。
            const byFile = new Map((Array.isArray(meta.shards) ? meta.shards : []).map((x) => [path.basename(String(x.file)), x]))
            for (const fs of (Array.isArray(g.shards) ? g.shards : [])) {
              const sh = byFile.get(path.basename(String(fs)))
              if (!sh || !sh.bodySha256 || !Number.isFinite(sh.bodyBytes)) { bad += 1; pad.push(`归档片 ${path.basename(String(fs))}：台账缺正文 sha256/字节 ⇒ [未核对]`); continue }
              checked += 1
              sum += sh.bodyBytes
              pad.push(`归档片 ${path.basename(String(fs))} 正文 ${fmt(sh.bodyBytes)} B：摘要 ${sh.bodySha256}（见 ①，盘上已逐片对拍）`)
            }
            for (const r of (retainedCoord || [])) {
              const mr = (Array.isArray(meta.retained) ? meta.retained : []).find((x) => x.idx === r.idx)
              const want = mr && mr.sha256
              if (!want || !Number.isInteger(r.from) || !Number.isInteger(r.to)) { bad += 1; pad.push(`保留节 ${r.label}：台账缺 sha256 或源坐标 ⇒ [未核对]`); continue }
              checked += 1
              sum += r.to - r.from
              pad.push(`保留节 ${r.label} 源坐标 ${fmt(r.from)}..${fmt(r.to)}（${fmt(r.to - r.from)} B）：摘要 ${want}`)
            }
            const okSum = sum === g.sourceBytes
            if (!okSum) failures.push(`第 ${g.generation} 代：各段字节数之和 ${fmt(sum)} ≠ 该代源字节数 ${fmt(g.sourceBytes)}（分片摘要路的算术等式不成立）`)
            for (const l of pad) say(`        · ${l}`)
            say(`        · 恒等式㈡（分片摘要路）各段字节数之和 ${fmt(sum)} / 该代源 ${fmt(g.sourceBytes)} ⇒ ${okSum ? '[相等]' : '[不等]'}`)
            say(`          ⚠ 该代源文件的字节**已不在盘上**（被后续轮换覆盖）⇒ 拼不出整串，本条**只核了每一段的摘要与尺寸**，`)
            say('            **不构成「整串 sha256 相等」**（不得读作恒等式㈡成立）。整串对拍只在 --apply 那一刻做得到。')
            if (bad) say(`          · 另有 ${bad} 段因台账缺字段而 [未核对]（**不得读作相等**）`)
          }
        }
        // ---- 本轮输出的生成块分量（事后复核用，与上面的恒等式无关）
        const nb = g.newGenBlockBytes === null || g.newGenBlockBytes === undefined ? null : Number(g.newGenBlockBytes)
        const nm = g.newGenMetaBytes === null || g.newGenMetaBytes === undefined ? null : Number(g.newGenMetaBytes)
        const ni = g.newGenIndexBytes === null || g.newGenIndexBytes === undefined ? null : Number(g.newGenIndexBytes)
        const nr = g.newGenReadmeBytes === null || g.newGenReadmeBytes === undefined ? null : Number(g.newGenReadmeBytes)
        if (nb === null || nm === null || ni === null || nr === null) {
          say(`        · 本轮生成块分量：台账缺字段 ⇒ [未核对]（**不得读作相等**）`)
        } else {
          const okC = nm + ni + nr === nb
          if (!okC) failures.push(`第 ${g.generation} 代生成块分段之和不成立：元数据 ${nm} + 索引 ${ni} + 读法 ${nr} ≠ ${nb}`)
          say(`        · 本轮生成块分段 元数据 ${fmt(nm)} + 索引 ${fmt(ni)} + 读法 ${fmt(nr)} = ${fmt(nm + ni + nr)} / 生成块 ${fmt(nb)} ⇒ ${okC ? '[相等]' : '[不等]'}`)
          // 盘上切片对拍：活动片开头 nb 字节必须逐字节等于「元数据段 + 索引段 + 读法段」
          const pane = Buffer.from(activeBytes)
          if (nb <= pane.length && g.newGenBlockOnDisk !== false) {
            const onDisk = pane.subarray(0, nb)
            const idxStart = nm
            const rmeStart = nm + ni
            const okIdx = sha(onDisk.subarray(idxStart, rmeStart)) === g.newGenIndexSha256
            const okRme = rmeStart + nr <= onDisk.length && sha(onDisk.subarray(rmeStart, rmeStart + nr)) === g.newGenReadmeSha256
            if (!okIdx) failures.push(`第 ${g.generation} 代：活动片里归档索引段（${nm}..${rmeStart}）的 sha256 与台账不等`)
            if (!okRme) failures.push(`第 ${g.generation} 代：活动片里读法段（${rmeStart}..${rmeStart + nr}）的 sha256 与台账不等`)
            say(`        · 盘上前面 ${fmt(nb)} B 的切片：索引段 sha256 ⇒ ${okIdx ? '[相等]' : '[不等]'} · 读法段 sha256 ⇒ ${okRme ? '[相等]' : '[不等]'}`)
            say(`        · ⚠ 生成块**自身**不记 sha256：元数据块里装着台账、台账若要记「生成块自己的摘要」就是自指（无确定解）。本行**不是**「已核对」。`)
          } else {
            say(`        · 盘上前面 ${fmt(nb)} B 的切片：活动片总长 ${fmt(pane.length)} B ⇒ [不可再验]（**不得读作相等**）`)
          }
        }
      } else {
        say(`        · 第 ${g.generation} 代的生成块字节已不在盘上（上一代活动片被本轮覆盖）⇒ [不可再验]（**不得读作相等**）`)
      }
    }
    say('')
  }

  say('')
  say(`活动片：${rel(activePath, process.cwd())} = ${fmt(activeBytes.length)} B · ${fmt(countLines(activeBytes))} 行 · sha256 ${sha(activeBytes)}`)

  // ---- 裁定 #33-②：分计数器 + 「不可再验」登记（**事后一遍**，不改上面那个循环的结构）----
  //
  // 事由：旧版的汇总行是无条件的「✓ 校验全部相等 ⇒ 无损成立（EXIT=0）」，
  // 而**同一份输出里**明明可能印着 `[不可再验]`（旧代整串拼不出来）—— 那是自相矛盾。
  //
  // ⚠️ 为什么写成「事后一遍」而不是动上面那个循环：那个循环里 `--verify`/`--apply` 两条路、
  //    字节在手/不在手两个分支各自缩进 10〜14 层；把恒等式㈠ 从 `currentGen` 分支里提出来
  //    （它本来就不该被关在那儿：㈠ 是**纯算术**，只用到台账里三个数，每一代都能算）时，
  //    我第一版直接搬代码块，连续踩了两次花括号配平（`Unexpected token 'else'`、
  //    `Illegal return statement`）。教训：**结构改动要用工具、改完立刻 `node --check`**，
  //    别用「看着对」的缩进推断。这里改成不动结构、只做事后统计，风险为零。
  const stat = { ident1Checked: 0, ident2FullChecked: 0, partitionOk: 0, unverifiable: [] }
  {
    const gens = Array.isArray(meta.generations) ? meta.generations : []
    const curGen = gens.length ? Number(gens[gens.length - 1].generation) : null
    for (const g of gens) {
      const aSrc = g.sourceGenBlockBytes === null || g.sourceGenBlockBytes === undefined ? null : Number(g.sourceGenBlockBytes)
      if (aSrc === null) {
        stat.unverifiable.push(`第 ${g.generation} 代：台账缺 A_src 字节数 ⇒ 恒等式㈠ 算不了`)
      } else {
        stat.ident1Checked += 1 // ㈠ 是纯算术，只用到台账里三个数 —— 每一代都能算
      }
      // ㈡ 的**整串对拍**只在「该代源字节就在手上」时做过：只有 `--apply` 会传 `sourceBuf`，
      // 且只有最后那一代（当代）的源才等于手上的源缓冲区；更早的代的源已被后续轮换覆盖。
      const full = !!(sourceBuf && g.generation === curGen)
      if (full) stat.ident2FullChecked += 1
      else stat.unverifiable.push(`第 ${g.generation} 代：该代源文件字节不在手上 ⇒ 恒等式㈡ 只走了分片摘要路（**不构成整串 sha256 相等**）`)

      // ---- 裁定 #33 ①：「节树是该代源文件的一个划分」的**正向证明** ----
      //
      // 这一条取代原来那个「A_src = 0」的论证。原来那套（`archivedBodyBytes + retainedBytes
      // == sourceBytes ⇒ A_src = 0`）对**回填**的代是**同义反复**：回填路径里 `retainedBytes`
      // 本身就是按 `sourceBytes − bodyBytes` 算的残差，等式恒真（A 的原话：用它当证据等于用
      // 同义反复当证据）。现在改成用「该代源文件里各节的区间」直接验四件事：
      //   ① 首节 startByte == 0     ② 相邻：前一节 endByte == 后一节 startByte
      //   ③ 区间两两不重叠          ④ 末节 endByte == 该代源字节数
      // 四件事成立 ⇒ 源文件里不存在落在节树之外的字节 ⇒ 生成块也在 §0 里 ⇒ **A_src = 0 是推论**。
      // 缺陷（裁定 #33 要求有）的负向对照：把台账里某节的 endByte 改小 1 ⇒ 这里报出「空隙」。
      const sec = Array.isArray(g.sections) ? g.sections : null
      if (!sec || !sec.length) {
        failures.push(`第 ${g.generation} 代：「节树划分」证明不了 —— 台账里没有 \`sections\` 区间表（这一代是旧版工具切的）。**不得**用它顶上「A_src = 0」那条结论。`)
      } else {
        let bad = null
        if (Number(sec[0].startByte) !== 0) bad = `首节 startByte = ${sec[0].startByte} ≠ 0（节树没有从文件第一个字节起）`
        for (let i = 1; !bad && i < sec.length; i += 1) {
          const p = Number(sec[i - 1].endByte)
          const c = Number(sec[i].startByte)
          if (p !== c) bad = `第 ${sec[i - 1].idx}/${sec[i].idx} 节之间：前一节止于 ${p}，后一节起于 ${c}（差 ${c - p} B ⇒ ${c > p ? '空隙' : '重叠'}）`
        }
        for (let i = 0; !bad && i < sec.length; i += 1) {
          if (Number(sec[i].endByte) < Number(sec[i].startByte)) bad = `第 ${sec[i].idx} 节区间倒置 [${sec[i].startByte}, ${sec[i].endByte})`
        }
        const total = sec.reduce((a, s) => a + (Number(s.endByte) - Number(s.startByte)), 0)
        if (!bad && Number(sec[sec.length - 1].endByte) !== Number(g.sourceBytes)) {
          bad = `末节止于 ${sec[sec.length - 1].endByte}，该代源 ${g.sourceBytes}（差 ${g.sourceBytes - Number(sec[sec.length - 1].endByte)} B）`
        }
        if (!bad && total !== Number(g.sourceBytes)) bad = `Σ 节长 ${total} ≠ 该代源 ${g.sourceBytes}`
        if (bad) {
          failures.push(`第 ${g.generation} 代：「节树是该代源文件的划分」不成立 —— ${bad}。⇒ 源里可能有落在节树之外的字节，A_src = 0 **不能**再由这里推出。`)
        } else {
          stat.partitionOk += 1
          say(`        · 节树划分（第 ${g.generation} 代）：首节起 0 · ${sec.length} 节连续不重叠 · 末节止于 ${fmt(g.sourceBytes)} · Σ 节长 ${fmt(total)} == 该代源 ${fmt(g.sourceBytes)} ⇒ **[是划分]**（⇒ A_src = 0 是推论）`)
          // ---- 交叉印证（A 的裁定 #33-①：「上一代台账那条等式」降为交叉印证）----
          //
          // ⚠️ 为什么要写成两条对照、而不是只印一条「[相等]」：
          //   ① `Σ 节长` 是**上面那四件事**的推论 —— 它与本文档无关，是独立量。
          //   ② `台账三元和`（归档正文 + 保留原文 + A_src）在**回填**的代里是**恒真**的：
          //      回填时 `retainedBytes = sourceBytes − bodyBytes`，所以 `bodyBytes + retainedBytes`
          //      必然等于 `sourceBytes`。它就是「同义反复」的那一条。
          // 两条都印出来，读者才能看出「哪条是测量、哪条是残差」。不一致时**两条都出**，不挑一条。
          const lhsLedger = Number(g.archivedBodyBytes) + Number(g.retainedBytes)
          const delta = total - lhsLedger
          if (delta !== 0) {
            say(`            · ⚠ 交叉印证不一致：节树划分给的 ${fmt(total)} B（独立量）≠ 台账三元和给的 ${fmt(lhsLedger)} B（回填的代里这条恒真）⇒ 差 ${fmt(delta)} B。**两条都不采信**，先查是哪一条错。`)
            failures.push(`第 ${g.generation} 代交叉印证不一致：节树划分 ${fmt(total)} B vs 台账三元和 ${fmt(lhsLedger)} B（差 ${fmt(delta)}）`)
          } else {
            say(`            · 交叉印证：节树划分 ${fmt(total)} B（独立量，由上面四件事推出）== 台账三元和 ${fmt(lhsLedger)} B（归档正文 ${fmt(g.archivedBodyBytes)} + 保留原文 ${fmt(g.retainedBytes)}；**回填的代里这条恒真**，只作旁证）`)
          }
        }
      }
    }
  }
  return { ok: failures.length === 0, lines, failures, stat }
}

// ------------------------------------------------------------------ 主流程
function main() {
  const o = parseArgs(process.argv.slice(2))
  const filePath = path.isAbsolute(o.file) ? o.file : path.resolve(o.root, o.file)
  const archiveDir = o.archiveDir
    ? (path.isAbsolute(o.archiveDir) ? o.archiveDir : path.resolve(o.root, o.archiveDir))
    : path.join(path.dirname(filePath), 'archive')

  if (!existsSync(filePath)) {
    fail(EXIT.INCOMPLETE, `未能验证：分片不存在 —— ${filePath}（EXIT=2 是「我没能验证」，不是「它坏了」）`)
  }
  const buf = readFileSync(filePath)
  const text = buf.toString('utf8')
  const role = path.basename(filePath).replace(/\.md$/, '')

  // ---- --verify：离线校验（读活动片里的元数据块 + 归档片实物）
  if (o.mode === 'verify') {
    const parsed = parseMeta(text)
    if (!parsed) {
      fail(EXIT.INCOMPLETE, `未能验证：${filePath} 里没有 ${META_BEGIN} 元数据块（该片可能从未轮换过，或元数据块被删）`)
    }
    if (parsed.parseError) {
      fail(EXIT.INCOMPLETE, `未能验证：元数据块不是合法 JSON —— ${parsed.parseError}`)
    }
    // ⚠️ 这里**不传** `sourceBuf`：`--verify` 手上只有**当代活动片**，对旧代它不是该代源文件。
    // 传进去会让旧代误走「字节在手」那条路、拿后代字节去比旧代摘要（实测报 69C1A907 vs 真值 A9D97C52）。
    // 旧代改走台账里的**分片摘要路**（见 ④ 的注释：它不证明整串 sha 相等，报告里会明写）。
    const v = verifyAll({ meta: parsed.meta, activeBuf: buf, activePath: filePath, archiveDir })
    console.log(`board 分片轮换校验（board-rotate.mjs --verify）`)
    console.log(`活动片：${filePath}`)
    console.log(`归档目录：${archiveDir}`)
    console.log('')
    for (const l of v.lines) console.log(l)
    console.log('')
    if (v.ok) {
      // 裁定 #33-②：汇总行必须与同一份输出里的 `[不可再验]` 一致 ——
      // 只要存在不可再验的项，就**不得**说「全部相等」。
      const nGen = Array.isArray(parsed.meta.generations) ? parsed.meta.generations.length : 0
      const st = v.stat || { ident1Checked: 0, ident2FullChecked: 0, unverifiable: [] }
      if (st.unverifiable.length) {
        console.log(`✓ 可核部分全部相等；${st.unverifiable.length} 项不可再验 ⇒ 无损**部分**成立（EXIT=0）`)
        console.log(`    已核：恒等式㈠（纯算术，每代都能算）${st.ident1Checked} / ${nGen} 代 · 恒等式㈡ 整串对拍 ${st.ident2FullChecked} / ${nGen} 代（M ≤ N；整串只能在该代源字节就在手上时算）`)
        for (const u of st.unverifiable) console.log(`    [不可再验] ${u}`)
        console.log(`    ⚠ 本行**不构成**「全片无损已证」：上面那些项没有被验，也没有被证伪。`)
      } else {
        console.log(`✓ 校验全部相等 ⇒ 无损成立（EXIT=0）（恒等式㈠ ${st.ident1Checked} / ${nGen} 代 · 恒等式㈡ 整串 ${st.ident2FullChecked} / ${nGen} 代${nGen === 1 ? '；本片只轮换过 1 次 ⇒ 没有可交叉印证的前代' : ''}）`)
      }
      process.exit(EXIT.PASS)
    }
    console.log(`✗ 校验未通过（EXIT=1）：共 ${v.failures.length} 项`)
    for (const f of v.failures) console.log(`   - ${f}`)
    process.exit(EXIT.FAIL)
  }

  // ---- 裁定 #29.5：再切（同一片第二次轮换）的**续号**与**跨代坐标**。
  // parseMeta 返回的是 `{ meta, index, end }`（**不是** meta 本身）—— 下面一律用 .meta 取字段。
  const parsedExisting = parseMeta(text)
  const existingMeta = parsedExisting && parsedExisting.meta ? parsedExisting.meta : null
  //
  // 为什么需要它：第二次轮换的源是「已被重写过的活动片」，与「原始文件」**坐标原点不同** ——
  // 第一代的偏移说的是「原始 a.md 的第几个字节」，第二代的偏移说的是「第一代活动片的第几个字节」。
  // 两者混在一个坐标空间里就是错账。本工具的处理：
  //   ① NNN 从归档目录既有最大值**续号**（绝不覆盖、绝不重号）；
  //   ② 每个归档片的片头带 `- 本片属于第 N 代（该代源 sha256 … / … B）`，使任何一片都能自证属于哪一代；
  //   ③ 活动片元数据记 `generations[]`（每代：该代源 sha256 / 字节 / 行数 / 该代归档片清单 / 该代保留区间字节数），
  //      于是不变式「**第 N 代：该代保留区间字节数 + 该代全部归档片正文字节数 == 该代源文件字节数**」
  //      对**每一代**都能独立复算（`--verify` 用 `rotations[]` 逐代核对）。
  const priorShards = []
  if (existsSync(archiveDir)) {
    for (const name of readdirSync(archiveDir).sort()) {
      if (!name.startsWith(`${role}-`) || !name.endsWith('.md')) continue
      const m = new RegExp(`^${role}-(\\d{3})-`).exec(name)
      if (m) priorShards.push({ name, num: Number(m[1]) })
    }
  }
  const priorMaxNum = priorShards.reduce((a, s) => Math.max(a, s.num), 0)
  // 裁定 #29.5：代数**必须递增**；重复取上一版那个数会把两代账记成同一代。
  // 触发条件是「已经轮换过」（有元数据块），不设 `--force` 也一样 —— 代数只描述「这是第几次轮换」。
  const generation = (existingMeta && Number.isInteger(existingMeta.generation) ? existingMeta.generation + 1 : 1)
  const priorGenerations = (existingMeta && Array.isArray(existingMeta.generations)) ? existingMeta.generations : []
  // 续号计划：本轮各片用 priorMaxNum+1、priorMaxNum+2…（在 buildShards 里消费）
  let seqBase = priorMaxNum


  const { sections, preambleBytes } = splitSections(buf, o.boundaries)
  if (sections.length === 0) {
    fail(EXIT.INCOMPLETE, `未能验证：文件为空（${filePath}，0 B），无从切分`)
  }
  const boundaryHits = sections.filter((s) => s.idx > 0).length
  if (boundaryHits === 0) {
    fail(EXIT.INCOMPLETE,
      `未能验证：--boundary ${JSON.stringify(o.boundariesRaw)} 在该文件里零命中（没有可切的节边界）。\n` +
      `   零命中 ⇒ 无从切分，本工具**不产出空归档、不静默降级**（EXIT=2）。`)
  }
  for (const s of sections) {
    s.title = s.title || buf.subarray(s.startByte, Math.min(s.endByte, s.startByte + 200)).toString('utf8').split('\n')[0]
    s.bytes = s.endByte - s.startByte
    s.lines = countLines(buf.subarray(s.startByte, s.endByte))
    s.sha256 = sha(buf.subarray(s.startByte, s.endByte))
    s.ordinal = ordinalOf(s)
    // 归一：`s.label` 一律**不带 § 前缀**（下游片名 `sh.file` / 片头 `renderShardHeader` /
    // 归档索引行 / 保留区间行 `renderActive` 各自拼 §）。不归一就会印出 `§§122` —— 实测过（裁定 #43）。
    // ⚠ 这里刻意**不写行号**（本文件自己的插入会让行号立刻腐）。
    s.label = labelFor(s).replace(/^§/, '')
  }
  const preambleText = preambleBytes > 0 ? buf.subarray(0, preambleBytes).toString('utf8') : ''

  // ---- 分类：保留 / 归档。规则必须可复现，故两种情形都写清「因何保留」
  const maxIdx = sections.length - 1
  let kept
  let ruleText
  if (o.keepSections !== null) {
    const set = parseKeepSections(o.keepSections, maxIdx)
    kept = sections.filter((s) => set.has(s.idx))
    const missing = sections.filter((s) => !set.has(s.idx)).length
    ruleText = `显式 --keep-sections ${o.keepSections} ⇒ 保留 ${kept.length} 节（${kept.map((s) => s.label).join(' ')}），归档 ${missing} 节`
  } else {
    // 默认规则：自末尾向前逐节纳入。
    //
    // ⚠️ 预算算的不是「保留节的字节之和」，而是**活动片的最终字节数**：活动片 = 元数据块 + 抬头
    // + 归档索引 + 读法 + 最近窗口。元数据块与归档索引会随片数增长（真 a.md 上固定部分就占
    // ~27 KB），若只按 `--max-bytes` 卡窗口，算出来的活动片会**超过 96 KiB**（实测 122,310 B）。
    // 所以这里先给一个保守起点（扣除实测固定开销），后面在渲染出真实 activeBufNew 之后再收敛。
    const budget = o.keepBytes !== null ? o.keepBytes : o.maxBytes
    kept = []
    let acc = 0
    for (let i = sections.length - 1; i >= 0; i -= 1) {
      const s = sections[i]
      if (i === maxIdx && s.idx === 0) { kept.unshift(s); break }
      if (acc + s.bytes > budget && kept.length > 0) break
      acc += s.bytes
      kept.unshift(s)
    }
    ruleText = o.keepBytes !== null
      ? `--keep-bytes ${o.keepBytes} ⇒ 自末尾向前逐节纳入，保留 ${kept.length} 节（${kept.map((s) => s.label).join(' ')}），实占 ${fmt(acc)} B`
      : `未给保留规则 ⇒ 默认「自末尾向前逐节纳入，且**活动片最终字节 ≤ ${fmt(o.maxBytes)} B**（--keep-bytes 可单独指定窗口上限）」⇒ 保留 ${kept.length} 节（${kept.map((s) => s.label).join(' ')}），窗口实占 ${fmt(acc)} B`
  }
  // preamble 永远留在活动片（它是文件抬头），并从归档区排除
  const keepSet = new Set(kept.map((s) => s.idx))
  keepSet.add(0)
  kept = sections.filter((s) => keepSet.has(s.idx))
  let archivedSections = sections.filter((s) => !keepSet.has(s.idx))
  if (archivedSections.length === 0) {
    // 不静默降级：默认规则命中了「整份文件都在一个节里」或「预算装得下全文」。
    // 从**最靠前**的非保留节里再归档一节（保留区仍在尾部，仍然可复现），让 --plan 能继续；
    // 若连一节都让不出来（整份文件只有 preamble 一节），才报错退出。
    const spare = sections.filter((s) => s.idx > 0)
    if (spare.length <= 1) {
      fail(EXIT.USAGE, `保留规则把整份文件都留下了，且没有任何一节可让出（本文件解析出 ${sections.length} 节，其中节首仅 ${spare.length} 个）⇒ 无从归档。`)
    }
    const give = spare[0].idx
    console.log(`⚠ 默认保留规则命中了全文（${sections.length} 节）⇒ 自动改为「保留尾部、至少归档最前面一节」，本次归档 ${give} 起。`)
    keepSet.delete(give)
    kept = sections.filter((s) => keepSet.has(s.idx))
    archivedSections = sections.filter((s) => !keepSet.has(s.idx))
  }

  const secOf = (idx) => sections.find((s) => s.idx === idx)

  /**
   * 由「要归档的节列表」装出归档片。抽成函数是因为活动片预算收敛时可能要反复重装
   * （每让出一节给归档，片边界就得重算一次）。
   *
   * 规则：单节超限 ⇒ 先按 --sub-boundary 切（零命中则该节独占一片，章程 §4.13.2b-2）；
   * 再按原始顺序累积到 ≤ max-bytes，**同一节的子节绝不跨片**。
   */
  function buildShards(archiveList) {
    const pieces = []
    for (const s of archiveList) {
      if (s.bytes > o.maxBytes) {
        const subs = splitSub(buf, s, o.subBoundaries)
        if (!subs) {
          if (o.subBoundaries.length) {
            console.log(`⚠ 单节超限 ${s.idx}（${fmt(s.bytes)} B > ${fmt(o.maxBytes)} B），但 --sub-boundary 在该节内零命中 ⇒ 该节独占一片（章程 §4.13.2b-2）。`)
          } else {
            console.log(`⚠ 单节超限 ${s.idx}（${fmt(s.bytes)} B > ${fmt(o.maxBytes)} B），未给 --sub-boundary ⇒ 该节独占一片（章程 §4.13.2b-2）。`)
          }
          pieces.push({ secIdx: s.idx, startByte: s.startByte, endByte: s.endByte })
        } else {
          subs.forEach((p) => pieces.push({ secIdx: s.idx, startByte: p.startByte, endByte: p.endByte }))
        }
      } else {
        pieces.push({ secIdx: s.idx, startByte: s.startByte, endByte: s.endByte })
      }
    }
    const out = []
    let cur = null
    for (const p of pieces) {
      const wantsNew = !cur || cur.bytes + (p.endByte - p.startByte) > o.maxBytes
      if (wantsNew) {
        if (cur) out.push(cur)
        cur = { startByte: p.startByte, endByte: p.endByte, bytes: 0, secIdxs: [] }
      }
      cur.endByte = p.endByte
      cur.bytes = cur.endByte - cur.startByte
      if (!cur.secIdxs.includes(p.secIdx)) cur.secIdxs.push(p.secIdx)
    }
    if (cur) out.push(cur)
    // ---- 裁定 #29.1/#29.2：**同一顶层节被切成多片时**必须让片名唯一。
    // 为什么不是审美问题：章程 §4.13.2b 规定的常规读法是「按索引 grep 指定归档片」，
    // 而索引的用途正是「片名 → 覆盖哪一段」。旧版把片名定成 `§a-§b`（只由节区间派生），
    // 于是同一个 `## 4. big` 被 --sub-boundary 切成 3 片时，三片的节区间字段都是 `§4-§4`
    // ⇒ 按片名 grep 不再能唯一定位一片，章程规定的读法被打断。
    // 判据（A 裁定）：仅当同一节多切时附加 `-part<k>of<m>`，不拆的节保持旧名（不打乱既有引用）。
    // 「哪些节真的被切成了多片」：以**分片清单**为准（而不是靠「单节超限」这个条件反推——
    // 一条超限的节完全可以独占一片，那是章程 §4.13.2b-2 明文允许的，不该打 part 标记）。
    const whereOf = new Map()
    out.forEach((sh, i) => {
      for (const x of new Set(sh.secIdxs)) {
        if (!whereOf.has(x)) whereOf.set(x, [])
        whereOf.get(x).push(i)
      }
    })
    // 「单节独占片」= 全片只含一节，且该节就是这一节。
    const aloneShards = new Map()          // secIdx -> 只含该节的片下标清单
    out.forEach((sh, i) => {
      const own = [...new Set(sh.secIdxs)]
      if (own.length !== 1) return
      if (!aloneShards.has(own[0])) aloneShards.set(own[0], [])
      aloneShards.get(own[0]).push(i)
    })
    const partOf = new Map()               // secIdx -> 该节独占的片下标清单（≥2 片才算被拆）
    for (const [x, list] of aloneShards) if (list.length >= 2) partOf.set(x, list)
    // 每片按「它独占的节」判归属；一片里若有**两个**这样的节，那是互相矛盾的归属 ⇒ 报错，不猜。
    const labelOf = new Map()
    out.forEach((sh, i) => {
      const own = [...new Set(sh.secIdxs)]
      const splitHits = own.filter((x) => partOf.has(x))
      const loneHits = own.filter((x) => aloneShards.has(x))
      if (loneHits.length !== 1) return
      labelOf.set(i, loneHits[0])
      sh.splitSection = partOf.has(loneHits[0])
      sh.splitSecIdx = sh.splitSection ? loneHits[0] : null
    })
    out.forEach((sh, i) => {
      sh.seq = seqBase + i + 1                      // #29.5：跨代续号（第一代 seqBase=0 ⇒ 1,2,3…）
      sh.seq3 = String(sh.seq).padStart(3, '0')
      // 裁定 #43：片名/区间取 `sec.label`（**题号**；无题号者回落本代序号），不再取 `sec.idx`（纯序号）。
      // 旧写法在「归档段从文件开头开始」的第 1 代看不见缺陷，第 2 代归档中段（序号 3 起 = `## §122` 起）
      // 立刻打架：片名写 `§1–§20`，片内正文却是 `§122–§141` ⇒ 按节号检索的人找不到片。
      sh.fromLabel = sh.secIdxs.length ? secOf(sh.secIdxs[0]).label : ''
      sh.toLabel = sh.secIdxs.length ? secOf(sh.secIdxs[sh.secIdxs.length - 1]).label : ''
      sh.partK = null
      sh.partM = null
      if (sh.splitSection) {
        const list = partOf.get(sh.splitSecIdx)
        sh.partK = list.indexOf(i) + 1          // k 从 1 起、按原始字节升序
        sh.partM = list.length
      }
      // 片名在这里定（不能留给调用方：meta.shards 是**投影副本**，调用方再往原数组上补字段，
      // 副本里还是 undefined —— 真 a.md 的归档索引就这样印出过 8 个字面量 `undefined`）。
      sh.partTag = sh.partK ? `-part${sh.partK}of${sh.partM}` : ''
      sh.file = `archive/${role}-${sh.seq3}-§${sh.fromLabel}-§${sh.toLabel}${sh.partTag}.md`
      sh.startLine = sections[sectionIndexAt(sections, sh.startByte)].startLine
      // 末行 = 包含字节 sh.endByte-1 的那一节的行区间末行 —— 这一节必定是「同节同片」的（子节不跨片）
      sh.endLine = sections[sectionIndexAt(sections, sh.endByte - 1)].endLine
      sh.body = buf.subarray(sh.startByte, sh.endByte)
      sh.bodyBytes = sh.body.length
      sh.bodyLines = countLines(sh.body)
      sh.bodySha256 = sha(sh.body)
    })
    return out
  }

  const shards = buildShards(archivedSections)

  // 片头依赖 shard 的正文摘要，故先算一次占位片头尺寸、再逐步收敛（片头只依赖被摘要的数值，不依赖自身长度）
  //
  // ⚠️ **这里不得出现任何随「何时跑」而变的字段**（旧版有 `rotatedAt: new Date().toISOString()`）。
  // 理由：这个 JSON 是 --verify 的唯一输入、也是归档片的自摘要输入，一旦含挂钟时间：
  //   ① 同一输入跑两次 --plan 会得出**不同的活动片 sha256**（确定性硬要求直接失败）；
  //   ② `--plan` 预告的摘要与后来 `--apply` 实写的摘要必然不等（跨分钟就炸）；
  //   ③ `--apply` 内部「预测 vs 写出」的逐字节对拍变成同义反复/永假。
  // 溯源的时间戳改放**人读的那一路**（stdout 的 `生成时刻` 行），机器判据里一个字节都不留。
  //
  // ⚠️ **位置无关（裁定 #31-⑤）**：这个 JSON 里的每一个字符串都不得依赖「跑的时候 cwd 在哪 / 源文件在哪个目录」。
  // 旧版写 `source: rel(filePath, o.root)` 与 `archiveDir: rel(archiveDir, o.root)` ⇒ 同一份源、同版本、同选项，
  // 放在名字长度不同的目录里会产出**不同的字节**（A 实测：/tmp/x1 与 /tmp/xx-longer-dir-name 差 16 B）。
  // 现在一律只记文件名（`a.md` / `archive`）；绝对路径与相对路径只出现在 stdout 报告里，不进产物。
  const meta = {
    tool: 'scripts/board-rotate.mjs',
    version: 1,
    generation,                    // 裁定 #29.5：第几代（首次轮换 = 1）
    generations: priorGenerations, // 裁定 #29.5：跨代坐标（每代：源 sha256 / 字节 / 行数 / 该代归档片清单 / 该代保留区间字节数）
    source: path.basename(filePath), // 裁定 #31-⑤：只记**文件名**（见下方「位置无关」注释块）
    sourceRel: rel(filePath, o.root), // 人读用，**不写进任何产物**（只出现在 stdout 报告里）
    role,
    sourceSha256: sha(buf),
    sourceBytes: buf.length,
    sourceLines: countLines(buf),
    boundary: o.boundariesRaw,
    subBoundary: o.subBoundariesRaw,
    maxBytes: o.maxBytes,
    keepRule: ruleText,
    shards: [],
    retained: [],
  }

  let preambleTextForRender = preambleText
  // （片名 sh.file 已在 buildShards 内部定好——meta.shards 是投影副本，在调用方补字段补不到副本上。）

  // 片头里的长度类字段是**自身派生**的：`headerBytes` 与 `fileBytes` 要被印在片头文本里，
  // 而数字位数又影响文本长度 ⇒ 长度这一路要迭代到不动点（一般 2–3 轮收敛）。
  //
  // ⚠️⚠️ 但**摘要这一路绝不能自指**。曾经把「本片整文件 sha256」也印进片头，于是片头文本依赖摘要、
  // 摘要又依赖片头文本 ⇒ 那是给 sha256 解不动点，**无确定解**（实测永远在 12 轮内振荡不收敛，
  // 而且就算收敛也是收敛到一个假值，与被写出的字节无关）。这类自指只有两条出路：
  //   ① 不把摘要写进片头（本工具的选择）；② 写一个**先定死内容的占位符**。
  // 所以：长度迭代到不动点；**整片摘要由 --apply 写出后实测、填回活动片的索引**（--verify 再核对）。
  // 真正的保证不是「片头里印的摘要」，而是**活动片索引 records 的 sha256 与盘上字节的对拍**。
  const frameShards = (list) => {
    for (const sh of list) {
      sh.headerBytes = 0
      sh.fileBytes = sh.bodyBytes
      sh.fileLines = countLines(sh.body)   // 先给个有定义的值：片头会渲染它，undefined 会在 fmt() 里炸
      let text = ''
      let converged = false
      const draft = { ...meta, shards: list }
      for (let it = 0; it < 12; it += 1) {
        const rendered = renderShardHeader(draft, sh)
        const headerBytes = bytesOf(rendered)
        const fileLines = countLines(Buffer.concat([Buffer.from(rendered, 'utf8'), sh.body]))
        if (headerBytes === sh.headerBytes && fileLines === sh.fileLines) {
          text = rendered
          converged = true
          break
        }
        sh.headerBytes = headerBytes
        sh.fileBytes = headerBytes + sh.bodyBytes
        sh.fileLines = fileLines
      }
      if (!converged) {
        fail(EXIT.INCOMPLETE, `未能验证：归档片 ${sh.seq3} 的片头长度不动点在 12 轮内未收敛（现片头 ${fmt(sh.headerBytes)} B）。不写盘。`)
      }
      sh.fileLines = countLines(Buffer.concat([Buffer.from(text, 'utf8'), sh.body]))
      // 自证①：片头文本的长度必须等于它自己印出去的那个数（否则 --verify 按 headerBytes 剥离会错位）
      if (bytesOf(text) !== sh.headerBytes) {
        fail(EXIT.INCOMPLETE, `未能验证：归档片 ${sh.seq3} 的片头自述长度 ${fmt(sh.headerBytes)} B ≠ 实际长度 ${fmt(bytesOf(text))} B。不写盘。`)
      }
      // 自证②：长度不动点必然把整片长度也钉死（片头 + 正文）
      if (sh.fileBytes !== sh.headerBytes + sh.bodyBytes) {
        fail(EXIT.INCOMPLETE, `未能验证：归档片 ${sh.seq3} 的整片长度不自洽（片头 ${fmt(sh.headerBytes)} + 正文 ${fmt(sh.bodyBytes)} ≠ 整片 ${fmt(sh.fileBytes)}）`)
      }
      sh.headerText = text
      // 整片摘要：--plan 阶段只能是**等长占位符**（64 个 `0`），--apply 写出归档片后实测覆盖。
      // 用等长占位符而不是空串/undefined：索引行长度与字节数在两种模式下完全相同，
      // 于是「--plan 预告的尺寸」与「--apply 实写的尺寸」才是同一个数（否则差 64 字节无法对拍）。
      sh.fileSha256 = '0'.repeat(64)
    }
  }
  frameShards(shards)

  // retained 元数据（含活动片内的将来偏移，渲染后才填）
  meta.retained = kept.map((s) => ({
    label: s.label, idx: s.idx, title: s.title.split('\n')[0].slice(0, 120),
    startByte: s.startByte, endByte: s.endByte, bytes: s.bytes, lines: s.lines, sha256: s.sha256,
  }))
  // ⚠️ 这里必须补上 renderShardHeader **真的要读** 的字段：`seq3` 是片头标题「归档片 NNN」的来源
  // （少了它渲染出字面量 "undefined"，多 6 字节）；`fromLabel`/`toLabel` 是片头与归档索引里
  // 「原节区间 §x–§y」的来源。旧版正是在此处丢了字段，于是「收敛时量的片头长度」与「后来渲染出的
  // 片头长度」不等，--apply 的写后自检才把它拦下来（晚了，但拦住了）。
  // 判据不是「字段看着齐」，而是：**用这份 meta.shards 渲染出的片头，逐字节等于收敛时那一份**（见下方断言）。
  // `headerText` 也一并带过去：--apply 写归档片时**只能用这一份文本**。
  // `fileSha256`（整片摘要）带的是**占位符**，--apply 会就地覆盖成实测值后再渲染活动片。
  meta.shards = shards.map((sh) => ({
    seq: sh.seq, seq3: sh.seq3, file: sh.file, fromLabel: sh.fromLabel, toLabel: sh.toLabel,
    // #29.1/#29.2：part 标记必须一起投影 —— 它就是**字段投影漏字段**这一类 bug 的最新一例
    //（本文件的历史上，`seq3`、`file`、`body` 都各漏过一次；漏了就是索引印 undefined 或印错段标记）。
    partK: sh.partK ?? null, partM: sh.partM ?? null, partTag: sh.partTag ?? '',
    startByte: sh.startByte, endByte: sh.endByte,
    startLine: sh.startLine, endLine: sh.endLine,
    bodyBytes: sh.bodyBytes, bodyLines: sh.bodyLines, bodySha256: sh.bodySha256,
    headerBytes: sh.headerBytes, fileBytes: sh.fileBytes, fileLines: sh.fileLines,
    headerText: sh.headerText, fileSha256: sh.fileSha256,
  }))

  const plan = { meta, shards: meta.shards, retained: meta.retained, preambleText: preambleTextForRender }
  // 自证：投影后的 meta.shards 渲染出的片头，必须与收敛时量的那一份**逐字节相同**。
  // 少了这条，字段投影漏一个（例如 fromLabel/toLabel）只会在 --apply 写盘的那一刻才炸出来。
  for (const sh of meta.shards) {
    if (renderShardHeader(meta, sh) !== sh.headerText) {
      const got = renderShardHeader(meta, sh)
      fail(EXIT.INCOMPLETE,
        `未能验证：归档片 ${sh.seq3 ?? sh.seq} 的片头在字段投影后与收敛时那份不同（收敛时 ${fmt(sh.headerBytes)} B，投影后 ${fmt(bytesOf(got))} B）。\n` +
        `   ⇒ 本工具的字段投影漏了片头渲染要读的字段（渲染出的片头出现了 "undefined"？）。不写盘。\n` +
        `   投影后用到的字段值：fromLabel=${JSON.stringify(sh.fromLabel)} toLabel=${JSON.stringify(sh.toLabel)} seq3=${JSON.stringify(sh.seq3)}`)
    }
  }

  /**
   * 定位保留区间在活动片里的偏移，并逐段与源字节**对拍**。
   *
   * ⚠️ 活动片的布局不变量：元数据块之后是 preamble 原文，再后面才是保留区间的原文。
   * 所以「活动片里的偏移」= preamble 之后的累加偏移，**§0（preamble 自身）不参与这段校验**
   * （它的字节由 --verify 第 ③ 条的整体拼接等价性覆盖）—— 首版就是漏了这个例外，把「活动片里
   * §0 的区间」错当成位于缓冲区 0 处，于是永远报「渲染 bug」。
   */
  // ⚠️ 顺序不变量：paneSections / windowBytes / preambleMeta 全部**从 meta.retained 派生**，
  //   所以只能在 meta.retained 定稿之后算一次。任何改动 meta.retained 的路径都必须重新派生
  //   （refreshRows()），否则会让「活动片里的节」与「元数据里登记的节」两份名单分叉，
  //   表现为 recomputeGeometry 里 `r` 为 undefined（真 a.md 上撞过）。
  let paneSections = []
  let windowBytes = 0
  let windowBytesKept = 0
  let preambleMeta = null
  let activeBufNew = Buffer.alloc(0)
  let changed = new Set()
  /**
   * ⚠️ 两个「窗口字节数」不是一回事，别合并（裁定 #31-⑥ 踩过）：
   *   `windowBytes`      = `paneSections`（**不含 §0**）之和 —— 用于「最近窗口预算」这条人读指标；
   *   `windowBytesKept`  = `kept`（**含 §0**）之和 —— 「最近窗口」实际渲染进活动片的字节数。
   * 渲染用的是 `kept` ⇒ **一切从渲染结果反推偏移的计算（`paneBase`）必须用 `windowBytesKept`**。
   * 用 `windowBytes` 会少算 §0 那 5 B（tiny 上表现为 §0 区间从 4,305 变 4,310、哈希对不上）。
   */
  const paneBase = () => activeBufNew.length - windowBytesKept
  /**
   * `§0` 抬头在活动片里的偏移。裁定 #31-⑥ 之前这里写的是 `bytesOf(piecesOf(...)[0].text)`（= 元数据块长度），
   * 那只在「抬头被单独渲染在元数据块之后」时成立。现在 §0 在保留集合里时**不再单独渲染**，
   * 它是「最近窗口」的第一节 ⇒ 偏移就是窗口起点 `paneBase()`。两条分支都从**渲染结果**推偏移，
   * 不用「按布局常量手算」——手算的第二份布局正是首版 2 B 对不上、以及这次 §0 假红的来源。
   */
  const preambleOff = () => {
    if (!kept.some((s) => s.idx === 0)) return bytesOf(piecesOf(plan, kept, buf)[0].text)
    return paneBase()
  }

  function refreshRows() {
    // ⚠️ 这里**必须接着旧几何**（activeStartByte/activeEndByte），不能从 kept 重造一份干净的：
    // 预算是迭代收敛的（`--keep-bytes` 的默认规则会一轮轮丢节），每丢一节就 refreshRows 一次，
    // 而 `recomputeGeometry()` 在**别的**调用点（`finalizeActiveRender` 之后）才把几何填回来。
    // 旧版这里新造的对象不带几何 ⇒ 预算循环的最后一次 refreshRows 会**静默抹掉**刚算好的几何，
    // 而 `stampCurrentGeneration()`（晚于预算循环）读到的就是「缺几何」的那份
    // ⇒ 台账里 `retainedSourceCoords[].paneFrom`、`preambleActiveStartByte` 全成 null，
    // `--verify` 第 ④ 条报「缺抬头/保留节坐标 ⇒ 无法切出」。症状离原因有三层，极难定位。
    const prevRows = new Map((Array.isArray(meta.retained) ? meta.retained : []).map((r) => [r.idx, r]))
    meta.retained = kept.map((s) => {
      const p = prevRows.get(s.idx)
      return {
        label: s.label, idx: s.idx, title: s.title.split('\n')[0].slice(0, 120),
        startByte: s.startByte, endByte: s.endByte, bytes: s.bytes, lines: s.lines, sha256: s.sha256,
        ...(p && Number.isInteger(p.activeStartByte) && Number.isInteger(p.activeEndByte)
          ? { activeStartByte: p.activeStartByte, activeEndByte: p.activeEndByte }
          : {}),
      }
    })
    plan.retained = meta.retained
    // ⚠️ 「最近窗口」= `kept` **按原序**渲染（含 §0）。以前这里分两组：
    //   `paneSections = kept.filter(idx !== 0)`（算预算）+ `preambleMeta`（单独登记 §0 几何）。
    //   裁定 #31-⑥ 让 §0 不再单独渲染之后，§0 必须**留在原位**进窗口遍历，
    //   否则「窗口起点 + 各节字节」的累加会跳过 §0、使后续每节偏移整体错位 5 B（tiny 上实测：
    //   §§2 报 4,300..4,313 / 13 B，实际应是 4,305.., 10 B）。
    paneSections = kept.slice()
    windowBytes = kept.filter((s) => s.idx !== 0).reduce((a, s) => a + s.bytes, 0)
    windowBytesKept = kept.reduce((a, s) => a + s.bytes, 0)
    preambleMeta = kept.some((s) => s.idx === 0) ? meta.retained.find((x) => x.idx === 0) : null
  }

  /**
   * 渲染活动片 + 就地把各保留区间（含抬头 §0）的字节几何写回 meta，
   * 并逐段用 sha256 对拍**真实渲染出来的字节**（不是按长度相加推出来的）。
   *
   * 抽成函数：活动片预算收敛时每让出一节就要重跑一遍（分片边界与索引字节数都变了）。
   * 返回本次渲染出来的字节；调用方负责最后的收敛判定。
   */
  function recomputeGeometry() {
    for (let it = 0; it < 12; it += 1) {
      activeBufNew = Buffer.from(renderActive(plan, kept, buf), 'utf8')
      changed = new Set()
      if (preambleMeta) {
        const a = preambleOff()
        if (preambleMeta.activeStartByte !== a) { preambleMeta.activeStartByte = a; changed.add('§0') }
        if (preambleMeta.activeEndByte !== a + preambleMeta.bytes) { preambleMeta.activeEndByte = a + preambleMeta.bytes; changed.add('§0') }
        const slice = activeBufNew.subarray(a, a + preambleMeta.bytes)
        const got0 = sha(slice)
        if (got0 !== preambleMeta.sha256) {
          fail(EXIT.INCOMPLETE,
            `未能验证：渲染后的活动片里抬头 §0 区间（${fmt(a)}..${fmt(a + preambleMeta.bytes)}）的 sha256 与源字节不等。\n` +
            `   源字节 ${preambleMeta.sha256} / 活动片该区间 ${got0}\n` +
            `   ⇒ 这是本工具自己的渲染 bug（不是被切分文件的问题），不写盘、不产出半成品。`)
        }
      }
      let off = paneBase()
      for (const s of paneSections) {
        const r = meta.retained.find((x) => x.idx === s.idx)
        if (r.activeStartByte !== off) { r.activeStartByte = off; changed.add(s.label) }
        if (r.activeEndByte !== off + s.bytes) { r.activeEndByte = off + s.bytes; changed.add(s.label) }
        const slice = activeBufNew.subarray(off, off + s.bytes)
        const got = sha(slice)
        if (got !== s.sha256) {
          fail(EXIT.INCOMPLETE,
            `未能验证：渲染后的活动片里 §${s.label} 区间（${fmt(off)}..${fmt(off + s.bytes)}）的 sha256 与源字节不等。\n` +
            `   源字节 ${s.sha256} / 活动片该区间 ${got}\n` +
            `   ⇒ 这是本工具自己的渲染 bug（不是被切分文件的问题），不写盘、不产出半成品。`)
        }
        off += s.bytes
      }
      if (changed.size === 0) break
    }
  }
  // 先把 retained 名单定稿，再做「用投影后的 meta 渲染片头」的自证。refreshRows() 自身只做
  // 名单/几何导出的派生（paneSections / windowBytes / preambleMeta），不依赖任何几何结果。
  refreshRows()
  /**
   * 裁定 #29.5（①/③）：把「本代」记进 generations（跨代坐标账）。
   *
   * ⚠️ 必须在**每次渲染活动片之前**调用：`generations` 会进 `board-rotate:meta`（活动片的一部分），
   * 而 `--plan` 结尾用「同一份分段账」与「渲染结果」逐字节对拍。第一次实测就踩了这个坑 ——
   * 台账在渲染之后才赋值 ⇒ `--plan` 报 3,202 B、分段账拼出来 3,554 B（差 352 B，正是台账本身），
   * 被那条对拍断言当场拦下（**断言是对的，位置是错的**）。
   * 预算收敛循环里每让出一节都会重建分片 ⇒ 台账（shards / archivedBodyBytes / retainedBytes）
   * 也必须随之刷新，否则元数据里的账与实际计划对不上。
   */
  /**
   * 裁定 #31-④：逐代复算**升到 sha256 级**（旧形态只比字节数）。每代记三段的 sha256 + 字节：
   *   ① archivedBodySha256/Bytes —— 该代归档片**正文**按原始偏移序拼接
   *   ② retainedSha256/Bytes     —— 该代保留原文节按原始偏移序拼接
   *   ③ genBlockSha256/Bytes     —— 该代源文件里的**生成块**（元数据 + 归档索引 + 读法 + 抬头），
   *                                = 源文件从偏移 0 到「第一个保留原文节」之前的那一段
   * 恒等式（单次拼接，无交错布局；口径见裁定 #32-③）：
   *   sha256(A_src ‖ 归档正文(原偏移序) ‖ 保留原文(原偏移序)) == 该代源 sha256
   *   —— A_src 是**该代源文件里的生成块**，不是本轮新写的那个。
   *
   * ⚠️ **自指陷阱，已按「等长占位符」化解，改代码时不要退回**：
   * `genBlockBytes` 是元数据块自己的内容之一 ⇒ 它一变、元数据长度变、`genBlockBytes` 又变。
   * 解法同片头的长度不动点：**先用等长占位值**（sha 用 `'0'.repeat(64)`、字节数用 `null`）
   * 迭代到不动点，真值只在**最终文本已渲染完之后**才能填（见 `stampCurrentGeneration`）。
   * 占位 sha 与真 sha **等长** ⇒ 填真值不改变任何字节数 ⇒ `--plan` 预告尺寸 == `--apply` 写出尺寸。
   * 谁把占位值改成空串或 `null`，那条尺寸对拍会立刻炸（这是期望行为，不是脆弱）。
   */
  const GEN_SHA_PLACEHOLDER = '0'.repeat(64)
  /**
   * 定宽十进制**字符串**（`0` 补前导零）。
   *
   * ⚠️ 三条反面教训，别退回（都是一次实测踩出来的）：
   *   ① 占位用 `null`（4 字符）：真值恰好 4 位（4,480）时「碰巧」等长，真值 5 位（10,000+）就整体错位。
   *   ② 占位用**裸 number 0**：真值 4194 是 4 位 ⇒ JSON 里 `0` → `4194`，短了一位，链接炸。
   *   ③ 把定宽数字存成 **number**：`Number('000000004194')` = `4194`，前导零当场丢失 ⇒ 定宽白做。
   * 所以存**字符串**：`"000000004194"`。宽度与值无关 ⇒ 填真值不改变任何字节数。
   * 代价是 JSON 里带 2 个引号 —— 那是**两边都有**的常量，不影响「填值前后等长」这个不变量。
   */
  const GEN_BYTES_WIDTH = 12
  const padBytes = (n) => {
    // `null` 表示「取不到」（不是 0）——必须与 0 区分：0 是「该代源里确实没有生成块」，
    // null 是「上一版元数据没记这个偏移 ⇒ 不可再验」。把 null 补成 '000000000000' 就是伪造读数。
    if (n === null || n === undefined) return null
    return String(n).padStart(GEN_BYTES_WIDTH, '0')
  }

  /**
   * 恒等式㈠ 里的 A_src：**该代源文件**里、第一个保留原文节之前的字节数 = 那一代的「生成块」。
   *   · 第 1 代：源文件是人类手写的（末尾没有元数据块）⇒ A_src = **0 B**；
   *   · 第 N(≥2) 代：源文件 = 上一代的活动片，它的各保留区间偏移记在上一版元数据的 `retained[]`
   *     的 `activeStartByte` 里 ⇒ A_src = 最小的那个 `activeStartByte`。
   * ⚠️ 这里**不能**用「本轮新写的生成块字节数」：那是下一代的 A_src，不是这一代的（混用过，当场炸）。
   * ⚠️ 上一版元数据里的 `activeStartByte` 也可能缺失（老版本写的活动片）⇒ 那时取不到就退化为 null，
   *     `--verify` 会如实报「不可再验」，**不得与「相等」同形**。
   */
  function computeSourceGenBlockBytes() {
    // A_src = **该代源文件**（= 上一版活动片）里、第一个保留原文节之前的字节数，也就是那一代的生成块。
    //
    // 取法：上一版台账自己量的 `generations[last].newGenBlockBytes`（生成块总字节）。
    // 备选（前一条缺了才用）：`newGenMetaBytes + newGenIndexBytes + newGenReadmeBytes`。
    //
    // ⚠️ 三条**不能**用的取法（历史都踩过，别退回）：
    //   ① 取「上一版 `retained[].activeStartByte` 的最小值」——那组偏移会被 `refreshRows()` /
    //      `recomputeGeometry()` 在**本轮预算迭代**里重写成**新一代活动片**的坐标（它是屏幕上的
    //      活变量，不是历史记录）。实测（tiny 第二次 `--apply`，源 5,405 B）：这样取到 5,375，
    //      而那正是**新片（12,171 B）**的布局 ⇒ 恒等式㈠ 报「998 + 4,407 + 5,375 = 10,780 ≠ 5,405」。
    //   ② 取「元数据块的结束位置」——生成块还含**归档索引与读法指示**两段（排在元数据块之后），
    //      只算元数据块会少算一千多字节（实测 3,639 vs 真值 4,8xx）。
    //   ③ 取「第一个保留节在源文件里的起点 `retained[].startByte`」——对，但要处理 §0
    //      （它的 `startByte` 是 0）且旧版元数据可能没记这个字段，所以只作第二备选。
    // 三条都取不到 ⇒ `null`（`--verify` 会如实报「不可再验」，**不得与「相等」同形**）。
    if (!existingMeta) return 0
    // ⚠️ **先判「上一代台账里 A_src 这一项是不是 0」**，不要看 `newGenBlockBytes`。
    //
    // `newGenBlockBytes` 是「上一版这一代**写出去的**生成块」，它含**本代重算的归档索引**；
    // 而输出阶段（`stampCurrentGeneration`）重新渲染时索引会再变一次 —— 两个值可以不同。
    // 拿它当 A_src 用，实测在 tiny 第二代上给出 5,375（那是**上一代**的生成块），
    // 而「上一代台账」自己记的 `A_src` 是 **0**（第 1 代的源 43 B 全是人写的）。
    //
    // 判据是**上一代台账自己写下的等式**：
    //   `archivedBodyBytes + retainedBytes + sourceGenBlockBytes == sourceBytes`
    // 左边三项都在上一版元数据里。若这个等式在**去掉 A_src 项**之后正好成立，
    // 就说明该代源文件的字节已经全部被归档正文与保留原文覆盖 ⇒ 上一代源里**没有生成块**，
    // 本代源（= 上一代活动片）的 A_src 应当是 **0**。
    const gens = Array.isArray(existingMeta.generations) ? existingMeta.generations : []
        const last = gens.length ? gens[gens.length - 1] : null
    if (last) {
      const sb = Number(last.sourceBytes)
      const ab = Number(last.archivedBodyBytes)
      const rb = Number(last.retainedBytes)
      if (Number.isFinite(sb) && Number.isFinite(ab) && Number.isFinite(rb) && ab + rb === sb) {
        return 0
      }
    }
    if (last) {
      let nb = Number(last.newGenBlockBytes)
      if (!Number.isFinite(nb)) {
        const a = Number(last.newGenMetaBytes)
        const b = Number(last.newGenIndexBytes)
        const c = Number(last.newGenReadmeBytes)
        nb = Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) ? a + b + c : NaN
      }
      if (Number.isFinite(nb)) {
        return nb
      }
    }
    const rs = Array.isArray(existingMeta.retained) ? existingMeta.retained.filter((r) => r.idx !== 0 && Number.isInteger(r.startByte)) : []
    if (rs.length) {
      const g2 = Math.min(...rs.map((r) => r.startByte))
      return g2
    }
    const m0 = parseMeta(buf.toString('utf8'))
    if (!m0 || m0.parseError || m0.index !== 0 || !Number.isInteger(m0.end)) return null
    let gen = m0.end
    if (buf[gen] === 0x0a) gen += 1
    return gen
  }
  const sourceGenBlockBytes = computeSourceGenBlockBytes()

  function syncGenerationLedger() {
    // 前几代：保留区间字节数 = 该代源字节数 − 该代归档片正文字节之和。
    // 这不是估算：每片正文的字节数由它**自己的片头**自述，且整片已与盘上字节对拍过。
    const inherited = priorGenerations.map((g) => {
      const mine = []
      for (const p of priorShards) {
        const abs = path.join(archiveDir, p.name)
        if (!existsSync(abs)) continue
        const facts = readShardFacts(abs)
        if (facts.generation === g.generation) mine.push({ name: p.name, bodyBytes: facts.bodyBytes })
      }
      const bodyBytes = mine.reduce((a, p) => a + (p.bodyBytes === null ? 0 : p.bodyBytes), 0)
      const retainedBytes = Math.max(0, g.sourceBytes - bodyBytes)
      // 裁定 #33 ①：`retainedBytes` 在这一路是**残差**（= 该代源字节数 − 归档片正文字节和），
      // 不是测量值。它进台账时必须打标，免得后来的读者拿它当独立读数用。
      // 为什么这里必须这么算：旧代的归档片正面字节和此时在盘上仍可数，而保留区间的字节
      // 在上一版活动片被覆盖后**已经读不到了**；唯一还在手的量就是 `sourceBytes`。
      const derivedFlags = { retainedBytes: true }
      // #31-④：旧代的三段字节在**当前活动片里已不存在**（上一代的活动片被本轮覆盖）⇒
      // `genBlockOnDisk: false`，`--verify` 要印成「不可再验」，**不得与「相等」同形**
      // （同一条判据：读不到 ≠ 没有）。三段 sha 从上一版元数据逐字继承，值本身仍在盘上。
      return {
        ...g,
        filesOnDisk: mine.map((p) => p.name),
        archivedBodyBytes: bodyBytes,
        retainedBytes,
        derived: { ...(g.derived || {}), ...derivedFlags },
        archivedBodySha256: g.archivedBodySha256 || null,
        retainedSha256: g.retainedSha256 || null,
        // 归一化成**定宽字符串**：旧版可能存的是裸数字或 null，不归一化会让「等长」假成立（见 padBytes 注释）。
        sourceGenBlockBytes: g.sourceGenBlockBytes === undefined || g.sourceGenBlockBytes === null ? null : padBytes(g.sourceGenBlockBytes),
        newGenBlockBytes: g.newGenBlockBytes === undefined || g.newGenBlockBytes === null ? null : padBytes(g.newGenBlockBytes),
        newGenMetaBytes: g.newGenMetaBytes === undefined || g.newGenMetaBytes === null ? null : padBytes(g.newGenMetaBytes),
        newGenMetaSha256Skipped: true,
        newGenIndexBytes: g.newGenIndexBytes === undefined || g.newGenIndexBytes === null ? null : padBytes(g.newGenIndexBytes),
        newGenIndexSha256: g.newGenIndexSha256 || null,
        newGenReadmeBytes: g.newGenReadmeBytes === undefined || g.newGenReadmeBytes === null ? null : padBytes(g.newGenReadmeBytes),
        newGenReadmeSha256: g.newGenReadmeSha256 || null,
        newGenBlockOnDisk: false,
      }
    })
    meta.generations = [
      ...inherited,
      {
        generation,
        sourceSha256: meta.sourceSha256,
        sourceBytes: meta.sourceBytes,
        sourceLines: meta.sourceLines,
        archiveDir: path.basename(archiveDir), // 裁定 #31-⑤：只记文件名，不记路径
        shards: meta.shards.map((s) => s.file),
        archivedBodyBytes: meta.shards.reduce((a, s) => a + s.bodyBytes, 0),
        retainedBytes: meta.retained.reduce((a, r) => a + r.bytes, 0),
        // 下面这些字段由 `stampCurrentGeneration()` 在最终文本渲染完后定稿（此前是**等长占位**）。
        // 占位必须与真值**等长**：`genBlockBytes` 用定宽 12 位字符串、三个 sha 用 64 个 `0`。
        // 踩过的三个坑（都在 tiny 上实测炸过，别退回）：
        //   ① 占位 `genBlockBytes: null`（4 字符）在真值 4,480（4 字符）时碰巧等长，真值 10,000 就错位；
        //   ② 占位写成裸 number `0` ⇒ 真值 4,487 多一位，链接断；
        //   ③ 把定宽数字存成 **number** ⇒ `Number('000000004194')` 前导零当场丢失，定宽白做。
        // 还有一条：**这些键必须在渲染时就存在**（哪怕是占位）——定稿时才新增键会让 JSON 多出
        // 3 行、约 259 B，渲染出来的文本凭空变长，「填真值前后等长」当场失败（实测 4,240 → 4,520）。
        // ---- 恒等式用的 A_src：「**该代源文件**里的生成块」
        //
        // ⚠️ 这个值**不是**「本轮要写出去的生成块」，两者完全不同，混用会当场炸（实测踩过）：
        //   第 1 代的源文件是**人类手写的**，末尾没有任何元数据块 ⇒ A_src = 0 B；
        //   若这里填「本轮新写的生成块」（tiny 上 4,791 B），恒等式㈠ 变成
        //   13 + 30 + 4,791 = 4,834 ≠ 43，--apply 写后校验立刻报红并回滚。
        //   第 N(≥2) 代的 A_src = 上一版活动片开头那段旧生成块（由 `parseMeta` 定界）。
        sourceGenBlockBytes: padBytes(sourceGenBlockBytes),
        // ---- 本轮新写的生成块的分量（供 --verify 事后复核；**不用于恒等式**）
        //
        // ⚠️ **不记 `newGenBlockSha256`**：生成块 = 元数据块 + 归档索引 + 读法 + 抬头，而台账
        //（= 本对象）就在元数据块里 ⇒ 给它记自己的摘要会自指，**无确定解**（同片头自指）。
        // 所以拆成两段**可真算**的 sha256 + 元数据段字节数（元数据段自身的 sha 同样自指，只能记长度）。
        // 用 `newGenMetaSha256Skipped` **布尔标记**而不是「64 个 0 的假 sha」：
        // 假值长得像真值，读的人会以为已完成核对。
        newGenBlockBytes: padBytes(0),
        newGenMetaBytes: padBytes(0),
        newGenMetaSha256Skipped: true,
        newGenIndexBytes: padBytes(0),
        newGenIndexSha256: GEN_SHA_PLACEHOLDER,
        newGenReadmeBytes: padBytes(0),
        newGenReadmeSha256: GEN_SHA_PLACEHOLDER,
        newGenBlockOnDisk: true, // 本轮输出的生成块就在活动片开头，--verify 可切片核对
        archivedBodySha256: GEN_SHA_PLACEHOLDER,
        retainedSha256: GEN_SHA_PLACEHOLDER,
        // ---- 「该代源文件」里各保留节的坐标（供 `--verify` 第 ④ 条做规范拼接）----
        //
        // ⚠️ 为什么必须是**源坐标**而不是活动片偏移：`meta.retained[].activeStartByte` 是相对
        // **本轮新写出去的活动片**的（盘上 4,835 B），而「该代源文件」是**上一版**活动片
        //（tiny 第 1 代的源就是人类手写的那 43 B）。拿新片偏移去切旧源 ⇒ 切出的是别的节，
        // 而且**长度可能碰巧相等**（实测 §2 那条切出 13 B，正是 §1 的字节）⇒ 症状是
        // 「长度对得上、sha 不等」，极难看出。这里记 `from/to` 直接来自源文件的节切分。
        // ⚠️ `meta.retained` 里**含 §0（抬头）**，而抬头要单独作为「该代源文件第 0 段」补在最前面
        //（见下面 `preambleSourceBytes`）⇒ 这张坐标表必须**从 §1 起**记，否则 §0 会被算两次：
        // 排序后相邻两段 from/to 变成 5..0 ⇒ 报「5..0 处空隙或重叠 5 B」（实测踩过）。
        retainedSourceCoords: meta.retained.filter((r) => r.idx !== 0).map((r) => ({
          label: r.label, idx: r.idx, from: r.startByte, to: r.endByte,
          // 同一个节在**本轮渲染结果**里的坐标（切片用这一对），见 preambleActiveStartByte 的说明。
          paneFrom: Number.isInteger(r.activeStartByte) ? r.activeStartByte : null,
          paneTo: Number.isInteger(r.activeEndByte) ? r.activeEndByte : null,
        })),
        // 抬头（§0）在**该代源文件**里的字节数：保留节覆盖不到它（它不在任何节里），
        // 所以规范拼接要在最前面把它补回来。值 = 第一个节在源文件里的起点。
        preambleSourceBytes: kept.length && kept[0].idx === 0 ? kept[0].endByte : 0,
        // 抬头在**该代源文件**里的 sha256。为什么要记：`--verify` 离线跑时，源文件（上一版活动片）
        // 早已不在盘上，抬头的字节不可能再取出来算 —— 只剩「与台账记的摘要比」这一种核对方式。
        // 不记 ⇒ 离线只能报「不可再验」，而「抬头的字节有没有被搬错」恰恰是最需要离线复核的一格。
        // 定稿（`stampCurrentGeneration`）时填真值；占位是 64 个 `0`，与真值**等长**（不变量）。
        preambleSourceSha256: GEN_SHA_PLACEHOLDER,
        // 抬头的字节在**本轮渲染结果**（= 下一代活动片）里的坐标。
        //
        // ⚠️ 为什么不能拿「该代源文件」的 0..preamble 去切片：`--verify` 的 `activeBuf` 是
        // **刚刚重写过的活动片**（盘上那份已经是新内容），拿它的 0..5 切出来的是元数据块的
        // `<!-- `（实测：`"<!-- ## 1. a\nbbb\n\nbegin -->..."`）⇒ sha 不等却看不出原因。
        // 抬头与保留节一样，都还留在本轮渲染结果里、也还会留在下一代活动片里，
        // 而「该代源文件」= 上一代活动片，两者的这些字节按判据相同 ⇒ 用新片的坐标切片即可。
        preambleActiveStartByte: preambleMeta && Number.isInteger(preambleMeta.activeStartByte) ? preambleMeta.activeStartByte : null,
        preambleActiveEndByte: preambleMeta && Number.isInteger(preambleMeta.activeEndByte) ? preambleMeta.activeEndByte : null,
        // ---- 裁定 #33 ①：「节树是该代源文件的一个划分」的**正向证明**材料 ----
        //
        // 为什么要记这个：A_src（= 该代源文件里、第一个保留原文节之前的那些字节）原来是靠
        // `archivedBodyBytes + retainedBytes == sourceBytes ⇒ A_src = 0` 推出来的 —— 而
        // `retainedBytes` 在**回填**（`inherited` 那条路）时本身就是按 `sourceBytes − bodyBytes`
        // 算出来的残差 ⇒ 那条等式对回填的代**恒真**，拿它当证据是**同义反复**（A 的原话）。
        //
        // 改为记下各节在**该代源文件**里的区间 `[startByte, endByte)`，让读者能独立复核四件事：
        //   ① 首节 startByte == 0（节树从文件第一个字节起）
        //   ② 相邻两节：前一节 endByte == 后一节 startByte（连续，无缝）
        //   ③ 区间两两不重叠（由 ② 直接蕴含，仍单独检查一遍）
        //   ④ 末节 endByte == sourceBytes（节树止于文件最后一个字节）
        // Σ 节长 == sourceBytes 是 ①+②+④ 的推论。四件事都成立 ⇒ 源文件里**不存在**
        // 任何落在节树之外的字节 ⇒ 生成块也在 §0 抬头里 ⇒ A_src = 0 是**推论**，不是巧合。
        sections: sections.map((s) => ({
          idx: s.idx,
          label: s.label,
          startByte: s.startByte,
          endByte: s.endByte,
        })),
        // ---- 裁定 #33 三：这一代的台账必须答得出「是哪一版工具切的」----
        // 取不到自己（例如单文件被内联执行）时记 `null`，**不补 64 个 0 的假 sha**
        // ——假值长得像真值，读的人会以为已核对（同 `newGenMetaSha256Skipped` 的道理）。
        toolSha256: TOOL_SHA256,
      },
    ]
    if (inherited.length && existingMeta) {
      const prev = existingMeta.generations || []
      if (prev.length !== inherited.length) {
        console.log(`⚠ 代际台账长度与上一版元数据不一致（上一版 ${prev.length} 代 / 本版重算 ${inherited.length} 代）⇒ 显式列出，不静默修补。`)
      }
    }
  }

  /**
   * 裁定 #31-④「当代三段」的定稿。**调用点必须在「最终文本已渲染完」之后**。
   * 生成块 = 最终文本去掉尾部「保留原文」那一段（等价于「偏移 0 到第一个保留原文节之前」）。
   * 返回当代三段的读数，供调用方打印/断言。
   */
  /**
   * 从「当前这一份渲染结果」里读出当代三段的读数。
   * 返回 `stable` 表示这次读出的值与台账里已记的一致（不动点到了）。
   *
   * ⚠️ **`genIndexSha256` / `genReadmeSha256` / 各段字节数都写回台账（= 元数据块）自身**，
   * 而元数据块又是活动片开头那一段 ⇒ 「改台账 → 元数据长度变 → 索引/读法长度又可能变」。
   * 这是又一处自指，解法仍是「占位 + 迭代到不动点」：调用方（`finalizeActiveRender`）
   * 反复「渲染 → 读段 → 写回」，直到 `stable === true`。
   *
   * ⚠️ **`genMetaSha256` 永远不记，且不要试图加回来**：元数据块自己装不下自己的摘要
   *（同片头自指）。所以当代记的是 `genMetaBytes`（可判「三段之和 == 生成块」）+ 另外两段的真 sha256。
   */
  function stampCurrentGeneration(finalText, shardShaOverride = null) {
    const cur = meta.generations[meta.generations.length - 1]
    const archivedParts = meta.shards.map((s) => buf.subarray(s.startByte, s.endByte))
    const retainedParts = kept.map((s) => buf.subarray(s.startByte, s.endByte))
    cur.archivedBodyBytes = archivedParts.reduce((a, p) => a + p.length, 0)
    cur.retainedBytes = retainedParts.reduce((a, p) => a + p.length, 0)
    cur.archivedBodySha256 = sha(Buffer.concat(archivedParts))
    cur.retainedSha256 = sha(Buffer.concat(retainedParts))
    // 抬头在该代源文件里的摘要（`buf` = 该代源文件的字节，`--apply` 与 `--plan` 都有它）。
    // 空抬头（没有 §0）⇒ 记空字符串，`--verify` 见到 `''` 时**不当作占位**（那是「确实没有抬头」）。
    {
      const preB = Number(cur.preambleSourceBytes || 0)
      cur.preambleSourceSha256 = preB > 0 && preB <= buf.length ? sha(buf.subarray(0, preB)) : ''
    }

    // 生成块 = 元数据块 + 归档索引 + 读法 + 抬头。按**渲染分段**取，不按布局常量手算。
    // `shardShaOverride`：`--apply` 写出归档片、实测出整片 sha256 之后要把索引里那 7 列换成真值
    // ⇒ 索引字节变了、台账记的 `newGenIndexSha256` 必须跟着变。传 `null` = 用当前 `sh.fileSha256`
    //（`--plan` 阶段是等长占位符，`--apply` 未实测完也是）。
        const savedSha = meta.shards.map((x) => x.fileSha256)
    if (shardShaOverride) meta.shards.forEach((x, i) => { x.fileSha256 = shardShaOverride[i] })
    const pieces = piecesOf(plan, kept, buf)
    if (shardShaOverride) meta.shards.forEach((x, i) => { x.fileSha256 = savedSha[i] })
    const byName = new Map(pieces.map((p) => [p.name, Buffer.from(p.text, 'utf8')]))
    const metaBuf = byName.get(PIECE_META)
    const indexBuf = byName.get(PIECE_INDEX)
    const readmeBuf = byName.get(PIECE_README)
    if (!metaBuf || !indexBuf || !readmeBuf) {
      fail(EXIT.INCOMPLETE, `未能验证：活动片分段里缺少元数据/归档索引/读法之一（本工具的渲染 bug，不写盘）`)
    }
    const genBytes = metaBuf.length + indexBuf.length + readmeBuf.length
        if (String(genBytes).length > GEN_BYTES_WIDTH) {
      fail(EXIT.INCOMPLETE,
        `未能验证：生成块字节数 ${fmt(genBytes)} 超过占位宽度 ${GEN_BYTES_WIDTH} 位 ⇒ 定宽不变量失效。\n` +
        `   ⇒ 请把 GEN_BYTES_WIDTH 加宽（这是本工具的常量，不是被切分文件的问题）。不写盘。`)
    }
        const keys = ['newGenBlockBytes', 'newGenMetaBytes', 'newGenIndexBytes', 'newGenIndexSha256', 'newGenReadmeBytes', 'newGenReadmeSha256']
    const snapshot = () => JSON.stringify(keys.map((k) => cur[k]))
    const before = snapshot()
    cur.newGenBlockBytes = padBytes(genBytes)
    cur.newGenMetaBytes = padBytes(metaBuf.length)
    cur.newGenIndexBytes = padBytes(indexBuf.length)
    cur.newGenIndexSha256 = sha(indexBuf)
    cur.newGenReadmeBytes = padBytes(readmeBuf.length)
    cur.newGenReadmeSha256 = sha(readmeBuf)
            return { stable: before === snapshot(), genBytes, metaBytes: metaBuf.length, indexBytes: indexBuf.length, readmeBytes: readmeBuf.length }
  }



  syncGenerationLedger()
  recomputeGeometry()
  if (changed.size !== 0) {
    fail(EXIT.INCOMPLETE, `未能验证：保留区间在活动片里的偏移迭代 12 次仍未收敛（变化项：${[...changed].join(' ')}）`)
  }

  // ---- 活动片预算收敛（默认规则时）
  //
  // 上面那轮只保证了「保留节的字节之和 ≤ 预算」，但活动片还含元数据块 / 抬头 / 归档索引 / 读法，
  // 这几块在真 a.md 上合计约 27 KB 且随片数增长。所以必须拿**渲染后的真实总长**再收敛一次：
  // 超预算就从最老的一端丢一节（丢掉的节改归归档），丢完重新渲染，直到 ≤ maxBytes。
  // 只在「未显式给 --keep-bytes / --keep-sections」时做——显式给了就是要窗口本身那个数，由用户负责。
  if (o.keepBytes === null && o.keepSections === null) {
    let dropped = 0
    for (let guard = 0; guard < sections.length + 2; guard += 1) {
      if (activeBufNew.length <= o.maxBytes) break
      const candidates = kept.filter((s) => s.idx !== 0)
      if (candidates.length <= 1) break
      const victim = candidates[0]                       // 最老的一节
      kept.splice(kept.indexOf(victim), 1)
      dropped += 1
      // 丢掉的那一节改归归档（保持「保留 + 归档」仍是全文件的一个划分）
      if (!archivedSections.some((a) => a.idx === victim.idx)) {
        archivedSections.push(victim)
        archivedSections.sort((a, b) => a.idx - b.idx)
      }
      // 重算保留元数据与归档片，再重新渲染活动片
      refreshRows()
      meta.shards = buildShards(archivedSections)   // 原地换掉分片规划（frameShards 就地改这个数组）
      frameShards(meta.shards)
      plan.shards = meta.shards
      syncGenerationLedger()                        // #29.5：分片变了 ⇒ 代际台账必须跟着变
      recomputeGeometry()
    }
    if (dropped > 0) {
      ruleText = `${ruleText}；再按**活动片最终字节 ≤ ${fmt(o.maxBytes)} B**收敛，又让出 ${dropped} 节给归档 ⇒ 最终保留 ${kept.length} 节（${kept.map((s) => s.label).join(' ')}）`
    }
  }
  // 裁定 #31-④：定稿当代三段 sha256 并重排一次，让「盘上字节」与「台账」一致。
  // 必须在预算收敛之后（`kept` / `meta.shards` 都定稿了），且在 `--plan` 报告与 `--apply` 写盘之前。
  finalizeActiveRender()
  // ---- 裁定 #29.4：写盘前硬断言（计划片名两两不同 && 不与盘上已存在文件重名）。
  {
    // #29.4：写盘前硬断言 —— 计划片名两两不同，且不与盘上已存在文件重名。
    // 判据（A 裁定）：任一不成立 ⇒ EXIT≠0，打印冲突片名清单，**一个文件都不写**。
    //
    // ⚠️ 只查「文件名两两不同」是**查错了性质**（第一版就犯了这个错，负向对照当场暴露）：
    // 旧版把三片都叫 `…-002/003/004-§4-§4.md`，文件名本来就不同（NNN 不同），
    // 真缺陷是「**节区间字段** §4-§4 不再唯一」——章程 §4.13.2b 的读法是「按索引 grep 定位一片」，
    // 同一个节区间出现在 ≥2 行里，按它 grep 就会命中多片。所以要查的正是这个：
    //   同一节区间若被 ≥2 片占用 ⇒ 这些片必须**全部**带 part 标记（且 k 各不同）；
    //   否则「只读一行索引即可唯一确定」这句话对那个区间不成立。
    const dup = meta.shards.map((s) => s.file).filter((f, i, a) => a.indexOf(f) !== i)
    if (dup.length) {
      fail(EXIT.FAIL,
        `拒绝：计划片名**两两不同**不成立 —— 有 ${new Set(dup).size} 个名字被两片占用（裁定 #29.4）：\n` +
        [...new Set(dup)].map((f) => `   - ${f}（出现 ${dup.filter((x) => x === f).length + 1} 次）`).join('\n') +
        `\n   一个文件都没写。`)
    }
    const rangeGroups = new Map()
    for (const s of meta.shards) {
      const key = `§${s.fromLabel}-§${s.toLabel}`
      if (!rangeGroups.has(key)) rangeGroups.set(key, [])
      rangeGroups.get(key).push(s)
    }
    const rangeConflict = [...rangeGroups].filter(([, list]) => list.length > 1)
    if (rangeConflict.length) {
      // 判据必须看**印出去的片名**里有没有 part 标记，而不是看 `partK` 字段：
      // 负向对照第一版就是这么放过去的 —— 对照台把 partTag 置空，可 partK 仍然算得出 [1,2,3]，
      // 于是「partK 各不相同」这条判据为真、断言不响。**查字段 ≠ 查产物。**
      const tagged = (s) => /-part\d+of\d+\.md$/.test(s.file)
      const bad = rangeConflict.filter(([, list]) => list.some((s) => !tagged(s)) || new Set(list.map((s) => s.file.match(/-part(\d+)of/)?.[1])).size !== list.length)
      if (bad.length) {
        fail(EXIT.FAIL,
          `拒绝：节区间字段**不再唯一**（裁定 #29.4 / 章程 §4.13.2b 的「按索引 grep 定位一片」会命中多片）：\n` +
          bad.map(([k, list]) => `   - ${k}：${list.length} 片 —— ${list.map((s) => `${s.file}${s.partK ? '' : '（**无 part 标记**）'}`).join(' / ')}`).join('\n') +
          `\n   一个文件都没写。修法：被 ≤1 节独占的多片必须带 part k/m 标记（裁定 #29.2 的命名格式）。`)
      }
    }
    const onDisk = meta.shards.filter((s) => existsSync(path.join(archiveDir, path.basename(s.file))))
    if (onDisk.length) {
      fail(EXIT.FAIL,
        `拒绝：计划片名与**盘上已存在文件重名**（裁定 #29.4 / 章程 §4.13.2b-4「归档片只增不改」）：\n` +
        onDisk.map((s) => `   - ${path.join(archiveDir, path.basename(s.file))}`).join('\n') +
        `\n   一个文件都没写。再切请让 NNN 续号（本工具已扫 archive/ ⇒ 本次 seqBase=${seqBase}，最大既有号 ${priorMaxNum || '（目录为空）'}）。`)
    }
  }

  if (activeBufNew.length > o.maxBytes) {
    // 裁定 #30.1：显式给 --keep-bytes/--keep-sections 时**不改变用户的选择**（不静默收敛），
    // 但超限必须显著告警并点明章程的上限与实测字节，然后**照常执行**（不 fail）。
    // 为什么「不 fail」是对的：超限可能是单节本身就超 96 KiB（章程 §4.13.2b-2 明文允许该情形），
    // 此时唯一的「修法」是去改内容分节，不是让工具拒绝工作——拒绝工作只会让人绕过工具手抄。
    console.log(`⚠ 活动片最终 ${fmt(activeBufNew.length)} B > 上限 ${fmt(o.maxBytes)} B（章程 §4.13.2b 上限 96 KiB = ${fmt(MAX_BYTES)} B）：`)
    console.log(`   实际字节 ${fmt(activeBufNew.length)} B；本工具不静默降级、也不 fail —— 照常执行。`)
    console.log(`   若这不是你要的，请调小 --keep-bytes / --keep-sections，或给 --sub-boundary 让超限节可切。`)
  }

  // ---- 裁定 #31-④：当代三段（归档正文 / 保留原文 / 生成块）的 sha256 定稿
  //
  // 为什么必须**迭代**：`genIndexSha256` / `genReadmeSha256` / 各段字节数都写回台账（= 元数据块），
  // 而元数据块又是活动片开头那一段 ⇒「改台账 → 元数据长度变 → 生成块长度又变」。
  // 这是自指，解法同片头的长度不动点：**反复「渲染 → 读段 → 写回」直到一轮下来值全不变**。
  //   · 占位与真值等长（`padBytes` 定宽 12 位字符串、`GEN_SHA_PLACEHOLDER` 64 个 `0`）⇒ 字节数不变；
  //   · 不收敛（12 轮仍在变）⇒ EXIT=2，绝不静默留一份「账与字节不一致」的活动片。
  // 不记 `genBlockSha256` 的理由见台账处注释（无确定解），本条只保证「三段之和 == 生成块字节」+ 两段真 sha。
  function finalizeActiveRender() {
    let cur = null
    let ok = false
    for (let i = 0; i < 12; i += 1) {
      activeBufNew = Buffer.from(renderActive(plan, kept, buf), 'utf8')
      const r = stampCurrentGeneration(activeBufNew.toString('utf8'))
            if (r.stable) { ok = true; break }
    }
    if (!ok) {
      fail(EXIT.INCOMPLETE,
        `未能验证：生成块分段台账在 12 轮渲染内未收敛（每轮写回台账都会改变元数据长度）。\n` +
        `   ⇒ 占位与真值不等长，或某段字节数依赖它自己。不写盘。`)
    }
    cur = meta.generations[meta.generations.length - 1]
    // 自证 1：三段之和 == 生成块（三段都是**从最终渲染结果里切出来的**，不是按布局常量手算的）
    const sum = Number(cur.newGenMetaBytes) + Number(cur.newGenIndexBytes) + Number(cur.newGenReadmeBytes)
    if (sum !== Number(cur.newGenBlockBytes)) {
      fail(EXIT.INCOMPLETE,
        `未能验证：生成块分段之和不等于生成块字节数（元数据 ${fmt(Number(cur.newGenMetaBytes))} + 索引 ${fmt(Number(cur.newGenIndexBytes))} + 读法 ${fmt(Number(cur.newGenReadmeBytes))} = ${fmt(sum)} ≠ ${fmt(Number(cur.newGenBlockBytes))}）。\n` +
        `   ⇒ 本工具的渲染 bug，不写盘。`)
    }
    // 自证 2：索引段与读法段按台账字节数从**最终字节**里切出来，sha 必须与台账相等
    const pieces = piecesOf(plan, kept, buf)
    const byName = new Map(pieces.map((p) => [p.name, Buffer.from(p.text, 'utf8')]))
    const idxBuf = byName.get(PIECE_INDEX)
    const rmeBuf = byName.get(PIECE_README)
    if (sha(idxBuf) !== cur.newGenIndexSha256) {
      fail(EXIT.INCOMPLETE, `未能验证：归档索引段自证不等（台账 ${cur.newGenIndexSha256} / 实得 ${sha(idxBuf)}）⇒ 不写盘。`)
    }
    if (sha(rmeBuf) !== cur.newGenReadmeSha256) {
      fail(EXIT.INCOMPLETE, `未能验证：读法段自证不等（台账 ${cur.newGenReadmeSha256} / 实得 ${sha(rmeBuf)}）⇒ 不写盘。`)
    }
    return cur
  }

  // ---- --plan
  if (o.mode === 'plan') {
    console.log('board 分片轮换计划（board-rotate.mjs --plan · **未改盘**）')
    console.log(`分片：${filePath}`)
    console.log(`归档目录：${archiveDir}`)
    // 裁定 #29.5：再切必须把「续号」与「代际」明写在输出里 —— 不然读的人不知道
    // 「这一代的偏移是从哪份文件的第 0 字节算起的」，两代偏移会被混着读。
    console.log(`代际：本片是第 ${generation} 代${existingMeta ? `（上一版元数据记的是第 ${existingMeta.generation || 1} 代）` : '（首次轮换：尚无元数据块）'}`)
    console.log(`归档目录扫描：${priorShards.length ? `既有 ${priorShards.length} 片，最大序号 ${priorMaxNum}` : '目录不存在或为空'} ⇒ 本轮 NNN 从 ${String(priorMaxNum + 1).padStart(3, '0')} 起续号，绝不覆盖`)
    if (priorMaxNum === 0 && generation > 1) {
      console.log(`⚠ 元数据说这是第 ${generation} 代，但归档目录里没有既有片 ⇒ 台账不一致，请人工核对（本工具不静默修补）。`)
    }
    if (generation > 1) {
      console.log(`坐标提示：本代的「原始字节区间」是相对**本轮源文件**（= 第 ${generation - 1} 代活动片）的，`)
      console.log(`          与第 1 代那些归档片的偏移**不是同一个坐标空间**；每片片头带「本片属于第 N 代」自证归属。`)
    }
    // 生成时刻只出现在这里（人读的那一路），不进 meta、不进任何摘要——见 meta 定义处的说明。
    console.log(`生成时刻：${new Date().toISOString()}（**仅供人读；本行不进任何摘要**，故两次 --plan 的摘要逐字节相同）`)
    console.log('')
    console.log(`源文件：sha256 ${meta.sourceSha256}`)
    console.log(`       ${fmt(meta.sourceBytes)} B · ${fmt(meta.sourceLines)} 行（口径：字节 = Buffer 长度；行 = \\n 个数，末行无终结符时 +1）`)
    console.log(`       轮换触发线 ${fmt(o.triggerBytes)} B ⇒ ${meta.sourceBytes > o.triggerBytes ? '**超过触发线，应当轮换**' : '未超过触发线'}`)
    console.log('')
    console.log(`节边界正则：${JSON.stringify(o.boundariesRaw)}（逐行测试，任一命中即节首）`)
    console.log(`解析出 ${sections.length} 节（含 preamble §0：${fmt(preambleBytes)} B）`)
    for (const s of sections) {
      const mark = keepSet.has(s.idx) ? '保留' : '归档'
      console.log(`  [${mark}] ${s.idx}${s.ordinal !== null ? `（题号 ${s.ordinal}）` : ''} ${fmt(s.startByte)}..${fmt(s.endByte)} ${fmt(s.bytes)} B ${fmt(s.lines)} 行 ${s.sha256.slice(0, 16)}…  ${s.title.replace(/^#+\s*/, '').slice(0, 60)}`)
    }
    console.log('')
    console.log(`保留规则：${ruleText}`)
    console.log(`保留（进活动片）：${kept.length} 节 ${kept.map((s) => s.label).join(' ')} = ${fmt(kept.reduce((a, s) => a + s.bytes, 0))} B`)
    console.log(`归档：${archivedSections.length} 节 ⇒ 切成 ${shards.length} 片`)
    console.log('')
    console.log('归档片规划：')
    for (const sh of meta.shards) {
      console.log(`  ${sh.file}`)
      console.log(`    §${sh.fromLabel}–§${sh.toLabel} · 原始字节 ${fmt(sh.startByte)}..${fmt(sh.endByte)} · 正文 ${fmt(sh.bodyBytes)} B / ${fmt(sh.bodyLines)} 行 / ${sh.bodySha256}`)
      console.log(`    片头 ${fmt(sh.headerBytes)} B ⇒ 整片 ${fmt(sh.fileBytes)} B / ${fmt(sh.fileLines)} 行（整片 sha256 写出后实测，见 --apply / --verify 的输出）`)
      console.log(`    ${sh.fileBytes <= o.maxBytes ? `≤ ${fmt(o.maxBytes)} B ✓` : `⚠ 超过 ${fmt(o.maxBytes)} B（单节超限独占一片的情形）`}`)
    }
    console.log('')
    console.log(`活动片预测（渲染实测，非估算）：${fmt(activeBufNew.length)} B / ${fmt(countLines(activeBufNew))} 行 / ${sha(activeBufNew)}`)
    console.log(`  ${activeBufNew.length <= o.maxBytes ? `≤ ${fmt(o.maxBytes)} B ✓` : `⚠ 超过 ${fmt(o.maxBytes)} B —— 请调小 --keep-bytes / --keep-sections`}`)
    console.log('')
    // A（裁定 #28 补充-2）要的：活动片计划总字节数要能拆开看，索引行要给原文。
    // 构成账**不是**「总长 − 一串估算的段长」那种算法（那种算法会自己造出一个对不上、却看不出差在哪的黑洞：
    // 首版就因为「账按旧布局算、字节按新布局写」，凭空多出 2 B 且无法定位）。这里改用同一份分段清单：
    // `piecesOf` 与 `renderActive` 是同序同分隔符的两处代码，并在此处强制断言两者拼接逐字节相等。
    const pieces = piecesOf(plan, kept, buf)
    const joined = Buffer.from(pieces.map((p) => p.text).join(''), 'utf8')
    if (!joined.equals(activeBufNew)) {
      fail(EXIT.INCOMPLETE,
        `未能验证：分段账（piecesOf）拼起来与渲染结果（renderActive）不是同一串字节（长度 ${fmt(joined.length)} vs ${fmt(activeBufNew.length)}）。\n` +
        `   ⇒ 本工具的渲染 bug：账与字节必须出自同一套分段，否则 --plan 报的尺寸毫无意义。不写盘。`)
    }
    const cmSum = pieces.reduce((a, p) => a + bytesOf(p.text), 0)
    if (cmSum !== activeBufNew.length) {
      fail(EXIT.INCOMPLETE, `未能验证：活动片分段构成之和 ${fmt(cmSum)} ≠ 实测总长 ${fmt(activeBufNew.length)}（本工具的渲染 bug，不写盘）`)
    }
    for (const p of pieces) {
      console.log(`  ${String(fmt(bytesOf(p.text))).padStart(9)}  B  ${p.name}`)
    }
    console.log(`  ${String(fmt(activeBufNew.length)).padStart(9)}  B  合计（渲染实测，= 上列各项之和）`)
    console.log('')
    console.log('活动片里将要写入的索引行原文（复核时可拿它当预期值）：')
    for (const line of renderArchiveIndex(meta.shards, meta).split('\n')) {
      if (line.trim() !== '') console.log(`  | ${line}`)
    }
    console.log('')
    console.log('未改盘（--plan 是只读的）。要落盘请用 --apply。')
    if (process.env.BOARD_ROTATE_DUMP_RENDER) {
      // 排错用：把「--apply 将要写出的活动片」原样写到 stdout（stderr 才是报告），
      // 便于用 wc -c / sha256sum / head -c 这些外部读数独立核对本工具内部那套账。
      process.stdout.write(activeBufNew)
      process.stderr.write(`[dump] 已把活动片渲染结果写到 stdout：${fmt(activeBufNew.length)} B / ${sha(activeBufNew)}\n`)
    }
    process.exit(EXIT.PASS)
  }

  // ---- --apply
  // （existingMeta 已在上面「#29.5 续号」段解析过——再切判定与续号都依赖它，故不在此重复定义。）
  if (existingMeta && !o.force) {
    fail(EXIT.FAIL,
      `拒绝：${filePath} 已经含有 ${META_BEGIN} 元数据块（该片已轮换过）。\n` +
      `   ✓ 先跑 --verify 确认现状；确需再切请显式加 --force（本次不静默重切）。`)
  }
  const clash = meta.shards.filter((sh) => existsSync(path.join(archiveDir, path.basename(sh.file))))
  if (clash.length) {
    fail(EXIT.FAIL,
      `拒绝：目标归档片已存在，**归档片只增不改**（§4.13.2b-4），不覆盖：\n` +
      clash.map((sh) => `   - ${path.join(archiveDir, path.basename(sh.file))}`).join('\n'))
  }

  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true })
  // 裁定 #33 缺陷 B / #31-②：备份用**固定名**，同一源文件只留最近这一个。
  // 旧版用 `Date.now()` ⇒ 每次 `--apply` 落一个新文件（实测两次成功轮换留下 2 个备份，会无限累积）。
  // 「覆盖」只发生在 `--apply` 已通过全部写前检查、准备真正写盘之前，所以它不掩盖任何失败。
  const bakPath = `${filePath}.rotate-bak`
  const written = []
  let rolledBack = false
  const rollback = (why) => {
    for (const p of written) { try { rmSync(p, { force: true }) } catch { /* 尽力而为 */ } }
    try {
      if (existsSync(bakPath)) {
        const fd = openSync(bakPath, 'r')
        const orig = readFileSync(fd)
        closeSync(fd)
        const out = openSync(filePath, 'w')
        writeSync(out, orig)
        closeSync(out)
      }
    } catch { /* 尽力而为 */ }
    rolledBack = true
    fail(EXIT.FAIL, `--apply 失败并已回滚：${why}\n   已删除本次新写的归档片 ${written.length} 个；活动片已从备份恢复：${bakPath}`)
  }

  // 1) 备份原文件
  {
    const out = openSync(bakPath, 'w')
    writeSync(out, buf)
    closeSync(out)
  }
  // 2) 写归档片（此刻已确认均不存在）
  //
  // ⚠️ 片头**只能用收敛时留下的那一份文本**（`sh.headerText`），不得在这里重新渲染一次。
  // 曾经就是因为「这里重渲染一次、那里另渲染一次」，两份文本在自我引用的摘要字段上分了叉，
  // 于是写出去的字节与收敛时记下的摘要永不相等（自检拦住，但已属浪费一次写盘 + 回滚）。
  for (const sh of meta.shards) {
    const p = path.join(archiveDir, path.basename(sh.file))
    const body = buf.subarray(sh.startByte, sh.endByte)
    if (sh.headerText === undefined) {
      rollback(`内部不一致：归档片 ${sh.seq3} 没有收敛后的片头文本（本工具的 bug，拒绝写盘）`)
    }
    const content = Buffer.concat([Buffer.from(sh.headerText, 'utf8'), body])
    const out = openSync(p, 'w')
    writeSync(out, content)
    closeSync(out)
    written.push(p)
    // 写后自检（这里的三条**都不涉及自指**，所以是真正独立的对拍）：
    if (content.length !== sh.fileBytes) {
      rollback(`归档片 ${p} 写出后长度与预测不等（预测 ${fmt(sh.fileBytes)} B，实得 ${fmt(content.length)} B）`)
    }
    if (content.subarray(sh.headerBytes).length !== sh.bodyBytes || sha(content.subarray(sh.headerBytes)) !== sh.bodySha256) {
      rollback(`归档片 ${p} 剥离片头后与正文摘要不等（headerBytes=${sh.headerBytes}）`)
    }
    // 整片摘要：**只能在这里实测**（片头里没有它，所以它不是自指），记下来供活动片索引使用。
    sh.fileSha256 = sha(content)
    if (sh.fileSha256 !== sha(readFileSync(p))) {
      rollback(`归档片 ${p} 回读后的 sha256 与内存中的字节不等（写盘未落定）`)
    }
  }
  // 3) 写活动片
  //
  // ⚠️ 活动片的字节**必须在归档片实测出整片 sha256 之后**才渲染：活动片里的归档索引要写
  // 每片的整片 sha256，而那个值是上一步从盘上实测的。曾经把渲染写在写归档片之前，于是索引里
  // 印的是「渲染那一刻还不存在的值」（旧版直接印 undefined，新版印的是渲染前的占位）。
  // 所以这里**重新渲染**一次（覆盖上面那个含占位符的版本），并把它的 sha256 与写盘内容逐字节对拍。
  //
  // 关键不变量：占位符与实测值都是 64 个十六进制字符 ⇒ 重新渲染**不改变任何字节长度**，
  // 上面算好的保留区间偏移（activeStartByte/activeEndByte）依然成立。下面这条断言就是守这个不变量的。
  const activeBufPlan = activeBufNew
  // ⚠️ 这一步**不是**可有可无的：上面刚把每片的**实测**整片 sha256 填进 `sh.fileSha256`，
  // 而活动片的归档索引里那一列就是印它的 ⇒ 索引字节变了、台账里的 `newGenIndexSha256` 必须重算。
  // 不重算就会：台账记的是「占位符版索引」的 sha，盘上写的是「实测值版索引」的字节 ⇒
  // `--verify` 第 ④ 条报「活动片里归档索引段 sha256 与台账不等」（实测踩过，两处 sha 差 30 字节的摘要）。
  // 片 sha 是 64 个十六进制字符、占位符也是 64 个 ⇒ **长度不变**，故偏移不变量不受影响。
  stampCurrentGeneration(activeBufNew.toString('utf8'), meta.shards.map((x) => x.fileSha256))
  activeBufNew = Buffer.from(renderActive(plan, kept, buf), 'utf8')
    if (activeBufNew.length !== activeBufPlan.length) {
    rollback(`重新渲染活动片后长度变了（${fmt(activeBufPlan.length)} → ${fmt(activeBufNew.length)} B）：整片摘要占位符与实测值不等长，保留区间偏移已失效`)
  }
  {
    const out = openSync(filePath, 'w')
    writeSync(out, activeBufNew)
    closeSync(out)
  }
  if (sha(readFileSync(filePath)) !== sha(activeBufNew)) rollback('活动片写出后指纹与预测不等')

  // 4) 写后自动校验（与 --verify 同一套代码）
  // 把**源缓冲区 `buf`** 一并传进去：第 ④ 条要按「该代源文件」的坐标切片，而源文件此刻已被覆盖。
  const v = verifyAll({ meta, activeBuf: readFileSync(filePath), activePath: filePath, archiveDir, sourceBuf: buf })
  console.log('board 分片轮换（board-rotate.mjs --apply）')
  console.log(`分片：${filePath}`)
  // 裁定 #29.6：备份路径必须**显著**打印（它是安全冗余，不是垃圾）。
  // 同时说清它落在哪：源文件同目录的 `${filePath}.rotate-bak`（**固定名**，裁定 #33 缺陷 B），
  // **不在 archive/ 里**（archive/ 只放归档片，混进备份会让「归档片只增不改」的目录变得不可解释）。
  // 裁定 #33 缺陷 B 追加：必须打印备份的 **sha256 与字节数** —— 名字固定之后，
  // 「这个备份到底是哪一份」不能再靠文件名回答，只能靠指纹回答。
  const bakBytesForReport = readFileSync(bakPath)
  console.log('')
  console.log('════════════════════════════════════════════════════════════════')
  console.log(`⚠ 备份（安全冗余，**确认无损后再删**）：`)
  console.log(`    ${bakPath}`)
  console.log(`    备份指纹：sha256 ${sha(bakBytesForReport)} · ${fmt(bakBytesForReport.length)} B`)
  console.log(`    位置说明：与源文件同目录，*不*在 archive/ 里；本工具不会自动删除它。`)
  console.log(`    命名说明：固定名（同源只留最近一个）⇒ 要区分「哪一份」请看上面的 sha256。`)
  console.log(`    用途：若后续发现本次轮换有误，用它能逐字节还原轮换前的活动片。`)
  console.log('════════════════════════════════════════════════════════════════')
  console.log('')
  console.log(`已写归档片 ${written.length} 个：`)
  for (const p of written) console.log(`  ${p} = ${fmt(statSync(p).size)} B / ${fmt(countLines(readFileSync(p)))} 行 / ${sha(readFileSync(p))}`)
  console.log('')
  console.log(`已重写活动片：${fmt(activeBufNew.length)} B / ${fmt(countLines(activeBufNew))} 行 / ${sha(activeBufNew)}`)
  console.log('')
  for (const l of v.lines) console.log(l)
  console.log('')
  if (v.ok) {
    // 裁定 #33-②：同 `--verify` —— 汇总行必须与同一份输出里的 `[不可再验]` 一致。
    const nGen = Array.isArray(meta.generations) ? meta.generations.length : 0
    const st = v.stat || { ident1Checked: 0, ident2FullChecked: 0, unverifiable: [] }
    if (st.unverifiable.length) {
      console.log(`✓ 写后校验：可核部分全部相等；${st.unverifiable.length} 项不可再验 ⇒ 无损**部分**成立（EXIT=0）`)
      console.log(`    已核：恒等式㈠ ${st.ident1Checked} / ${nGen} 代 · 恒等式㈡ 整串对拍 ${st.ident2FullChecked} / ${nGen} 代`)
      for (const u of st.unverifiable) console.log(`    [不可再验] ${u}`)
      console.log(`    ⚠ 本行**不构成**「全片无损已证」。`)
    } else {
      console.log(`✓ 写后校验全部相等 ⇒ 无损成立（EXIT=0）（恒等式㈠ ${st.ident1Checked} / ${nGen} 代 · 恒等式㈡ 整串 ${st.ident2FullChecked} / ${nGen} 代${nGen === 1 ? '；本片只轮换过 1 次 ⇒ 没有可交叉印证的前代' : ''}）`)
    }
    process.exit(EXIT.PASS)
  }
  console.log(`✗ 写后校验未通过（将回滚）：共 ${v.failures.length} 项`)
  for (const f of v.failures) console.log(`   - ${f}`)
  rollback(`写后校验 ${v.failures.length} 项不等`)
  if (!rolledBack) process.exit(EXIT.FAIL)
}

main()
