#!/usr/bin/env node
/**
 * Session log 复刻件漂移探测（契约表 §E「复刻件会随官方 UI 改版漂移」的验收工具）
 *
 * 背景：插件无法 import 其它插件的组件，所以 `conversation.session.header.utilities` 里的官方条目被
 * 遮蔽（priority −1）后，必须在 `conversation.session.header.actions` 里**复刻**一份 UI。复刻件与
 * 官方之间没有任何编译期联系，官方改版只会表现为「我们的按钮还是旧样子」——静默失效。
 *
 * 判据是**双向**的，两侧用同一组契约锚点：
 *   · 官方侧（harness checkout）：slot id / controller provider / inject face / 菜单与文案 / 对话框状态映射；
 *   · 本插件侧（client/client.js）：遮蔽 id / 菜单与图标 / 本地化键 / controller face / 状态映射。
 * 任一侧丢失锚点即 DRIFT（exit 1）。官方升级 DSH 后、或本插件改这两段代码后都应该跑一次。
 *
 * 用法：
 *   node scripts/dsh-log-ui.drift.mjs [--harness <harness 仓库根>] [--plugin <插件根>]
 *   node scripts/dsh-log-ui.drift.mjs --selftest     # 用临时变异副本证明本门能报红
 * 默认 --harness = ../deepseek-harness（相对本仓库根）；--plugin = 本仓库根。
 *
 * 退出码：0 = 两侧锚点齐全；1 = 有 DRIFT；3 = 前置条件不成立（harness 路径/文件缺失）——未完成验证；64 = 用法错误。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXIT = { PASS: 0, FAIL: 1, INCOMPLETE: 3, USAGE: 64 }
const OFFICIAL_DIR = 'packages/session-query/session-log-export/src/client'

/**
 * 图标命名（**两侧共用同一组名字**，因为官方当前用的就是这一组）。
 *
 * 2026-09-22 更正（D 复核，缘起：本门 3 条 DRIFT）：
 *   harness `4937343a5e`（2026-09-17, feat(web): unify the client visual language）把图标名从
 *   `IconXxxOutline<尺寸数>` 改成 `IconXxxOutline{Regular|Medium}`（`ICON_REGULAR_STROKE = 1` /
 *   `ICON_MEDIUM_STROKE = 1.3`；`*Artwork` 保留旧默认 `size`）。⇒ 本门原来写死的 `IconEllipsisOutline16`
 *   在**两侧都已成为死名**：官方 `HeaderAction.tsx` 现在用的是 `IconEllipsisOutlineRegular`，
 *   本插件 `client/client.js` 同步后用的**也是** `…Regular` ⇒ 两侧仍然一致，锚点只需换成新名。
 *   ⚠️ **旧写法是「两个字面量恰好相等」的脆弱代理**：它并不能区分「两侧真的用同一个图标」与
 *   「两侧恰好都写着同一个字符串」。改名的教训是：**这类锚点应锚在"名字所在的那一处调用"上**，
 *   而不是锚在某个具体尺寸后缀上。
 */
const ICON_MENU_ANCHOR_TS = 'IconEllipsisOutlineRegular'
const ICON_MENU_ANCHOR_PLUGIN = 'primitives.' + ICON_MENU_ANCHOR_TS

/**
 * inject face 的**成员**锚点：只锚「官方把 `sessionLogDownload` 这个 store 交给 face」。
 *
 * 2026-09-22 收窄（D 复核）：原锚点是 `'hooks: { sessionLogDownload: controller.store }'`（带右花括号），
 * 官方在同一次改版里**给同一个对象加了一个兄弟属性** ⇒ 现文为
 * `hooks: { sessionLogDownload: controller.store, feedbackAvailable },`。
 * **加兄弟属性不改变被探的耦合**（官方仍是把 controller.store 交出、插件仍接同一个 store），
 * 而带右花括号的写法会把「加属性」误报成 DRIFT ⇒ 锚点收窄到键值本身，去掉右侧花括号。
 * ⚠️ 代价（如实写明）：收窄后本锚**不再**约束 face 的其余形状；`feedbackAvailable` 与 `openFeedback`
 * 是官方新增的能力，本插件**尚未跟随**——那是**语义漂移**，本门当前**探测不到**，另行上报（不在此处断言）。
 */
const ANCHOR_INJECT_FACE_STORE = 'sessionLogDownload: controller.store'

/** 官方侧契约锚点：官方改掉任何一条，我们的复刻件就可能已经过期。 */
const OFFICIAL_ANCHORS = [
  ['index.ts', 'utilities 槽 cell id', "id: 'session-log-download'"],
  ['index.ts', 'controller 服务名', "provide('sessionLogDownload'"],
  ['index.ts', 'inject face（hooks/request/dismiss）', ANCHOR_INJECT_FACE_STORE],
  ['HeaderAction.tsx', '菜单锚点（⋯ 更多操作）', ICON_MENU_ANCHOR_TS],
  ['HeaderAction.tsx', '菜单项文案键', "t('menu.download')"],
  ['Dialog.tsx', '对话框 open 状态映射', 'entry?.open === true'],
  ['controller.ts', 'download(id) 入口', 'download(sessionId'],
]

/** 本插件侧锚点：遮蔽 + 复刻件必须仍然对得上官方那一组。 */
const PLUGIN_ANCHORS = [
  ['client/client.js', '遮蔽 id（同 cell、priority −1）', "id: 'session-log-download'"],
  ['client/client.js', '菜单组件', 'primitives.Menu'],
  ['client/client.js', '菜单锚点图标', ICON_MENU_ANCHOR_PLUGIN],
  ['client/client.js', '菜单项文案键', "t('menu.download')"],
  ['client/client.js', 'controller face', ANCHOR_INJECT_FACE_STORE],
  ['client/client.js', '对话框 open 状态映射', 'entry.open === true'],
]

function readOrNull(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/** @returns {{missing: string[], checked: number}} */
function audit(anchors, resolve) {
  const missing = []
  let checked = 0
  for (const [file, label, needle] of anchors) {
    const text = readOrNull(resolve(file))
    checked += 1
    if (text === null) { missing.push(`${file}：文件缺失（${label}）`); continue }
    if (!text.includes(needle)) missing.push(`${file}：找不到「${label}」锚点 ${JSON.stringify(needle)}`)
  }
  return { missing, checked }
}

function usage() {
  console.error('用法：node scripts/dsh-log-ui.drift.mjs [--harness <dir>] [--plugin <dir>] [--selftest]')
}

const argv = process.argv.slice(2)
const opts = { harness: null, plugin: ROOT, selftest: false }
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--harness' || a === '--plugin') {
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

if (opts.harness === null) {
  const sibling = path.resolve(ROOT, '..', 'deepseek-harness')
  // --selftest 允许没有 harness（此时官方侧用合成锚点）；真实对照才要求 checkout 存在。
  if (!existsSync(sibling) && !opts.selftest) {
    console.error(`未完成验证：推导不出 harness 仓库（${sibling} 不存在），请用 --harness <dir> 指定`)
    process.exit(EXIT.INCOMPLETE)
  }
  opts.harness = sibling
}

function runAgainst(harnessDir, pluginDir, officialDir) {
  const official = audit(OFFICIAL_ANCHORS, (f) => path.join(officialDir, f))
  const plugin = audit(PLUGIN_ANCHORS, (f) => path.join(pluginDir, f))
  return { official, plugin }
}

if (opts.selftest) {
  // 负向对照：把官方 HeaderAction 的菜单锚点删掉 → 官方侧必须报 DRIFT；
  // 把插件侧的菜单文案键删掉 → 插件侧必须报 DRIFT。两份都用临时副本，不动任何真实文件。
  // 没有 harness checkout 时（例如 CI 只 checkout 本插件仓库）用**合成**的官方锚点文本，
  // 只验证探测器逻辑；真实对照仍走 §D 步骤 8 的 --harness 人工验收。
  const realOfficialDir = path.join(opts.harness, OFFICIAL_DIR)
  const hasRealHarness = existsSync(realOfficialDir)
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-st-drift-'))
  let officialDir = realOfficialDir
  if (!hasRealHarness) {
    officialDir = path.join(tmp, 'synthetic-official')
    mkdirSync(officialDir, { recursive: true })
    const contents = {}
    for (const [file, , needle] of OFFICIAL_ANCHORS) {
      contents[file] = (contents[file] || '') + '\n// synthetic anchor\n' + needle + '\n'
    }
    for (const [file, text] of Object.entries(contents)) writeFileSync(path.join(officialDir, file), text)
    console.log('note  未提供 harness checkout：官方侧使用合成锚点文本（只验证探测器逻辑）')
  }
  const pristine = runAgainst(opts.harness, opts.plugin, officialDir)
  const officialCopy = path.join(tmp, 'official')
  cpSync(officialDir, officialCopy, { recursive: true })
  const headerAction = path.join(officialCopy, 'HeaderAction.tsx')
  // ⚠️ 变异必须针对**当前锚点**（2026-09-22）：原来这里写死旧名 `IconEllipsisOutline16`，
  //    换名后这个替换在两侧都成了空操作 —— 官方侧仍会报红（因为锚点已改新名、旧名不存在），
  //    于是负向对照**看起来通过**，但它证明的已不是"改掉锚点会报红"。现改为从锚点常量取。
  writeFileSync(headerAction, readFileSync(headerAction, 'utf8').replace(new RegExp(ICON_MENU_ANCHOR_TS, 'g'), 'IconEllipsisOutlineXX'))
  const pluginCopyDir = path.join(tmp, 'plugin')
  cpSync(path.join(opts.plugin, 'client'), path.join(pluginCopyDir, 'client'), { recursive: true })
  const clientFile = path.join(pluginCopyDir, 'client', 'client.js')
  writeFileSync(clientFile, readFileSync(clientFile, 'utf8').replace(/'menu\.download'/g, "'menu.download.renamed'"))
  const mutated = runAgainst(opts.harness, pluginCopyDir, officialCopy)
  rmSync(tmp, { recursive: true, force: true })

  const okPristine = pristine.official.missing.length === 0 && pristine.plugin.missing.length === 0
  const okOfficialDrift = mutated.official.missing.some((m) => m.includes('菜单锚点'))
  const okPluginDrift = mutated.plugin.missing.some((m) => m.includes('菜单项文案键'))
  console.log(`${okPristine ? 'ok  ' : 'FAIL'}  正向对照：未变异的官方 + 本插件锚点齐全`)
  console.log(`${okOfficialDrift ? 'ok  ' : 'FAIL'}  负向对照：官方菜单锚点改名 → 官方侧报 DRIFT`)
  console.log(`${okPluginDrift ? 'ok  ' : 'FAIL'}  负向对照：插件文案键改名 → 插件侧报 DRIFT`)
  if (okPristine && okOfficialDrift && okPluginDrift) console.log('漂移探测器成立（能报红、且不误报）。')
  process.exit(okPristine && okOfficialDrift && okPluginDrift ? EXIT.PASS : EXIT.FAIL)
}

const officialDir = path.join(opts.harness, OFFICIAL_DIR)
if (!existsSync(officialDir)) {
  console.error(`未完成验证：harness 里找不到 ${officialDir}`)
  process.exit(EXIT.INCOMPLETE)
}

const result = runAgainst(opts.harness, opts.plugin, officialDir)
console.log('Session log 复刻件漂移探测（契约表 §E）')
console.log(`  harness：${opts.harness}`)
console.log(`  插件：${opts.plugin}`)
const missing = [...result.official.missing.map((m) => '[官方] ' + m), ...result.plugin.missing.map((m) => '[插件] ' + m)]

/**
 * 覆盖率提醒（**not note，不是判据，不影响退出码**）。
 *
 * 为什么要有它（D 于 2026-09-22 复核时发现）：本门**只在「锚点文本消失」时报红**，
 * 对「官方在同一次改版里**新增**了能力、而本插件没跟随」是**瞎的**。
 * 实测：官方 `index.ts` 现在一个 inject face 里同时交出 `sessionLogDownload` 与 `feedbackAvailable`
 * （另有 `openFeedback` 回调、`menu.feedback` 文案），而本插件侧这三者**全部 0 命中**——
 * 即"官方左键菜单有 download + feedback 两项，插件只复刻了 download 一项"。
 * 锚点全在，门照样绿 ⇒ 这类**语义漂移**必须由人看，不能读成"复刻件还是对的"。
 * 判据来源：契约表 §E 自己就写着「官方在同一 cell 新增菜单项时还会被遮蔽吞掉」。
 */
const OFFICIAL_ENHANCEMENT_MARKERS = ['feedbackAvailable', 'openFeedback', 'menu.feedback']
try {
  const officialIndex = readFileSync(path.join(officialDir, 'index.ts'), 'utf8')
  const headerAction = readFileSync(path.join(officialDir, 'HeaderAction.tsx'), 'utf8')
  const pluginIndex = readFileSync(path.join(opts.plugin, ...PLUGIN_ANCHORS[0][0].split('/')), 'utf8')
  const notFollowed = OFFICIAL_ENHANCEMENT_MARKERS.filter(
    (k) => officialIndex.includes(k) || headerAction.includes(k),
  ).filter((k) => !pluginIndex.includes(k))
  if (notFollowed.length > 0) {
    console.log('')
    console.log(`note  官方侧另有本插件**未跟随**的能力：${notFollowed.join(' · ')}`)
    console.log('      官方 Session header 菜单现为「download + feedback」两项；本插件复刻件只做了 download。')
    console.log('      ⚠️ 这是**语义漂移**：锚点齐全也照样存在，本门的 13 条锚点探不到它（不把它算成 FAIL，')
    console.log('         因为"跟随官方新增能力"属**新决定**，不是本门的验收面）。⇒ 需要人决定是否跟随。')
  }
} catch {
  // note 是增值信息，读不到就跳过——不得让它影响本门的退出码
}

if (missing.length === 0) {
  console.log(`锚点齐全：官方 ${result.official.checked} 条 + 插件 ${result.plugin.checked} 条。`)
  process.exit(EXIT.PASS)
}
console.error(`DRIFT：${missing.length} 条锚点缺失。`)
for (const m of missing) console.error(`  - ${m}`)
console.error('  处置：对照官方最新实现同步 client/client.js 的 log-reposition 模块，或确认本插件侧的遮蔽策略仍然成立。')
process.exit(EXIT.FAIL)
