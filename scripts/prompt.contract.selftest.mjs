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
 *      **不重复写 settings**（settings.update 会持久化整份 settings.yaml）。
 *
 * 每条断言都必须能报红：脚本在 os.tmpdir() 的副本上还原历史缺陷（去重吃空行、按字面渲染缺失），
 * 对应断言必须变为失败。副本与临时文件都不落工作区。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
  return dir
}

const main = await promptChecks(path.join(ROOT, 'lib'))
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
function makeGlobalPromptCtx() {
  const scopes = {}
  const sections = []
  const updates = []
  const ctx = {
    settings: {
      register(ns) {
        scopes[ns] = scopes[ns] || { value: undefined }
        return {
          get() { return scopes[ns].value },
          watch() { return () => {} },
          update(patch) { updates.push({ ns, patch }); return Promise.resolve() },
          replace() { return Promise.resolve() },
        }
      },
    },
    systemPrompt: { section(s) { sections.push(s); return () => {} } },
    agents: { roots() { return [] } },
    inject() { return () => {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on() {},
    timeout() { return () => {} },
  }
  return { ctx, scopes, sections, updates }
}

async function globalPromptChecks() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'lib/global-prompt.js')).href)
  const { ctx, scopes, sections, updates } = makeGlobalPromptCtx()
  mod.apply(ctx, { maxFileBytes: 64, maxTotalBytes: 128 })

  const globalSection = sections.find((s) => s.name === 'global-prompt')
  if (globalSection === undefined) throw new Error('global-prompt 段未注册')

  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-st-prompt-files-'))
  const small = path.join(dir, 'small.txt')
  const big = path.join(dir, 'big.txt')
  writeFileSync(small, 'hello {{braces}}')
  writeFileSync(big, 'x'.repeat(200))

  scopes['global-prompt'].value = { enabled: true, content: 'Base', files: [small] }
  const first = globalSection.text({})
  const afterFirst = updates.length
  globalSection.text({})
  const afterSecond = updates.length

  // 内容变化（size/mtime 变化）后必须重读并重新投影
  writeFileSync(small, 'hello {{braces}} v2')
  const future = new Date(Date.now() + 2000)
  utimesSync(small, future, future)
  scopes['global-prompt'].value = { enabled: true, content: 'Base', files: [small] }
  const third = globalSection.text({})
  const afterThird = updates.length

  scopes['global-prompt'].value = { enabled: true, content: 'Base', files: [big] }
  const fourth = globalSection.text({})
  const lastStatus = updates.length > 0 ? updates[updates.length - 1].patch.byScope.global[0] : undefined

  rmSync(dir, { recursive: true, force: true })
  return {
    literal: globalSection.interpolate === false,
    noSanitize: first === 'Base\nhello {{braces}}',
    writeSuppressed: afterSecond === afterFirst,
    refreshed: afterThird > afterSecond && third.indexOf('v2') !== -1,
    oversized: fourth === 'Base' && lastStatus !== undefined && lastStatus.status === 'fail',
  }
}

const gp = await globalPromptChecks()
check('global-prompt 段声明 interpolate:false', gp.literal)
check('引用文件内容按原文注入（不再空格化花括号）', gp.noSanitize)
check('文件未变时不重复写 settings（写入抑制）', gp.writeSuppressed)
check('文件变化后重读并重新投影', gp.refreshed)
check('超大文件判 fail 且不注入', gp.oversized)

rmSync(negDedupDir, { recursive: true, force: true })
rmSync(negLiteralDir, { recursive: true, force: true })

console.log('')
console.log(`共 ${total.count} 条：通过 ${total.count - failures.length}，失败 ${failures.length}`)
if (failures.length > 0) {
  console.error('提示词管线契约不成立：')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(EXIT.FAIL)
}
console.log('全部断言成立（含 2 条负向对照：还原历史缺陷后对应断言确实报红）。')
process.exit(EXIT.PASS)
