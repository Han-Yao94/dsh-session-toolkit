#!/usr/bin/env node
/**
 * 「退化钳被调用」契约门（clamp-call.assert.mjs）
 *
 * 守的是什么：`client/client.js` 里拖动钳制的**退化分支真的被调用**，而不是"函数还在、没人调"的死代码。
 *
 * 为什么需要它（这是本条存在的唯一理由，别删）：
 *   抽取式探针（正则抽函数体 → `new Function` 执行）**在原理上看不到调用点**——它的观测面是函数体，
 *   而"有没有被调用"在函数体之外。实测（board/d.md §2.4b，M2/M3 变异）：
 *     · 把 4 处调用全换成等价匿名函数、定义保留 ⇒ 抽取式探针 **仍然 9/9 全绿**；
 *     · 更糟：函数仍在被调用、只把退化保护抽掉 ⇒ 它也 **9/9 全绿**。
 *   ⇒ 「探针全绿」不携带「退化分支真的生效」。而 `node --check`（L0 语法门）对此同样无能为力：
 *     删掉定义、留悬空调用，语法上完全合法（实测 exit 0）。⇒ 两个门的观测面都与本缺陷面不相交。
 *
 * 判据（三条互补，缺一即漏一类形态）：
 *   · `defs == 1`  —— 定义唯一（0 ⇒ 被删；>1 ⇒ 重复定义/被复制）
 *   · `calls >= 1` —— 抓「定义存在、调用全被换成匿名等价物」的死代码形态（M2）
 *   · `calls == 4` —— 抓「只删/注释掉一条调用」的部分退化形态（M4/M5）——它们能过 `>= 1`
 *
 * ⚠️ `4` 是**有意耦合**的：它 = `dx 溢出` / `dx 正常` / `dy 溢出` / `dy 正常` 四条分支各一次调用。
 *    将来若合并分支，本条会**报红**——那是**故意的**：它强制改动者回来更新这里的数字并说明原因，
 *    而不是让一个静默变宽/变窄的观测面留在原地。**不要把它当误报删掉。**
 *    降级形态（A 已采纳为备选）：改成「`>= 1` + 每条分支各一处」的按分支断言。
 *
 * 退出码（align 本仓库 §5.2；**刻意不用 2**——2 是「未完成验证」，不是缺陷，见 scripts/verify.mjs 文件头）：
 *   0 = 三条判据全部成立
 *   1 = 有判据不成立（含读取失败等前置条件不成立——按"无法确立断言"报红，不冒充 2）
 *   64 = 用法错误
 *
 * 用法：
 *   node scripts/clamp-call.assert.mjs                       # 断言本仓库 client/client.js
 *   node scripts/clamp-call.assert.mjs --file <path>         # 断言指定文件（负向对照用）
 *   node scripts/clamp-call.assert.mjs --selftest            # 造三份变异副本自证本门会报红
 *
 * 自证（--selftest）造三种破坏、全部在 os.tmpdir() 的副本上（工作区零写入）：
 *   M2 调用换匿名（定义保留）· M4 注释掉一条调用 · M6 删定义留悬空调用
 *
 * 已知边界（明列，不沉默；§4.13.6 的"未覆盖"纪律）：
 *   · 本条是**文本级**断言：它数的是名字出现的位置，不解析语义。绕开方式有两条：
 *     ① 用别名（`var c = siClampAxis; … c(...)`）——调用点不在名字上；
 *     ② 函数与全部调用一起改名——此时 `defs/calls` 计数仍成立且语义等价，属**可接受**的重命名
 *        （但会把本门弄成"名字对不上"的形态，需同步更新 `NAME`）。
 *     要抗别名需 AST 解析，在本仓库"零依赖"约束下代价不成比例。**当前强度足以守住已知形态。**
 *   · 本条只证明**调用点存在**，不证明被调用时**行为正确**——后者由 `siClamp` 自身的数学性质与
 *     浏览器实测覆盖（board/c.md 的 AC49/AC52/AC53 探针 + 人类所有者 GUI 复验）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXIT = { PASS: 0, FAIL: 1, USAGE: 64 }

/** 现行函数名。旧名 `siClamp1` 已在裁定 #13 退役——**不要**再对它做断言（按字面写会当天即红）。 */
const NAME = 'siClampAxis'
/** 期望的定义处数与调用处数（1：唯一定义；4：四条分支各一次调用，见文件头「有意耦合」）。 */
const EXPECT_DEFS = 1
const EXPECT_CALLS = 4

function usage() {
  console.error('用法：node scripts/clamp-call.assert.mjs [--file <path>] [--selftest]')
  console.error('  --file <path>  待断言文件，默认 client/client.js（相对仓库根解析）')
  console.error('  --selftest     造三份变异副本，自证本门会报红')
}

/**
 * 计数：定义 = 含 `function <NAME>(` 的行；调用 = 含 `<NAME>(` 但不含 `function <NAME>(` 的行。
 * ⚠️ **必须先剥掉行注释再数**：否则「注释掉一条调用」与真调用同形，`calls == 4` 会漏检
 *    （自测 M4 就是抓这个——第一版本门没剥注释，M4 未报红，被 --selftest 当场打出）。
 * 已知粗糙处（刻意保守、不影响本用例）：按行剥 `//`，不识别字符串字面量里的 `//`。
 * @returns {{defs:number, calls:number, oldNameHits:number, defLines:number[], callLines:number[]}}
 */
function audit(src) {
  const lines = src.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, ''))
  const defLines = [], callLines = []
  lines.forEach((l, i) => {
    if (l.includes('function ' + NAME + '(')) defLines.push(i + 1)
    else if (l.includes(NAME + '(')) callLines.push(i + 1)
  })
  return {
    defs: defLines.length,
    calls: callLines.length,
    defLines,
    callLines,
    oldNameHits: (src.match(/siClamp1\s*\(/g) ?? []).length,
  }
}

/** 断言并按 §5.2 口径打印逐条结论。@returns {string[]} 失败项（空 = 全过） */
function judge(label, src) {
  const r = audit(src)
  const failures = []
  const ck = (name, ok, detail) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
    if (!ok) failures.push(`${name}${detail ? '（' + detail + '）' : ''}`)
  }
  ck(`定义唯一：${NAME} 定义 ${EXPECT_DEFS} 处`, r.defs === EXPECT_DEFS, `实测 ${r.defs}${r.defLines.length ? ' @' + r.defLines.join(',') : ''}`)
  ck(`被调用：非定义命中 >= 1`, r.calls >= 1, `实测 ${r.calls}`)
  ck(`每分支一处：非定义命中 == ${EXPECT_CALLS}`, r.calls === EXPECT_CALLS, `实测 ${r.calls}${r.callLines.length ? ' @' + r.callLines.join(',') : ''}`)
  if (r.oldNameHits > 0) {
    console.log(`  note 旧名 siClamp1( 仍有 ${r.oldNameHits} 处命中——它已退役，本门不对它断言（若确为残留，请人工确认）`)
  }
  console.log(`  ${failures.length === 0 ? 'PASS' : 'FAIL'} [${label}]`)
  return failures
}

// ------------------------------------------------------------------ 用法解析
const argv = process.argv.slice(2)
const opts = { file: path.join(ROOT, 'client', 'client.js'), selftest: false }
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--file') {
    if (!argv[i + 1]) { usage(); process.exit(EXIT.USAGE) }
    opts.file = path.isAbsolute(argv[i + 1]) ? argv[i + 1] : path.join(ROOT, argv[i + 1]); i += 1
  } else if (a === '--selftest') {
    opts.selftest = true
  } else if (a === '--help' || a === '-h') {
    usage(); process.exit(EXIT.PASS)
  } else {
    console.error(`未知参数 ${a}`); usage(); process.exit(EXIT.USAGE)
  }
}

console.log(`「退化钳被调用」契约门（clamp-call.assert.mjs）· 目标名 ${NAME} · 仓库 ${ROOT}`)
console.log('')

if (!opts.selftest) {
  if (!existsSync(opts.file)) {
    console.error(`无法断言：文件不存在 —— ${opts.file}`)
    console.error('（前置条件不成立 ⇒ 按 exit 1 报红，**不**用 2——2 是「未完成验证」，见文件头）')
    process.exit(EXIT.FAIL)
  }
  const failures = judge(path.relative(ROOT, opts.file) || opts.file, readFileSync(opts.file, 'utf8'))
  console.log('')
  if (failures.length > 0) {
    console.error(`断言失败 ${failures.length} 条：`)
    for (const f of failures) console.error(`  - ${f}`)
    console.error('提示：若这是分支合并等合法改动，请更新本文件头的 EXPECT_CALLS 与「有意耦合」说明，')
    console.error('      不要直接删掉 == 那条断言——它守的是「部分退化」这一类形态。')
    process.exit(EXIT.FAIL)
  }
  console.log(`三条判据全部成立（定义 ${EXPECT_DEFS} · 调用 >= 1 · 调用 == ${EXPECT_CALLS}）。`)
  process.exit(EXIT.PASS)
}

// ------------------------------------------------------------------ 自证（负向对照）
const src = readFileSync(opts.file, 'utf8')
/** 局部替换：断言发生次数恰为 1，否则判「变异未生效、自测无意义」。 */
function mutateOnce(needle, replacement, label) {
  const hits = src.split(needle).length - 1
  if (hits !== 1) { console.error(`变异「${label}」的锚点命中 ${hits} 次（需恰好 1）⇒ 变异未生效，自测无意义`); return null }
  return src.replace(needle, replacement)
}
const ANON = '(function (lo, hi, v) { return v < lo ? lo : (v > hi ? hi : v) })'

const TMP = mkdtempSync(path.join(os.tmpdir(), 'dsh-st-clampcall-'))
let red = 0
const results = []
try {
  // 基线：真实文件必须绿（否则下面的"报红"可能是门自己坏了）
  console.log('=== 基线（真实文件，必须绿）===')
  const base = judge(path.relative(ROOT, opts.file), src)
  results.push({ label: 'baseline', failures: base, expect: 'green' })
  console.log('')
  // 变异体一律从真实源码改出来（不用硬编码夹具 ⇒ 门坏了会当场暴露）
  const cases = [
    ['M2 四处调用换成等价匿名函数（定义保留）', () => {
      // 只把**调用点**的函数名换成等价匿名函数表达式；定义行不动（`function <NAME>(` 不匹配 `NAME + '('` 之外的形态）
      const callRe = new RegExp('(?<!function )' + NAME + '\\(', 'g')
      const out = src.replace(callRe, ANON + '(')
      const after = (out.split(NAME + '(').length - 1)
      if (after !== 1) throw new Error(`替换后剩余 ${NAME}( 命中 ${after} 处（应只剩定义 1 处）`)
      return out
    }],
    ['M4 注释掉一条调用（部分退化）', () => mutateOnce(`      dx = ${NAME}(-rect.left, vw - rect.right, dx);`,
      `      // dx = ${NAME}(-rect.left, vw - rect.right, dx);`, 'M4')],
    ['M6 删定义、留悬空调用（语法仍合法）', () => mutateOnce(`  function ${NAME}(lo, hi, v) {\n    return v < lo ? lo : (v > hi ? hi : v);\n  }\n`, '', 'M6')],
  ]
  for (const [label, make] of cases) {
    let mutated
    try { mutated = make() } catch (e) { console.error(`变异「${label}」构造失败：${e.message}`); results.push({ label, failures: ['构造失败'], expect: 'red' }); continue }
    if (mutated === null || mutated === src) { console.error(`变异「${label}」未改变源码 ⇒ 自测无意义`); results.push({ label, failures: ['未生效'], expect: 'red' }); continue }
    const f = path.join(TMP, label.slice(0, 2) + '.js')
    writeFileSync(f, mutated)
    console.log(`=== ${label}（副本 ${path.relative(os.tmpdir(), f)}，必须报红）===`)
    const failures = judge(label, mutated)
    results.push({ label, failures, expect: 'red' })
    if (failures.length > 0) red += 1
    console.log('')
  }
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

const baseOk = results[0].failures.length === 0
const allRed = red === results.length - 1
console.log('--- 自证汇总 ---')
console.log(`  基线（真实文件）绿：${baseOk}`)
console.log(`  三个变异体报红数：${red}/${results.length - 1}`)
if (baseOk && allRed) {
  console.log('')
  console.log('本门成立：真实文件绿，且三种破坏形态（死代码 / 部分退化 / 悬空调用）各自报红。')
  console.log(`（临时副本已删；工作区零写入）`)
  process.exit(EXIT.PASS)
}
console.error('')
console.error(`自证失败：基线绿=${baseOk}，报红 ${red}/${results.length - 1}（要求基线绿且全部报红）`)
for (const r of results) if (r.expect === 'red' && r.failures.length === 0) console.error(`  - ${r.label}：未报红（漏检）`)
process.exit(EXIT.FAIL)
