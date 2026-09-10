#!/usr/bin/env node
/**
 * verify.mjs 的负向自测门 ——「不会失败的检查等于没有检查」的可重复执行形式。
 *
 * 做三件事：
 *   1. 阳性对照：未经破坏的副本必须跑绿（否则下面所有"报红"都可能是副本机制本身坏了）。
 *   2. 逐条破坏：每个副本恰好施加一处破坏，断言 verify.mjs **报红且报出指定的失败项**。
 *      —— 只断言"退出码非零"是不够的：崩溃、用法错误、别的检查命中都会产生非零。
 *   3. 路径/边界覆盖：skip（exit 2）、dry-run 降级（exit 0）、用法错误（exit 64）、
 *      合法版本引用被扰动但不该报红（exit 0）——各自断言退出码与输出措辞符合 verify.mjs 文件头的契约。
 *
 * 退出码契约（本文件）：0 = 全部预期行为成立；1 = 至少一条不再成立（自测本身被证伪）。
 *
 * 【勿改】硬性约束（继承 verify.mjs）：
 *   - 沙箱禁止带管道 stdio 的 spawn（子进程 EPERM）——必须用文件描述符，绝不用管道；fd 个数不受限。
 *   - 机器可读输出（如 `npm pack --dry-run --json`）必须与 stderr 分开落盘（verify.mjs 的 run() 即双 fd）。
 *     本自测门只做文本标记断言、不解析机器可读 JSON，故自身用单 fd 是允许的；
 *     但**不得据此把 verify.mjs 改回单 fd**——那会复活"JSON 被 stderr 提示污染"的偶发假红（见 verify.mjs 文件头 L22-27）。
 *   - 全部破坏施加在 os.tmpdir() 的副本上，**工作区零写入**；脚本内自带两条护栏：
 *       护栏 1：任何写路径必须落在 os.tmpdir() 之下，且与工作区根之间**不得存在前缀包含关系（双向）**
 *              （判据 `within(abs, ROOT) || within(ROOT, abs)`，不只是"不相等"——裁定 #11）；
 *       护栏 2：跑前跑后对工作区做内容对拍（SHA256，跳过 .git 与 node_modules），
 *              内容不一致即判自测失败。按协议 §6.6，只看内容，永不把 .git mtime 纳入判据。
 *   - 不进 pnpm verify（保持快门快）；CI 中由 npm-publish.yml 的 selftest job 单独调用。
 *
 * 已知未覆盖（明列，不沉默）：
 *   1. checkSyntax 中 run() 的 spawn error 分支（r.error 非空）：需 spawn 本身失败
 *      （EPERM/ENOENT），本环境不可稳定构造。
 *   2. package.json 存在但读失败等 IO 异常族（权限/目录）：需构造环境相关条件。
 *   3. workflow YAML 自身的行为（tag 守卫、job 依赖、触发分支）：不在本自测范围——
 *      本自测只针对 verify.mjs。tag 守卫的显式枚举反例（v0.1.70 必须被拒）**本机未能执行**
 *      （本沙箱无可用 POSIX shell：MSYS 系启动即崩，WSL 未安装），已固化为 CI 的
 *      `Tag guard matrix` 步骤（从工件 awk 抽取真 case 块执行）；其首次证据来自 CI，见裁定 #10 回报。
 *   4. 并发写者导致的工作区变动：由护栏 2 检测并报出，但这属于"检测"而非"覆盖"。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP_BASE = os.tmpdir()
const EXIT = { PASS: 0, FAIL: 1 }

// ------------------------------------------------------------------ 护栏 1
// 裁定 #11：判据是「与工作区根之间不存在前缀包含关系（双向）」，不只是"不相等"。
// 否则 D:\ws\sub 这种「不相等但仍在工作区内」的路径会漏过去。
function within(a, b) {
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
}

function assertOutsideWorkspace(p, label) {
  const abs = path.resolve(p)
  const inTmp = within(abs, TMP_BASE)
  const nested = within(abs, ROOT) || within(ROOT, abs)
  if (!inTmp || nested) {
    console.error(`护栏 1 触发：${label} → ${abs}`)
    console.error('  必须在 os.tmpdir() 之下，且与工作区根之间不得存在前缀包含关系（双向）。拒绝继续。')
    process.exit(EXIT.FAIL)
  }
}

// ------------------------------------------------------------------ 护栏 2
const IGNORE_DIRS = new Set(['.git', 'node_modules'])

function manifest(dir) {
  const out = new Map()
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) walk(p)
      } else if (e.isFile()) {
        out.set(
          path.relative(dir, p).split(path.sep).join('/'),
          createHash('sha256').update(readFileSync(p)).digest('hex'),
        )
      }
    }
  }
  walk(dir)
  return out
}

function manifestDiff(before, after) {
  const diffs = []
  for (const [k, v] of after) if (before.get(k) !== v) diffs.push(before.has(k) ? `内容变化: ${k}` : `新增: ${k}`)
  for (const k of before.keys()) if (!after.has(k)) diffs.push(`删除: ${k}`)
  return diffs
}

// ------------------------------------------------------------------ 运行器
// 先判路径、再落盘：否则"先在禁止位置建目录、再拒绝"仍是工作区写入。
assertOutsideWorkspace(path.join(TMP_BASE, 'dsh-st-selftest-'), '自测工作目录模板')
const WORK = mkdtempSync(path.join(TMP_BASE, 'dsh-st-selftest-'))
assertOutsideWorkspace(WORK, '自测工作目录')

// 子进程环境：清掉 DSH_TOOLKIT_NPM_CLI，避免外部残留把它指向别处而改变被判对象的行为
// （唯一例外是 skip 用例，它**故意**把该变量指向一个非 npm-cli 文件）。
const BASE_ENV = { ...process.env }
delete BASE_ENV.DSH_TOOLKIT_NPM_CLI

let seq = 0

function runVerify(dir, { exe = process.execPath, argv = [], env = BASE_ENV } = {}) {
  seq += 1
  const log = path.join(WORK, `log-${String(seq).padStart(2, '0')}.txt`)
  const fd = openSync(log, 'w')
  try {
    const r = spawnSync(exe, [path.join(dir, 'scripts', 'verify.mjs'), ...argv], {
      cwd: dir, stdio: ['ignore', fd, fd], env,
    })
    return { status: r.status, error: r.error, output: readFileSync(log, 'utf8') }
  } finally {
    closeSync(fd)
  }
}

const COPY_ENTRIES = ['lib', 'client', 'scripts', 'package.json', 'cordis.patch.yml', 'README.md', 'README.zh.md']

function makeCopy(id) {
  const dest = path.join(WORK, id)
  assertOutsideWorkspace(dest, `case=${id} 副本`)
  mkdirSync(dest, { recursive: true })
  for (const e of COPY_ENTRIES) {
    const src = path.join(ROOT, e)
    if (existsSync(src)) cpSync(src, path.join(dest, e), { recursive: true })
  }
  return dest
}

// ------------------------------------------------------------------ 变异助手
function editPkg(dir, fn) {
  const f = path.join(dir, 'package.json')
  const p = JSON.parse(readFileSync(f, 'utf8'))
  fn(p)
  writeFileSync(f, JSON.stringify(p, null, 2)) // 默认 UTF-8 无 BOM（PS 5.1 的 utf8 会写 BOM，此处不经过 PowerShell）
}

function pkgVersion(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version
}

function bumpPatch(v) {
  const p = v.split('.')
  p[2] = String(Number(p[2]) + 1)
  return p.join('.')
}

/** 副本内替换：仅在目标 README 出现当前版本串时才有意义，故由用例自行确认。 */
function replaceIn(file, from, to) {
  const s = readFileSync(file, 'utf8')
  writeFileSync(file, s.split(from).join(to))
}

// ------------------------------------------------------------------ 用例表
// kind: 'control' 未破坏的阳性对照 | 'red' 期望报红且命中 marker | 'path' 期望特定退出码与 marker
const CASES = [
  { id: 'control-pristine', kind: 'control', marker: '全部检查通过', expectExit: 0 },

  {
    id: 'pkg-missing', kind: 'red', marker: 'pack/package-json: package.json 不存在',
    mutate: (d) => rmSync(path.join(d, 'package.json')),
  },
  {
    id: 'pkg-invalid-json', kind: 'red', marker: 'pack/package-json: package.json 不是合法 JSON',
    mutate: (d) => writeFileSync(path.join(d, 'package.json'), '{ not json '),
  },
  {
    id: 'readme-missing', kind: 'red', marker: 'pack/docs: README.zh.md 缺失',
    mutate: (d) => rmSync(path.join(d, 'README.zh.md')),
  },
  {
    id: 'syntax-error', kind: 'red', marker: 'syntax: lib/sanitize.js 语法错误',
    mutate: (d) => appendFileSync(path.join(d, 'lib/sanitize.js'), '\nfunction broken( {\n'),
  },
  {
    id: 'build-step', kind: 'red', marker: 'pack/build-step: package.json 出现构建脚本 prepare',
    mutate: (d) => editPkg(d, (p) => { p.scripts = { ...(p.scripts ?? {}), prepare: 'node -e 0' } }),
  },
  {
    id: 'entry-missing', kind: 'red', marker: 'pack/entry: main → lib/does-not-exist.js 在仓库中不存在',
    mutate: (d) => editPkg(d, (p) => { p.main = 'lib/does-not-exist.js' }),
  },
  {
    id: 'entry-not-packed', kind: 'red', marker: 'pack/entry: dsh.bundle.patch → ./cordis.patch.yml 未被打进 tgz',
    mutate: (d) => editPkg(d, (p) => { p.files = (p.files ?? []).filter((f) => f !== 'cordis.patch.yml') }),
  },
  {
    id: 'files-missing', kind: 'red', marker: 'pack/files: files 白名单中的 lib/nope-dir 未出现在 tgz',
    mutate: (d) => editPkg(d, (p) => { p.files = [...(p.files ?? []), 'lib/nope-dir'] }),
  },
  {
    id: 'client-no-exports', kind: 'red', marker: 'pack/client: 声明了 dsh.client 却没有 exports["./client"]',
    mutate: (d) => editPkg(d, (p) => { delete p.exports['./client'] }),
  },
  {
    id: 'client-platform-type', kind: 'red', marker: 'pack/client: dsh.client.platform 必须是字符串',
    mutate: (d) => editPkg(d, (p) => { p.dsh.client.platform = 123 }),
  },
  {
    id: 'client-inject-type', kind: 'red', marker: 'pack/client: dsh.client.inject 必须是字符串数组',
    mutate: (d) => editPkg(d, (p) => { p.dsh.client.inject = 'not-an-array' }),
  },
  {
    id: 'client-external-type', kind: 'red', marker: 'pack/client: dsh.client.external 必须是字符串数组',
    mutate: (d) => editPkg(d, (p) => { p.dsh.client.external = 'not-an-array' }),
  },
  {
    id: 'import-undeclared', kind: 'red', marker: 'pack/import: not-a-real-pkg 未声明却被 import/require',
    mutate: (d) => appendFileSync(path.join(d, 'lib/sanitize.js'), "\nimport __qaGhost from 'not-a-real-pkg'\n"),
  },
  {
    id: 'docs-mismatch', kind: 'red', marker: 'pack/docs: README.md 与 README.zh.md 提及的版本集合不一致',
    mutate: (d) => replaceIn(path.join(d, 'README.zh.md'), pkgVersion(d), bumpPatch(pkgVersion(d))),
  },
  {
    id: 'docs-self-version-both-stale', kind: 'red', marker: 'pack/docs: README.md 的「本包当前版本」声明为 {vb}',
    mutate: (d) => {
      const v = pkgVersion(d)
      const bogus = bumpPatch(v)
      replaceIn(path.join(d, 'README.md'), v, bogus)
      replaceIn(path.join(d, 'README.zh.md'), v, bogus)
    },
  },
  {
    // 7b 反例固化为门：自述写旧版 + 别处提到新版 —— 旧「集合包含」语义会绿，定向断言必须红。
    id: 'docs-self-stale-with-decoy', kind: 'red', marker: 'pack/docs: README.md 的「本包当前版本」声明为 {vb}',
    mutate: (d) => {
      const v = pkgVersion(d)
      const bogus = bumpPatch(v)
      for (const n of ['README.md', 'README.zh.md']) {
        const f = path.join(d, n)
        const s = readFileSync(f, 'utf8')
        const after = s.replace(
          /(Current version:\s*\*\*|当前版本[:：]\s*\*\*)[0-9]+\.[0-9]+\.[0-9]+(\*\*)/,
          (all, a, b) => a + bogus + b,
        )
        if (after === s) throw new Error(`decoy 变异未生效：${n} 的自述行未匹配`)
        writeFileSync(f, `${after}\n\n<!-- 迁移记录：${v} 的变更说明 -->\n`)
      }
    },
  },
  {
    id: 'docs-self-version-missing', kind: 'red', marker: 'pack/docs: README.md 未找到任何「本包当前版本」声明',
    mutate: (d) => replaceIn(path.join(d, 'README.md'), 'Current version:', 'Version:'),
  },
  {
    // 第三种声明位（安装片段 dsh-session-toolkit@<版本>）在真实 README 里当前无实例，
    // 补一条负向测试，避免该模式长期未被执行（未被执行的模式等于没有模式）。
    id: 'docs-install-snippet-stale', kind: 'red', marker: 'pack/docs: README.md 的「本包当前版本」声明为 {vb}',
    mutate: (d) => {
      const bogus = bumpPatch(pkgVersion(d))
      for (const n of ['README.md', 'README.zh.md']) {
        appendFileSync(path.join(d, n), `\n\n\`\`\`\ndsh plugin --profile web add dsh-session-toolkit@${bogus}\n\`\`\`\n`)
      }
    },
  },
  {
    // 不得假红：其它合法版本引用（harness 版本 / 依赖线 / cordis / schemastery）变动不应触发定向断言。
    id: 'docs-legit-refs-not-misjudged', kind: 'path', expectExit: 0, marker: '「本包当前版本」声明 = {v}',
    mutate: (d) => {
      for (const n of ['README.md', 'README.zh.md']) {
        const f = path.join(d, n)
        writeFileSync(f, readFileSync(f, 'utf8')
          .split('3.18.1').join('3.18.2')
          .split('4.0.1').join('4.0.2')
          .split('0.1.2-alpha.1').join('0.1.3-alpha.1'))
      }
    },
  },
]

// ------------------------------------------------------------------ 特殊用例
function caseSyntaxEmpty() {
  const d = path.join(WORK, 'syntax-empty')
  assertOutsideWorkspace(d, 'case=syntax-empty')
  mkdirSync(path.join(d, 'tools'), { recursive: true })
  writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'minimal', version: '1.0.0', type: 'module' }, null, 2))
  writeFileSync(path.join(d, 'README.md'), 'minimal 1.0.0\n')
  writeFileSync(path.join(d, 'README.zh.md'), 'minimal 1.0.0\n')
  cpSync(path.join(ROOT, 'scripts', 'verify.mjs'), path.join(d, 'tools', 'verify.mjs'))
  const log = path.join(WORK, 'log-syntax-empty.txt')
  const fd = openSync(log, 'w')
  try {
    const r = spawnSync(process.execPath, [path.join(d, 'tools', 'verify.mjs')], {
      cwd: d, stdio: ['ignore', fd, fd],
    })
    return { status: r.status, output: readFileSync(log, 'utf8') }
  } finally {
    closeSync(fd)
  }
}

function caseSkip() {
  // 裁定 #11 批准的构造：DSH_TOOLKIT_NPM_CLI 指向一个"真实存在但非 npm-cli"的文件
  // → npmCli() 命中该路径 → 真实 pack 失败 → dry-run 也失败 → 进 skip('pack', …)。
  const d = makeCopy('skip')
  const decoy = path.join(d, 'cordis.patch.yml')
  if (!existsSync(decoy)) throw new Error('skip 构造失败：诱饵文件 cordis.patch.yml 不存在')
  return runVerify(d, { env: { ...BASE_ENV, DSH_TOOLKIT_NPM_CLI: decoy } })
}

function caseDryRunFallback() {
  // 让 hasTar() 为假：PATH 指向空目录 → `tar --version` 直接 ENOENT → 退化为 npm pack --dry-run。
  const emptybin = path.join(WORK, 'emptybin')
  assertOutsideWorkspace(emptybin, 'case=dry-run 的空 PATH 目录')
  mkdirSync(emptybin, { recursive: true })
  const d = makeCopy('dry-run')
  return runVerify(d, { env: { ...process.env, PATH: emptybin, Path: emptybin } })
}

function caseUsage() {
  const d = makeCopy('usage')
  return runVerify(d, { argv: ['bogus-mode'] })
}

// ------------------------------------------------------------------ 断言
const results = []

function judge(c, r, { expectExit, marker, forbid }) {
  const notes = []
  let pass = true
  if (r.error) {
    pass = false
    notes.push(`spawn 失败：${r.error.code ?? r.error.message}`)
  } else if (r.status !== expectExit) {
    pass = false
    notes.push(`退出码 ${r.status} ≠ 期望 ${expectExit}`)
  }
  const ver = pkgVersion(ROOT)
  const m = marker.replace('{v}', ver).replace('{vb}', bumpPatch(ver))
  if (!r.output.includes(m)) {
    pass = false
    notes.push(`输出未命中期望标记：${m}`)
  }
  if (forbid && r.output.includes(forbid)) {
    pass = false
    notes.push(`输出出现了禁止出现的措辞：${forbid}`)
  }
  results.push({ id: c.id, kind: c.kind, status: r.status, pass, notes })
  const flag = pass ? 'PASS' : 'FAIL'
  console.log(`${flag}  [${c.kind}] ${c.id} exit=${r.status}${pass ? '' : `  ← ${notes.join('；')}`}`)
  if (!pass) {
    const tail = r.output.trim().split(/\r?\n/).slice(-8).join('\n')
    console.log(`      ---- verify.mjs 输出尾部 ----\n${tail}\n      ----------------------------`)
  }
}

// ------------------------------------------------------------------ 主流程
console.log(`验证门负向自测（verify.selftest.mjs）`)
console.log(`工作区：${ROOT}`)
console.log(`副本与日志：${WORK}`)
console.log('')

const before = manifest(ROOT)

for (const c of CASES) {
  const dir = makeCopy(c.id)
  if (c.mutate) c.mutate(dir)
  judge(c, runVerify(dir), { expectExit: c.expectExit ?? 1, marker: c.marker })
}

{
  const c = { id: 'syntax-empty', kind: 'red' }
  judge(c, caseSyntaxEmpty(), { expectExit: 1, marker: 'syntax: 未发现任何待检查的 JS 文件' })
}
{
  const c = { id: 'pack-skipped', kind: 'path' }
  judge(c, caseSkip(), { expectExit: 2, marker: '跳过 1 项 —— 未完成验证（非通过）', forbid: '全部检查通过' })
}
{
  const c = { id: 'pack-dry-run-fallback', kind: 'path' }
  judge(c, caseDryRunFallback(), { expectExit: 0, marker: '打包清单来源：npm pack --dry-run' })
}
{
  const c = { id: 'usage-unknown-mode', kind: 'path' }
  judge(c, caseUsage(), { expectExit: 64, marker: '未知模式 bogus-mode' })
}

// ------------------------------------------------------------------ 工作区对拍（护栏 2）
const after = manifest(ROOT)
const diffs = manifestDiff(before, after)
if (diffs.length > 0) {
  results.push({ id: 'workspace-immutability', kind: 'guard', status: null, pass: false, notes: diffs })
  console.log(`FAIL  [guard] workspace-immutability`)
  for (const d of diffs) console.log(`      ${d}`)
}

const failed = results.filter((r) => !r.pass)
console.log('')
console.log(`共 ${results.length} 条：通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length > 0) {
  console.error('')
  console.error(`自测失败 ${failed.length} 条——门的某条预期行为已不再成立，或工作区在自测期间被并发写者改动：`)
  for (const f of failed) console.error(`  - [${f.kind}] ${f.id}：${f.notes.join('；')}`)
  console.error(`副本保留在 ${WORK} 以供排查。`)
  process.exit(EXIT.FAIL)
}
console.log('全部负向断言成立：门的每条检查都能报红，路径退出码契约成立，工作区零写入。')
rmSync(WORK, { recursive: true, force: true })
process.exit(EXIT.PASS)
