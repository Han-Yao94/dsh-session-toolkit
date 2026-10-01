export const inject = ['systemPrompt']

export function apply(ctx, cfg) {
  // Config 分键（identity.maxText / identity.sectionOrder），缺省兜底默认值。
  // S-4 / S-5：schema 只保证 `z.number()`（**不收紧 schema** —— 收紧会让既有用户的持久化
  // 配置在加载期直接抛、整条插件不 apply），故这里做**运行时归一化**（与 lib/auto-resume.js
  // 的 normalizeConcurrency 同形：非法值 ⇒ 一次性 console.warn + 回落默认值）。
  // 为什么必须挡：maxText=NaN ⇒ `text.length <= NaN` 恒假 ⇒ 身份文本**静默清空**；
  // sectionOrder=NaN/Infinity 会被直接透传给内核的 systemPrompt.section()，排序不可预期。
  const DEFAULT_MAX_TEXT = 8000
  const DEFAULT_SECTION_ORDER = 40
  function describeCfgValue(v) {
    if (typeof v === 'string') return JSON.stringify(v)
    if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v)
    if (typeof v === 'bigint') return String(v) + 'n'
    if (typeof v === 'symbol' || typeof v === 'function') return String(v)
    try {
      const s = JSON.stringify(v)
      return s === undefined ? String(v) : s
    } catch {
      return String(v)
    }
  }
  function normalizePositiveInt(raw, fallback, label) {
    if (raw === undefined || raw === null) return fallback
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw
    console.warn('[dsh-session-identity] ' + label + ' must be a positive integer; got '
      + describeCfgValue(raw) + ' — falling back to ' + fallback)
    return fallback
  }
  // sectionOrder 与 concurrency/maxText 语义不同：排序允许 0 与负数，只要求「整数」。
  function normalizeInt(raw, fallback, label) {
    if (raw === undefined || raw === null) return fallback
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw
    console.warn('[dsh-session-identity] ' + label + ' must be an integer; got '
      + describeCfgValue(raw) + ' — falling back to ' + fallback)
    return fallback
  }
  const maxText = normalizePositiveInt(cfg ? cfg.maxText : undefined, DEFAULT_MAX_TEXT, 'identity.maxText')
  const sectionOrder = normalizeInt(cfg ? cfg.sectionOrder : undefined, DEFAULT_SECTION_ORDER, 'identity.sectionOrder')

  // 身份文本是本条目 Config 的 volatile 字段（DSH 0.1.7 起 settings 的唯一数据面）。
  // 组装时实时 .get()：表单写入提交后立刻生效，无需重挂插件。
  const defaultRef = cfg ? cfg.default : undefined
  const sessionsRef = cfg ? cfg.sessions : undefined
  function volatileValue(ref, fallback) {
    if (!ref || typeof ref.get !== 'function') return fallback
    const v = ref.get()
    return (v === undefined || v === null) ? fallback : v
  }

  // 解析优先级：会话记录 → 默认身份；enabled 非 true 或空文本 → 不注入。
  // host 侧截断防御（P2-6）：UI 4000 为软上限，settings.yaml 手工编辑可写入任意长度，
  // 仅 token 成本风险；超长文本截断并告警一次。
  let warned = false
  function clip(text) {
    if (text.length <= maxText) return text
    if (!warned) {
      warned = true
      console.warn('[dsh-session-identity] identity text truncated to ' + maxText + ' chars (token cost guard)')
    }
    // 码点安全截断（Array.from 按码点切分），避免 UTF-16 代理对中间切断（emoji 等乱码）
    return Array.from(text).slice(0, maxText).join('')
  }

  function resolveIdentity(sessionId) {
    const sessions = volatileValue(sessionsRef, {})
    const dflt = volatileValue(defaultRef, {})
    const rec = sessions ? sessions[sessionId] : undefined
    if (rec) {
      if (rec.enabled !== true) return ''
      const t = typeof rec.text === 'string' ? rec.text.trim() : ''
      return t ? clip(t) : ''
    }
    if (!dflt || dflt.enabled !== true) return ''
    const t = typeof dflt.text === 'string' ? dflt.text.trim() : ''
    return t ? clip(t) : ''
  }

  // 路线 B（T0 已验证）：全局注册单段，text 每次组装按 AssembleContext.agent 求值，
  // 实时生效；空身份返回 ''（空段在渲染时删除）。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'session-identity',
    order: sectionOrder,
    // 按字面渲染：身份设定里的 `{{...}}` 不得被当成提示词变量插值（0.1.6+ 生效；
    // 旧内核由 lib/prompt-literal.js 兜底）。
    interpolate: false,
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
