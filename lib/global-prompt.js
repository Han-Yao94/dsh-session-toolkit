import fs from 'node:fs'
import { originGuard } from './request-guard.js'

export const inject = ['systemPrompt', 'agents', 'timer']

// 只读投影路由：活跃工作区 + 引用文件读取状态。
// 这两项是 host 的**运行时状态**（不是用户配置），而 DSH 0.1.7 起的 settings 只承载
// 条目 Config 的 volatile 字段，故改由本插件自己的只读 HTTP 路由送给浏览器半
// （由 webServer 注册的原始路由；client 轮询该路由）。
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

// 会话枚举（供浏览器半的**组成员选择器**）：从 ctx.agents.roots() 取每个根会话的
// { id, cwd, title }。三条边界，都是「宁可少给、不能报错」：
// ① 只列**根会话**（roots() 定义 = owner 为空的会话），与会话选择器的语义一致；
// ② 数据源只有 ctx.agents（经 inject 声明的必需服务）⇒ 不会因可选服务缺席而整段消失；
// ③ 标题是**可选**的：sessionTitle 服务不在场（或对某个会话取标题抛错）⇒ 该条 title 记 null，
//    其余字段照常返回。标题读取异常绝不能把整条只读路由打成 500 —— client 轮询该路由，
//    一旦 500 它拿不到 active/fileStatus，工作区提示词与文件状态的显示会一起坏掉。
function collectSessions(ctx) {
  const sessions = []
  const agents = ctx.agents
  let roots = []
  if (agents && typeof agents.roots === 'function') {
    try { roots = agents.roots() } catch (e) { console.warn('[dsh-global-prompt] agents.roots() failed: ' + (e && e.message ? e.message : String(e))); roots = [] }
  }
  if (!Array.isArray(roots)) return sessions
  // sessionTitle 是可选服务：缺失即降级为「全部 title = null」，不拖垮整包。
  const titleSvc = ctx.get('sessionTitle')
  const canReadTitle = titleSvc !== undefined && titleSvc !== null && typeof titleSvc.get === 'function'
  for (const agent of roots) {
    const session = agent && agent.session
    const header = session && session.header
    const id = header && typeof header.id === 'string' ? header.id : ''
    if (!id) continue
    let title = null
    if (canReadTitle) {
      try {
        // 服务返回 { title, messageSeqs, source, … }，尚未产生标题时为 undefined。
        const snap = titleSvc.get(session)
        if (snap && typeof snap.title === 'string') title = snap.title
      } catch (e) {
        console.warn('[dsh-global-prompt] sessionTitle.get failed: ' + (e && e.message ? e.message : String(e)))
      }
    }
    sessions.push({ id, cwd: (header && typeof header.cwd === 'string' && header.cwd.length > 0) ? header.cwd : null, title })
  }
  return sessions
}

// 读引用文件（每次组装时重读）：失败跳过（不注入），返回注入 body 与每文件状态。
// 支持纯文本/markdown，按 `{ mtimeMs, size }` 缓存内容：文件未变则不重复读盘。
// cachePrefix：本条 config 的命名空间（'' / 'workspace:…' / 'group:…'）。缓存是跨段共用的
// 一张表，而同一路径可能被多个工作区/组同时引用；readPromptFiles 每轮只会剔除「不在本次
// wanted 里」的键（缓存键跟随当前引用列表），若多个命名空间共用同一键，先读的一方会把后来
// 一方仍需要的条目剔掉 ⇒ 同一文件反复重读。「命名空间 + 路径」做键后各段互不干扰。
function readPromptFiles(files, limits, cache, cachePrefix) {
  const pre = typeof cachePrefix === 'string' ? cachePrefix : ''
  const statuses = []
  const wanted = []
  for (const f of files || []) {
    if (typeof f === 'string' && f.length > 0) wanted.push(f)
  }
  const keyOf = (f) => (pre === '' ? f : pre + '\u0000' + f)
  // 缓存的键跟随当前引用列表，删掉已不再引用的文件，避免缓存无限增长。
  // 剔除**只许动本命名空间的键**，两侧都要判（少一条就是一个跨命名空间误伤）：
  //  · 命名空间侧：本轮的键必须精确以 `pre + '\u0000'` 开头 —— 若只按裸前缀比较，某个工作区
  //    路径恰好以 'workspace:' 开头时会被误剔（只多读一次、不串内容，但配对不严格）；
  //  · 默认侧：默认命名空间（pre === ''）本轮只允许剔**裸路径键**（不含 NUL 分隔符）。
  //    否则全局段与工作区段（它们走默认命名空间）会把同一张表里 'group:*' 等条目的键一起剔掉
  //    —— 那些条目正是别的段还在用的，于是每轮重新读盘，恰好把「避免反复重读」的修复搬到
  //    组命名空间上去失效。代价：默认命名空间腾不出带 NUL 的陈旧条目，但默认侧的键就是路径
  //    本身、每条路径只属于一个工作区，不存在跨段共享 ⇒ 无条目因此泄漏。
  const full = pre === '' ? '' : pre + '\u0000'
  for (const key of Array.from(cache.keys())) {
    const own = pre === '' ? key.indexOf('\u0000') === -1 : key.startsWith(full)
    if (!own) continue
    if (wanted.indexOf(key.slice(full.length)) === -1) cache.delete(key)
  }
  let body = ''
  let total = 0
  for (const f of wanted) {
    const ck = keyOf(f)
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
      let entry = cache.get(ck)
      if (entry === undefined || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
        entry = { mtimeMs: st.mtimeMs, size: st.size, text: fs.readFileSync(f, 'utf8') }
        cache.set(ck, entry)
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
  // 注意：deps.workspaceValue() 返回的**已经是 workspaces 字典**，不是外层 workspacePrompt section
  // （ref 建于本文件的 workspaceCfg.workspaces；同文件工作区 section 同样直接把它当字典用 ⇒
  // Object.keys(workspaces)）。此前按 v.workspaces / v.removed 取子键，二者恒为 undefined ⇒ 每个
  // 活跃工作区都被判「缺失」而补 { enabled:false, content:'', files:[] }，changed 恒真 ⇒ 每次同步
  // 把整份字典写回；settings.update 是**递归深合并**（mergeLayers：plain object 递归合并、其余值
  // 含数组整体替换）⇒ 用户正文被 content:'' 覆盖、files 被整体替换成 []。修法三层：① 取值层级改对
  // ② removed 走它自己的 ref（与 workspaces 同级）③ 只回写**本轮真正新增的路径**，不写回整份字典
  // —— 即使将来读取再次出错，也伤不到已有条目。
  const rawWorkspaces = deps.workspaceValue()
  const workspaces = (rawWorkspaces && typeof rawWorkspaces === 'object' && !Array.isArray(rawWorkspaces))
    ? { ...rawWorkspaces }
    : {}
  const added = {}
  const rawRemoved = deps.removedValue()
  const removed = Array.isArray(rawRemoved) ? rawRemoved.slice() : []
  for (const item of active) {
    const path = item.path
    if (typeof path !== 'string' || path.length === 0) continue
    if (removed.indexOf(path) !== -1) continue
    if (workspaces[path] !== undefined) continue
    // 原位写进快照，避免同一批里出现两条相同 path 时被重复补进 added（写入是真副作用，只做一次）。
    workspaces[path] = { enabled: false, content: '', files: [] }
    added[path] = workspaces[path]
  }
  if (Object.keys(added).length > 0) {
    // 新增工作区写回本条目 config（settings 服务的 Host 写入口，落盘 profile patch）。
    // 失败不记账：下一次同步/重试按当前 config 重算，缺失路径会被再补一次（幂等）。
    const settings = ctx.get('settings')
    if (!settings || typeof settings.update !== 'function') {
      console.warn('[dsh-global-prompt] settings service unavailable: discovered workspaces stay unlisted in config')
    } else {
      settings.update(deps.entryId, { workspacePrompt: { workspaces: added } }).catch((e) => {
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
  // + groupPrompt.*（按组提示词：成员会话 id 跨工作区）
  const hostCfg = (cfg && typeof cfg === 'object' && cfg.global && typeof cfg.global === 'object') ? cfg.global : {}
  const workspaceCfg = (cfg && typeof cfg === 'object' && cfg.workspace && typeof cfg.workspace === 'object') ? cfg.workspace : {}
  const groupCfg = (cfg && typeof cfg === 'object' && cfg.group && typeof cfg.group === 'object') ? cfg.group : {}
  // 顺序键默认值（原为就地字面量 50 / 60 / 55，抽出成常量以便运行时归一化）：
  const DEFAULT_SECTION_ORDER = 50
  const DEFAULT_WORKSPACE_SECTION_ORDER = 60
  const DEFAULT_GROUP_SECTION_ORDER = 55
  // 裁定 #50 ②：三个顺序键与下面的字节预算是**同一个问题族**（schema 只保证 `z.number()`，
  // NaN / Infinity / 非数值会穿透），故用同形的运行时归一化；其中 `sectionOrder` 与
  // lib/identity.js 的 identity.sectionOrder 是**同一个符号语义** —— 排序键允许 0 与负数，
  // 所以只要求「整数」（Number.isInteger 已能挡住 NaN / Infinity / 非数值），不要求 > 0。
  const sectionOrder = normalizeInt(hostCfg.sectionOrder, DEFAULT_SECTION_ORDER, 'globalPrompt.sectionOrder')
  const workspaceSectionOrder = normalizeInt(hostCfg.workspaceSectionOrder, DEFAULT_WORKSPACE_SECTION_ORDER, 'globalPrompt.workspaceSectionOrder')
  // 组 section 的顺序默认 55（夹在全局 50 与工作区 60 之间，见 §188.2）：
  // 组提示词比按工作区的通用提示词更针对当前会话，故排在它前面；它是用户数据，不标 volatile。
  const groupSectionOrder = normalizeInt(groupCfg.sectionOrder, DEFAULT_GROUP_SECTION_ORDER, 'groupPrompt.sectionOrder')
  // 组是**可空**的：groupCfg.groups 未配置（或 config 里没有 groupPrompt 键）时 groupRef 为
  // undefined，volatileValue(groupRef, {}) 兜成 {} ⇒ Object.keys 为空 ⇒ 组 section 恒返回空串。
  const groupRef = groupCfg.groups
  // L9-12：schema 只保证 `z.number()`（**不收紧 schema** —— 收紧会让既有用户的持久化配置
  // 在加载期直接抛、整条插件不 apply，比运行期回落更坏），故这里做**运行时归一化**：
  // 只有「正整数」才放行，其余一律回落默认值并告警（与 lib/auto-resume.js 的
  // normalizeConcurrency 同形）。为什么必须挡：`st.size > NaN` 与 `total + size > Infinity`
  // 都恒假 ⇒ 字节预算**静默失效**，下面的 fs.readFileSync 会读任意大文件。
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
  function normalizeByteBudget(raw, fallback, label) {
    if (raw === undefined || raw === null) return fallback
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw
    console.warn('[dsh-global-prompt] ' + label + ' must be a positive integer; got '
      + describeCfgValue(raw) + ' — falling back to ' + fallback)
    return fallback
  }
  // 顺序键同族归一化（裁定 #50 ②）：只要求「整数」（允许 0 与负数，见上），其余回落并告警。
  // 与 normalizeByteBudget 的唯一差别就是这条 > 0：预算为「字节数」、顺序键为「排序键」。
  function normalizeInt(raw, fallback, label) {
    if (raw === undefined || raw === null) return fallback
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw
    console.warn('[dsh-global-prompt] ' + label + ' must be an integer; got '
      + describeCfgValue(raw) + ' — falling back to ' + fallback)
    return fallback
  }
  const limits = {
    maxFileBytes: normalizeByteBudget(hostCfg.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'globalPrompt.maxFileBytes'),
    maxTotalBytes: normalizeByteBudget(hostCfg.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 'globalPrompt.maxTotalBytes'),
  }
  // 用户数据是本条目 Config 的 volatile 字段（DSH 0.1.7 起 settings 的唯一数据面）：
  // 组装时实时 .get()，表单写入提交后立刻生效，无需重挂插件。
  const globalEnabledRef = hostCfg.enabled
  const globalContentRef = hostCfg.content
  const globalFilesRef = hostCfg.files
  const workspaceRef = workspaceCfg.workspaces
  // removed 与 workspaces 在 config 里是**同级键**（lib/index.js 的 workspacePrompt 结构），
  // 因此它有自己的 ref；此前从 workspaces 的值里取 removed，恒 undefined（见 sync 的修复说明）。
  const removedRef = workspaceCfg.removed
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
    removedValue: () => volatileValue(removedRef, []),
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

  // 组 section：按**会话 id 精确匹配**命中组，注入其 content + 引用文件。
  // 与工作区 section 的匹配口径不同：工作区按 cwd 前缀（目录归属），组按 header.id 精确等于
  // groups[g].sessions 里的成员项（人工挑选的成员，与 cwd 无关 ⇒ 可跨工作区）。
  // 一个会话可命中多个组：组之间并列注入、不互斥，每个命中组自成一块（块内 content 与引用文件
  // 之间用单个 '\n'，块间用 '\n\n' 空行分隔），块序 = groups 的键枚举序。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'group-prompt',
    order: groupSectionOrder,
    interpolate: false, // 同上：组提示词与引用文件按字面渲染
    text: (context) => {
      // agent 是模块增强字段（runtime-types 里声明为可选，诊断期缺席）⇒ 一律判空，不假定在场。
      const agent = context.agent
      if (!agent || !agent.session) return ''
      const header = agent.session.header || {}
      const sessionId = typeof header.id === 'string' ? header.id : ''
      if (!sessionId) return ''
      const groups = volatileValue(groupRef, {})
      if (!groups || typeof groups !== 'object') return ''
      const blocks = []
      for (const groupKey of Object.keys(groups)) {
        const rec = groups[groupKey]
        if (!rec || rec.enabled !== true) continue
        const members = Array.isArray(rec.sessions) ? rec.sessions : []
        if (members.indexOf(sessionId) === -1) continue
        const content = typeof rec.content === 'string' ? rec.content.trim() : ''
        const files = Array.isArray(rec.files) ? rec.files : []
        if (!content && files.length === 0) continue
        // 状态 scopeKey = 'group:' + 组键（与既有键不冲突：global 是字面量、工作区键是绝对路径）。
        const { body, statuses } = readPromptFiles(files, limits, fileCache, 'group:' + groupKey)
        recordStatus(runtime, statusState, 'group:' + groupKey, statuses)
        blocks.push(content + (content && body ? '\n' : '') + body)
      }
      // 无命中组（或命中组都未启用/无正文）返回空串：systemPrompt 会整段跳过，不留空行。
      return blocks.join('\n\n')
    },
  }), 'dsh-group-prompt: prompt section')

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
        // 前置 Origin 守卫（用 lib/request-guard.js 的实现；该实现原由本路由与 /api/restart 共用，
        // 后者已于 0.1.13 整功能移除，故现只剩本路由一个调用点——规则不因路由减少而放宽）：
        // 本路由同样绕过了 harness 的 /api/ 鉴权网关。只读面危害低一档，但仍然需要这道守卫。
        if (!originGuard(req, res, webServer.host)) return
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, active: runtime.active, fileStatus: runtime.fileStatus, sessions: collectSessions(ctx) }))
      },
    }), 'dsh-global-prompt: state route')
  })
}
