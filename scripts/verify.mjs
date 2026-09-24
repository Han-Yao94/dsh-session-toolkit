#!/usr/bin/env node
/**
 * dsh-session-toolkit 离线验证门。
 *
 * 背景：本包无构建步骤，「改完直接装」是常态，但此前没有任何可执行的验证信号——
 * README 里几条关键承诺（tgz 干净安装可解析全部 import、双语文档成对同步、
 * 入口可达）都只靠人工核过。本脚本把它们变成可重复执行的断言。
 *
 *   syntax —— 随包 JS 全部通过 `node --check`（语法门，秒级）。
 *   pack   —— 打包清单、入口可达性、import 声明完整性、双语 README 版本一致。
 *
 * 用法：node scripts/verify.mjs [syntax|pack|all]   （默认 all）
 *
 * 退出码契约（三态必须互相可区分；skip 绝不与「通过」同形）：
 *   0  = 全部检查通过
 *   1  = 有检查失败
 *   2  = 有检查被跳过（**未完成验证**，结果不得读作「通过」）——裁定 #11 指定
 *   64 = 用法错误（sysexits EX_USAGE；2 已划给"跳过"，为保持其唯一含义而挪走）
 * 末行措辞固定：跳过时必须是 `跳过 N 项 —— 未完成验证（非通过）`，且不得出现「全部检查通过」。
 * 不提供 `--allow-skip` 之类逃生口：逃生口会把红线变成"可关掉的东西"。
 *
 * 【勿改】本仓库沙箱禁止带管道 stdio 的 spawn（子进程会 EPERM）。
 * 所有子进程一律用**文件描述符**承接输出（绝不管道），输出落到日志文件再读回。
 * 且 stdout 与 stderr 必须**分开落盘**：共用一个 fd 会让 npm 的 stderr 提示（如
 * "npm notice New major version…"）混进 stdout 的机器可读 JSON，`JSON.parse` 随即抛
 * `Unexpected non-whitespace character after JSON`（2026-09-10 实测的偶发假红，见 log-22）。
 * 负向自测（证明每条断言都能报红）见 scripts/verify.selftest.mjs。
 */

import { spawnSync } from 'node:child_process'
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync,
  statSync,
} from 'node:fs'
import { builtinModules } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])
/**
 * 递归列出目录下所有 `.js`/`.mjs`，返回相对 ROOT 的 posix 路径（升序）。
 *
 * 【为什么必须递归（裁定 #18 / BL-018，2026-09-24）】此处原先用单层 `readdirSync`，
 * 于是**嵌套目录里的 JS 不进语法门**。当时 `scripts/lib/manifest-guard.mjs` 是唯一受害者：
 * 它被两门 import、每跑必执行（语法错会立刻红），所以真实风险低 —— 但「碰巧有人跑它」
 * 不是覆盖。**判据只能是"这个文件在 CHECKED_JS 里"**，不是"它恰好会被谁 import"。
 *
 * 不用 `scripts/lib/manifest-guard.mjs` 的 `manifest()`：那个清单按忽略表跳过
 * `.git`/`node_modules`/`.pnpm-store`，而忽略表是为**护栏口径**定的；哪天它扩了，
 * 语法门的覆盖面会跟着悄悄缩水。两者**同形但耦合方向不同**，故意各留一份。
 *
 * 【符号链接三条（裁定 #21，2026-09-24）—— 递归化引入的"静默丢覆盖"必须堵掉】
 *   递归 walker 第一版只收 `e.isFile()`，于是三格从"有声"变成"无声"：
 *     · `.js` 指向真实文件的链接：旧版（平铺）会收，新版**静默跳过** ⇒ 覆盖面反而缩了；
 *     · `.js` 悬空链接：旧版跑 `node --check` **硬报红**，新版**静默跳过** ⇒ EXIT=0；
 *     · 符号链接目录：不跟随（防环），但读数里**没有任何提示** ⇒ 同样读作"通过"。
 *   判据仍是同一句：**"这个文件在 CHECKED_JS 里"**。看不出来的跳过不是覆盖，是漏覆盖。
 *   故三条语义写死：①名字以 `.js`/`.mjs` 结尾且指向真实文件的链接 ⇒ **收**（跟不跟由名字定，不由形态定）；
 *   ②名字以 `.js`/`.mjs` 结尾的悬空链接 ⇒ **报红**（与旧版一致）；③**符号链接目录 ⇒ 报红**
 *   并说明"请改成真实目录"，**不做成一行 note 后继续绿** —— 本门无法证明其内容被覆盖。
 *   判据：`LINK_VIOLATIONS` 非空即 FAIL —— 由 `checkSyntax()` 里那条 `for (… ) fail('syntax/link', v)`
 *   落实。另有一道**与本条无关**的既有前置：「未发现任何待检查的 JS 文件」——那是**树本身没有 JS**
 *   （例如整棵 `lib/` 的内容都在被拒的链接目录里，清单因此为空）。**不要**把这一格做成提前返回：那样会
 *   静默丢掉该目录之后/同层其余文件的覆盖，正是本条要堵的漏覆盖。
 */
function listJsFiles(dir) {
  const abs = path.join(ROOT, dir)
  // 根目录不存在 ⇒ 空清单。此路径被既有用例 `syntax-empty` 覆盖（它构造一棵没有 lib/ 与 scripts/
  // 的树，期望「未发现任何待检查的 JS 文件」）；删掉这个 `existsSync` 会让该用例因 ENOENT 崩掉而红
  //（2026-09-24 实测的连带翻转，已回填）。
  if (!existsSync(abs)) return []
  const out = []
  const push = (p) => { out.push(`${dir}/${p}`) }
  const walk = (d, rel) => {
    const entries = readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      const childAbs = path.join(d, e.name)
      const jsish = e.name.endsWith('.js') || e.name.endsWith('.mjs')
      // 悬空符号链接：statSync 抛 ENOENT。必须先单独识别，否则它会被当成"普通文件"去 node --check
      //（那也能红，但报出的是 `Cannot find module` 而不是"这个链接是断的"，归因不准）。
      let stat = null
      let brokenLink = false
      if (e.isSymbolicLink()) {
        try { stat = statSync(childAbs) } catch { brokenLink = true }
      }
      if (brokenLink) {
        if (jsish) LINK_VIOLATIONS.push(`${dir}/${childRel} 是**悬空符号链接**：必须修好或删除。按名字它该被检查，实际读不到 ⇒ 不得读作"通过"。`)
        else LINK_VIOLATIONS.push(`${dir}/${childRel} 是悬空符号链接（名字不以 .js/.mjs 结尾，本门无法判断该怎么处理）⇒ 报红而不是跳过。`)
        continue
      }
      const isDir = stat ? stat.isDirectory() : e.isDirectory()
      if (isDir) {
        if (e.isSymbolicLink()) {
          LINK_VIOLATIONS.push(`${dir}/${childRel} 是**符号链接目录**：本门不跟随符号链接目录（避免环），请改成真实目录 —— 否则无法证明该目录下的 JS 被覆盖。`)
          continue
        }
        walk(childAbs, childRel)
        continue
      }
      if (jsish) push(childRel)
    }
  }
  walk(path.join(ROOT, dir), '')
  return out
}

/** 符号链接形态的三类违规（见 `listJsFiles` 注释）。非空即让语法门 FAIL，**不降级为 note**。 */
const LINK_VIOLATIONS = []

const CHECKED_JS = ['lib', 'scripts'].flatMap((d) => listJsFiles(d) ?? [])
  // `?? []` 是**纯防御，当前 `listJsFiles` 不会返回 null/undefined**（它只有 `return out` 与
  // 根目录不存在时的 `return []` 两条返回路径）⇒ 这半句不冒充机制，留着只为函数签名变化时兜底。
  // 「符号链接目录」那一格的报红**不靠这里**：它在 `walk` 里 `continue`、**其余条目照常走完**，
  // 由 `checkSyntax()` 里 `LINK_VIOLATIONS` 那条 `fail()` 报，与本行无关。
  .concat(existsSync(path.join(ROOT, 'client/client.js')) ? ['client/client.js'] : [])

/**
 * 「表示本包当前版本」的识别模式（docs 定向断言用）。
 * 只认这些显式声明位；其余版本串一律不参与匹配，以免误伤合法引用：
 * harness 版本 `dsh-v0.1.2-alpha.1`、依赖线 `0.1.2-alpha.1`、`@deepseek-ai/cordis` 4.0.1、
 * `@deepseek-ai/schemastery` 3.18.1、react 18.2.0。
 * 新增声明位时同步扩这里。README 若换措辞导致命中 0 处，本检查**响亮失败**（见下方 5b），
 * 不回退为"检查不到就算过"。
 */
const SELF_VERSION_PATTERNS = [
  { label: 'README.md: Current version 字段', re: /Current version:\s*\*\*([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?)\*\*/g },
  { label: 'README.zh.md: 当前版本 字段', re: /当前版本[:：]\s*\*\*([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?)\*\*/g },
  { label: '安装片段 dsh-session-toolkit@<版本>', re: /\bdsh-session-toolkit@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?)\b/g },
]
const SELF_VERSION_HINT = 'Current version: **X.Y.Z** / 当前版本:**X.Y.Z** / dsh-session-toolkit@X.Y.Z'

const EXIT = { PASS: 0, FAIL: 1, INCOMPLETE: 2, USAGE: 64 }

const failures = []
const notes = []   // 信息性提示，不改变退出码（例如真实打包失败后降级为 dry-run 清单）
const skips = []   // 未执行的校验，必须改变退出码（见文件头退出码契约）

function fail(check, detail) {
  failures.push(`${check}: ${detail}`)
}

function ok(msg) {
  console.log(`  ok   ${msg}`)
}

function skip(check, reason) {
  skips.push(`${check} 已跳过：${reason}`)
  console.log(`  SKIP ${reason}`)
}

/** 子进程日志落在临时目录，绝不污染仓库工作区。 */
const LOG_DIR = mkdtempSync(path.join(os.tmpdir(), 'dsh-st-verify-logs-'))
let runSeq = 0

/** stdout / stderr 分开落盘（共用 fd 会互相污染，见文件头说明）。 */
function run(cmd, args, opts = {}) {
  runSeq += 1
  const outPath = path.join(LOG_DIR, `run-${runSeq}.out.log`)
  const errPath = path.join(LOG_DIR, `run-${runSeq}.err.log`)
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  try {
    const r = spawnSync(cmd, args, { cwd: opts.cwd ?? ROOT, stdio: ['ignore', outFd, errFd], env: process.env })
    const stdout = readFileSync(outPath, 'utf8')
    const stderr = readFileSync(errPath, 'utf8')
    return { status: r.status, error: r.error, stdout, stderr, output: stdout + stderr, logPath: outPath }
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
}

function tail(text, lines = 12) {
  const all = text.trim().split(/\r?\n/)
  return all.slice(-lines).join('\n')
}

// ---------------------------------------------------------------- syntax 门

function checkSyntax() {
  console.log('\n[1/2] 语法门（node --check）')
  if (CHECKED_JS.length === 0) {
    fail('syntax', '未发现任何待检查的 JS 文件（CHECKED_JS 为空）')
    return
  }
  for (const rel of CHECKED_JS) {
    const abs = path.join(ROOT, rel)
    const r = run(process.execPath, ['--check', abs])
    if (r.error) fail('syntax', `${rel} 无法启动 node --check（${r.error.code ?? r.error.message}）`)
    else if (r.status !== 0) fail('syntax', `${rel} 语法错误：\n${tail(r.output)}`)
    else ok(rel)
  }
  // 放在最后只为**可读性**：先让每个被检查的 JS 打出 `ok`/语法错，再把符号链接形态的违规列在后面，
  // 两类读数不交错。**不是**机制所需 —— `LINK_VIOLATIONS` 无论放哪都会 `fail()`，报红不依赖循环顺序。
  for (const v of LINK_VIOLATIONS) fail('syntax/link', v)
}

// ---------------------------------------------------------------- 打包契约

let pkgError = null

/** 缺失或非法 JSON 时返回 null 并记录原因：调用方给出干净的失败项，而不是未捕获异常。 */
function pkg() {
  const file = path.join(ROOT, 'package.json')
  if (!existsSync(file)) {
    pkgError = 'package.json 不存在'
    return null
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    pkgError = `package.json 不是合法 JSON：${e.message}`
    return null
  }
}

function npmCli() {
  const candidates = [
    process.env.DSH_TOOLKIT_NPM_CLI,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) ?? null
}

function hasTar() {
  const r = run('tar', ['--version'])
  return !r.error && r.status === 0
}

/**
 * 打包清单。优先用真实产物（npm pack + tar -tzf），退化为 dry-run JSON，
 * 都不可用时返回 null（调用方 skip，而不是假装通过）。
 */
function packInventory(tmp) {
  const cli = npmCli()
  if (!cli) return { source: null, reason: '未找到 npm-cli.js（可用 DSH_TOOLKIT_NPM_CLI 指定）' }

  if (hasTar()) {
    const dest = path.join(tmp, 'real')
    mkdirSync(dest, { recursive: true })
    const r = run(process.execPath, [
      cli, 'pack', '--cache', path.join(tmp, 'cache'), '--pack-destination', dest,
    ])
    if (r.status === 0) {
      const tgz = existsSync(dest) ? readdirSync(dest).find((f) => f.endsWith('.tgz')) : null
      if (tgz) {
        const t = run('tar', ['-tzf', path.join(dest, tgz)])
        if (t.status === 0) {
          const paths = t.output.trim().split(/\r?\n/)
            .filter((l) => l && !l.endsWith('/'))
            .map((l) => l.replace(/^package\//, ''))
          return { source: `真实 tgz（${tgz}）`, paths }
        }
      }
    }
    notes.push(`真实打包失败，退化为 dry-run：${tail(r.output, 4)}`)
  }

  const r = run(process.execPath, [cli, 'pack', '--dry-run', '--json', '--cache', path.join(tmp, 'cache')])
  if (r.status !== 0) return { source: null, reason: `npm pack --dry-run 失败：${tail(r.output, 4)}` }
  // 只解析 stdout：stderr 上的 npm 提示不得进入 JSON 解析（见文件头说明）。
  const jsonStart = r.stdout.indexOf('[')
  if (jsonStart < 0) return { source: null, reason: 'npm pack --dry-run 未输出 JSON' }
  const parsed = JSON.parse(r.stdout.slice(jsonStart))
  return { source: 'npm pack --dry-run', paths: parsed[0].files.map((f) => f.path) }
}

function checkPack() {
  console.log('\n[2/2] 打包契约')
  const p = pkg()
  if (!p) {
    fail('pack/package-json', `${pkgError}——打包契约检查无法执行`)
    return
  }

  // 0) 本脚本用工作区文件内容审计 import，因此断言「包内内容 == 工作区内容」。
  const buildSteps = ['prepare', 'prepack', 'prepublishOnly'].filter((s) => p.scripts?.[s])
  if (buildSteps.length > 0) {
    fail('pack/build-step', `package.json 出现构建脚本 ${buildSteps.join(', ')}；工作区文件已不等于 tgz 内容，本脚本的 import 审计不再成立`)
  } else {
    ok('无构建步骤（工作区内容 == 包内容）')
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-st-verify-'))
  try {
    const inv = packInventory(tmp)
    if (!inv.paths) {
      skip('pack', inv.reason)
      return
    }
    const inPack = new Set(inv.paths)
    ok(`打包清单来源：${inv.source}，共 ${inv.paths.length} 个文件`)

    // 1) package.json 声明的入口/补丁必须在包内可达
    const declared = []
    if (p.main) declared.push(['main', p.main])
    for (const [key, val] of Object.entries(p.exports ?? {})) {
      const target = typeof val === 'string' ? val : val?.default
      if (target) declared.push([`exports["${key}"]`, target])
    }
    if (p.dsh?.bundle?.patch) declared.push(['dsh.bundle.patch', p.dsh.bundle.patch])
    for (const [label, rel] of declared) {
      const clean = rel.replace(/^\.\//, '')
      if (!existsSync(path.join(ROOT, clean))) fail('pack/entry', `${label} → ${rel} 在仓库中不存在`)
      else if (!inPack.has(clean)) fail('pack/entry', `${label} → ${rel} 未被打进 tgz`)
      else ok(`${label} → ${rel}`)
    }

    // 2) files 白名单每一项都要真的在包里出现
    for (const entry of p.files ?? []) {
      const hit = entry.includes('.')
        ? inPack.has(entry)
        : inv.paths.some((f) => f.startsWith(`${entry}/`))
      if (!hit) fail('pack/files', `files 白名单中的 ${entry} 未出现在 tgz`)
      else ok(`files: ${entry}`)
    }

    // 3) dsh.client 声明形状 —— 对齐 harness 自身的校验规则
    //    （client/modules/src/index.ts:767 `declares dsh.client but exports no "./client" bundle`；
    //      manifest.ts:139 `dsh.client.<field> must be a string array`）
    //    注意：dsh.client.inject 是**信息性**边（loading/prefetch 元数据，绝不参与 apply 排序，
    //    见 ui-workspace/src/client/index.ts:57），因此它**不**要求 npm 依赖声明，勿加此规则。
    if (p.dsh?.client) {
      if (!p.exports?.['./client']) {
        fail('pack/client', '声明了 dsh.client 却没有 exports["./client"]；harness 会拒绝该声明')
      } else {
        ok('dsh.client 声明存在且 exports["./client"] 已定义')
      }
      const decl = p.dsh.client
      for (const field of ['inject', 'external']) {
        const v = decl[field]
        if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
          fail('pack/client', `dsh.client.${field} 必须是字符串数组（harness 会抛错）`)
        }
      }
      if (decl.platform !== undefined && typeof decl.platform !== 'string') {
        fail('pack/client', 'dsh.client.platform 必须是字符串（harness 会抛错）')
      }
    }

    // 4) import 声明完整性 —— README 承诺「干净安装可解析全部 import」，此处静态核验
    const declaredDeps = new Set([
      ...Object.keys(p.dependencies ?? {}),
      ...Object.keys(p.peerDependencies ?? {}),
    ])
    const audited = inv.paths.filter((f) => f.endsWith('.js'))
    const undeclared = new Map()
    for (const rel of audited) {
      const src = readFileSync(path.join(ROOT, rel), 'utf8')
      for (const spec of specifiers(src)) {
        if (spec.startsWith('.') || spec.startsWith('/') || BUILTINS.has(spec)) continue
        const prefix = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        if (!declaredDeps.has(prefix)) {
          if (!undeclared.has(prefix)) undeclared.set(prefix, [])
          undeclared.get(prefix).push(`${rel} → ${spec}`)
        }
      }
    }
    if (undeclared.size > 0) {
      for (const [name, where] of undeclared) {
        fail('pack/import', `${name} 未声明却被 import/require：\n    ${where.join('\n    ')}`)
      }
    } else {
      ok(`import 声明完整（审计 ${audited.length} 个包内 JS 文件，全部裸依赖均已声明）`)
    }

    // 5) 双语 README —— (a) 两侧版本集合一致；(b) 「本包当前版本」定向断言。
    //    5b 的由来：集合包含语义挡不住「自述写旧版 + 别处提到新版」这类自述落后缺陷
    //    （0.1.7 事故的近亲变体）。反例与修前/修后对照见裁定 #6-EXT-1 回报。
    const missingDocs = ['README.md', 'README.zh.md'].filter((n) => !existsSync(path.join(ROOT, n)))
    if (missingDocs.length > 0) {
      fail('pack/docs', `${missingDocs.join('、')} 缺失——无法校验双语 README 版本一致`)
      return
    }
    const en = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    const zh = readFileSync(path.join(ROOT, 'README.zh.md'), 'utf8')
    const semver = /\b\d+\.\d+\.\d+\b/g
    const setOf = (s) => [...new Set(s.match(semver) ?? [])].sort()
    const [enV, zhV] = [setOf(en), setOf(zh)]
    const docsFailBefore = failures.length
    if (enV.join() !== zhV.join()) {
      fail('pack/docs', `README.md 与 README.zh.md 提及的版本集合不一致：\n    EN: ${enV.join(', ')}\n    ZH: ${zhV.join(', ')}`)
    }

    let selfHits = 0
    for (const [name, text] of [['README.md', en], ['README.zh.md', zh]]) {
      let hits = 0
      for (const { label, re } of SELF_VERSION_PATTERNS) {
        for (const m of text.matchAll(re)) {
          hits += 1
          selfHits += 1
          if (m[1] !== p.version) {
            fail('pack/docs', `${name} 的「本包当前版本」声明为 ${m[1]}，与 package.json 的 ${p.version} 不一致（${label}）`)
          }
        }
      }
      if (hits === 0) {
        fail('pack/docs', `${name} 未找到任何「本包当前版本」声明（期望形态：${SELF_VERSION_HINT}）——无法校验其版本自述，拒绝放行`)
      }
    }
    if (failures.length === docsFailBefore) {
      ok(`双语 README 版本一致（EN/ZH 各提及：${enV.join(', ')}），「本包当前版本」声明 = ${p.version}（命中 ${selfHits} 处）`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** 粗粒度但够用的 specifier 提取：from '...' / import('...') / require('...')。 */
function specifiers(src) {
  const found = new Set()
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) for (const m of src.matchAll(re)) found.add(m[1])
  return found
}

// ---------------------------------------------------------------- 入口

const mode = process.argv[2] ?? 'all'
if (!['syntax', 'pack', 'all'].includes(mode)) {
  console.error(`未知模式 ${mode}；用法：node scripts/verify.mjs [syntax|pack|all]`)
  process.exit(EXIT.USAGE)
}

console.log(`dsh-session-toolkit 验证门（mode=${mode}）`)
if (mode !== 'pack') checkSyntax()
if (mode !== 'syntax') checkPack()

console.log('')
for (const n of notes) console.log(`note  ${n}`)
rmSync(LOG_DIR, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`\n失败 ${failures.length} 项：`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(EXIT.FAIL)
}
if (skips.length > 0) {
  console.error('')
  for (const s of skips) console.error(`  - ${s}`)
  console.error(`跳过 ${skips.length} 项 —— 未完成验证（非通过）`)
  process.exit(EXIT.INCOMPLETE)
}
console.log('全部检查通过。')
