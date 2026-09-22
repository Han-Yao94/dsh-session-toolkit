#!/usr/bin/env node
/**
 * 提示词管线契约门（run: node scripts/prompt.contract.selftest.mjs）
 *
 * 固定三件事，它们此前都只能靠人工读代码发现：
 *   A. 跨段行级去重**不得吃掉空行**——空行是 markdown 的段落/列表分隔，一旦被
 *      「先出现者优先」的 seen 集合吃掉，第一段之后的每一段空行都会被删，提示词结构静默变形。
 *   B. 三段自有提示词按字面渲染：0.1.6+ 用 interpolate: false（文本一个字符不改）；
 *      旧内核（无该字段）才退化为 sanitize 的空格化兜底——两种内核下都不得让 `{{...}}`
 *      变成未注册变量引用而抛错。
 *   C. global-prompt 的引用文件读取与状态投影：超大文件不注入只报 fail；文件未变时
 *      **不重建状态投影**（状态每个模型步都重算，值没变就不该换引用/内容）。
 *      用户数据（启用开关 + 文本 + 引用文件）是本条目 config 的 volatile 字段，
 *      运行时投影（引用文件状态、活跃工作区）经 GET /api/session-toolkit/state 送给浏览器半。
 *
 * 每条断言都必须能报红：脚本在 os.tmpdir() 的副本上还原历史缺陷（去重吃空行、按字面渲染缺失），
 * 对应断言必须变为失败。副本与临时文件都不落工作区。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXIT = { PASS: 0, FAIL: 1 }

const failures = []
const total = { count: 0 }

function check(id, ok, detail) {
  total.count += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${id}${ok || !detail ? '' : '  ← ' + detail}`)
  if (!ok) failures.push(`${id}: ${detail}`)
}

// ------------------------------------------------------------------ 最小 waterfall 运行器
function makeCtx() {
  const listeners = []
  const ctx = {
    on(event, fn) { if (event === 'system-prompt/assemble') listeners.push(fn) },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    timeout() { return () => {} },
    interval() { return () => {} },
    get() { return undefined },
  }
  async function run(assembly) {
    let i = 0
    const next = async () => {
      if (i >= listeners.length) return assembly
      const fn = listeners[i++]
      return fn(assembly, {}, next)
    }
    return next()
  }
  return { ctx, run }
}

function section(name, text, extra) {
  return Object.assign({ name, text }, extra || {})
}

function textOf(assembly, name) {
  const found = assembly.sections.find((s) => s.name === name)
  return found === undefined ? undefined : found.text
}

// 带 `{{...}}` 的文本：新内核必须一字不改，旧内核必须被空格化——没有花括号的话，
// 「按字面渲染」这条断言就是空断言（负向对照会把它抓出来）。
const IDENTITY_LINE = 'You are a BA.\n\nKeep {{braces}} literal.'
const GLOBAL_LINES = 'Rules:\n\n- always X\n\n- never Y'

// ------------------------------------------------------------------ A/B：去重 + 按字面渲染
async function promptChecks(libDir) {
  const dedup = await import(pathToFileURL(path.join(libDir, 'prompt-dedup.js')).href)
  const literal = await import(pathToFileURL(path.join(libDir, 'prompt-literal.js')).href)
  const { ctx, run } = makeCtx()
  dedup.apply(ctx, { enabled: true })
  literal.apply(ctx, {})

  const modern = await run({ sections: [
    section('session-identity', IDENTITY_LINE, { interpolate: false }),
    section('global-prompt', GLOBAL_LINES, { interpolate: false }),
    section('harness:identity', 'You are an AI agent.'),
  ] })
  const modernGlobal = textOf(modern, 'global-prompt')

  const deduped = await run({ sections: [
    section('session-identity', 'Be concise.\n\nOwn line A.', { interpolate: false }),
    section('global-prompt', 'Be concise.\n\nOwn line B.', { interpolate: false }),
  ] })
  const dedupedGlobal = textOf(deduped, 'global-prompt')

  // 旧内核形态：assemble 不保留 interpolate 字段（这里用不带该字段的段落模拟）
  const legacy = await run({ sections: [section('global-prompt', 'Use {{name}} literally.\n\n{{a}}{{b}}')] })
  const legacyText = textOf(legacy, 'global-prompt')

  return {
    blankPreserved: modernGlobal === GLOBAL_LINES,
    duplicateRemoved: dedupedGlobal === '\nOwn line B.',
    harnessUntouched: textOf(modern, 'harness:identity') === 'You are an AI agent.',
    literalKept: textOf(modern, 'session-identity') === IDENTITY_LINE,
    legacyEscaped: typeof legacyText === 'string' && !/\{\{/.test(legacyText),
  }
}

function copyLib(id) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-st-prompt-' + id + '-'))
  cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true })
  provideSchemastery(path.join(dir, 'node_modules'))
  return dir
}

/**
 * 为临时根准备 `@deepseek-ai/schemastery`：能链到工作区真实包就链（本地开发），
 * 链不到就放一个最小 schema 桩（CI 不装依赖）。被测断言与 schema 构造无关，
 * 但 `lib/global-prompt.js` 顶层 import 它——缺它会让门直接 ERR_MODULE_NOT_FOUND。
 * @param {string} nodeModulesDir 临时根的 node_modules 目录
 * @returns {'linked'|'stub'}
 */
function provideSchemastery(nodeModulesDir) {
  const real = path.join(ROOT, 'node_modules')
  if (existsSync(path.join(real, '@deepseek-ai', 'schemastery'))) {
    try {
      symlinkSync(real, nodeModulesDir, process.platform === 'win32' ? 'junction' : 'dir')
      if (existsSync(path.join(nodeModulesDir, '@deepseek-ai', 'schemastery'))) return 'linked'
    } catch { /* 落回桩 */ }
  }
  const stubDir = path.join(nodeModulesDir, '@deepseek-ai', 'schemastery')
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
}

const mainRoot = copyLib('main')
const main = await promptChecks(path.join(mainRoot, 'lib'))
check('去重保留空行（跨段不再吃掉段落分隔）', main.blankPreserved)
check('去重仍删除真正的重复行', main.duplicateRemoved)
check('去重不动 harness 自有段', main.harnessUntouched)
check('新内核按字面渲染（interpolate:false 不改写文本）', main.literalKept)
check('旧内核兜底：{{...}} 被空格化，不再触发未注册变量', main.legacyEscaped)

// 负向对照 1：还原「不去重空行」的历史缺陷
const negDedupDir = copyLib('neg-dedup')
const negDedupFile = path.join(negDedupDir, 'lib/prompt-dedup.js')
const negDedupSrc = readFileSync(negDedupFile, 'utf8')
const negDedupMutated = negDedupSrc.replace('if (/^\\s*$/.test(line)) { kept.push(line); continue }', '')
if (negDedupMutated === negDedupSrc) throw new Error('负向对照变异未命中：prompt-dedup.js 空行保护行')
writeFileSync(negDedupFile, negDedupMutated)
const negDedup = await promptChecks(path.join(negDedupDir, 'lib'))
check('负向对照：去掉空行保护后，空行断言报红', negDedup.blankPreserved === false)

// 负向对照 2：去掉按字面渲染判断
const negLiteralDir = copyLib('neg-literal')
const negLiteralFile = path.join(negLiteralDir, 'lib/prompt-literal.js')
const negLiteralSrc = readFileSync(negLiteralFile, 'utf8')
const negLiteralMutated = negLiteralSrc.replace('if (sec.interpolate === false) continue', '')
if (negLiteralMutated === negLiteralSrc) throw new Error('负向对照变异未命中：prompt-literal.js 早退行')
writeFileSync(negLiteralFile, negLiteralMutated)
const negLiteral = await promptChecks(path.join(negLiteralDir, 'lib'))
check('负向对照：去掉按字面渲染判断后，文本保真断言报红', negLiteral.literalKept === false)

// ------------------------------------------------------------------ C：引用文件读取 + 写入抑制
/** 最小 volatile 引用桩：被测代码只调 .get()（写入方是 settings 表单，不在本门内）。 */
function volatileRef(value) {
  const ref = { get() { return ref.value }, set(next) { ref.value = next } }
  ref.value = value
  return ref
}

function makeGlobalPromptCtx() {
  const refs = {
    enabled: volatileRef(false),
    content: volatileRef(''),
    files: volatileRef([]),
    workspaces: volatileRef({}),
    removed: volatileRef([]),
  }
  const sections = []
  const routes = []
  const workspaceWrites = []
  // ⚠️ 假 webServer **必须带 `host`**：守卫的签名是 `originGuard(req, res, webServer.host)`，
  //    真实宿主（`packages/host/webserver`）一定有这个 getter。假对象若没有它，
  //    被测代码就会按"没有绑定信息"的形态跑 ⇒ 测的不是真实部署。（缺省时守卫按 loopback fail-closed，
  //    那是安全侧默认，但**不等于**真实宿主的行为。）
  const webServer = {
    host: '127.0.0.1',
    register(spec) {
      routes.push(spec)
      return () => {}
    },
  }
  const childCtx = {
    get(name) { return name === 'webServer' ? webServer : undefined },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  const ctx = {
    // 本插件不再注册 settings 命名空间：用户数据是本条目 config 的 volatile 字段；
    // 「活跃工作区同步补回缺失路径」经 ctx.get('settings').update(条目 id, patch) 写回 config。
    get(name) {
      if (name !== 'settings') return undefined
      return { update(ns, patch) { workspaceWrites.push({ ns, patch }); return Promise.resolve() } }
    },
    systemPrompt: { section(s) { sections.push(s); return () => {} } },
    agents: { roots() { return [] } },
    inject(names, cb) { if (names.indexOf('webServer') !== -1) cb(childCtx); return () => {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on() {},
    timeout() { return () => {} },
  }
  return { ctx, refs, sections, routes, workspaceWrites }
}

/** 调一次只读状态路由，取回它写给浏览器的 JSON 文本（字面比较，避免把解析结果当同一对象）。 */
function readStateText(routes) {
  const route = routes.find((r) => r.path === '/api/session-toolkit/state')
  if (route === undefined) throw new Error('状态路由 /api/session-toolkit/state 未注册')
  let body
  const res = {
    writeHead() { return res },
    end(text) { body = text },
  }
  // ⚠️ 假请求**必须像真请求一样带 Host**（Origin 守卫上线后，Host 是判定来源的一部分）：
  //    `lib/request-guard.js` 的栅栏 A 在绑定为 loopback 时要求 Host 是 loopback 字面量，
  //    且缺 Host 一律 403（fail-closed，合法 HTTP/1.1 必须带 Host）。
  //    这里照**真实同源 GET** 的形状：只带 Host，不带 Origin（浏览器对同源 GET 通常不发 Origin）。
  //    真实世界里 `route.handler` 只会被 HTTP 服务器调用，`req.headers` 必然是对象 ⇒ 这不是在迁就实现，
  //    而是让假请求不再模拟一个**不可能发出的**请求。
  route.handler({ method: 'GET', headers: { host: '127.0.0.1:3080' } }, res)
  return body
}

async function globalPromptChecks() {
  const root = copyLib('global-prompt')
  const mod = await import(pathToFileURL(path.join(root, 'lib/global-prompt.js')).href)
  const { ctx, refs, sections, routes } = makeGlobalPromptCtx()
  mod.apply(ctx, {
    global: { maxFileBytes: 64, maxTotalBytes: 128, enabled: refs.enabled, content: refs.content, files: refs.files },
    workspace: { workspaces: refs.workspaces, removed: refs.removed },
  })

  const globalSection = sections.find((s) => s.name === 'global-prompt')
  if (globalSection === undefined) throw new Error('global-prompt 段未注册')

  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-st-prompt-files-'))
  const small = path.join(dir, 'small.txt')
  const big = path.join(dir, 'big.txt')
  writeFileSync(small, 'hello {{braces}}')
  writeFileSync(big, 'x'.repeat(200))

  refs.enabled.set(true)
  refs.content.set('Base')
  refs.files.set([small])
  const first = globalSection.text({})
  const stateAfterFirst = readStateText(routes)
  globalSection.text({})
  const stateAfterSecond = readStateText(routes)

  // 内容变化（size/mtime 变化）后必须重读并重新投影
  writeFileSync(small, 'hello {{braces}} v2')
  const future = new Date(Date.now() + 2000)
  utimesSync(small, future, future)
  const third = globalSection.text({})
  const stateAfterThird = readStateText(routes)

  refs.files.set([big])
  const fourth = globalSection.text({})
  const lastStatus = JSON.parse(readStateText(routes)).fileStatus.byScope.global[0]

  rmSync(dir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
  return {
    literal: globalSection.interpolate === false,
    noSanitize: first === 'Base\nhello {{braces}}',
    projectionStable: stateAfterSecond === stateAfterFirst,
    refreshed: stateAfterThird !== stateAfterSecond && third.indexOf('v2') !== -1,
    oversized: fourth === 'Base' && lastStatus !== undefined && lastStatus.status === 'fail',
  }
}

const gp = await globalPromptChecks()
check('global-prompt 段声明 interpolate:false', gp.literal)
check('引用文件内容按原文注入（不再空格化花括号）', gp.noSanitize)
check('文件未变时状态投影不重建（同一份 JSON）', gp.projectionStable)
check('文件变化后重读并重新投影', gp.refreshed)
check('超大文件判 fail 且不注入', gp.oversized)

rmSync(negDedupDir, { recursive: true, force: true })
rmSync(negLiteralDir, { recursive: true, force: true })
rmSync(mainRoot, { recursive: true, force: true })

console.log('')
console.log(`共 ${total.count} 条：通过 ${total.count - failures.length}，失败 ${failures.length}`)
if (failures.length > 0) {
  console.error('提示词管线契约不成立：')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(EXIT.FAIL)
}
console.log('全部断言成立（含 2 条负向对照：还原历史缺陷后对应断言确实报红）。')
process.exit(EXIT.PASS)
