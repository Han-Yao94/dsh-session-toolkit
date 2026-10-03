// session-search — Host half（dsh-session-toolkit 的模块之一）
// 注册 search_sessions：跨会话按内容找回历史会话。走 `ctx.sessionQuery` 的**字面扫描**
// 路径（listSessions → 元数据过滤 → 逐会话 filterEvents），不依赖全文检索索引 —— 本部署
// 把 session-query-sqlite 配成 `openAt: never`，search 调用一律以 SESSION_QUERY_SEARCH_DISABLED
// 失败，而 listSessions / filterEvents 这类精确读**照常可用**。
//
// 内核依据（DSH checkout 只读核验，2026-10-03，与 BL-131 探针读数一致）：
//  · 服务 `ctx.sessionQuery` = SqliteSessionQueryEngine（packages/session-query/session-query-sqlite）
//  · `listSessions()` ⇒ Array<{ header: { version, id, createdAt, cwd, parentSession?, isSeeded,
//    origin, delegationDepth, agentPreset }, live, persisted }>。**id 在 row.header.id**，不在 row.id。
//  · `filterEvents(id, filters)` 的第二参数**必须是数组**（packages/session-query/session-query/
//    lib/index.js 第 795-797 行 assertArray：非数组抛 SESSION_QUERY_INVALID_FILTER，消息
//    "session filters must be an array"）。事件级 filter 的 kind 枚举（同文件第 711-737 行）=
//    seq / time / type / surface / text，多子句之间是 **AND**。
//  · `text` 的匹配语义（同文件第 745-750 行 compileSessionTextFilter）：trim() 后按空白切词、
//    每段正则转义、以 \s+ 连接、new RegExp(pattern, 'iu') ⇒ 字面、大小写不敏感、空白灵活。
//    全空白输入抛 SESSION_QUERY_INVALID_FILTER。
//  · `readTitleSnapshots(ids)` 返回 **allSettled 形状** [{ sessionId, status, value|reason }]
//    ⇒ 取标题必须判 status，路径是 value.title.title。
//  · `readSession(id)` 返回**整份事件日志**（60MB 会话实测输出 3.2 亿字符）⇒ 本模块严禁使用。
//  · `surface` 枚举（SessionEventSurface）= current / shadowed / log-only，见 packages/session-query/
//    session-query/src/types.ts 第 23-24 行；classifySurface 在同包 src/documents.ts 第 57-78 行。
//    current = 当前模型上下文；**shadowed = 已被后续快照取代/压缩掉的历史**（正是「找回」最该覆盖
//    的那部分，它已经不在模型上下文里了）；log-only = 从未上过任何面的原始日志（工具管道噪声）。
//  · ⇒ 默认 surfaces = ['current','shadowed']（排除 log-only）。实测（同一 query 'session-toolkit'
//    在 60MB 会话上）：current 349 条 / shadowed 9311 条 / log-only 6969 条，全量 16629 条
//    ⇒ 只取 current 会丢掉约 96% 的命中。调用方可用 `surfaces` 参数显式指定子集。
import { defineTool } from '@deepseek-ai/dsh-tools'

// 本模块不需要任何「几乎必有」的宿主服务：sessionQuery 与 tools 都在 apply 之后
// 用 ctx.inject 等它就绪（缺失时本模块静默不注册工具，不拖垮整包）。
export const inject = []

// 上限：本模块的全部成本都在 filterEvents 上（它没有内部分页参数，单会话可能命中上万条，
// 且每次调用都要读一份会话日志），所以「扫多少会话 / 每会话取多少 / 总共返回多少」三件事
// 各自设默认值与硬顶，调用方只能在硬顶内收紧，不能放大。
const DEFAULT_MAX_SESSIONS = 50
const HARD_MAX_SESSIONS = 200
const DEFAULT_PER_SESSION = 5
const HARD_PER_SESSION = 20
const DEFAULT_LIMIT = 20
const HARD_LIMIT = 100
const SNIPPET_RADIUS = 120
const MAX_QUERY_CHARS = 200

// 事件面（见文件头 surface 说明）。默认取 current + shadowed（含被压缩出上下文的历史），排除
// log-only；`surfaces` 参数可显式指定三值子集（空数组非法 —— 那等于「什么面都不要」⇒ 必然 0 命中，
// 属调用方错误而非空结果）。
const ALL_SURFACES = ['current', 'shadowed', 'log-only']
const DEFAULT_SURFACES = ['current', 'shadowed']

function clampInt(value, fallback, hardMax, min) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  if (floored < min) return min
  return floored > hardMax ? hardMax : floored
}

// `surfaces`（可选）：显式传即完全按调用方口径 —— 三值子集，去重保序；不传用默认值。
// 非法值 / 空数组一律返回结构化错误（不做静默兜底：调用方给了明确的面集合，猜他的意图更危险）。
function parseSurfaces(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: DEFAULT_SURFACES.slice() }
  if (!Array.isArray(raw)) {
    return { ok: false, errorText: 'surfaces 必须是数组（取值来自 ' + ALL_SURFACES.join(' / ') + '，如 ["current","shadowed"]）' }
  }
  const seen = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { ok: false, errorText: 'surfaces 只能含字符串：取值来自 ' + ALL_SURFACES.join(' / ') }
    }
    if (!ALL_SURFACES.includes(item)) {
      return { ok: false, errorText: 'surfaces 含非法值 ' + JSON.stringify(item) + '：只能是 ' + ALL_SURFACES.join(' / ') }
    }
    if (!seen.includes(item)) seen.push(item)
  }
  if (seen.length === 0) {
    return { ok: false, errorText: 'surfaces 不能为空数组：至少要指定一个事件面（' + ALL_SURFACES.join(' / ') + '）' }
  }
  return { ok: true, value: seen }
}

// 错误对象 → 可读一行。内核抛的是 SessionQueryError（带 code），保留 code。
function describe(error) {
  if (error === null || error === undefined) return String(error)
  if (typeof error === 'string') return error
  const message = error.message === undefined ? '' : String(error.message)
  const name = error.name === undefined ? '' : String(error.name)
  const code = error.code === undefined ? '' : String(error.code)
  const head = [name, message].filter((part) => part.length > 0).join(': ')
  if (code.length === 0) return head
  return head.length === 0 ? code : head + ' (' + code + ')'
}

// `since` 接受数字（毫秒时间戳）或 ISO 8601 字符串（也接受纯数字字符串）。
function parseSince(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, value: raw }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.length === 0) return { ok: true, value: undefined }
    if (/^\d+$/.test(trimmed)) return { ok: true, value: Number.parseInt(trimmed, 10) }
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed)) return { ok: true, value: parsed }
  }
  return { ok: false }
}

// 取片段：以 query 的首个词为锚，命中位置两侧各截 SNIPPET_RADIUS 字符。
// 切词规则与 compileSessionTextFilter 一致（空白切分），只取首个词做定位。
function snippetOf(text, query) {
  const body = typeof text === 'string' ? text : ''
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return ''
  const anchor = query.trim().split(/\s+/u)[0] ?? ''
  const at = anchor.length === 0 ? -1 : flat.toLowerCase().indexOf(anchor.toLowerCase())
  const center = at < 0 ? 0 : at
  const start = Math.max(0, center - SNIPPET_RADIUS)
  const end = Math.min(flat.length, center + (at < 0 ? 0 : anchor.length) + SNIPPET_RADIUS)
  const head = start > 0 ? '…' : ''
  const tail = end < flat.length ? '…' : ''
  return head + flat.slice(start, end) + tail
}

// 标题：批量取，逐条判 status（allSettled 形状），rejected 只降级这一条。
function titleMapOf(snapshots) {
  const map = new Map()
  if (!Array.isArray(snapshots)) return map
  for (const entry of snapshots) {
    if (entry === null || entry === undefined) continue
    const id = typeof entry.sessionId === 'string' ? entry.sessionId : ''
    if (id.length === 0) continue
    if (entry.status !== 'fulfilled') { map.set(id, null); continue }
    const value = entry.value ?? {}
    const title = value.title ?? {}
    map.set(id, typeof title.title === 'string' ? title.title : null)
  }
  return map
}

export function apply(ctx) {
  // 两个可选服务都等就绪再注册：晚到不会让工具永久消失，永不到就整体静默降级。
  ctx.inject(['tools', 'sessionQuery'], (ready) => {
    const tools = ready.get('tools')
    const sessionQuery = ready.get('sessionQuery')
    if (!tools || !sessionQuery) return
    registerTools(ready, tools, sessionQuery)
  })
}

function registerTools(ctx, tools, sessionQuery) {
  // 跨会话内容检索。返回值恒为 JSON 可序列化对象：{ ok:true, ... } 或 { ok:false, error, errorText }，
  // 绝不抛未捕获异常（与 session-admin.js / peer-message.js 同风格）。
  async function searchSessions(args) {
    const raw = args === undefined || args === null ? {} : args
    const query = typeof raw.query === 'string' ? raw.query.trim() : ''
    if (query.length === 0) {
      return { ok: false, error: 'EMPTY_QUERY', errorText: 'query 不能为空：请给出要检索的字面文本（大小写不敏感、空白灵活，多词之间按空白切分后逐词匹配）' }
    }
    if (query.length > MAX_QUERY_CHARS) {
      return { ok: false, error: 'QUERY_TOO_LONG', errorText: 'query 过长（上限 ' + MAX_QUERY_CHARS + ' 字符）：本工具是字面扫描，不是查询语言' }
    }
    const since = parseSince(raw.since)
    if (!since.ok) {
      return { ok: false, error: 'INVALID_SINCE', errorText: 'since 无法解析：请给 ISO 8601 字符串（如 2026-10-01T00:00:00Z）或毫秒时间戳' }
    }
    const cwdFilter = typeof raw.cwd === 'string' && raw.cwd.trim().length > 0 ? raw.cwd.trim() : undefined
    const maxSessions = clampInt(raw.maxSessions, DEFAULT_MAX_SESSIONS, HARD_MAX_SESSIONS, 1)
    const perSession = clampInt(raw.perSession, DEFAULT_PER_SESSION, HARD_PER_SESSION, 1)
    const limit = clampInt(raw.limit, DEFAULT_LIMIT, HARD_LIMIT, 1)
    const surfacesResult = parseSurfaces(raw.surfaces)
    if (!surfacesResult.ok) {
      return { ok: false, error: 'INVALID_SURFACES', errorText: surfacesResult.errorText }
    }
    const surfaces = surfacesResult.value

    // ① 会话发现 + 元数据过滤（全部在 header 上，不读事件日志）。
    let rows
    try {
      rows = await sessionQuery.listSessions()
    } catch (error) {
      return { ok: false, error: 'LIST_FAILED', errorText: 'listSessions() 失败，无法枚举会话：' + describe(error) }
    }
    if (!Array.isArray(rows)) {
      return { ok: false, error: 'UNEXPECTED_SHAPE', errorText: 'listSessions() 未返回数组（实际 ' + typeof rows + '）：内核契约与预期不符' }
    }
    const available = rows.filter((row) => row !== null && row !== undefined && row.header !== null && row.header !== undefined)
    const selected = available.filter((row) => {
      if (cwdFilter !== undefined && row.header.cwd !== cwdFilter) return false
      if (since.value !== undefined) {
        const createdAt = typeof row.header.createdAt === 'number' ? row.header.createdAt : 0
        if (createdAt < since.value) return false
      }
      return true
    })
    // 最新在前（与 listSessions 的既有顺序一致，显式排一次以免依赖上游顺序）。
    selected.sort((left, right) => (right.header.createdAt ?? 0) - (left.header.createdAt ?? 0))
    const scanned = selected.slice(0, maxSessions)
    const sessionsSkipped = selected.length - scanned.length

    // ② 逐会话字面扫描（多子句 = AND：text ∧ surface）。
    const hitsBySession = []
    let totalHits = 0
    let stoppedByLimit = false
    for (const row of scanned) {
      if (totalHits >= limit) { stoppedByLimit = true; break }
      const sessionId = String(row.header.id)
      let hits
      try {
        hits = await sessionQuery.filterEvents(sessionId, [
          { kind: 'text', text: query },
          { kind: 'surface', values: surfaces },
        ])
      } catch (error) {
        // 单会话失败不终止整轮：把它作为该会话的结构化错误上报（A 要求「失败须带类型化 code」）。
        hitsBySession.push({ sessionId, header: row.header, live: row.live === true, persisted: row.persisted === true, error: 'FILTER_FAILED', errorText: describe(error), matchCount: 0, matches: [], matchesTruncated: false })
        continue
      }
      const list = Array.isArray(hits) ? hits : []
      if (list.length === 0) continue
      // limit 是**总**命中条数上限：这里必须按剩余额度截断，否则最后一个会话会把总数顶破 limit。
      const remaining = limit - totalHits
      if (remaining <= 0) { stoppedByLimit = true; break }
      const take = list.slice(0, Math.min(perSession, remaining))
      if (take.length < list.length) stoppedByLimit = true
      totalHits += take.length
      hitsBySession.push({
        sessionId,
        header: row.header,
        live: row.live === true,
        persisted: row.persisted === true,
        matchCount: list.length,
        matchesTruncated: list.length > take.length,
        matches: take.map((hit) => ({
          seq: hit.seq,
          type: hit.type,
          time: hit.time,
          surface: hit.surface,
          snippet: snippetOf(hit.text, query),
        })),
      })
    }

    // ③ 标题：只对真有命中的会话批量取（省一次全量遍历）。
    let titles = new Map()
    if (hitsBySession.length > 0) {
      try {
        titles = titleMapOf(await sessionQuery.readTitleSnapshots(hitsBySession.map((entry) => entry.sessionId)))
      } catch (error) {
        titles = new Map()
        void error // 标题是装饰信息：取不到就用 null 表达，不影响命中结果本身。
      }
    }

    const returnedMatches = hitsBySession.reduce((sum, entry) => sum + entry.matches.length, 0)
    const payload = {
      ok: true,
      query,
      filters: { cwd: cwdFilter ?? null, since: since.value ?? null },
      surfaces,
      scanned: { sessionsAvailable: available.length, sessionsMatchedFilters: selected.length, sessionsScanned: scanned.length, sessionsSkipped, maxSessions },
      returned: { matches: returnedMatches, sessions: hitsBySession.length, limit, perSession },
      truncated: { sessions: sessionsSkipped > 0, matches: stoppedByLimit || hitsBySession.some((entry) => entry.matchesTruncated === true) },
      sessions: hitsBySession.map((entry) => ({
        sessionId: entry.sessionId,
        title: titles.get(entry.sessionId) ?? null,
        cwd: entry.header.cwd ?? null,
        createdAt: entry.header.createdAt ?? null,
        origin: entry.header.origin ?? null,
        live: entry.live,
        persisted: entry.persisted,
        matchCount: entry.matchCount,
        matchesTruncated: entry.matchesTruncated,
        ...entry.error === undefined ? {} : { error: entry.error, errorText: entry.errorText },
        matches: entry.matches,
      })),
    }
    // 空结果语义：ok:true 且 returned.matches === 0 = 「扫描完成、确实没命中」，
    // 与上面任何 { ok:false } 的失败明确区分（调用方不必靠猜）。
    const surfaceNote = '按 surface=' + surfaces.join('+') + ' 过滤（默认 current+shadowed：含已被压缩出上下文的历史；log-only 是原始日志噪声，默认排除）。'
    payload.note = returnedMatches === 0
      ? '扫描完成，未命中任何内容（这是正常空结果，不是失败）。本工具按字面扫描 semantic text，' + surfaceNote
      : 'seq 是事件在会话日志里的坐标 —— 宿主会话读取工具正是吃这两个值（sessionId + seq）；本包自身不暴露读取工具。' + surfaceNote
    return payload
  }

  const searchTool = defineTool({
    name: 'search_sessions',
    description: '跨会话按内容检索历史会话（字面扫描，不依赖全文检索索引）。行为：listSessions() → 按 cwd/since 过滤元数据 → 逐会话对提取后的语义文本做字面匹配（大小写不敏感、空白灵活）→ 返回命中的会话标题、事件坐标（sessionId + seq —— 宿主会话读取工具正是吃这两个值；本包自身不暴露读取工具）与片段。**默认返回 surface=current 与 shadowed 的事件**（shadowed = 已被后续快照取代/压缩出上下文的历史，正是「找回」最该覆盖的部分），默认排除 log-only（从未上过任何面的原始日志噪声）；可用 surfaces 参数显式指定子集。空结果 = ok:true 且 returned.matches 为 0（不是失败）。有扫描上限：默认最多扫 50 个会话（硬顶 200）、每会话最多 5 条命中（硬顶 20）、总命中最多 20 条（硬顶 100）；被截断时 truncated.sessions / truncated.matches 为 true。任何失败都返回 { ok:false, error:<类型化 code>, errorText }，不抛异常。',
    parameters: {
      query: { type: 'string', required: true, description: '要检索的字面文本。大小写不敏感、空白灵活（多词之间按空白切分后按顺序匹配）；不做正则、不做布尔语法。上限 200 字符' },
      cwd: { type: 'string', description: '可选：只检索该工作目录下的会话（与会话 header 的 cwd 精确相等）' },
      since: { type: 'string', description: '可选：只检索该时刻之后创建的会话。ISO 8601 字符串（如 2026-10-01T00:00:00Z）或毫秒时间戳' },
      limit: { type: 'number', description: '可选：最多返回多少条命中（默认 20，硬顶 100）' },
      perSession: { type: 'number', description: '可选：每个会话最多返回多少条命中（默认 5，硬顶 20）' },
      maxSessions: { type: 'number', description: '可选：最多扫描多少个会话（默认 50，硬顶 200）。会话按创建时间从新到旧扫描' },
      surfaces: { type: 'array', description: '可选：只回哪些事件面，取值子集来自 current / shadowed / log-only。默认 ["current","shadowed"]（含被压缩出上下文的历史，排除原始日志噪声）。显式传即完全按此过滤；空数组或非法值报 INVALID_SURFACES' },
    },
    output: {
      schema: { type: 'json' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      try {
        return await searchSessions(args)
      } catch (error) {
        // 兜底：任何未预期异常也变成结构化错误，不砸崩调用方会话。
        return { ok: false, error: 'UNEXPECTED', errorText: describe(error) }
      }
    },
  })
  tools.register(searchTool)
}

export { describe, parseSince, parseSurfaces, snippetOf, titleMapOf }
