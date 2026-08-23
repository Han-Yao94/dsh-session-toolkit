import z from '@deepseek-ai/schemastery'
import fs from 'node:fs'

export const inject = ['settings', 'systemPrompt', 'agents', 'timer']

// 连续 { 全部空格化：`{{{x}}}` → `{ { {x}}}`，避免重叠匹配残留完整 {{var}} 组
// 被变量插值器当作引用（未注册则 throw，导致该会话每轮组装失败）。
function sanitize(content) {
  return content.replace(/\{+/g, (m) => m.split('').join(' '))
}

// 工作区路径前缀匹配：cwd 等于该路径，或位于该路径的子目录内（前缀 + 分隔符）。
// 统一分隔符比较（Windows \ 与 / 等价），并忽略末尾多余分隔符。
function isPathPrefix(prefix, cwd) {
  const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const p = norm(prefix)
  const c = norm(cwd)
  if (!p || !c) return false
  if (p === c) return true
  // 子目录：c 以 p + '/' 开头（如 p=/repo，c=/repo/sub）
  return c.startsWith(p + '/')
}

// 路径归一化（统一分隔符，去尾斜杠），用于会话 cwd 去重与分组计数
function normCwd(s) {
  return s.replace(/\\/g, '/').replace(/\/+$/, '')
}

// 可靠数据源：从 ctx.agents.roots()（DSH 核心 agent 服务，几乎必有，auto-resume/peer-message 同用）的
// 每个 agent.session.header.cwd 去重聚合「活跃工作区 + 会话数」。agents 经 inject 声明，apply 时 ctx.agents 必定可见。
function collectWorkspacesFromAgents(ctx) {
  const agents = ctx.agents
  let roots = []
  if (agents && typeof agents.roots === 'function') {
    try { roots = agents.roots() } catch (e) { roots = [] }
  }
  if (!Array.isArray(roots)) return []
  const map = new Map()
  for (const agent of roots) {
    const h = agent && agent.session && agent.session.header
    const cwd = h && typeof h.cwd === 'string' ? h.cwd : undefined
    if (!cwd || cwd.length === 0) continue
    const key = normCwd(cwd)
    const cur = map.get(key)
    if (cur) cur.count += 1
    else map.set(key, { path: cwd, count: 1 })
  }
  return Array.from(map.values()).map((x) => ({ path: x.path, sessionCount: x.count }))
}

// 读引用文件（同步，text() 每次组装时实时读）：失败跳过（不注入），返回注入 body 与每文件状态。
// 支持纯文本/markdown（原样 sanitize 后注入），无大小上限。
function readPromptFiles(files) {
  const statuses = []
  let body = ''
  for (const f of files || []) {
    if (typeof f !== 'string' || f.length === 0) continue
    try {
      const text = fs.readFileSync(f, 'utf8')
      statuses.push({ filePath: f, status: 'ok', charCount: text.length })
      body += (body ? '\n' : '') + sanitize(text)
    } catch (e) {
      // 读文件失败 → 跳过该文件内容（不注入），记录失败状态供 UI 显示原因
      statuses.push({ filePath: f, status: 'fail', reason: String(e && e.message ? e.message : e) })
    }
  }
  return { body, statuses }
}

// 把活跃工作区投影（path + sessionCount）写入只读投影 namespace，并把手动未移除的缺失路径补进
// workspace-prompt（仅补缺失，不覆盖用户 enabled/content/files）。返回是否有数据。
// 注意：scope.get() 返回的 value 被 DSH deepFreeze 冻结（不可变），必须对 workspaces/removed 拷贝成
// 可变对象后再修改，否则向冻结对象加属性会抛 "object is not extensible"。
function syncWorkspaceProjection(ctx, wsScope, activeScope) {
  const active = collectWorkspacesFromAgents(ctx)
  if (!Array.isArray(active) || active.length === 0) return false
  const v = wsScope.get() || {}
  const workspaces = (v.workspaces && typeof v.workspaces === 'object') ? { ...v.workspaces } : {}
  const removed = Array.isArray(v.removed) ? v.removed.slice() : []
  let changed = false
  for (const item of active) {
    const path = item.path
    if (typeof path !== 'string' || path.length === 0) continue
    if (removed.indexOf(path) === -1 && workspaces[path] === undefined) {
      workspaces[path] = { enabled: false, content: '', files: [] }
      changed = true
    }
  }
  activeScope.update({ active }).catch(() => {})
  if (changed) {
    wsScope.update({ workspaces }).catch(() => {})
  }
  return true
}

// 延迟重试：apply 时 agents 可能尚未 ready（roots() 空），故轮询直至聚合到非空活跃工作区（或达上限）。
async function syncWithRetry(ctx, wsScope, activeScope, attempt) {
  const MAX = 40 // 500ms * 40 = 20s 上限
  let ok = false
  try {
    ok = syncWorkspaceProjection(ctx, wsScope, activeScope)
  } catch (e) {
    ok = false
  }
  if (ok) return
  if (attempt < MAX) {
    ctx.timeout(() => { syncWithRetry(ctx, wsScope, activeScope, attempt + 1) }, 500)
  }
}

const fileStatusSchema = z.object({
  filePath: z.string(),
  status: z.union(['ok', 'fail']),
  charCount: z.number(),
  reason: z.string(),
})

export function apply(ctx, cfg) {
  // Config 分键（globalPrompt.sectionOrder / workspaceSectionOrder 可选），缺省兜底默认值
  const sectionOrder = (cfg && typeof cfg.sectionOrder === 'number') ? cfg.sectionOrder : 50
  const workspaceSectionOrder = (cfg && typeof cfg.workspaceSectionOrder === 'number') ? cfg.workspaceSectionOrder : 60

  // 全局提示词：启用开关 + 文本 + 引用文件列表（files）
  const scope = ctx.settings.register('global-prompt', z.object({
    enabled: z.boolean().default(false),
    content: z.string().default(''),
    files: z.array(z.string()).default([]),
  }), { applies: 'live' })

  // 工作区提示词：每个工作区 enabled/content/files + removed（用户已移除的 path）
  const wsScope = ctx.settings.register('workspace-prompt', z.object({
    workspaces: z.dict(z.object({
      enabled: z.boolean().default(false),
      content: z.string().default(''),
      files: z.array(z.string()).default([]),
    })).default({}),
    removed: z.array(z.string()).default([]),
  }), { applies: 'live' })

  // 只读投影：host 把活跃工作区（path + sessionCount，来自 agents.roots() 的会话 cwd 聚合）写入前端可读 scope
  const activeScope = ctx.settings.register('workspace-registry-active', z.object({
    active: z.array(z.object({
      path: z.string(),
      sessionCount: z.number().default(0),
    })).default([]),
  }), { applies: 'live' })

  // 只读投影：引用文件最近一次读取状态（byScope: global / 工作区 path → 状态数组），前端引用文件区块读它
  const fsStatusScope = ctx.settings.register('prompt-file-status', z.object({
    byScope: z.dict(z.array(fileStatusSchema)).default({}),
  }), { applies: 'live' })

  // 全局 section：enabled 时注入 content + 引用文件内容（每次组装实时读文件，失败跳过）
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'global-prompt',
    order: sectionOrder,
    text: () => {
      const v = scope.get()
      if (!v.enabled) return ''
      const { body, statuses } = readPromptFiles(v.files)
      fsStatusScope.update({ byScope: { global: statuses } }).catch(() => {})
      const content = v.content.trim()
      const contentPart = content ? sanitize(content) : ''
      return contentPart + (contentPart && body ? '\n' : '') + body
    },
  }), 'dsh-global-prompt: prompt section')

  // 工作区 section：按会话 cwd 前缀匹配，取「最具体」（pathKey 最长/最深）启用工作区，注入其 content + 引用文件
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'workspace-prompt',
    order: workspaceSectionOrder,
    text: (context) => {
      const agent = context.agent
      if (!agent || !agent.session) return ''
      const header = agent.session.header || {}
      const cwd = typeof header.cwd === 'string' ? header.cwd : ''
      if (!cwd) return ''
      const v = wsScope.get()
      if (!v || !v.workspaces || typeof v.workspaces !== 'object') return ''
      let best = null
      for (const pathKey of Object.keys(v.workspaces)) {
        const rec = v.workspaces[pathKey]
        if (!rec || rec.enabled !== true) continue
        const content = typeof rec.content === 'string' ? rec.content.trim() : ''
        const files = Array.isArray(rec.files) ? rec.files : []
        if (!content && files.length === 0) continue
        // 用命中路径做状态 scopeKey（该工作区可能有多条启用前缀命中，取最具体者）
        if (best === null || pathKey.length > best.pathKey.length) {
          best = { pathKey, content, files }
        }
      }
      if (!best) return ''
      const { body, statuses } = readPromptFiles(best.files)
      fsStatusScope.update({ byScope: { [best.pathKey]: statuses } }).catch(() => {})
      const contentPart = best.content ? sanitize(best.content) : ''
      return contentPart + (contentPart && body ? '\n' : '') + body
    },
  }), 'dsh-workspace-prompt: prompt section')

  // 活跃工作区投影（基于 agents.roots()）+ 缺失路径补齐：启动用延迟重试（等 agents ready），
  // 并随 session/created 实时重新聚合。agents 经 inject 声明，apply 时必可见。
  syncWithRetry(ctx, wsScope, activeScope, 0)
  ctx.on('session/created', () => {
    syncWithRetry(ctx, wsScope, activeScope, 0)
  })
}
