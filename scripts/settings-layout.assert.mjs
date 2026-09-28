#!/usr/bin/env node
// 设置面板「布局 / 交互」规格符合性门（A 派发 #57-D-1；真源 docs/agents/board/a.md §200.3 缺陷机制 + §200.4 整改规格）。
//
// 判据对象：`client/client.js` 里那一段设置面板 CSS（`var CSS = [ … ].join('\n')`）与同一模块的渲染/交互调用。
// 判据一律**不依赖行号**（行号会漂），只用结构/文本模式；每个断言同时报出实际匹配到几处。
//
// 退出码：0 = 全部判据成立 · 1 = 有判据不成立（缺陷）· 2 = 装置没跑成（不是缺陷）· 64 = 用法错。
//
// ── 本门能证明什么 ────────────────────────────────────────────────────────────
//   只证明「源码文本层面的结构符合 §200.4 规格」。它能红、能定位到具体选择器。
// ── 本门不能证明什么（边界，不得读作通过）───────────────────────────────────
//   1) **不能替代人类真机验收**：我们无法渲染 GUI（需 `dsh web` 打印的带 token URL，裸访问 401）。
//      「白块消失」「标签条不被切」「滚动顺畅」这类**视觉结论只能由人类所有者看**。
//   2) 不验 CSS 优先级/层叠（同名属性后者覆盖前者这类问题本门看不见）。
//   3) 不验平台侧真实 token 值（只验引用的是 `--dsw-alias-*` 平台 token 名，不验其解析结果）。
//   4) 不验 `client/client.js` 之外的样式来源（官方 CSS / 内联 style 不在判据内）。
//
// ── 自保 ──────────────────────────────────────────────────────────────────────
//   ① 每条断言配一次「负向对照」（`--selftest`）：把违例注入临时副本 ⇒ 该断言**必须报红**；
//      报不出红即说明这条断言不会失败（= 没有检查），本门自证失败退出 2。
//   ② 变异未生效即判失败：注入前后源码逐字节相同 ⇒ 报「对照无效」，绝不当成“通过”。
//   ③ 未点名断言不得被连带翻转：变异只许让它点名的那条翻红，其余必须保持原判。
//   ④ 观测装置自证：CSS 块必须先被解析到（声明条数 > 0），否则退出 2（防止“恒 0 命中”被读成通过）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EXIT = { PASS: 0, DEFECT: 1, DEVICE: 2, USAGE: 64 }
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TARGET_REL = 'client/client.js'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法：
  node scripts/settings-layout.assert.mjs                基线判据（对现盘 ${TARGET_REL}）
  node scripts/settings-layout.assert.mjs --selftest     逐条负向对照（把违例注入临时副本，必须报红）
  node scripts/settings-layout.assert.mjs --source <f>   指定被测源码（供自证/调试）
  node scripts/settings-layout.assert.mjs --help

退出码：0 判据全成立 · 1 有判据不成立 · 2 装置没跑成 · 64 用法错`)
  process.exit(EXIT.PASS)
}
let sourcePath = path.join(ROOT, TARGET_REL)
if (argv.includes('--source')) {
  const i = argv.indexOf('--source')
  const v = argv[i + 1]
  if (!v) { console.error('用法错：--source 需要一个路径'); process.exit(EXIT.USAGE) }
  sourcePath = path.resolve(v)
}
const unknown = argv.filter((a, i) => !['--selftest', '--source'].includes(a) && !(i > 0 && argv[i - 1] === '--source'))
if (unknown.length) { console.error('用法错：不认识的参数 ' + unknown.join(' ')); process.exit(EXIT.USAGE) }

// ── 源码解析 ────────────────────────────────────────────────────────────────

function readSource() {
  if (!fs.existsSync(sourcePath)) { console.error(`装置没跑成：找不到被测源码 ${sourcePath}`); process.exit(EXIT.DEVICE) }
  return fs.readFileSync(sourcePath, 'utf8')
}

// 设置面板 CSS 块 = 文件里**最后一段** `var CSS = [ … ].join('\n')`（前面还有两个模块各自的 CSS）。
// 判据：从最后一个 `var CSS = [` 到其后最近的 `].join(` 之间。
export function extractCssBlock(src) {
  const startIdx = src.lastIndexOf('var CSS = [')
  if (startIdx === -1) return null
  const endIdx = src.indexOf('].join(', startIdx)
  if (endIdx === -1) return null
  const rawInner = src.slice(startIdx + 'var CSS = ['.length, endIdx)
  const cssText = jsStringsToCss(rawInner)
  return {
    start: startIdx,
    end: endIdx,
    text: cssText,
    raw: rawInner,
    rules: parseRules(cssText),
  }
}

// 极简 CSS 规则解析器：只处理本文件实际用到的形态（单层选择器 / 声明块 / 无嵌套 / 无 @media）。
// 输出 { selector, decls: { prop: value }, raw }。`@keyframes` 这类 at-rule 记入 atRules 并跳过其块体。
// 块体是 JS 字符串数组（每行一个 `'...'` 字面量，行尾带逗号）：先把字面量内容抽出来拼成纯 CSS，
// 再对纯 CSS 解析规则。务必分两步——直接在混着 JS 引号/逗号/换行的原文上匹配选择器，
// 会把上一行的尾巴吞成选择器（实测 89 条规则一条选择器都对不上）。
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

// 取「恰好以该选择器开头」的规则（避免 .dsw-tab 命中 .dsw-tab:hover / .dsw-tabs 等）
function ruleFor(rules, selector) {
  return rules.filter((r) => r.selector === selector)
}
function rulesWithPrefix(rules, prefix) {
  return rules.filter((r) => r.selector === prefix || r.selector.startsWith(prefix + ':') || r.selector.startsWith(prefix + ' ') || r.selector.startsWith(prefix + '.'))
}

function cssNumbers(v) {
  const vals = []
  for (const n of String(v).matchAll(/(-?\d+(?:\.\d+)?)(px|%)?/g)) {
    vals.push(n[2] === '%' ? { num: Number(n[1]), unit: '%' } : { num: Number(n[1]), unit: n[2] || '' })
  }
  return vals
}
// 从 CSS 长度值里取 px 数值。必须**先取数值再判**：用 `!/^0\.5px$/` 这类整串正则会把
// `0.5px solid var(...)` 这种带后续关键字的写法直接判错（平台真源就是这一形态）。
// 也不能用 cssNumbers（它只认 `\d+`，`.5px` 这种省略前导零的写法会退化成 5px）。
export function pxValue(v) {
  const m = String(v).match(/(?:^|[\s(])(\d+(?:\.\d+)?|\.\d+)\s*px/)
  return m ? Number(m[1]) : null
}
export function hasFlexOne(v) {
  return String(v).split(/\s+/).includes('1')
}
function overflowIsScroll(v) {
  const s = String(v).trim()
  return /^(auto|scroll)$/.test(s) && s !== 'hidden'
}

// ── 五条断言 ────────────────────────────────────────────────────────────────
// 约定：返回 { out: [失败条目原文], notes: [读数] }；out 非空 = 该判据不成立。
// 成功说明一律进 notes，绝不混进 out（否则 out.length 恒 > 0 ⇒ 判据恒红）。

export function A1_no_page_stretch(ctx) {
  const src = (ctx && ctx.src) || ''
  const rules = (ctx && ctx.rules) || []
  const out = [], notes = []
  const page = ruleFor(rules, '.dsw-page')
  const card = ruleFor(rules, '.dsw-card')
  notes.push(`.dsw-page 规则 ${page.length} 处 · .dsw-card 规则 ${card.length} 处`)
  if (page.length === 0) out.push('找不到 `.dsw-page` 规则（判据对象缺失）')
  if (card.length === 0) out.push('找不到 `.dsw-card` 规则（判据对象缺失）')
  for (const r of page) {
    if (r.decls['min-height']) {
      for (const n of cssNumbers(r.decls['min-height'])) {
        if (n.unit === '%' && n.num >= 100) out.push(`.dsw-page 带 min-height:${r.decls['min-height']}（页面级拉伸源）`)
      }
    }
    if (r.decls['flex'] !== undefined && hasFlexOne(r.decls['flex'])) out.push(`.dsw-page 带 flex:${r.decls['flex']}（页面级拉伸源）`)
    if (r.decls['height'] && /^100%$/.test(r.decls['height'].trim())) out.push(`.dsw-page 带 height:100%（等价拉伸）`)
  }
  for (const r of card) {
    if (r.decls['flex'] !== undefined && hasFlexOne(r.decls['flex'])) out.push(`.dsw-card 带 flex:${r.decls['flex']}（卡片被撑满 = 余量成卡内空白）`)
    if (r.decls['min-height']) {
      for (const n of cssNumbers(r.decls['min-height'])) {
        if (n.unit === '%' && n.num >= 100) out.push(`.dsw-card 带 min-height:${r.decls['min-height']}（等价拉伸）`)
      }
    }
  }
  const pageDom = (src.match(/className: 'dsw-page(?: [^']*)?'/g) || []).length
  const cardDom = (src.match(/className: 'dsw-card(?: [^']*)?'/g) || []).length
  notes.push(`DOM 面 .dsw-page 用法 ${pageDom} 处 · .dsw-card 用法 ${cardDom} 处`)
  if (pageDom === 0) out.push('DOM 里没有 .dsw-page（判据对象缺失，可能是改名了）')
  return { out, notes }
}

export function A2_no_nested_scroll(ctx) {
  const rules = (ctx && ctx.rules) || []
  const out = [], notes = []
  // 平台外壳已经给了滚动容器（.options{overflow-y:auto}）⇒ 我们自己的样式里不得再出现「滚动 + 限高」组合。
  const textareaCls = new Set(['dsw-area', 'dsw-group-name-input', 'dsw-file-input'])
  let overflowOnly = 0, maxHeightOnly = 0, both = 0
  for (const r of rules) {
    const ov = r.decls['overflow'] ?? r.decls['overflow-y']
    const mh = r.decls['max-height'] ?? r.decls['max-block-size']
    const ovScroll = ov !== undefined && overflowIsScroll(ov)
    const hasMax = mh !== undefined
    if (!ovScroll && !hasMax) continue
    notes.push(`  ${r.selector}  overflow=${ov ?? '-'}  max-height=${mh ?? '-'}`)
    if (ovScroll && !hasMax) overflowOnly++
    if (!ovScroll && hasMax) maxHeightOnly++
    if (ovScroll && hasMax) {
      const cls = (r.selector.match(/\.(dsw-[a-z0-9-]+)/) || [])[1]
      if (cls && textareaCls.has(cls)) { notes.push(`  ⇒ ${r.selector} 是文本域类（豁免）`); continue }
      both++
      out.push(`嵌套滚动组合：${r.selector} 同时有 overflow:${ov} 与 max-height:${mh}（滚动应归外壳，单一滚动上下文）`)
    }
  }
  notes.push(`读数：仅 overflow 者 ${overflowOnly} 处 · 仅 max-height 者 ${maxHeightOnly} 处 · 两者并存者 ${both} 处`)
  notes.push(`豁免名单（文本域）：${[...textareaCls].join(' ')}`)
  return { out, notes }
}

export function A3_native_tabs(ctx) {
  const rules = (ctx && ctx.rules) || []
  const out = [], notes = []
  const tabs = ruleFor(rules, '.dsw-tabs')
  const tab = ruleFor(rules, '.dsw-tab')
  const tabActive = ruleFor(rules, '.dsw-tab.active')
  const tabAfter = ruleFor(rules, '.dsw-tab.active::after')
  if (tabs.length === 0) out.push('找不到 `.dsw-tabs` 规则（判据对象缺失）')
  if (tab.length === 0) out.push('找不到 `.dsw-tab` 规则（判据对象缺失）')
  for (const r of tabs) {
    const bb = r.decls['border-bottom']
    if (!bb) out.push('.dsw-tabs 缺 `border-bottom`（原生形态要求行底分隔线）')
    else if (!/var\(--dsw-alias-border-l2\)/.test(bb)) out.push(`.dsw-tabs 行底线用的不是平台 token：${bb}`)
    // 宽度判据（真源 `PluginsSettingsSection.module.css:27` = `border-bottom: 0.5px solid var(--dsw-alias-border-l2);`）。
    // 只判 token 会让 `1px solid var(--dsw-alias-border-l2)` 照样变绿——半个检查等于没有检查。
    else if (pxValue(bb) !== 0.5) out.push(`.dsw-tabs 行底线宽度 = ${pxValue(bb) === null ? '取不到长度' : pxValue(bb) + 'px'}，平台真源 :27 是 0.5px：${bb}`)
    else notes.push(`.dsw-tabs border-bottom = ${bb}（宽度 0.5px ✓ 与真源 :27 一致）`)
  }
  for (const r of tab) {
    const bg = r.decls['background'] ?? r.decls['background-color']
    if (bg !== undefined && !/^(transparent|none)$/.test(bg.trim())) out.push(`.dsw-tab 带填充背景：background:${bg}（原生形态 = 纯文字标签，无填充）`)
    if (r.decls['font-size'] && !/^13px$/.test(r.decls['font-size'])) out.push(`.dsw-tab 字号 ${r.decls['font-size']} ≠ 平台 13px`)
    if (r.decls['color'] && !/var\(--dsw-alias-label-tertiary\)/.test(r.decls['color'])) out.push(`.dsw-tab 常态色用的不是平台 token：${r.decls['color']}`)
    // 底边：**平台原生 `.tab` 自己没有 border-bottom**（真源 :31-41 = `border: 0`），激活条由
    // `.dsw-tab.active::after` 的 `bottom:-1px` 压在 `.dsw-tabs` 的行底线上。所以这里要断言的是
    // 「**不得**多出一条占位底边」，而不是「必须有底边」——后者会要求实现偏离原生形态。
    // 旧实现正是这样写的：`border-bottom:2px solid transparent;margin-bottom:-1px`（负边距用来
    // 抵消那 2px），而 A 追加判据（board §203.7）要求删掉它：`::after` 的 `bottom:-1px` 相对
    // padding box 解析 ⇒ 多出的 2px 会把激活条抬到行底线上方约 2px。
    const bbTab = r.decls['border-bottom']
    if (bbTab !== undefined) {
      const w = pxValue(bbTab)
      if (w === 0) { /* `border-bottom:0` 与 `border:0` 等价，不算缺陷 */ }
      else if (w === null || w > 0) out.push(`.dsw-tab 多出一条占位底边 border-bottom:${bbTab}（平台原生 .tab 是 border:0；该边会把 ::after 激活条自 padding box 抬到行底线上方）`)
    }
  }
  for (const r of tabActive) {
    const bg = r.decls['background'] ?? r.decls['background-color']
    if (bg !== undefined && !/^(transparent|none)$/.test(bg.trim())) out.push(`.dsw-tab.active 带填充背景：background:${bg}（截图里的「填充蓝块」即此）`)
    if (r.decls['border-bottom-color'] !== undefined) out.push('.dsw-tab.active 直接改 border-bottom-color（规格要求改用 ::after 2px 条）')
  }
  if (tabAfter.length === 0) out.push('缺 `.dsw-tab.active::after`（规格：激活 = ::after 2px 条）')
  else notes.push(`.dsw-tab.active::after = { ${Object.entries(tabAfter[0].decls).map(([k, v]) => k + ':' + v).join('; ')} }`)
  notes.push(`命中：.dsw-tabs ${tabs.length} · .dsw-tab ${tab.length} · .dsw-tab.active ${tabActive.length} · ::after ${tabAfter.length}`)
  return { out, notes }
}

export function A4_platform_scale_and_tokens(ctx) {
  const rules = (ctx && ctx.rules) || []
  const out = [], notes = []
  const title = ruleFor(rules, '.dsw-title')
  const desc = ruleFor(rules, '.dsw-desc')
  if (title.length === 0) out.push('找不到 `.dsw-title` 规则（判据对象缺失）')
  if (desc.length === 0) out.push('找不到 `.dsw-desc` 规则（判据对象缺失）')
  for (const r of title) {
    if (r.decls['font-size'] && r.decls['font-size'] !== '18px') out.push(`.dsw-title 字号 ${r.decls['font-size']} ≠ 平台标题 18px`)
    if (r.decls['font-weight'] && r.decls['font-weight'] !== '600') out.push(`.dsw-title 字重 ${r.decls['font-weight']} ≠ 平台 600`)
    if (r.decls['color'] && !/var\(--dsw-alias-label-primary\)/.test(r.decls['color'])) out.push(`.dsw-title 颜色未直接取平台 token：${r.decls['color']}`)
  }
  for (const r of desc) {
    if (r.decls['font-size'] && r.decls['font-size'] !== '13px') out.push(`.dsw-desc 字号 ${r.decls['font-size']} ≠ 平台副标题 13px`)
    if (r.decls['color'] && !/var\(--dsw-alias-label-tertiary\)/.test(r.decls['color'])) out.push(`.dsw-desc 颜色未直接取平台 token：${r.decls['color']}`)
  }
  // 「不得经自建 --dsw-text-* 别名中转」：只对标题/副标题/标签条三类关键元素判，避免误伤别处。
  const keySelectors = ['.dsw-title', '.dsw-desc', '.dsw-tab', '.dsw-tab.active']
  let viaAlias = 0
  for (const sel of keySelectors) {
    for (const r of ruleFor(rules, sel)) {
      for (const [k, v] of Object.entries(r.decls)) {
        if (/^color$/.test(k) && /var\(--dsw-text-/.test(v)) {
          viaAlias++
          out.push(`${sel} 的 color 经自建别名中转：${v}（规格要求直取 var(--dsw-alias-*))`)
        }
      }
    }
  }
  notes.push(`命中：.dsw-title ${title.length} · .dsw-desc ${desc.length} · 经 --dsw-text-* 中转的颜色声明 ${viaAlias} 处`)
  return { out, notes }
}

// 取函数体（大括号配平；同时支持 `function f() {` 与 `function f(\n  a\n) {` 两种签名形态）。
// 不用行号：从 "function <name>" 往后找第一对配平的大括号，字符串/模板/注释里的括号不计入。
export function extractFunctionBody(src, name) {
  const key = 'function ' + name
  const at = src.indexOf(key)
  if (at === -1) return null
  const afterName = at + key.length
  if (/[A-Za-z0-9_$]/.test(src[afterName] || '')) return null   // 防止命中 f 而把 f2 当成 f
  let i = src.indexOf('(', afterName)
  if (i === -1) return null
  let depth = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) { i++; break } }
  }
  let j = src.indexOf('{', i)
  if (j === -1) return null
  let d = 0
  for (let k = j; k < src.length; k++) {
    const c = src[k]
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      k++
      while (k < src.length) {
        if (src[k] === '\\') { k += 2; continue }
        if (src[k] === q) break
        k++
      }
      continue
    }
    if (c === '/' && src[k + 1] === '/') { while (k < src.length && src[k] !== '\n') k++; continue }
    if (c === '/' && src[k + 1] === '*') { k += 2; while (k < src.length && !(src[k] === '*' && src[k + 1] === '/')) k++; k++; continue }
    if (c === '{') d++
    else if (c === '}') { d--; if (d === 0) return src.slice(j, k + 1) }
  }
  return null
}

function countMatches(src, re) {
  // 一律补上 g：无 g 的 lastIndex 不推进 ⇒ 同一处匹配被反复计数（这条我实测踩过一次死循环）。
  const rx = re.global ? re : new RegExp(re.source, re.flags + 'g')
  rx.lastIndex = 0
  let n = 0
  let m
  let guard = 0
  while ((m = rx.exec(src)) !== null) {
    n++
    // 零宽匹配的推进守卫必须判「本次匹配长度为 0」。写成 `m.index === re.lastIndex` 是错的：
    // 对非零宽匹配该式永假（m.index 是起点、lastIndex 是起点+长度）⇒ exec 反复返回同一处 ⇒ **死循环**。
    // 我实测就是踩了这一条：门在 A5 处挂死 6 s 无输出、CPU 满载（CPU profile 被 SIGTERM 打断，拿不到产物）。
    if (m[0].length === 0) rx.lastIndex++
    if (++guard > 5000000) throw new Error('countMatches 失控（超过 5e6 次匹配，正则或输入异常）')
  }
  return n
}

const RE_FN_SET_TAB = /\bsetTab\s*\(/
const RE_SCROLL_INTO_VIEW = /scrollIntoView\s*\(/
const RE_BLOCK_START = /block\s*:\s*'start'/
const RE_BLOCK_NEAREST = /block\s*:\s*'nearest'/
// 「赋值一份本地状态（调用任何 setXxx(...)）」：排除 .set / .slice / .push / .every / .indexOf / .indexOf 这类成员调用。
const RE_STATE_COMMIT = /(?<![.\w$])set[A-Z][A-Za-z0-9_$]*\s*\(/g

// A5：切页归位。
// 判据对象 = 切页回调 `setTabSafely` 的函数体 + 它到 TabBar 的接线。
// 只证「结构」：源码里确实有一个既有 setTab(...) 又有受守卫的 scrollIntoView({block:'start'}) 的回调，
// 且该回调被传给了标签条的 onTab 属性。**不证时序、不证视觉结果**（真机验收归人类所有者）。
export function A5_scroll_reset_on_tab_change(ctx) {
  const src = (ctx && ctx.src) || ''
  const out = [], notes = []
  // 装置自证面：这些读数必须 > 0，否则说明观测路径没搭上（零命中先怀疑探针）。
  const fnCount = (src.match(/function\s+setTabSafely/g) || []).length
  const scrollCountAll = countMatches(src, /scrollIntoView\s*\(/g)
  notes.push(`全文件：function setTabSafely ${fnCount} 处 · scrollIntoView ${scrollCountAll} 处`)
  if (fnCount === 0) {
    out.push('找不到切页回调 `setTabSafely`（判据对象缺失）')
    return { out, notes }
  }
  const body = extractFunctionBody(src, 'setTabSafely')
  if (!body) { out.push('解不出 `setTabSafely` 的函数体（装置解析失败）'); return { out, notes } }
  const callsSetTab = countMatches(body, RE_FN_SET_TAB)
  const callsScroll = countMatches(body, RE_SCROLL_INTO_VIEW)
  const guarded = /typeof\s+pageRef\.current\.scrollIntoView\s*===\s*'function'/.test(body)
  const hasStart = RE_BLOCK_START.test(body)
  const hasNearest = RE_BLOCK_NEAREST.test(body)
  let commits = 0
  const reCommit = new RegExp(RE_STATE_COMMIT.source, 'g')
  let mcm
  while ((mcm = reCommit.exec(body)) !== null) commits++
  notes.push(`setTabSafely 体内：setTab( ${callsSetTab} 处 · 本地状态提交 ${commits} 处 · scrollIntoView( ${callsScroll} 处 · typeof 守卫 ${guarded ? '有' : '无'} · block:'start' ${hasStart ? '有' : '无'} · block:'nearest' ${hasNearest ? '有' : '无'}`)
  const wiring = /onTab\s*:\s*setTabSafely/.test(src)
  const tabBarWiring = /createElement\(\s*TabBar\s*,\s*\{[^}]*onTab\s*:\s*setTabSafely/.test(src)
  notes.push(`接线：onTab: setTabSafely ${wiring ? '有' : '无'} · TabBar 上 ${tabBarWiring ? '有' : '无'}`)
  if (callsSetTab === 0) out.push('`setTabSafely` 体内没有 setTab(...)：切页没有先提交本地状态')
  if (callsScroll === 0) out.push('`setTabSafely` 体内没有 scrollIntoView(...)：切页不会归位（§200.3 缺陷 4）')
  if (callsScroll > 0 && !guarded) out.push('`scrollIntoView` 没有 `typeof … === \'function\'` 守卫（裸调用可能抛）')
  if (callsScroll > 0 && !hasStart) {
    out.push(hasNearest
      ? "scrollIntoView 用的是 `{ block: 'nearest' }`（≠ 规格要求的 `'start'`）：\'nearest\' 仅在元素出视野时最小滚动，**不保证回到滚动容器顶部** ⇒ §200.4-5「切标签时把根滚回顶部」未满足"
      : "scrollIntoView 未带 `{ block: 'start' }`（规格 §200.4-5 要求 block:'start' 或等价写法）")
  }
  if (!wiring || !tabBarWiring) out.push('`setTabSafely` 没有接到标签条的 onTab 上（写了却没人调用 = 空转）')
  notes.push(`真源：docs/agents/board/a.md §200.4 第 5 条（切页归位，scrollIntoView({block:'start'}) 或等价写法）`)
  return { out, notes }
}

// A6：会话勾选框的「点击 → 本地先落地」结构（#57-D-1 追加，人类所有者报的延迟症状）。
// 症状机制（A 已定位，出现在被修之前的版本里）：onSessionsChange 勾一下直接写宿主，
// 而成员列表来自宿主快照 prop、复选框是受控 checked ⇒ 点击到快照回灌之间 React 把框弹回旧态 = 可见延迟。
// 本判据只证**结构**：① 处理函数体内有**同步**的状态提交（不在 timeout/防抖回调里）；
// ② 写宿主（gpScope.set）发生在别处（防抖 flush），不在这个处理函数体内；
// ③ 宿主快照回灌的 effect 有「有在途写入就不跟」的守卫（否则旧快照会把勾选弹回去）。
// **不证时序、不证延迟消失**——静态文本无法证明一次 React 渲染往返里到底发生了什么（真机验收归人类所有者）。
export function A6_checkbox_local_echo(ctx) {
  const src = (ctx && ctx.src) || ''
  const out = [], notes = []
  if (src.indexOf('function onSessionsChange') === -1) {
    out.push('找不到 `onSessionsChange`（判据对象缺失：会话勾选的处理函数被改名/删除了？）')
    return { out, notes }
  }
  const handler = extractFunctionBody(src, 'onSessionsChange')
  if (!handler) { out.push('解不出 `onSessionsChange` 的函数体（装置解析失败）'); return { out, notes } }
  // 去掉注释再读，别把注释里的伪代码当成真代码。
  const code = handler
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  // ① 同步提交：分支体内、且不在 ctx.timeout/setTimeout 回调里
  let commit = 0, commitOutsideTimer = 0
  {
    const re = new RegExp(RE_STATE_COMMIT.source, 'g')
    let m
    while ((m = re.exec(code)) !== null) {
      commit++
      // 用大括号配平判断「这个提交点是否落在某个 timer 回调体内」——不用正则回溯（`[^]*?` 这类写法
      // 在大文件上会指数级回溯，我实测把门挂死过一次：一次基线跑 60 s 不返回，移到后台才看见）。
      const before = code.slice(0, m.index)
      let d = 0, inTimer = false
      for (let i = before.length - 1; i >= 0; i--) {
        const c = before[i]
        if (c === '}') d++
        else if (c === '{') {
          d--
          if (d < 0) {
            const head = before.slice(Math.max(0, i - 60), i)
            if (/(ctx\.timeout|setTimeout)\s*\(/.test(head)) inTimer = true
            break
          }
        }
      }
      if (!inTimer) commitOutsideTimer++
    }
  }
  notes.push(`onSessionsChange 体内：状态提交 ${commit} 处（其中不在 timer 回调里的 ${commitOutsideTimer} 处）`)
  if (commitOutsideTimer === 0) out.push('`onSessionsChange` 体内没有**同步**（非 timer 回调内）的状态提交（没有 setXxx(...)）⇒ 勾选不会立即反映到本地受控值上 = 可见延迟的结构')
  // ② 写宿主不得在这个处理函数体内
  const writesInHandler = countMatches(code, /gpScope\.set\s*\(/g) + countMatches(code, /scope\.set\s*\(\s*'groups'/g)
  if (writesInHandler > 0) out.push(`\`onSessionsChange\` 体内直接写宿主 ${writesInHandler} 处（勾一下即写宿主的形态）`)
  // ③ 宿主快照回灌 effect 的守卫
  let guarded = 0, echoEffects = 0, hostReads = 0
  const reFn = /useEffect\s*\(\s*function\s*\([^)]*\)\s*\{/g
  let m
  while ((m = reFn.exec(src)) !== null) {
    const start = m.index + m[0].length - 1
    let d = 0, end = -1
    for (let k = start; k < src.length; k++) {
      const c = src[k]
      if (c === "'" || c === '"' || c === '`') {
        const q = c; k++
        while (k < src.length) { if (src[k] === '\\') { k += 2; continue } if (src[k] === q) break; k++ }
        continue
      }
      if (c === '{') d++
      else if (c === '}') { d--; if (d === 0) { end = k; break } }
    }
    if (end === -1) continue
    const body = src.slice(start, end + 1)
    if (!/\.sessions\b/.test(body)) continue
    echoEffects++
    if (/if\s*\(\s*pendingSessionsRef\.current\s*\)\s*return/.test(body)) guarded++
    if (/(?:Array\.isArray\s*\(|typeof\s+)[^;\n]*\.sessions/.test(body)) hostReads++
  }
  notes.push(`宿主快照回灌 effect：命中 ${echoEffects} 个（按「effect 体里出现 .sessions」识别）· 其中带 pending 守卫 ${guarded} 个 · 带宿主读盘 ${hostReads} 个`)
  if (echoEffects === 0) out.push('找不到「宿主快照回灌会话」的 effect（判据对象缺失）')
  else if (guarded === 0) out.push('宿主快照回灌的 effect 没有「有在途写入就不跟」的守卫（`if (pendingSessionsRef.current) return`）⇒ 旧快照会把勾选弹回旧态 = 可见延迟的结构')
  notes.push('真源：A 追加派发（勾选框延迟症状）；本判据只覆盖同步提交 / 写宿主位置 / 快照回灌守卫三处结构')
  return { out, notes }
}

export const CRITERIA = [
  { id: 'A1', name: '页面根/卡片不得是拉伸件（.dsw-page 无 min-height:100%、无 flex:1；.dsw-card 无 flex:1）', fn: A1_no_page_stretch, needsCss: true },
  { id: 'A2', name: '不得出现嵌套滚动组合（非文本域元素上 overflow:auto/scroll 与 max-height 并存）', fn: A2_no_nested_scroll, needsCss: true },
  { id: 'A3', name: '标签条为原生文字标签形态（无填充背景 + 行底 0.5px var(--dsw-alias-border-l2) + ::after 激活条）', fn: A3_native_tabs, needsCss: true },
  { id: 'A4', name: '标题/副标题取平台字号量（18/13）且颜色直取平台 token（不经自建 --dsw-text-* 别名）', fn: A4_platform_scale_and_tokens, needsCss: true },
  { id: 'A5', name: '切页归位：setTabSafely 内有 setTab(...) + 受守卫的 scrollIntoView({block:\'start\'})，且接到 TabBar 的 onTab', fn: A5_scroll_reset_on_tab_change, needsCss: true },
  { id: 'A6', name: '会话勾选：处理函数同步提交本地状态、不直接写宿主，且宿主快照回灌有 pending 守卫', fn: A6_checkbox_local_echo, needsCss: true },
]

// ── 变异（每条断言一次负向对照）──────────────────────────────────────────────
// 约定：`replace: [旧串, 新串, 期望命中次数]`；命中数不符或替换后源码未变 ⇒ 对照无效（不是“通过”）。
export const MUTATIONS = [
  {
    id: 'M1', crit: 'A1',
    what: '给 .dsw-card 注入 flex:1（= 本门要禁止的拉伸件）',
    replace: ['.dsw-card{width:100%;', '.dsw-card{width:100%;flex:1;', 1],
  },
  {
    id: 'M2', crit: 'A2',
    what: '给 .dsw-groups-list 注入 overflow-y:auto + max-height:320px（= 嵌套滚动组合）',
    kind: 'inject-decl', selector: '.dsw-groups-list', decl: 'overflow-y:auto;max-height:320px;',
  },
  {
    id: 'M3', crit: 'A3',
    what: '给 .dsw-tab.active 注入填充背景（= 截图里的填充药丸）',
    kind: 'inject-decl', selector: '.dsw-tab.active', decl: 'background:var(--dsw-alias-state-business-tertiary);',
  },
  {
    id: 'M4', crit: 'A4',
    what: '把 .dsw-title 的字号改成 21px（= 平台 18px 之外）',
    kind: 'set-decl-number', selector: '.dsw-title', prop: 'font-size', value: '21px',
  },
  {
    id: 'M5', crit: 'A5',
    what: "把切页回调里的 `{ block: 'start' }` 改成 `{ block: 'nearest' }`（形式还在、归位语义没了）",
    replace: ["pageRef.current.scrollIntoView({ block: 'start' });", "pageRef.current.scrollIntoView({ block: 'nearest' });", 1],
  },
  {
    id: 'M6', crit: 'A5',
    what: '拆掉切页回调到标签条的接线（onTab 改传原始 setTab）——归位函数还在但没人调用',
    replace: ['onTab: setTabSafely', 'onTab: setTab', 1],
  },
  {
    id: 'M7', crit: 'A6',
    what: '勾选框：去掉处理函数里的**同步本地更新**（删掉会话引用赋值 + setSessions，只留防抖写宿主）',
    kind: 'remove-sync-commit',
  },
  {
    id: 'M8', crit: 'A6',
    what: '勾选框：去掉宿主快照回灌的 pending 守卫（有在途写入也照样用旧快照覆盖本地值）',
    kind: 'remove-pending-guard',
  },
  {
    id: 'M9', crit: 'A3',
    what: '标签条行底线由 0.5px 加粗到 1px（token 不变 ⇒ 只判 token 的版本会漏掉）',
    kind: 'set-decl-number', selector: '.dsw-tabs', prop: 'border-bottom',
    from: '0.5px solid var(--dsw-alias-border-l2)', value: '1px solid var(--dsw-alias-border-l2)',
  },
  {
    id: 'M10', crit: 'A3',
    what: '给 .dsw-tab 注入占位底边 `border-bottom:2px solid transparent`（= 旧实现那行，会把 ::after 激活条抬高 2px）',
    kind: 'inject-decl', selector: '.dsw-tab', decl: 'border-bottom:2px solid transparent;',
  },
]

// 变异用：按**选择器形状**定位「选择器 + 声明块」，把违例注入进去。
// 两条我实测踩过的坑都写在这里，别再退回去：
//   ① 不钉死整段 CSS 字面量——钉死的版本因为实现里把 gap 从 8 改成 12 就「旧串命中 0 次」而整条对照作废
//      （装置失效被读成“对照无效”，不是代码红了）。
//   ② 不用 `new RegExp('(\\' + esc + ')…')` 拼反斜杠——JS 里 `'\\'` 是**一个**反斜杠字符，与 esc 里的
//      反斜杠再叠一层，正则要求的就变成字面反斜杠，`.dsw-groups-list` 永远匹配不到（我实测
//      pattern 显示为 `(\\\\.dsw-groups-list)`，命中 null）。改用纯 indexOf + 边界判定，无转义面。
// 边界判定是必需的：`.dsw-title` 在源码里出现 3 次（`.dsw-title-row` / `.dsw-title-group` 各含一次），
// 只取 indexOf 会命中 `.dsw-title-row` 的规则体，变异注错地方 ⇒ 点名判据不红却看着像“装置坏了”。
function findRuleSpan(src, selector, expect) {
  const want = expect === undefined ? 1 : expect
  const all = []
  for (let i = 0; ; ) {
    const k = src.indexOf(selector, i)
    if (k === -1) break
    all.push(k)
    i = k + 1
  }
  const starts = all.filter((k) => {
    const after = src[k + selector.length]
    if (/[A-Za-z0-9_-]/.test(after || '')) return false     // 属于 .dsw-title-row / .dsw-tabs 这类更长选择器
    const open = src.indexOf('{', k)
    if (open === -1 || open - (k + selector.length) > 40) return false
    return /^[\s,]*$/.test(src.slice(k + selector.length, open))   // 选择器与 { 之间只允许空白/逗号
  })
  if (starts.length !== want) {
    return { err: `选择器 ${selector} 命中规则体 ${starts.length} 处 ≠ 期望 ${want} 处（字面出现 ${all.length} 次；锚点写窄了或实现变了 ⇒ 先怀疑探针，别当成对照通过）` }
  }
  return { starts }
}

function ruleBodyAt(src, at, selector) {
  const open = src.indexOf('{', at)
  const close = src.indexOf('}', open)
  if (open === -1 || close === -1) return null
  return { selAt: at, open, close, decls: src.slice(open + 1, close) }
}

function injectDecl(src, selector, decl, expect) {
  const found = findRuleSpan(src, selector, expect)
  if (found.err) return { ok: false, why: found.err }
  const span = ruleBodyAt(src, found.starts[0], selector)
  if (!span) return { ok: false, why: `找不到规则体 ${selector}{...}` }
  const prop = decl.split(':')[0]
  if (span.decls.includes(prop + ':')) return { ok: false, why: `${selector} 里已经存在 ${prop}（变异会退化成同义反复）` }
  const text = src.slice(0, span.open + 1) + decl + src.slice(span.open + 1)
  if (text === src) return { ok: false, why: '变异未生效（替换后源码逐字节相同）' }
  return { ok: true, text }
}

// 把某条声明里的一个长度值改掉。两种调用形态：
//   ① value：按 prop 找第一条 `<prop>: <n>px` 就地改数（用于 `.dsw-title{font-size:18px}` 这种单值声明）
//   ② from→value：prop 的值是复合值（如 `border-bottom: 0.5px solid var(--x)`），必须连**旧值**一起匹配，
//      否则会把 `solid var(--x)` 后面或别处的 px 改错地方。
// 三档失败必须给不同 why，否则「探针没跑成」和「对照无效」会混成同一个读数（自保①）。
function setDeclNumber(src, selector, prop, value, expect, from) {
  const found = findRuleSpan(src, selector, expect)
  if (found.err) return { ok: false, why: found.err }
  const span = ruleBodyAt(src, found.starts[0], selector)
  if (!span) return { ok: false, why: `找不到规则体 ${selector}{...}` }
  let re
  if (from) {
    const hit = span.decls.split(prop + ':' + from).length - 1
    if (hit !== 1) {
      return { ok: false, why: `${selector} 里 \`${prop}: ${from}\` 命中 ${hit} 次 ≠ 期望 1 次（锚点写窄了或实现变了 ⇒ 先怀疑探针，别当成对照通过）` }
    }
    re = new RegExp('(^|;)\\s*' + prop + '\\s*:\\s*' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  } else {
    re = new RegExp('(^|;)\\s*' + prop + '\\s*:\\s*[0-9.]+px')
    if (!re.test(span.decls)) return { ok: false, why: `${selector} 的声明里没有可改的 ${prop}: <n>px` }
  }
  const fixed = span.decls.replace(re, (s0, p1) => p1 + prop + ':' + value)
  const text = src.slice(0, span.open + 1) + fixed + src.slice(span.close)
  if (text === src) return { ok: false, why: '变异未生效（替换后源码逐字节相同）' }
  return { ok: true, text }
}

export function applyMutation(src, m) {
  // 判据是「处理函数体内有没有同步提交」⇒ 负向对照必须把**同步**这一环真的拿掉，而不是把整段删空
  // （整段删空会让多条断言一起崩，分不清是谁抓到的）。
  if (m.kind === 'remove-sync-commit') {
    const oldS = '      sessionsRef.current = next;\n      setSessions(next);\n'
    const n = src.split(oldS).length - 1
    if (n !== 1) return { ok: false, why: `变异锚点命中 ${n} 次 ≠ 期望 1 次（锚点写窄了或实现变了，先怀疑探针）` }
    const newS = '      var next = Array.isArray(nextSessions) ? nextSessions.slice() : [];   // 变异：本地同步提交被拿掉\n      void String(next.length);\n'
    const text = src.replace(oldS, newS)
    if (text === src) return { ok: false, why: '变异未生效（替换后源码逐字节相同）' }
    return { ok: true, text }
  }
  if (m.kind === 'remove-pending-guard') {
    const oldS = '    if (pendingSessionsRef.current) return;\n'
    const n = src.split(oldS).length - 1
    if (n !== 1) return { ok: false, why: `变异锚点命中 ${n} 次 ≠ 期望 1 次（锚点写窄了或实现变了，先怀疑探针）` }
    const newS = '    if (pendingSessionsRef.current && false) return;   // 变异：守卫被短路\n'
    const text = src.replace(oldS, newS)
    if (text === src) return { ok: false, why: '变异未生效（替换后源码逐字节相同）' }
    return { ok: true, text }
  }
  if (m.kind === 'inject-decl') {
    return injectDecl(src, m.selector, m.decl, m.expect)
  }
  if (m.kind === 'set-decl-number') {
    return setDeclNumber(src, m.selector, m.prop, m.value, m.expect, m.from)
  }
  const [oldS, newS, expect] = m.replace
  const n = src.split(oldS).length - 1
  if (n !== expect) return { ok: false, why: `旧串命中 ${n} 次 ≠ 期望 ${expect} 次` }
  const text = src.replace(oldS, newS)
  if (text === src) return { ok: false, why: '变异未生效（替换后源码逐字节相同）' }
  return { ok: true, text }
}

// ── 判定 ────────────────────────────────────────────────────────────────────

export function judge(src, label) {
  const css = extractCssBlock(src)
  if (!css) return { fatal: 'CSS 块解析失败（找不到 `var CSS = [` … `].join(`）', results: [] }
  if (css.rules.length === 0) return { fatal: 'CSS 块解析出 0 条规则（观测装置没搭上）', results: [] }
  const results = CRITERIA.map((c) => {
    let r
    try { r = c.fn({ src, rules: css.rules, css }) } catch (e) { return { id: c.id, name: c.name, err: String(e && e.message || e) } }
    return { id: c.id, name: c.name, fails: r.out, notes: r.notes }
  })
  return { css, results, label }
}

function printReport(j, src) {
  const bytes = Buffer.byteLength(src, 'utf8')
  const sha = sha256(src)
  console.log(`被测：${sourcePath}`)
  console.log(`指纹：sha256=${sha} · ${bytes} B · CSS 块规则 ${j.css.rules.length} 条`)
  console.log('')
  let failed = 0
  for (const c of CRITERIA) {
    const r = j.results.find((x) => x.id === c.id)
    if (!r) { console.log(`  ?? ${c.id} 没有结果`); failed++; continue }
    if (r.err) { console.log(`  !! ${c.id} ${c.name}\n     判据抛错：${r.err}`); failed++; continue }
    if (r.fails.length === 0) console.log(`  ok ${c.id} ${c.name}`)
    else { failed++; console.log(`  FAIL ${c.id} ${c.name}`); for (const f of r.fails) console.log(`       · ${f}`) }
    for (const n of r.notes || []) console.log(`       ${n}`)
  }
  console.log('')
  console.log(failed === 0 ? `PASS：${CRITERIA.length} 条判据全部成立` : `FAIL：${failed}/${CRITERIA.length} 条判据不成立`)
  return failed
}

// ESM 下没有 require：用 createRequire 拿标准库（不算第三方依赖）
import { createRequire } from 'node:module'
const _req = createRequire(import.meta.url)
function sha256(s) { return _req('node:crypto').createHash('sha256').update(s, 'utf8').digest('hex') }

// ── 自证（逐条负向对照）─────────────────────────────────────────────────────

function selftest() {
  const src = readSource()
  const base = judge(src, 'baseline')
  if (base.fatal) { console.error('装置没跑成：' + base.fatal); process.exit(EXIT.DEVICE) }
  const baseVerdict = {}
  for (const c of CRITERIA) {
    const r = base.results.find((x) => x.id === c.id)
    baseVerdict[c.id] = r && !r.err && r.fails.length === 0
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsw-layout-selftest-'))
  let bad = 0
  const rows = []
  for (const m of MUTATIONS) {
    const a = applyMutation(src, m)
    if (!a.ok) { rows.push({ m, verdict: '对照无效：' + a.why, ok: false }); bad++; continue }
    const f = path.join(tmpDir, `mut-${m.id}.js`)
    fs.writeFileSync(f, a.text, 'utf8')
    const j = judge(a.text, m.id)
    if (j.fatal) { rows.push({ m, verdict: '对照无效：' + j.fatal, ok: false }); bad++; continue }
    const r = j.results.find((x) => x.id === m.crit)
    const named = r && !r.err && r.fails.length > 0
    const passOf = (res) => !!(res && !res.err && Array.isArray(res.fails) && res.fails.length === 0)
    // 判「被翻转」= 判定**变了**。写成 `baseVerdict[c.id] === passOf(...)` 是错的：它判的是「没变」，
    // 于是所有**没被动到**的判据全被计成「连带翻转」，唯一真变的点名判据反而漏掉（我实测报出
    // 「点名判据报红 0 · 连带翻转 8」这个自相矛盾的读数，就是这一行）。另外 `r.fails.length` 在
    // 判据抛错（r.err）时是 TypeError，会把装置自己炸掉 —— 必须走 Array.isArray。
    const flipped = CRITERIA.filter((c) => baseVerdict[c.id] !== passOf(j.results.find((x) => x.id === c.id)))
      .map((c) => c.id)
    // 三件事分开判，绝不混同：
    //   ① 机制有效 = 点名判据**报红**且**没有任何未点名判据被连带翻转**（`named` + `collateral`）。
    //   ② 真正的「绿变红」= 机制有效 **且基线该判据是绿的**（`genuineFlip`）。这才是标准负向对照。
    //   ③ 基线本来就红的判据（如 C 尚未交付的 A3/A4）做不到② —— 记成「机制有效，但只证注入生效效果、
    //      **绿变红待复核**」。**不得当成通过**，也不得因为②做不到就把机制判成坏。
    //   我踩过的坑：把 `onlyNamedFlipped`（要求 flipped 恰好 = [点名判据]）当成机制有效的条件 ⇒ 对基线已红的
    //   判据 flipped 恒为空 ⇒ 装置自证失败退出 2，而这其实是**被测对象的问题**，不是装置的问题。
    const collateral = flipped.filter((x) => x !== m.crit)
    const mechOk = !!named && collateral.length === 0
    const genuineFlip = mechOk && baseVerdict[m.crit] === true
    const baseRed = mechOk && baseVerdict[m.crit] === false
    if (!mechOk) bad++
    rows.push({
      m, mechOk, genuineFlip, baseRed, collateral,
      verdict: !named ? '**没报红 ⇒ 这条断言是空的**'
        : collateral.length ? '**点名判据报红，但有未点名判据被连带翻转**'
          : '报红（符合预期）',
      extra: `未点名判据被连带翻转：${collateral.join(' ') || '0 条'}`,
      note: genuineFlip ? '' : (baseRed ? '基线该判据本来就红 ⇒ 只证「注入生效让点名判据报出这条」；**绿变红待实现修好后复核**' : ''),
      detail: r && r.fails ? r.fails : [],
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

if (argv.includes('--selftest')) selftest()

const src = readSource()

const j = judge(src, 'baseline')
if (j.fatal) { console.error('装置没跑成：' + j.fatal); process.exit(EXIT.DEVICE) }
const failed = printReport(j, src)
process.exit(failed === 0 ? EXIT.PASS : EXIT.DEFECT)
