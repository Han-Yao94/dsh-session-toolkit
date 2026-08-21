// lib/blocklist.js — 文件屏蔽（file-blocklist）
// 指定文件的内容不进入模型上下文（read/read_image 可靠拦截 + shell 命令文本启发式）。
import z from '@deepseek-ai/schemastery'

export const inject = ['settings']

// 手写 glob → 正则（不引入依赖）：
// - **  → 任意层级（含零个）；* → 单段内任意；? → 单字符
// - 路径分隔符 / 与 \ 等价（Windows 大小写不敏感，i 标志）
// - 其余字符按正则字面转义
export function globToRegExp(glob) {
  const src = String(glob)
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '*') {
      if (src[i + 1] === '*') {
        i++ // 消费第二个 *
        out += '.*'
        // ** 后随分隔符时允许零段（如 **/AGENTS.md 也匹配根目录 AGENTS.md）
        if (src[i + 1] === '/' || src[i + 1] === '\\') { i++; out += '[\\\\/]?' }
      } else {
        out += '[^\\\\/]*'
      }
    } else if (ch === '?') {
      out += '[^\\\\/]'
    } else if (ch === '/' || ch === '\\') {
      out += '[\\\\/]'
    } else if ('\\^$+{}[]()|.'.indexOf(ch) !== -1) {
      out += '\\' + ch
    } else {
      out += ch
    }
  }
  return new RegExp(out, 'i')
}

const READ_TOOLS = new Set(['read', 'read_image'])
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'cmd', 'sh', 'ps'])

export function apply(ctx) {
  const scope = ctx.settings.register('file-blocklist', z.object({
    global: z.array(z.string()).default([]),
    sessions: z.dict(z.array(z.string())).default({}),
  }), { applies: 'live' })

  function patternsFor(sessionId) {
    const v = scope.get() || {}
    const out = []
    if (Array.isArray(v.global)) out.push(...v.global)
    if (sessionId && v.sessions && Array.isArray(v.sessions[sessionId])) out.push(...v.sessions[sessionId])
    return out
  }

  // 字面模式：目标文本包含即命中（大小写不敏感）；含通配：glob→正则 test
  function matchesAny(patterns, target) {
    if (!target || typeof target !== 'string') return false
    for (const p of patterns) {
      if (!p) continue
      if (p.indexOf('*') === -1 && p.indexOf('?') === -1) {
        if (target.toLowerCase().indexOf(p.toLowerCase()) !== -1) return true
      } else if (globToRegExp(p).test(target)) {
        return true
      }
    }
    return false
  }

  function denyReason() {
    return '该文件已被屏蔽配置拦截（file-blocklist），内容不会加载到上下文'
  }

  // tools/pre-execute waterfall：命中 → deny（不调 next）；未命中/其他工具 → next() 放行
  ctx.on('tools/pre-execute', (exec, next) => {
    const name = exec && exec.name
    const args = exec && exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
    const sessionId = exec.agent && exec.agent.session ? String(exec.agent.session.id) : undefined
    const patterns = patternsFor(sessionId)
    if (patterns.length === 0) return next()
    if (READ_TOOLS.has(name)) {
      const target = typeof args.file_path === 'string' ? args.file_path : (typeof args.path === 'string' ? args.path : undefined)
      if (target && matchesAny(patterns, target)) return { kind: 'deny', reason: denyReason() }
      return next()
    }
    if (SHELL_TOOLS.has(name)) {
      const cmd = typeof args.command === 'string' ? args.command : undefined
      if (cmd && matchesAny(patterns, cmd)) return { kind: 'deny', reason: denyReason() }
      return next()
    }
    return next()
  })
}