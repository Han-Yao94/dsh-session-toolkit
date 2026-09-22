#!/usr/bin/env node
/**
 * 门：`@deepseek-ai/dsh-client-ui-primitives` 的「导出名面」。
 *
 * 判据（A 定的，见 `docs/agents/integration-contracts.md` §B 那一行 + §D.9）：
 *   插件从 `client/client.js` 引用的**每一个** `primitives.<Name>`，必须真的存在于
 *   已装 harness 的 `packages/client/ui-primitives/lib/index.js` 的导出名集合里。
 *   缺任一 ⇒ exit 1，并逐行列出「缺哪个名字 + 它在 client/client.js 的行号」。
 *
 * 为什么要有这道门（2026-09-22，人类所有者报的障）：
 *   harness `4937343a5e`（feat(web): unify the client visual language，2026-09-17）把图标名
 *   从 `IconXxxOutline<尺寸数>` 改成 `IconXxxOutline{Regular|Medium}`。7 个旧名字一夜之间
 *   求值为 `undefined` ⇒ `React.createElement(undefined, …)` 抛错 ⇒ 该组件子树渲染失败
 *   ⇒ **设置页内容区整片空白**（左导航行照常出现：注册与渲染是两件事）。
 *   **它穿透了当时全部的门**：语法门绿、打包门绿、锚门绿、四条契约门全绿——因为本表此前的
 *   client 侧行只覆盖 slots / configForms / locale / sessionLogDownload，没有一行覆盖
 *   「primitives 的导出名面」。本门就是补这一格。
 *
 * ⚠️ 为什么用文本解析取导出面、而不 `import` 那个包（**实测**）：
 *   `node --input-type=module -e 'await import(<harness>/packages/client/ui-primitives/lib/index.js)'`
 *   ⇒ `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".css" for …/StateDot.module.css`
 *   （该 index.js 里共 33 处 `from "./X.module.css"`）⇒ 门里绝不能 import 它。
 *
 * 不挂 CI：与 `dependency-skew.measure.mjs` / `dsh-log-ui.drift.mjs` 同类——都需要外部
 * harness 输入，挂上去只会得到「未完成验证」的假红（契约 §D 第 10 条）。
 *
 * 用法：node scripts/primitives-export.assert.mjs --harness <deepseek-harness 路径>
 *       node scripts/primitives-export.assert.mjs --harness <…> --selftest
 *       node scripts/primitives-export.assert.mjs --harness <…> --file <待核的 client.js>
 *
 * 退出码（§5.2 口径）：
 *   0  通过
 *   1  缺陷：有成员在导出面里不存在
 *   64 用法/前置错误（缺 --harness、路径不对、文件读不到、解析不出导出面）
 *   ⚠️ **刻意不用 2**（2 = 「未完成验证」，不是「有缺陷」）。前置条件也为 64，
 *      且**必须带说明**——不许糊成 1 而不说是什么坏了。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXIT = { PASS: 0, FAIL: 1, USAGE: 64 }

/** 待核文件（相对仓库根解析）。 */
const DEFAULT_TARGET = 'client/client.js'
/** 导出面所在的包内路径（相对 harness 根）。 */
const PRIMITIVES_REL = 'packages/client/ui-primitives/lib/index.js'

function usage(out = console.error) {
  out('用法：node scripts/primitives-export.assert.mjs --harness <deepseek-harness 路径> [--selftest] [--file <path>]')
  out('')
  out('  --harness <path>  deepseek-harness 仓库根（必填；本门要读它已装的 ui-primitives 导出面）')
  out('  --file <path>     待核文件，默认 client/client.js（相对仓库根解析）')
  out('  --selftest        造两份变异副本，自证本门会报红（工作区零写入）')
  out('  --help            打印本帮助')
  out('')
  out(`退出码：0 通过 · 1 缺陷（成员在导出面里不存在）· 64 用法/前置错误（刻意不用 2）`)
}

/**
 * 取 primitives 包的导出名集合。
 * 只认**顶层** `export { … }`（该文件末尾有一条），用花括号配平截取——不 import。
 * 先剥行注释与块注释，避免把注释里的名字算进来。
 * @param {string} pkgFile
 * @returns {{names:Set<string>, raw:string}|null} null = 解析不出（调用方按前置错误处置）
 */
function readExports(pkgFile) {
  let src
  try {
    src = readFileSync(pkgFile, 'utf8')
  } catch {
    return null
  }
  // 剥注释（本文件里没有字符串内含 /**/ 的情形；谨慎起见块注释再单独处理一次）
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '')
  const names = new Set()
  const re = /(^|\n)\s*export\s*\{/g
  let m
  let found = 0
  while ((m = re.exec(clean)) !== null) {
    // 花括号配平截取
    let i = clean.indexOf('{', m.index)
    let depth = 0
    let end = -1
    for (let j = i; j < clean.length; j++) {
      if (clean[j] === '{') depth++
      else if (clean[j] === '}') {
        depth--
        if (depth === 0) { end = j; break }
      }
    }
    if (end < 0) continue
    found++
    const body = clean.slice(i + 1, end)
    for (const part of body.split(',')) {
      const t = part.trim()
      if (!t) continue
      // 只取真实名字：`A` / `A as B`。门关心的是**导出名**，故取 `B`（别名右侧）。
      const asM = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
      if (asM) { names.add(asM[2]); continue }
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t)
    }
  }
  if (found === 0 || names.size === 0) return null
  return { names, raw: clean }
}

/**
 * 从待核文件里抓出所有 `primitives.<Name>` 的成员名（去重），并留下行号。
 * **不是白名单、不是硬编码列表**——从代码里抓，否则新增图标时本门会漏。
 * 已知取舍（刻意保守）：不剥字符串字面量里的 `primitives.X`；若真出现在字符串里，
 * 报出来比漏掉好（漏掉 = 门不成立）。
 * @param {string} src
 * @returns {Map<string, number[]>} 成员名 → 出现行号（升序，1 起）
 */
function extractMembers(src) {
  const lines = src.split(/\r?\n/)
  /** @type {Map<string, number[]>} */
  const out = new Map()
  const re = /\bprimitives\s*\.\s*([A-Za-z_$][\w$]*)/g
  for (let i = 0; i < lines.length; i++) {
    let m
    re.lastIndex = 0
    while ((m = re.exec(lines[i])) !== null) {
      const name = m[1]
      if (!out.has(name)) out.set(name, [])
      const arr = out.get(name)
      if (arr[arr.length - 1] !== i + 1) arr.push(i + 1)
    }
  }
  return out
}

/**
 * 判定并按 §5.2 口径打印逐条结论。
 * @returns {{missing:string[], present:string[]}}
 */
function judge(label, src, exportSet) {
  const members = extractMembers(src)
  const missing = []
  const present = []
  for (const name of [...members.keys()].sort()) {
    if (exportSet.has(name)) present.push(name)
    else missing.push(name)
  }
  console.log(`  成员数（去重）：${members.size} · 命中导出面：${present.length} · **缺**：${missing.length}`)
  if (missing.length > 0) {
    console.log('  缺失成员（名字 + 在待核文件里的行号）：')
    for (const name of missing) {
      console.log(`    - primitives.${name}  @${members.get(name).join(',')}`)
    }
  }
  console.log(`  ${missing.length === 0 ? 'PASS' : 'FAIL'} [${label}]`)
  return { missing, present }
}

// ------------------------------------------------------------------ 参数
const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  usage(console.log)
  process.exit(EXIT.PASS)
}

let harness = null
let targetArg = null
let selftest = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--harness') { harness = argv[++i] }
  else if (a === '--file') { targetArg = argv[++i] }
  else if (a === '--selftest') { selftest = true }
  else {
    console.error(`未知参数：${a}`)
    usage()
    process.exit(EXIT.USAGE)
  }
}

if (!harness) {
  console.error('❌ 缺 `--harness <deepseek-harness 路径>`。')
  console.error('   本门要读已装 harness 的 ui-primitives 导出面；没有它 = 门不会失败 = 等于没有门，故不静默跳过。')
  console.error('')
  usage()
  process.exit(EXIT.USAGE)
}
harness = path.resolve(harness)
if (!existsSync(harness) || !existsSync(path.join(harness, 'packages'))) {
  console.error(`❌ \`--harness\` 指向的路径不是 harness 仓库根：${harness}`)
  console.error(`   实测：${existsSync(harness) ? '目录存在但缺少 packages/' : '路径不存在'}`)
  process.exit(EXIT.USAGE)
}
const pkgFile = path.join(harness, PRIMITIVES_REL)
if (!existsSync(pkgFile)) {
  console.error(`❌ 在 harness 里找不到导出面文件：${pkgFile}`)
  console.error('   前置条件不满足（不是「有缺陷」）⇒ 按 §5.2 走 64，不走 1。')
  process.exit(EXIT.USAGE)
}
const exportInfo = readExports(pkgFile)
if (!exportInfo) {
  console.error(`❌ 无法从 ${pkgFile} 解析出导出名集合（找不到顶层 \`export { … }\`）。`)
  console.error('   前置条件不满足 ⇒ 按 §5.2 走 64，不走 1。**不要当作通过。**')
  process.exit(EXIT.USAGE)
}

const target = targetArg ? path.resolve(ROOT, targetArg) : path.join(ROOT, DEFAULT_TARGET)
const targetRel = path.relative(ROOT, target) || target
if (!existsSync(target)) {
  console.error(`❌ 待核文件不存在：${target}`)
  console.error(`   （--file 缺省时按仓库根解析，当前仓库根：${ROOT}）`)
  process.exit(EXIT.USAGE)
}
const src = readFileSync(target, 'utf8')

console.log('「primitives 导出名面」门（primitives-export.assert.mjs）')
console.log(`  仓库根      ${ROOT}`)
console.log(`  harness     ${harness}`)
console.log(`  导出面      ${PRIMITIVES_REL}（${exportInfo.names.size} 个导出名·文本解析，未 import）`)
console.log(`  待核文件    ${targetRel}`)
console.log('')

// ------------------------------------------------------------------ 正向
console.log('=== 正向（真实文件）===')
const base = judge(targetRel, src, exportInfo.names)
console.log('')

let bad = base.missing.length > 0

// ------------------------------------------------------------------ 自证（负向对照）
if (selftest) {
  const ANON = 'primitives.IconNoSuchThing16'
  const TMP = mkdtempSync(path.join(os.tmpdir(), 'dsh-st-primsexp-'))
  console.log('=== 自证：两份变异副本，必须各自报红 ===')
  const results = []

  const cases = [
    ['M1 注入一个确定不存在的成员（IconNoSuchThing16）', () => {
      const needle = '    return React.createElement(primitives.DisclosureRow, {'
      const hits = src.split(needle).length - 1
      if (hits !== 1) throw new Error(`锚点命中 ${hits} 次（需恰好 1）⇒ 变异未生效`)
      // 注入一行真调用形态
      return src.replace(needle, `    React.createElement(primitives.IconNoSuchThing16, { size: 16 });\n${needle}`)
    }],
    ['M2 把新名改回旧名（IconGlobeOutlineRegular → IconGlobeOutline14）——直接复现本次事故', () => {
      const from = 'primitives.IconGlobeOutlineRegular'
      const to = 'primitives.IconGlobeOutline14'
      const hits = src.split(from).length - 1
      if (hits === 0) throw new Error(`锚点 ${from} 命中 0 次 ⇒ 该名字当前已不在文件里（C 可能已改），变异无意义`)
      // ① 先自证锚点本身在**原始**文件里是"存在的成员"（否则这条对照是空的）
      if (!exportInfo.names.has('IconGlobeOutlineRegular')) throw new Error('IconGlobeOutlineRegular 不在导出面里 ⇒ 该变异无法演示"存在→不存在"')
      const out = src.split(from).join(to)
      const after = out.split(to).length - 1
      if (after !== hits) throw new Error(`替换后 ${to} 命中 ${after} 次，与替换前 ${hits} 不一致`)
      return out
    }],
  ]

  for (const [label, make] of cases) {
    let mutated
    try {
      mutated = make()
    } catch (e) {
      console.error(`  变异「${label}」构造失败：${e.message}`)
      results.push({ label, ok: false, why: '构造失败' })
      continue
    }
    if (mutated === src) {
      console.error(`  变异「${label}」未改变源码 ⇒ 自测无意义`)
      results.push({ label, ok: false, why: '未生效' })
      continue
    }
    const copyRoot = path.join(TMP, label.slice(0, 2))
    const f = path.join(copyRoot, DEFAULT_TARGET)
    mkdirSync(path.dirname(f), { recursive: true })
    writeFileSync(f, mutated)
    console.log(`=== ${label}（副本 ${path.relative(os.tmpdir(), f)}，必须报红）===`)
    const r = judge(path.join(label.slice(0, 2), DEFAULT_TARGET), readFileSync(f, 'utf8'), exportInfo.names)
    console.log('')
    results.push({ label, ok: r.missing.length > 0, why: r.missing.join(',') || '未报红' })
  }

  const passRed = results.filter((r) => r.ok).length
  console.log('--- 自证汇总 ---')
  console.log(`  基线（真实文件）绿：${base.missing.length === 0}`)
  console.log(`  两个变异体报红数：${passRed}/${results.length}`)
  for (const r of results) {
    console.log(`    ${r.ok ? 'ok  ' : 'FAIL'} ${r.label} ⇒ ${r.ok ? '报红（缺 ' + r.why + '）' : '未报红：' + r.why}`)
  }
  rmSync(TMP, { recursive: true, force: true })
  console.log('  （临时副本已删；工作区零写入）')
  console.log('')
  if (passRed !== results.length) {
    console.error('❌ 自证未通过：有变异体没报红 ⇒ 本门在那类破坏形态下不可靠。')
    process.exit(EXIT.FAIL)
  }
  console.log('本门成立：两个变异体各自报红。')
  console.log('')
  // 自证模式下，最终退出码仍以**基线**为准
  if (bad) {
    console.log(`❌ 基线报红：${base.missing.length} 个成员不在导出面里（见上）。`)
    process.exit(EXIT.FAIL)
  }
  console.log('✅ 基线绿（客户端引用的每个 primitives.X 都在导出面里）。')
  process.exit(EXIT.PASS)
}

if (bad) {
  console.log(`❌ ${base.missing.length} 个成员不在导出面里：${base.missing.map((n) => 'primitives.' + n).join(' · ')}`)
  console.log('   这正是「设置页整片空白」的形态：React.createElement(undefined, …) 抛错 ⇒ 子树渲染失败。')
  console.log('   修法：把这些名字改成 harness 当前导出面里的名字（图标多为 IconXxxOutlineRegular / …Medium）。')
  process.exit(EXIT.FAIL)
}
console.log('✅ 通过：客户端引用的每个 primitives.X 都在已装 harness 的导出面里。')
process.exit(EXIT.PASS)
