import z from '@deepseek-ai/schemastery'
import fs from 'node:fs'

export const inject = ['settings', 'systemPrompt', 'agents', 'timer']

// 引用文件读取上限（globalPrompt.maxFileBytes / maxTotalBytes 可配置）。
// 默认 256 KiB / 1 MiB：引用文件在每次 assemble 时都会走一遍，无上限时一个
// 超大文件（或大 log）会同步阻塞事件循环并把提示词撑爆。
const DEFAULT_MAX_FILE_BYTES = 262144
const DEFAULT_MAX_TOTAL_BYTES = 1048576

// 工作区路径前缀匹配：cwd 等于该路径，或位于该路径的子目录内（前缀 + 分隔符）。
// 统一分隔符比较（Windows \ 与 / 等价），并忽略末尾多余分隔符。
function isPathPrefix(prefix, cwd) {
  const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
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
    try { roots = agents.roots() } catch (e) { console.warn('[dsh-global-prompt] agents.roots() failed: ' + (e && e.message ? e.message : String(e))); roots = [] }
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

// 读引用文件（每次组装时重读）：失败跳过（不注入），返回注入 body 与每文件状态。
// 支持纯文本/markdown，按 `{ mtimeMs, size }` 缓存内容：文件未变则不重复读盘。
function readPromptFiles(files, limits, cache) {
  const statuses = []
  const wanted = []
  for (const f of files || []) {
    if (typeof f === 'string' && f.length > 0) wanted.push(f)
  }
  // 缓存的键跟随当前引用列表，删掉已不再引用的文件，避免缓存无限增长。
  for (const key of Array.from(cache.keys())) {
    if (wanted.indexOf(key) === -1) cache.delete(key)
  }
  let body = ''
  let total = 0
  for (const f of wanted) {
    try {
      const st = fs.statSync(f)
      if (!st.isFile()) throw new Error('not a regular file')
      if (st.size > limits.maxFileBytes) {
        statuses.push({
          filePath: f,
          status: 'fail',
          reason: 'file is ' + st.size + ' bytes, over the ' + limits.maxFileBytes + '-byte limit',
        })
        continue
      }
      if (total + st.size > limits.maxTotalBytes) {
        statuses.push({
          filePath: f,
          status: 'fail',
          reason: 'total referenced-file budget of ' + limits.maxTotalBytes + ' bytes exceeded',
        })
        continue
      }
      let entry = cache.get(f)
      if (entry === undefined || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
        entry = { mtimeMs: st.mtimeMs, size: st.size, text: fs.readFileSync(f, 'utf8') }
        cache.set(f, entry)
      }
      total += st.size
      statuses.push({ filePath: f, status: 'ok', charCount: entry.text.length })
      body += (body ? '\n' : '') + entry.text
    } catch (e) {
      // 读文件失败 → 跳过该文件内容（不注入），记录失败状态供 UI 显示原因
      console.warn('[dsh-global-prompt] read file failed:', f, e && e.message ? e.message : e)
      statuses.push({ filePath: f, status: 'fail', reason: String(e && e.message ? e.message : e) })
    }
  }
  return { body, statuses }
}

// 只读投影写入抑制：settings 的 update() 会把整份 settings.yaml 持久化
// （带文件锁的读改写 + 原子写），而本投影在每个模型步的 assemble 里都会被刷新。
// 只有内容真正变化时才写，失败则清掉记账让后续组装重试。
function writeScopeKey(scope, state, key, statuses, label) {
  const next = JSON.stringify(statuses)
  if (state[key] === next) return
  state[key] = next
  scope.update({ byScope: { [key]: statuses } }).catch((e) => {
    if (state[key] === next) delete state[key]
    console.warn('[dsh-global-prompt] ' + label + ' scope update failed:', e && e.message ? e.message : e)
  })
}

// 把活跃工作区投影（path + sessionCount）写入只读投影 namespace，并把手动未移除的缺失路径补进
// workspace-prompt（仅补缺失，不覆盖用户 enabled/content/files）。返回是否有数据。
// 注意：scope.get() 返回的 value 被 DSH deepFreeze 冻结（不可变），必须对 workspaces/removed 拷贝成
// 可变对象后再修改，否则向冻结对象加属性会抛 "object is not extensible"。
function syncWorkspaceProjection(ctx, deps) {
  const wsScope = deps.wsScope
  const activeScope = deps.activeScope
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
  // 同样的写入抑制：活跃工作区投影在每次同步/重试里都会重算，值没变就不写盘。
  const activeJson = JSON.stringify(active)
  if (deps.activeState.json !== activeJson) {
    deps.activeState.json = activeJson
    activeScope.update({ active }).catch((e) => {
      if (deps.activeState.json === activeJson) deps.activeState.json = undefined
      console.warn('[dsh-global-prompt] scope update failed:', e && e.message ? e.message : e)
    })
  }
  if (changed) {
    wsScope.update({ workspaces }).catch((e) => console.warn('[dsh-global-prompt] scope update failed:', e && e.message ? e.message : e))
  }
  return true
}

// 延迟重试：apply 时 agents 可能尚未 ready（roots() 空），故轮询直至聚合到非空活跃工作区（或达上限）。
async function syncWithRetry(ctx, deps, attempt) {
  const MAX = deps.retry.max
  let ok = false
  try {
    ok = syncWorkspaceProjection(ctx, deps)
  } catch (e) {
    console.warn('[dsh-global-prompt] sync workspace projection failed: ' + (e && e.message ? e.message : String(e)))
    ok = false
  }
  if (ok) return
  if (attempt < MAX) {
    ctx.timeout(() => { syncWithRetry(ctx, deps, attempt + 1) }, deps.retry.intervalMs)
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
  const limits = {
    maxFileBytes: (cfg && typeof cfg.maxFileBytes === 'number') ? cfg.maxFileBytes : DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: (cfg && typeof cfg.maxTotalBytes === 'number') ? cfg.maxTotalBytes : DEFAULT_MAX_TOTAL_BYTES,
  }
  // 引用文件读取缓存与投影写入记账（apply 局部：不跨插件实例/热重载共享）
  const fileCache = new Map()
  const statusState = {}
  const activeState = { json: undefined }
  const deps = {
    wsScope: null,
    activeScope: null,
    limits,
    fileCache,
    statusState,
    activeState,
    retry: {
      max: (cfg && typeof cfg.workspaceSyncRetryMax === 'number') ? cfg.workspaceSyncRetryMax : 40,
      intervalMs: (cfg && typeof cfg.workspaceSyncRetryIntervalMs === 'number') ? cfg.workspaceSyncRetryIntervalMs : 500,
    },
  }

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
  deps.wsScope = wsScope
  deps.activeScope = activeScope

  // 全局 section：enabled 时注入 content + 引用文件内容（每次组装实时读文件，失败跳过）
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'global-prompt',
    order: sectionOrder,
    // 按字面渲染：提示词与引用文件里的 `{{...}}` 不是变量引用（0.1.6+ 生效；
    // 旧内核由 lib/prompt-literal.js 兜底）。此前用 sanitize() 空格化 `{` 串，
    // 会不可逆地改写用户的 JSON/代码/模板内容。
    interpolate: false,
    text: () => {
      const v = scope.get()
      if (!v.enabled) return ''
      const { body, statuses } = readPromptFiles(v.files, limits, fileCache)
      writeScopeKey(fsStatusScope, statusState, 'global', statuses, 'prompt-file-status')
      const content = v.content.trim()
      return content + (content && body ? '\n' : '') + body
    },
  }), 'dsh-global-prompt: prompt section')

  // 工作区 section：按会话 cwd 前缀匹配，取「最具体」（pathKey 最长/最深）启用工作区，注入其 content + 引用文件
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'workspace-prompt',
    order: workspaceSectionOrder,
    interpolate: false, // 同上：工作区提示词与引用文件按字面渲染
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
        // 【隔离修复】只匹配会话 cwd 位于该工作区目录下的 enabled 工作区（前缀匹配）；否则会误注入不相干工作区的 content/files
        if (!isPathPrefix(pathKey, cwd)) continue
        // 用命中路径做状态 scopeKey（该工作区可能有多条启用前缀命中，取最具体者）
        if (best === null || pathKey.length > best.pathKey.length) {
          best = { pathKey, content, files }
        }
      }
      if (!best) return ''
      const { body, statuses } = readPromptFiles(best.files, limits, fileCache)
      writeScopeKey(fsStatusScope, statusState, best.pathKey, statuses, 'prompt-file-status')
      return best.content + (best.content && body ? '\n' : '') + body
    },
  }), 'dsh-workspace-prompt: prompt section')

  // 活跃工作区投影（基于 agents.roots()）+ 缺失路径补齐：启动用延迟重试（等 agents ready），
  // 并随 session/created 实时重新聚合。agents 经 inject 声明，apply 时必可见。
  syncWithRetry(ctx, deps, 0)
  ctx.on('session/created', () => {
    syncWithRetry(ctx, deps, 0)
  })
}
