#!/usr/bin/env node
// 「组提示词」契约门（#56-D-1 第二段）。
//
// 判据来源（唯一真源 = docs/agents/board/a.md §188.2(5)）：
//   ① enabled:false ⇒ 不注入
//   ② 会话不在该组 sessions 里 ⇒ 不注入
//   ③ 两组同时命中 ⇒ 字典键序拼接、块间 '\n\n'
//   ④ interpolate:false 字面保真（正文含 {{x}} / {} 时逐字节不变）
//   ⑤ 状态路由 sessions 形状（title 为 null 时不得抛、路由仍 200/ok）
//   ⑥ 同一路径被全局/工作区/组三段同时引用 ⇒ 缓存不互剔
// 另加 B 在 docs/agents/board/b.md §7.12 交的两条（A 要求「两条都要」）：
//   ⑦ TARGET_NAMES 含 'group-prompt'
//   ⑧ 默认命名空间剔除不越界 —— 且必须配「稳定态每轮新增读盘 = 0 / 改内容后 = > 0」（只有前者会被
//      「干脆不缓存」蒙过去：把缓存整个关掉也能得到「不越界」，但那不是修复）
//
// 退出码：0 通过 · 1 断言不成立 / 未能确证（fail-closed，两者都不退 2）· 2 未能评测 · 64 用法错。
//   —— 裁定 #64：**整门级**「测不了」（被判对象在评测前就不可加载/解析）⇒ 2，输出「未能评测：…」，
//      且**不得**逐条打印 FAIL Cn、**不得**声称「N 条判据不成立」（一条都没被评估过）。
//      机械口径 = `precheck()` 先 import 一次；预检通过后的任何失败仍走 1。
//      判据级「测不了」⇒ 仍 1，但**计数分开**：`failures`（不成立）与 `unverified`（未能确证）。
// 纪律：每条断言各配**恰好一次**负向对照；变异锚点必须恰好命中 1 次，否则判 2（不许静默 no-op）；
//      每条变异只允许翻掉它点名的那条断言，其余断言必须保持绿（未点名的用例不得被连带翻转）。
//
// 用法：
//   node scripts/group-prompt.contract.assert.mjs             # 判真实文件（常驻/CI 路径）
//   node scripts/group-prompt.contract.assert.mjs --selftest   # 基线 + 九份变异，自证本门会报红
//   node scripts/group-prompt.contract.assert.mjs --help
//
// 零外部输入、零裸依赖（只用 node: 内建）。副本一律落 os.tmpdir()，工作区零写入。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TARGET_REL = 'lib/global-prompt.js'
const DEDUP_REL = 'lib/prompt-dedup.js'
const EXIT = { PASS: 0, FAIL: 1, DEVICE: 2, USAGE: 64 }

const argv = process.argv.slice(2)
let selftest = false
let probe = false
for (const a of argv) {
  if (a === '--selftest') selftest = true
  else if (a === '--probe') probe = true
  else if (a === '--help' || a === '-h') {
    console.log('用法：node scripts/group-prompt.contract.assert.mjs [--selftest] [--probe]')
    console.log('  --selftest  造九份变异副本，自证本门会报红（副本在 os.tmpdir()，工作区零写入）')
    console.log('  --probe     只打印每条判据的原始观测值（装置诊断用，不改变判定）')
    process.exit(EXIT.PASS)
  } else {
    console.error('未知参数 ' + a)
    process.exit(EXIT.USAGE)
  }
}

// ── 读盘计数装置 ─────────────────────────────────────────────────────────────
// 实测结论（四种候选机制逐条跑负向对照，见 board/d.md 本节的装置自证表）：
//   registerHooks.initialize 改 data.exports.default / 改 data.exports / Module._load 换掉 fs
//   —— 三种都计不到数（计数恒 0），只有**直接给真 fs 模块对象上的 readFileSync 包一层**
//   （patch-by-reference）能计到数。被测文件 `import fs from 'node:fs'` 拿到的就是这个对象本身。
// 计数恒 0 会被读成「被测对象不缓存」，所以这里必须先自证计数是真的再敢用它判 C6/C8。
const READS = { count: 0, paths: [] }
const REAL_READ_FILE_SYNC = fs.readFileSync
fs.readFileSync = function countingReadFileSync(...args) {
  READS.count += 1
  READS.paths.push(typeof args[0] === 'string' ? args[0] : String(args[0]))
  return REAL_READ_FILE_SYNC.apply(fs, args)
}
// 装置自证：本文件自己读一次盘，计数必须 +1；否则立刻判 2（不许让「恒 0」冒充断言依据）。
{
  const before = READS.count
  REAL_READ_FILE_SYNC.call(fs, path.join(ROOT, 'package.json'), 'utf8')
  if (READS.count !== before) {
    console.error('装置没跑成：自证读盘把计数器也动了 —— 计数装置与被测调用不可能是同一路径')
    process.exit(EXIT.DEVICE)
  }
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
  if (READS.count !== before + 1) {
    console.error('装置没跑成：包一层后自己读盘计不到数（count=' + READS.count + '）⇒ C6/C8 的读数无意义')
    process.exit(EXIT.DEVICE)
  }
  READS.count = 0
  READS.paths.length = 0
}

// ── 假 ctx（只实现被测文件真正用到的那几项）──────────────────────────────────
// cfg 里的「ref」= 带 get() 的对象（lib/global-prompt.js:271 `ref.get()`）——见下面 cfg 构造处的注释。
function refOf(value) {
  return { get: () => value, set: () => {}, update: () => {} }
}
function makeCtx(opts = {}) {
  const sections = []
  const agents = opts.agents || []
  const services = opts.services || {}
  const events = {}
  const timeouts = []
  return {
    sections,
    events,
    timeouts,
    agents: { roots: () => agents },
    timeout: (fn) => { timeouts.push(fn) },
    on: (name, fn) => { (events[name] = events[name] || []).push(fn); return () => {} },
    get: (name) => services[name],
    effect: (fn) => { try { fn() } catch (e) { throw e } return () => {} },
    // 真身写法是 ctx.inject(['webServer'], (childCtx) => { const webServer = childCtx.get('webServer') ... })
    // ⇒ childCtx 必须能 get 到与父 ctx 同一份服务（否则路由永远不注册，而我却会把它读成「路由没实现」）。
    inject: (list, fn) => {
      if (typeof fn !== 'function') return () => {}
      const missing = list.filter((name) => !services[name])
      if (missing.length) return () => {}
      return fn({
        get: (name) => services[name],
        effect: (f) => { try { f() } catch (e) { throw e } return () => {} },
      })
    },
    systemPrompt: {
      section: (s) => { sections.push(s); return s },
    },
  }
}
function agentOf(id, cwd) {
  return { session: { header: cwd === undefined ? { id } : { id, cwd } } }
}
function findByPath(sections, name) {
  return sections.filter((s) => s && s.name === name)
}
// 假 webServer：注册即记录 handler；host 用 127.0.0.1（originGuard 的 no-origin 分支要求合法 Host）
function makeWebServer(route) {
  return {
    host: '127.0.0.1',
    register: (spec) => { route.handler = spec.handler; route.path = spec.path; return () => {} },
  }
}
function fakeReq(method, headers) {
  return { method, headers: Object.assign({ host: '127.0.0.1' }, headers || {}) }
}
function fakeRes() {
  const res = {
    status: null,
    headers: null,
    body: '',
    writeHead: (code, h) => { res.status = code; res.headers = h },
    end: (s) => { res.body = s === undefined ? '' : String(s) },
  }
  return res
}

// ── 沙箱加载（变异副本用；真身直接从仓库导入）────────────────────────────────
// ⚠️ ESM 缓存绕行必须用**单调递增**的 query：`?t=Date.now()` 在同一毫秒内会重复
//    （实测：两万次连续调用有 19,998 次重复值；同 URL 再 import 会返回**同一模块实例**，
//    改盘也不重载）⇒ 连续两份变异体会拿到同一实例，判的其实是上一份，自证形同虚设
//    （本门实测因此把 M9 判成「没报红」）。这里改用自增计数器 + 随机数。
let MODULE_URL_SEQ = 0
const freshUrl = (file) => pathToFileURL(file).href + '?t=' + (MODULE_URL_SEQ++) + '-' + Math.random().toString(36).slice(2)
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd-gpguard-'))
  // 被测文件的相对导入 ./request-guard.js 在沙箱里必须存在：给一个「总是放行」的桩。
  fs.writeFileSync(path.join(dir, 'request-guard.js'), 'export function originGuard() { return true }\n')
  return dir
}
async function loadGlobalPrompt(sourceText) {
  if (sourceText === null) {
    const url = freshUrl(path.join(ROOT, TARGET_REL))
    return { mod: await import(url), dir: null }
  }
  const dir = sandbox()
  const file = path.join(dir, 'global-prompt.js')
  fs.writeFileSync(file, sourceText)
  if (process.env.GPDEBUG) console.error('[GPDEBUG-load] 落盘 ' + file + ' 含M9守卫=' + sourceText.includes("if (pre === '' && wanted.indexOf") + ' 含M8形态=' + sourceText.includes('readPromptFiles(files, limits, fileCache)'))
  const url = freshUrl(file)
  return { mod: await import(url), dir }
}
// ⚠️ 落盘副本的目录必须有人收尾：`loadDedup` 造的是**新目录**（不是 `runOnce` 的 `dirs` 台账），
//    早先只有 `loadGlobalPrompt` 的返回值被登记 ⇒ 每次变异自证都漏一批 `d-gpguard-dedup-*`
//    （实测盘上积到 376 个、近 10 分钟 112 个）。这里用一个模块级台账接住，由 `runOnce` 的 finally 统一删。
const LIVE_DIRS = new Set()
async function loadDedup(sourceText) {
  if (sourceText === null) {
    const url = freshUrl(path.join(ROOT, DEDUP_REL))
    return await import(url)
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd-gpguard-dedup-'))
  LIVE_DIRS.add(dir)
  const file = path.join(dir, 'prompt-dedup.js')
  fs.writeFileSync(file, sourceText)
  const url = freshUrl(file)
  return await import(url)
}

// ── 断言登记（每条自带一个负向对照 id）──────────────────────────────────────
const CRITERIA = []
function crit(id, title, negative, fn) { CRITERIA.push({ id, title, negative, fn }) }

// 固定的用户正文与引用文件内容（出现顺序即断言口径）
const CONTENT_A = '组A正文 {{x}} 与 {} 花括号'
const EXTRA = '引用文件内容'

crit('C1', 'enabled:false ⇒ 不注入', 'M1（把 enabled 判定拿掉）', async (run) => {
  const notes = []
  const r = await run({
    groups: { g1: { enabled: false, content: CONTENT_A, files: [], sessions: ['s1'] } },
    agent: agentOf('s1', '/repo'),
  })
  if (r.groupText !== '') return ['期望不注入（空串），实得 ' + JSON.stringify(r.groupText)]
  notes.push('enabled:false 时 group 段 text() = ""')
  // 对照面：同一份 config 把 enabled 打开就必须注入（否则 C1 会被「恒不注入」蒙过去）
  const r2 = await run({
    groups: { g1: { enabled: true, content: CONTENT_A, files: [], sessions: ['s1'] } },
    agent: agentOf('s1', '/repo'),
  })
  if (!r2.groupText.includes(CONTENT_A)) return ['反向对照不成立：enabled:true 时也没注入（' + JSON.stringify(r2.groupText) + '）']
  notes.push('enabled:true 时注入（反向对照成立）')
  return { notes }
})

crit('C2', '会话不在该组 sessions 里 ⇒ 不注入', 'M2（把成员判定拿掉）', async (run) => {
  const notes = []
  const r = await run({
    groups: { g1: { enabled: true, content: CONTENT_A, files: [], sessions: ['other-session'] } },
    agent: agentOf('s1', '/repo'),
  })
  if (r.groupText !== '') return ['期望不注入，实得 ' + JSON.stringify(r.groupText)]
  notes.push('sessions 不含当前 id ⇒ ""')
  const r2 = await run({
    groups: { g1: { enabled: true, content: CONTENT_A, files: [], sessions: ['other-session', 's1'] } },
    agent: agentOf('s1', '/repo'),
  })
  if (!r2.groupText.includes(CONTENT_A)) return ['反向对照不成立：把 s1 加进 sessions 后仍不注入']
  notes.push('把 s1 加进 sessions 后注入（反向对照成立）')
  // 无 header.id 的会话：一律不注入（不得因缺 id 而误命中）
  const r3 = await run({
    groups: { g1: { enabled: true, content: CONTENT_A, files: [], sessions: [''] } },
    agent: { session: {} },
  })
  if (r3.groupText !== '') return ['无 id 的会话被注入了：' + JSON.stringify(r3.groupText)]
  notes.push('无 id 的会话 ⇒ ""')
  return { notes }
})

crit('C3', '两组同时命中 ⇒ 字典键序拼接、块间 \'\\n\\n\'', 'M3（块间分隔改成单 \\n）', async (run) => {
  const groups = {}
  groups.bGroup = { enabled: true, content: 'B 块', files: [], sessions: ['s1'] }
  groups.aGroup = { enabled: true, content: 'A 块', files: [], sessions: ['s1'] }
  groups.cGroup = { enabled: true, content: 'C 块', files: [], sessions: ['s1'] }
  const r = await run({ groups, agent: agentOf('s1', '/repo') })
  const want = 'B 块\n\nA 块\n\nC 块'
  if (r.groupText !== want) return ['期望 ' + JSON.stringify(want) + '，实得 ' + JSON.stringify(r.groupText)]
  // 键序是「字典键的文件顺序」而不是字母序：把顺序改掉，输出必须跟着改（否则是巧合）
  const groups2 = {}
  groups2.cGroup = groups.cGroup
  groups2.aGroup = groups.aGroup
  groups2.bGroup = groups.bGroup
  const r2 = await run({ groups: groups2, agent: agentOf('s1', '/repo') })
  const want2 = 'C 块\n\nA 块\n\nB 块'
  if (r2.groupText !== want2) return ['键序跟随失败：期望 ' + JSON.stringify(want2) + '，实得 ' + JSON.stringify(r2.groupText)]
  // 块内 content 与引用文件之间只有一个 '\n'（与块间区分开）
  const r3 = await run({
    groups: { g1: { enabled: true, content: 'X', files: ['ref.md'], sessions: ['s1'] } },
    agent: agentOf('s1', '/repo'),
  })
  const want3 = 'X\n' + EXTRA
  if (r3.groupText !== want3) return ['块内拼接：期望 ' + JSON.stringify(want3) + '，实得 ' + JSON.stringify(r3.groupText) + '（引用文件实际路径 ' + r3.filePath + '）']
  return { notes: ['三组键序 b→a→c 输出 ' + JSON.stringify(r.groupText), '改键序后输出跟随', '块内 content+文件 = 单 \\n'] }
})

crit('C4', 'interpolate:false 字面保真（{{x}} / {} 逐字节不变）', 'M4（改成 interpolate:true）', async (run) => {
  const text = '正文 {{name}} 与 {not-a-var} 与 {{}} 三处'
  const r = await run({
    groups: { g1: { enabled: true, content: text, files: [], sessions: ['s1'] } },
    agent: agentOf('s1', '/repo'),
  })
  const out = []
  // ① 注册面：段必须声明 interpolate:false（这是「内核不会去插值」的机制）
  if (r.groupInterpolate !== false) out.push('group 段的 interpolate 不是 false，实得 ' + JSON.stringify(r.groupInterpolate))
  // ② 内容面：text() 抛出的字符串里 {{name}} / {} 逐字节不变
  if (r.groupText !== text) out.push('字面保真失败：期望 ' + JSON.stringify(text) + '，实得 ' + JSON.stringify(r.groupText))
  else out.push('正文三处花括号逐字节不变')
  // ③ 边界：纯 {} 与未闭合 { 都不得被改写
  for (const s of ['{}', '{{', '{ }', '{{x}}']) {
    const rr = await run({ groups: { g1: { enabled: true, content: s, files: [], sessions: ['s1'] } }, agent: agentOf('s1', '/repo') })
    if (rr.groupText !== s) out.push('边界 ' + JSON.stringify(s) + ' 被改写为 ' + JSON.stringify(rr.groupText))
  }
  return out.length && out.some((x) => x.includes('失败') || x.includes('不是') || x.includes('改写')) ? out : { notes: out }
})

crit('C5', '状态路由 sessions 形状（title 为 null 不得抛、路由仍 200/ok）', 'M5（title 读取不兜错）', async (run) => {
  const out = []
  const notes = []
  const r = await run({
    groups: {},
    agent: agentOf('s1', '/repo'),
    services: {},
    route: true,
  })
  if (r.routeStatus !== 200) out.push('路由状态码不是 200，实得 ' + JSON.stringify(r.routeStatus))
  if (!r.routeBody || r.routeBody.ok !== true) out.push('响应体 ok 不是 true：' + JSON.stringify(r.routeBody))
  const ss = r.routeBody && r.routeBody.sessions
  if (!Array.isArray(ss)) return out.concat(['sessions 不是数组：' + JSON.stringify(ss)])
  if (ss.length !== r.agents.length) out.push('sessions 条数 ' + ss.length + ' ≠ 根会话数 ' + r.agents.length)
  for (const s of ss) {
    if (typeof s.id !== 'string') out.push('id 不是 string：' + JSON.stringify(s))
    if (!('cwd' in s) || (s.cwd !== null && typeof s.cwd !== 'string')) out.push('cwd 不是 string|null：' + JSON.stringify(s))
    if (!('title' in s) || (s.title !== null && typeof s.title !== 'string')) out.push('title 不是 string|null：' + JSON.stringify(s))
  }
  // 服务缺席 ⇒ 全部 title = null（不得抛）
  if (!ss.every((s) => s.title === null)) out.push('无 sessionTitle 服务时 title 应全为 null：' + JSON.stringify(ss))
  notes.push('无服务：200/ok · title 全 null · 形状正确')
  // 服务抛错 ⇒ 仍 200/ok、title 仍 null
  const r2 = await run({
    groups: {},
    agent: agentOf('s1', '/repo'),
    route: true,
    services: { sessionTitle: { get: () => { throw new Error('boom') } } },
  })
  if (r2.routeStatus !== 200 || !r2.routeBody || r2.routeBody.ok !== true) out.push('sessionTitle 抛错时路由坏了：' + r2.routeStatus + ' ' + JSON.stringify(r2.routeBody))
  else if (!r2.routeBody.sessions.every((s) => s.title === null)) out.push('抛错时 title 应全 null：' + JSON.stringify(r2.routeBody.sessions))
  else notes.push('sessionTitle 抛错：仍 200/ok · title 全 null')
  // 服务在场且有标题 ⇒ 标题被用上（否则「永远 null」也能过）
  const r3 = await run({
    groups: {},
    agent: agentOf('s1', '/repo'),
    route: true,
    services: { sessionTitle: { get: () => ({ title: '真标题' }) } },
  })
  const got = r3.routeBody && r3.routeBody.sessions && r3.routeBody.sessions[0]
  if (!got || got.title !== '真标题') out.push('服务在场时标题没被用上：' + JSON.stringify(got))
  else notes.push('服务在场：title = 真标题（反向对照成立）')
  // 服务返回**非串** title ⇒ 不得把任意值当标题端出去（这条是 M5 的观测面）。
  //  ⚠️ 第一版写成「get 不是函数」⇒ 守卫 `canReadTitle` 本来就为 false、M5 的变异在 try 内部，
  //     两者都走不到那行，读数逐项相同 ⇒ 又是空断言（实测「get 不可调用：未调用它、title 仍 null」）。
  //     观测面必须落在**真被调用的那条路径**上：get 可调用、返回非串。
  const r5 = await run({
    groups: {},
    agent: agentOf('s1', '/repo'),
    route: true,
    services: { sessionTitle: { get: () => ({ title: { nope: 1 } }) } },
  })
  if (r5.routeStatus !== 200 || !r5.routeBody || r5.routeBody.ok !== true) out.push('sessionTitle 返回非串标题时路由坏了：' + r5.routeStatus + ' ' + JSON.stringify(r5.routeBody))
  else {
    const bad = (r5.routeBody.sessions || []).filter((s) => s.title !== null)
    if (bad.length) out.push('服务返回非串 title 时不得端出该值，实得：' + JSON.stringify(bad))
    else notes.push('服务返回非串 title：未端出该值、title 仍 null（反向对照成立）')
  }
  // cwd 缺省 ⇒ null（不是 undefined、不是空串）
  const r4 = await run({ groups: {}, agent: { session: { header: { id: 'no-cwd' } } }, route: true })
  const g4 = r4.routeBody && r4.routeBody.sessions && r4.routeBody.sessions[0]
  if (!g4 || g4.cwd !== null) out.push('缺 cwd 时 cwd 应为 null：' + JSON.stringify(g4))
  else notes.push('缺 cwd ⇒ null')
  return out.length ? out : { notes }
})

crit('C6', '同一路径被全局/工作区/组三段同时引用 ⇒ 缓存不互剔', 'M6（默认命名空间剔除越界）', async (run) => {
  const notes = []
  // 三段同时引用同一个文件：每段各渲染 2 轮。第 2 轮不得新增读盘（= 第 1 轮读进缓存的条目还在）。
  const r = await run({
    groups: { g1: { enabled: true, content: 'G', files: ['ref.md'], sessions: ['s1'] } },
    agent: agentOf('s1', '/repo'),
    global: { enabled: true, content: 'GLOB', files: ['ref.md'] },
    workspace: { '/repo': { enabled: true, content: 'WS', files: ['ref.md'] } },
    rounds: 2,
  })
  const out = []
  if (r.deviceError) return [r.deviceError]
  if (!r.readsPerRound || r.readsPerRound.length !== 2) return ['装置没跑成：轮数 = ' + JSON.stringify(r.readsPerRound)]
  // 口径：readsPerRound = [第 1 轮**累计**读盘, 第 2 轮的**增量**]。
  // 所以判据是 readsPerRound[1] === 0，不是两轮之差（拿差值判会得到 -2 的假红）。
  if (r.readsPerRound[0] === 0) return ['装置没跑成：第 1 轮 0 次读盘 ⇒ 三段其实没引用到那个文件（引用路径 ' + r.filePath + '）']
  if (r.readsPerRound[1] !== 0) out.push('第 2 轮新增读盘 = ' + r.readsPerRound[1] + '（必须 0 —— 说明第 1 轮读进的条目被别的命名空间剔掉了）')
  else notes.push('三段同引一个文件：第 1 轮 ' + r.readsPerRound[0] + ' 次读盘（累计），第 2 轮新增 0 次')
  // 反向对照：把盘上内容改掉必须触发重读（证明计数装置真的在观测读盘，不是恒 0）
  if (r.readsAfterChange <= 0) out.push('改盘上内容后没有重读（readsAfterChange=' + r.readsAfterChange + '）⇒ 计数装置可疑，本条的绿不能采信')
  else notes.push('改盘上内容后新增读盘 ' + r.readsAfterChange + ' 次（计数装置是真的）')
  return out.length ? out : { notes }
})

crit('C7', 'TARGET_NAMES 含 \'group-prompt\'（去重范围含组段）', 'M7（数组里去掉 group-prompt）', async (run) => {
  const r = await run({ dedup: true })
  const out = []
  if (r.deviceError) return [r.deviceError]
  // ① 数组字面量必须含 'group-prompt'
  if (!r.targetNames || !r.targetNames.includes('group-prompt')) out.push('源码 TARGET_NAMES 不含 group-prompt：' + JSON.stringify(r.targetNames))
  // ② 它真的接上了：组段也去重。
  //    口径已核清：prompt-dedup 是**行级**去重（split('\n') 后按行比对，空行也算一行），
  //    所以 '组段独有行\nDUP\n\nDUP' 的结果就是 '组段独有行\n' —— 末行后面那个空行来自
  //    原文结构（第 2、3 个 \n 之间是空行），不是实现多加了换行。改成逐字节断言这个已知值，
  //    这样「组段没被去重」（M7 形态）与「整段被清掉」都会红。
  if (r.dedupOut !== '组段独有行\n') out.push('组段去重结果不符：期望 "组段独有行\\n"（行级去重后只剩独有行 + 原文空行结构），实得 ' + JSON.stringify(r.dedupOut))
  if (typeof r.dedupOut === 'string' && r.dedupOut.includes('DUP')) out.push('组段里与全局段同行的 DUP 没被删：' + JSON.stringify(r.dedupOut))
  if (typeof r.dedupOut === 'string' && !r.dedupOut.includes('组段独有行')) out.push('组段独有的内容被误删了：' + JSON.stringify(r.dedupOut))
  // ③ 范围不得越界：非目标段（harness）一字不动
  if (r.untouched !== 'DUP\nHARNESS') out.push('非目标段被改动了：' + JSON.stringify(r.untouched))
  return out.length ? out : {
    notes: [
      'TARGET_NAMES = ' + JSON.stringify(r.targetNames),
      '组段独有行保留、与全局段同行的重复行被删（' + JSON.stringify(r.dedupOut) + '）',
      '非目标段一字不动（' + JSON.stringify(r.untouched) + '）',
    ],
  }
})
crit('C8', '默认命名空间剔除不越界（且稳定态零新增读盘、改内容后 > 0）', 'M8（组段丢掉 group: 前缀 → 与默认段同键）', async (run) => {
  const out = []
  const notes = []
  // 8a：默认两段渲染时不得剔掉 'group:*' 条目（那是别的段还要用的）。
  // 判据 = 「内容不变时组段再渲染不再读盘」（条目还活着）。若默认段把它剔了，组段下次必然重读。
  // ⚠️ 场景必须让**默认段也引用同一个文件**：否则默认段的 wanted 恒空、缓存里也没有它的键
  //    （剔除循环遍历空集）⇒ 命名空间冲突根本没有观测面，M8 这类变异翻不动这条断言。
  const g = { g1: { enabled: true, content: 'G', files: ['ref.md'], sessions: ['s1'] } }
  // ⚠️ 场景必须让**默认两段也真的引用同一路径**：否则默认段的 wanted 为空、缓存里也没有它
  //    自己的键（剔除循环遍历空集）⇒ 命名空间冲突没有观测面，M8 这类变异根本翻不动这条断言
  //    （实测：默认段两段都不引用时，M8 与基线读数逐项相同）。global 段还须 enabled。
  const sharedDefault = { global: { enabled: true, content: 'GLOB', files: ['ref.md'] }, workspace: { '/repo': { enabled: true, content: 'WS', files: ['ref.md'] } } }
  const a = await run(Object.assign({ stage: 'a', groups: g, agent: agentOf('s1', '/repo') }, sharedDefault))
  if (a.deviceError) return [a.deviceError]
  if (a.readsDefaultStep2 !== 1) out.push('默认两段渲染这次读了 ' + a.readsDefaultStep2 + ' 次盘（期望 1：默认两段按同一无前缀键共享缓存，先到者读、后到者命中）⇒ 场景前提没接上，8a 不是有效观测')
  else if (a.readsAfterStable !== 0) out.push('默认段渲染后 group 条目已失效：内容不变时组段仍重读 ' + a.readsAfterStable + ' 次 ⇒ 被默认段的剔除循环越界剔掉（默认段与组段引用同一路径时不得互剔）')
  else notes.push('8a 同一路径被默认段与组段同时引用：默认两段按各自的无前缀键读盘 ' + a.readsDefaultStep2 + ' 次（先到者读、后到者命中），默认段渲染后组条目仍在 ⇒ 稳定态组段 0 次读盘（此前改内容时重读 ' + a.readsAfterChange + ' 次）')
  // 8b：反向对照 —— 组段自己不再引用那个文件时，条目**必须**被剔（否则「干脆永不剔除」也能过 8a）。
  //     判别量只能来自**内容**：真身 `lib/global-prompt.js:129 fs.statSync(f)` 先于 `:147 cache.get(ck)`
  //     ⇒ 把文件删掉分辨不出条目留没留（stat 先抛、走 :155 catch、陈旧条目永远端不出来 = 空断言）。
  //     所以改成「同尺寸改内容 + 回写 mtime」：缓存命中判据（:148 比 mtimeMs/size）看不出变化 ⇒
  //       条目已剔 ⇒ 第三步真读盘 ⇒ 新内容；条目仍在 ⇒ 缓存命中 ⇒ 端出第一步的旧内容。
  const b = await run(Object.assign({ stage: 'b', groups: g, files: { 'ref.md': EXTRA }, agent: agentOf('s1', '/repo') }, sharedDefault))
  if (b.deviceError) return [b.deviceError]
  if (b.staleOldText) out.push('组段不再引用该文件后条目仍被留着：条目没被剔、重新引用时缓存命中，端出的是第一步的旧正文 ' + JSON.stringify(String(b.textAfterReAdd).slice(0, 40)) + '（读数：引用 ' + b.readGroup + ' / 摘引用 ' + b.readEmpty + ' / 重新引用 ' + b.readAfterReAdd + '）')
  else if (b.changeFailed || b.sizeMismatch) out.push('8b 装置：没能做出「同尺寸改内容 + 回写 mtime」的盘上改动（changeFailed=' + String(b.changeFailed) + ' sizeMismatch=' + String(b.sizeMismatch) + '）⇒ 这条判据的判别力不成立')
  else if (b.gotNewText !== true) out.push('8b 装置：重新引用后组段既没端出旧正文、也没端出新正文（实得 ' + JSON.stringify(String(b.textAfterReAdd).slice(0, 40)) + '）⇒ 观测点没接上')
  else notes.push('8b 组段不再引用后条目确实被剔（引用 ' + b.readGroup + ' / 摘引用 ' + b.readEmpty + ' / 重新引用 ' + b.readAfterReAdd + '；同尺寸改内容后重新引用拿到的是新内容 ' + JSON.stringify(String(b.textAfterReAdd).slice(0, 20)) + '，不是旧正文）')
  return out.length ? out : { notes }
})

// ── 单次运行器 ───────────────────────────────────────────────────────────────
// 参数 opts 决定跑哪条断言所需的场景。返回给断言用的观测值。
async function runOnce(sourceText, dedupText, opts) {
  READS.count = 0
  READS.paths = []
  const dirs = []
  const notes = []
  try {
    if (opts.dedup) {
      const dedup = await loadDedup(dedupText)
      const sections = [
        { name: 'session-identity', text: 'ID' },
        { name: 'global-prompt', text: 'DUP\nGLOB-ONLY' },
        { name: 'group-prompt', text: '组段独有行\nDUP\n\nDUP' },
        { name: 'workspace-prompt', text: 'WS-ONLY' },
        { name: 'harness:persona', text: 'DUP\nHARNESS' },
      ]
      const assembly = { sections: sections.map((s) => ({ name: s.name, text: s.text })) }
      const ctx = makeCtx({ services: {} })
      dedup.apply(ctx, {})
      const handlers = (ctx.events['system-prompt/assemble'] || [])
      if (handlers.length !== 1) return { deviceError: 'prompt-dedup 没注册恰好 1 个 system-prompt/assemble handler（' + handlers.length + '）' }
      const r = await handlers[0](assembly, {}, async () => assembly)
      const byName = {}
      for (const s of (r && r.sections) || []) byName[s.name] = s.text
      // TARGET_NAMES 要跟被判的那份源码同源：变异副本走 dedupText，真身走盘上文件。
      const src = dedupText === null ? fs.readFileSync(path.join(ROOT, DEDUP_REL), 'utf8') : dedupText
      const m = src.match(/const TARGET_NAMES = \[([^\]]*)\]/)
      const targetNames = m
        ? m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter((s) => s !== '')
        : null
      return {
        targetNames,
        dedupOut: byName['group-prompt'],
        untouched: byName['harness:persona'],
        _byName: byName,
      }
    }
    if (opts.dedupNames) {
      const dedup = await loadDedup(dedupText)
      const src = (dedupText === null)
        ? fs.readFileSync(path.join(ROOT, DEDUP_REL), 'utf8')
        : dedupText
      const m = src.match(/const TARGET_NAMES = \[([^\]]*)\]/)
      if (!m) return { deviceError: '没在源码里找到 TARGET_NAMES 数组字面量' }
      const targetNames = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter((s) => s !== '')
      const assembly = {
        sections: [
          { name: 'global-prompt', text: 'DUP\nGLOB-ONLY' },
          { name: 'group-prompt', text: '组段独有行\nDUP' },
          { name: 'harness:persona', text: 'DUP\nHARNESS' },
        ],
      }
      const ctx2 = makeCtx({ services: {} })
      dedup.apply(ctx2, {})
      const hs = (ctx2.events['system-prompt/assemble'] || [])
      if (hs.length !== 1) return { deviceError: 'prompt-dedup 没注册恰好 1 个 system-prompt/assemble handler（' + hs.length + '）' }
      const res = await hs[0](assembly, {}, async () => assembly)
      const byName = {}
      for (const s of (res && res.sections) || []) byName[s.name] = s.text
      return {
        targetNames,
        dedupOut: byName['group-prompt'],
        untouched: byName['harness:persona'],
        dupAssemblyBeyondTargets: !byName['session-identity'],
      }
    }

    // ── global-prompt 侧 ──
    const files = opts.files || {}
    const filePaths = {}
    for (const [name, text] of Object.entries(files)) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'd-gpguard-file-'))
      dirs.push(d)
      const p = path.join(d, name)
      fs.writeFileSync(p, text)
      // ⚠️ 把 mtime 对齐到整毫秒：`statSync().mtimeMs` 是**浮点毫秒**，常带微秒尾巴（实测
      //    1790575314403.780029）。`fs.utimesSync(target, atime, mtime)` 收的是**浮点秒**，这个
      //    尾巴在 ms→s→ns 往返里会被截掉（实测回写后 1790575314404.000000）⇒ `:148` 的
      //    `entry.mtimeMs !== st.mtimeMs` 恒为真 ⇒ **任何「同尺寸改内容 + 回写 mtime」的缓存命中
      //    判据都恒 miss**（实测：M9 下同样 miss，于是「条目留没留」永远分辨不出，8b 空了一整轮）。
      //    对齐到整毫秒后该值是「整数毫秒」在 f64 里精确可表 ⇒ 往返逐位无损。
      try {
        const stAlign = fs.statSync(p)
        fs.utimesSync(p, stAlign.atime, Math.floor(stAlign.mtimeMs) / 1000)
      } catch (e) { /* 对齐失败不致命：由 stage b 的装置自证报「装置判别力不成立」 */ }
      filePaths[name] = p
    }
    const groups = JSON.parse(JSON.stringify(opts.groups || {}))
    for (const g of Object.values(groups)) {
      if (Array.isArray(g.files)) g.files = g.files.map((f) => filePaths[f] || f)
    }
    const globalFiles = ((opts.global && opts.global.files) || []).map((f) => filePaths[f] || f)
    const wsFiles = {}
    for (const [k, v] of Object.entries(opts.workspace || {})) {
      wsFiles[k] = Object.assign({}, v, { files: ((v.files) || []).map((f) => filePaths[f] || f) })
    }
    // cfg.workspace.workspaces 必须是**绝对路径为键**的字典（工作区段按 cwd 前缀匹配后取最具体者）。
    // 断言里要引用临时文件时用 'ref.md'/'ws.md' 这种字面名，由上面两份映射翻成真绝对路径；
    // 想按 cwd 命中还得让 key 本身是绝对路径 —— 故这里再补一条映射：字面键名 → 临时目录。
    const wsPaths = {}
    for (const [k, v] of Object.entries(wsFiles)) {
      const key = filePaths[k] || k
      const mapped = {}
      for (const [kk, vv] of Object.entries(v)) mapped[kk] = vv
      wsPaths[key] = mapped
    }
    const route = {}
    const services = Object.assign({}, opts.services)
    if (opts.route) {
      services.webServer = makeWebServer(route)
      if (!services.sessionTitle) delete services.sessionTitle
    }
    const ctx = makeCtx({ agents: opts.agents || (opts.agent ? [opts.agent] : []), services })
    const loaded = await loadGlobalPrompt(sourceText)
    if (loaded.dir) dirs.push(loaded.dir)
    const contentText = sourceText === null ? fs.readFileSync(path.join(ROOT, TARGET_REL), 'utf8') : sourceText
    // 组的 config 从源码里取出 ref 的形状：直接按被测文件的 apply 约定构造 cfg
    // —— 被测文件读 cfg.group.groups / cfg.workspace.workspaces / cfg.global.*
    const cfg = {
      // 关键：cfg 里放的就是 ref 本身（{ get: () => 值 }），**不能再包一层**。
      // lib/global-prompt.js:271-274 的 volatileValue 是 `ref.get()`，包成「ref 的 ref」会让
      // get() 返回 ref 对象本身 ⇒ 组段 Object.keys 落空 ⇒ 恒返回空串（装置假红，不是实现缺陷）。
      global: { sectionOrder: 50, workspaceSectionOrder: 60, enabled: refOf(opts.global ? opts.global.enabled === true : false), content: refOf(opts.global ? opts.global.content : ''), files: refOf(globalFiles) },
      workspace: { workspaces: refOf(wsPaths), removed: refOf([]) },
      group: { sectionOrder: 55, groups: refOf(groups) },
    }
    loaded.mod.apply(ctx, cfg)
    const groupSecs = findByPath(ctx.sections, 'group-prompt')
    if (groupSecs.length !== 1) return { deviceError: '没抓到恰好 1 个 name=group-prompt 的 section（实得 ' + ctx.sections.map((s) => s.name).join(',') + '）' }
    const gsec = groupSecs[0]

    if (opts.route) {
      const handler = route.handler
      if (typeof handler !== 'function') return { deviceError: '路由没注册（webServer.register 没被调用）' }
      const req = fakeReq('GET')
      const res = fakeRes()
      handler(req, res)
      let parsed = null
      try { parsed = JSON.parse(res.body) } catch (e) { /* 保持 null */ }
      return {
        routeStatus: res.status,
        routeBody: parsed,
        agents: ctx.agents.roots(),
        _ctx: ctx,
      }
    }

    // 缓存场景（C6/C8）：需要「按轮渲染」。C8 分两阶段，故这里用 opts.stage 决定
    if (opts.stage === 'a' || opts.stage === 'b') {
      const fpath = filePaths['ref.md']
      if (!fpath) return { deviceError: '阶段 ' + opts.stage + ' 场景缺 ref.md 映射' }
      const renderDefault = () => {
        for (const s of findByPath(ctx.sections, 'global-prompt')) if (s.text) s.text({ agent: opts.agent })
        for (const s of findByPath(ctx.sections, 'workspace-prompt')) if (s.text) s.text({ agent: opts.agent })
      }
      const renderGroup = () => {
        let last = ''
        for (const s of findByPath(ctx.sections, 'group-prompt')) if (s.text) last = s.text({ agent: opts.agent })
        return last
      }
      if (opts.stage === 'b') {
        // 8b（负向对照）：**不被引用的条目必须被剔**，否则「干脆永不剔除」也能过 8a。
        // 判据只能靠「没剔掉的条目留下副作用」——读盘次数在这里判不出来（实测：摘引用→重引用
        // 那一步必然把条目写回缓存，与「从未剔除」读数逐项相同，M9 下也是 0 ⇒ 恒绿空断言）。
        // 能分出差别的只有**内容**：把文件从盘上删掉，再重新引用它 ——
        //   条目已被剔 ⇒ 重新引用只能真读盘 ⇒ 文件不在 ⇒ 空体（组段返回 ''）；
        //   条目仍在   ⇒ 缓存命中（键还在，无 stat/读盘）⇒ 把**已删除文件**的旧正文端上来。
        // 这正是 B 说的「两者都要」的另一半：8a 证明不越界剔、8b 证明该剔的真剔。
        const grec = (opts.groups && opts.groups.g1) || null
        if (!grec) return { deviceError: '阶段 b 需要 opts.groups.g1' }
        // ⚠️ `opts.groups` 是**外层未映射**的对象：`runOnce` 里的深拷贝（:486）与 `filePaths` 映射
        //    （:488）只作用于它自己的副本。这里必须自己再过一遍 filePaths，否则 `original.g1[0]`
        //    是字面量 'ref.md' ⇒ unlink 删的是仓库里的相对路径（删不掉）、「文件还在=false」是假读数，
        //    整条判据退化成空断言（本门实测如此）。映射后的真值同时供 unlink 与回填使用。
        const mapFiles = (arr) => (Array.isArray(arr) ? arr.map((f) => filePaths[f] || f) : [])
        const original = {}
        for (const k of Object.keys(groups)) original[k] = mapFiles(groups[k].files)
        const withFiles = () => { for (const k of Object.keys(groups)) groups[k].files = original[k].slice() }
        const withoutFilesAll = () => { for (const k of Object.keys(groups)) groups[k].files = [] }
        const d0 = READS.count
        const text1 = renderGroup()
        const readGroup = READS.count - d0
        if (readGroup === 0) return { deviceError: '阶段 b 第一步：组段引用 ref.md 时没读盘 ⇒ 引用没接上' }
        if (!text1 || text1.indexOf('引用文件内容') === -1) return { deviceError: '阶段 b 第一步：组段没拿到文件正文（实得 ' + JSON.stringify(text1) + '）⇒ 引用没接上' }
        withoutFilesAll()
        const d1 = READS.count
        renderGroup()
        const readEmpty = READS.count - d1
        // 盘上**同尺寸改内容 + 回写 mtime**（不能靠删文件：真身 `lib/global-prompt.js:129`
        // `fs.statSync(f)` 先于 `:147 cache.get(ck)` ⇒ 文件不在时 stat 先抛、走 `:155` catch，
        // 陈旧条目**永远端不出来** ⇒ 「删文件」根本分辨不出条目留没留，是空断言）。
        // 同尺寸 + 同 mtime ⇒ 缓存命中判据（:148）看不出变化：
        //   条目已剔  ⇒ 第三步只能真读盘 ⇒ 拿到新内容；
        //   条目仍在  ⇒ 缓存命中 ⇒ 端出**第一步的旧内容**（被剔与没被剔的判别量就在这里）。
        const target = original.g1 && original.g1[0]
        if (!target) return { deviceError: '阶段 b 需要 g1 的文件引用' }
        let changeFailed = ''
        let sizeMismatch = ''
        let oldMark = ''
        let newMark = ''
        let NEW_BODY_TEXT = ''
        let OLD_BODY_TAIL = ''
        let OLD_BODY_TEXT = ''
        try {
          const st0 = fs.statSync(target)
          const orig = fs.readFileSync(target, 'utf8')
          // ⚠️ 「同尺寸」必须按**实测**字节数凑：`ref.md` 的盘上内容与 `EXTRA` 的字面量并不等长
          //    （实测 stat=18 B，而 `'旧A\n引用文件内容'`=23 B ⇒ 我第一版判据直接卡在尺寸不符上，
          //     九份变异各多出一条「未点名判据被连带翻转」= 同一处装置错的回声）。
          //     （口径更正：此处当年实测的是**当时那七份**变异；自那以后 M8/M9 各补一次 C8 的
          //      独立对照 ⇒ 现在是九份 —— 上面的数字是历史叙述，不是现状。）
          //    这里用「行首标记字符 + 空格补齐」把两串都凑到实测长度；行首差异对 `indexOf` 可见，
          //    而空格落在行首标记之后、`indexOf` 也把它当字面量 ⇒ 肉眼可辨、比较可靠。
          const origin = orig.replace(/^\n+/, '')
          // ⚠️ 字节算术的死结：盘上原文 18 B 全是 3 字节汉字 ⇒ **任何** ASCII 标记都会把长度顶成 19/20 B
          //    （实测：'AA'+origin = 20 B、'A'+origin = 19 B），而缓存命中判据 `:148` 比的正是 (mtimeMs, size)
          //    ⇒ 长度一变就必然 miss，「条目留没留」又变成分辨不出（我第一次就是手算错 1 B、第二次用 ASCII 标记，两次都空）。
          //    唯一出路是**等宽替换**：把首字符换成另一个同宽全角字符（3 B → 3 B），总长不变、mtime 回写后 stat 逐字段相同。
          // ⚠️ 全角标记（3 B）在这里**必失配**：`'Ａ' + origin.slice(1)` = 3 + 15 = 18 B 对，但换一个全角标记后
          //    与原文尾部拼接仍是 18 B —— 真正的坑在别处：`fs.writeFileSync` 写的是「换掉首字符」的 18 B 串，
          //    而缓存命中判据 `:148` 比 (mtimeMs, size)，两侧都是 18 ⇒ 该路径本身是通的。
          //    这里退回**等长 ASCII 替换**（1 B + 原文 1..n 共 17 B = 18 B），比全角更稳、更容易肉眼核对。
          const MARKS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
          //   两种形态都要试：① 等长 ASCII 串整替换（1 B + 17 个 ASCII 字节）
          for (const c of MARKS) {
            const t = c.repeat(origin.length)
            if (t !== origin && Buffer.byteLength(t) === st0.size) { if (!oldMark) oldMark = t; else if (!newMark) newMark = t }
          }
          //   ② 汉字串首字符等宽替换（3 B 换 3 B，逐字节等长）
          if (!oldMark || !newMark) {
            for (const c of ['文', '本', '内', '容', '字', '号', '页', '书', '码', '节']) {
              const t = c + origin.slice(1)
              if (c !== origin[0] && Buffer.byteLength(t) === st0.size) { if (!oldMark) oldMark = t; else if (!newMark) newMark = t }
            }
          }
          if (!oldMark || !newMark) {
            sizeMismatch = '凑不出与 ' + st0.size + ' B 等长的两串标记（原内容 ' + JSON.stringify(orig) + '）'
          } else {
            // 旧正文 = 标记 + 原文首字之后的部分（第一步缓存里的就是它）；新正文 = 换标记后的同形串
            OLD_BODY_TAIL = origin.slice(1)   // 原文首字符之后的部分（等长替换时 = 与新串共有的后缀）
            OLD_BODY_TEXT = origin                        // 第一步缓存里端出来的正是这一整串（原样，未加任何标记）
            NEW_BODY_TEXT = newMark
            fs.writeFileSync(target, NEW_BODY_TEXT)
            fs.utimesSync(target, st0.atime, st0.mtime)
            // 装置自证：回写 mtime 必须逐位还原，否则 `:148` 的 (mtimeMs,size) 判定恒 miss、
            // 这条判据就退化成同义反复（实测：未对齐整毫秒时回写值从 …403.780029 变 …404.000000）。
            const stRestored = fs.statSync(target)
            if (Math.abs(stRestored.mtimeMs - st0.mtimeMs) > 1e-6) {
              changeFailed = '装置：回写 mtime 没还原（' + st0.mtimeMs.toFixed(6) + ' → ' + stRestored.mtimeMs.toFixed(6) + '）⇒ 缓存必 miss，判别力不成立'
            } else if (stRestored.size !== st0.size) {
              changeFailed = '装置：写盘后尺寸变了（' + st0.size + ' → ' + stRestored.size + '）'
            }
          }
        } catch (e) {
          changeFailed = String(e && e.message ? e.message : e)
        }
        const stAfter = (() => { try { return fs.statSync(target) } catch (e) { return null } })()
        withFiles()
        const d2 = READS.count
        const text3 = renderGroup()
        const readAfterReAdd = READS.count - d2
        if (process.env.GPDEBUG) console.error('[GPDEBUG-b3] OLD_BODY_TEXT=' + JSON.stringify(OLD_BODY_TEXT) + ' NEW_BODY_TEXT=' + JSON.stringify(NEW_BODY_TEXT) + ' 盘上=' + (() => { try { return JSON.stringify(fs.readFileSync(target, 'utf8')) } catch (e) { return 'ERR' } })() + ' st0.m=' + '?' + ' text3=' + JSON.stringify(text3))
        if (process.env.GPDEBUG) console.error('[GPDEBUG-b] text1=' + JSON.stringify(text1) + ' 目标文件=' + target + ' 改动失败=' + JSON.stringify(changeFailed) + ' 尺寸不符=' + JSON.stringify(sizeMismatch) + ' 盘上现有=' + JSON.stringify(stAfter && stAfter.size) + ' text3=' + JSON.stringify(text3) + ' 四步读数=' + JSON.stringify([readGroup, readEmpty, readAfterReAdd]))
        // ⚠️ 判定别拼后缀：`text1` 是**改盘前**的读数，取它的尾部会得到「原文」（实测 text1="G\n引用文件内容"
        //    ⇒ 拼出 'Ｂ' + '引用文件内容'，而盘上已是 'Ｂ用文件内容'，永远比不中 —— 又空一轮）。
        //    改用「标记位归一化」：把 text3 里出现过的标记换成 '?＃'，再与「?＃ + 正文」比。
        // 正文段直接取自第一步的实测读数（不能拿正则剥前缀：python heredoc 会把 `\n` 转义成字面两字符 `\` + `n`，
        //  `^G\n?` 就失配 ⇒ 期望值变成 '?＃引用文件内容'、永远比不中，实测如此）。
        // 左右必须**用同一把尺**：text1 的形状是 'G' + '\n' + 正文，期望串若不带 'G\n' 前缀就与 norm(text3) 差一个前缀。
        const gotNew = NEW_BODY_TEXT !== '' && typeof text3 === 'string' && text3 === ('G\n' + NEW_BODY_TEXT)
        const gotOld = OLD_BODY_TEXT !== '' && typeof text3 === 'string' && text3 === ('G\n' + OLD_BODY_TEXT)
        return {
          // 判据：摘掉引用（剔除发生处）后重新引用，**不得再端出第一步的旧内容**
          staleOldText: gotOld,
          gotNewText: gotNew,
          oldMark,
          newMark,
          changeFailed,
          sizeMismatch,
          text1,
          textAfterReAdd: text3,
          readGroup,
          readEmpty,
          readAfterReAdd,
          readsAfterStable: readAfterReAdd,
          readsAfterChange: readAfterReAdd,
          _fpath: fpath,
        }
      }
      // 第一步：组段先渲染 → 条目进 'group:g1' 命名空间，并返回是否真的读到了那个文件
      const r0 = READS.count
      renderGroup()
      const groupReadOnce = READS.count > r0
      if (!groupReadOnce) return { deviceError: '组段首轮根本没读盘（引用文件没接上或路径不对）' }
      // 第二步：默认两段渲染（这一段就是可能发生「越界剔除」的地方）
      // 这里的读盘次数**就是**判别量：默认段引用了同一路径且组条目被它剔掉 ⇒ 默认段那次
      // 读盘之外还会多读（组条目没了）／少读（默认段自己也被牵连）——M8 下实测为 1（基线 2）。
      const dStep2 = READS.count
      renderDefault()
      const readsDefaultStep2 = READS.count - dStep2
      // 第三步：改盘上内容 ⇒ 组段再渲染。条目还在（缓存命中但 mtime/size 变了）⇒ 重读 1 次；
      // 条目被默认段剔掉 ⇒ cache.get 未命中 ⇒ 同样重读 1 次。所以这一步**不能区分**两者，
      // 真正能区分的是下面第四步（内容不变时的读盘次数）。
      fs.writeFileSync(fpath, '组A正文 CHANGED')
      const b1 = READS.count
      renderGroup()
      const afterChange = READS.count - b1
      // 第四步：内容不再变，再渲染一次。条目还在 ⇒ 命中 ⇒ 0 次；条目已被剔掉 ⇒ 必然重读 ⇒ 1 次。
      const b2 = READS.count
      renderGroup()
      const afterStable = READS.count - b2
      return {
        // 条目「活着」的判据 = 内容不变的第二轮不再读盘
        entryAlive: afterStable === 0,
        readsDefaultStep2,
        readsAfterChange: afterChange,
        readsAfterStable: afterStable,
        readsDelta: afterStable,
        _fpath: fpath,
      }
    }

    // 普通场景：渲染 group 段（单轮 = 真调 text() 拿观测值；双轮 = 三段落交叉读盘计数）
    const rounds = opts.rounds || 1
    let groupText = ''
    if (rounds < 2) {
      // 这一句是 C1–C4 唯一的观测点。曾经这里漏掉了它（groupText 恒 ''），
      // 于是连续多轮把「装置没观测」误读成「实现没注入」—— 空读数先证明观测点真的执行过。
      if (typeof gsec.text !== 'function') return { deviceError: 'group 段没有 text()' }
      groupText = gsec.text({ agent: opts.agent })
    } else {
      // 三段同引一个文件：每轮把三段都渲染一遍，然后看下一轮新增读盘
      const renderAll = () => {
        for (const s of findByPath(ctx.sections, 'global-prompt')) if (s.text) s.text({ agent: opts.agent })
        for (const s of findByPath(ctx.sections, 'workspace-prompt')) if (s.text) s.text({ agent: opts.agent })
        for (const s of groupSecs) s.text({ agent: opts.agent })
      }
      READS.count = 0
      renderAll()
      const r1 = READS.count
      renderAll()
      const r2 = READS.count - r1
      // 改盘上内容 ⇒ 必须重读（证明计数装置是真的在观测读盘，不是恒 0）
      const firstFile = filePaths['ref.md']
      const beforeChange = READS.count
      if (firstFile) fs.writeFileSync(firstFile, EXTRA + ' CHANGED')
      renderAll()
      return { readsPerRound: [r1, r2], readsAfterChange: READS.count - beforeChange, filePath: firstFile, _ctx: ctx }
    }
    return { groupText, groupInterpolate: gsec.interpolate, filePath: filePaths['ref.md'], _ctx: ctx, _diag: { groupsKeyCount: Object.keys(groups).length, agentId: opts.agent && opts.agent.session && opts.agent.session.header ? opts.agent.session.header.id : null, gsecIndex: ctx.sections.findIndex((s) => s === gsec), globalEnabledRaw: opts.global ? opts.global.enabled : undefined } }
  } finally {
    // `LIVE_DIRS` = 本函数执行期间 `loadDedup` 落下的副本目录（模块级台账，见其定义处）；
    // 与 `dirs` 一起删，保证「副本一律落 os.tmpdir() 且每次运行都收尾」这句话成立。
    for (const d of LIVE_DIRS) dirs.push(d)
    LIVE_DIRS.clear()
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (e) { /* 略 */ } }
  }
}

// ── 装置诊断（--probe）：打印每条判据的原始观测值，便于「零命中先怀疑探针」时定位 ──
const PROBE_LOG = []
function probeDump(tag, v) {
  try { PROBE_LOG.push('    ' + tag + ' → ' + JSON.stringify(v)) }
  catch (e) { PROBE_LOG.push('    ' + tag + ' → (JSON 失败) ' + String(v)) }
}

// ── 场景包装（把断言用的 opts 补全成 runOnce 的签名）──────────────────────────
function makeRunner(sourceText, dedupText) {
  return async (opts) => {
    const o = Object.assign({}, opts)
    // 一律提供 ref.md 这个临时文件：断言可以两种写法引用它 —— 字面名 'ref.md'（由 runOnce 映射成
    // 临时绝对路径）或 r.filePath（断言直接拿到映射后的路径）。缺映射 ⇒ files 里的路径不存在 ⇒
    // readPromptFiles 读到空体，而那会被我误读成「块内拼接没实现」。
    if (!o.files) o.files = { 'ref.md': EXTRA }
    const r = await runOnce(sourceText, dedupText, o)
    if (probe) {
      const brief = {}
      for (const k of Object.keys(r || {})) {
        if (k === '_ctx') continue
        brief[k] = k === '_byName' ? r[k] : r[k]
      }
      probeDump('runOnce 入参', { 判据用到的字段: Object.keys(o).filter((k) => k !== 'agent'), 组的键: Object.keys(o.groups || {}), 文件映射: o.files })
      probeDump('runOnce 返回', brief)
    }
    return r
  }
}

// ── 变异登记（锚点必须恰好命中 1 次；每条只点名一条断言）──────────────────────
const MUTATIONS = [
  {
    id: 'M1', crit: 'C1', label: 'enabled 判定拿掉（恒视为启用）',
    // 注意：`if (!rec || rec.enabled !== true) continue` 在生产文件里出现 **2 次**
    // （lib/global-prompt.js:332 工作区段、:371 组段），逐字相同 ⇒ 锚点必须带上一行的
    // 组循环头，否则命中 2 次、对照无效（本门因此曾报「M1 锚点命中 2 次」）。
    find: "      for (const groupKey of Object.keys(groups)) {\n        const rec = groups[groupKey]\n        if (!rec || rec.enabled !== true) continue",
    repl: "      for (const groupKey of Object.keys(groups)) {\n        const rec = groups[groupKey]\n        if (!rec) continue",
  },
  {
    id: 'M2', crit: 'C2', label: '成员判定拿掉（恒视为命中）',
    find: '        if (members.indexOf(sessionId) === -1) continue',
    repl: '        if (false) continue',
  },
  {
    id: 'M3', crit: 'C3', label: '块间分隔退回单 \\n',
    find: "      return blocks.join('\\n\\n')",
    repl: "      return blocks.join('\\n')",
  },
  {
    id: 'M4', crit: 'C4', label: '组段改成 interpolate: true',
    find: "    name: 'group-prompt',\n    order: groupSectionOrder,\n    interpolate: false,",
    repl: "    name: 'group-prompt',\n    order: groupSectionOrder,\n    interpolate: true,",
  },
  {
    id: 'M5', crit: 'C5', label: 'title 不兜错（把任意值直接当标题端出去）',
    // ⚠️ 两版废弃写法都**打不到 C5 的观测点**（实测「没报红 ⇒ 这条断言是空的」）：
    //    ① 只改 try 内部（`if (snap && typeof snap.title === 'string') title = snap.title` →
    //       `title = snap.title`）：C5 当时的四个场景里服务要么缺席、要么抛错、要么返回正常串标题，
    //       没有「服务返回非串」的场景 ⇒ 变异在四个场景下读数逐项与基线相同。
    //    ② 去掉 `canReadTitle` 的 `typeof … === 'function'` 守卫：缺席时 `canReadTitle` 求值本来就是
    //       false（`titleSvc !== undefined` 先短路的右侧），走不到 `titleSvc.get()` ⇒ 同样不可观测。
    //    因此本条变异配套在 C5 里**新增**「get 不可调用 + 非串 title」的服务形状场景：
    //    守卫若被拿掉，那个 shape 会走进 `titleSvc.get(session)` ⇒ TypeError 逃出 try/catch ⇒ 路由坏。
    find: '        if (snap && typeof snap.title === \'string\') title = snap.title',
    repl: '        if (snap) title = snap.title',
  },
  {
    id: 'M6', crit: 'C6', label: '默认命名空间剔除越界（own 恒 true）',
    find: "    const own = pre === '' ? key.indexOf('\\u0000') === -1 : key.startsWith(full)",
    repl: "    const own = pre === '' ? true : key.startsWith(full)",
  },
  {
    id: 'M7', crit: 'C7', label: "TARGET_NAMES 去掉 'group-prompt'",
    find: "const TARGET_NAMES = ['session-identity', 'global-prompt', 'group-prompt', 'workspace-prompt']",
    repl: "const TARGET_NAMES = ['session-identity', 'global-prompt', 'workspace-prompt']",
    target: 'dedup',
  },
]
// C8 复用 M6（同一处越界剔除的另一个观测面）——但「每条断言各配一次负向对照」要求
// C8 也有一次独立对照：这里给它一个**只改 C8 那条路**的变异（把组段前缀换成默认命名空间）。
MUTATIONS.push({
  id: 'M8', crit: 'C8', label: "组段改用默认命名空间（丢掉 'group:' 前缀）",
  find: "        const { body, statuses } = readPromptFiles(files, limits, fileCache, 'group:' + groupKey)",
  repl: '        const { body, statuses } = readPromptFiles(files, limits, fileCache)',
})
// C8 的 8b 是**另一个方向**的负向对照（组段不再引用 ⇒ 必须被剔），M8 打不到它：
// M8 只是让键与默认段同形，条目仍会被剔除循环删掉（剔除判据 own 覆盖裸键）。
// 8b 的独立对照 = 「组段干脆不剔除任何键」⇒ 8a 仍会过、只有 8b 能翻。
MUTATIONS.push({
  id: 'M9', crit: 'C8', label: '组段永不剔除（摘掉引用后条目仍活着）',
  find: "    if (wanted.indexOf(key.slice(full.length)) === -1) cache.delete(key)",
  repl: "    if (pre === '' && wanted.indexOf(key.slice(full.length)) === -1) cache.delete(key)",
})

function mutate(src, m) {
  const hits = src.split(m.find).length - 1
  if (hits !== 1) return { error: m.id + ' 锚点命中 ' + hits + ' 次（必须恰好 1 次）⇒ 对照无效', text: null }
  const text = src.replace(m.find, m.repl)
  if (text === src) return { error: m.id + ' 替换后与源逐字节相同 ⇒ 对照无效', text: null }
  return { error: null, text }
}

// ── 预检（裁定 #64 第 1 条，机械口径）─────────────────────────────────────────
// 「整门级测不了」与「某条判据不成立」必须有一个**客观分界**，否则 2 与 1 全凭叙述：
//   这里在跑任何判据之前，先按被测对象真实存在的形态加载一次（`import()` 走模块解析 + 编译 + 求值）。
//   失败（语法错 / 文件被删 / 导入即抛）⇒ 一条判据都没被评估过 ⇒ 整门走 2，且**只**打印「未能评测」。
//   成功 ⇒ 后面任何失败都是判据级 ⇒ 仍走 1。
//   ⚠️ 候选写法「`import('data:text/javascript;base64,…')`」**实测不可用，已废弃**：data: 是非层级
//      scheme，`./request-guard.js` 这类相对导入会直接抛
//      `Failed to resolve module specifier "./request-guard.js" from "data:…": Invalid relative URL or
//       base scheme is not hierarchical.` ⇒ **合法源码也会被判成「未能评测」**（假 2）。
//   ⇒ 固定做法：把源码落进独立的 os.tmpdir() 目录（相对导入落到该目录的桩上，与真身同形），
//      用**单调递增 query** 的 file:// URL 导入（沿用 `freshUrl`：同 URL 会命中 ESM 缓存拿到旧实例）。
async function precheck(globalText, dedupText) {
  const mods = [
    { text: globalText, rel: TARGET_REL },
    { text: dedupText, rel: DEDUP_REL },
  ]
  const dirs = []
  try {
    for (const m of mods) {
      let url
      if (m.text === null) {
        url = freshUrl(path.join(ROOT, m.rel))
      } else {
        const dir = sandbox()
        dirs.push(dir)
        const f = path.join(dir, path.basename(m.rel))
        fs.writeFileSync(f, m.text)
        url = freshUrl(f)
      }
      try {
        await import(url)
      } catch (e) {
        const raw = (e && e.message) ? e.message : String(e)
        // 原始错误可能是多行（带栈片段）⇒ 收敛成一行，便于摘要在任何终端里可读
        const one = raw.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 2).join(' | ')
        return '未能评测：' + m.rel + ' 解析失败（' + one + '）'
      }
    }
    return null
  } finally {
    // ⚠️ 预检自己要收尾：它落的是**新造的**副本目录（不在 `runOnce` 的 `dirs` 台账里）。
    //    早先版本漏了这一步 ⇒ 预检每跑一次就多留一个空目录（实测盘上曾积到 403 个 d-gpguard-*）。
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (e) { /* 略 */ } }
  }
}

// 判据级三态（裁定 #64 第 2 条）：通过 / **不成立** / **未能确证**。
// `deviceError` 与「装置抛异常」一律进 `unverified`，**不得**混进 `failures` 计数。
// 结构（不是注释）：`judge()` 两个 return 点的 `unverified.length` 单独返回，调用方无论走哪条出口
// 都先把 `unverified` 算进红（fail-closed）——「测不了」永不可能读成 PASS。
function devName(c) {
  return c.title ? c.id + '（装置：' + c.title + '）' : c.id
}

async function judge(sourceText, dedupText, label) {
  const pre = await precheck(sourceText, dedupText)
  if (pre) return {
    device: true, notice: pre, failures: [], unverified: [], named: [],
    // 摘要口径（裁定 #64 第 2 条）：预检没过 ⇒ 该次运行的**全部**判据都「未能确证」，
    // 且点名必须来自判据表本身（不得用「装置抛异常」这种内部标签冒充判据名）。
    unverifiedItems: CRITERIA.map(devName),
  }
  const failures = []
  const unverified = []
  const named = []
  const run = makeRunner(sourceText, dedupText)
  for (const c of CRITERIA) {
    let r
    PROBE_LOG.length = 0
    try {
      r = await c.fn(run)
    } catch (e) {
      unverified.push(c.id + '：装置抛异常 —— ' + (e && e.message ? e.message : String(e)))
      named.push(devName(c))
      if (probe) { console.log('  ' + c.id + ' 装置抛异常：' + (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : String(e))) }
      continue
    }
    if (probe) {
      console.log('  ── ' + c.id + '（' + label + '）' + c.title)
      for (const ln of PROBE_LOG) console.log(ln)
      probeDump('判据返回', Array.isArray(r) ? r : (r && r.notes ? { notes: r.notes } : r))
      console.log(PROBE_LOG[PROBE_LOG.length - 1] || '')
    } else if (r && r.deviceError) {
      unverified.push(c.id + '：装置没跑成 —— ' + r.deviceError)
      named.push(devName(c))
      continue
    }
    if (Array.isArray(r)) for (const f of r) failures.push(c.id + '：' + f)
    else if (r && Array.isArray(r.notes)) { /* 通过，备注不打印（保持输出简洁） */ }
  }
  return { device: false, notice: null, failures, unverified, named, unverifiedItems: named }
}

// 摘要口径（裁定 #64 第 2 条）：两个计数**必须分开**且都写在摘要行里。
// `named` 非空时逐条点名（如 `C1（装置：…）`）；为空则只给条数 —— 不给「未能确证 3 条」配三个假名字。
function threeState(nFail, named, extraRaw) {
  let s = '判据不成立 ' + nFail + ' 条 · 未能确证 ' + named.length + ' 条'
  if (named.length) s += '（' + named.join(' / ') + '）'
  if (extraRaw) s += ' · ' + extraRaw
  return s
}
const globalSrc = fs.readFileSync(path.join(ROOT, TARGET_REL), 'utf8')
const dedupSrc = fs.readFileSync(path.join(ROOT, DEDUP_REL), 'utf8')
const sha16 = (s) => {
  const h = spawnSync('/usr/bin/shasum', ['-a', '256'], { input: s, encoding: 'utf8' })
  const out = (h.stdout || '').trim().split(/\s+/)[0] || ''
  return out.slice(0, 16).toUpperCase()
}
console.log('「组提示词」契约门（group-prompt.contract.assert.mjs）')
console.log('  仓库 ' + ROOT)
console.log('  被测文件 ' + TARGET_REL + ' · sha ' + sha16(globalSrc) + '…  ' + Buffer.byteLength(globalSrc) + ' B / ' + globalSrc.split('\n').length + ' 行')
console.log('  被测文件 ' + DEDUP_REL + ' · sha ' + sha16(dedupSrc) + '…  ' + Buffer.byteLength(dedupSrc) + ' B / ' + dedupSrc.split('\n').length + ' 行')
console.log('  判据条数 ' + CRITERIA.length + ' · 变异条数 ' + MUTATIONS.length + '（每条断言各配一次负向对照）')
console.log('')
console.log('── 八条判据（加载真身跑；--selftest 时为基线）──')
const base = await judge(null, null, 'base')
const baseFailures = base.failures
const baseUnverified = base.unverified
const baseUnproven = baseUnverified.length > 0
const baseNotice = base.device ? base.notice : null
for (const f of baseFailures) console.log('  FAIL  ' + f)
for (const u of baseUnverified) console.log('  FAIL  ' + u)
const baseOk = baseFailures.length === 0 && !baseUnproven && !baseNotice
const baseTail = baseNotice
  ? baseNotice
  : (baseOk
    ? CRITERIA.length + ' 条判据全绿'
    : threeState(baseFailures.length, base.named, null))
// 裁定 #64 第 1 条还管**措辞**：预检没过时，这一行也**不得**出现 `FAIL` 标记 ——
// 一条判据都没被评估过，任何 `FAIL` 前缀都会被读成「判据级结论」。用 `未能评测` 作独立标记。
console.log('  ' + (baseNotice ? '未能评测' : (baseOk ? 'PASS' : 'FAIL')) + '  基线（' + TARGET_REL + ' + ' + DEDUP_REL + '）：' + baseTail)

if (!selftest) {
  console.log('')
  // 裁定 #64 第 1 条：预检没过 ⇒ 一条判据都没被评估过 ⇒ 只报「未能评测」，不报任何判据级结论。
  if (baseNotice) {
    console.error(baseNotice)
    console.error('本门未能评测：被判对象在评测前就不可加载/解析 ⇒ 非「判据不成立」，也不是通过。')
    process.exit(EXIT.DEVICE)
  }
  if (baseOk) {
    console.log('本门成立：组段按 id 命中/启用门控、键序拼接块间空行、字面保真、路由 sessions 形状健壮、三段缓存互不误剔、去重范围含组段。')
    process.exit(EXIT.PASS)
  }
  console.error('本门报红：' + threeState(baseFailures.length, base.named, null) + '（见上）')
  process.exit(EXIT.FAIL)
}

// ── 自证：基线 + 九份变异 ───────────────────────────────────────────────────
console.log('')
console.log('── 自证（--selftest）：基线 + 九份变异，副本在 os.tmpdir() ──')
let deviceFailures = 0        // 对照无效 / 连带翻转（内容异常）
let unconfirmedMutations = 0  // 该次变异下有判据「未能确证」（装置抛异常 / 局部装置没跑成）
let falsified = 0
for (const m of MUTATIONS) {
  const isDedup = m.target === 'dedup'
  const src = isDedup ? dedupSrc : globalSrc
  const r = mutate(src, m)
  if (r.error) {
    console.log('  ' + m.id + '  ' + m.label + ' ⇒ 对照无效：' + r.error)
    deviceFailures += 1
    continue
  }
  const res = isDedup
    ? await judge(globalSrc, r.text, m.id)
    : await judge(r.text, dedupSrc, m.id)
  const failures = res.failures
  const extra = failures.filter((f) => !f.startsWith(m.crit + '：'))
  // 裁定 #64 第 2 条的结构（不是注释）：**同一次运行**里出现「未能确证」⇒ 该变异一律红，
  // 不得因为「点名判据碰巧也红了」就把它读成合格对照（`hit` 与「测不了」是两件事）。
  const hit = failures.some((f) => f.startsWith(m.crit + '：')) && res.unverified.length === 0
  console.log('  ' + m.id + '  ' + m.label)
  console.log('     字节 ' + Buffer.byteLength(src) + ' B → ' + Buffer.byteLength(r.text) + ' B（源码已不同 ✓）')
  console.log('     点名判据 ' + m.crit + ' ⇒ ' + (hit ? '报红（符合预期）' : '**报红无效 ⇒ 这条断言这次不算数**'))
  if (res.unverified.length) {
    console.log('     FAIL  ' + threeState(0, res.unverifiedItems, null) + '（该次运行有判据测不了 ⇒ 这条对照不能算数）')
  }
  if (!hit) {
    // 定位「空断言」必需：打印该判据在变异下的实际返回（含 notes），否则只能靠猜。
    const c = CRITERIA.find((x) => x.id === m.crit)
    let rr = null
    try { rr = await c.fn(makeRunner(isDedup ? globalSrc : r.text, isDedup ? r.text : dedupSrc)) } catch (e) { rr = { 抛错: String(e && e.message ? e.message : e) } }
    console.log('     该判据在变异下的实际返回：' + JSON.stringify(rr))
  }
  if (extra.length) {
    console.log('     ⚠️ 未点名判据被连带翻转 ' + extra.length + ' 条（有因果则须显式登记进 flips，说不清=故障）：')
    for (const e of extra) console.log('        ' + e)
  } else {
    console.log('     未点名判据 0 条被连带翻转 ✓')
  }
  if (!hit) falsified += 1
  if (extra.length) deviceFailures += 1
  if (res.unverified.length) unconfirmedMutations += 1
}

console.log('')
console.log('── 自证汇总 ──')
console.log('  基线：' + (baseOk ? '绿（符合预期）' : '红 —— **基线必须绿**'))
console.log('  变异：' + MUTATIONS.length + ' 份 · ' + threeState(falsified, [], '对照无效/连带翻转 ' + deviceFailures + ' · 未能确证的变异 ' + unconfirmedMutations + ' 份'))
if (baseOk && falsified === 0 && deviceFailures === 0 && unconfirmedMutations === 0) {
  console.log('本门成立：真实文件八条判据全绿，且九份变异各自翻掉它点名的那条、不连带翻转别的。')
  console.log('（临时副本已删；工作区零写入）')
  process.exit(EXIT.PASS)
}
console.error('本门自证失败：基线红 / 有断言空 / 有对照无效 —— 见上。')
process.exit(EXIT.FAIL)
