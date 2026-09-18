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
const LITERAL_SECTIONS = ['session-identity', 'global-prompt', 'workspace-prompt']

export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    // 与 prompt-dedup 同款：先 await next() 尊重前序 waterfall 的替换结果。
    const r = await next()
    if (!r || !Array.isArray(r.sections)) return r
    for (let i = 0; i < r.sections.length; i++) {
      const sec = r.sections[i]
      if (!sec || LITERAL_SECTIONS.indexOf(sec.name) === -1) continue
      // 内核对齐：标记被保留 ⇒ 内核支持按字面渲染，原样返回。
      if (sec.interpolate === false) continue
      if (typeof sec.text !== 'string' || sec.text.length === 0) continue
      const escaped = sanitize(sec.text)
      if (escaped !== sec.text) r.sections[i] = { ...sec, text: escaped }
    }
    return r
  })
}
