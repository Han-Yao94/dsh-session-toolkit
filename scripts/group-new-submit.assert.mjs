#!/usr/bin/env node
// 新建组「提交路径」判据门（A 派发 #77-D-1；真源 docs/agents/board/a.md §228.3 改动契约 + §228.4 验收判据 A1–A4）。
//
// 人类所有者原话（§228.1，逐字）：「输入组名后按回车键会直接创建组，这个需要调整，不能回车直接创建，要点击新建组按钮才能创建」
// ⇒ 唯一合法的提交路径 = 同卡片里那个主色按钮的 onClick；键盘路径必须不存在。
//
// 判据对象：`client/client.js` 里 `ClassName: 'dsw-group-new-input'` 那个 input 元素的 **props 原文**
//          （从 `React.createElement(<tag>, {` 到与之配平的 `}`），以及同卡片按钮元素的 props、
//          另三处键盘路径的**逐字原文**。判据一律**不依赖行号**（行号会漂），只用结构/文本模式。
//
// 退出码：0 = 全部判据成立 · 1 = 有判据不成立（缺陷）· 2 = 装置没跑成（不是缺陷）· 64 = 用法错。
//
// ── 本门能证明什么 ────────────────────────────────────────────────────────────
//   只证明「源码文本层面：该 input 没有键盘提交路径、按钮仍是唯一提交路径、另三处键盘路径逐字未动」。
//   每条判据都能红、能定位到具体元素与具体子串。
// ── 本门不能证明什么（边界，不得读作通过）───────────────────────────────────
//   1) **不能证明运行期行为**：本门不渲染、不派发事件。「回车真的建不出组」只有人类真机确认。
//   2) 不证明输入法（IME）组合态行为；`e.isComposing` 是否该判不在本门判据内。
//   3) 不证明 `addGroup` 自身的语义（空名/重名拦截、错误提示、创建后清空）—— 那是 C 的另一组契约。
//   4) 只认 `dsw-group-new-input` 这一个 className 定位的元素；className 改名即判据对象失联（报 C1 红）。
//
// ── 自保 ──────────────────────────────────────────────────────────────────────
//   ① 每条判据配一次「负向对照」（`--selftest`）：把违例注入临时副本 ⇒ 该判据**必须报红**；
//      报不出红即说明这条判据不会失败（= 没有检查），本门自证失败退出 2。
//   ② 变异未生效即判失败：注入前后源码逐字节相同、或锚点命中数 ≠ 期望 ⇒ 报「对照无效」，绝不当成“通过”。
//   ③ 未点名判据不得被连带翻转：变异只许让它点名的那条翻红，其余必须保持原判。
//   ④ 观测装置自证：主判据对象（input、按钮）必须被解析到且唯一，否则退出 2（防止“恒 0 命中”被读成通过）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const EXIT = { PASS: 0, FAIL: 1, DEVICE: 2, USAGE: 64 }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET_REL = 'client/client.js'
const INPUT_CLASS = 'dsw-group-new-input'
const BTN_SCOPE_CLASS = 'dsw-groups-head-card' // 按钮所在卡片（作用域锚）
const BTN_TAG = 'primitives.Button'            // 卡片内的主色按钮
const BTN_WHAT = '主色按钮（primitives.Button）'
const CREATE_FN = 'addGroup'

const INVOKED_AS = path.basename(process.argv[1] || '')
// 入口守卫：只在「本文件被当脚本直接执行」时生效（`import.meta.main`）。
// 这样 `import` 本文件取导出函数做独立探针时，不会误报「装置未跑成」。
function guardInvokedAs() {
  if (!import.meta.main) return
  if (!INVOKED_AS.endsWith('group-new-submit.assert.mjs')) {
    console.error('装置未跑成：本脚本必须以 group-new-submit.assert.mjs 之名被调用（现为 ' + INVOKED_AS + '）')
    process.exit(EXIT.DEVICE)
  }
}
// ⚠ 这一行曾经**漏掉**：守卫只有函数定义、没有任何调用点 ⇒ 把脚本拷成别的名字照样 PASS/EXIT 0，
//    守卫形同不存在（实测：`scripts/renamed-gate-probe.mjs` 全绿）。负向对照见自检 ⑪。
guardInvokedAs()

// ── 参数 ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
function usage(out) {
  out('用法：')
  out('  node scripts/group-new-submit.assert.mjs                 基线判据（对现盘 ' + TARGET_REL + '）')
  out('  node scripts/group-new-submit.assert.mjs --selftest      逐条负向对照（注入违例，必须报红）')
  out('  node scripts/group-new-submit.assert.mjs --source <f>    指定被测源码（供自证/调试）')
  out('  node scripts/group-new-submit.assert.mjs --probe         只打印观测面原始读数')
  out('  node scripts/group-new-submit.assert.mjs --help')
}
let sourcePath = null
let selftest = false
let probe = false
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--help' || a === '-h') { usage((s) => console.log(s)); process.exit(EXIT.PASS) }
  else if (a === '--selftest') selftest = true
  else if (a === '--probe') probe = true
  else if (a === '--source') {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) { console.error('用法错：--source 需要一个路径'); process.exit(EXIT.USAGE) }
    sourcePath = v
    i += 1
  } else { console.error('用法错：不认识的参数 ' + a); usage((s) => console.error(s)); process.exit(EXIT.USAGE) }
}

function deviceFail(msg) {
  console.error('未能评测（装置没跑成，不是缺陷）：' + msg)
  process.exit(EXIT.DEVICE)
}

// ── 观测装置 ──────────────────────────────────────────────────────────────────
// 与兄弟门（session-picker / settings-layout）同一套括号配平口径：跳过字符串与注释。
export function matchBrace(src, open) {
  if (src[open] !== '{') return -1
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      i += 1
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1 }
      continue
    }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 1; continue }
    if (c === '{') depth += 1
    else if (c === '}') { depth -= 1; if (depth === 0) return i }
  }
  return -1
}

/** `ClassName: 'X'` / `className: "X"` 的两种书写都要认。 */
function classNameForms(cls) { return [`className: '${cls}'`, 'className: "' + cls + '"'] }

/** 抽 `React.createElement(<tag>, { … })` 的 props 原文（含外层花括号），按 className 定位；要求唯一。 */
export function findElementByClass(src, cls) {
  const forms = classNameForms(cls)
  const hits = []
  for (const form of forms) {
    let at = src.indexOf(form)
    while (at !== -1) { hits.push(at); at = src.indexOf(form, at + 1) }
  }
  if (hits.length === 0) return { ok: false, err: `className \`${cls}\` 一处都没命中（判据对象失联）` }
  if (hits.length > 1) return { ok: false, err: `className \`${cls}\` 命中 ${hits.length} 处（判据对象歧义：${hits.map((h) => src.slice(0, h).split('\n').length).join(', ')} 行）` }
  const pos = hits[0]
  // 向左找最近的 `React.createElement(<tag>,`，其 `{` 即 props 起点
  const left = src.lastIndexOf('React.createElement(', pos)
  if (left === -1) return { ok: false, err: `\`${cls}\` 左侧找不到 React.createElement(` }
  const comma = src.indexOf(',', left + 'React.createElement('.length)
  if (comma === -1 || comma > pos) return { ok: false, err: `\`${cls}\` 所在元素的参数表异常（找不到 tag 后的逗号）` }
  const openBrace = (function () {
    for (let i = comma; i < pos; i += 1) if (src[i] === '{') return i
    return -1
  })()
  if (openBrace === -1) return { ok: false, err: `\`${cls}\` 所在元素找不到 props 的 \`{\`` }
  const close = matchBrace(src, openBrace)
  if (close === -1) return { ok: false, err: `\`${cls}\` 所在元素的 props 花括号不配平` }
  const tag = src.slice(left + 'React.createElement('.length, comma).trim()
  return { ok: true, at: pos, line: src.slice(0, pos).split('\n').length, tag, props: src.slice(openBrace + 1, close) }
}

/** 逐字子串锚点；要求唯一命中。`where` 只用于报错文案。 */
export function anchor(src, literal, where) {
  const n = src.split(literal).length - 1
  if (n === 0) return { ok: false, err: `${where} 逐字原文未命中（该键盘路径已被改动/删除）` }
  if (n > 1) return { ok: false, err: `${where} 逐字原文命中 ${n} 处（锚点不唯一，判据不可靠）` }
  return { ok: true, n }
}

/** 按元素形态定位按钮：卡片 className 之后、下一个卡片之前的唯一 `React.createElement(<tagExpr>, { … })`。 */
export function findButtonElement(src, scopeClass, tagExpr, what) {
  const card = findElementByClass(src, scopeClass)
  if (!card.ok) return { ok: false, err: `作用域锚（${scopeClass}）：${card.err}` }
  const cardForms = classNameForms(scopeClass)
  const cardHits = cardForms.map((f) => src.split(f).length - 1).reduce((a, b) => a + b, 0)
  if (cardHits !== 1) return { ok: false, err: `作用域锚 \`${scopeClass}\` 命中 ${cardHits} 处（判据对象歧义）` }
  const start = card.at
  const end = (function () {
    for (const f of cardForms) { const i = src.indexOf(f, start + 1); if (i !== -1) return i }
    return src.length
  })()
  const needle = 'React.createElement(' + tagExpr + ','
  const hits = []
  let at = src.indexOf(needle, start)
  while (at !== -1 && at < end) { hits.push(at); at = src.indexOf(needle, at + 1) }
  if (hits.length === 0) return { ok: false, err: `在 \`${scopeClass}\` 卡片里找不到 ${what}（\`${needle}\`）` }
  if (hits.length > 1) return { ok: false, err: `在 \`${scopeClass}\` 卡片里 ${what} 命中 ${hits.length} 处（判据对象歧义）` }
  const brace = (function () {
    for (let i = hits[0] + needle.length; i < end; i += 1) if (src[i] === '{') return i
    return -1
  })()
  if (brace === -1) return { ok: false, err: `${what} 找不到 props 的 \`{\`` }
  const close = matchBrace(src, brace)
  if (close === -1) return { ok: false, err: `${what} 的 props 花括号不配平` }
  return { ok: true, at: hits[0], line: src.slice(0, hits[0]).split('\n').length, tag: tagExpr, props: src.slice(brace + 1, close) }
}

// ── 判据 ──────────────────────────────────────────────────────────────────────
// A1：该 input 上不存在任何会调用创建函数的键盘分支（最省做法 = 整个 onKeyDown 缺席）。
export const C1_ID = 'C1'
export function C1(src, ctx) {
  const el = ctx.input
  const hasKeyDown = /(^|[\s,{])onKeyDown\s*:/.test(el.props)
  const mentionsCreate = new RegExp('\\b' + CREATE_FN + '\\b').test(el.props)
  if (hasKeyDown) {
    const at = el.props.search(/(^|[\s,{])onKeyDown\s*:/)
    const snippet = el.props.slice(Math.max(0, at - 20), at + 120).replace(/\s+/g, ' ')
    return { id: C1_ID, title: `\`${INPUT_CLASS}\` 的 props 里不存在 onKeyDown 键盘路径`, ok: false,
      detail: `props 里仍有 onKeyDown（…${snippet}…）⇒ 回车路径可能仍能创建组` }
  }
  if (mentionsCreate) {
    return { id: C1_ID, title: `\`${INPUT_CLASS}\` 的 props 里不存在 onKeyDown 键盘路径`, ok: false,
      detail: `虽无 onKeyDown，但 props 里仍出现 \`${CREATE_FN}\` ⇒ 判据要求「不存在任何调用创建函数的键盘分支」形同虚设` }
  }
  return { id: C1_ID, title: `\`${INPUT_CLASS}\` 的 props 里不存在 onKeyDown 键盘路径`, ok: true,
    detail: `onKeyDown 缺席 · props 未出现 \`${CREATE_FN}\`（input@${el.line} 行，tag=${el.tag ?? '?'}）` }
}

// A2：按钮仍绑定同一个创建函数，且空名禁用条件仍在。
export const C2_ID = 'C2'
export function C2(src, ctx) {
  const b = ctx.button
  const onChange = /(^|[\s,{])onClick\s*:\s*([A-Za-z_$][\w$]*)/.exec(b.props)
  const disabled = /(^|[\s,{])disabled\s*:\s*([^,}]+)/.exec(b.props)
  const problems = []
  if (!onChange) problems.push('props 里找不到顶层 `onClick: <函数>`')
  else if (onChange[2] !== CREATE_FN) problems.push(`onClick 指向 \`${onChange[2]}\` 而不是 \`${CREATE_FN}\``)
  if (!disabled) problems.push('props 里找不到顶层 `disabled: …`')
  else if (!/trim\(\)\s*===\s*''/.test(disabled[2])) problems.push(`disabled 条件不是空名判定（现为 \`${disabled[2].trim()}\`）`)
  if (problems.length) {
    return { id: C2_ID, title: `\`${BTN_SCOPE_CLASS}\` 卡片里的主色按钮仍以 onClick 绑定 \`${CREATE_FN}\`、禁用条件仍是空名`, ok: false,
      detail: problems.join('；') + `（button@${b.line} 行）` }
  }
  return { id: C2_ID, title: `\`${BTN_SCOPE_CLASS}\` 卡片里的主色按钮仍以 onClick 绑定 \`${CREATE_FN}\`、禁用条件仍是空名`, ok: true,
    detail: `onClick: ${onChange[2]} · disabled: ${disabled[2].trim()}（button@${b.line} 行）` }
}

// A3：另三处键盘路径逐字未动（引用文件输入回车 / 重命名输入回车 / Ctrl-Cmd-S 保存）。
export const C3_ID = 'C3'
export function C3(src) {
  const items = [
    { where: '引用文件输入的回车（dsw-file-input ⇒ add()）', literal: "onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } }" },
    { where: '重命名输入的回车（⇒ commitRename()）', literal: "if (e.key === 'Enter') { e.preventDefault(); commitRename(); }" },
    { where: 'Ctrl/Cmd+S 保存（⇒ save()）', literal: 'e.preventDefault(); save();' }
  ]
  const bad = []
  const seen = []
  for (const it of items) {
    const r = anchor(src, it.literal, it.where)
    if (r.ok) seen.push(`${it.where}（唯一命中）`)
    else bad.push(`${it.where}：${r.err}`)
  }
  if (bad.length) return { id: C3_ID, title: '另三处键盘路径逐字未动', ok: false, detail: bad.join('；') }
  return { id: C3_ID, title: '另三处键盘路径逐字未动', ok: true, detail: seen.join(' · ') }
}

// A4（观察项，只报不判）：input 的其余 props 与被推的两处语义仍在。
export function observe(src, ctx) {
  const el = ctx.input
  const b = ctx.button
  // 按钮文案是 createElement 的**第三个实参**（children），不在 props 里：
  // 从 props 的闭合处向右取到该实参结束（`}, t('groupAdd'))` 这一段）。
  const buttonTail = (function () {
    const brace = b.at + 'React.createElement(' .length
    const open = src.indexOf('{', brace)
    const close = matchBrace(src, open)
    return close === -1 ? '' : src.slice(close, close + 120)
  })()
  const rows = []
  for (const [label, re, text] of [
    ['input.value = addName', /value\s*:\s*addName/, el.props],
    ['input.placeholder = t(...)', /placeholder\s*:\s*t\(/, el.props],
    ['input.aria-label = t(...)', /'aria-label'\s*:\s*t\(/, el.props],
    ['input.onChange 设置 addName', /setAddName\(/, el.props],
    ['input.onChange 清理 addErr', /setAddErr\(null\)/, el.props],
    ["button 文案 = t('groupAdd')", /t\('groupAdd'\)/, buttonTail]
  ]) rows.push(`    ${re.test(text) ? '在' : '!! 不在'}  ${label}`)
  return rows
}

// ── 评测 ──────────────────────────────────────────────────────────────────────
export function run(src) {
  const input = findElementByClass(src, INPUT_CLASS)
  if (!input.ok) return { device: `主判据对象（input）：${input.err}` }
  const button = findButtonElement(src, BTN_SCOPE_CLASS, BTN_TAG, BTN_WHAT)
  if (!button.ok) return { device: `主判据对象（按钮所在卡片）：${button.err}` }
  const ctx = { input, button }
  const results = [C1(src, ctx), C2(src, ctx), C3(src)]
  return { ctx, results, pass: results.every((r) => r.ok) }
}

function fingerprint(s) { return createHash('sha256').update(s, 'utf8').digest('hex') }

function readSource() {
  const p = sourcePath ? path.resolve(sourcePath) : path.join(ROOT, TARGET_REL)
  if (!fs.existsSync(p)) deviceFail(`被测源码不存在：${p}`)
  return { p, src: fs.readFileSync(p, 'utf8') }
}

function printReport(res, src, p) {
  console.log(`判据对象   ${p}`)
  console.log(`指纹       ${fingerprint(src).slice(0, 16)} · ${Buffer.byteLength(src, 'utf8')} B · ${src.split('\n').length} 行`)
  console.log(`锚点       input@${res.ctx.input.line} 行（tag=${res.ctx.input.tag ?? '?'}） · 按钮卡片@${res.ctx.button.line} 行`)
  console.log('')
  for (const r of res.results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} [${r.id}] ${r.title}`)
    console.log(`       ${r.detail}`)
  }
  console.log('')
  console.log('  观察项（不参与判定）：')
  for (const line of observe(src, res.ctx)) console.log(line)
}

// ── 基线 ──────────────────────────────────────────────────────────────────────
if (import.meta.main && !selftest) {
  const { p, src } = readSource()
  if (probe) {
    const input = findElementByClass(src, INPUT_CLASS)
    const button = findButtonElement(src, BTN_SCOPE_CLASS, BTN_TAG, BTN_WHAT)
    console.log(`probe  ${p}`)
    console.log(`  input  ${input.ok ? `OK @${input.line} 行 · props ${Buffer.byteLength(input.props)} B` : '失联：' + input.err}`)
    if (input.ok) console.log(`    props = ${input.props.replace(/\s+/g, ' ').slice(0, 400)}`)
    console.log(`  button ${button.ok ? `OK @${button.line} 行 · props ${Buffer.byteLength(button.props)} B` : '失联：' + button.err}`)
    if (button.ok) console.log(`    props = ${button.props.replace(/\s+/g, ' ').slice(0, 400)}`)
    for (const it of [
      ["file-input 回车", "onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } }"],
      ["重命名 回车", "if (e.key === 'Enter') { e.preventDefault(); commitRename(); }"],
      ["Ctrl/Cmd+S 保存", "e.preventDefault(); save();"]
    ]) console.log(`  ${it[0]} 命中 ${src.split(it[1]).length - 1} 处`)
    process.exit(EXIT.PASS)
  }
  const res = run(src)
  if (res.device) deviceFail(res.device)
  printReport(res, src, p)
  console.log('')
  console.log(res.pass ? `RESULT: PASS —— ${res.results.length} 条判据全部成立` : `RESULT: FAIL —— 判据不成立 ${res.results.filter((r) => !r.ok).length} 条`)
  process.exit(res.pass ? EXIT.PASS : EXIT.FAIL)
}

// ── 自检：逐条负向对照（只在被直接执行时跑；被 import 时不得有副作用）────────────
if (import.meta.main) {
// 对照矩阵（每条都注入到**临时副本**；原文一律不改）：
//   样本①～③：用 git 里的改前版 / 现盘改后版做「天然」红绿对照。
//   变异④～⑧：每条判据至少一次「能报红」的证明，并检查未点名判据不被连带翻转。
let failures = 0
let deviceErrors = 0
let casesRun = 0
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsw-group-new-'))

function cleanup() { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 尽力 */ } }
process.on('exit', cleanup)

function loadVariant(name, text) {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, text)
  return { name, p, text }
}

function evaluate(text) {
  const res = run(text)
  if (res.device) return { device: res.device }
  return { pass: res.pass, reds: res.results.filter((r) => !r.ok).map((r) => r.id), results: res.results }
}

function check(label, text, expect) {
  casesRun += 1
  const got = evaluate(text)
  if (got.device) { console.log(`  !! ${label} —— 装置异常：${got.device}`); failures += 1; return }
  const want = (expect.red || []).slice().sort().join(',')
  const have = got.reds.slice().sort().join(',')
  const ok = want === have && (expect.pass === undefined || got.pass === expect.pass)
  console.log(`  ${ok ? 'ok  ' : '!! '} ${label}`)
  console.log(`       期望报红 = [${want || '无'}] · 实得 [${have || '无'}]`)
  if (!ok) { failures += 1; for (const r of got.results) console.log(`         ${r.ok ? 'ok  ' : 'FAIL'} [${r.id}] ${r.detail}`) }
}

// 变异注入器：锚点必须唯一命中，否则装置故障（不得静默 no-op —— 自保②）
function mutate(src, literal, replacement, label) {
  const n = src.split(literal).length - 1
  if (n !== 1) throw new Error(`对照无效：${label} 的锚点命中 ${n} 处（期望 1）`)
  const out = src.replace(literal, replacement)
  if (out === src) throw new Error(`对照无效：${label} 注入后源码逐字节未变`)
  return out
}

// 变异 + 断言必须在**同一个 try** 里，并且捕到异常就记一次失败：
// 否则 mutate 抛出的异常会一路冒到顶层 await 之前，把该用例**以及它后面的所有用例**一起静默跳过，
// 屏上只剩一个 FAIL 计数 —— 这正是「静默跳过」比报红更危险的地方（本轮自检自己撞见过）。
function mutateAndCheck(label, src, literal, replacement, expect) {
  casesRun += 1
  let mutated
  try {
    mutated = mutate(src, literal, replacement, label)
  } catch (e) {
    console.log(`  !! ${label}`)
    console.log(`       对照无效（装置故障，不是缺陷）：${e.message}`)
    failures += 1
    return
  }
  check(label, mutated, expect)
}

console.log('自检：逐条负向对照（原文一律不改，全部注入内存副本）')
const live = readSource()
const liveSrc = live.src

// ── 冻结夹具：自检**只吃夹具**，绝不读 git 历史、绝不读盘上活件 ──────────────────
// 为什么：① C 的改动一旦提交，`git show HEAD:client/client.js` 就从「改前」变成「改后」，
//            用例①会自己变红 —— 装置随提交历史退化（同族事故已在漂移门发生过一次）。
//         ② 盘上活件只要还有人写，自检读数就会被下一次编辑改写。
const FIXDIR = path.join(ROOT, 'scripts', 'fixtures')
const FIX_PRE = path.join(FIXDIR, 'client.groups-pre-fix.js')   // 改前（含回车创建分支）
const FIX_POST = path.join(FIXDIR, 'client.groups-post-fix.js') // 改后（只能点按钮创建）
const missing = [FIX_PRE, FIX_POST].filter((f) => !fs.existsSync(f))
if (missing.length) deviceFail('冻结夹具缺失，自检拒绝退回活件：' + missing.join(' · '))
const preSrc = fs.readFileSync(FIX_PRE, 'utf8')
const postSrc = fs.readFileSync(FIX_POST, 'utf8')
console.log(`  被测源码   ${live.p}`)
console.log(`  活件指纹   ${fingerprint(liveSrc).slice(0, 16)} · ${Buffer.byteLength(liveSrc, 'utf8')} B（**不参与自检判定**，只用于对照漂移告警）`)
console.log(`  冻结夹具   改前 ${fingerprint(preSrc).slice(0, 16)} · ${Buffer.byteLength(preSrc, 'utf8')} B`)
console.log(`             改后 ${fingerprint(postSrc).slice(0, 16)} · ${Buffer.byteLength(postSrc, 'utf8')} B`)
console.log('')
console.log(`  ① 改前夹具 ⇒ C1 必须报红（这就是「回车能建组」那版）`)
const h = evaluate(preSrc)
if (h.device) { console.log('  !! 装置异常：' + h.device); deviceErrors += 1 }
else {
  casesRun += 1
  const needC1 = h.reds.includes(C1_ID)
  console.log(`  ${needC1 ? 'ok  ' : '!! '} 期望 [C1] · 实得 [${h.reds.join(',') || '无'}]`)
  if (!needC1) failures += 1
}
console.log('  ② 改后夹具 ⇒ 必须全绿（这就是「只能点按钮」那版）')
check('改后夹具', postSrc, { red: [], pass: true })
console.log('  ③ 改前夹具 ⇒ 判据不成立（C1 能区分改前/改后）')
casesRun += 1
if (h.device) { console.log('  !! 装置异常：' + h.device); failures += 1 }
else {
  console.log(`  ${h.pass ? '!! ' : 'ok  '} ${h.pass ? '改前夹具竟然是绿的（C1 无法区分改前/改后）' : '改前夹具报红，与 ① 一致'}`)
  if (h.pass) failures += 1
}
console.log('')
console.log('  ④ 变异：创建分支留在原地但改成只 preventDefault ⇒ C1 必须**仍报红**（只看「有没有键盘分支」）')
mutateAndCheck('onKeyDown 仍在（虽不调 addGroup）', preSrc,
  "onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); addGroup(); } }",
  "onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); } }",
  { red: [C1_ID] })
console.log('  ⑤ 变异：把创建分支**挪到**「引用文件输入」（dsw-file-input）⇒ C1 必须仍绿、C3 报红（证明 C1 只看那个 input）')
// 这是「挪」而不是「加」：先把创建分支从**新建组输入自己的 props 范围**里摘掉，再把它挪到文件输入上。
// ⚠ 三处都踩过：① 拿 `setAddName` 当整串替换的锚点会命中新建组输入本身；
//              ② 拿不存在的字面量（多写个尾逗号）当锚点会让 mutate 抛异常（现由 mutateAndCheck 兜住）；
//              ③ 清洗正则里把要摘的 `addGroup()` 误写成 `add()`，而失败分支 `cleaned === el.props`
//                 因正则**永不命中**而恒真 ⇒ 静默 no-op（自保②失效）。故下面显式断言清洗确实改变了文本。
const dropFromInput = (function () {
  const el = findElementByClass(preSrc, INPUT_CLASS)
  if (!el.ok) throw new Error('对照无效：改前夹具里找不到新建组输入 —— ' + el.err)
  const at = preSrc.indexOf(el.props)
  if (at === -1) throw new Error('对照无效：改前夹具里定位不到新建组输入的 props 偏移')
  const cleaned = el.props.replace(/\s*,\s*onKeyDown: function \(e\) \{ if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); addGroup\(\); \} \}/, '')
  if (cleaned === el.props) throw new Error('对照无效：没摘掉创建分支（props 逐字节未变）')
  if (/onKeyDown/.test(cleaned)) throw new Error('对照无效：props 里仍残留 onKeyDown')
  return preSrc.slice(0, at) + cleaned + preSrc.slice(at + el.props.length)
})()
mutateAndCheck('把 addGroup 挪挂到 dsw-file-input', dropFromInput,
  "onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } }",
  "onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); addGroup(); } }",
  { red: [C3_ID] })
console.log('  ⑥ 变异：删掉按钮的 onClick ⇒ C2 必须报红')
mutateAndCheck('删除按钮 onClick', postSrc,
  "disabled: addName.trim() === '', onClick: addGroup }", "disabled: addName.trim() === '' }", { red: [C2_ID] })
console.log('  ⑦ 变异：把按钮禁用条件改成"永不禁用" ⇒ C2 必须报红')
mutateAndCheck('按钮永不禁用', postSrc,
  "disabled: addName.trim() === ''", 'disabled: false', { red: [C2_ID] })
console.log('  ⑧ 变异：把重命名回车改成别的函数 ⇒ C3 必须报红')
mutateAndCheck('重命名回车改函数', postSrc,
  "if (e.key === 'Enter') { e.preventDefault(); commitRename(); }",
  "if (e.key === 'Enter') { e.preventDefault(); commitRenameX(); }", { red: [C3_ID] })
console.log('')
console.log('  ⑨ 装置自证：className 改名 ⇒ 主判据对象失联必须是 exit 2（不是"通过"）')
casesRun += 1
const renamed = mutate(postSrc, "className: 'dsw-group-new-input'", "className: 'dsw-group-new-input-renamed'", '改 className')
const rn = evaluate(renamed)
const rnOk = !!rn.device
console.log(`  ${rnOk ? 'ok  ' : '!! '} 期望：装置没跑成 · 实得：${rnOk ? rn.device : '竟然还能评（' + JSON.stringify(rn) + '）'}`)
if (!rnOk) failures += 1
console.log('')
console.log('  ⑩ 漂移告警（**不参与判定**）：活件是否与任一冻结夹具逐位相同')
const lf = fingerprint(liveSrc)
const driftMsg = lf === fingerprint(postSrc) ? '活件 == 改后夹具（同刻）'
  : lf === fingerprint(preSrc) ? '活件 == 改前夹具（C 的改动还没落盘）'
    : '活件与两份夹具**都不同** ⇒ 盘上出现了夹具没覆盖的第三种形态，请重核夹具'
console.log(`     ${driftMsg}`)
console.log('')
console.log('  ⑪ 装置自证：把本脚本拷成别的名字 ⇒ **入口守卫**必须拦住（exit 2），不得静默给出 PASS')
// 为什么必须有这条：守卫曾经只有函数定义没有调用点 ⇒ 改名后照样全绿（守卫形同不存在）。
// 做法：把**本文件自己**拷到同目录下的另一个名字再执行 —— 必须待在同目录，否则
//       `TARGET_REL` 取不到 `client/client.js`，挂掉的原因就变成「被测源码不存在」，
//       那读的是**另一个**故障，与守卫无关（我第一次就是这么把对照做假的）。
casesRun += 1
{
  const probeName = 'guard-probe-' + process.pid + '.mjs'
  const probePath = path.join(path.dirname(new URL(import.meta.url).pathname), probeName)
  let probeOut = ''
  let probeCode = null
  try {
    fs.writeFileSync(probePath, fs.readFileSync(new URL(import.meta.url).pathname, 'utf8'))
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync(process.execPath, [probePath], { encoding: 'utf8', cwd: ROOT })
    probeOut = (r.stdout || '') + (r.stderr || '')
    probeCode = r.status
  } catch (e) {
    deviceErrors += 1
    console.log(`  !! 装置异常：入口守卫对照没跑成 —— ${e.message}`)
  } finally {
    try { fs.unlinkSync(probePath) } catch { /* 探针没写成，无需删 */ }
  }
  if (probeCode !== null) {
    const guardHit = probeCode === EXIT.DEVICE && probeOut.includes('装置未跑成') && probeOut.includes(probeName)
    console.log(`  ${guardHit ? 'ok  ' : '!! '} 期望：exit 2 + 「装置未跑成」点名现用名 · 实得：exit ${probeCode} · ${probeOut.trim().split('\n')[0] || '（无输出）'}`)
    if (!guardHit) failures += 1
  }
}

console.log('')
console.log(`自检：用例 ${casesRun} 项 · 装置异常 ${deviceErrors} · 判据不成立 ${failures}`)
if (deviceErrors > 0) { console.error(`RESULT: DEVICE —— 自检装置自身出错 ${deviceErrors} 项`); process.exit(EXIT.DEVICE) }
console.log(failures === 0 ? 'RESULT: PASS —— 每条判据都能报红，未点名判据未被连带翻转' : `RESULT: FAIL —— 自检不成立 ${failures} 项`)
process.exit(failures === 0 ? EXIT.PASS : EXIT.FAIL)
}

