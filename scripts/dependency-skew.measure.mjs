#!/usr/bin/env node
/**
 * 依赖解析偏斜量测门（契约表 §F 的验收工具）
 *
 * 判据是**相对**的：不写死任何期望版本，而是让「插件」与「宿主 profile」各自解析同一个包，
 * 比对两条链路的**实际落点**（realpath）与其中的 package.json 版本。硬编码期望版本会把
 * 「基线已漂移」误报成「解析错」——这条教训在 §F 里已经付过一次代价。
 *
 * 为什么需要跨实例判定：`@deepseek-ai/dsh-tools` / `dsh-home-paths` 是 harness 提供的包，
 * 插件不该用一份比宿主更旧的副本（§F 实测：插件侧 0.1.2-rc.1 嵌套副本 vs 宿主 0.1.5）。
 * 版本相同但落点不同（pnpm peer 上下文不同）属「同版本不同实例」，本门如实区分。
 *
 * 用法：
 *   node scripts/dependency-skew.measure.mjs --profile <profile 目录或 profile 的 node_modules 父目录>
 *   node scripts/dependency-skew.measure.mjs --plugin . --host <宿主解析基准目录>
 *   node scripts/dependency-skew.measure.mjs --selftest      # 用临时造物证明本门能报红
 * 默认 --plugin = 本仓库根；--host 缺省等于 --profile；--profile 缺省由 $DSH_HOME 或 ~/.dsh 推导。
 *
 * 退出码：0 = 全部 SAME（含同版本不同实例的 DE-INSTANCE 判定见输出）；1 = 有 SKEW；
 *        3 = 前置条件不成立（目录不存在 / 包无法解析）——未完成验证，不得读作通过；64 = 用法错误。
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXIT = { PASS: 0, FAIL: 1, INCOMPLETE: 3, USAGE: 64 }

// 契约表 §F 登记的三个包（客户端 store/primitives 由 shell 播种，不在此列）。
const PACKAGES = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/schemastery',
]

function usage() {
  console.error('用法：node scripts/dependency-skew.measure.mjs [--plugin <dir>] [--host <dir>] [--profile <dir>] [--selftest]')
}

function resolveFrom(baseDir, spec) {
  const anchor = path.join(baseDir, 'package.json')
  const require = createRequire(existsSync(anchor) ? anchor : path.join(baseDir, 'index.js'))
  try {
    const pkgJson = require.resolve(spec + '/package.json')
    const real = realpathSync(pkgJson)
    const version = JSON.parse(readFileSync(real, 'utf8')).version
    return { ok: true, file: real, dir: path.dirname(real), version }
  } catch (e) {
    return { ok: false, why: e && e.code ? e.code : String(e && e.message ? e.message : e) }
  }
}

/** @returns {{rows: Array<{pkg: string, verdict: string, plugin: object, host: object}>, skew: number, unknown: number}} */
function measure(pluginDir, hostDir) {
  const rows = []
  let skew = 0
  let unknown = 0
  for (const pkg of PACKAGES) {
    const plugin = resolveFrom(pluginDir, pkg)
    const host = resolveFrom(hostDir, pkg)
    let verdict
    if (!plugin.ok || !host.ok) { verdict = 'UNRESOLVED'; unknown += 1 }
    else if (plugin.dir === host.dir) verdict = 'SAME-INSTANCE'
    else if (plugin.version === host.version) verdict = 'DE-INSTANCE'
    else { verdict = 'SKEW'; skew += 1 }
    rows.push({ pkg, verdict, plugin, host })
  }
  return { rows, skew, unknown }
}

function report(result) {
  console.log('依赖解析偏斜量测（契约表 §F）')
  for (const row of result.rows) {
    const p = row.plugin.ok ? `${row.plugin.version}  ${row.plugin.dir}` : `未解析（${row.plugin.why}）`
    const h = row.host.ok ? `${row.host.version}  ${row.host.dir}` : `未解析（${row.host.why}）`
    console.log(`  ${row.verdict.padEnd(14)} ${row.pkg}`)
    console.log(`      插件：${p}`)
    console.log(`      宿主：${h}`)
  }
}

// ------------------------------------------------------------------ 用法解析
const argv = process.argv.slice(2)
const opts = { plugin: ROOT, host: null, profile: null, selftest: false }
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--plugin' || a === '--host' || a === '--profile') {
    if (!argv[i + 1]) { usage(); process.exit(EXIT.USAGE) }
    opts[a.slice(2)] = path.resolve(argv[i + 1])
    i += 1
  } else if (a === '--selftest') {
    opts.selftest = true
  } else if (a === '--help' || a === '-h') {
    usage()
    process.exit(EXIT.PASS)
  } else {
    console.error(`未知参数 ${a}`)
    usage()
    process.exit(EXIT.USAGE)
  }
}

if (opts.selftest) {
  // 只验证**判定逻辑**（不依赖任何已安装的 node_modules，CI 里也能跑）：
  // 两侧各造一棵临时解析树 —— 不同版本必须判 SKEW，同版本不同目录必须判 DE-INSTANCE。
  // 真实偏斜验收走 §D 步骤 7 的 --profile 人工步骤。
  const fakeRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-st-skew-'))
  const writeTree = (name, versions) => {
    const root = path.join(fakeRoot, name)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'probe-' + name, version: '1.0.0' }))
    for (const pkg of PACKAGES) {
      const dir = path.join(root, 'node_modules', ...pkg.split('/'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, version: versions[pkg], main: 'index.js' }))
      writeFileSync(path.join(dir, 'index.js'), 'export default {}\n')
    }
  }
  const base = Object.fromEntries(PACKAGES.map((p) => [p, '9.9.9-probe']))
  const older = Object.fromEntries(PACKAGES.map((p) => [p, '0.0.1-older']))
  writeTree('plugin', base)
  writeTree('host-skew', older)
  writeTree('host-deinstance', base)
  const skewCase = measure(path.join(fakeRoot, 'plugin'), path.join(fakeRoot, 'host-skew'))
  const deCase = measure(path.join(fakeRoot, 'plugin'), path.join(fakeRoot, 'host-deinstance'))
  rmSync(fakeRoot, { recursive: true, force: true })
  const okSkew = skewCase.skew === PACKAGES.length && skewCase.rows.every((r) => r.verdict === 'SKEW')
  const okDe = deCase.skew === 0 && deCase.rows.every((r) => r.verdict === 'DE-INSTANCE')
  console.log(`${okSkew ? 'ok  ' : 'FAIL'}  负向对照：${PACKAGES.length} 个包版本不同 → 全部判 SKEW`)
  console.log(`${okDe ? 'ok  ' : 'FAIL'}  正向对照：同版本不同实例 → 判 DE-INSTANCE（不误报 SKEW）`)
  if (okSkew && okDe) console.log('偏斜判定逻辑成立（含真实 profile 验收命令见 §F）。')
  process.exit(okSkew && okDe ? EXIT.PASS : EXIT.FAIL)
}

if (opts.host === null) {
  if (opts.profile !== null) {
    opts.host = opts.profile
  } else {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const candidate = path.join(home, 'profiles', 'web')
    if (!existsSync(candidate)) {
      console.error(`未完成验证：没有 --host/--profile，且推导不出 profile 目录（${candidate} 不存在）`)
      console.error('  提示：装好的 profile 目录通常是 <DSH_HOME>/profiles/web（里面是本 profile 的 node_modules）。')
      process.exit(EXIT.INCOMPLETE)
    }
    opts.host = candidate
  }
}

for (const [label, dir] of [['插件', opts.plugin], ['宿主', opts.host]]) {
  if (!existsSync(dir)) {
    console.error(`未完成验证：${label}目录不存在 —— ${dir}`)
    process.exit(EXIT.INCOMPLETE)
  }
}

const result = measure(opts.plugin, opts.host)
report(result)
console.log('')
console.log(`SKEW_COUNT=${result.skew}  UNRESOLVED=${result.unknown}`)
if (result.unknown > 0) {
  console.error('未完成验证：有包无法解析（宿主侧缺包会让本门读作"没有偏斜"，不得降级成通过）。')
  process.exit(EXIT.INCOMPLETE)
}
if (result.skew > 0) {
  console.error('存在 SKEW：插件解析到的宿主提供包与宿主自身不是同一版本。')
  console.error('  处置：确认 package.json 的区间是否覆盖宿主版本（注意 prerelease 语义：^0.1.2-alpha.1 匹配不到 0.1.6-alpha.2），')
  console.error('        改区间后必须重启 GUI 再跑本门（区间在安装期生效，不会热更）。')
  process.exit(EXIT.FAIL)
}
console.log('无 SKEW：插件与宿主解析到同一版本（DE-INSTANCE 属同版本不同实例，见 §F 判定）。')
process.exit(EXIT.PASS)
