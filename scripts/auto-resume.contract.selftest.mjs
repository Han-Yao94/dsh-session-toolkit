#!/usr/bin/env node
/**
 * auto-resume 启动恢复的**契约门**（可重复执行、能报红、可被证伪）。
 *
 * 守的是什么：`lib/auto-resume.js` 的启动恢复必须能在**两种 list() 契约**下都选对目标——
 *   · 快照形状（0.1.5 现行）：`list()` → `SessionPersistenceSnapshot[]`，header 在 `.header`
 *     （`@deepseek-ai/dsh-session-persistence/lib/types/index.d.ts:22-31,155`）；
 *   · 裸 header 形状（0.1.2 一线）：列表项本身即 header。
 * 2026-09-10 的真实故障形态：只认裸 header 的代码遇到快照形状 → `h.id` 为 undefined →
 * 目标集恒空 → **静默无动作、无任何报错**。本门把这种"静默失效"变成会红的断言。
 *
 * 做法（不依赖真实 ~/.dsh/sessions）：把被测代码在 os.tmpdir() 里实例化，喂**合成**的
 * persistence 后端，观察它实际调用了哪些 `agents.resume`。
 *
 * 退出码契约（沿用 verify.mjs 口径）：
 *   0  = 全部契约断言成立，且两个灵敏度对照复现
 *   1  = 有断言失败（含把 `--code` 指向已知坏代码时的预期红）
 *   3  = 前置条件不成立（取不到 HEAD blob / 建不起 node_modules 链接 / 被测模块导入失败）——**未完成验证**，不得读作通过
 *   64 = 用法错误
 *
 * 用法：
 *   node scripts/auto-resume.contract.selftest.mjs                 # 测工作区 lib/auto-resume.js
 *   node scripts/auto-resume.contract.selftest.mjs --code <file>   # 测指定副本（旧 blob / 变异体）
 * 不进 pnpm verify（保持快门快）；CI 中由 npm-publish.yml 的独立 job 直调本文件。
 *
 * 护栏（同 verify.selftest.mjs 的立场）：
 *   · 一切副本、日志、破坏只在 os.tmpdir() 内；工作区零写入，跑前跑后做内容 SHA256 对拍。
 *   · 写路径必须与工作区根**双向无前缀包含**，且先判路径后落盘。
 *   · 子进程一律用文件描述符承接输出（本沙箱禁管道 stdio，会 EPERM）；stdout/stderr 分开落盘。
 *
 * 负向对照从哪来（2026-09-11 修订，**替换掉「HEAD 即坏代码」这一前提**）：
 *   原实现取 `HEAD:lib/auto-resume.js` 当"已知坏代码"。该前提**只在修复被提交之前成立**——
 *   修复一旦进 HEAD（提交 `96751aa`），HEAD 的内容就变成好代码，对照物随即失效并让本门恒红
 *   （实测：`FAIL sensibility/legacy-head-blob ← 旧代码竟然选中了 [s-legal]`）。这不是被测代码回归，
 *   是**对照物随提交而消失**，属测量手段缺陷（协议 §5「验证手段本身必须先被验证」）。
 *   修订后的取值顺序（判据是**内容指纹**，不是提交哈希；不新增任何"坏代码副本"文件，真源仍是 git 历史）：
 *     1. HEAD 的 blob 若**不含**修复指纹（`normalizeEntry`）→ 它本身就是坏代码，直接用；
 *     2. 否则从 HEAD 向前逐个提交找**最近一个仍含修复指纹**的提交 C（修复就是由它写入的），
 *        取其父提交 `<C>^:lib/auto-resume.js` 作为坏代码——该提交存在即永久存在，对照可重复取得；
 *     3. 都取不到 → `EXIT=3`（未完成验证），**不得**降级读作通过。
 *   判别用 `normalizeEntry` 而非"是否含 isSnapshot 那行"：修复既**新增**了判别行也**新增**了归一化函数，
 *   指纹必须能唯一定位本次修复；`isSnapshot` 在修复后的代码里存在，取它作指纹同样成立，但 `normalizeEntry`
 *   更贴近"形状归一化"这一被守的契约本身。
 *   修订后的实测（2026-09-11）：HEAD 含指纹 → 解析到 `96751aa^`（blob `c3a03842…`，即登记处 §3.1 的坏版本）
 *   → 坏对照 `0` 选中、当前代码 `8/8 PASS EXIT=0`、变异体 `0` 选中。三态可证伪保持。
 *
 * 已知未覆盖（明列，不沉默）：
 *   1. cordis 真实的 `ctx.inject` 时序（服务晚到 / 永不到）——本门用同一个 ctx 直接回调，不测调度。
 *   2. 真实持久化后端与真实 ~/.dsh/sessions（本门全部用合成后端；真实后端属 L3）。
 *   3. `scope.watch` 的「false→true 立即恢复」路径——本门只覆盖启动恢复。
 *   4. 并发上限 CONCURRENCY 的真实调度语义（本门只断言最终选中集合，不断言批间顺序）。
 *   5. Host Dev 的 integration.mjs 是**观测脚本**（恒 exit 0），本门不采信其输出，也不复用它。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// 两条护栏的判据本体（与 verify.selftest.mjs 共用同一实现，避免两门各自腐化）
import {
  assertOutsideWorkspace as guardPathOk, manifest, manifestDiff,
} from './lib/manifest-guard.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP_BASE = os.tmpdir()
const EXIT = { PASS: 0, FAIL: 1, INCOMPLETE: 3, USAGE: 64 }

// ------------------------------------------------------------------ 护栏 1 / 护栏 2
// 判据本体已抽到 `scripts/lib/manifest-guard.mjs`（与 verify.selftest.mjs 共用同一份实现）。
// 本门只保留"拒绝形式"的包装：护栏 1 的判据仍然照旧，只是 decision 由库里给。
function assertOutsideWorkspace(p, label) {
  try {
    guardPathOk(p, label, { root: ROOT, tmpBase: TMP_BASE })
  } catch (e) {
    console.error(e.message)
    console.error('  必须在 os.tmpdir() 之下，且与工作区根之间不得存在前缀包含关系（双向）。拒绝继续。')
    process.exit(EXIT.FAIL)
  }
}

// ------------------------------------------------------------------ 工作区
assertOutsideWorkspace(path.join(TMP_BASE, 'dsh-arv-contract-'), '自测工作目录模板')
const WORK = mkdtempSync(path.join(TMP_BASE, 'dsh-arv-contract-'))
assertOutsideWorkspace(WORK, '自测工作目录')

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase().slice(0, 16)

/** 被测模块是 ESM，`import '@deepseek-ai/schemastery'` 需要能解析——在临时目录建工作区 node_modules 链接。 */
/**
 * 为临时副本准备 `@deepseek-ai/schemastery`。
 *
 * 本门断言的是「哪些会话被选中」，与 schema 构造无关；因此优先链接工作区里真实的包
 * （本地开发），**不可解析时退化为最小 schema 桩**（CI 不装依赖）。此前缺依赖直接
 * exit 3，导致这条门在 CI 上从未真正执行（f336ca7 的红就是这个形态）——「跳过」被
 * 误读成「契约成立」，正是本仓库反复强调的静默失效。
 * @returns {'linked'|'stub'|false}
 */
function provideSchemastery() {
  const link = path.join(WORK, 'node_modules')
  const target = path.join(ROOT, 'node_modules')
  if (existsSync(path.join(target, '@deepseek-ai', 'schemastery'))) {
    try {
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      if (existsSync(path.join(link, '@deepseek-ai', 'schemastery'))) return 'linked'
    } catch { /* 落回桩 */ }
  }
  // 最小 schema 桩：z.object/z.dict/z.number/... 全部返回可继续链式调用（含 .default）的对象，
  // 被测代码只把它交给 settings.register（本门的 ctx 忽略 schema）。
  const stubDir = path.join(link, '@deepseek-ai', 'schemastery')
  try {
    mkdirSync(stubDir, { recursive: true })
    writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/schemastery', version: '0.0.0-contract-stub', type: 'module', main: 'index.mjs',
    }, null, 2))
    writeFileSync(path.join(stubDir, 'index.mjs'), [
      'const make = () => new Proxy(function () {}, {',
      "  get: (_t, key) => (key === 'then' ? undefined : make()),",
      '  apply: () => make(),',
      '  construct: () => make(),',
      '})',
      'export default new Proxy({}, { get: () => make() })',
      '',
    ].join('\n'))
    return 'stub'
  } catch {
    return false
  }
}

/** 读取任意 `<rev>:<rel>` 的 blob（负向对照的真源是 git 历史，不是转述）。 */
function gitBlob(revRel) {
  const outPath = path.join(WORK, 'blob.out')
  const errPath = path.join(WORK, 'blob.err')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  try {
    const r = spawnSync('git', ['-C', ROOT, 'cat-file', 'blob', revRel],
      { stdio: ['ignore', outFd, errFd], env: process.env })
    if (r.status !== 0) return { ok: false, why: readFileSync(errPath, 'utf8').trim() || `git exit ${r.status}` }
    return { ok: true, text: readFileSync(outPath, 'utf8') }
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
}

function revList(...args) {
  const outPath = path.join(WORK, 'rev.out')
  const errPath = path.join(WORK, 'rev.err')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  try {
    const r = spawnSync('git', ['-C', ROOT, 'rev-list', ...args],
      { stdio: ['ignore', outFd, errFd], env: process.env })
    if (r.status !== 0) return { ok: false, why: readFileSync(errPath, 'utf8').trim() || `git exit ${r.status}` }
    return { ok: true, revs: readFileSync(outPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) }
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
}

/**
 * 修复指纹：形状归一化函数。修复前的代码没有它，故"含指纹 = 已是好代码"。
 * 该字面量必须在当前 lib/auto-resume.js 中存在，否则视为门无法定位本次修复 → EXIT=3。
 */
const BAD_FINGERPRINT = 'function normalizeEntry'
/** 回归扫描上限（防止仓库异常时无限回溯）。 */
const MAX_LEGACY_SCAN = 50

/**
 * 取"已知坏代码"（形状归一化之前的版本）。取值判据是**内容指纹**，不是提交哈希：
 * HEAD 不含指纹 → 直接用 HEAD；否则回溯找最近一个把指纹写进历史的提交，取其父版本。
 * 回溯一步即够（修复提交自身的父版本就是坏版本），循环只是"未提交时的一步短路 + 异常兜底"。
 */
function resolveLegacyControl() {
  const rel = 'lib/auto-resume.js'
  const head = gitBlob(`HEAD:${rel}`)
  if (!head.ok) return { ok: false, why: `取不到 HEAD:${rel} —— ${head.why}` }
  if (!head.text.includes(BAD_FINGERPRINT)) {
    return { ok: true, source: `HEAD:${rel}`, rev: 'HEAD', text: head.text, note: 'HEAD 本身即坏代码（修复尚未提交）' }
  }
  const rl = revList('-n', String(MAX_LEGACY_SCAN), 'HEAD')
  if (!rl.ok) return { ok: false, why: `git rev-list 失败 —— ${rl.why}` }
  for (const rev of rl.revs) {
    const cur = gitBlob(`${rev}:${rel}`)
    if (!cur.ok || !cur.text.includes(BAD_FINGERPRINT)) continue // 该提交尚未引入修复，或该提交没有此文件
    const parent = gitBlob(`${rev}^:${rel}`)
    if (!parent.ok) return { ok: false, why: `修复提交 ${rev} 的父版本不可读 —— ${parent.why}` }
    if (parent.text.includes(BAD_FINGERPRINT)) continue // 指纹早已存在，说明修复不在此提交
    return {
      ok: true,
      source: `${rev}^:${rel}`,
      rev: `${rev}^`,
      text: parent.text,
      note: `HEAD 已含修复指纹（${BAD_FINGERPRINT}），回溯到引入它的提交 ${rev}，取其父版本作坏对照`,
    }
  }
  return { ok: false, why: `最近 ${MAX_LEGACY_SCAN} 个提交里找不到引入「${BAD_FINGERPRINT}」的提交（工作区是否已含修复但未提交？请先提交）` }
}

function materialize(name, text) {
  const dir = path.join(WORK, name)
  assertOutsideWorkspace(dir, `副本 ${name}`)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'auto-resume.js')
  writeFileSync(file, text)
  return file
}

/**
 * 把被测代码**原样复制**进临时区再加载：`--code` 可能指向任意目录，而 ESM 的裸导入
 * 只沿被加载文件所在目录向上找 node_modules——只有落在 WORK 之下才解析得到 schemastery。
 * 复制不改变被测字节（判据仍是"这份代码是否满足契约"）。
 */
function stageCode(srcPath) {
  const dir = path.join(WORK, 'code-under-test')
  assertOutsideWorkspace(dir, '被测代码副本')
  mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, 'auto-resume.js')
  copyFileSync(srcPath, dest)
  return dest
}

// ------------------------------------------------------------------ 合成输入
const ENABLED = {
  's-legal': true, 's-subagent': true, 's-child': true, 's-depth': true, 's-off': false, 's-blank': true,
}
const HEADERS = [
  { id: 's-legal' },
  { id: 's-subagent', origin: 'subagent' },
  { id: 's-child', parentSession: 'parent-1' },
  { id: 's-depth', delegationDepth: 1 },
  { id: 's-off' },
  { id: 's-blank' },
]
const EVENT_COUNT = { 's-legal': 7, 's-blank': 0 }

const BACKENDS = {
  /** 0.1.5 现行：SessionPersistenceSnapshot[] */
  snapshot: () => ({
    async list() {
      return HEADERS.map((header) => {
        const snap = { header, revision: `rev-${header.id}` }
        if (Object.prototype.hasOwnProperty.call(EVENT_COUNT, header.id)) snap.eventCount = EVENT_COUNT[header.id]
        return snap
      })
    },
  }),
  /** 0.1.2 一线：SessionHeader[] */
  bare: () => ({ async list() { return HEADERS.map((h) => ({ ...h })) } }),
  /** 未识别形状：既不是快照也不是裸 header */
  unrecognized: () => ({
    async list() {
      return [
        { sessionId: 's-legal', meta: { cwd: '/x' } },
        { header: 'not-an-object', revision: 1 },
      ]
    },
  }),
}

// ------------------------------------------------------------------ 运行器
function makeCtx(backend, log, options = {}) {
  // 每会话开关是本条目 config 的 volatile 字段（DSH 0.1.7 起）：被测代码只调 .get()。
  const sessionsRef = { get: () => ENABLED }
  // 旧内核的 settings 命名空间桩：负向对照要跑历史修订版（它们走 ctx.settings.register），
  // 缺了它坏对照会以「apply 抛错」而非「选中集合不同」报红，断言就不再指向被测缺陷。
  const legacyScope = {
    get: () => ({ sessions: ENABLED }),
    watch: () => () => {},
    update: async () => {},
    replace: async () => {},
  }
  // options.controller：模拟 0.1.6 才有的官方恢复链路 ctx.sessionController.resolveAgent()。
  const controller = options.controller === true
    ? { resolveAgent: async (sessionId) => { log.controller.push(sessionId); return { agent: {} } } }
    : undefined
  const childCtx = {
    get: (name) => {
      if (name === 'sessionPersistence') return backend
      if (name === 'sessionController') return controller
      return undefined
    },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  return {
    sessionsRef,
    settings: { register: () => legacyScope },
    get: (name) => {
      if (name === 'sessionPersistence') return backend // 旧代码在 apply 时刻一次性取值
      if (name === 'sessionController') return controller
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
    // 新代码用 ctx.on 监听 loader/volatile-update（本门只覆盖启动恢复，故登记后不触发）
    on: (event) => { if (event === 'loader/volatile-update') log.volatile.push(event); return () => {} },
    // 新代码用 ctx.inject 等服务就绪；这里同步回调，模拟"服务已在"
    inject: (names, cb) => {
      if (names.includes('sessionPersistence')) cb(childCtx)
      else if (controller !== undefined && names.includes('sessionController')) cb(childCtx)
    },
    agents: {
      get: () => undefined,
      resume: async ({ resumeSessionId }) => { log.resume.push(resumeSessionId) },
    },
  }
}

async function settle(log, budgetMs = 1500) {
  const t0 = Date.now()
  let last = -1
  let stable = 0
  while (Date.now() - t0 < budgetMs) {
    await new Promise((r) => setTimeout(r, 15))
    if (log.resume.length === last) {
      if (++stable >= 3) return
    } else {
      last = log.resume.length
      stable = 0
    }
  }
}

async function runCase(file, backendName, options = {}) {
  const log = { resume: [], controller: [], warn: [], volatile: [] }
  const original = console.warn
  console.warn = (...args) => { log.warn.push(args.map(String).join(' ')) }
  try {
    const mod = await import(`${pathToFileURL(file).href}?r=${Math.random()}`)
    const ctx = makeCtx(BACKENDS[backendName](), log, options)
    mod.apply(ctx, { concurrency: 2, sessions: ctx.sessionsRef })
    await settle(log)
  } finally {
    console.warn = original
  }
  return log
}

// ------------------------------------------------------------------ 断言
const results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ← ${detail}`}`)
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join()

// ------------------------------------------------------------------ 主流程
const argv = process.argv.slice(2)
let requestedPath = path.join(ROOT, 'lib', 'auto-resume.js')
if (argv[0] === '--code') {
  if (!argv[1]) { console.error('用法：node scripts/auto-resume.contract.selftest.mjs [--code <file>]'); process.exit(EXIT.USAGE) }
  requestedPath = path.resolve(argv[1])
} else if (argv.length > 0) {
  console.error(`未知参数 ${argv[0]}；用法：node scripts/auto-resume.contract.selftest.mjs [--code <file>]`)
  process.exit(EXIT.USAGE)
}

if (!existsSync(requestedPath)) {
  console.error(`前置条件不成立：被测代码不存在 ${requestedPath}`)
  process.exit(EXIT.INCOMPLETE)
}
const schemasterySource = provideSchemastery()
if (schemasterySource === false) {
  console.error('前置条件不成立：既无法链接也无法为临时副本放置 @deepseek-ai/schemastery 桩')
  process.exit(EXIT.INCOMPLETE)
}
if (schemasterySource === 'stub') {
  console.log('note  @deepseek-ai/schemastery 不可解析（CI 不装依赖）：使用最小 schema 桩；本门断言与 schema 构造无关。')
}
const codePath = stageCode(requestedPath)

console.log('auto-resume 启动恢复契约门（auto-resume.contract.selftest.mjs）')
console.log(`工作区：${ROOT}`)
console.log(`被测代码（来源）：${requestedPath}  sha256(16)=${sha256(requestedPath)}`)
console.log(`被测代码（副本）：${codePath}`)
console.log(`临时目录：${WORK}`)
console.log('')

const before = manifest(ROOT)

// 前置：被测模块必须能被加载（失败属"未完成验证"，不是"契约不成立"）
try {
  await import(`${pathToFileURL(codePath).href}?probe=${Math.random()}`)
} catch (e) {
  console.error(`前置条件不成立：被测模块无法导入 —— ${e.message}`)
  process.exit(EXIT.INCOMPLETE)
}

// 前置：指纹必须能在**被测文件**上定位，否则坏对照与变异体的取值依据不成立（未完成验证，不得读作通过）
if (!readFileSync(requestedPath, 'utf8').includes(BAD_FINGERPRINT)) {
  console.error(`前置条件不成立：被测文件里找不到指纹「${BAD_FINGERPRINT}」——无法定位形状归一化，坏对照与变异体均不成立`)
  console.error(`被测文件：${requestedPath}`)
  process.exit(EXIT.INCOMPLETE)
}

// 1) 快照形状：六类输入的完整判别
{
  const log = await runCase(codePath, 'snapshot')
  check('contract/snapshot-shape · 选中集合（六类输入）',
    sameSet(log.resume, ['s-legal']),
    `实际 resumed = [${log.resume.join(', ')}]，期望 [s-legal]`)
  check('contract/snapshot-shape · 排除 subagent / parentSession / delegationDepth>0 / 开关 false / eventCount=0',
    !log.resume.includes('s-subagent') && !log.resume.includes('s-child')
      && !log.resume.includes('s-depth') && !log.resume.includes('s-off') && !log.resume.includes('s-blank'),
    `实际多选出 = [${log.resume.filter((x) => x !== 's-legal').join(', ')}]`)
}

// 2) 裸 header 形状：向后兼容（eventCount 在裸形状不可得，故 s-blank 无法被排除——如实断言）
{
  const log = await runCase(codePath, 'bare')
  check('contract/bare-header-shape · 选中集合（向后兼容 0.1.2 一线）',
    sameSet(log.resume, ['s-legal', 's-blank']),
    `实际 resumed = [${log.resume.join(', ')}]，期望 [s-legal, s-blank]（裸形状无 eventCount，空白判据不可得）`)
}

// 3) 未识别形状：必须零选中 + 有可诊断告警
{
  const log = await runCase(codePath, 'unrecognized')
  check('contract/unrecognized-shape · 零选中', log.resume.length === 0,
    `实际 resumed = [${log.resume.join(', ')}]`)
  check('contract/unrecognized-shape · 有可诊断告警（不得静默）',
    log.warn.some((w) => /unrecognized shape/i.test(w)),
    `未捕获到告警；实际 warn = ${JSON.stringify(log.warn)}`)
}

// 3.5) 官方恢复链路优先（0.1.6+ ctx.sessionController.resolveAgent）：一旦可用就必须走它
//      （模型选择 installSelection、preset mount、归属校验都在里面），不得再手工 ctx.agents.resume。
{
  const log = await runCase(codePath, 'snapshot', { controller: true })
  check('contract/session-controller · 走官方 resolveAgent 且不再手工 resume',
    sameSet(log.controller, ['s-legal']) && log.resume.length === 0,
    `controller 调用 = [${log.controller.join(', ')}]，agents.resume = [${log.resume.join(', ')}]`
    + '（期望 controller=[s-legal] 且 agents.resume 为空）')
}

// 4) 灵敏度对照：门必须能区分"坏代码"与"好代码"
{
  const legacySrc = resolveLegacyControl()
  if (!legacySrc.ok) {
    console.error(`前置条件不成立：取不到已知坏代码（形状归一化之前的版本）—— ${legacySrc.why}`)
    process.exit(EXIT.INCOMPLETE)
  }
  console.log(`坏对照（${legacySrc.rev}）：${legacySrc.note}`)
  const legacy = await runCase(materialize('legacy-head', legacySrc.text), 'snapshot')
  check(`sensibility/legacy-baseline · 旧代码在快照形状下必须选不中（复现回归；来源 ${legacySrc.rev}）`,
    legacy.resume.length === 0,
    `旧代码竟然选中了 [${legacy.resume.join(', ')}] —— 本门的回归模型不成立`)

  const current = readFileSync(path.join(ROOT, 'lib', 'auto-resume.js'), 'utf8')
  const needle = 'const isSnapshot = item.header !== null && typeof item.header === \'object\''
  if (!current.includes(needle)) {
    console.error('前置条件不成立：当前 lib/auto-resume.js 中找不到形状判别那行，无法构造变异体')
    process.exit(EXIT.INCOMPLETE)
  }
  const mutated = current.replace(needle, 'const isSnapshot = false')
  const disabled = await runCase(materialize('mutate-normalize-disabled', mutated), 'snapshot')
  check('sensibility/normalize-disabled · 判别永不触发时必须选不中（门自身可被证伪）',
    disabled.resume.length === 0,
    `变异体竟然选中了 [${disabled.resume.join(', ')}] —— 本门的断言不承重`)

  // 官方链路优先分支同样要能证伪：关掉优先分支后，controller 断言必须报红。
  const controllerNeedle = 'if (sessionController !== undefined) {'
  if (!current.includes(controllerNeedle)) {
    console.error('前置条件不成立：当前 lib/auto-resume.js 中找不到 sessionController 优先分支，无法构造变异体')
    process.exit(EXIT.INCOMPLETE)
  }
  const noController = await runCase(
    materialize('mutate-controller-branch-disabled', current.replace(controllerNeedle, 'if (false) {')),
    'snapshot',
    { controller: true },
  )
  check('sensibility/session-controller-branch · 关掉优先分支后该断言必须报红',
    noController.controller.length === 0 && noController.resume.length > 0,
    `变异体 controller 调用 = [${noController.controller.join(', ')}]，agents.resume = [${noController.resume.join(', ')}]`
    + '（期望 controller 为空且 agents.resume 非空）')
}

// ------------------------------------------------------------------ 护栏自证（裁定 #53）
// 判据：「不会失败的检查等于没有检查」。两条护栏此前都**没有用例证明它们报得出红**。
// 负向对照（本条自身可失败）：把 `scripts/lib/manifest-guard.mjs` 的 `manifestDiff` 改成
//   `return []` ⇒ 下面三条 `manifestDiff-自证·*` 同时红；把 `assertOutsideWorkspace` 的
//   `nested` 改成 `false` ⇒ `判据-自证·工作区内` 红。（实测读数见 §15 / 交付报告）
{
  const fakeRoot = path.join(TMP_BASE, 'dsh-arv-fake-root')
  const fakeTmp = path.join(TMP_BASE, 'dsh-arv-fake-tmp')
  const j = (...p) => path.join(...p)
  const guard1Cases = [
    { name: '工作区内·真', p: j(fakeRoot, 'sub'), root: fakeRoot, tmp: fakeTmp, reject: true, why: '在工作区根之下' },
    { name: '等于工作区根', p: fakeRoot, root: fakeRoot, tmp: fakeTmp, reject: true, why: '双向包含（相等）' },
    { name: '反向包含·根本身在候选之下', p: fakeTmp, root: j(fakeTmp, 'sub'), tmp: fakeTmp, reject: true, why: 'reverse-nested（裁定 #11 补的那格）' },
    { name: '前缀像但其实无关', p: j(fakeTmp, 'other', 'x'), root: j(fakeTmp, 'oth'), tmp: fakeTmp, reject: false, why: '按分量比较，不是字符串前缀 ⇒ 必须放行' },
    { name: '临时区·合法', p: j(fakeTmp, 'work', 'x'), root: fakeRoot, tmp: fakeTmp, reject: false, why: '在 tmpBase 之下且与根无包含关系' },
    { name: '两者皆非', p: j(path.sep, 'definitely-outside-arv'), root: fakeRoot, tmp: j(fakeTmp, 'nowhere'), reject: true, why: '既不在 tmpBase 下、也不在根下 ⇒ 拒' },
  ]
  for (const c of guard1Cases) {
    let rejected = false
    let m = ''
    try {
      guardPathOk(c.p, '自证', { root: c.root, tmpBase: c.tmp })
    } catch (e) {
      rejected = true
      m = e.message
    }
    check(
      `guard/custom1-判据-自证·${c.name}`,
      rejected === c.reject,
      `期望${c.reject ? '拒绝' : '放行'}（${c.why}），实得${rejected ? '拒绝' : '放行'}`
      + `（p=${c.p} root=${c.root} tmpBase=${c.tmp}）`
      + (rejected && !c.reject ? `；拒绝消息：${m.split('\n')[0]}` : ''),
    )
  }

  const m0 = manifest(ROOT)
  const probe = [...m0.keys()]
  const ignoredInList = probe.filter((k) => k === '.DS_Store' || k.startsWith('.pnpm-store/'))
  check(
    'guard/custom2-清单-自证·非空',
    m0.size >= 10,
    `清单仅 ${m0.size} 条 ⇒ 清单为空或近乎为空时，对拍恒绿（护栏形同虚设）`,
  )
  check(
    'guard/custom2-清单-自证·不含忽略项',
    ignoredInList.length === 0,
    `清单仍含忽略项 ${ignoredInList.length} 条（${ignoredInList.slice(0, 3).join(', ')}）`
    + ' ⇒ 纳入口径未生效：`pnpm install` 或 Finder 一动就让本格报红而**归因错**'
    + '（1524 条里 1474 条 store + 1 条 .DS_Store，真被测面只有 49）',
  )

  const added = new Map(m0)
  added.set('__selfcheck__/新增', '0'.repeat(64))
  check('guard/custom2-manifestDiff-自证·新增', manifestDiff(m0, added).length === 1,
    '造 1 条新增，应报 1 条差异；报 0 条 ⇒ 对拍报不出差异')

  if (probe.length > 0) {
    const k0 = probe[0]
    const changed = new Map(m0)
    changed.set(k0, '0'.repeat(64))
    check('guard/custom2-manifestDiff-自证·内容变化', manifestDiff(m0, changed).length === 1,
      `造 1 条内容变化（键 ${k0}），应报 1 条差异；报 0 条 ⇒ 对拍报不出差异`)

    const deleted = new Map(m0)
    deleted.delete(k0)
    check('guard/custom2-manifestDiff-自证·删除', manifestDiff(m0, deleted).length === 1,
      `造 1 条删除（键 ${k0}），应报 1 条差异；报 0 条 ⇒ 对拍报不出差异`)
  } else {
    check('guard/custom2-manifestDiff-自证·内容变化', false, '清单为空 ⇒ 无法造差异，护栏 2 本就无意义')
    check('guard/custom2-manifestDiff-自证·删除', false, '清单为空 ⇒ 无法造差异，护栏 2 本就无意义')
  }
}

// ------------------------------------------------------------------ 工作区对拍
const diffs = manifestDiff(before, manifest(ROOT))
check('guard/workspace-immutability', diffs.length === 0,
  diffs.length ? diffs.join('；') : '')

// ------------------------------------------------------------------ 汇总
const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`共 ${results.length} 条：通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length > 0) {
  console.error('')
  console.error(`契约门失败 ${failed.length} 条——被测代码不符合启动恢复契约，或门自身的灵敏度对照不成立：`)
  for (const f of failed) console.error(`  - ${f.name}：${f.detail}`)
  console.error(`副本保留在 ${WORK} 以供排查。`)
  process.exit(EXIT.FAIL)
}
console.log('启动恢复契约成立：两种 list() 形状下都选对目标，未识别形状有可诊断告警，灵敏度对照复现，工作区零写入。')
rmSync(WORK, { recursive: true, force: true })
process.exit(EXIT.PASS)
