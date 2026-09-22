import fs from 'node:fs'
import { originGuard } from './request-guard.js'

export const inject = ['systemPrompt', 'agents', 'timer']

// 只读投影路由：活跃工作区 + 引用文件读取状态。
// 这两项是 host 的**运行时状态**（不是用户配置），而 DSH 0.1.7 起的 settings 只承载
// 条目 Config 的 volatile 字段，故改由本插件自己的只读 HTTP 路由送给浏览器半
// （与 /api/restart 同一套 webServer 机制；client 轮询该路由）。
export const STATE_ROUTE = '/api/session-toolkit/state'

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

// 读取状态记账：状态每个模型步都会重算，只有内容真正变化时才替换进程内投影
// （避免无变化的 JSON 反复重建，也让 client 的轮询能看到稳定引用）。
function recordStatus(runtime, state, key, statuses) {
  const next = JSON.stringify(statuses)
  if (state[key] === next) return
  state[key] = next
  runtime.fileStatus.byScope[key] = statuses
}

// 把活跃工作区（path + sessionCount）写进进程内投影（经 STATE_ROUTE 送到浏览器半），并把用户
// 未移除的缺失路径补进本条目 config 的 workspacePrompt.workspaces（仅补缺失，不覆盖用户的
// enabled/content/files）。返回是否有数据。
// 注意：volatile .get() 返回的 value 可能是冻结对象（不可变），workspaces/removed 必须先拷贝再改。
function syncWorkspaceProjection(ctx, deps) {
  const active = collectWorkspacesFromAgents(ctx)
  if (!Array.isArray(active) || active.length === 0) return false
  // 值没变就不换引用：client 按引用判断是否需要重渲染。
  const activeJson = JSON.stringify(active)
  if (deps.activeState.json !== activeJson) {
    deps.activeState.json = activeJson
    deps.runtime.active = active
  }
  const v = deps.workspaceValue()
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
  if (changed) {
    // 新增工作区写回本条目 config（settings 服务的 Host 写入口，落盘 profile patch）。
    // 失败不记账：下一次同步/重试按当前 config 重算，缺失路径会被再补一次（幂等）。
    const settings = ctx.get('settings')
    if (!settings || typeof settings.update !== 'function') {
      console.warn('[dsh-global-prompt] settings service unavailable: discovered workspaces stay unlisted in config')
    } else {
      settings.update(deps.entryId, { workspacePrompt: { workspaces } }).catch((e) => {
        console.warn('[dsh-global-prompt] workspace config update failed:', e && e.message ? e.message : e)
      })
    }
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

// 聚合包条目 id：settings 的命名空间就是被编辑条目的 id，浏览器半据此取表单。
const ENTRY_ID = 'session-toolkit'

export function apply(ctx, cfg) {
  // Config 分键：globalPrompt.*（顺序/上限 + 全局提示词）+ workspacePrompt.*（按工作区提示词）
  const hostCfg = (cfg && typeof cfg === 'object' && cfg.global && typeof cfg.global === 'object') ? cfg.global : {}
  const workspaceCfg = (cfg && typeof cfg === 'object' && cfg.workspace && typeof cfg.workspace === 'object') ? cfg.workspace : {}
  const sectionOrder = typeof hostCfg.sectionOrder === 'number' ? hostCfg.sectionOrder : 50
  const workspaceSectionOrder = typeof hostCfg.workspaceSectionOrder === 'number' ? hostCfg.workspaceSectionOrder : 60
  const limits = {
    maxFileBytes: typeof hostCfg.maxFileBytes === 'number' ? hostCfg.maxFileBytes : DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: typeof hostCfg.maxTotalBytes === 'number' ? hostCfg.maxTotalBytes : DEFAULT_MAX_TOTAL_BYTES,
  }
  // 用户数据是本条目 Config 的 volatile 字段（DSH 0.1.7 起 settings 的唯一数据面）：
  // 组装时实时 .get()，表单写入提交后立刻生效，无需重挂插件。
  const globalEnabledRef = hostCfg.enabled
  const globalContentRef = hostCfg.content
  const globalFilesRef = hostCfg.files
  const workspaceRef = workspaceCfg.workspaces
  function volatileValue(ref, fallback) {
    if (!ref || typeof ref.get !== 'function') return fallback
    const v = ref.get()
    return (v === undefined || v === null) ? fallback : v
  }
  // 引用文件读取缓存与投影记账（apply 局部：不跨插件实例/热重载共享）
  const fileCache = new Map()
  const statusState = {}
  const activeState = { json: undefined }
  // 运行时投影：活跃工作区 + 引用文件状态，经 STATE_ROUTE 只读暴露给浏览器半（不落盘）
  const runtime = { active: [], fileStatus: { byScope: {} } }
  const deps = {
    runtime,
    workspaceValue: () => volatileValue(workspaceRef, {}),
    entryId: ENTRY_ID,
    limits,
    fileCache,
    statusState,
    activeState,
    retry: {
      max: typeof hostCfg.workspaceSyncRetryMax === 'number' ? hostCfg.workspaceSyncRetryMax : 40,
      intervalMs: typeof hostCfg.workspaceSyncRetryIntervalMs === 'number' ? hostCfg.workspaceSyncRetryIntervalMs : 500,
    },
  }

  // 全局 section：enabled 时注入 content + 引用文件内容（每次组装实时读文件，失败跳过）
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'global-prompt',
    order: sectionOrder,
    // 按字面渲染：提示词与引用文件里的 `{{...}}` 不是变量引用（0.1.6+ 生效；
    // 旧内核由 lib/prompt-literal.js 兜底）。此前用 sanitize() 空格化 `{` 串，
    // 会不可逆地改写用户的 JSON/代码/模板内容。
    interpolate: false,
    text: () => {
      if (volatileValue(globalEnabledRef, false) !== true) return ''
      const files = volatileValue(globalFilesRef, [])
      const content = volatileValue(globalContentRef, '')
      const { body, statuses } = readPromptFiles(files, limits, fileCache)
      recordStatus(runtime, statusState, 'global', statuses)
      const text = typeof content === 'string' ? content.trim() : ''
      return text + (text && body ? '\n' : '') + body
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
      const workspaces = volatileValue(workspaceRef, {})
      if (!workspaces || typeof workspaces !== 'object') return ''
      let best = null
      for (const pathKey of Object.keys(workspaces)) {
        const rec = workspaces[pathKey]
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
      recordStatus(runtime, statusState, best.pathKey, statuses)
      return best.content + (best.content && body ? '\n' : '') + body
    },
  }), 'dsh-workspace-prompt: prompt section')

  // 活跃工作区投影（基于 agents.roots()）+ 缺失路径补齐：启动用延迟重试（等 agents ready），
  // 并随 session/created 实时重新聚合。agents 经 inject 声明，apply 时必可见。
  syncWithRetry(ctx, deps, 0)
  ctx.on('session/created', () => {
    syncWithRetry(ctx, deps, 0)
  })

  // 只读状态路由：活跃工作区 + 引用文件读取状态（webServer 为可选服务，用 ctx.inject 等它就绪；
  // register 返回 disposer，包 ctx.effect 绑定生命周期，热重载不重复注册、卸载时注销）。
  ctx.inject(['webServer'], (childCtx) => {
    const webServer = childCtx.get('webServer')
    if (!webServer) return
    childCtx.effect(() => webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: (req, res) => {
        // 前置 Origin 守卫（与 /api/restart 共用 lib/request-guard.js 的同一份实现）：
        // 本路由同样绕过了 harness 的 /api/ 鉴权网关。只读面危害低一档，但规则必须一致，
        // 否则两条路由会在加固上漂移。**以下既有语义一字未动**（含 405 分支与响应体）。
        if (!originGuard(req, res, webServer.host)) return
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, active: runtime.active, fileStatus: runtime.fileStatus }))
      },
    }), 'dsh-global-prompt: state route')
  })
}
