#!/usr/bin/env node
/**
 * 「工作区提示词不被写空」契约门（workspace-prompt.guard.assert.mjs）
 *
 * 守的是什么：`lib/global-prompt.js` 的同步路径**不许把用户粘贴的工作区提示词正文弄丢**。
 * 本门不看注释、不看 diff，而是**把真身加载进来跑**：假 settings 服务 + 真 mergeLayers 语义，
 * 看写回载荷与「深合并后的 config」里用户正文还在不在。
 *
 * 为什么需要它（本条存在的唯一理由，别删）：
 *   DSH 的 `settings.update(ns, patch)` 是 **mergeLayers 深合并**（编译产物
 *   `/Users/hanyao/deepseek-harness/packages/settings/settings/lib/index.js:281-290`）：
 *   plain object 递归合并，**其余值（含数组）整体替换下层**。
 *   于是「同步时把每个活跃工作区判成缺失、补一条 {enabled:false,content:'',files:[]}」这个 bug，
 *   一写回就把用户正文覆盖成空串、把 files 清成 []。实缺陷形态（board/d.md #141-D）：
 *     · 取值层级错：`workspaceCfg.workspaces` 已是**字典**，却又去取 `.workspaces` 子键 ⇒ 恒 undefined；
 *     · `removed` 没接上自己的 ref ⇒ 用户移除过的路径被重新补回；
 *     · 回写不带作用域 ⇒ 整份字典被写回，未点名的条目也被连带。
 *   三条都在**同一次同步**里发生，且盘上只留下「正文变空」这一条症状。
 *
 * 判据（五格，互补；缺一即漏一类形态）：
 *   ① main            正文未被写空 · files 未被整体替换 · 未点名条目不被连带 · **零次写回** · text() 含正文
 *   ② removed-skip    在 removed 里的路径不补回、不写回
 *   ③ removed-drop    从 removed 摘掉后**可以**再补回，且补的是空模板（不是伪造正文）
 *   ④ added-template  真新增工作区被补进，形状必须是 {enabled:false,content:'',files:[]}
 *   ⑤ add-with-existing  库里已有别的条目时，载荷**只许带新增的那一条**（回写作用域）
 *   （round-trip：旧码快照必须报红——由 --selftest 的 M0 证明，不在本门常驻路径里）
 *
 * 退出码（align 本仓库 §5.2）：
 *   0 = 五格判据全部成立
 *   1 = 有判据不成立（含读取失败等前置不成立——按"无法确立断言"报红）
 *   2 = 自证（--selftest）里出现「基线不绿」或「某形态未报红」这类**装置自身**问题
 *   64 = 用法错误
 *
 * 用法：
 *   node scripts/workspace-prompt.guard.assert.mjs                  # 断言本仓库 lib/global-prompt.js
 *   node scripts/workspace-prompt.guard.assert.mjs --file <path>    # 断言指定文件（负向对照用）
 *   node scripts/workspace-prompt.guard.assert.mjs --selftest       # 造三份变异副本，自证本门会报红
 *
 * 自证（--selftest）三份破坏 + 一份基线，全部在 os.tmpdir() 的副本上（工作区零写入）：
 *   M0 未变异（基线，必须绿）
 *   M1 取值层级退回「取 .workspaces 子键」  ⇒ ① 的用户正文判据必须报红
 *   M2 removed 退回「从 workspaces 的值里取」⇒ ② 的补回判据必须报红
 *   M3 回写不再只带新增条目（退回整份字典） ⇒ ⑤ 的载荷判据必须报红
 *   每个变异先自证锚点**恰好命中 1 次**；不命中即判「对照无效」，不许当场静默 no-op。
 *
 * 已知边界（明列，不沉默）：
 *   · 夹具的假 settings 桩只实现 update()（clone 后深合并进 current），并按 DSH 编译产物
 *     :281-290 的语义复刻 mergeLayers；桩**不做** schema 校验/表单投影（真身 projectForm 那层）。
 *     对齐证明（真值表 5 格 + 证伪对照 4 格，对拍编译产物里逐字抽出的实物）见 board/d.md #141-D。
 *   · 本门是**行为级**的：它加载真身并真跑一段，但仍只覆盖「apply 时同步 + session/created 之后同步」
 *     这两条已知入口；其它调用路径（未来新增的同步触发点）不在覆盖内。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET_REL = 'lib/global-prompt.js'
const EXIT = { PASS: 0, FAIL: 1, UNFINISHED: 2, USAGE: 64 }

const NS = 'session-toolkit'
const WS_A = '/tmp/d-verify/ws-active'
const WS_EXTRA = '/tmp/d-verify/ws-extra'
const REF_FILE = '/tmp/d-verify/ref.md'
const CONTENT_A = '这是用户粘贴的工作区提示词正文（必须活下来）'
const CONTENT_EXTRA = '另一个工作区的正文（不许被连带）'

// ── 真身 mergeLayers 的等价实现（对齐证明见文件头「已知边界」）────────────────
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
function mergeLayers(under, over) {
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged = { ...under }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = Object.hasOwn(merged, key) ? mergeLayers(merged[key], value) : value
  }
  return merged
}

// ── 场景表 ──────────────────────────────────────────────────────────────────
const SCENARIOS = {
  main: { store: () => ({ removed: [], workspaces: { [WS_A]: { enabled: true, content: CONTENT_A, files: [REF_FILE] }, [WS_EXTRA]: { enabled: true, content: CONTENT_EXTRA, files: [] } } }), unremove: false },
  'removed-skip': { store: () => ({ removed: [WS_A], workspaces: {} }), unremove: false },
  'removed-drop': { store: () => ({ removed: [WS_A], workspaces: {} }), unremove: true },
  'added-template': { store: () => ({ removed: [], workspaces: {} }), unremove: false },
  'add-with-existing': { store: () => ({ removed: [], workspaces: { [WS_EXTRA]: { enabled: true, content: CONTENT_EXTRA, files: [REF_FILE] } } }), unremove: false }
}

const line = (k, v) => console.log('  ' + String(k).padEnd(24) + ' ' + v)
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 把被测文件加载进沙箱（旁路桩 request-guard），返回 { mod, sandbox }。失败返回 null。 */
async function loadTarget(targetPath) {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'd-wsguard-'))
  try {
    const src = readFileSync(targetPath, 'utf8')
    const modPath = path.join(sandbox, 'global-prompt.mjs')
    writeFileSync(modPath, src)
    writeFileSync(path.join(sandbox, 'request-guard.js'), 'export function originGuard() { return true }\n')
    const mod = await import(pathToFileURL(modPath).href)
    return { mod, sandbox }
  } catch (err) {
    console.error('  加载失败：' + String(err && err.stack ? err.stack : err))
    return { mod: null, sandbox }
  }
}

/** 跑一个场景；返回 { failures: string[], updates, mergedWs, ... } */
async function runScenario(mod, name) {
  const spec = SCENARIOS[name]
  const beforeState = spec.store()
  const storeBefore = { workspacePrompt: structuredClone(beforeState) }
  const live = { current: { workspaces: beforeState.workspaces, removed: beforeState.removed } }
  const store = { entries: {} }
  const updates = []
  let section = null

  const makeRef = (field) => ({ get: () => live.current[field] })
  const settingsStub = {
    async update(ns, patch) {
      const input = structuredClone(patch)
      updates.push({ ns, patch: input })
      store.entries[ns] = mergeLayers(store.entries[ns] || {}, input)
    }
  }
  const activeAgent = { session: { header: { cwd: WS_A } } }
  const ctx = {
    // 同一批里放两条相同 path：只许补一次（写入是真副作用）
    agents: { roots: () => [{ session: { header: { cwd: WS_A } } }, { session: { header: { cwd: WS_A } } }] },
    get: (n) => (n === 'settings' ? settingsStub : undefined),
    inject: (deps, fn) => { fn(ctx) },
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    timeout: () => () => {},
    systemPrompt: { section: (s) => { section = s; return s } }
  }
  // 真身契约（lib/index.js:113）：apply 收到 { global, workspace }，每个 schema 字段是带 .get() 的 ref；
  // 被测文件只读 workspace.workspaces 与 workspace.removed（lib/global-prompt.js:203 / :206）。
  const cfg = { global: {}, workspace: { workspaces: makeRef('workspaces'), removed: makeRef('removed') } }

  const failures = []
  const fail = (m) => failures.push(m)
  try {
    await mod.apply(ctx, cfg)
  } catch (err) {
    fail('apply 抛异常：' + String(err && err.message ? err.message : err))
    return { failures }
  }
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 10))
  const updatesP1 = updates.slice()

  let phase2 = null
  if (spec.unremove) {
    const entriesAtP1 = structuredClone(store.entries)
    const at = updates.length
    live.current.removed = []
    section = null
    try {
      await mod.apply(ctx, cfg)
    } catch (err) {
      fail('第二阶段 apply 抛异常：' + String(err && err.message ? err.message : err))
      return { failures }
    }
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 10))
    let merged2 = entriesAtP1[NS] || {}
    for (const u of updates.slice(at)) merged2 = mergeLayers(merged2, u.patch)
    phase2 = { added: updates.length - at, ws: (merged2.workspacePrompt && merged2.workspacePrompt.workspaces) || {} }
  }

  // 真身写回：把第一阶段的 patch 深合并进「写回前的盘上 config 快照」——判据只认这个结果
  let mergedConfig = structuredClone(storeBefore)
  for (const u of updatesP1) mergedConfig = mergeLayers(mergedConfig, u.patch)
  const mergedWs = (mergedConfig.workspacePrompt && mergedConfig.workspacePrompt.workspaces) || {}

  if (name === 'main') {
    if (!(mergedWs[WS_A] && mergedWs[WS_A].content === CONTENT_A)) fail('用户正文被改写成 ' + JSON.stringify(mergedWs[WS_A] ? mergedWs[WS_A].content : undefined))
    if (!(mergedWs[WS_A] && Array.isArray(mergedWs[WS_A].files) && mergedWs[WS_A].files.length === 1)) fail('files 引用列表被替换成 ' + JSON.stringify(mergedWs[WS_A] ? mergedWs[WS_A].files : undefined))
    if (!(mergedWs[WS_EXTRA] && mergedWs[WS_EXTRA].content === CONTENT_EXTRA)) fail('未点名条目被连带改写')
    if (updatesP1.length !== 0) fail('正文在时不该有任何写回，实测 ' + updatesP1.length + ' 次')
    if (section && typeof section.text === 'function') {
      const txt = section.text({ agent: activeAgent })
      if (typeof txt !== 'string' || !txt.includes(CONTENT_A)) fail('section.text() 里没有用户正文：' + JSON.stringify(txt))
    }
  }
  if (name === 'removed-skip' || name === 'removed-drop') {
    if (updatesP1.length !== 0) fail('removed 里的路径被写回 ' + updatesP1.length + ' 次，载荷 = ' + JSON.stringify(updatesP1.map((u) => u.patch.workspacePrompt && u.patch.workspacePrompt.workspaces)))
    if (mergedWs[WS_A] !== undefined) fail('removed 里的路径被补回：' + JSON.stringify(mergedWs[WS_A]))
  }
  if (name === 'removed-drop') {
    if (!phase2) fail('第二阶段没跑起来（装置问题）')
    else {
      if (phase2.added !== 1) fail('摘掉 removed 后应补回 1 次，实测 ' + phase2.added + ' 次')
      const e = phase2.ws[WS_A]
      if (!(e && e.enabled === false && e.content === '' && Array.isArray(e.files) && e.files.length === 0)) fail('补回的不是空条目模板：' + JSON.stringify(e))
    }
  }
  if (name === 'added-template') {
    const e = mergedWs[WS_A]
    if (!e) fail('真新增工作区没被补入')
    else if (!(e.enabled === false && e.content === '' && Array.isArray(e.files) && e.files.length === 0)) fail('补入的条目不是 {enabled:false,content:\'\',files:[]}：' + JSON.stringify(e))
    if (Object.keys(mergedWs).length !== 1) fail('同一批两条相同 path 被补了多个条目：' + JSON.stringify(Object.keys(mergedWs)))
    if (updatesP1.length !== 1) fail('写回次数应为 1，实测 ' + updatesP1.length)
  }
  if (name === 'add-with-existing') {
    if (updatesP1.length !== 1) fail('写回次数应为 1，实测 ' + updatesP1.length)
    else {
      const keys = Object.keys(updatesP1[0].patch.workspacePrompt.workspaces)
      if (JSON.stringify(keys) !== JSON.stringify([WS_A])) fail('载荷里带了未点名的条目：' + JSON.stringify(keys))
    }
    if (!(mergedWs[WS_EXTRA] && mergedWs[WS_EXTRA].content === CONTENT_EXTRA)) fail('未点名条目的正文被连带改写')
  }
  return { failures, updates: updatesP1, mergedWs }
}

// ── 变异装置（登记式；锚点必须恰好命中 1 次）────────────────────────────────
const MUTATIONS = [
  {
    id: 'M1',
    label: '取值层级退回「取 .workspaces 子键」',
    find: 'const rawWorkspaces = deps.workspaceValue()',
    repl: 'const rawWorkspaces = { workspaces: deps.workspaceValue() }',
    expect: { scenario: 'main', mustFail: /正文/ }
  },
  {
    id: 'M2',
    label: 'removed 退回「从 workspaces 的值里取」',
    find: 'removedValue: () => volatileValue(removedRef, [])',
    repl: 'removedValue: () => volatileValue(workspaceRef, {})',
    expect: { scenario: 'removed-skip', mustFail: /补回/ }
  },
  {
    id: 'M3',
    label: '回写不再只带新增条目（退回整份字典）',
    find: 'settings.update(deps.entryId, { workspacePrompt: { workspaces: added } })',
    repl: 'settings.update(deps.entryId, { workspacePrompt: { workspaces } })',
    expect: { scenario: 'add-with-existing', mustFail: /未点名/ }
  }
]

function mutate(src, m) {
  const hits = src.split(m.find).length - 1
  if (hits !== 1) return { error: `${m.id} 锚点命中 ${hits} 次（必须恰好 1 次）⇒ 对照无效`, text: null }
  const text = src.replace(m.find, m.repl)
  if (text === src) return { error: `${m.id} 替换后与源逐字节相同 ⇒ 对照无效`, text: null }
  return { error: null, text }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
let targetAbs = path.join(ROOT, TARGET_REL)
let selftest = false
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--file') {
    if (!argv[i + 1]) { usage(); process.exit(EXIT.USAGE) }
    targetAbs = path.resolve(argv[i + 1])
    i += 1
  } else if (a === '--selftest') {
    selftest = true
  } else if (a === '--help' || a === '-h') {
    usage()
    process.exit(EXIT.PASS)
  } else {
    console.error('未知参数 ' + a)
    usage()
    process.exit(EXIT.USAGE)
  }
}
function usage() {
  console.log('用法：node scripts/workspace-prompt.guard.assert.mjs [--file <path>] [--selftest]')
  console.log('  --file <path>   断言指定文件（负向对照用；默认 lib/global-prompt.js）')
  console.log('  --selftest      造三份变异副本，自证本门会报红（副本在 os.tmpdir()，工作区零写入）')
}

console.log('「工作区提示词不被写空」契约门（workspace-prompt.guard.assert.mjs）')
console.log('  仓库 ' + ROOT)
if (!existsSync(targetAbs)) {
  console.error('  被测文件不存在：' + targetAbs)
  process.exit(EXIT.FAIL)
}
const targetSrc = readFileSync(targetAbs, 'utf8')
line('被测文件', targetAbs)
line('sha256', sha256(targetSrc).slice(0, 16) + '…  ' + Buffer.byteLength(targetSrc) + ' B / ' + targetSrc.split('\n').length + ' 行')

/** 对一个「源文本」跑全部五格 + 源码级不变量；返回 failures */
async function judgeSource(sourceText, label) {
  const failures = []
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'd-wsguard-judge-'))
  const file = path.join(tmpDir, 'global-prompt.js')
  writeFileSync(file, sourceText)
  try {
    const loaded = await loadTarget(file)
    if (!loaded.mod || typeof loaded.mod.apply !== 'function') {
      failures.push('加载后被测文件没有导出 apply（不是一个可用的 host 插件）')
      return failures
    }
    // 源码级不变量：removed 必须来自它自己的 ref（与 workspaces 同级），而不是从字典里取
    if (!/removedRef = workspaceCfg\.removed/.test(sourceText)) failures.push('removed 没有接自己的 ref（workspaceCfg.removed）')
    if (!/removedValue: \(\) => volatileValue\(removedRef, \[\]\)/.test(sourceText)) failures.push('removedValue 不是从 removedRef 取值')
    for (const name of Object.keys(SCENARIOS)) {
      const r = await runScenario(loaded.mod, name)
      for (const f of r.failures) failures.push(name + '：' + f)
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
  return failures
}

// 常驻路径：判真实文件
console.log('')
console.log('── 五格判据（加载真身跑）──')
const baseFailures = await judgeSource(targetSrc, 'base')
for (const f of baseFailures) console.log('  FAIL  ' + f)
const baseOk = baseFailures.length === 0
console.log('  ' + (baseOk ? 'PASS' : 'FAIL') + '  基线（' + path.relative(ROOT, targetAbs) + '）：' + (baseOk ? '五格全绿' : baseFailures.length + ' 条不成立'))

if (!selftest) {
  console.log('')
  if (baseOk) {
    console.log('本门成立：用户正文在同步路径上活下来、removed 三条契约成立、回写只带新增条目。')
    process.exit(EXIT.PASS)
  }
  console.error('本门报红：' + baseFailures.length + ' 条判据不成立（见上）')
  process.exit(EXIT.FAIL)
}

// ── 自证：三份破坏 + 一份基线，全部在临时副本上 ─────────────────────────────
console.log('')
console.log('── 自证（--selftest）：基线 + 三份破坏，副本在 os.tmpdir() ──')
const rows = [{ id: 'M0', label: '未变异（基线，必须绿）', expectRed: false, failures: baseFailures }]
for (const m of MUTATIONS) {
  const r = mutate(targetSrc, m)
  if (r.error) {
    rows.push({ id: m.id, label: m.label, expectRed: true, failures: [], mutationError: r.error })
    continue
  }
  line(m.id + ' 变异', m.label)
  line(m.id + ' 字节', Buffer.byteLength(targetSrc) + ' B → ' + Buffer.byteLength(r.text) + ' B（源码已不同 ✓）')
  const failures = await judgeSource(r.text, m.id)
  const hits = failures.filter((f) => {
    if (m.id === 'M1') return /^main：/.test(f)
    if (m.id === 'M2') return /^removed-skip：/.test(f)
    if (m.id === 'M3') return /^add-with-existing：/.test(f)
    return false
  })
  const hit = hits.some((f) => m.expect.mustFail.test(f))
  rows.push({ id: m.id, label: m.label, expectRed: true, failures, hit, expect: m.expect })
}

console.log('')
console.log('── 自证汇总 ──')
for (const r of rows) {
  if (r.mutationError) console.log('  ' + r.id + '  ' + r.label + ' ⇒ 对照无效：' + r.mutationError)
  else if (!r.expectRed) console.log('  ' + r.id + '  ' + r.label + ' ⇒ ' + (r.failures.length === 0 ? '绿（符合预期）' : '红（基线不绿，装置问题）'))
  else console.log('  ' + r.id + '  ' + r.label + ' ⇒ ' + (r.hit ? '报红（符合预期：' + r.expect.mustFail + '）' : '未报红（漏检！实测 ' + r.failures.length + ' 条失败）'))
}
const baselineGreen = rows[0].failures.length === 0
const allInvalid = rows.slice(1).every((r) => !r.mutationError)
const allRed = rows.slice(1).every((r) => r.hit === true)
console.log('')
if (baselineGreen && allInvalid && allRed) {
  console.log('本门成立：真实文件五格全绿，且三种破坏形态（取值层级 / removed ref / 回写作用域）各自报红。')
  console.log('（临时副本已删；工作区零写入）')
  process.exit(EXIT.PASS)
}
if (!baselineGreen) {
  console.error('自证失败：基线不绿（' + rows[0].failures.length + ' 条）——先修被测文件或装置，再看变异。')
  process.exit(EXIT.FAIL)
}
console.error('自证装置问题：变异锚点未命中或未生效（' + rows.filter((r) => r.mutationError).length + ' 份）⇒ 判 2（未完成验证，不得读作通过）')
for (const r of rows) if (r.mutationError) console.error('  - ' + r.id + '：' + r.mutationError)
process.exit(EXIT.UNFINISHED)
