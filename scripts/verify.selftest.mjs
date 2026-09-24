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
import {
  appendFileSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertOutsideWorkspace as guardPathOk, manifest, manifestDiff,
} from './lib/manifest-guard.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP_BASE = os.tmpdir()
const EXIT = { PASS: 0, FAIL: 1 }

// ------------------------------------------------------------------ 护栏 1
// 裁定 #11：判据是「与工作区根之间不存在前缀包含关系（双向）」，不只是"不相等"。
// 否则 D:\ws\sub 这种「不相等但仍在工作区内」的路径会漏过去。
// 判据本体在 `scripts/lib/manifest-guard.mjs`（纯函数、可取用）；此处的包装负责**拒绝的形式**
// ——门在违规时 `process.exit(FAIL)`（`--selftest` 与 CI 都靠退出码），并原样保留可读的两行输出。
function assertOutsideWorkspace(p, label) {
  try {
    guardPathOk(p, label, { root: ROOT, tmpBase: TMP_BASE })
  } catch (e) {
    console.error(e.message)
    process.exit(EXIT.FAIL)
  }
}

// ------------------------------------------------------------------ 护栏 2
// 判据与实测数字见 `scripts/lib/manifest-guard.mjs`（纳入口径 = 「不得改动任何未忽略内容」）；
// 本文件 `guard2/*` 自证项会打印清单条数，用来核那个 1524 = 1474 + 1 + 49 的分解。


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
    // 裁定 #18 / BL-018：`CHECKED_JS` 曾用单层 readdir ⇒ 嵌套目录里的 JS 完全不进语法门。
    // 本用例造一个**两层嵌套**、内容有语法错的 .js：递归后必须被 `node --check` 抓到并逐字报出路径。
    // 自证如何能失败：把 `listJsFiles()` 的 `if (e.isDirectory()) walk(...)` 去掉 ⇒ EXIT=0 ⇒ 本用例红。
    id: 'syntax-error-nested', kind: 'red', marker: 'syntax: lib/deeply/nested/legacy.js 语法错误',
    mutate: (d) => {
      mkdirSync(path.join(d, 'lib/deeply/nested'), { recursive: true })
      writeFileSync(path.join(d, 'lib/deeply/nested/legacy.js'), 'function broken( {\n')
    },
  },
  {
    // 裁定 #21-symlink-1：名字以 .js 结尾、指向真实文件的符号链接**必须进 CHECKED_JS**。
    // （递归 walker 第一版只收 `e.isFile()`，对链接返回 false ⇒ 静默跳过，覆盖面反而比旧版缩了。）
    id: 'syntax-symlink-to-broken', kind: 'red', marker: 'syntax: lib/link_to_broken.js 语法错误',
    mutate: (d) => {
      writeFileSync(path.join(d, 'lib/broken-target.js'), 'function broken( {\n')
      symlinkSync('./broken-target.js', path.join(d, 'lib/link_to_broken.js'))
    },
  },
  {
    // 裁定 #21-symlink-2：悬空链接必须**大声报红**（旧版平铺会把它交给 node --check 硬红；递归第一版静默跳过 ⇒ EXIT=0）。
    id: 'syntax-symlink-dangling', kind: 'red', marker: 'syntax/link: lib/dangling.js 是**悬空符号链接**',
    mutate: (d) => symlinkSync('/nonexistent-target-xyz', path.join(d, 'lib/dangling.js')),
  },
  {
    // 裁定 #21-symlink-3：符号链接目录**不跟随**（防环），但必须报红并说明"请改成真实目录"。
    // 不许做成"打印一行 note 然后继续绿" —— 本门无法证明该目录下的内容被覆盖。
    id: 'syntax-symlink-dir', kind: 'red', marker: '本门不跟随符号链接目录（避免环），请改成真实目录',
    mutate: (d) => {
      mkdirSync(path.join(d, 'lib/real-dir'), { recursive: true })
      symlinkSync('./real-dir', path.join(d, 'lib/linkdir'))
    },
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

// ------------------------------------------------------------------ 护栏自证（裁定 #53）
// 判据：「不会失败的检查等于没有检查」。两条护栏此前都**没有用例证明它们报得出红**
// （拒绝分支 `:62-66` 与对拍分支 `:91-96` 从未被触发过一次）。
function check(id, ok, notes) {
  // `notes` 存成**数组**：本文件既有的汇总（`:507` 区）用 `f.notes.join('；')` 拼多行，
  // 曾有版本在此存字符串 ⇒ 只在**真的有失败**时才崩（`TypeError: f.notes.join is not a function`），
  // 即"全绿时看不出来"。存数组让两种输入都安全。
  const arr = Array.isArray(notes) ? notes : notes ? [String(notes)] : []
  results.push({ id, kind: 'guard', status: null, pass: ok, notes: ok ? [] : arr })
  console.log(`${ok ? 'PASS' : 'FAIL'}  [guard] ${id}${ok ? '' : `  ← ${arr.join('；')}`}`)
}

// 护栏 1 自证：判据本体（`scripts/lib/manifest-guard.mjs`）必须拒绝「与工作区根双向有前缀包含」的路径。
// 负向对照（本用例自身可失败）：把该模块 `assertOutsideWorkspace` 的 `nested` 改成 `const nested = false`
//   ⇒ 第一条断言红 ⇒ 本门 EXIT=1（实测读数见 §15 / 交付报告）。
{  // 门的**全部判据分支**逐个喂（纯内存，不起子进程）：
  // ⚠️ 曾经的写法（已废弃，两次踩坑）：起子进程 `import` 本门文件去调它自己那个包装 ——
  //    本门**顶层就是主流程**（先跑用例、最后才对拍），于是 import 它会连它自己的自证一起跑，
  //    而那条自证又起子进程 ⇒ **无限递归 fork**（实测触发两次，均以 pkill 收场）。
  //    改判：门的包装不过两行（`guardPathOk` + `process.exit`），其运行证据来自本门启动时的
  //    `assertOutsideWorkspace(WORK, …)`（`:113` 区，合法路径必须放行，否则本门根本跑不到这里）；
  //    **判据本身**由下表覆盖，而"门确实用它、且在真 ROOT 上执行"由下面的变异测试覆盖。
  const fakeRoot = path.join(TMP_BASE, 'dsh-st-fake-root')
  const fakeTmp = path.join(TMP_BASE, 'dsh-st-fake-tmp')
  const j = (...p) => path.join(...p)
  const guard1Cases = [
    { name: '工作区内·真', p: j(fakeRoot, 'sub'), root: fakeRoot, tmp: fakeTmp, reject: true, why: '在工作区根之下' },
    { name: '等于工作区根', p: fakeRoot, root: fakeRoot, tmp: fakeTmp, reject: true, why: '双向包含（相等）' },
    { name: '反向包含·根本身在候选之下', p: fakeTmp, root: j(fakeTmp, 'sub'), tmp: fakeTmp, reject: true, why: 'reverse-nested（裁定 #11 补的那格）' },
    { name: '前缀像但其实无关', p: j(fakeTmp, 'other', 'x'), root: j(fakeTmp, 'oth'), tmp: fakeTmp, reject: false, why: '按分量比较，不是字符串前缀 ⇒ 必须放行' },
    { name: '临时区·合法', p: j(fakeTmp, 'work', 'x'), root: fakeRoot, tmp: fakeTmp, reject: false, why: '在 tmpBase 之下且与根无包含关系' },
    { name: '两者皆非', p: j(path.sep, 'definitely-outside'), root: fakeRoot, tmp: j(fakeTmp, 'nowhere'), reject: true, why: '既不在 tmpBase 下、也不在根下 ⇒ 拒' },
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
      `guard1/判据-自证·${c.name}`,
      rejected === c.reject,
      `期望${c.reject ? '拒绝' : '放行'}（${c.why}），实得${rejected ? '拒绝' : '放行'}`
      + `（p=${c.p} root=${c.root} tmpBase=${c.tmp}）`
      + (rejected && !c.reject ? `；拒绝消息：${m.split('\n')[0]}` : ''),
    )
  }
}

// ------------------------------------------------------------------ 护栏 2 自证
// `manifestDiff` 三个分支（新增 / 内容变化 / 删除）各喂一次；**只在 Map 内存里造差异**，
// 不触碰任何文件（`manifest(ROOT)` 本身是纯读）。
// 「门确实在真 ROOT 上对拍、且真能报红」由变异测试覆盖（`verify.selftest.mjs` 的副本 + 在其根写文件）。
// 负向对照（本用例自身可失败）：把 `manifestDiff` 改成 `return []` ⇒ 三条同时红（实测读数见 §15）。
{
  const m0 = manifest(ROOT)
  const probe = [...m0.keys()]
  const ignoredInList = probe.filter((k) => k === '.DS_Store' || k.startsWith('.pnpm-store/'))

  check(
    'guard2/清单-自证·非空',
    m0.size >= 10,
    `清单仅 ${m0.size} 条 ⇒ 清单为空或近乎为空时，对拍恒绿（护栏形同虚设）`,
  )

  check(
    'guard2/清单-自证·不含忽略项',
    ignoredInList.length === 0,
    `清单仍含忽略项 ${ignoredInList.length} 条（${ignoredInList.slice(0, 3).join(', ')}）`
    + ' ⇒ 纳入口径未生效：`pnpm install` 或 Finder 一动就让本格报红而**归因错**'
    + '（1524 条里 1474 条 store + 1 条 .DS_Store，真被测面只有 49）',
  )

  const added = new Map(m0)
  added.set('__selfcheck__/新增', '0'.repeat(64))
  check(
    'guard2/manifestDiff-自证·新增',
    manifestDiff(m0, added).length === 1,
    '造 1 条新增，应报 1 条差异；报 0 条 ⇒ 对拍报不出差异',
  )

  if (probe.length > 0) {
    const k0 = probe[0]
    const changed = new Map(m0)
    changed.set(k0, '0'.repeat(64))
    check(
      'guard2/manifestDiff-自证·内容变化',
      manifestDiff(m0, changed).length === 1,
      `造 1 条内容变化（键 ${k0}），应报 1 条差异；报 0 条 ⇒ 对拍报不出差异`,
    )

    const deleted = new Map(m0)
    deleted.delete(k0)
    check(
      'guard2/manifestDiff-自证·删除',
      manifestDiff(m0, deleted).length === 1,
      `造 1 条删除（键 ${k0}），应报 1 条差异；报 0 条 ⇒ 对拍报不出差异`,
    )
  } else {
    check('guard2/manifestDiff-自证·内容变化', false, '清单为空 ⇒ 无法造差异，护栏 2 本就无意义')
    check('guard2/manifestDiff-自证·删除', false, '清单为空 ⇒ 无法造差异，护栏 2 本就无意义')
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
