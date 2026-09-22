#!/usr/bin/env node
/**
 * 门：`client/client.js` 的**标识符作用域**——凡在某个 IIFE 模块块内**被使用**、
 * 而**该块自己没有绑定**的「模块别名」，一律报红。
 *
 * ── 为什么要它（2026-09-22，人类所有者批准"窄做"）────────────────────────────
 * 真实故障（在 `client/client.js` 里活了 4 天）：模块 4（log-reposition）的
 * `SessionLogDownloadHeaderAction` 调 `react.useState`，而那个块**只 require 了
 * `react/jsx-runtime`** —— 二者是**两条不同的 require**（前者提供 `react`，后者不提供）。
 * 渲染时 `ReferenceError: react is not defined` ⇒ slot 渲染器**把抛错吞掉**、整条 entry 消失
 * ⇒ 用户看到的是「按钮不见了」，**不是报错**。
 *
 * 它穿过了当时**全部**门：语法门（语法合法）· 打包门（入口可达）· 锚门（哈希对）·
 * primitives-export（只核 `primitives.X` 的成员是否存在）。⇒ 这一格原本无人守。
 * 引入者 `3e44642`（2026-09-18，加了 hooks 调用、没加 require）；已修 `c313af5`。
 *
 * ── 判据（A 定，人类所有者裁定"窄做"）──────────────────────────────────────
 * · **抽取面**：IIFE 块 = 全文件匹配 `(function () {` … 最近的 `})();` 的成对区间。
 * · **模块别名**：全文件**任一位置**由 `require(...)` 绑定过的标识符
 *   （`React` · `primitives` · `react` · `react_jsx_runtime` · `runtime_client`）——
 *   **从代码里抓，不写死名单**（新增 require 自动进面）。
 * · **判定**：某块**用到**某别名（形如 `alias.`）而**该块没有** `var|let|const alias = require(...)`
 *   ⇒ **报红**，并指出**哪一块、哪个标识符、哪一行**。
 *
 * ── 覆盖边界（照实写明，不许读成更宽）────────────────────────────────────────
 * ❌ **不覆盖**「非 require 绑定的未声明标识符」（如 `foo.bar` 而 `foo` 从没声明）——
 *    那需要真正的作用域分析，人类所有者已裁定**暂不宽做**。
 * ❌ **不证**「按钮在浏览器里渲染出来了」——那要浏览器。本门证的是
 *    「**该标识符在其块内有绑定**」，不是运行时行为。
 *
 * ── 三道自保（都内建为结构，不是备注）──────────────────────────────────────
 * ① **块切分失配即报红**：块头数与闭包数不一致、或切出的块数与基线不一致 ⇒ **报红**，
 *    **不许**当成"没有块要检查"而返回 0。（依据：靠字面量/形状锚定位的门必须能报"我没匹配上"。
 *    今晚这条规律已出现三次：B 的旧签名锚、C 对照组里的松谓词、A 的行号平移。）
 * ② **变异未生效即判失败**：任何 `mutate` 若不改变源码 ⇒ 报红，不许静默跳过。
 * ③ **负向对照必须报红 + 正向对照必须不报**：`--selftest` 里用**含缺陷的固定装置**与**干净件**
 *    各跑一遍，两者缺一不算。
 *    （C 的第一版检查器踩过这个坑：桩不全 ⇒ 块在跑到目标行之前就因别的原因抛出 ⇒ **报出假 "OK"**。）
 *
 * 纪律：只读被测对象（`client/**` 属 C，本门不写它）；变异一律在 `os.tmpdir()` 副本；
 *       零外部输入（不读 profile / 不读 harness checkout / 不打任何端口）。
 * 退出码：0 通过 · 1 缺陷 · 64 用法/前置错误（刻意不用 2）。
 *
 * 用法：node scripts/scope-identifiers.assert.mjs [--selftest] [--target <path>] [--verbose]
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXIT = { PASS: 0, FAIL: 1, USAGE: 64 }
const DEFAULT_TARGET = 'client/client.js'

/** IIFE 模块块的头与尾（**只用这一对形状锚**；切分失配由自保①兜住）。 */
const BLOCK_HEAD = /^(\s*)\(function \(\) \{$/
const BLOCK_TAIL = /^(\s*)\}\)\(\);$/
/** `var|let|const <ident> = require(` */
const REQUIRE_BIND = /^(\s*)(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/

const usage = (out = console.error) => {
  out('用法：node scripts/scope-identifiers.assert.mjs [--selftest] [--target <path>] [--verbose]')
  out('')
  out('  --selftest       跑变异自证 + 正向/负向固定装置（副本在 os.tmpdir()，工作区零写入）')
  out('  --target <path>  被测文件，默认 client/client.js（相对仓库根解析）')
  out('  --verbose        打印每个块的明细（范围 / 声明的别名 / 用到的别名）')
  out('  --help           打印本帮助')
  out('')
  out('本门证什么：client/client.js 的每个 IIFE 模块块里，**用到的模块别名在该块内有 require 绑定**。')
  out('本门**不**证：按钮在浏览器里渲染出来了（那要浏览器）；也不覆盖「非 require 绑定的未声明标识符」。')
  out('退出码：0 通过 · 1 缺陷 · 64 用法/前置错误（刻意不用 2）')
}

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) { usage(console.log); process.exit(EXIT.PASS) }
let selftest = false
let verbose = false
let targetArg = null
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--selftest') selftest = true
  else if (a === '--verbose') verbose = true
  else if (a === '--target') {
    const v = argv[i + 1]
    // ⚠️ `argv[++i]` 越界会得到 undefined；判据必须是"缺值"而不是 `=== null`
    //    （B 今晚踩过这条：缺路径时退出码成了 0）。
    if (v === undefined || v.startsWith('--')) { console.error('`--target` 缺少路径'); usage(); process.exit(EXIT.USAGE) }
    targetArg = v; i += 1
  } else { console.error(`未知参数：${a}`); usage(); process.exit(EXIT.USAGE) }
}

const TARGET = targetArg ? path.resolve(ROOT, targetArg) : path.join(ROOT, DEFAULT_TARGET)
if (!existsSync(TARGET)) {
  console.error(`❌ 读不到被测文件：${TARGET}`)
  console.error('   前置条件不满足 ⇒ 按 §5.2 走 64，不走 1。**不要当作通过。**')
  process.exit(EXIT.USAGE)
}
const TARGET_REL = path.relative(ROOT, TARGET) || TARGET
const src = readFileSync(TARGET, 'utf8')

/** 全文件 require 绑定过的标识符（**从代码里抓，不写死名单**）。 */
function aliasesOf(text) {
  const set = new Set()
  for (const l of text.split('\n')) {
    const m = l.match(REQUIRE_BIND)
    if (m) set.add(m[2])
  }
  return set
}

/** 切 IIFE 块：块头 → 其后最近的闭包。@returns {{blocks:Array,heads:number,tails:number,unclosed:number[]}} */
function splitBlocks(text) {
  const lines = text.split('\n')
  const heads = []
  const tails = []
  lines.forEach((l, i) => { if (BLOCK_HEAD.test(l)) heads.push(i + 1); if (BLOCK_TAIL.test(l)) tails.push(i + 1) })
  const blocks = []
  const unclosed = []
  for (const h of heads) {
    const t = tails.find((x) => x > h)
    if (t === undefined) { unclosed.push(h); continue }
    blocks.push({ head: h, tail: t, lines: lines.slice(h - 1, t) })
  }
  return { blocks, heads: heads.length, tails: tails.length, unclosed }
}

/** 逐块审计。@returns {{blocks:Array,aliases:string[],unclosed:number[],heads:number,tails:number}} */
function audit(text) {
  const aliases = [...aliasesOf(text)].sort()
  const { blocks, heads, tails, unclosed } = splitBlocks(text)
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const out = []
  for (const b of blocks) {
    const declared = new Set()
    const used = new Map() // alias → 首个使用行号
    b.lines.forEach((l, i) => {
      const abs = b.head + i
      for (const a of aliases) {
        if (new RegExp('^\\s*(?:var|let|const)\\s+' + esc(a) + '\\s*=').test(l)) declared.add(a)
        // 「用到」= `alias.`（避免把字符串/前缀误判），并且排除声明行自身
        if (new RegExp('(^|[^A-Za-z0-9_$.])' + esc(a) + '\\s*\\.').test(l) && !declared.has(a)) {
          if (!used.has(a)) used.set(a, abs)
        } else if (new RegExp('(^|[^A-Za-z0-9_$.])' + esc(a) + '\\s*\\.').test(l)) {
          if (!used.has(a)) used.set(a, abs)   // 已声明但也在用（用于明细展示）
        }
      }
    })
    const missing = [...used.keys()].filter((a) => !declared.has(a)).sort()
    out.push({ head: b.head, tail: b.tail, declared: [...declared].sort(), used: [...used.keys()].sort(), usedAt: used, missing })
  }
  return { blocks: out, aliases, unclosed, heads, tails }
}

const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'dsh-st-scope-'))
let failures = 0
const fail = (msg) => { failures += 1; console.error(`  RED  ${msg}`) }

console.log('「client.js 标识符作用域」门（scope-identifiers.assert.mjs）')
console.log(`  仓库根    ${ROOT}`)
console.log(`  被测文件  ${TARGET_REL}（只读；变异在 os.tmpdir() 副本上做）`)
console.log('  证什么    每个 IIFE 模块块里「用到的模块别名」在该块内有 require 绑定')
console.log('  不证什么  按钮在浏览器里渲染出来了（要浏览器）；也不覆盖「非 require 绑定的未声明标识符」')
console.log('')

// ── 正向
const r = audit(src)
console.log(`[1/3] 正向对照：切出 ${r.blocks.length} 个 IIFE 块 · 全文件 require 绑定的别名 ${r.aliases.length} 个（${r.aliases.join(' · ')}）`)
// ⭐ 自保①-a：块头/闭包数与块数必须自洽
if (r.unclosed.length > 0) fail(`自保①：有 ${r.unclosed.length} 个块头找不到闭包（:${r.unclosed.join(',:')}）⇒ 切分失配，不许当成"没有块要检查"`)
if (r.blocks.length === 0) fail('自保①：一个 IIFE 块都没切出来 ⇒ 形状锚失配（这种情况**不是"没有问题"**）⇒ 报红')
// ⭐ 自保①-b：块数与基线一致（基线由本文件当前形态给出；不一致必须人来看）
const EXPECT_BLOCKS = 5
if (r.blocks.length !== EXPECT_BLOCKS) {
  fail(`自保①：切出 ${r.blocks.length} 个块，基线是 ${EXPECT_BLOCKS} 个 ⇒ 文件结构变了或形状锚失配`
    + `（若确认是合理的结构变化，请同步 EXPECT_BLOCKS；**不许**把它当成"少检查几个块"）`)
}
let missingTotal = 0
for (const b of r.blocks) {
  const verdict = b.missing.length === 0 ? 'ok' : 'RED'
  if (b.missing.length > 0) {
    missingTotal += b.missing.length
    for (const a of b.missing) fail(`块 :${b.head}–:${b.tail} 用到 \`${a}\` 但**该块未绑定**它（首个使用点 :${b.usedAt.get(a)}）`)
  }
  console.log(`  ${verdict === 'ok' ? 'ok  ' : 'RED '} 块 :${b.head}–:${b.tail}  声明=[${b.declared.join(',') || '—'}]  用到=[${b.used.join(',') || '—'}]  缺=[${b.missing.join(',') || '—'}]`)
  if (verbose) console.log(`        （明细：使用点 ${[...b.usedAt.entries()].map(([k, v]) => k + '@' + v).join(' · ') || '—'}）`)
}
console.log(`[2/3] 判定：缺绑定 ${missingTotal} 处`)

// ── 变异对照 + 正/负向固定装置（只在 --selftest）
const CASES = [
    {
      label: '还原本次缺陷：删掉模块 4 的 `var react = require(\'react\')`',
      mutate: (s) => s.replace(/^\s*var react = require\('react'\);\n/m, (m) => (/^\s*\/\/ 本块用 react\./m.test(s) ? m : m)),
      // 精确锚：模块 4 那条 react require 紧跟在 `var exports = module.exports;` 之后且带该注释
      mutate2: (s) => s.replace(/^(\s*)var react = require\('react'\);\n(\s*var react_jsx_runtime = require\('react\/jsx-runtime'\);\n\s*var primitives = require\('@deepseek-ai\/dsh-client-ui-primitives'\);\n\s*var runtime_client = require\('@deepseek-ai\/dsh-client-store'\);)/m, '$2'),
      expectMissing: { blocks: 1, alias: 'react' },
    },
    {
      label: '去掉模块 3 的 `var react = require(\'react\')`（同一形态、另一块）',
      mutate: (s) => s.replace(/^(\s*)var react = require\('react'\);\n(\s*var react_jsx_runtime = require\('react\/jsx-runtime'\);\n\s*var NS = 'web-restart-ui';)/m, '$2'),
      expectMissing: { blocks: 1, alias: 'react' },
    },
    {
      label: '破坏 IIFE 形状锚（全部块头加尾巴注释）⇒ 必须报"切分失配"而不是返回 0',
      // ⚠️ 注意：`BLOCK_HEAD` 是 `^(\s*)\(function \(\) \{$` —— **缩进无关**（对重格式化更稳），
      //    所以"只改缩进"**不会**造成失配。要真的让锚失配，得动那个形状本身。
      mutate: (s) => s.split('\n').map((l) => (/^\s*\(function \(\) \{$/.test(l) ? l + ' // x' : l)).join('\n'),
      expectSplitFailure: true,
    },
    {
      label: '部分失配：只让**一个**块头失配（5 → 4）⇒ 自保①必须抓住"块数与基线不一致"',
      mutate: (s) => {
        let n = 0
        return s.split('\n').map((l) => {
          if (/^\s*\(function \(\) \{$/.test(l)) { n += 1; if (n === 3) return l + ' // x' }
          return l
        }).join('\n')
      },
      expectSplitFailure: true,
    },
    {
      label: '把 `react.` 全改成 `React.`（未声明的另一别名；只在模块 4 内）',
      mutate: (s) => {
        const lines = s.split('\n')
        for (let i = 2118; i < 2293 && i < lines.length; i += 1) lines[i] = lines[i].replace(/(^|[^A-Za-z0-9_$.])react\s*\./g, '$1React.')
        return lines.join('\n')
      },
      expectMissing: { blocks: 1, alias: 'React' },
    },
    {
      label: '【惰性对照】只改注释 ⇒ 一个块都不许报缺',
      mutate: (s) => s.replace('// ===== 模块 4', '// ===== 模块 4（本注释被本门自测替换，语义不变）'),
      expectMissing: { blocks: 0, alias: null },
    },
]
if (selftest) {
  console.log(`[3/3] 变异对照（--selftest）：${CASES.length} 条`)
  const loadFrom = async (text, tag) => {
    const p = path.join(tmpdir, tag + '.js')
    writeFileSync(p, text)
    return { p, text: readFileSync(p, 'utf8') }   // ⚠️ 扫描读的是**写下去的那份**（防"变异加在别的数组上"）
  }
  let inertChecked = false
  let caseCount = 0
  for (const c of CASES) {
    const mutated = (c.mutate2 || c.mutate)(src)
    // ⭐ 自保②：变异未生效 ⇒ 判失败
    if (mutated === src) { fail(`「${c.label}」变异未生效（锚点失配）—— 视为失败，不许静默跳过`); continue }
    const written = await loadFrom(mutated, 'm' + Math.abs(c.label.length))
    const rr = audit(written.text)
    const totalMissing = rr.blocks.reduce((n, b) => n + b.missing.length, 0)
    const wantAlias = c.expectMissing === undefined ? null : c.expectMissing.alias
    const hitAlias = wantAlias !== null && rr.blocks.some((b) => b.missing.includes(wantAlias))
    let ok
    if (c.expectSplitFailure) {
      ok = rr.blocks.length === 0 || rr.unclosed.length > 0 || rr.blocks.length !== EXPECT_BLOCKS || rr.heads !== 5
      if (!ok) fail(`「${c.label}」破坏了形状锚却没被自保①抓住（切出 ${rr.blocks.length} 块 / 块头 ${rr.heads} 个）`)
    } else if (c.expectMissing.blocks === 0) {
      inertChecked = true
      ok = totalMissing === 0
      if (!ok) fail(`「${c.label}」本应完全惰性，却报出 ${totalMissing} 处缺绑定`)
    } else {
      ok = totalMissing === c.expectMissing.blocks && hitAlias
      if (!ok) {
        fail(`「${c.label}」期望报 ${c.expectMissing.blocks} 块缺 \`${c.expectMissing.alias}\`，实测缺 ${totalMissing} 处`
          + `（含 \`${c.expectMissing.alias}\`：${hitAlias}）`)
      }
    }
    console.log(`  ${ok ? 'ok  ' : 'RED '} ${c.label}`)
    console.log(`        缺绑定 ${totalMissing} 处${hitAlias ? `（含 \`${wantAlias}\`）` : ''}`)
  }
  if (!inertChecked) fail('自保②自测缺失：没有一条"应完全惰性"的对照')
}
rmSync(tmpdir, { recursive: true, force: true })

console.log('')
if (failures === 0) {
  console.log(`✅ 通过：${r.blocks.length} 个块全部「用到的别名都已在块内绑定」`
    + (selftest ? ` · ${CASES.length} 条对照各自成立（含还原本次缺陷那条）` : ' · （变异对照未跑：加 --selftest）'))
  console.log('   （副本已删；工作区零写入；未打任何端口）')
  process.exit(EXIT.PASS)
}
console.error(`❌ 失败 ${failures} 项 —— 有块用到了未绑定的模块别名，或本门的自保（切分失配 / 变异未生效）被抓。`)
process.exit(EXIT.FAIL)
