#!/usr/bin/env node
/**
 * 门：「rc1 基座」四条断言（裁定 #rc1-D-2①：判据本体落在这里，本文件头即权威说明）。
 *
 * ── 它证什么、不证什么（**不许把推断读成端到端**）──────────────────────────
 * ✅ 能证：**给定一棵基座树**，① 它的依赖解析面真的落在 0.2.0-rc.1 一线（不是 alpha.1 跨代）；
 *          ② `auto-resume` 契约门在该基座上 21/21；③ 既有 23 条命令在该基座上全绿；
 *          ④ 该基座与 alpha.1 基座的**同一批命令输出**归一化后一致（细则见下）。
 * ❌ 不证：**「插件在 rc1 宿主里跑得起来」**。这四条全是**文件系统 + 子进程**级的读数，
 *          没有宿主进程、没有浏览器、没有真实 profile。端到端面不在本门，别拿它当兼容性证明。
 * ❌ 不证：**跨代组合已经消失**。本门只测「基座是什么」，不测「宿主怎么加载它」。
 *
 * ── 为什么要有这道门（2026-09-28 D 的第三波侦察，`board/d.md` §94-D）────────
 * 那一波的否定性结论是：**既有 20 个门对 rc1 是「版本盲」的**——把解析根从 alpha.1 换成
 * 真 0.2.0-rc.1，23 条命令输出**归一化后逐字节相同（0/23 不同）**，且机器抽取证明
 * 门脚本的**非相对非内置 import = 0 条**（没有门直接 import 依赖包）。
 * ⇒ 现状的绿**证明不了**兼容，`host rc1 × plugin alpha.1` 这类跨代组合能一路绿到发布。
 * 本门就是把这个空白补上：**把「基座是什么」变成一条会红的断言**。
 *
 * ── 四条断言（各自独立判红，缺一不可）──────────────────────────────────
 *  A 解析面：从基座自身解析 `@deepseek-ai/*` 与 cordis/schemastery ⇒ 五个 rc1 包**版本齐一** ·
 *    **不带 alpha 后缀**（本门要挡的就是「宿主 rc1 × 插件 alpha.1」）· cordis ≥ 4.0.4 ·
 *    schemastery ≥ 3.18.4。期望值**不硬编码版本号**（硬编码会把「基线漂移」误报成「解析错」），
 *    只查「同一版 + 非 alpha + 不低于 rc1 要求的两个下限」。
 *  B 契约：`scripts/auto-resume.contract.selftest.mjs` 在基座里跑 ⇒ 必须 21/21 且 EXIT 0。
 *    **它同时钉住前置**：没有 `.git` 或历史不全时该门 EXIT 3（`fatal: not a git repository`）
 *    ⇒ 本门把这种情况判为**前置不成立（EXIT 3）**，不判红也不放过（详见「退出码」）。
 *  C 回归哨兵：把该项目**现存的**门命令逐条在基座上跑 ⇒ 全绿。命令清单**现场抽取**
 *    （`.github/workflows/npm-publish.yml` 的 `run: node scripts/...` + `package.json` 的
 *    `scripts.*`），**不手抄**——手抄清单一旦漏项，哨兵就静默缩小了作用域。
 *    ⚠ C **不是**「rc1 兼容」的证据（版本盲），它只是防回归。
 *  D 异常判据（裁定 #rc1-D-2②）：把同一批命令在**两个基座**（rc1 / alpha.1）上各跑一遍，
 *    输出做**归一化**后对拍。**有差异 ⇒ EXIT 1（判红）**，不是「升级人工复核」——
 *    CI 里没有人工，无人值守时「升级复核」等于丢弃信号；真有门对依赖版本敏感，
 *    正是必须阻住发布的事。报文会打印「哪些命令敏感」。
 *    归一化**必须口径完整**：路径（基座自身路径 / `TMPDIR`）、临时目录名（`*-XXXXXX`）。
 *    口径不全 ⇒ **假差异**（§94-D 首版就漏了 `/var/folders/**\/dsw-*-XXXXXX`，误报 2 条）。
 *
 * ── 退出码（照本项目口径，**刻意不用 2**）────────────────────────────
 *   0  = 四条断言全部成立
 *   1  = 有断言不成立（缺陷）
 *   3  = **前置条件不成立 ⇒ 未完成验证，不得读作通过**（基座/对照基座不存在 · 命令清单抽不出 ·
 *        包无法解析 · 基座没有 `.git` 完整历史 · `auto-resume` 报 3）
 *   64 = 用法错误
 *   ⚠ fail-closed：**任何取不到读数的情况一律走 3，不走 0**（取不到 ≠ 通过）。
 *   ⚠ 两种问题同时存在时**取 3 而不是 1**：3 表示「这一轮没验证完」，比「有断言不成立」更强，
 *     不允许用一条红把「还有断言根本没跑到」掩盖掉。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────
 * · **只读**：本门不写被测基座、不写本仓工作区（selftest 的造物全在 `os.tmpdir()`）。
 * · **不联网、不 install**：装 rc1 基座是 **job 的**事（钉精确版本 + pnpm store 缓存），
 *   本门只**验证**基座（`--base` 指向的树必须已经装好）。
 * · **不碰活端口、不碰 profile**：本门只起子进程跑 node，不发任何网络请求。
 * · **管道取码**：本门一律用 `spawnSync` 取 `status`；若在 shell 里取码，必须 `${PIPESTATUS[0]}`
 *   或先落文件再取码——`cmd | sed ; echo $?` 取到的是 `sed` 的 0，**会说谎**（§94-D.6 实测）。
 *
 * ── 基座怎么来（job 侧三步；`/tmp` 不保证存活，系统清理后按此重建）──────────
 *   1. `git clone --no-hardlinks <repo> <base>`（**`.git` 必须完整**：`fetch-depth: 0`）
 *   2. 基座必须是**干净提交树**（`git status --porcelain` 为空）——带未提交改动会让锚门报红
 *   3. 独立目录内 `package.json` **七条全写精确版本**（`@deepseek-ai/dsh-tools@0.2.0-rc.1` 等）
 *      再 `pnpm install --store-dir <store> --ignore-scripts`（**不要让 pnpm 自己选**：
 *      同一份并集声明 npm 选 rc1、pnpm 选 0.1.7-rc.2，见 `board/a.md` §252.3）
 *
 * 用法：
 *   node scripts/rc1-basis.assert.mjs --base <rc1基座> [--alpha-base <对照基座>] [--verbose]
 *   node scripts/rc1-basis.assert.mjs --selftest        # 真调自身，四条断言各配会失败的负对照
 *   node scripts/rc1-basis.assert.mjs --help
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXIT = { PASS: 0, FAIL: 1, INCOMPLETE: 3, USAGE: 64 }

/** rc1 一线的五个包：本门要求它们**版本齐一且不带 alpha 后缀**。 */
const RC1_PKGS = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
]
/** rc1 各包在 `peerDependencies` 里收紧到的下限（缺省值；`--min-cordis` 可覆盖）。 */
const MIN_CORDIS = '4.0.4'
const MIN_SCHEMASTERY = '3.18.4'
/** `auto-resume` 契约门在本项目的用例总数（B 断言的期望值）。 */
const AUTO_RESUME_TOTAL = 21

const usage = (out = console.error) => {
  out('用法：node scripts/rc1-basis.assert.mjs --base <rc1基座> [--alpha-base <对照基座>] [--commands <cmd,cmd>]')
  out('      node scripts/rc1-basis.assert.mjs --selftest [--verbose]')
  out('')
  out('  --base <dir>        rc1 基座（已装好钉版依赖的树；本门只读它）')
  out('  --alpha-base <dir>  对照基座（alpha.1 树）；给了就执行 D 断言，**少了它 D 判前置不成立（3）**')
  out('  --commands <list>   覆盖命令清单（逗号分隔；缺省=从工作流与 package.json 现场抽取）')
  out('  --selftest          真调自身，四条断言各配一条会失败的负对照')
  out('  --verbose           打印每条命令的读数与归一化摘要')
  out('  --help              打印本帮助')
  out('')
  out('退出码：0 全部成立 · 1 有断言不成立 · 3 前置条件不成立（未完成验证，不得读作通过）· 64 用法错')
  out('')
}

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) { usage(console.log); process.exit(EXIT.PASS) }

let base = null
let alphaBase = null
let commandsOverride = null
let selftest = false
let verbose = false
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--base') { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) { console.error('`--base` 需要一个目录'); process.exit(EXIT.USAGE) } base = v; i += 1 }
  else if (a === '--alpha-base') { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) { console.error('`--alpha-base` 需要一个目录'); process.exit(EXIT.USAGE) } alphaBase = v; i += 1 }
  else if (a === '--commands') { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) { console.error('`--commands` 需要一个逗号分隔的命令清单'); process.exit(EXIT.USAGE) } commandsOverride = v.split(',').map((s) => s.trim()).filter(Boolean); i += 1 }
  else if (a === '--selftest') { selftest = true }
  else if (a === '--verbose') { verbose = true }
  else { console.error(`未知参数：${a}`); usage(); process.exit(EXIT.USAGE) }
}
if (!selftest && base === null) { console.error('缺少 `--base`（或改用 `--selftest`）'); usage(); process.exit(EXIT.USAGE) }

// ── 小工具 ──────────────────────────────────────────────────────────────
const say = (s) => process.stdout.write(`${s}\n`)
const log = (s) => { if (verbose) process.stdout.write(`    ${s}\n`) }

/** 跑一条命令（`node <args>`），cwd 指定在基座里；**用 spawnSync 的 status，不碰管道退出码**。 */
function run (cwd, args, timeout = 300000) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout, env: { ...process.env } })
  return { status: r.status === null ? 'TIMEOUT' : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error?.code ?? null }
}

/** 现场抽取命令清单：工作流的 `run: node scripts/...` + `package.json` 的 `scripts.*`（不手抄）。 */
function extractCommands (root) {
  const wf = path.join(root, '.github/workflows/npm-publish.yml')
  const pkgFile = path.join(root, 'package.json')
  if (!existsSync(wf) || !existsSync(pkgFile)) return null
  const y = readFileSync(wf, 'utf8')
  const ci = [...y.matchAll(/run:\s*node\s+(scripts\/[^\s"'#]+(?:\s+--?[^\s"'#]+)*)/g)].map((m) => m[1])
  let npm = []
  try { npm = Object.values(JSON.parse(readFileSync(pkgFile, 'utf8')).scripts ?? {}).map((v) => String(v).replace(/^node\s+/, '')).filter((v) => v.startsWith('scripts/')) } catch { return null }
  const list = [...new Set([...ci, ...npm])]
  return list.length > 0 ? list : null
}

/** 归一化：把**会因基座/临时目录而变**的字面抹平；口径必须完整，否则会造出假差异。 */
export function normalizeOutput (text, roots = []) {
  let s = text
  // 长路径先替换，避免短路径前缀把长路径切碎（`/tmp/d-rc1/a` 是 `/tmp/d-rc1/ab` 的前缀）
  const sorted = [...roots].filter(Boolean).map(String).sort((a, b) => b.length - a.length)
  for (const r of sorted) {
    const variants = new Set([r, r.replace(/^\/private/, ''), `/private${r}`, r.replace(/^\/var/, '/private/var')])
    for (const v of variants) if (v.length > 1) s = s.split(v).join('<BASE>')
  }
  s = s.replace(/\/private\/tmp\/[^\s"']+|\/tmp\/[^\s"']+/g, '<TMP>')
  s = s.replace(/\/var\/folders\/[^\s"']+/g, '<TMPDIR>')
  // 归一化是**递归**的：`/tmp` 被抹成 `<TMP>` 之后，临时目录名就**不再带斜杠前缀**了
  // （剩下 `dsh-st-clampcall-XXXXXX` 这种裸名）⇒ 必须单独再抹一道。否则两棵树的随机临时名
  // 会造出**假差异**（§94-D 首版栽过一次：漏了一种形态就误报 2 条；本轮真树复跑又栽一次）。
  s = s.replace(/\b(?:dsh|dsw|sa|dsb|pc)[A-Za-z0-9-]*-[A-Za-z0-9]{6,8}\b/g, '<TMPNAME>')
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>')
  return s.split('\n').map((l) => l.trimEnd()).join('\n').trim()
}

const cmpVersion = (a, b) => {
  const pa = String(a).split('-')[0].split('.').map(Number)
  const pb = String(b).split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

// ── 断言 A：解析面 ───────────────────────────────────────────────────────
/**
 * 在基座里解析五个 rc1 包 + cordis + schemastery。**子进程的 cwd = 基座** ⇒ 裸 specifier 的
 * 解析基准就是基座自己（Node 从发起模块位置向上找 `node_modules`）。
 */
function assertResolution (baseDir) {
  const probe = `
    const { createRequire } = require('node:module')
    const req = createRequire(${JSON.stringify(path.join(baseDir, 'package.json'))})
    const out = {}
    for (const p of ${JSON.stringify([...RC1_PKGS, '@deepseek-ai/cordis', '@deepseek-ai/schemastery'])}) {
      try {
        const pj = req(p + '/package.json')
        out[p] = { version: pj.version, path: req.resolve(p + '/package.json') }
      } catch (e) { out[p] = { error: e.code || String(e.message).slice(0, 60) } }
    }
    console.log(JSON.stringify(out))
  `
  const r = run(baseDir, ['-e', probe])
  if (r.status !== 0) return { ok: false, incomplete: true, why: `解析探针跑不起来（status=${r.status}${r.error ? ` · ${r.error}` : ''}）：${r.out.trim().slice(0, 200)}` }
  let got
  try { got = JSON.parse(r.out.trim().split('\n').pop()) } catch { return { ok: false, incomplete: true, why: `解析探针输出不是 JSON：${r.out.trim().slice(0, 200)}` } }

  const problems = []
  const unresolved = Object.entries(got).filter(([, v]) => v.error)
  if (unresolved.length > 0) {
    return { ok: false, incomplete: true, why: `有包无法解析（未完成验证，不得读作通过）：${unresolved.map(([k, v]) => `${k}=${v.error}`).join(' · ')}`, readings: got }
  }
  const versions = [...new Set(RC1_PKGS.map((p) => got[p].version))]
  if (versions.length !== 1) problems.push(`五个 rc1 包版本不齐一：${RC1_PKGS.map((p) => `${p.replace('@deepseek-ai/', '')}=${got[p].version}`).join(' · ')}`)
  const v = versions.length === 1 ? versions[0] : versions[0]
  if (/alpha/i.test(String(v))) problems.push(`解析到 alpha 线（跨代组合：宿主 rc1 × 插件 alpha）= ${v}`)
  if (cmpVersion(got['@deepseek-ai/cordis'].version, MIN_CORDIS) < 0) problems.push(`cordis ${got['@deepseek-ai/cordis'].version} < 下限 ${MIN_CORDIS}`)
  if (cmpVersion(got['@deepseek-ai/schemastery'].version, MIN_SCHEMASTERY) < 0) problems.push(`schemastery ${got['@deepseek-ai/schemastery'].version} < 下限 ${MIN_SCHEMASTERY}`)
  for (const [p, g] of Object.entries(got)) {
    // ⚠ 必须**两侧都 realpath** 再比：macOS 的 `/tmp` 是 `/private/tmp` 的符号链接，
    //   基座实现在 `/private/tmp/...` 时，字面比较会把「落点正确」误判成「不在基座内」（本轮实测踩过）。
    const rel = path.relative(realpathSync.native(baseDir), realpathSync.native(path.dirname(g.path)))
    if (rel.startsWith('..') || path.isAbsolute(rel)) problems.push(`${p} 的落点不在基座内：${g.path}`)
  }
  return { ok: problems.length === 0, why: problems.join(' | '), readings: got, version: v }
}

// ── 断言 B：auto-resume 契约门 ────────────────────────────────────────────
function assertAutoResume (baseDir) {
  const script = path.join(baseDir, 'scripts/auto-resume.contract.selftest.mjs')
  if (!existsSync(script)) return { ok: false, incomplete: true, why: `基座里没有 ${path.relative(baseDir, script)}` }
  if (!existsSync(path.join(baseDir, '.git'))) return { ok: false, incomplete: true, why: '基座没有 `.git`（该门要读 HEAD 历史取「已知坏代码」；`fetch-depth: 0` 没做）' }
  const r = run(baseDir, ['scripts/auto-resume.contract.selftest.mjs'])
  const m = r.out.match(/共\s*(\d+)\s*条：通过\s*(\d+)，失败\s*(\d+)/)
  if (r.status === EXIT.INCOMPLETE) return { ok: false, incomplete: true, why: `该门自己报「前置条件不成立」（EXIT 3）⇒ 基座不满足前置。原文：${r.out.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 160)}` }
  if (!m) return { ok: false, incomplete: true, why: `读数取不到（status=${r.status}）：${r.out.trim().slice(-200)}` }
  const [, total, pass, fail] = m.map(Number)
  if (r.status !== 0 || fail !== 0 || total !== AUTO_RESUME_TOTAL) return { ok: false, why: `期望 ${AUTO_RESUME_TOTAL}/${AUTO_RESUME_TOTAL} 且 EXIT 0；实测 共 ${total} 条：通过 ${pass}，失败 ${fail}（EXIT ${r.status}）` }
  return { ok: true, detail: `共 ${total} 条：通过 ${pass}，失败 ${fail}` }
}

// ── 断言 C：既有命令回归哨兵 ──────────────────────────────────────────────
function assertSentinel (baseDir, commands) {
  const results = []
  for (const cmd of commands) {
    const [file, ...rest] = cmd.split(/\s+/)
    if (!existsSync(path.join(baseDir, file))) { results.push({ cmd, status: 'MISSING' }); continue }
    const r = run(baseDir, [file, ...rest])
    results.push({ cmd, status: r.status, head: r.out.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 120) ?? '' })
    log(`C ${String(r.status).padEnd(7)} ${cmd}`)
  }
  const missing = results.filter((r) => r.status === 'MISSING')
  if (missing.length > 0) return { ok: false, incomplete: true, why: `基座里缺命令文件：${missing.map((m) => m.cmd.split(/\s+/)[0]).join(' · ')}`, results }
  const bad = results.filter((r) => r.status !== 0)
  if (bad.length > 0) return { ok: false, why: `${bad.length}/${results.length} 条非 0：${bad.map((b) => `[${b.status}] ${b.cmd} —— ${b.head}`).join(' || ')}`, results }
  return { ok: true, detail: `${results.length}/${results.length} 条 EXIT 0`, results }
}

// ── 断言 D：两基座输出对拍（差异 ⇒ 判红）──────────────────────────────────
function assertDifferential (rc1Dir, alphaDir, commands) {
  const diffs = []
  const normalized = {}
  for (const cmd of commands) {
    const [file, ...rest] = cmd.split(/\s+/)
    const a = run(rc1Dir, [file, ...rest])
    const b = run(alphaDir, [file, ...rest])
    const na = normalizeOutput(a.out, [rc1Dir, alphaDir])
    const nb = normalizeOutput(b.out, [alphaDir, rc1Dir])
    normalized[cmd] = { rc1: na, alpha: nb }
    if (a.status !== b.status || na !== nb) diffs.push({ cmd, statusRc1: a.status, statusAlpha: b.status, same: na === nb })
    log(`D ${a.status === b.status && na === nb ? '同 ' : '异 '} ${cmd}`)
  }
  if (diffs.length === 0) return { ok: true, detail: `${commands.length}/${commands.length} 条归一化后一致（0 条对依赖版本敏感）`, normalized }
  return { ok: false, why: `有 ${diffs.length} 条对依赖版本敏感 ⇒ 判红（裁定 #rc1-D-2②）：${diffs.map((d) => `${d.cmd}（status ${d.statusRc1} vs ${d.statusAlpha}${d.same ? '' : ' · 输出不同'}）`).join(' || ')}`, diffs, normalized }
}

// ── 主流程（四条断言，各自独立判红；3 优先于 1 记账）───────────────────────
function runAll ({ baseDir, alphaDir, commands }) {
  const report = { assertions: {}, exit: EXIT.PASS }
  say(`rc1 基座门 · 基座 = ${baseDir}`)
  say(`            对照基座 = ${alphaDir ?? '（未给 ⇒ D 断言前置不成立）'}`)

  if (!existsSync(baseDir) || !existsSync(path.join(baseDir, 'scripts'))) {
    say(`未完成验证：基座不存在或不像一棵仓库树 —— ${baseDir}`)
    return { report, exit: EXIT.INCOMPLETE }
  }

  // A
  const A = assertResolution(baseDir)
  report.assertions.A = A
  say(`A 解析面            ${A.ok ? '成立' : A.incomplete ? '未完成' : '不成立'}${A.ok ? `（${A.version}）` : `：${A.why}`}`)
  if (A.ok) for (const [p, g] of Object.entries(A.readings)) log(`A ${p} v${g.version} → ${g.path}`)

  // B
  const B = assertAutoResume(baseDir)
  report.assertions.B = B
  say(`B auto-resume 契约  ${B.ok ? `成立（${B.detail}）` : B.incomplete ? '未完成' : '不成立'}${B.ok ? '' : `：${B.why}`}`)

  // C
  const C = assertSentinel(baseDir, commands)
  report.assertions.C = C
  say(`C 既有命令哨兵      ${C.ok ? `成立（${C.detail}）` : C.incomplete ? '未完成' : '不成立'}${C.ok ? '' : `：${C.why}`}`)

  // D
  let D
  if (alphaDir === null) D = { ok: false, incomplete: true, why: '未给 `--alpha-base` ⇒ 对拍无对照（未完成验证，不得读作通过）' }
  else if (!existsSync(alphaDir)) D = { ok: false, incomplete: true, why: `对照基座不存在 —— ${alphaDir}` }
  else D = assertDifferential(baseDir, alphaDir, commands)
  report.assertions.D = D
  say(`D 两基座对拍        ${D.ok ? `成立（${D.detail}）` : D.incomplete ? '未完成' : '不成立'}${D.ok ? '' : `：${D.why}`}`)

  const incomplete = Object.values(report.assertions).filter((x) => x.incomplete).length
  const failed = Object.values(report.assertions).filter((x) => !x.ok && !x.incomplete).length
  const exit = incomplete > 0 ? EXIT.INCOMPLETE : failed > 0 ? EXIT.FAIL : EXIT.PASS
  say('')
  say(`RESULT: ${exit === EXIT.PASS ? 'PASS —— 四条断言全部成立' : exit === EXIT.INCOMPLETE ? 'INCOMPLETE —— 有前置条件不成立（未完成验证，不得读作通过）' : 'FAIL —— 有断言不成立'}（EXIT ${exit}）`)
  return { report, exit }
}

// ── selftest：真调自身，四条断言各配一条**会失败**的负对照 ──────────────────
function makeFixtureTree (dir, { versions, autoResumeExit = 0, cmdExit = {} }) {
  mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  mkdirSync(path.join(dir, '.git'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: {} }, null, 2)}\n`)
  writeFileSync(path.join(dir, 'scripts/local-cmd.mjs'), `process.exit(${cmdExit['scripts/local-cmd.mjs'] ?? 0})\n`)
  writeFileSync(path.join(dir, 'scripts/second-cmd.mjs'), `process.exit(${cmdExit['scripts/second-cmd.mjs'] ?? 0})\n`)
  writeFileSync(path.join(dir, 'scripts/auto-resume.contract.selftest.mjs'),
    `console.log('共 ${AUTO_RESUME_TOTAL} 条：通过 ${AUTO_RESUME_TOTAL - autoResumeExit}，失败 ${autoResumeExit}')\nprocess.exit(${autoResumeExit === AUTO_RESUME_TOTAL ? EXIT.INCOMPLETE : autoResumeExit > 0 ? EXIT.FAIL : EXIT.PASS})\n`)
  for (const [pkg, ver] of Object.entries(versions)) {
    const d = path.join(dir, 'node_modules', pkg)
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, 'package.json'), `${JSON.stringify({ name: pkg, version: ver }, null, 2)}\n`)
  }
}

function selftestMain () {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'rc1-basis-selftest-'))
  const cases = []
  const note = (name, want, got, extra = '') => {
    const ok = want === got
    cases.push({ name, want, got, ok, extra })
    say(`  ${ok ? 'ok  ' : 'FAIL'} ${name}：期望 EXIT ${want}，实测 ${got}${extra ? ` —— ${extra}` : ''}`)
  }
  const RC1 = { '@deepseek-ai/dsh-tools': '0.2.0-rc.1', '@deepseek-ai/dsh-home-paths': '0.2.0-rc.1', '@deepseek-ai/dsh-client-locale': '0.2.0-rc.1', '@deepseek-ai/dsh-client-store': '0.2.0-rc.1', '@deepseek-ai/dsh-client-ui-primitives': '0.2.0-rc.1', '@deepseek-ai/cordis': '4.0.4', '@deepseek-ai/schemastery': '3.18.4' }
  const ALPHA = { ...RC1, '@deepseek-ai/dsh-tools': '0.1.7-alpha.1', '@deepseek-ai/cordis': '4.0.3', '@deepseek-ai/schemastery': '3.18.3' }

  say('=== 正向：两棵健全基座（rc1 / alpha.1），D 应当「一致」⇒ EXIT 0 ===')
  const good = path.join(tmpRoot, 'good-rc1'); makeFixtureTree(good, { versions: RC1 })
  const alpha = path.join(tmpRoot, 'good-alpha'); makeFixtureTree(alpha, { versions: ALPHA })
  const cmds = ['scripts/local-cmd.mjs', 'scripts/second-cmd.mjs']
  const rPositive = runSelf([ '--base', good, '--alpha-base', alpha, '--commands', cmds.join(',') ])
  note('正向：两基座一致 ⇒ 0（若这条不是 0，后面所有负对照都不可信）', EXIT.PASS, rPositive)

  // ⚠ 装置纪律：测 A/B/C 的负对照**必须同时给 --alpha-base**，否则 D 会被判「前置不成立」
  //   而全局 `3` 压过目标断言的 `1` ⇒ 负对照**测不出东西**（本轮实测踩过：三条期望 1 实测 3，
  //   根因是装置没给对照基座，不是门不红）。这与「探针没跑起来 ≠ 被测对象有问题」同族。
  const withAlpha = (b, extra = []) => [ '--base', b, '--alpha-base', alpha, '--commands', cmds.join(','), ...extra ]

  say('=== 负对照 A：解析到 alpha 线（跨代组合）⇒ 必须 1 ===')
  const badA = path.join(tmpRoot, 'neg-a-alpha'); makeFixtureTree(badA, { versions: ALPHA })
  note('负对照 A：rc1 基座位放 alpha.1 树', EXIT.FAIL, runSelf(withAlpha(badA)))
  const badA2 = path.join(tmpRoot, 'neg-a-unresolved'); makeFixtureTree(badA2, { versions: {} })
  note('负对照 A′：包完全解析不到（前置不成立，不得读作通过）', EXIT.INCOMPLETE, runSelf(withAlpha(badA2)))

  say('=== 负对照 B：auto-resume 报红 / 报 3 ⇒ 必须非 0 ===')
  const badB = path.join(tmpRoot, 'neg-b-red'); makeFixtureTree(badB, { versions: RC1, autoResumeExit: 3 })
  note('负对照 B：该门 18/21（有失败）', EXIT.FAIL, runSelf(withAlpha(badB)))
  const badB2 = path.join(tmpRoot, 'neg-b-incomplete'); makeFixtureTree(badB2, { versions: RC1, autoResumeExit: AUTO_RESUME_TOTAL })
  note('负对照 B′：该门自己报「前置条件不成立」（EXIT 3）', EXIT.INCOMPLETE, runSelf(withAlpha(badB2)))
  const badB3 = path.join(tmpRoot, 'neg-b-nogit'); makeFixtureTree(badB3, { versions: RC1 })
  rmSync(path.join(badB3, '.git'), { recursive: true, force: true })
  note('负对照 B″：基座没有 .git（历史不全）', EXIT.INCOMPLETE, runSelf(withAlpha(badB3)))

  say('=== 负对照 C：某条既有命令报红 / 缺文件 ⇒ 必须非 0 ===')
  const badC = path.join(tmpRoot, 'neg-c-red'); makeFixtureTree(badC, { versions: RC1, cmdExit: { 'scripts/second-cmd.mjs': 1 } })
  note('负对照 C：第二条命令 EXIT 1', EXIT.FAIL, runSelf(withAlpha(badC)))
  const badC2 = path.join(tmpRoot, 'neg-c-missing'); makeFixtureTree(badC2, { versions: RC1 })
  rmSync(path.join(badC2, 'scripts/second-cmd.mjs'))
  note('负对照 C′：命令文件不存在', EXIT.INCOMPLETE, runSelf(withAlpha(badC2)))

  say('=== 负对照 D：两基座输出/退出码有差异 ⇒ 必须 1 ===')
  const badD = path.join(tmpRoot, 'neg-d-diff'); makeFixtureTree(badD, { versions: RC1, cmdExit: { 'scripts/second-cmd.mjs': 1 } })
  note('负对照 D：alpha 树里同一条命令退 1 ⇒ 对拍必须抓到', EXIT.FAIL, runSelf([ '--base', good, '--alpha-base', badD, '--commands', cmds.join(',') ]))
  note('负对照 D′：没给 --alpha-base（对拍无对照）', EXIT.INCOMPLETE, runSelf([ '--base', good, '--commands', cmds.join(',') ]))

  say('=== 装置自保：清单抽不出来 / 基座不像仓库树 ⇒ 必须非 0（不许静默跳过）===')
  note('自保：基座不存在', EXIT.INCOMPLETE, runSelf(withAlpha(path.join(tmpRoot, 'no-such-dir'))))
  note('自保：命令清单为空（抽不出 ⇒ 不许「零条命令全绿」）', EXIT.INCOMPLETE, runSelf([ '--base', good, '--alpha-base', alpha ]))

  say('=== 机制自证：一个断言红 + 另一个断言未完成 时，退出码取 3（未完成优先）===')
  const mixed = path.join(tmpRoot, 'neg-mixed'); makeFixtureTree(mixed, { versions: ALPHA, autoResumeExit: 3 })
  note('机制：A 红 + B 红 ⇒ 1（无未完成项时按红）', EXIT.FAIL, runSelf(withAlpha(mixed)))
  const mixed2 = path.join(tmpRoot, 'neg-mixed2'); makeFixtureTree(mixed2, { versions: RC1, autoResumeExit: 3 })
  rmSync(path.join(mixed2, 'scripts/second-cmd.mjs'))
  note('机制：B 红 + C 未完成 ⇒ 3（**未完成优先**：这一轮没验证完，不得读作「只是红」）', EXIT.INCOMPLETE, runSelf(withAlpha(mixed2)))

  rmSync(tmpRoot, { recursive: true, force: true })
  const failed = cases.filter((c) => !c.ok)
  say('')
  say(`--- selftest 汇总 ---`)
  say(`  用例 ${cases.length} 条：通过 ${cases.length - failed.length}，失败 ${failed.length}`)
  say(`  四条断言各自至少一条会失败的负对照：A ${cases.filter((c) => c.name.startsWith('负对照 A')).length} · B ${cases.filter((c) => c.name.startsWith('负对照 B')).length} · C ${cases.filter((c) => c.name.startsWith('负对照 C')).length} · D ${cases.filter((c) => c.name.startsWith('负对照 D')).length}`)
  say('')
  if (failed.length > 0) { say(`RESULT: FAIL —— ${failed.length} 条用例不成立`); return EXIT.FAIL }
  say('RESULT: PASS —— 本门成立：正向成立，且四条断言各自都有会失败的负对照。')
  return EXIT.PASS

  /** 用**当前文件**再跑一次主流程（真调自身），返回退出码；`--commands` 为空时用现场抽取。 */
  function runSelf (args) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: 'utf8', env: { ...process.env } })
    if (r.status === null) return 'TIMEOUT'
    if (verbose) process.stdout.write(`${(r.stdout ?? '').split('\n').map((l) => `      | ${l}`).join('\n')}\n`)
    return r.status
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────
if (selftest) process.exit(selftestMain())

// 命令清单：**优先看被测基座自己**（避免「拿本仓的清单去测别的树」），基座抽不到才回落本仓。
const commands = commandsOverride ?? extractCommands(base) ?? extractCommands(ROOT)
if (commands === null || commands.length === 0) {
  console.error('未完成验证：抽不出命令清单（工作流的 `run: node scripts/...` 与 package.json 的 scripts 都没读到）—— 不许把「零条命令」读成全绿。')
  process.exit(EXIT.INCOMPLETE)
}
const { exit } = runAll({ baseDir: base, alphaDir: alphaBase, commands })
process.exit(exit)
