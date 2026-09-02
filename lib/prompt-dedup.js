// 三段系统提示词（身份/全局/工作区）跨段行级去重。
//
// promptDedup.enabled 默认开启（仅显式设为 false 时禁用；默认开启后行为与「不设区分键」时一致，
// 即系统提示词会被自动去重）。范围只限 name ∈ {session-identity, global-prompt, workspace-prompt} 三段之间，
// 绝不动 harness 自带段（harness:identity / deployment:persona / 工具段等）。
//
// 实现方式：在插件根 ctx 上订阅 subject-less 的 system-prompt/assemble waterfall，
// 先 await next() 拿到权威组装结果 r，再对 r.sections 中目标段做行级去重。
// 只改写 r.sections[i].text 组装结果字符串，不触碰注册的 section 定义、不设 complete。
export const inject = ['systemPrompt']

// 只处理这三个插件自有段（顺序即优先级：身份40 > 全局50 > 工作区60，数组已按 order 排序）
const TARGET_NAMES = ['session-identity', 'global-prompt', 'workspace-prompt']

export function apply(ctx, cfg) {
  // Config 分键（promptDedup.enabled）。默认开启：仅当显式设置为 false 时才禁用。
  const enabled = !(cfg && cfg.enabled === false)

  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    // 必须先 await next()：尊重前序 waterfall 可能替换 assembly 对象
    const r = await next()

    // 显式关闭（enabled=false）时直接早退，不触碰任何 sections → 行为零变化（默认开启）
    if (!enabled) return r
    if (!r || !Array.isArray(r.sections)) return r

    // 行级去重：按 assembly 数组顺序遍历目标段，seen 记录「先出现」的整行原文。
    // 只删跨段/后续「原行完全相同」的重复，任何段独有内容一律保留；不解析 {{...}} 占位符。
    const seen = new Set()
    for (let i = 0; i < r.sections.length; i++) {
      const sec = r.sections[i]
      if (!sec || TARGET_NAMES.indexOf(sec.name) === -1) continue
      if (typeof sec.text !== 'string') continue
      // 空段（如 subagent 跳过身份段 → text===''）不贡献行，从全局段开始计
      if (sec.text === '') continue

      const lines = sec.text.split('\n')
      const kept = []
      for (const line of lines) {
        if (seen.has(line)) continue
        seen.add(line)
        kept.push(line)
      }
      const newText = kept.join('\n')
      if (newText !== sec.text) {
        // 只改写组装结果里该 section 的 text（替换对象，避免任何 mutation 污染），
        // 不改 name/order、不触碰注册的 section 定义
        r.sections[i] = { ...sec, text: newText }
      }
    }
    return r
  })
}
