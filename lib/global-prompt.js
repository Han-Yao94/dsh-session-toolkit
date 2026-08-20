import z from '@deepseek-ai/schemastery'

export const inject = ['settings', 'systemPrompt']

export function apply(ctx, cfg) {
  // Config 分键（globalPrompt.sectionOrder），缺省兜底默认值
  const sectionOrder = (cfg && typeof cfg.sectionOrder === 'number') ? cfg.sectionOrder : 50
  function sanitize(content) {
    // 连续 { 全部空格化：`{{{x}}}` → `{ { {x}}}`，避免重叠匹配残留完整 {{var}} 组
    // 被变量插值器当作引用（未注册则 throw，导致每轮组装失败）。
    return content.replace(/\{+/g, (m) => m.split('').join(' '))
  }
  const scope = ctx.settings.register('global-prompt', z.object({
    enabled: z.boolean().default(false),
    content: z.string().default(''),
  }), { applies: 'live' })
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'global-prompt',
    order: sectionOrder,
    text: () => {
      const v = scope.get()
      if (!v.enabled) return ''
      const content = v.content.trim()
      return content ? sanitize(content) : ''
    },
  }), 'dsh-global-prompt: prompt section')
}
