#!/usr/bin/env node
/**
 * §0 内容锚门（anchor.contract.selftest.mjs）
 *
 * 守的是什么：`docs/agents/integration-contracts.md` §0 登记的 14 条内容锚
 * （被引文件 SHA256）。锚是**契约表的唯一机器判据**（表头 L13：行号不得作为判据）。
 * 被引文件一旦变动，表里对应的行号/引用就可能静默失效——本门把这个"静默"变成会红。
 *
 * 本门**只读**契约表的 §0 段并重算哈希，**不复制任何锚值到本文件**：
 * 唯一真源是契约表本身，复制一份就等于造出第二个真源（派发明令禁止）。
 *
 * 本门**不校验行号**——这是刻意的边界，不是遗漏：
 *   · 锚绿 ≠ 行号正确。"文件未变而行号指向邻近但无关的行"（off-by-N）是已知不可机检类；
 *     把它塞进本门＝把不可机检类伪装成可机检（§5 末条对 L1c 的同类要求），判为回归。
 *   · 因此"行号被改错、文件未变"这一情形，本门**必须保持 EXIT=0**（见回报的负向测试 ③）。
 *
 * 判据只有哈希。表里的字节数**仅作诊断输出**：它与哈希同源读取（同一个文件），
 * 不构成第二个独立来源（§10.2-6「独立＝方法独立」），故不参与通过/失败判定。
 *
 * 退出码（沿用 verify.mjs 约定）：
 *   0  = 全部锚 MATCH
 *   1  = 有锚 DIFF / 有被锚文件缺失 / §0 解析不到任何锚（门无法执行，不得读作通过）
 *   2  = 未完成验证：锚表本身不存在或不可读（前置条件不成立，与"通过"不同形）
 *   64 = 用法错误
 *
 * 用法：
 *   node scripts/anchor.contract.selftest.mjs
 *   node scripts/anchor.contract.selftest.mjs --anchor-file <path> --root <dir>
 *     两个开关就是为"负向测试不写他人文件"准备的：把门指向临时副本树即可。
 *     相对路径均按 --root 解析（默认 = 仓库根）。
 *
 * 仪器约定（§5 新禁则）：读文本一律 Node `fs.readFileSync(p, 'utf8')`，哈希一律 `node:crypto`。
 * **不使用 `Get-Content`**（PS 5.1 默认 GBK 解码会毁掉中文与行数），也不调用任何子进程
 * （沙箱下带管道 stdio 的 spawn 会 EPERM；本门无此需要）。
 *
 * 依赖注入痕迹：本文件**未复用** verify.mjs 的 runner（无子进程、无临时日志目录），
 * 只在退出码口径与它的 EXIT 常量语义上保持一致。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ANCHOR_DEFAULT_REL = 'docs/agents/integration-contracts.md'
const EXIT = { PASS: 0, FAIL: 1, INCOMPLETE: 2, USAGE: 64 }

const FRICTION_NOTICE = '若这是合法改动，请通知 Tech Lead 重核并重落锚，不要自己改 §0。'

// ------------------------------------------------------------------ 用法
function usage() {
  console.error(`用法：node scripts/anchor.contract.selftest.mjs [--anchor-file <path>] [--root <dir>]`)
  console.error(`  --anchor-file <path>  锚表路径，默认 ${ANCHOR_DEFAULT_REL}（相对 --root 解析）`)
  console.error(`  --root <dir>          相对路径的解析根，默认仓库根`)
}

const argv = process.argv.slice(2)
let root = ROOT_DEFAULT
let anchorArg = ANCHOR_DEFAULT_REL
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--root') {
    if (!argv[i + 1]) { usage(); process.exit(EXIT.USAGE) }
    root = path.resolve(argv[i + 1]); i += 1
  } else if (a === '--anchor-file') {
    if (!argv[i + 1]) { usage(); process.exit(EXIT.USAGE) }
    anchorArg = argv[i + 1]; i += 1
  } else if (a === '--help' || a === '-h') {
    usage(); process.exit(EXIT.PASS)
  } else {
    console.error(`未知参数 ${a}`)
    usage(); process.exit(EXIT.USAGE)
  }
}
const anchorPath = path.isAbsolute(anchorArg) ? anchorArg : path.join(root, anchorArg)

// ------------------------------------------------------------------ 解析 §0
/**
 * 从锚表文本里抽出 §0 的锚条。只认 §0 段、只认「`路径` | `64位十六进制` | 字节」三列行。
 * @returns {null|Array<{file:string,hash:string,bytes:number|null}>} null = 找不到 §0 段
 */
function parseAnchors(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s*0\.\s*内容锚/.test(l))
  if (start < 0) return null
  const rows = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+\S/.test(lines[i])) break // 进入下一节
    const cells = lines[i].split('|').map((s) => s.trim())
    if (cells.length < 5) continue
    const p = /^`([^`]+)`$/.exec(cells[1])
    const h = /^`([0-9A-Fa-f]{64})`$/.exec(cells[2])
    if (!p || !h) continue
    rows.push({ file: p[1], hash: h[1].toUpperCase(), bytes: /^\d+$/.test(cells[3]) ? Number(cells[3]) : null })
  }
  return rows
}

function sha256File(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex').toUpperCase()
}

const short = (h) => `${h.slice(0, 8)}…${h.slice(-8)}`

// ------------------------------------------------------------------ 主流程
console.log('契约表 §0 内容锚门（anchor.contract.selftest.mjs）')
console.log(`解析根（--root）：${root}`)
console.log(`锚表（--anchor-file）：${anchorPath}`)
console.log('')

if (!existsSync(anchorPath) || !statSync(anchorPath).isFile()) {
  console.error(`未完成验证：锚表不存在或不是文件 —— ${anchorPath}`)
  process.exit(EXIT.INCOMPLETE)
}

let rows
try {
  rows = parseAnchors(readFileSync(anchorPath, 'utf8'))
} catch (e) {
  console.error(`未完成验证：锚表不可读 —— ${anchorPath}（${e.message}）`)
  process.exit(EXIT.INCOMPLETE)
}
if (rows === null) {
  console.error('§0 段未找到（期望形如 `## 0. 内容锚`）——门无法执行，不得读作通过。')
  process.exit(EXIT.FAIL)
}
if (rows.length === 0) {
  console.error('§0 解析到 0 条锚——门无法执行，不得读作通过（空门＝假绿）。')
  process.exit(EXIT.FAIL)
}

const failures = []
let matched = 0
for (const row of rows) {
  const abs = path.resolve(root, row.file)
  const insideRoot = abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  if (!insideRoot) {
    failures.push(`${row.file}：解析后落在 --root 之外（${abs}）——拒绝读取`)
    console.log(`OUTSIDE ${row.file}  → ${abs}`)
    continue
  }
  if (!existsSync(abs)) {
    failures.push(`${row.file}：锚表中列出，但盘上不存在`)
    console.log(`MISSING ${row.file}`)
    continue
  }
  const actual = sha256File(abs)
  const actualBytes = statSync(abs).size
  const bytesNote = row.bytes === null ? '' : `（表登记 ${row.bytes} B；实测 ${actualBytes} B — 诊断用，不作判据）`
  if (actual === row.hash) {
    matched += 1
    console.log(`MATCH   ${row.file.padEnd(26)} ${short(actual)}  ${actualBytes} B`)
  } else {
    failures.push(`${row.file}：锚不符（表 ${short(row.hash)} / 实 ${short(actual)}）`)
    console.log(`DIFF    ${row.file.padEnd(26)} 表 ${short(row.hash)} / 实 ${short(actual)} ${bytesNote}`)
  }
}

console.log('')
console.log(`锚条数 ${rows.length}：MATCH ${matched}，失败 ${failures.length}`)

if (failures.length > 0) {
  console.error('')
  console.error(`锚门失败 ${failures.length} 项：`)
  for (const f of failures) console.error(`  - ${f}`)
  console.error('')
  console.error(FRICTION_NOTICE)
  process.exit(EXIT.FAIL)
}

console.log(`§0 内容锚全部 MATCH（${matched}/${rows.length}）。`)
console.log('注：锚绿 ≠ 行号正确。off-by-N（文件未变而行号指向邻近但无关的行）不在本门判据内。')
console.log(`临时物：本门未产生任何文件；os.tmpdir() 仅用于其自身解析，无副本落地（${os.tmpdir()}）`)
process.exit(EXIT.PASS)
