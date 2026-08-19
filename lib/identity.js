import z from '@deepseek-ai/schemastery'

export const inject = ['settings', 'systemPrompt']

export function apply(ctx) {
  function sanitize(content) {
    // 连续 { 全部空格化：`{{{x}}}` → `{ { {x}}}`，避免重叠匹配残留完整 {{var}} 组
    // 被变量插值器当作引用（未注册则 throw，导致该会话每轮组装失败）。
    return content.replace(/\{+/g, (m) => m.split('').join(' '))
  }

  const scope = ctx.settings.register('session-identity', z.object({
    default: z.object({
      enabled: z.boolean().default(true),
      text: z.string().default(''),
    }),
    sessions: z.dict(z.object({
      enabled: z.boolean().default(true),
      text: z.string().default(''),
    })).default({}),
  }), { applies: 'live' })

  // 解析优先级：会话记录 → 默认身份；enabled 非 true 或空文本 → 不注入。
  // host 侧截断防御（P2-6）：UI 4000 为软上限，settings.yaml 手工编辑可写入任意长度，
  // 仅 token 成本风险；超长文本截断并告警一次。
  const MAX_TEXT = 8000
  let warned = false
  function clip(text) {
    if (text.length <= MAX_TEXT) return text
    if (!warned) {
      warned = true
      console.warn('[dsh-session-identity] identity text truncated to ' + MAX_TEXT + ' chars (token cost guard)')
    }
    // 码点安全截断（Array.from 按码点切分），避免 UTF-16 代理对中间切断（emoji 等乱码）
    return Array.from(text).slice(0, MAX_TEXT).join('')
  }

  function resolveIdentity(sessionId) {
    const v = scope.get()
    if (!v) return ''
    const rec = v.sessions ? v.sessions[sessionId] : undefined
    if (rec) {
      if (rec.enabled !== true) return ''
      const t = typeof rec.text === 'string' ? rec.text.trim() : ''
      return t ? sanitize(clip(t)) : ''
    }
    if (!v.default || v.default.enabled !== true) return ''
    const t = typeof v.default.text === 'string' ? v.default.text.trim() : ''
    return t ? sanitize(clip(t)) : ''
  }

  // 路线 B（T0 已验证）：全局注册单段，text 每次组装按 AssembleContext.agent 求值，
  // 实时生效；空身份返回 ''（空段在渲染时删除）。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'session-identity',
    order: 55,
    text: (context) => {
      const agent = context.agent
      if (!agent || !agent.session) return ''
      // subagent 不注入身份：会话 header 带 origin/delegationDepth 标记
      const header = agent.session.header || {}
      if (header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)) return ''
      return resolveIdentity(agent.session.id)
    },
  }), 'dsh-session-identity: prompt section')
}
