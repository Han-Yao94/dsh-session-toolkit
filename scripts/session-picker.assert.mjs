#!/usr/bin/env node
// 组提示词「会话选择器」结构门（A 派发 #59-D-1；真源 docs/agents/board/a.md §215.4 A4 + §215.5）。
//
// 判据对象：`client/client.js` 里 `SessionPicker` / `GroupRow` 两个函数的**函数体原文**，
//          以及设置面板 CSS 块（`var CSS = [ … ].join('\n')`）与 zh/en 两个 locale 字典块。
// 判据一律**不依赖行号**（行号会漂），只用结构/文本模式；每条报出实际命中几处。
//
// 退出码：0 = 全部判据成立 · 1 = 有判据不成立（缺陷）· 2 = 装置没跑成（不是缺陷）· 64 = 用法错。
//
// ── 本门能证明什么 ────────────────────────────────────────────────────────────
//   只证明「源码文本层面的结构符合 §215.4 A4 规格」：会话按工作区分组、每组标题给已选/总数、
//   每组有「全选本组 / 取消本组」且只作用于该组在线会话、有过滤输入框（真的过滤）+「已选 N / 共 M」+
//   「清空选择」、离线成员有行且其复选框 disabled、组内开关用 groupEnableLabel、选择器内无内层滚动条。
//   每条都能红、能定位到具体事实。
// ── 本门不能证明什么（边界，不得读作通过）───────────────────────────────────
//   1) **不能替代人类真机验收**：观感/手感/长列表是否真的更省事，只有人类所有者看得到
//      （A 的无头浏览器裸访问 401，拿不到带 token 的渲染）。
//   2) 不验运行时行为：选择结果是否真的持久化、跨工作区取消是否真的写回，本门只读源码结构。
//   3) 不验 CSS 优先级/层叠；不验平台 token 的真实解析值。
//   4) 不验 `client/client.js` 之外的样式来源（官方 CSS / 内联 style 不在判据内）。
//
// ── 自保 ──────────────────────────────────────────────────────────────────────
//   ① 每条断言配一次「负向对照」（`--selftest`）：把违例注入临时副本 ⇒ 该断言**必须报红**；
//      报不出红即说明这条断言不会失败（= 没有检查），本门自证失败退出 2。
//   ② 变异未生效即判失败：注入前后逐字节相同、或锚点命中数 ≠ 期望 ⇒ 报「对照无效」，绝不当“通过”。
//   ③ 未点名断言不得被连带翻转：变异只许让它点名的那条翻红，其余必须保持原判。
//   ④ 观测装置自证：函数体/CSS 块/locale 块必须都解析到，否则退出 2（见 precheck）。
//
// ── 判据口径（与 A 的派发逐条对应，差异处已注明）────────────────────────────
//   C1 「已选/总数」：A §215.4 A4① 的原文是「已选/总数」。本门接受两种等价形态——
//        ① 组标题内含形如 `N/M` 的**数字分数**（现盘 C 的 `String(g.selectedCount)+'/'+String(g.items.length)`）；
//        ② 组标题内含中文「已选…共…」或英文 selected…total。
//      这不是放宽判据：分数本身就是「已选/总数」的字面表达。**不**接受「只有组标题、没有计数」。
//   C2 「全选/取消全选」：A 派发原文如此；实现取的分组键是 `sessionsGroupAll`/`sessionsGroupNone`
//      （文案「全选本组」/「取消本组」）⇒ 本门按**语义**判：既接受中文「全选/取消全选」字面，
//      也接受「全选本组/取消本组」，但要求**两种动作都能找到**，且文案键在 zh/en 两本字典里都有。
//   C4 离线成员：A 的机械口径是「离线成员行存在、但其复选框 disabled（不可勾）」。
//      §215.4 A4④ 的原文是「保留但置灰、不可勾、可『移除』」——「不可勾」与「有 disabled 复选框」
//      在实现上可以不等价（行级 `cursor:default` + 不给复选框路径也能做到不可勾）。
//      本门照 A 的机械口径判（要求 disabled 复选框），红是真红，但**归类要与文本混淆缺陷分开**。
//
// ── 判据 1/3/4 的锚点口径（写门时的约定）──────────────────────────────────
//   分组标题类名须命中 `/^dsw-session-(group|workspace|cwd)/`（现盘 `dsw-session-group-head`）。
//   若实现取了别的名字，本门会报红并**同时打印选择器里实际出现的全部元素类名**（`--probe`）
//   ⇒ 先怀疑锚点写窄，不要当成缺陷。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const _req = createRequire(import.meta.url)
function sha256(s) { return _req('node:crypto').createHash('sha256').update(s, 'utf8').digest('hex') }

const EXIT = { PASS: 0, DEFECT: 1, DEVICE: 2, USAGE: 64 }
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TARGET_REL = 'client/client.js'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法：
  node scripts/session-picker.assert.mjs                  基线判据（对现盘 ${TARGET_REL}）
  node scripts/session-picker.assert.mjs --selftest       逐条负向对照（把违例注入临时副本，必须报红）
  node scripts/session-picker.assert.mjs --source <f>     指定被测源码（供自证/调试）
  node scripts/session-picker.assert.mjs --probe          只打印观测面的原始读数（锚点对不上时先跑这个）
  node scripts/session-picker.assert.mjs --help

退出码：0 判据全成立 · 1 有判据不成立 · 2 装置没跑成（含解析失败）· 64 用法错`)
  process.exit(EXIT.PASS)
}
let sourcePath = path.join(ROOT, TARGET_REL)
if (argv.includes('--source')) {
  const i = argv.indexOf('--source')
  const v = argv[i + 1]
  if (!v) { console.error('用法错：--source 需要一个路径'); process.exit(EXIT.USAGE) }
  sourcePath = path.resolve(v)
}
const unknown = argv.filter((a, i) => !['--selftest', '--source', '--probe'].includes(a) && !(i > 0 && argv[i - 1] === '--source'))
if (unknown.length) { console.error('用法错：不认识的参数 ' + unknown.join(' ')); process.exit(EXIT.USAGE) }

function oneLine(s) { return String(s).replace(/\s+/g, ' ').trim() }

// ── 源码读取与预检分类（A 的裁定 #64）──────────────────────────────────────
// 整门级「测不了」= 被判对象在评测前就不可加载/解析 ⇒ exit 2，且不得逐条打印 FAIL Cn、
// 不得声称「N 条判据不成立」。预检通过后的任何失败仍走 1。

function readSourceOrExit() {
  if (!fs.existsSync(sourcePath)) {
    console.error(`未能评测：${sourcePath} 不存在（装置没跑成）`)
    process.exit(EXIT.DEVICE)
  }
  return fs.readFileSync(sourcePath, 'utf8')
}

export function precheck(src) {
  try {
    // 只做语法预检（不执行）：new Function 不执行函数体，能抓到语法错。
    new Function(src)
  } catch (e) {
    return { device: true, notice: `未能评测：${TARGET_REL} 解析失败（${oneLine(e && e.message || e)}）` }
  }
  const fatal = []
  const picker = extractFunctionBody(src, 'SessionPicker')
  const group = extractFunctionBody(src, 'GroupRow')
  const css = extractCssBlock(src)
  const zh = extractLocaleBlock(src, 'zh')
  const en = extractLocaleBlock(src, 'en')
  if (!picker.ok) fatal.push(`SessionPicker 函数体解析失败（${picker.err}）`)
  if (!group.ok) fatal.push(`GroupRow 函数体解析失败（${group.err}）`)
  if (!css) fatal.push('设置面板 CSS 块解析失败（找不到 `var CSS = [` … `].join(`）')
  else if (css.rules.length === 0) fatal.push('CSS 块解析出 0 条规则（观测装置没搭上）')
  if (!zh.ok) fatal.push(`zh locale 块解析失败（${zh.err}）`)
  if (!en.ok) fatal.push(`en locale 块解析失败（${en.err}）`)
  return { device: false, fatal, picker, group, css, zh, en }
}

// ── 解析工具 ────────────────────────────────────────────────────────────────

// 从 `open` 处（指向 `{`）做括号配平扫描；跳过字符串/模板串/注释（注释里的括号会破坏配平）。
export function matchBrace(src, open) {
  let d = 0
  for (let k = open; k < src.length; k++) {
    const c = src[k]
    if (c === '/' && src[k + 1] === '/') { const nl = src.indexOf('\n', k); k = nl === -1 ? src.length : nl; continue }
    if (c === '/' && src[k + 1] === '*') { const e = src.indexOf('*/', k + 2); k = e === -1 ? src.length : e + 1; continue }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; k++
      while (k < src.length) { if (src[k] === '\\') { k += 2; continue } if (src[k] === q) break; k++ }
      continue
    }
    if (c === '{') d++
    else if (c === '}') { d--; if (d === 0) return k }
  }
  return -1
}

export function matchParen(s, open) {
  let d = 0
  for (let k = open; k < s.length; k++) {
    const c = s[k]
    if (c === '/' && s[k + 1] === '/') { const nl = s.indexOf('\n', k); k = nl === -1 ? s.length : nl; continue }
    if (c === '/' && s[k + 1] === '*') { const e = s.indexOf('*/', k + 2); k = e === -1 ? s.length : e + 1; continue }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; k++
      while (k < s.length) { if (s[k] === '\\') { k += 2; continue } if (s[k] === q) break; k++ }
      continue
    }
    if (c === '(') d++
    else if (c === ')') { d--; if (d === 0) return k }
  }
  return -1
}

// 抽 `function NAME(props) { … }` 的完整体。要求 function 出现在行首（可带缩进），
// 避免命中调用点或注释里的名字。命中数必须恰为 1，否则报「判据对象缺失/歧义」。
export function extractFunctionBody(src, name) {
  const starts = []
  const re = new RegExp('^[ \\t]*function[ \\t]+' + name + '[ \\t]*\\(', 'gm')
  for (let m; (m = re.exec(src)) !== null; ) starts.push(m.index)
  if (starts.length === 0) return { ok: false, err: `找不到 \`function ${name}(\`` }
  if (starts.length > 1) return { ok: false, err: `\`function ${name}(\` 命中 ${starts.length} 处（判据对象歧义）` }
  const at = starts[0]
  const open = src.indexOf('{', at)
  if (open === -1) return { ok: false, err: `function ${name} 后面找不到 \`{\`` }
  const close = matchBrace(src, open)
  if (close === -1) return { ok: false, err: `function ${name} 的括号不配平` }
  return { ok: true, at, open, close, body: src.slice(open, close + 1) }
}

// 抽 `  var NAME = { … };`（locale 字典）。口径与 CSS 块一致：**取最后一段**。
// 实测 `client/client.js` 里 `  var zh = {` / `  var en = {` 各有 2 处（模块 1 = 会话身份页字典，
// 模块 3 = 本门要看的设置/组页字典，在后）⇒ 第一版按「编号必须唯一」判定，直接把自己判成 exit 2
// （那是同名子块，不是歧义）。
export function extractLocaleBlock(src, name) {
  const re = new RegExp('^  var ' + name + ' = \\{', 'gm')
  const hits = []
  for (let m; (m = re.exec(src)) !== null; ) hits.push(m.index)
  if (hits.length === 0) return { ok: false, err: `找不到顶层 \`  var ${name} = {\`` }
  const at = hits[hits.length - 1]
  const open = src.indexOf('{', at)
  const close = matchBrace(src, open)
  if (close === -1) return { ok: false, err: `var ${name} 的括号不配平` }
  return { ok: true, at, body: src.slice(open, close + 1), occurrences: hits.length }
}

// 极简 CSS 规则解析（与 settings-layout 门同构：先把 JS 字符串字面量抽出来拼成纯 CSS，再解析）。
export function jsStringsToCss(body) {
  const out = []
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch
      let j = i + 1, str = ''
      while (j < body.length) {
        if (body[j] === '\\') { str += body[j + 1]; j += 2; continue }
        if (body[j] === q) break
        str += body[j]
        j++
      }
      out.push(str)
      i = j + 1
      continue
    }
    i++
  }
  return out.join('\n')
}

export function parseRules(cssText) {
  const rules = []
  for (const m of cssText.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ')
    if (!selector) continue
    const body = m[2]
    if (selector.startsWith('@')) { rules.push({ selector, decls: {}, raw: body, at: true }); continue }
    const decls = {}
    for (const d of body.split(';')) {
      const c = d.indexOf(':')
      if (c === -1) continue
      const k = d.slice(0, c).trim()
      const v = d.slice(c + 1).trim()
      if (k) decls[k] = v
    }
    for (const sel of selector.split(',')) {
      rules.push({ selector: sel.trim().replace(/\s+/g, ' '), decls, raw: body, at: false })
    }
  }
  return rules
}

export function extractCssBlock(src) {
  const startIdx = src.lastIndexOf('var CSS = [')
  if (startIdx === -1) return null
  const endIdx = src.indexOf('].join(', startIdx)
  if (endIdx === -1) return null
  const rawInner = src.slice(startIdx + 'var CSS = ['.length, endIdx)
  const cssText = jsStringsToCss(rawInner)
  return { start: startIdx, end: endIdx, text: cssText, raw: rawInner, rules: parseRules(cssText) }
}

// ── 观测面：把「函数体原文」变成可机械判定的事实 ────────────────────────────

// `React.createElement(TAG, { props }, children…)` —— 返回每个元素及其**顶层子元素**。
// 标签名可以是字符串字面量（`'div'`）也可以是标识符（`SwitchRow`）；两者都要认。
export function parseElements(body) {
  const els = []
  const needle = 'createElement('
  for (let i = body.indexOf(needle); i !== -1; i = body.indexOf(needle, i + 1)) {
    // `open` 必须指向 `createElement(` 的**那个左括号本身**，而不是它后面一位：
    // 深度从 0 起算，左括号进 1；若从括号后一位起算，元素自身的左括号不计入深度，
    // 遇到体内第一个 `)` 就归零 ⇒ inner 被截断、className 抽不到。
    // 实测（sha 17fdeb74）：label 元素的 inner 只到 `t('sessionIdLabel'` 就断了，
    // `dsw-session-row` 整条丢失，「全选本组」的接线也一并读不到。
    const open = i + needle.length - 1
    const close = matchParen(body, open)
    if (close === -1) continue
    const inner = body.slice(open + 1, close)
    // 标签名 = 括号后到第一个**顶层**逗号（跳过字符串）。
    let comma = -1
    for (let k = 0; k < inner.length; k++) {
      const c = inner[k]
      if (c === "'" || c === '"' || c === '`') {
        const q = c; k++
        while (k < inner.length) { if (inner[k] === '\\') { k += 2; continue } if (inner[k] === q) break; k++ }
        continue
      }
      if (c === ',') { comma = k; break }
    }
    const head = comma === -1 ? inner : inner.slice(0, comma)
    const tm = head.match(/^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$.]*))\s*$/)
    const tag = tm ? (tm[3] !== undefined ? tm[3] : (tm[1] !== undefined ? tm[1] : tm[2])) : null
    const afterTag = comma === -1 ? inner.length : comma + 1
    // props 起点 = 标签名之后的**第一个非空白字符**；只有它是 `{` 才是属性对象。
    // （先前用 `inner.indexOf('{')` 或正则推起点都是错的：`React.createElement('div', { className: … }, …)`
    //   里 indexOf('{') 命中的就是属性块本身，但起点算错一位后切片会丢掉左花括号 ⇒ className 全部
    //   抽不到，我实测报出「元素 28 个 · 带类名 0 个」这个自相矛盾的读数。）
    let propsStart = -1
    for (let k = afterTag; k < inner.length; k++) {
      if (!/\s/.test(inner[k])) { if (inner[k] === '{') propsStart = k; break }
    }
    const propsEnd = propsStart === -1 ? -1 : matchBrace(inner, propsStart)
    const props = propsEnd === -1 ? '' : inner.slice(propsStart + 1, propsEnd)
    const children = propsEnd === -1 ? inner.slice(afterTag) : inner.slice(propsEnd + 1)
    const cls = props.match(/className\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/)
    els.push({
      at: i, tag,
      className: cls ? (cls[1] !== undefined ? cls[1] : cls[2]) : null,
      props,
      children,
      inner,
      span: [i, close + 1],
    })
  }
  return els
}

// 分组标题类名口径：`dsw-session-group-*` / `dsw-session-workspace-*` / `dsw-session-cwd-*`。
const GROUP_CLASS_RE = /^dsw-session-(?:group|workspace|cwd)(?:[-_][a-z0-9-]+)*$/
export function isGroupClass(cls) { return !!cls && GROUP_CLASS_RE.test(cls) }

export function elementClasses(body) {
  const out = []
  for (const e of parseElements(body)) if (e.className) out.push(e.className)
  return out
}

// 抽「派生数组」：`var NAME = <expr>;`，expr 里含数组方法或下标读取。
// 必须排除解构（`var [a, b] = useState([])`）——它不是派生数组，第一版把它读成了 `var filter = filterState[0]`。
export function derivedArrays(body) {
  const out = []
  const re = /var\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n=]*?(?:\.\s*(?:filter|map|sort)\s*\(|\[\s*\d+\s*\])[^\n]*?);/g
  for (let m; (m = re.exec(body)) !== null; ) out.push({ name: m[1], expr: m[2] })
  return out
}

// 抽「累加式派生数组」：`var NAME = []` + 随后 `NAME.push(<expr>)`（常在 `if(…)` 内）。
// 与 derivedArrays 的数组方法式并列，用来认出 `var offlineIds=[]; for(…) if(!liveById[selected[si]]) offlineIds.push(selected[si])`
// 这类「选中但不在在线列表里」的等价写法 —— 只认数组方法式会把判据写窄。
// 注意：判断条件用 matchBrace 取配平块，不用非贪婪正则 —— `\{[\s\S]*?\}` 会在长条件里回溯、
// 实测把捕获吞掉换行（`offlineIds` 单个变量的读数变成整个 var 语句）。
export function derivedPushLoops(body) {
  const out = []
  const marker = /var\s+([A-Za-z_$][\w$]*)\s*=\s*\[\s*\]/g
  for (let m; (m = marker.exec(body)) !== null; ) {
    const name = m[1]
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const push = new RegExp('\\b' + esc + '\\s*\\.\\s*push\\s*\\(([^\\n]*?)\\)')
    const pm = body.slice(m.index).match(push)
    if (!pm) continue
    // 条件：从该 push 处向左取最近一个 `if (…)`，用配平取整段条件。
    let cond = ''
    const before = body.slice(0, m.index + pm.index)
    const ifAt = (function () {
      const re = /\bif\s*\(/g
      let hit = -1
      for (let q; (q = re.exec(before)) !== null; ) hit = q.index
      return hit
    })()
    if (ifAt !== -1) {
      const parenAt = before.indexOf('(', ifAt)
      const close = matchParen(before, parenAt)
      cond = close === -1 ? '' : before.slice(parenAt, close + 1)
    }
    const condRe = /!\s*([A-Za-z_$][\w$]*)\s*\[/
    const readArr = cond.match(condRe)
    out.push({ name, pushExpr: `${name}.push(${pm[1].trim()})`, cond, readArr: readArr ? readArr[1] : null })
  }
  return out
}

// 抽函数体内（含循环体内）的函数声明：名字 + 完整体 + 相对函数体起点的下标。
export function functionsIn(body) {
  const out = []
  const re = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g
  for (let m; (m = re.exec(body)) !== null; ) {
    const name = m[1]
    const open = body.indexOf('{', m.index)
    if (open === -1) continue
    const close = matchBrace(body, open)
    if (close === -1) continue
    out.push({ name, at: m.index, open, close, body: body.slice(open, close + 1) })
  }
  return out
}

// 抽回调引用：`onClick: fn` / `onChange: function () {…}` / `onClick: function () {…}`
export function callbackRefs(body) {
  const out = []
  const re = /\bon([A-Z][A-Za-z]*)\s*:\s*(function\s*\([^)]*\)\s*\{|\s*[A-Za-z_$][\w$.]*)/g
  for (let m; (m = re.exec(body)) !== null; ) {
    const v = m[2].trim()
    if (v.startsWith('function')) {
      const fo = body.indexOf('function', m.index)
      const open = body.indexOf('{', fo)
      const close = open === -1 ? -1 : matchBrace(body, open)
      out.push({ ev: m[1], kind: 'inline', at: m.index, body: close === -1 ? '' : body.slice(open, close + 1) })
    } else {
      out.push({ ev: m[1], kind: 'ref', at: m.index, name: v.replace(/\..*$/, '') })
    }
  }
  return out
}

// 半径内取「最近的一次 `.map(` 回调参数名」：用于判断某个元素是不是建在某个数组的 map 循环里。
function enclosingMapVar(body, at) {
  const before = body.slice(0, at)
  const hits = [...before.matchAll(/\.\s*map\s*\(\s*function\s*\(\s*([A-Za-z_$][\w$]*)/g)]
  if (!hits.length) return null
  return hits[hits.length - 1][1]
}

function keysOf(picker) {
  const keys = [...picker.matchAll(/t\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const esc = [...picker.matchAll(/t\s*\(\s*(?:g|grp|o|it|s)\.([A-Za-z_$][\w$]*)\s*\)/g)].map((m) => m[1])
  return { keys: [...new Set(keys)], dyn: [...new Set(esc)] }
}

// 数「已选/总数」的计数结构。三种等价形态：
//   ① `String(x) + '/' + String(y)` 或 `` `${x}/${y}` `` —— 数字分数
//   ② 中文「已选 … 共 …」（顺序两种都收）
//   ③ 英文 selected … total
function countShapes(s) {
  const found = []
  if (/String\s*\([^)]*\)\s*\+\s*['"]\/['"]\s*\+\s*String\s*\(/.test(s)) found.push('数字分数 String(a)+"/"+String(b)')
  if (/`[^`]*\$\{[^}]*\}\s*\/\s*\$\{[^}]*\}[^`]*`/.test(s)) found.push('模板串分数 ${a}/${b}')
  if (/已选[\s\S]{0,24}共|共[\s\S]{0,24}已选/.test(s)) found.push('中文「已选…共…」')
  if (/selected[\s\S]{0,24}total|total[\s\S]{0,24}selected/i.test(s)) found.push('英文 selected…total')
  return found
}

// ── 判据 ────────────────────────────────────────────────────────────────────
// 约定：返回 { out: [失败条目原文], notes: [读数] }；out 非空 = 该判据不成立。
// 成功说明一律进 notes，绝不混进 out（否则 out.length 恒 > 0 ⇒ 判据恒红）。

export function C1_group_by_cwd(ctx) {
  const picker = ctx.picker
  const out = [], notes = []
  const els = parseElements(picker)
  const classes = els.map((e) => e.className).filter(Boolean)
  const groupEls = els.filter((e) => isGroupClass(e.className))
  notes.push(`SessionPicker 体内元素 ${els.length} 个 · 带类名 ${classes.length} 个 · 分组标题候选 ${groupEls.length} 个`)
  notes.push(`实际类名：${[...new Set(classes)].join(' ') || '（无）'}`)
  if (groupEls.length === 0) {
    out.push('选择器里找不到「分组标题」元素（类名须命中 `/^dsw-session-(group|workspace|cwd)/`；这条是本判据的锚点，锚点对不上时先跑 --probe 看实际类名，别当成缺陷）')
  } else {
    // ★ 分组标题 = 类名 `dsw-session-*-head`（在线支与离线分区支各一个）。
    //   不能拿「类名以 dsw-session-group 开头」当分组标题：那会把 group-head 的**子元素**
    //   （`dsw-session-group-path` / `dsw-session-group-count`）和容器 `dsw-session-group` 全算进来
    //   —— 实测当场报出「8 个候选 / 4 个没有计数」的假红（把路径 span、计数 span 也当成了分组头）。
    const heads = groupEls.filter((e) => /head/i.test(e.className))
    const titles = heads.length > 0 ? heads : groupEls.filter((e) => !/[-_](?:path|count|list|body)$/.test(e.className))
    notes.push(`分组标题（类名含 head）= ${heads.length} 个${heads.length === 0 ? ' ⇒ 退化为「非 path/count/list/body 的分组类名」= ' + titles.length + ' 个' : ''}`)
    // ★ 两类「分组标题」不能按同一把尺子量：
    //   ① cwd 工作区分组头 —— §215.4 A4① 要求「已选/总数」（分数 N/M 或「已选…共…」）；
    //   ② 非 cwd 分区头（离线成员分区）—— 没有「总数」概念，只要求存在计数元素即可。
    //   实测：把两者混在一起量，会因离线分区的 `String(offlineRows.length)`（裸数字）报出**假红**。
    //   判别非 cwd 分区头：它的体内引用了 offline 类派生数组（`offlineRows` / `offlineIds` …）。
    const pushLoops = derivedPushLoops(picker)
    const offlineArrNames = pushLoops.filter((d) => /off/i.test(d.name)).map((d) => d.name)
    const isPartitionHead = (e) => offlineArrNames.some((n) => new RegExp('\\b' + n + '\\b').test(e.inner))
      || /^\s*(?:String\s*\()?\s*(?:offline|lost|stale)/i.test(e.children || '')
    const partitions = titles.filter(isPartitionHead)
    const workGroups = titles.filter((e) => !isPartitionHead(e))
    notes.push(`其中 cwd 工作区分组头 ${workGroups.length} 个 · 非 cwd 分区头 ${partitions.length} 个（后者只要求「有计数元素」，不要求分数形态）`)
    const withCount = [], withoutCount = []
    for (const e of titles) {
      const strict = workGroups.includes(e)
      const kids = parseElements(e.children)
      const ce = kids.find((k) => /count|stat|num/i.test(k.className || '') || countShapes(k.children).length > 0)
      if (ce) {
        const shapes = countShapes(ce.children)
        if (shapes.length > 0) withCount.push({ e, ce, shapes })
        else if (!strict) withCount.push({ e, ce, shapes: ['（分区头，只要求有计数元素）'] })
        else withoutCount.push({ e, why: `计数元素 \`${ce.className || ce.tag}\` 里没有「已选/总数」形态（分数 N/M 或「已选…共…」）` })
        continue
      }
      if (countShapes(e.inner).length > 0) { withCount.push({ e, ce: null, shapes: countShapes(e.inner) }); continue }
      withoutCount.push({ e, why: `标题里没有计数元素，整体也没有计数形态（子元素：${kids.map((k) => k.className || k.tag).join(' ') || '无'}）` })
    }
    notes.push(`带计数的分组标题 ${withCount.length} 个 · 不带计数的 ${withoutCount.length} 个`)
    for (const w of withCount) notes.push(`  ✓ \`${w.e.className}\`${workGroups.includes(w.e) ? '（工作区分组头）' : '（分区头）'} → ${w.ce ? `\`${w.ce.className}\` · ${w.shapes.join(' · ')}` : `标题整体 · ${w.shapes.join(' · ')}`}`)
    for (const w of withoutCount) notes.push(`  ✗ \`${w.e.className}\`：${w.why}`)
    if (withoutCount.length > 0) {
      out.push(`有 ${withoutCount.length} 个分组标题里找不到「已选/总数」计数（${withoutCount.map((w) => w.e.className).join(' · ')}；§215.4 A4① 要求**每个 cwd 分组**都给「已选/总数」，分数 N/M 或「已选…共…」都算）`)
    }
    if (titles.length === 0) out.push('连一个分组标题都认不出来（`dsw-session-*-head` 也没有；先跑 --probe 看实际类名）')
    else if (workGroups.length === 0) out.push(`选择器里没有**工作区分组标题**（按 cwd 分组这一条落空：认到的 ${titles.length} 个标题全是非 cwd 分区头 —— ${titles.map((e) => e.className).join(' · ')}）`)
    const rowEls = els.filter((e) => /^dsw-session-(?:row|item|entry)/.test(e.className || ''))
    notes.push(`会话行元素 ${rowEls.length} 个（^dsw-session-(row|item|entry)）`)
    if (rowEls.length === 0) out.push('选择器里找不到会话行元素（^dsw-session-(row|item|entry)）⇒ 分组里没有可勾的行')
    else if (groupEls[0].at > rowEls[0].at) out.push('分组标题出现在会话行之后（先造行后分组 ⇒ 不是「按组分块渲染」的结构）')
  }
  return { out, notes }
}

export function C2_group_select_all(ctx) {
  const picker = ctx.picker
  const out = [], notes = []
  const fns = functionsIn(picker)
  const all = fns.map((f) => ({ name: f.name, body: f.body, at: f.at }))
  for (const c of callbackRefs(picker)) if (c.kind === 'inline') all.push({ name: '(inline)', body: c.body, at: c.at })
  notes.push(`选择器体内函数 ${all.length} 个（含 inline 回调）：${all.map((f) => f.name).join(' ')}`)

  // ① 有「清空全部选中」的动作？与「按组切换」区分开：前者对全量选择做替换，后者只增删指定 id。
  const writes = all.filter((f) => /\bselected\b/.test(f.body) && /\.\s*(?:slice|concat|filter|push|splice|indexOf)\s*\(/.test(f.body))
  const { keys } = keysOf(picker)
  const clearish = writes.filter((f) => /onChange\s*\(\s*(\[\s*\]|selected\.filter\s*\()/.test(f.body))
  notes.push(`构造新选中集合的函数 ${writes.length} 个：${writes.map((f) => f.name).join(' ')} · 其中形如「清空/过滤式提交」的 ${clearish.length} 个`)
  if (writes.length === 0) {
    out.push('选择器里没有任何函数在构造新的选中集合（判据 2 的对象缺失）')
    return { out, notes }
  }
  const groupWriters = writes.filter((f) => !clearish.includes(f))
  notes.push(`扣除「清空式」后，按增量增删选中集合的函数 ${groupWriters.length} 个：${groupWriters.map((f) => f.name).join(' ') || '（无）'}`)

  // ② 找到「全选/取消本组」的控件：其 onclick 里引用了某个分组内会话 id 列表与一个写选中集合的函数。
  let ctl = null
  const controls = []
  for (const e of parseElements(picker)) {
    const m = e.props.match(/onClick\s*:\s*function\s*\([^)]*\)\s*\{/)
    if (!m) continue
    const open = e.props.indexOf('{', e.props.indexOf('onClick'))
    const close = matchBrace(e.props, open)
    if (close === -1) continue
    const hb = e.props.slice(open, close + 1)
    const call = groupWriters.find((f) => new RegExp('\\b' + f.name + '\\s*\\(').test(hb))
    if (!call) continue
    const arg = hb.match(new RegExp('\\b' + call.name + '\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*,'))
    controls.push({ el: e, handler: hb, writer: call.name, argVar: arg ? arg[1] : null })
  }
  notes.push(`能连到「按组写选中集合」的控件 ${controls.length} 个`)
  for (const c of controls) notes.push(`  控件 class=${c.el.className || '-'} · 写者=${c.writer} · 第一个实参=${c.argVar || '(非标识符)'} · 回调：${oneLine(c.handler).slice(0, 110)}`)
  if (controls.length === 0) {
    out.push('找不到「调用按组写选中集合」的控件 ⇒ 「全选本组」没有接到能改选中集合的动作上（§215.4 A4②）')
  } else {
    ctl = controls[0]
    if (!ctl.argVar) out.push(`控件 onClick 调 \`${ctl.writer}()\` 的第一个实参不是标识符（读不到「它作用于哪一组」）`)
    else {
      // ③ 作用域判据：该实参必须派生自**该分组的 items**，而不是全量 live。
      const decl = picker.match(new RegExp('var\\s+' + ctl.argVar + '\\s*=\\s*([^;\\n]+);'))
      const expr = decl ? decl[1] : ''
      notes.push(`var ${ctl.argVar} = ${oneLine(expr) || '(找不到声明)'}`)
      const fromGroupItems = /\.items\s*\.\s*map\s*\(/.test(expr) || /\.items\s*\)/.test(expr)
      const fromAllLive = /\blive\s*(?:\.|\))/.test(expr) || /\blive\s+map|=\s*live\b/.test(expr)
      if (fromAllLive || !fromGroupItems) {
        out.push(`「全选本组」的 id 列表（\`${ctl.argVar}\`）不是派生自该分组的 items（实际：\`${oneLine(expr) || '找不到'}\`）⇒ 该动作会作用到本组之外（§215.4 A4②）`)
      } else {
        notes.push(`作用域：\`${ctl.argVar}\` 派生自分组 items ⇒ 只作用于该组在线会话 ✓`)
      }
      // ④ 该写者不得把离线成员算进来（离线成员的容器是另一个数组）。
      if (/\boffline\w*\b/.test(ctl.handler)) out.push(`「全选本组」的回调里引用了离线成员数组 ⇒ 会把不可勾的离线成员一起选上（§215.4 A4④）`)
    }
  }

  // ⑤ 被分派的每一条控制/回调，都不许在「全量在线列表」上做整体选择。
  const broad = all.filter((f) => /\blive\s*\.\s*(?:filter|map)\s*\(/.test(f.body) && /\bselected\b/.test(f.body) && /\.\s*(?:concat|slice|push)\s*\(/.test(f.body))
  notes.push(`对 \`live\` 做整体遍历并改选中集合的函数 ${broad.length} 个：${broad.map((f) => f.name).join(' ') || '（无）'}`)

  // ⑥ 控件文案：中文「全选/取消全选」「全选本组/取消本组」都接受；也接受挑两个键的三元。
  const tri = picker.match(/t\s*\(\s*([A-Za-z_$][\w$]*)\s*\?([\s\S]{0,80}?):\s*([^)]*?)\)/)
  const zhAll = /全选|取消全选|全选本组|取消本组/.test(ctx.zh)
  const hasAllWord = /sessionsGroupAll|sessionsSelectAll|selectAll/i.test(picker) || /全选|Select all/i.test(picker) || !!tri
  notes.push(`「全选」措辞：控件三元=${tri ? '有' : '无'} · 选择器里出现全选类键/字面=${hasAllWord ? '是' : '否'} · zh 字典含「全选/取消本组」=${zhAll ? '是' : '否'}`)
  if (tri) {
    const ka = tri[2].match(/([A-Za-z_$][\w$]*)/)
    const kb = tri[3].match(/([A-Za-z_$][\w$]*)/)
    for (const k of [ka && ka[1], kb && kb[1]].filter(Boolean)) {
      const inZh = new RegExp('\\b' + k + '\\s*:').test(ctx.zh)
      const inEn = new RegExp('\\b' + k + '\\s*:').test(ctx.en)
      notes.push(`  动态键 \`${k}\`：zh ${inZh ? '有' : '缺'} · en ${inEn ? '有' : '缺'}`)
      if (!inZh) out.push(`控件文案的键 \`${k}\` 在 zh 字典里没有定义（运行时会取不到）`)
      if (!inEn) out.push(`控件文案的键 \`${k}\` 在 en 字典里没有定义`)
    }
  } else if (!hasAllWord) {
    out.push('选择器里找不到「全选本组 / 取消本组」（或「全选 / 取消全选」）的文案与键（§215.4 A4②）')
  }
  if (!zhAll) out.push('zh 字典里没有「全选/取消本组」这类措辞（读不到该动作的文案）')
  return { out, notes }
}

export function C3_filter_and_clear(ctx) {
  const picker = ctx.picker
  const out = [], notes = []
  const els = parseElements(picker)
  const inputs = els.filter((e) => e.tag === 'input')
  const textInputs = inputs.filter((e) => !/type\s*:\s*['"]checkbox['"]/.test(e.props))
  notes.push(`选择器体内 input 元素 ${inputs.length} 个 · 其中非 checkbox（文本型）${textInputs.length} 个`)
  for (const e of textInputs) notes.push(`  input props：${oneLine(e.props).slice(0, 150)}`)
  const hasFilterKey = /sessionsFilterPlaceholder|filterPlaceholder/i.test(picker) || /过滤会话|Filter conversations/i.test(picker)
  notes.push(`过滤框文案键在挑择器里出现=${hasFilterKey ? '是' : '否'}`)
  if (textInputs.length === 0) out.push('选择器里没有文本输入框（§215.4 A4③ 要求顶部一行过滤输入框）')
  else if (!hasFilterKey) out.push('文本输入框存在，但没有过滤框的 placeholder 键/文案（是不是把别的输入框当成过滤框了）')

  // 过滤真的生效：状态 → needle（toLowerCase）→ 至少一个派生/分组循环用它。
  const needle = picker.match(/var\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.\s*trim\s*\(\s*\)\s*\.\s*toLowerCase\s*\(/)
  notes.push(`needle（trim().toLowerCase()）变量：${needle ? needle[1] : '（无）'}`)
  let uses = 0
  if (needle) {
    const before = picker
    const re = new RegExp('\\b' + needle[1] + '\\b', 'g')
    uses = (before.match(re) || []).length - 1
  }
  notes.push(`needle 被引用 ${uses} 次（除声明外）`)
  if (!needle) out.push('找不到过滤条件的归一化（`….trim().toLowerCase()`）⇒ 过滤没有实现大小写不敏感的子串匹配（§215.4 A4③）')
  else if (uses < 2) out.push(`过滤条件 \`${needle[1]}\` 只在声明处出现（引用 ${uses} 次）⇒ 输入值没有被用来过滤任何行`)

  // ★ 输入框**真的**接到过滤状态上：过滤状态里的 setter 必须在过滤框的 onChange
  //   （或它调用的具名处理函数）体里被调用。
  //   认「过滤状态」不看 Hook 名字（现盘是 `var filterState = React.useState('')` 两段式），
  //   而是看它的读取值**后面跟着 `.trim().toLowerCase()`** —— 那才是 needle 的来源，真正可判。
  const setterM =
    picker.match(/var\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\[0\]\s*,\s*([A-Za-z_$][\w$]*)\s*=\s*\2\s*\[1\]/) ||
    picker.match(/var\s+\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*(?:React\s*\.\s*)?useState\s*\(/)
  let getter = null
  let setter = null
  if (setterM) {
    // 两段式：捕获组 = (state, getter, setter)；一段式：捕获组 = (getter, setter)
    const isTwo = setterM.length > 3
    getter = isTwo ? setterM[2] : setterM[1]
    setter = isTwo ? setterM[3] : setterM[2]
  }
  const needleFrom = needle ? picker.match(new RegExp('\\b' + needle[1] + '\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*[;\\n]')) : null
  notes.push(`过滤状态：state setter = \`${setter || '（无）'}\` · 读取值 = \`${getter || '（无）'}\` · needle 来源 = \`${needleFrom ? needleFrom[1] : '（无）'}\``)
  let wired = null
  for (const e of textInputs) {
    const ocAt = e.props.search(/onChange\s*:/)
    if (ocAt === -1) continue
    const open = e.props.indexOf('{', ocAt)
    if (open === -1) continue
    const close = matchBrace(e.props, open)
    const hb = close === -1 ? e.props.slice(open) : e.props.slice(open, close + 1)
    if (setter && new RegExp('\\b' + setter + '\\s*\\(').test(hb)) { wired = { e, hb } ; break }
    // 间接接线：onChange 指向一个具名函数，该函数体内调 setter（现盘是内联，这条是兜底形态）。
    const ref = hb.match(/^\{\s*([A-Za-z_$][\w$]*)\s*\}$/)
    if (ref) {
      const fn = functionsIn(picker).find((f) => f.name === ref[1])
      if (fn && setter && new RegExp('\\b' + setter + '\\s*\\(').test(fn.body)) { wired = { e, hb: fn.body } ; break }
    }
  }
  notes.push(`过滤框接线：state setter = \`${setter || '（无）'}\` · 在 input.onChange 里被调用 = ${wired ? '是' : '否'}`)
  if (wired) notes.push(`  onChange 体：${oneLine(wired.hb).slice(0, 120)}`)
  if (!setter) out.push('找不到过滤状态的 setter（`var [x, setX] = useState(...)` 的第二个元素）⇒ 输入值没有可以被提交的地方（§215.4 A4③）')
  else if (textInputs.length > 0 && !wired) out.push(`过滤框的 onChange 里没有调用 \`${setter}\` ⇒ 输入框不改变过滤条件（框在、过滤不生效）`)
  const derived = derivedArrays(picker)
  notes.push(`选择器体内派生数组 ${derived.length} 个：`)
  for (const d of derived) notes.push(`  var ${d.name} = ${oneLine(d.expr).slice(0, 130)}`)

  // 「已选 N / 共 M」：用 A4③ 的文案键，且该键在 zh/en 两本字典里都有定义（否则运行时取不到）。
  const cntKey = (picker.match(/t\s*\(\s*['"]([A-Za-z_$][\w$]*Count|[A-Za-z_$]*SelectedCount)['"]\s*\)/) || [])[1]
  const cntZh = /sessionsSelectedCount\s*:/.test(ctx.zh) || /已选[\s\S]{0,8}共/.test(ctx.zh)
  const cntEn = /sessionsSelectedCount\s*:/.test(ctx.en) || /selected[\s\S]{0,12}total/i.test(ctx.en)
  notes.push(`选定计数键：${cntKey || '（无）'} · zh 有该键/文案=${cntZh ? '是' : '否'} · en=${cntEn ? '是' : '否'}`)
  if (!cntKey) out.push('选择器里找不到「已选 N / 共 M」的计数文案键（§215.4 A4③ 三件之一）')
  if (!cntZh) out.push('zh 字典里没有「已选 N / 共 M」的键或文案')
  if (!cntEn) out.push('en 字典里没有对应的选中计数键或文案')

  // 「清空选择」：动作存在 + 文案键在两本字典里都有 + 它真的清空（onChange([]) 或过滤掉全部）。
  const clearKey = (picker.match(/t\s*\(\s*['"]([A-Za-z_$][\w$]*Clear)['"]\s*\)/) || [])[1]
  const clearZh = /sessionsClear\s*:/.test(ctx.zh) || /清空选择/.test(ctx.zh)
  const clearEn = /sessionsClear\s*:/.test(ctx.en) || /clear/i.test(ctx.en)
  let clearAction = null
  for (const e of parseElements(picker)) {
    const m = e.props.match(/onClick\s*:\s*function\s*\([^)]*\)\s*\{/)
    if (!m) continue
    const open = e.props.indexOf('{', e.props.indexOf('onClick'))
    const close = matchBrace(e.props, open)
    if (close === -1) continue
    const hb = e.props.slice(open, close + 1)
    if (/onChange\s*\(\s*\[\s*\]\s*\)/.test(hb) || /selected\.filter\s*\(/.test(hb)) clearAction = { el: e, handler: hb }
  }
  if (clearKey) {
    const bind = new RegExp('\\b' + clearKey + '\\b').test(picker)
    notes.push(`清空键 ${clearKey}：zh ${clearZh ? '有' : '缺'} · en ${clearEn ? '有' : '缺'} · 控件里被引用=${bind ? '是' : '否'}`)
    if (!clearZh) out.push(`「清空选择」的键 \`${clearKey}\` 在 zh 字典里没有定义`)
    if (!clearEn) out.push(`「清空选择」的键 \`${clearKey}\` 在 en 字典里没有定义`)
  }
  notes.push(`清空动作（onClick 里 onChange([]) 或 selected.filter(…) 提交）：${clearAction ? 'class=' + (clearAction.el.className || '-') : '（无）'}`)
  if (!clearKey && !/清空选择|Clear selection|sessionsClear/i.test(picker)) {
    out.push('选择器里找不到「清空选择」的文案键或字面文案（§215.4 A4③ 三件之一）')
  }
  if (!clearAction) out.push('「清空选择」按钮没有真的清空选中集合（其 onClick 里没有 `onChange([])` 这类提交）')
  return { out, notes }
}

export function C4_offline_disabled(ctx) {
  const picker = ctx.picker
  const out = [], notes = []
  // 「离线成员 = 选中但不在在线列表里」有两种等价写法，判据必须都认（只认一种 = 判据写窄）：
  //   ① 数组方法式：`var off = selected.filter(function (s) { if (!byId[s]) … })`
  //   ② 累加式（现盘实现）：`var off = []; for (…) if (!liveById[selected[si]]) off.push(selected[si]);`
  // 这一条是 (b) 的前提（离线成员只可能被移除、不可能被加入），裁定 #66 ④ 明确不许删。
  const derived = derivedArrays(picker)
  const offArr = derived.filter((d) => /\bif\s*\(\s*!\s*[A-Za-z_$][\w$]*\s*\[/.test(d.expr))
  const pushArr = derivedPushLoops(picker)
  notes.push('「离线成员」候选 —— 数组方法式 ' + offArr.length + ' 个：' + (offArr.map((d) => d.name).join(' ') || '（无）'))
  for (const d of offArr) notes.push(`  var ${d.name} = ${oneLine(d.expr).slice(0, 150)}`)
  notes.push('「离线成员」候选 —— 累加式 ' + pushArr.length + ' 个：' + (pushArr.map((d) => d.name).join(' ') || '（无）'))
  for (const d of pushArr) notes.push(`  var ${d.name} = [] … ${d.pushExpr}`)
  // 排除掉「在线会话」数组（无论哪种写法）：在线那一支只能是 `live` / `live.map(…)`。
  const named = [...offArr.map((d) => d.name), ...pushArr.map((d) => d.name)].filter((n) => n !== 'live' && n !== 'liveById' && n !== 'liveOrder')
  if (named.length === 0) {
    out.push('找不到「离线成员 = 选中但不在在线列表里」的派生结构（数组方法式与累加式都没有；判据 4 的对象缺失）')
    return { out, notes }
  }
  const offName = named.join('|')
  const offRe = new RegExp('(?:' + offName + ')')
  const els = parseElements(picker)
  // (a) 离线集合必须被渲染循环渲染成行，不能只用于计数。
  // ⚠️ 离线行**按类名含 `offline` 认**，不能拿派生数组名去比类名：
  //    `offName` 是「或」串（如 `offlineIds|groups|kept|offlineRows|keptSel`），其中 `groups`
  //    是类名 `dsw-sessions-groups` 的子串 ⇒ 实测会把**容器**当成离线行，随后 (c) 在错的元素里
  //    找不到移除控件、报出假红。
  let offEls = els.filter((e) => /\boffline\b/i.test(e.className || ''))
  if (offEls.length === 0) {
    const m = picker.match(new RegExp('(?:' + offName + ')\\s*\\.\\s*map\\s*\\(\\s*function\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)\\s*\\{'))
    const mv = m ? m[1] : null
    // 该 map 体里出现的会话行元素：用行内 `e.className` 提到该 map 变量来认。
    offEls = els.filter((e) => /^dsw-session-(?:row|item|entry)/.test(e.className || '')
      && (!mv || new RegExp('\\b' + mv + '\\s*\\.').test(e.inner)))
    notes.push(`按「行元素且引用 map 变量 ${mv || '?'}」回退认得 ${offEls.length} 个离线行元素`)
  }
  notes.push(`(a) 渲染循环：离线集合（${offName}）\\\`.map(\\\` 命中 ${(picker.match(new RegExp('(?:' + offName + ')\\s*\\.\\s*map\\s*\\(')) || []).length} 处 · 认得离线行元素 ${offEls.length} 个`)
  if ((picker.match(new RegExp('(?:' + offName + ')\\s*\\.\\s*map\\s*\\(')) || []).length === 0 || offEls.length === 0) {
    out.push(`(a) 离线成员集合（${offName}）没有被 \`.map(\` 渲染成行 ⇒ 离线成员只用于计数、没有可管理的行（裁定 #66 ①(a)）`)
  }
  // (b) 离线行里不得有可勾选项：允许没有 checkbox；若有 `input(type:'checkbox')`，必须 disabled:true 且不把 id 写回选中集。
  let anyBox = [], badBox = []
  for (const row of offEls) {
    const inner = els.filter((e) => e.at > row.at && e.at < row.at + row.inner.length)
    const boxes = inner.filter((e) => e.tag === 'input' && /type\s*:\s*['"]checkbox['"]/.test(e.props))
    anyBox = anyBox.concat(boxes)
    for (const b of boxes) {
      const withCb = /checkbox/.test(b.props) ? b.inner : b.props + b.children
      const disabled = /disabled\s*:\s*true/.test(b.props)
      const writes = /\bonChange\b/.test(withCb) || /\.\s*push\s*\(/.test(withCb)
      notes.push(`  (b) checkbox at ${b.at}：disabled=${disabled ? 'true' : '无'} · 回调/属性里出现 onChange|.push() = ${writes ? '是' : '否'}`)
      if (!disabled || writes) badBox.push({ b, disabled, writes })
    }
  }
  notes.push(`(b) 离线行内 checkbox ${anyBox.length} 个 · 违规（可勾或写回选中集）${badBox.length} 个`)
  if (badBox.length > 0) {
    out.push(`(b) 离线成员行里存在**可勾选**的复选框 ${badBox.length} 个（${badBox.map((x) => `at ${x.b.at}：disabled=${x.disabled ? 'true' : '无'}${x.writes ? '·回调写回选中集' : ''}`).join(' · ')})⇒ 离线成员会被勾进在线选择流（裁定 #66 ①(b)）`)
  }
  // (c) 必须存在显式移除控件且带可访问名（aria-label 非空）。
  let removers = 0, unnamed = []
  for (const row of offEls) {
    const inner = els.filter((e) => e.at > row.at && e.at < row.at + row.inner.length)
    const btns = inner.filter((e) => e.tag === 'button' || /Button/.test(e.tag || ''))
    for (const btn of btns) {
      const isRemove = /remove|dsw-file-remove|delete|close/i.test(btn.className || '')
        || /toggle\s*\(|remove\s*\(|onRemove\s*\(/.test(btn.props)
      if (!isRemove) continue
      removers += 1
      const am = (btn.props.match(/'aria-label'\s*:\s*([^,}]+)/) || btn.props.match(/aria-label\s*:\s*([^,}]+)/) || [])[1]
      if (!am || !am.trim()) unnamed.push(btn)
      notes.push(`  (c) 移除控件 class=${btn.className || '-'} · aria-label=${am ? oneLine(am).slice(0, 44) : '（无）'}`)
    }
  }
  notes.push(`(c) 离线行内显式移除控件 ${removers} 个 · 缺可访问名 ${unnamed.length} 个`)
  if (removers === 0) out.push('(c) 离线成员行里没有显式的移除控件（裁定 #66 ①(c)）')
  else if (unnamed.length > 0) out.push(`(c) 有 ${unnamed.length} 个移除控件没有非空 \`aria-label\`（无访问名 ⇒ 屏幕阅读器读不出这是「移除」）`)
  // (d) 派生核对已在前半段落盘（找不到即已 return）；这里补一条否证记录。
  notes.push(`(d) 派生核对：离线集合引用了「已选 − 在线」的判定（${named.join(' ')}）⇒ 「点击只会移除、不会加入」的前提成立`)
  return { out, notes }
}

export function C5_group_enable_label(ctx) {
  const group = ctx.group
  const out = [], notes = []
  const globalUse = group.match(/['"]enableLabel['"]/g) || []
  const ownUse = group.match(/['"]groupEnableLabel['"]/g) || []
  notes.push(`GroupRow 体内 'enableLabel' 出现 ${globalUse.length} 处 · 'groupEnableLabel' 出现 ${ownUse.length} 处`)
  if (globalUse.length > 0) out.push(`GroupRow 仍在用全局键 \`enableLabel\`（${globalUse.length} 处）——同组内写着「启用全局提示词」而行为是只对本组生效（§215.3 必修缺陷）`)
  if (ownUse.length === 0) out.push("GroupRow 没有引用 `groupEnableLabel` ⇒ 组内开关没有用本组专用文案键（§215.3 的修法）")
  const zhHas = /groupEnableLabel\s*:/.test(ctx.zh)
  const enHas = /groupEnableLabel\s*:/.test(ctx.en)
  const ownZh = (ctx.zh.match(/groupEnableLabel\s*:\s*'([^']*)'/) || [])[1]
  const ownEn = (ctx.en.match(/groupEnableLabel\s*:\s*'([^']*)'/) || [])[1]
  notes.push(`locale：zh 有 groupEnableLabel=${zhHas ? '是' : '否'}${ownZh ? `（"${ownZh}"）` : ''} · en 有=${enHas ? '是' : '否'}${ownEn ? `（"${ownEn}"）` : ''}`)
  if (!zhHas) out.push('zh locale 字典里没有 `groupEnableLabel` ⇒ 运行时取不到键')
  if (!enHas) out.push('en locale 字典里没有 `groupEnableLabel` ⇒ 英文界面取不到键')
  if (ownZh && /全局/.test(ownZh)) out.push(`zh 的 \`groupEnableLabel\` 文案里仍写「全局」："${ownZh}"（语义与行为相反，§215.3 缺陷未除）`)
  if (ownEn && /global/i.test(ownEn)) out.push(`en 的 \`groupEnableLabel\` 文案里仍写 "global"："${ownEn}"`)
  return { out, notes }
}

export function C6_no_inner_scroll(ctx) {
  const rules = ctx.rules || []
  const picker = ctx.picker
  const out = [], notes = []
  // 作用域 = 选择器**自己用到的类名** + 离线行组合类名。不按名字前缀瞎扫：
  // `.dsw-sessions-search` 这类文本输入框若哪天真加了限高滚动，也该被看见。
  const scope = new Set(elementClasses(picker))
  scope.add('dsw-session-group-head')
  scope.add('dsw-session-group')
  scope.add('dsw-session-group-count')
  scope.add('dsw-session-row.offline')
  scope.add('dsw-sessions-list')
  scope.add('dsw-sessions-groups')
  // 豁免：文本输入框类（本仓库既有约定，见 settings-layout 门的 textarea 豁免名单）。
  const exempt = new Set(['dsw-sessions-search', 'dsw-file-input', 'dsw-area', 'dsw-group-name-input'])
  const relevant = rules.filter((r) => {
    if (r.at) return false
    const base = (r.selector.match(/^\.(dsw-[a-z0-9-]+)/) || [])[1]
    if (!base) return false
    if (!scope.has(base) && !scope.has(r.selector)) return false
    return true
  })
  let scanned = 0, exempted = 0
  for (const r of relevant) {
    const decl = r.decls['overflow'] !== undefined ? { k: 'overflow', v: r.decls['overflow'] }
      : (r.decls['overflow-y'] !== undefined ? { k: 'overflow-y', v: r.decls['overflow-y'] } : null)
    if (!decl) continue
    scanned++
    const base = (r.selector.match(/^\.(dsw-[a-z0-9-]+)/) || [])[1]
    if (exempt.has(base) && /^(auto|scroll)$/.test(String(decl.v).trim())) { exempted++; notes.push(`  豁免（文本输入框）：${r.selector} { ${decl.k}: ${decl.v} }`); continue }
    if (/^(auto|scroll)$/.test(String(decl.v).trim())) {
      out.push(`选择器内层出现滚动条规则：\`${r.selector} { ${decl.k}: ${decl.v} }\`（§215.5 明确不做；平台约定「滚动归外壳」）`)
    }
  }
  notes.push(`作用域内类名 ${scope.size} 个 · 命中相关规则 ${relevant.length} 条 · 带 overflow 声明的 ${scanned} 条（豁免 ${exempted} 条）`)
  notes.push(`相关选择器：${relevant.map((r) => r.selector).join(' ') || '（无）'}`)
  if (scope.size === 0) out.push('选择器里没解析到任何类名 ⇒ 判据 6 的观测面为空（观测装置没搭上）')
  else if (relevant.length === 0) out.push('CSS 里找不到任何会话选择器相关规则（判据对象缺失，可能是类名改了）')
  return { out, notes }
}

export const CRITERIA = [
  { id: 'C1', name: '会话按工作区（cwd）分组：分组标题存在且内含「已选/总数」计数', fn: C1_group_by_cwd },
  { id: 'C2', name: '每组有「全选本组/取消本组」，且写选中集合的 id 列表派生自该组 items、不含离线成员', fn: C2_group_select_all },
  { id: 'C3', name: '过滤框（真过滤 + 大小写不敏感）+「已选 N / 共 M」+「清空选择」，键在 zh/en 都有定义', fn: C3_filter_and_clear },
  { id: 'C4', name: '离线成员有渲染行，且其复选框 disabled（不可勾）', fn: C4_offline_disabled },
  { id: 'C5', name: '组内开关用 groupEnableLabel（zh/en 都有键），GroupRow 不再出现 enableLabel', fn: C5_group_enable_label },
  { id: 'C6', name: '会话选择器内不得出现内层滚动条规则（overflow-y:auto / overflow:auto）', fn: C6_no_inner_scroll },
]

// ── 判定 ────────────────────────────────────────────────────────────────────

export function judge(src, label) {
  const pre = precheck(src)
  if (pre.device) return { fatal: pre.notice, device: true, results: [] }
  if (pre.fatal && pre.fatal.length) return { fatal: pre.fatal.join(' · '), results: [] }
  const picker = pre.picker.body
  const group = pre.group.body
  const zh = pre.zh.body
  const en = pre.en.body
  const ctx = { src, picker, group, rules: pre.css.rules, zh, en }
  const results = CRITERIA.map((c) => {
    let r
    try { r = c.fn(ctx) } catch (e) { return { id: c.id, name: c.name, err: oneLine(e && e.message || e) } }
    return { id: c.id, name: c.name, fails: r.out, notes: r.notes }
  })
  return { ctx, results, label, pre }
}

function printReport(j, src) {
  const bytes = Buffer.byteLength(src, 'utf8')
  const sha = sha256(src)
  console.log(`被测：${sourcePath}`)
  console.log(`指纹：sha256=${sha} · ${bytes} B · 设置面板 CSS 规则 ${j.pre ? j.pre.css.rules.length : 0} 条 · SessionPicker ${j.pre ? j.pre.picker.body.length : 0} 字符 · GroupRow ${j.pre ? j.pre.group.body.length : 0} 字符`)
  console.log('')
  let failed = 0, unverified = 0
  for (const c of CRITERIA) {
    const r = j.results.find((x) => x.id === c.id)
    if (!r) { console.log(`  ?? ${c.id} 没有结果`); unverified++; continue }
    if (r.err) { console.log(`  !! ${c.id} ${c.name}\n     判据未能确证（装置抛错）：${r.err}`); unverified++; continue }
    if (r.fails.length === 0) console.log(`  ok ${c.id} ${c.name}`)
    else { failed++; console.log(`  FAIL ${c.id} ${c.name}`); for (const f of r.fails) console.log(`       · ${f}`) }
    for (const n of r.notes || []) console.log(`       ${n}`)
  }
  console.log('')
  const tail = unverified ? ` · 未能确证 ${unverified} 条` : ''
  console.log(failed === 0 && unverified === 0
    ? `PASS：${CRITERIA.length} 条判据全部成立`
    : `FAIL：判据不成立 ${failed}/${CRITERIA.length} 条${tail}`)
  return { failed, unverified }
}

function probe(src) {
  const pre = precheck(src)
  if (pre.device) { console.error(pre.notice); process.exit(EXIT.DEVICE) }
  if (pre.fatal && pre.fatal.length) { console.error('未能评测：' + pre.fatal.join(' · ')); process.exit(EXIT.DEVICE) }
  const picker = pre.picker.body
  const group = pre.group.body
  console.log(`== SessionPicker 体长 ${picker.length} 字符 · GroupRow 体长 ${group.length} 字符 ==`)
  console.log('-- 元素类名（源码顺序）--')
  for (const c of elementClasses(picker)) console.log('   ' + c)
  console.log('-- 元素（tag · class · index · 子元素类名）--')
  const els = parseElements(picker)
  for (const e of els.slice(0, 60)) {
    const kids = parseElements(e.children).map((k) => k.className || k.tag).join(' ')
    console.log(`   [${e.at}] ${e.tag || '?'} class=${e.className || '-'} kids=[${kids}]`)
  }
  if (els.length > 60) console.log(`   … 共 ${els.length} 个元素`)
  console.log('-- 函数 --')
  for (const f of functionsIn(picker)) console.log(`   ${f.name} (at ${f.at}) 体长 ${f.body.length}`)
  console.log('-- 派生数组 --')
  for (const d of derivedArrays(picker)) console.log(`   var ${d.name} = ${oneLine(d.expr)}`)
  console.log('-- 回调 --')
  for (const c of callbackRefs(picker)) console.log(`   on${c.ev} → ${c.kind === 'ref' ? c.name : '(inline ' + c.body.length + ' ch)'}`)
  const kk = keysOf(picker)
  console.log('-- t(…) 字面键（去重）--')
  console.log('   ' + (kk.keys.join(' ') || '（无）'))
  console.log('-- t(动态键) --')
  console.log('   ' + (kk.dyn.join(' ') || '（无）'))
  console.log('-- 选择器相关 CSS --')
  const scope = new Set([...elementClasses(picker), 'dsw-session-group', 'dsw-session-group-head', 'dsw-session-group-count', 'dsw-sessions-list', 'dsw-sessions-groups'])
  for (const r of pre.css.rules) {
    const base = (r.selector.match(/^\.(dsw-[a-z0-9-]+)/) || [])[1]
    if (!base || (!scope.has(base) && !scope.has(r.selector))) continue
    console.log(`   ${r.selector} { ${r.raw.trim()} }`)
  }
  process.exit(EXIT.PASS)
}

// ── 变异（每条判据一次负向对照）──────────────────────────────────────────────
// 约定：`kind:'replace'`（默认）= [旧串, 新串, 期望命中次数]；命中数不符或替换后逐字节相同 ⇒ 对照无效。
export const MUTATIONS = [
  {
    id: 'M1', crit: 'C1',
    what: '把所有分组头的类名都换成非分组名（在线支 + 离线分区支 ⇒ `dsw-session-group-head` ×2 → `dsw-session-head-group`）⇒ 判据 1 的分组锚点消失',
    kind: 'replace',
    // 两处 JS 命中在字节层面相同（在线支 at 95453 / 离线分区支 at 97799）⇒ 期望 2 次。
    // 只改一处是**打不干净**的：实测只改在线支后判据仍读到「分组标题候选 7 个」⇒ 照样绿。
    replace: ["{ className: 'dsw-session-group-head' }", "{ className: 'dsw-session-nohead-x' }", 2],
  },
  {
    id: 'M2', crit: 'C1',
    what: '去掉两个分组标题里**计数元素**的类名（在线支与离线分区支的 `span.dsw-session-group-count` → 无名 span）⇒ 每个分组都给「已选/总数」的要求落空',
    kind: 'replace-many',
    // 注意：把计数**算式**换成静态串是打不动 C1 的 —— 判据靠 `className` 命中 count/stat/num
    // 或 kids 里含计数形态来认元素，元素还在（类名还在）就照样算「有计数」。
    // 两处 JS 命中的缩进不同（在线支 8 空格、离线分区支 10 空格），必须分别指定，否则只命中一处。
    replaceMany: [
      ["        React.createElement('span', { className: 'dsw-session-group-count' }, String(g.selectedCount)", "        React.createElement('span', { }, String(g.selectedCount)", 1],
      ["          React.createElement('span', { className: 'dsw-session-group-count' }, String(offlineRows.length)", "          React.createElement('span', { }, String(offlineRows.length)", 1],
    ],
  },
  {
    id: 'M3', crit: 'C2',
    what: '把「全选本组」的 id 列表从该组 items 换成全量 live ⇒ 一按就作用于所有工作区',
    kind: 'broaden-select-all',
  },
  {
    id: 'M4', crit: 'C2',
    what: '把写选中集合的函数改成「基于全量 live 重建」⇒ 丢失本组作用域',
    kind: 'stub-group-writer',
  },
  {
    id: 'M5', crit: 'C3',
    what: '把过滤框的 onChange 体换成空 ⇒ 输入不改变过滤条件（输入框还在，但不生效）',
    kind: 'neuter-input-onchange',
  },
  {
    id: 'M6', crit: 'C3',
    what: '把「已选 N / 共 M」的计数键从 zh 字典里删掉 ⇒ 运行时取不到键',
    kind: 'drop-locale-key',
    locale: 'zh',
    key: 'sessionsSelectedCount',
  },
  {
    id: 'M7', crit: 'C3',
    what: '把「清空选择」按钮的提交改成空函数 ⇒ 动作在但不真的清空',
    kind: 'neuter-clear-action',
  },
  {
    id: 'M8a', crit: 'C4',
    what: '给离线成员行注入一个**可勾**复选框（`disabled: true` 与回调都拿掉）⇒ (b) 必须报红',
    kind: 'replace',
    // props 内单点注入：把 `className: 'dsw-session-row offline', title:` 之间插入复选框。
    // （先前三种写法都把逗号代数写坏 ⇒ precheck 报解析失败 = 装置没跑成，不是对照有效。）
    replace: [
      "className: 'dsw-session-row offline', title:",
      "className: 'dsw-session-row offline', checkbox: React.createElement('input', { type: 'checkbox', className: 'dsw-session-check', checked: true, onChange: function () { toggle(o.id); } }), title:",
      1,
    ],
  },
  {
    id: 'M8b', crit: 'C4',
    what: '把离线行的类名从 `dsw-session-row offline` 改成不含 offline ⇒ 离线行认不出来，(a) 必须报红',
    kind: 'replace',
    replace: ["className: 'dsw-session-row offline'", "className: 'dsw-session-row ghost'", 1],
  },
  {
    id: 'M8', crit: 'C4',
    what: '给离线成员行注入一个**可勾**的复选框（不带 disabled）⇒ 离线成员可以被选中（§215.4 A4④ 要求不可勾）',
    kind: 'replace',
    // 判据 C4 的三档红点里，这一手打的是「行里没有复选框」/「复选框没 disabled」。
    // 注入必须落在元素的**子参数**位置：先前三种写法（往 props 中间插 createElement、
    // 只把 `, className:` 收成 ` }, className:`）都会让逗号代数坏掉 ⇒ precheck 报
    // `Unexpected token '.'` / `missing )`，整门走「未能评测」——那是装置没跑成，不是对照有效。
    // 现在把 props 的 key 之后**整体重写**：props 只留 key，其余属性与新增复选框都做子参数。
    // 注入必须落在**子参数**位置：离线行的 props 是 `{ key, className, title, onClick }`，
    // 闭合在 `toggle(o.id); } },` 之后，第一个子参数是 `React.createElement('span', { className: 'dsw-session-text' },`。
    // 先前把 props 提前闭合（`{ key: … }, createElement(…)` 却把 `className:` 留在外面）⇒
    // 逗号代数坏掉、`missing ) after argument list` —— 装置没跑成，不是对照有效。
    replace: [
      "React.createElement('span', { className: 'dsw-session-text' },\n            React.createElement('span', { className: 'dsw-session-title' }, o.id)",
      "React.createElement('input', { type: 'checkbox', className: 'dsw-session-check', checked: true, onChange: function () { toggle(o.id); } }), React.createElement('span', { className: 'dsw-session-text' },\n            React.createElement('span', { className: 'dsw-session-title' }, o.id)",
      1,
    ],
  },
  {
    id: 'M9', crit: 'C5',
    what: "把 GroupRow 的 `t('groupEnableLabel')` 换回 `t('enableLabel')` ⇒ 回到 §215.3 的语义相反文案",
    kind: 'replace',
    replace: ["t('groupEnableLabel')", "t('enableLabel')", 1],
  },
  {
    id: 'M10', crit: 'C5',
    what: '把 zh 字典里 groupEnableLabel 的键删掉 ⇒ 运行时取不到键',
    kind: 'drop-locale-key',
    locale: 'zh',
    key: 'groupEnableLabel',
  },
  {
    id: 'M11', crit: 'C6',
    what: '给 `.dsw-sessions-list` 注入 `overflow-y:auto` ⇒ 出现内层滚动条（§215.5 明确不做）',
    kind: 'inject-scroll',
    selector: '.dsw-sessions-list',
  },
]

function replaceOnce(src, oldS, newS, expect) {
  const n = src.split(oldS).length - 1
  if (n !== expect) return { ok: false, why: `变异锚点命中 ${n} 次 ≠ 期望 ${expect} 次（锚点写窄了或实现变了 ⇒ 先怀疑探针，别当成对照通过）：${JSON.stringify(oldS.slice(0, 60))}` }
  const text = src.replace(oldS, newS)
  if (text === src) return { ok: false, why: '变异未生效（替换后源码逐字节相同）' }
  return { ok: true, text }
}

// 把某个函数体整体替换掉，并把替换结果写回源码（picker 是我们从同一份 src 里切出来的 ⇒ 位置可用）。
function swapPickerBody(src, pickerBody, newBody) {
  const text = src.replace(pickerBody, newBody)
  if (text === src) return { ok: false, why: '变异未生效（替换后源码逐字节相同）' }
  return { ok: true, text }
}

export function applyMutation(src, m) {
  if (!m.kind || m.kind === 'replace') return replaceOnce(src, m.replace[0], m.replace[1], m.replace[2])

  if (m.kind === 'replace-many') {
    // 多处字面量替换：每处都带自己的期望命中次数。任一处的命中数不符即整份对照无效
    // （不静默跳过 —— 未生效的变异不得计作「对照成立」）。
    let text = src
    const done = []
    for (const [oldS, newS, expect] of m.replaceMany) {
      const n = text.split(oldS).length - 1
      if (n !== expect) return { ok: false, why: `第 ${done.length + 1} 处锚点命中 ${n} 次 ≠ 期望 ${expect} 次：${JSON.stringify(oldS.slice(0, 70))}` }
      const next = text.replace(oldS, newS)
      if (next === text) return { ok: false, why: `第 ${done.length + 1} 处变异未生效（替换后逐字节相同）` }
      text = next
      done.push(oldS.slice(0, 40))
    }
    return { ok: true, text }
  }

  const picker = extractFunctionBody(src, 'SessionPicker')
  if (!picker.ok) return { ok: false, why: '找不到 SessionPicker 体：' + picker.err }
  const body = picker.body

  if (m.kind === 'count-to-static') {
    // 把「已选/总数」的分数表达式整体换成静态串：`String(a)+'/'+String(b)` → `'0/0'`。
    const re = /String\s*\(\s*([A-Za-z_$][\w$.]*)\s*\)\s*\+\s*['"]\/['"]\s*\+\s*String\s*\(\s*([A-Za-z_$][\w$.]*)\s*\)/
    const hit = body.match(re)
    if (!hit) return { ok: false, why: '体内找不到 `String(a)+\'/\'+String(b)` 形式的计数（锚点写窄了或实现变了）' }
    return swapPickerBody(src, body, body.replace(re, "'§§'"))
  }

  if (m.kind === 'broaden-select-all') {
    // 把「全选本组」用的 id 列表从分组 items 换成全量 live。
    const hit = body.match(/var\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\.items\s*\.\s*map\s*\(/)
    if (!hit) return { ok: false, why: '体内找不到 `.items.map(` 形式的 id 列表（锚点写窄了或实现变了）' }
    const nb = body.replace(hit[0], `var ${hit[1]} = live.map(function (x) { return String(x.id); }); // 变异`)
    return swapPickerBody(src, body, nb)
  }

  if (m.kind === 'stub-group-writer') {
    // 把按组写选中集合的函数改成「基于全量 live 重建」。
    const fns = functionsIn(body)
    const cand = fns.filter((f) => /\bselected\b/.test(f.body) && /\.\s*(?:slice|push|splice|concat|filter|indexOf)\s*\(/.test(f.body) && /\bids\b/.test(f.body))
    if (cand.length !== 1) return { ok: false, why: `「按组写选中集合」的函数命中 ${cand.length} 个 ≠ 期望 1 个（锚点写窄了或实现变了）` }
    const f = cand[0]
    const nb = '{ var out = []; for (var i = 0; i < live.length; i++) out.push(String(live[i].id)); onChange(out); }'
    return swapPickerBody(src, body, body.replace(f.body, nb))
  }

  if (m.kind === 'neuter-input-onchange') {
    const els = parseElements(body)
    const inp = els.find((e) => e.tag === 'input' && /onChange\s*:/.test(e.props) && !/checkbox/.test(e.props))
    if (!inp) return { ok: false, why: '找不到带 onChange 的文本 input（锚点写窄了或实现变了）' }
    const open = inp.props.indexOf('{', inp.props.indexOf('onChange'))
    const close = matchBrace(inp.props, open)
    if (close === -1) return { ok: false, why: 'input 的 onChange 体括号不配平' }
    const hb = inp.props.slice(open, close + 1)
    return swapPickerBody(src, body, body.replace(hb, '{ /* 变异：输入不再改变过滤条件 */ }'))
  }

  if (m.kind === 'drop-locale-key') {
    const loc = extractLocaleBlock(src, m.locale)
    if (!loc.ok) return { ok: false, why: `找不到 ${m.locale} locale 块：` + loc.err }
    const line = loc.body.match(new RegExp('^\\s*' + m.key + '\\s*:[^\\n]*\\n', 'm'))
    if (!line) return { ok: false, why: `${m.locale} 字典里没有 ${m.key} 那一行（锚点写窄了或实现变了）` }
    const text = src.replace(line[0], '')
    if (text === src) return { ok: false, why: '变异未生效（替换后源码逐字节相同）' }
    return { ok: true, text }
  }

  if (m.kind === 'neuter-clear-action') {
    const clearKey = (body.match(/t\s*\(\s*['"]([A-Za-z_$][\w$]*Clear)['"]\s*\)/) || [])[1]
    if (!clearKey) return { ok: false, why: '体内找不到清空键（锚点写窄了或实现变了）' }
    // 找到引用该键的那个控件，把它的 onClick 体换成空。
    let target = null
    for (const e of parseElements(body)) {
      const m2 = e.props.match(/onClick\s*:\s*function\s*\([^)]*\)\s*\{/)
      if (!m2) continue
      const open = e.props.indexOf('{', e.props.indexOf('onClick'))
      const close = matchBrace(e.props, open)
      if (close === -1) continue
      const hb = e.props.slice(open, close + 1)
      if (/onChange\s*\(\s*\[\s*\]\s*\)/.test(hb)) target = hb
    }
    if (!target) return { ok: false, why: '找不到 `onChange([])` 形式的清空控件（锚点写窄了或实现变了）' }
    return swapPickerBody(src, body, body.replace(target, '{ /* 变异：清空动作不再提交 */ var noop = 1; void noop; }'))
  }

  if (m.kind === 'replace-first') {
    // 只替换**第一处**命中：`dsw-session-group-head` 在 JS 里出现 2 次（在线支 + 离线分区支），
    // 精确到一处的写法会被换行/缩进变化打破（实测锚点 0 命中），所以改成「锚点 + 右界」。
    const [anchor, newS, rightBound] = m.replaceFirst
    const at = body.indexOf(anchor)
    if (at === -1) return { ok: false, why: `第一处锚点未命中：${JSON.stringify(anchor.slice(0, 60))}（锚点写窄了或实现变了）` }
    const ends = []
    for (const b of (rightBound ? [rightBound] : [])) { const j = body.indexOf(b, at); if (j !== -1) ends.push(j) }
    if (ends.length === 0) return { ok: false, why: `右界 ${JSON.stringify(rightBound)} 在第一处锚点之后未命中` }
    const end = Math.min(...ends)
    const oldS = body.slice(at, end + (rightBound.length > 0 ? rightBound.length : 0))
    if (oldS === newS) return { ok: false, why: '变异未生效（替换后逐字节相同）' }
    return swapPickerBody(src, body, body.slice(0, at) + newS + body.slice(at + oldS.length))
  }

  if (m.kind === 'inject-offline-checkbox') {
    const cls = "className: 'dsw-session-row offline'"
    if (body.split(cls).length - 1 !== 1) return { ok: false, why: '离线行锚点命中 ≠ 1 次（锚点写窄了或实现变了）' }
    // 把 props 的**第二个属性**（原 `className:`）位置让给复选框元素，类名移到 props 之后：
    //   `{ key: …, className: 'dsw-session-row offline', title: … }`
    //   → `{ key: … }, React.createElement('input', …), className: 'dsw-session-row offline', title: …`
    // 逗号代数保持合法（props 对象在 key 之后闭合，其余属性成为子元素参数）。
    // 先前的三种写法都不行：往 props 中间插 createElement（逗号代数坏、`Unexpected token '.'`）、
    // 只把 `, className:` 收成 ` }, className:`（对象提前闭合、`missing )`）——都是装置没跑成。
    const a = "{ key: 'off-' + o.id, "
    const b = "className: 'dsw-session-row offline'"
    if (body.split(a).length - 1 !== 1) return { ok: false, why: '离线行 props 起始锚点命中 ≠ 1 次（锚点写窄了或实现变了）' }
    const inject = "React.createElement('input', { type: 'checkbox', className: 'dsw-session-check', checked: true, onChange: function () { toggle(o.id); } }), "
    const out = body.replace(a + b, a.replace(/,\s*$/, '') + " }, " + inject + b)
    return swapPickerBody(src, body, out)
  }

  if (m.kind === 'drop-disabled') {
    // 优先取「离线行渲染里带 disabled: true 的复选框」；实现若没有这种复选框，就取任意一处。
    const els = parseElements(body)
    const cbs = els.filter((e) => e.tag === 'input' && /disabled\s*:\s*true/.test(e.props))
    if (cbs.length !== 1) return { ok: false, why: `带 \`disabled: true\` 的 input 命中 ${cbs.length} 个 ≠ 期望 1 个（锚点写窄了或实现变了）` }
    const e = cbs[0]
    const nb = body.slice(0, e.span[0]) + e.inner.replace(/disabled\s*:\s*true/, 'disabled: false') + body.slice(e.span[1])
    return swapPickerBody(src, body, nb)
  }

  if (m.kind === 'inject-scroll') {
    const css = extractCssBlock(src)
    if (!css) return { ok: false, why: 'CSS 块解析失败' }
    const hits = css.rules.filter((r) => !r.at && r.selector === m.selector)
    if (hits.length !== 1) return { ok: false, why: `选择器 ${m.selector} 命中 ${hits.length} 处 ≠ 期望 1 处（锚点写窄了或实现变了）` }
    const rawHit = src.indexOf("'" + m.selector + '{')
    if (rawHit === -1) return { ok: false, why: `JS 源码里找不到 '${m.selector}{'` }
    const insertAt = rawHit + m.selector.length + 2   // 越过 `'{`
    const text = src.slice(0, insertAt) + 'overflow-y:auto;' + src.slice(insertAt)
    if (text === src) return { ok: false, why: '变异未生效（替换后源码逐字节相同）' }
    return { ok: true, text }
  }

  return { ok: false, why: `不认识的变异 kind=${m.kind}` }
}

// ── 自证（逐条负向对照）───────────────────────────────────────────────────

function selftest() {
  const src = readSourceOrExit()
  const pre = precheck(src)
  if (pre.device) { console.error(pre.notice + '\n（这是**装置没跑成**，不是缺陷）'); process.exit(EXIT.DEVICE) }
  if (pre.fatal && pre.fatal.length) { console.error('装置没跑成：' + pre.fatal.join(' · ')); process.exit(EXIT.DEVICE) }
  const base = judge(src, 'baseline')
  const baseVerdict = {}
  for (const c of CRITERIA) {
    const r = base.results.find((x) => x.id === c.id)
    baseVerdict[c.id] = !!(r && !r.err && Array.isArray(r.fails) && r.fails.length === 0)
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsw-picker-selftest-'))
  let bad = 0
  const rows = []
  for (const m of MUTATIONS) {
    const a = applyMutation(src, m)
    if (!a.ok) { rows.push({ m, mechOk: false, verdict: '对照无效：' + a.why, ok: false }); bad++; continue }
    const f = path.join(tmpDir, `mut-${m.id}.js`)
    fs.writeFileSync(f, a.text, 'utf8')
    const j = judge(a.text, m.id)
    if (j.fatal) { rows.push({ m, mechOk: false, verdict: '对照无效：' + j.fatal, ok: false }); bad++; continue }
    const r = j.results.find((x) => x.id === m.crit)
    const named = !!(r && !r.err && Array.isArray(r.fails) && r.fails.length > 0)
    const passOf = (res) => !!(res && !res.err && Array.isArray(res.fails) && res.fails.length === 0)
    const flipped = CRITERIA.filter((c) => baseVerdict[c.id] !== passOf(j.results.find((x) => x.id === c.id))).map((c) => c.id)
    const collateral = flipped.filter((x) => x !== m.crit)
    const mechOk = named && collateral.length === 0
    const genuineFlip = mechOk && baseVerdict[m.crit] === true
    const baseRed = mechOk && baseVerdict[m.crit] === false
    if (!mechOk) bad++
    rows.push({
      m, mechOk, genuineFlip, baseRed, collateral,
      verdict: !named ? '**没报红 ⇒ 这条断言是空的**'
        : collateral.length ? `**点名判据报红，但有未点名判据被连带翻转**（${collateral.join(' ')}）`
          : '报红（符合预期）',
      extra: `未点名判据被连带翻转：${collateral.join(' ') || '0 条'}`,
      note: genuineFlip ? '' : (baseRed ? '基线该判据本来就红 ⇒ 只证「注入生效让点名判据报出这条」；**绿变红待实现修好后复核**' : ''),
      detail: r && Array.isArray(r.fails) ? r.fails : [],
    })
  }
  console.log('负向对照（把违例注入临时副本 ⇒ 点名判据必须报红）')
  console.log(`被测源码：${sourcePath}`)
  console.log(`临时副本目录：${tmpDir}`)
  console.log('')
  for (const row of rows) {
    console.log(`  ${row.mechOk ? (row.genuineFlip ? 'ok  ' : 'PEND') : 'FAIL'} ${row.m.id} → ${row.m.crit}  ${row.m.what}`)
    console.log(`       ${row.verdict}`)
    if (row.extra) console.log(`       ${row.extra}`)
    if (row.note) console.log(`       ${row.note}`)
    for (const d of row.detail || []) console.log(`       报红内容：${d}`)
  }
  const mechOkCount = rows.filter((r) => r.mechOk).length
  const genuine = rows.filter((r) => r.genuineFlip).length
  const pending = rows.filter((r) => r.baseRed).length
  console.log('')
  console.log(`基线：${CRITERIA.filter((c) => baseVerdict[c.id]).length}/${CRITERIA.length} 条成立（这是**当前代码的读数**，红不代表装置坏）`)
  console.log(`变异：${MUTATIONS.length} 份 · 机制有效（点名报红且无连带翻转）${mechOkCount} · 其中真绿变红 ${genuine} · 基线本来就红（待复核）${pending} · 无效/连带翻转 ${bad}`)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  console.log('（临时副本已删）')
  process.exit(bad === 0 ? EXIT.PASS : EXIT.DEVICE)
}

// ── 入口 ────────────────────────────────────────────────────────────────────
// 只在「本文件被当作程序直接运行」时执行。被 `import` 时必须只暴露解析/判据函数，
// 不得产生任何输出与副作用（否则诊断脚本一 import 就把整门跑一遍 ⇒ 我实测踩过）。

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (IS_MAIN) {
  if (argv.includes('--selftest')) selftest()
  if (argv.includes('--probe')) probe(readSourceOrExit())

  const src = readSourceOrExit()
  const j = judge(src, 'baseline')
  if (j.fatal) {
    console.error(j.device ? j.fatal : '未能评测：' + j.fatal)
    console.error('本门未能评测：被判对象在评测前就不可加载/解析 ⇒ 非「判据不成立」，也不是通过。')
    process.exit(EXIT.DEVICE)
  }
  const { failed, unverified } = printReport(j, src)
  process.exit(failed === 0 && unverified === 0 ? EXIT.PASS : EXIT.DEFECT)
}
