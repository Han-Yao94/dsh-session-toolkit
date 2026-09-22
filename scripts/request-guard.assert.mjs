#!/usr/bin/env node
/**
 * 门：`lib/request-guard.js`（本插件自有 HTTP 路由的 Origin 守卫）的**行为 + 自证**。
 *
 * ── 它证什么、不证什么（**不许把推断读成端到端**）────────────────────────────
 * ✅ 能证：**判定函数对给定输入返回预期结果**（`isSameOriginRequest` 的返回值与 reason），
 *          以及**把真 `originGuard` 挂到临时 HTTP 服务器后，状态码/响应体/响应头符合判定**。
 * ❌ 不证：**「真实浏览器的跨域请求被拦」与「真实 DNS rebinding 被拦」**。本机零浏览器自动化、
 *          没有第二个 origin、没有可控 DNS ⇒ 那两件事**是推断，不是验证**。
 *          本门里所有 HTTP 都是打**自己起的临时服务器**，**从不碰活端口**（见 §纪律）。
 *
 * ── 为什么要有这道门（2026-09-22，D 提出、人类所有者批准）────────────────────
 * 这道守卫的负向对照原来住在 `${TMPDIR}/sa-verify/` ⇒ **随临时目录消失** ⇒
 * 「谁把 `bindHost !== ALL_INTERFACES_BIND` 翻回等值判断就报红」那条常驻断言
 * **将来守不住任何东西**：`lib/request-guard.js` 此后被改动，没有任何自动门会红。
 * 本门就是把那套装置落成持久件（`scripts/**` 属 D 的族）。
 *
 * ── 结构：正向对照 + 变异对照（含两条自保）──────────────────────────────────
 * 正向：`lib/request-guard.js` 的判定与真实输出对照一组**自带期望值**的用例。
 * 变异：对源码做**受控破坏**，断言破坏后**正好**翻掉声明的那一批用例。
 *   ⭐ 自保 ①**变异未生效即判失败**：任何 `mutate` 若不改变源码 ⇒ 报红，**不许静默跳过**。
 *      （反面教材：锚点写成旧签名/旧条件文本时，`replace` 变成空操作，
 *        "负向对照通过"其实是**什么都没测**。）
 *   ⭐ 自保 ②**未被点名的用例必须保持原状**：若某变异连带翻转了未点名项 ⇒ 报红。
 *      能说清因果的连带 = **耦合**，必须在 `flips` 里显式登记（并写明机制）；
 *      说不清因果的连带 = **故障**。两者只差一步，所以规则是"必须显式"。
 *
 * ── 纪律 ───────────────────────────────────────────────────────────────────
 * · **只读被测对象**：`lib/**` 属 B，本门不写它；变异一律在 `os.tmpdir()` 的副本上做。
 * · **严禁对活端口发任何请求**（含只读的）——本门只用纯函数 + 自起的临时服务器。
 * · **两种绑定模式都跑到**（`127.0.0.1` 与 `0.0.0.0`），不写成只测本机那一种。
 * · 退出码照本项目口径：0 通过 · 1 缺陷 · 64 用法/前置错误（**刻意不用 2**）。
 *
 * 用法：node scripts/request-guard.assert.mjs [--selftest] [--target <path>] [--verbose]
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXIT = { PASS: 0, FAIL: 1, USAGE: 64 }
const DEFAULT_TARGET = 'lib/request-guard.js'

/** 与 `WebServer.host` 同一取值域（`packages/host/webserver/src/index.ts:61`）。 */
const LOOPBACK = '127.0.0.1'
const ALL_INTERFACES = '0.0.0.0'
/** 第三个绑定值：只在本门里用来证明"非这两个字面量时守卫仍然施加"（当前内核不可达）。 */
const THIRD_BIND = '10.0.0.1'

const usage = (out = console.error) => {
  out('用法：node scripts/request-guard.assert.mjs [--selftest] [--target <path>] [--verbose]')
  out('')
  out('  --selftest       对源码做受控变异，自证本门会报红（副本在 os.tmpdir()，工作区零写入）')
  out('  --target <path>  被测文件，默认 lib/request-guard.js（相对仓库根解析）')
  out('  --verbose        打印每条用例的读数（默认只打印分组统计与失败项）')
  out('  --help           打印本帮助')
  out('')
  out('本门证什么：判定函数对给定输入返回预期结果 + 真 HTTP 服务器挂真守卫后的状态码。')
  out('本门**不**证：真实浏览器的跨域/rebinding 被拦（零浏览器自动化、无第二 origin、无可控 DNS）。')
  out('纪律：只读被测对象；**不对活端口发任何请求**；两种绑定模式都跑到。')
  out('')
  out('退出码：0 通过 · 1 缺陷 · 64 用法/前置错误（刻意不用 2）')
}

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) { usage(console.log); process.exit(EXIT.PASS) }
let selftest = false
let verbose = false
let targetArg = null
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--selftest') selftest = true
  else if (a === '--verbose') verbose = true
  else if (a === '--target') { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) { console.error('`--target` 缺少路径'); usage(); process.exit(EXIT.USAGE) } targetArg = v; i += 1 }
  else { console.error(`未知参数：${a}`); usage(); process.exit(EXIT.USAGE) }
}

const TARGET = targetArg ? path.resolve(ROOT, targetArg) : path.join(ROOT, DEFAULT_TARGET)
let src
try {
  src = readFileSync(TARGET, 'utf8')
} catch (e) {
  console.error(`❌ 读不到被测文件：${TARGET}（${e.code ?? e.message}）`)
  console.error('   前置条件不满足 ⇒ 按 §5.2 走 64，不走 1。**不要当作通过。**')
  process.exit(EXIT.USAGE)
}
const TARGET_REL = path.relative(ROOT, TARGET) || TARGET

// ─────────────────────────────────────────────────────────── 用例集
// [名称, headers, bindHost(undefined=不传), 期望 ok, 期望 reason]
// 覆盖：四种输入 × 两种绑定模式 + 栅栏 A 各格 + 栅栏 B 取值面 + 谓词 + 缺省 fail-closed
const CASES = [
  // ── 判据 1：四种输入必须齐（两种绑定模式各跑一遍）
  ['①外来 Origin（loopback 绑定）', { host: '127.0.0.1:3080', origin: 'http://evil.example' }, LOOPBACK, false, 'origin-mismatch'],
  ['①外来 Origin（0.0.0.0 绑定）', { host: '127.0.0.1:3080', origin: 'http://evil.example' }, ALL_INTERFACES, false, 'origin-mismatch'],
  ['①外来 Origin + 外来端口', { host: '127.0.0.1:3080', origin: 'http://evil.example:9999' }, LOOPBACK, false, 'origin-mismatch'],
  ['②Origin: null 小写', { host: '127.0.0.1:3080', origin: 'null' }, LOOPBACK, false, 'origin-null'],
  ['②Origin: NULL 大写', { host: '127.0.0.1:3080', origin: 'NULL' }, LOOPBACK, false, 'origin-null'],
  ['②Origin 空串', { host: '127.0.0.1:3080', origin: '' }, LOOPBACK, false, 'origin-null'],
  ['③无 Origin（有 Host）', { host: '127.0.0.1:3080' }, LOOPBACK, true, 'no-origin'],
  ['③无 Origin（0.0.0.0 绑定）', { host: '192.168.1.50:3080' }, ALL_INTERFACES, true, 'no-origin'],
  // ⚠️ **"无 Origin ⇒ 放行"以"有合法 Host"为前提**：栅栏 A 的 no-host 判定先落 ⇒
  //    `req={}` / `{headers:{}}` / `host:''` 三者都拒 `no-host`（实测，见交付文本）。
  //    只有当 Host 合法（loopback 绑定下须是 loopback 字面量）且无 Origin 时才是 `no-origin`。
  ['③无 Origin（Host 合法）⇒ 放行', { host: '127.0.0.1:3080' }, LOOPBACK, true, 'no-origin'],
  ['③无 Origin 但 Host 为空串 ⇒ 拒 no-host', { host: '' }, LOOPBACK, false, 'no-host'],
  ['③无 Origin 且 headers 为空对象 ⇒ 拒 no-host', {}, LOOPBACK, false, 'no-host'],
  ['③req 整个缺 headers 字段 ⇒ 拒 no-host', undefined, LOOPBACK, false, 'no-host'],
  ['④同源 带端口（loopback）', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, LOOPBACK, true, 'same-origin'],
  ['④同源 带端口（0.0.0.0）', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, ALL_INTERFACES, true, 'same-origin'],
  ['④同源 不带端口', { host: 'localhost', origin: 'http://localhost' }, LOOPBACK, true, 'same-origin'],
  ['④同源 显式默认端口 :80（两侧）', { host: 'localhost:80', origin: 'http://localhost:80' }, LOOPBACK, true, 'same-origin'],
  ['④同源 大小写混合', { host: 'LOCALHOST:3080', origin: 'http://LocalHost:3080' }, LOOPBACK, true, 'same-origin'],

  // ── 判据 3：栅栏 A 的核心格（rebinding 形态）
  ['A1 loopback 绑定 + Host: evil.com:3080（rebinding）', { host: 'evil.com:3080', origin: 'http://evil.com:3080' }, LOOPBACK, false, 'host-not-loopback'],
  ['A1b loopback 绑定 + Host: evil.com（无端口）', { host: 'evil.com', origin: 'http://evil.com' }, LOOPBACK, false, 'host-not-loopback'],
  ['A1c loopback 绑定 + Host: evil.com + sec-fetch-site: same-origin（栅栏 B 挡不住它）', { host: 'evil.com:3080', origin: 'http://evil.com:3080', 'sec-fetch-site': 'same-origin' }, LOOPBACK, false, 'host-not-loopback'],
  ['A2 Host: 127.0.0.1:3080 ⇒ 放行', { host: '127.0.0.1:3080' }, LOOPBACK, true, 'no-origin'],
  ['A2b Host: 127.0.0.5:3080（127/8 全段）⇒ 放行', { host: '127.0.0.5:3080' }, LOOPBACK, true, 'no-origin'],
  ['A2c Host: [::1]:3080 ⇒ 放行', { host: '[::1]:3080' }, LOOPBACK, true, 'no-origin'],
  ['A4 前缀陷阱 Host: 127.0.0.1.evil.com ⇒ 拒', { host: '127.0.0.1.evil.com:3080' }, LOOPBACK, false, 'host-not-loopback'],
  ['A5 缺 Host ⇒ 拒', { origin: 'http://127.0.0.1:3080' }, LOOPBACK, false, 'no-host'],

  // ── 判据 2：0.0.0.0 下不得施加 loopback 限制（局域网正当客户端必须放行 = 残余限制第 1 条的用例证据）
  ['B1 0.0.0.0 + LAN IP 自洽 ⇒ 放行', { host: '192.168.1.50:3080', origin: 'http://192.168.1.50:3080' }, ALL_INTERFACES, true, 'same-origin'],
  ['B1b 0.0.0.0 + LAN 主机名自洽 ⇒ 放行', { host: 'mybox.local:3080', origin: 'http://mybox.local:3080' }, ALL_INTERFACES, true, 'same-origin'],
  ['B2 0.0.0.0 + evil 域自洽 ⇒ 放行（残余限制：无"名字"可判别）', { host: 'evil.com:3080', origin: 'http://evil.com:3080' }, ALL_INTERFACES, true, 'same-origin'],
  ['B3 0.0.0.0 + Origin≠Host ⇒ 拒', { host: 'evil.com:3080', origin: 'http://other.example' }, ALL_INTERFACES, false, 'origin-mismatch'],
  ['B4 0.0.0.0 + 缺 Host ⇒ 拒', { origin: 'http://x.example' }, ALL_INTERFACES, false, 'no-host'],
  ['B5 0.0.0.0 + 畸形 Host 与畸形 Origin ⇒ 拒（先落 Origin 解析失败）', { host: 'bad host', origin: 'http://bad host' }, ALL_INTERFACES, false, 'origin-unparsable'],
  ['B5b 0.0.0.0 + 畸形 Host + 合法但不同的 Origin ⇒ 拒', { host: 'bad host', origin: 'http://evil.example' }, ALL_INTERFACES, false, 'origin-mismatch'],
  ['B6 0.0.0.0 + 端口不匹配 ⇒ 拒', { host: '127.0.0.1:9090', origin: 'http://127.0.0.1:3080' }, ALL_INTERFACES, false, 'origin-mismatch'],

  // ── 第三条绑定值（*≠* 这两个字面量时守卫必须仍然**施加**）
  ['D1 第三条绑定值 + rebinding ⇒ 拒（改前是放行 = fail-open）', { host: 'evil.com:3080', origin: 'http://evil.com:3080' }, THIRD_BIND, false, 'host-not-loopback'],
  ['D2 第三条绑定值 + LAN 自洽 ⇒ 也拒（代价照实：该部署下局域网客户端被拒）', { host: '192.168.1.50:3080', origin: 'http://192.168.1.50:3080' }, THIRD_BIND, false, 'host-not-loopback'],
  ['D3 第三条绑定值 + 真 loopback Host ⇒ 放行', { host: '127.0.0.1:3080' }, THIRD_BIND, true, 'no-origin'],
  ['D4 不传 bindHost + rebinding ⇒ 拒（fail-closed 缺省）', { host: 'evil.com:3080', origin: 'http://evil.com:3080' }, undefined, false, 'host-not-loopback'],
  ['D5 不传 bindHost + 同源 ⇒ 放行', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, undefined, true, 'same-origin'],
  ['D6 bindHost 空串 ⇒ 按 loopback（fail-closed）', { host: 'evil.com:3080', origin: 'http://evil.com:3080' }, '', false, 'host-not-loopback'],

  // ── 判据 6：栅栏 B 的取值面
  ['C1 sec-fetch-site: cross-site ⇒ 拒', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }, LOOPBACK, false, 'sec-fetch-site-cross-site'],
  ['C1b CROSS-SITE 大写 ⇒ 拒', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'CROSS-SITE' }, LOOPBACK, false, 'sec-fetch-site-cross-site'],
  ['C1c "  cross-site " 带空白 ⇒ 拒', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': '  cross-site  ' }, LOOPBACK, false, 'sec-fetch-site-cross-site'],
  ['C2 缺失 sec-fetch-site ⇒ 放行', { host: '127.0.0.1:3080' }, LOOPBACK, true, 'no-origin'],
  ['C3 same-origin ⇒ 放行', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }, LOOPBACK, true, 'same-origin'],
  ['C3b same-site ⇒ 放行（它正是 rebinding 的形态，拒了会误伤本机正当访问）', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-site' }, LOOPBACK, true, 'same-origin'],
  ['C3c none ⇒ 放行', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'none' }, LOOPBACK, true, 'same-origin'],
  ['C3d 未知取值 foo ⇒ 放行（不做白名单）', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'foo' }, LOOPBACK, true, 'same-origin'],
]

/** 名字 → [headers, bindHost, 期望 ok, 期望 reason] */
const BY_NAME = new Map(CASES.map(([n, h, b, ok, r]) => [n, { h, b, ok, r }]))

// ─────────────────────────────────────────────────────────── 变异集
// 每条变异声明 `flips`：名称 → 破坏后**应有**的 ok 值。未点名的用例必须保持原值。
// `expectInert: true` 表示"这条变异不应改变任何用例的判定"（用于负向验自保②）。
const MUTANTS = [
  {
    label: '去掉「绑定模式条件化」（栅栏 A 变成无条件施加）',
    // ⚠️ 锚**结构**而非条件文本：条件文本（含变量名与运算符）一改，字面量锚就失配。
    //    代价：条件被重写时本锚也会失配 ⇒ **靠自保①（变异未生效即判失败）兜住**。
    mutate: (s) => s.replace(/^ {2}if \([^\n]*\) \{$/m, '  if (true) {'),
    flips: {
      // ⚠️ 本表**只列实际翻转**的条目。写宽了的代价就是本门自己的"不承载信息"检查会报红
      //    （这正是裁定采纳的那条判据：一条永远不承载信息的期望 = 噪声）。
      //    实测：0.0.0.0 下的 B3 / B4 / B5 / B6 / ①外来 Origin / ④同源 在这条变异下**不翻**
      //    （它们由规则 1 / no-host / Origin 解析各自拒绝，根本不经过栅栏 A）。
      '③无 Origin（0.0.0.0 绑定）': false,
      'B1 0.0.0.0 + LAN IP 自洽 ⇒ 放行': false,
      'B1b 0.0.0.0 + LAN 主机名自洽 ⇒ 放行': false,
      'B2 0.0.0.0 + evil 域自洽 ⇒ 放行（残余限制：无"名字"可判别）': false,
    },
  },
  {
    label: '把条件翻回等值判断（回归到 bindHost === LOOPBACK_BIND）',
    // 这正是裁定 #11-① 修掉的 fail-open：第三条绑定值会**整个跳过**栅栏 A。
    mutate: (s) => s.replace('if (bindHost !== ALL_INTERFACES_BIND) {', 'if (bindHost === LOOPBACK_BIND) {'),
    flips: {
      // 只此一条：另两个被点过的名（A1 / B2）在这条变异下**实测与原值相同**（不承载信息），
      // 已按裁定从期望里删除 —— 一条永远不承载信息的期望，与一条永远为真的断言一样是噪声。
      'D1 第三条绑定值 + rebinding ⇒ 拒（改前是放行 = fail-open）': true,
      'D2 第三条绑定值 + LAN 自洽 ⇒ 也拒（代价照实：该部署下局域网客户端被拒）': true,
    },
  },
  {
    label: '去掉 loopback 判定（Host 不再要求是 loopback）',
    mutate: (s) => s.replace("    if (!isLoopbackHostname(hostUrl.hostname)) return { ok: false, reason: 'host-not-loopback' }\n", ''),
    flips: {
      'A1 loopback 绑定 + Host: evil.com:3080（rebinding）': true,
      'A1b loopback 绑定 + Host: evil.com（无端口）': true,
      'A1c loopback 绑定 + Host: evil.com + sec-fetch-site: same-origin（栅栏 B 挡不住它）': true,
      'A4 前缀陷阱 Host: 127.0.0.1.evil.com ⇒ 拒': true,
      'D1 第三条绑定值 + rebinding ⇒ 拒（改前是放行 = fail-open）': true,
      'D2 第三条绑定值 + LAN 自洽 ⇒ 也拒（代价照实：该部署下局域网客户端被拒）': true,
      'D4 不传 bindHost + rebinding ⇒ 拒（fail-closed 缺省）': true,
      'D6 bindHost 空串 ⇒ 按 loopback（fail-closed）': true,
    },
  },
  {
    label: '去掉栅栏 B（sec-fetch-site 的 cross-site 拒）',
    mutate: (s) => s.replace("  if (secFetchSite === 'cross-site') return { ok: false, reason: 'sec-fetch-site-cross-site' }\n", ''),
    flips: {
      'C1 sec-fetch-site: cross-site ⇒ 拒': true,
      'C1b CROSS-SITE 大写 ⇒ 拒': true,
      'C1c "  cross-site " 带空白 ⇒ 拒': true,
    },
  },
  {
    label: '把栅栏 B 的判据换成"只拒 safe"（cross-site 反被放过）',
    // 这条与上一条互补：上一条证"能拒"，这条证"取值面没被整体放宽/收紧"。
    mutate: (s) => s.replace("if (secFetchSite === 'cross-site') return", "if (secFetchSite === 'safe') return"),
    flips: {
      'C1 sec-fetch-site: cross-site ⇒ 拒': true,
      'C1b CROSS-SITE 大写 ⇒ 拒': true,
      'C1c "  cross-site " 带空白 ⇒ 拒': true,
    },
  },
  {
    label: '让 loopback 谓词恒真（等于没有栅栏 A）',
    mutate: (s) => s.replace('export function isLoopbackHostname(hostname) {', 'export function isLoopbackHostname(hostname) {\n  return true'),
    flips: {
      'A1 loopback 绑定 + Host: evil.com:3080（rebinding）': true,
      'A1b loopback 绑定 + Host: evil.com（无端口）': true,
      'A1c loopback 绑定 + Host: evil.com + sec-fetch-site: same-origin（栅栏 B 挡不住它）': true,
      'A4 前缀陷阱 Host: 127.0.0.1.evil.com ⇒ 拒': true,
      'D1 第三条绑定值 + rebinding ⇒ 拒（改前是放行 = fail-open）': true,
      'D2 第三条绑定值 + LAN 自洽 ⇒ 也拒（代价照实：该部署下局域网客户端被拒）': true,
      'D4 不传 bindHost + rebinding ⇒ 拒（fail-closed 缺省）': true,
      'D6 bindHost 空串 ⇒ 按 loopback（fail-closed）': true,
    },
  },
  {
    // ⭐ 自保②的**装置自测**：这条变异改的是**注释文本**（语义不变）⇒ 任何用例都不该翻转。
    //    若它翻转了任何用例，说明本门的"变异 → 用例"映射或用例集本身有问题。
    label: '【自保②自测】只改注释（语义不变）⇒ 一个用例都不许翻转',
    mutate: (s) => s.replace('// request-guard —', '// request-guard —（本注释被本门自测替换，语义不变）'),
    flips: {},
    expectInert: true,
  },
]

// ─────────────────────────────────────────────────────────── 判定
const runCases = (mod) => {
  const out = new Map()
  for (const [name, headers, bindHost] of CASES) {
    const req = headers === undefined ? {} : { method: 'POST', headers }
    const v = bindHost === undefined
      ? mod.isSameOriginRequest(req)
      : mod.isSameOriginRequest(req, { bindHost })
    out.set(name, v)
  }
  return out
}

const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'dsh-st-reqguard-'))
const loadCopy = async (source, tag) => {
  const p = path.join(tmpdir, `${tag}.mjs`)
  writeFileSync(p, source)
  return await import(`${pathToFileURL(p).href}?t=${Math.random()}`)
}

console.log('「request-guard Origin 守卫」门（request-guard.assert.mjs）')
console.log(`  仓库根    ${ROOT}`)
console.log(`  被测文件  ${TARGET_REL}  （只读；变异在 os.tmpdir() 副本上做）`)
console.log(`  用例数    ${CASES.length}（两种绑定模式都跑到）`)
console.log('  证什么    判定函数对给定输入返回预期结果 + 真 HTTP 服务器挂真守卫后的状态码')
console.log('  不证什么  真实浏览器的跨域/rebinding 被拦（零浏览器自动化、无第二 origin、无可控 DNS）')
console.log('')

let failures = 0
const fail = (msg) => { failures += 1; console.error(`  RED  ${msg}`) }

// ── 正向：真实文件必须全绿
const real = await loadCopy(src, 'real')
const base = runCases(real)
const baseBad = []
for (const [name, headers, bindHost, wantOk, wantReason] of CASES) {
  const v = base.get(name)
  const ok = v.ok === wantOk && v.reason === wantReason
  if (!ok) baseBad.push(`${name} ⇒ 实测 ok=${v.ok} reason=${v.reason}（期望 ok=${wantOk} ${wantReason}）`)
  if (verbose) console.log(`  ${ok ? 'ok  ' : 'RED '} ${name.padEnd(58)} ok=${String(v.ok).padEnd(5)} ${v.reason}`)
}
console.log(`[1/4] 正向对照：${CASES.length - baseBad.length}/${CASES.length} 符合期望`)
for (const b of baseBad) fail(`正向：${b}`)

// ── 结构断言（补在行为断言之外：那两处"必须如此"的形态）
console.log(`[2/${selftest ? 4 : 3}] 结构断言`)
const structural = [
  ['栅栏 A 的条件是 `!== ALL_INTERFACES_BIND`（不是等值特化）', /if \(bindHost !== ALL_INTERFACES_BIND\) \{/.test(src)],
  ['谓词 `isLoopbackHostname` 在文件里只有**一个**调用点，且落在栅栏 A 的块内', (() => {
    const calls = src.split('\n').filter((l) => l.includes('isLoopbackHostname(') && !l.includes('export function') && !l.startsWith(' *'))
    return calls.length === 1 && /host-not-loopback/.test(calls[0])
  })()],
  ['栅栏 B 的注释写明它**不是** rebinding 的解药', /堵不住 DNS rebinding|不是 rebinding 的解药|别把这一行当 rebinding/.test(src)],
  ['`LOOPBACK_BIND` 与 `ALL_INTERFACES_BIND` 均被导出', /export const LOOPBACK_BIND/.test(src) && /export const ALL_INTERFACES_BIND/.test(src)],
]
for (const [name, ok] of structural) {
  if (!ok) fail(`结构：${name}`)
  console.log(`  ${ok ? 'ok  ' : 'RED '} ${name}`)
}

// ── 变异对照（含两条自保）——**只在 --selftest 下跑**
// 为什么：正向对照证明"实现按契约工作"；变异对照证明"本门真的会红"。
// 前者每次跑，后者是自证（照 clamp-call / primitives-export 的既有约定）。
if (selftest) {
console.log(`[3/4] 变异对照（--selftest）：${MUTANTS.length} 条变异（未生效即判失败）`)
// ⭐ 两条自保**抽成可被直接调用的函数**，再用合成变异自证（避免自耦：自证不依赖本门的真实源）
const checkMutant = (source, baseVerdicts, m) => {
  const mutated = m.mutate(source)
  // 自保①：变异未生效 ⇒ 不通过（**不许静默跳过**）
  if (mutated === source) return { applied: false, flipped: [], undeclared: [], dead: [] }
  return { applied: true, mutated }
}
const applyMutant = async (m, { silent = false } = {}) => {
  const mutated = m.mutate(src)
  if (mutated === src) { if (!silent) fail(`「${m.label}」变异未生效（锚点失配）—— 视为失败，不许静默跳过`); return null }
  const got = runCases(await loadCopy(mutated, 'm'))
  const flipped = []
  const undeclared = []
  for (const [name] of CASES) {
    const before = base.get(name).ok
    const after = got.get(name).ok
    if (before === after) continue
    flipped.push(name)
    if (!Object.prototype.hasOwnProperty.call(m.flips, name)) undeclared.push(`${name}（${before} → ${after}）`)
  }
  const dead = Object.keys(m.flips).filter((n) => !flipped.includes(n))
  if (!silent) {
    for (const u of undeclared) fail(`「${m.label}」**连带翻转了未点名的用例**：${u}`)
    if (dead.length > 0) fail(`「${m.label}」点名了但不生效的期望（不承载信息）：${dead.join(' · ')}`)
    if (m.expectInert && flipped.length > 0) fail(`「${m.label}」本应完全惰性，却翻转了 ${flipped.length} 条`)
  }
  return { flipped, undeclared, dead }
}

// ⭐ 自保①的**装置自证**（合成输入，不碰真实源）：
//    若变异未生效 ⇒ 检查器必须报 applied=false（调用方据此判失败）。
{
  const inertMutant = { label: '合成：锚失配（mutate 恒等）', mutate: (x) => x, flips: {} }
  const r = checkMutant(src, null, inertMutant)
  const ok = r.applied === false
  if (!ok) fail('自保①自证：变异未生效时检查器却报 applied=true ⇒ 会出现"静默跳过"')
  console.log(`  ${ok ? 'ok  ' : 'RED '} 自保①自证：变异未生效（mutate 恒等）⇒ 检查器报 applied=false（调用方判失败）`)
}
// ⭐ 自保②的**装置自证**：无声明却翻转 ⇒ 必须进 undeclared
{
  // 诱饵：与真实变异同形（去掉栅栏 B），但**声明为空** ⇒ 检查器必须把它翻掉的三条记为 undeclared。
  const decoy = { label: '合成：生效但无任何声明', mutate: (x) => x.replace("  if (secFetchSite === 'cross-site') return { ok: false, reason: 'sec-fetch-site-cross-site' }\n", ''), flips: {} }
  const rr = await applyMutant(decoy, { silent: true })
  const ok = rr !== null && rr.undeclared.length > 0
  if (!ok) fail('自保②自证：无声明翻转却没被记为 undeclared ⇒ 未点名项无人守')
  console.log(`  ${ok ? 'ok  ' : 'RED '} 自保②自证：合成变异无声明却翻转 ${rr ? rr.undeclared.length : 0} 条 ⇒ 全部被记为"未点名翻转"`)
}

let inertChecked = false
for (const m of MUTANTS) {
  const r = await applyMutant(m)
  if (r === null) continue
  if (m.expectInert) inertChecked = true
  const ok = r.undeclared.length === 0 && r.dead.length === 0
  console.log(`  ${ok ? 'ok  ' : 'RED '} ${m.label}`)
  console.log(`        翻转 ${r.flipped.length} 条：${r.flipped.slice(0, 4).join(' · ')}${r.flipped.length > 4 ? ` …（共 ${r.flipped.length}）` : ''}`)
}
if (!inertChecked) fail('自保②自测缺失：没有一条"应完全惰性"的变异')
} else {
  console.log(`[3/4] 变异对照：**已跳过**（加 --selftest 跑 ${MUTANTS.length} 条变异，自证本门会红）`)
}

// ── 真 HTTP 薄层（临时服务器，**从不碰活端口**）
console.log(`[${selftest ? 4 : 3}/${selftest ? 4 : 3}] 薄层：把真 \`originGuard\` 挂到临时 HTTP 服务器（127.0.0.1，随机端口）`)
const httpCases = [
  ['同源 ⇒ 200 到 handler', { host: null, origin: null }, 200],
]
{
  const server = createServer((req, res) => {
    if (!real.originGuard(req, res, LOOPBACK)) return
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, reached: 'handler' }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const call = (headers) => new Promise((resolve) => {
    const req = createServer
    import('node:http').then(({ request }) => {
      const rq = request({ host: '127.0.0.1', port, path: '/x', method: 'GET', headers, setHost: false }, (rs) => {
        let body = ''
        rs.on('data', (d) => { body += d })
        rs.on('end', () => resolve({ status: rs.statusCode, body, headers: rs.headers }))
      })
      rq.on('error', (e) => resolve({ status: 0, body: String(e.message), headers: {} }))
      rq.end()
    })
  })
  const probes = [
    ['薄层：同源 Host+Origin ⇒ 200 且到 handler', { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }, 200],
    ['薄层：rebinding 形态（Host=evil.com）⇒ 403', { host: 'evil.com:3080', origin: 'http://evil.com:3080' }, 403],
    ['薄层：Origin: null ⇒ 403', { host: `127.0.0.1:${port}`, origin: 'null' }, 403],
    ['薄层：无 Origin ⇒ 200', { host: `127.0.0.1:${port}` }, 200],
    ['薄层：重复 Origin（Node 合并成 "a, b"）⇒ 403', { host: `127.0.0.1:${port}`, origin: 'http://a.example, http://b.example' }, 403],
  ]
  for (const [name, headers, want] of probes) {
    const r = await call(headers)
    const ok = r.status === want
    if (!ok) fail(`${name} ⇒ 实测 HTTP ${r.status}`)
    console.log(`  ${ok ? 'ok  ' : 'RED '} ${name}（HTTP ${r.status}）`)
    if (r.status === 403 && /access-control-allow-origin/i.test(JSON.stringify(r.headers))) {
      fail(`${name}：403 响应带着 CORS 头 ⇒ 跨域页面能读到响应（本门要求无）`)
    }
  }
  server.close()
  httpCases.length = 0
}

rmSync(tmpdir, { recursive: true, force: true })

console.log('')
if (failures === 0) {
  console.log(selftest
    ? `✅ 通过：${CASES.length} 条用例全绿 · ${structural.length} 条结构断言全绿 · ${MUTANTS.length} 条变异各自"正好"翻掉声明的那批 · 两条自保（未生效即失败 / 未点名须原状）各有装置自测`
    : `✅ 通过：${CASES.length} 条用例全绿 · ${structural.length} 条结构断言全绿 · （变异对照未跑：加 --selftest）`)
  console.log('   （副本已删；工作区零写入；未对活端口发任何请求）')
  process.exit(EXIT.PASS)
}
console.error(`❌ 失败 ${failures} 项 —— 被测实现与守卫契约不符，或本门的自保（变异未生效 / 未点名却翻转）被抓。`)
process.exit(EXIT.FAIL)
