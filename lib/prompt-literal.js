// 插件自有系统提示词段的「按字面渲染」保障。
//
// 背景：DSH 0.1.6 之前，systemPrompt 的每个段落在 renderPrompt 时都会被无条件插值，
// 文本里出现 `{{name}}` 而变量表里没有该名字就会抛错，导致该会话整轮组装失败。
// 0.1.6 起 PromptSection 支持 `interpolate: false`（assemble 会把该标记带进
// AssembledSection，renderPrompt 对 interpolate === false 的段完全跳过插值），
// 是官方提供、且不篡改用户文本的解法。
//
// 本模块是旧内核的兼容兜底：段落注册时已声明 interpolate: false；若组装结果里
// 该标记不存在（说明内核不认识这个字段），才把文本里的 `{` 连续串空格化，
// 换取「不抛错」。新内核上本模块一个字符都不改。
import { sanitize } from './sanitize.js'

export const inject = ['systemPrompt']

// 只处理插件自有段；harness 自有段（harness:identity / deployment:persona / 工具段）不碰。
//
// 登记判据（唯一）：该段在**注册时**声明了 `interpolate: false`。
// 全集求法（锚定行首可选空白 ⇒ 只命中代码、跳过注释；宽松写法会命中注释自身、含本行）：
//   grep -rnE "^[[:space:]]*interpolate: false" lib/   ⇒ 2026-10-01 实测 5 处
// 新增插件自有段时，只需在下面这一处补一个段名 —— 旧内核不认 `interpolate` 字段、会把标记丢掉，
// 这份名单就是它「该对谁做兜底」的**唯一依据**；漏登记 ⇒ 该段在旧内核上静默失去按字面渲染的保障
// （0.1.6+ 新内核不受影响，它自己认标记）。
//
// 清单现状（2026-10-01 核，5 处声明；后两个由 #ocr-B-1 补入，此前漏登记）：
//   session-identity       ← lib/identity.js      （声明处：`name: 'session-identity'`）
//   global-prompt          ← lib/global-prompt.js （声明处：`name: 'global-prompt'`）
//   workspace-prompt       ← lib/global-prompt.js （声明处：`name: 'workspace-prompt'`）
//   group-prompt           ← lib/global-prompt.js （声明处：`name: 'group-prompt'`）          ← 原缺
//   peer-inbox-discipline  ← lib/peer-message.js  （声明处：`name: DISCIPLINE_SECTION_NAME`）← 原缺
// 行号随编辑漂移，核验请用上面括号里的**记号名**（grep 该记号即可定位；不写死行号，避免注释随源码过期）。
const LITERAL_SECTIONS = new Set([
  'session-identity',
  'global-prompt',
  'workspace-prompt',
  'group-prompt',
  'peer-inbox-discipline',
])

export function apply(ctx) {
  // S-3：兼容兜底路径会**改写用户文本**（把 `{` 连续串空格化）。改写本身是刻意的，
  // 但旧实现是静默的 —— 用户只看到文本变了、不知道是谁改的、更不知道换掉它要做什么。
  // 改为一次 console.warn（与 lib/identity.js 的同类「静默改写」先例同形：只提醒一次，不刷屏）。
  let warnedSanitize = false
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    // 与 prompt-dedup 同款：先 await next() 尊重前序 waterfall 的替换结果。
    const r = await next()
    if (!r || !Array.isArray(r.sections)) return r
    for (let i = 0; i < r.sections.length; i++) {
      const sec = r.sections[i]
      if (!sec || !LITERAL_SECTIONS.has(sec.name)) continue
      // 内核对齐：标记被保留 ⇒ 内核支持按字面渲染，原样返回。
      if (sec.interpolate === false) continue
      if (typeof sec.text !== 'string' || sec.text.length === 0) continue
      const escaped = sanitize(sec.text)
      if (escaped !== sec.text) {
        if (!warnedSanitize) {
          warnedSanitize = true
          console.warn('[dsh-prompt-literal] section "' + sec.name + '" contains `{` runs that a kernel '
            + 'without `interpolate` support would interpolate; escaped them to keep the text literal '
            + '(compat fallback; only the first occurrence is reported)')
        }
        r.sections[i] = { ...sec, text: escaped }
      }
    }
    return r
  })
}
