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
//  · `readSurface(id)` 返回**只含 current 面**的事件（{ session, inheritedEventCount,
//    capturedThroughSeq, events }；events = currentSeqs 上逐个 snapshot 的事件，逐字段保留 data）。
//    它是取回事件 `data.source` 的唯一可负担路径：一次调用覆盖整个会话（#155-B 实测 48 个会话
//    总 6,951 ms、最大 2,441 ms；60MB 会话 1,232 ms / 9.26 MB），而逐命中 readEvent ≈1,092 ms/条
//    （#154-B）⇒ 成本在**会话数**、不在命中条数。**但它只覆盖 current 面**：shadowed / log-only
//    的命中在里面查不到（#155-B 负向对照：某会话 9,311 条 shadowed 命中在面内 0 条）⇒
//    senders 过滤对非 current 面命中只能标「来源未知」，不能假装判定了。
//  · 事件来源（「谁发的」）唯一字段 = `data.source.senderSessionId`，判别键 `source.kind`；
//    本部署 491 条 user-message 实测只有 agent-message / subagent-settled 两种 kind 带它，
//    **没有任何 kind 提供发送者名字**（真源 packages/session/session-format-v2-to-v3/src/payload.ts
//    第 115-118 行：agent-message 的强制键就三键 kind / form / senderSessionId）。
//  · `surface` 枚举（SessionEventSurface）= current / shadowed / log-only，见 packages/session-query/
//    session-query/src/types.ts 第 23-24 行；classifySurface 在同包 src/documents.ts 第 57-78 行。
//    current = 当前模型上下文；**shadowed = 已被后续快照取代/压缩掉的历史**（正是「找回」最该覆盖
//    的那部分，它已经不在模型上下文里了）；log-only = 从未上过任何面的原始日志（工具管道噪声）。
//  · ⇒ 默认 surfaces = ['current','shadowed']（排除 log-only）。实测（同一 query 'session-toolkit'
//    在 60MB 会话上）：current 349 条 / shadowed 9311 条 / log-only 6969 条，全量 16629 条
//    ⇒ 只取 current 会丢掉约 96% 的命中。调用方可用 `surfaces` 参数显式指定子集。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { originGuard } from './request-guard.js'

// 本模块不需要任何「几乎必有」的宿主服务：sessionQuery 与 tools 都在 apply 之后
// 用 ctx.inject 等它就绪（缺失时本模块静默不注册工具，不拖垮整包）。
export const inject = []

// 只读检索路由：把**同一套**检索（`runSearch` 的载荷，与模型工具逐字节相同）以 GET + JSON 暴露给
// 浏览器半（client 检索面板）。为什么走原始路由而不是 `ctx.remote`：宿主的 remote 消费端是 **build
// 期生成**的 wire 描述符，namespace 硬编码在宿主 packages/api/remotes/src/client/index.ts 的一组静态
// import 里 ⇒ 外部 npm 包进不去（C 侦察结论 + A 裁定）。故可用通道只有 `webServer.register` 的原始
// 路由 —— 与 STATE_ROUTE 同一机制、同一道 originGuard（原始路由绕过了 harness 覆盖 `/api/` 前缀的
// 鉴权网关，这道守卫不可省）。
export const SEARCH_ROUTE = '/api/session-toolkit/search'

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

// `senders`（可选）：按「事件来源会话」过滤命中。语义写死为**匹配 `source.senderSessionId`** ——
// 本部署的 agent 间消息来源只有这一个字段（真源 packages/session/session-format-v2-to-v3/src/
// payload.ts 第 115-118 行：`agent-message` 的强制键就是 kind / form / senderSessionId 三键，**无名字**）。
// 实测（#155-B：48 个会话 / 491 条 user-message）：带 senderSessionId 的 kind 只有两种 ⇒ 白名单；
// 其余 kind 值按非法值报错，不静默返回 0 命中（那等于向调用方承诺一个永远 0 命中的入口）。
const SENDER_KINDS = ['agent-message', 'subagent-settled']
const HARD_SENDERS = 10
// 来源映射的时间预算（毫秒，模块常量、不设配置旋钮）：超时即停止对后续会话调 readSurface，
// 未查的命中按「查不到」处理（保留 + sender:null），并响亮置 sendersPartial / sendersSkippedSessions。
const SENDER_BUDGET_MS = 5000
// 会话 id 形态。**两个世代并存**（#166-B 实测：会话存储目录名下 `session-` 前缀 9 个、裸 UUID 45 个，
// 同 lib/peer-message.js:55-59 的实测）：既可能是裸 UUID，也可能是 `session-<uuid>` 形态。
// 本正则**同时接受**两者 —— 只接受裸 UUID 时，调用方传裸 UUID 而事件侧的
// `source.senderSessionId` 是带前缀形态，`includes` 恒 false ⇒ 指定的来源被**静默全丢**、
// 却仍返回 ok:true（假阴性比报错危险得多）。
// 它仍不是「谁发的」的语义判据，只是把「既不是会话 id、也不是白名单 kind」的取值判成非法值 ——
// 否则任意字符串都会变成一个看似合法、实际永远匹配不到的 sender。
const SESSION_ID_RE = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

// 会话 id 的**规范化**（#166-B 裁定 A2）：去可选 `session-` 前缀 + 折叠小写。调用方参数侧
// （parseSenders）与事件来源侧（④ 过滤段）**都**过它 ⇒ 传 `session-<uuid>` 与传 `<uuid>`
// 选中的是同一批命中（两种写法的过滤结果逐字节相同）。
// ⚠ 它只用于**比较**：载荷回显保持调用方传入的原串（按规范化去重、保留首次出现的原串），
// 否则调用方回读到的就不再是自己写下的值（裁定 A2 第二句）。
function normalizeSenderId(value) {
  return value.toLowerCase().replace(/^session-/u, '')
}

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

// `senders`（可选）：显式传即按来源过滤命中的**事件**。语义 = 匹配 `source.senderSessionId`
// （会话 id，大小写不敏感），另接受两个白名单 kind（agent-message / subagent-settled）。
// 不传 ⇒ 不过滤，且**零额外内核调用**（默认行为与引入本参数之前逐字节相同）。
// 非法值 / 空数组 / 超上限一律结构化错误：调用方给了明确过滤意图时，静默忽略比报错危险得多。
function parseSenders(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (!Array.isArray(raw)) {
    return { ok: false, errorText: 'senders 必须是数组（元素 = 来源会话 id，或 ' + SENDER_KINDS.join(' / ') + ' 之一）' }
  }
  // 比较用（规范化）与回显用（原串）**分列**（#166-B 裁定 A2）：
  //   · ids / kinds      ⇒ 供 ④ 段比较（小写、id 去前缀）；两条路径都过 normalizeSenderId
  //   · idEcho / kindEcho ⇒ 供载荷回显**调用方传入的原串** —— 不得把回显改成规范化值，
  //     否则调用方回读到的（如裸 UUID）会与他写下的不同。
  const ids = []
  const kinds = []
  const idEcho = []
  const kindEcho = []
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { ok: false, errorText: 'senders 只能含字符串：元素 = 来源会话 id，或 ' + SENDER_KINDS.join(' / ') + ' 之一' }
    }
    const literal = item.trim()
    if (literal.length === 0) {
      return { ok: false, errorText: 'senders 不能含空字符串：元素 = 来源会话 id，或 ' + SENDER_KINDS.join(' / ') + ' 之一' }
    }
    // 去重键按**规范化**算（`id:` / `kind:` 前缀把两个 key 空间分开），于是同一来源的
    // `<uuid>` 与 `session-<uuid>`、`agent-message` 与 `AGENT-MESSAGE` 各只保留首次出现的原串。
    const folded = literal.toLowerCase()
    if (SENDER_KINDS.includes(folded)) {
      if (seen.has('kind:' + folded)) continue
      seen.add('kind:' + folded)
      kinds.push(folded)
      kindEcho.push(literal)
      continue
    }
    if (SESSION_ID_RE.test(folded)) {
      const normalized = normalizeSenderId(folded)
      if (seen.has('id:' + normalized)) continue
      seen.add('id:' + normalized)
      ids.push(normalized)
      idEcho.push(literal)
      continue
    }
    return { ok: false, errorText: 'senders 含非法值 ' + JSON.stringify(item) + '：只能是来源会话 id（<uuid> 或 session-<uuid> 形态），或 ' + SENDER_KINDS.join(' / ') + '；本部署不存在的 kind（如 team-message）不接受' }
  }
  const total = ids.length + kinds.length
  if (total === 0) {
    return { ok: false, errorText: 'senders 不能为空数组：至少要给一个来源会话 id 或 ' + SENDER_KINDS.join(' / ') }
  }
  if (total > HARD_SENDERS) {
    return { ok: false, errorText: 'senders 过多（去重后 ' + total + ' 个，上限 ' + HARD_SENDERS + ' 个）' }
  }
  return { ok: true, value: { ids, kinds, idEcho, kindEcho } }
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

// `since` 解析器接受数字（毫秒时间戳）或 ISO 8601 字符串（也接受纯数字字符串）。
// ⚠ 两条外部边界上都只有字符串可达：工具边界声明是 `type: 'string'`，裸数字在边界即被 ToolArgsError 拒掉
// （见 scripts/session-search.assert.mjs 的 A5 与 M18）；路由边界走 URL query，`params.get()` 恒返回字符串。
// ⇒ 第 109 行的数字分支只有**直接调用 `parseSince`**（本模块导出，供门与测试复用）才可达，保留它与此边界无关。
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

// 来源映射：一次 `readSurface(sessionId)` 拿到该会话 **current 面**的全部事件，抽出
// `seq → { sender, kind }`（sender = `data.source.senderSessionId`，缺失记 null）。
// 为什么必须逐会话一次、而不是逐命中 `readEvent`：`readEvent` 单条实测约 1,092 ms（#154-B 探针），
// 而 `readSurface` 一次 1 ~ 1,232 ms 就覆盖整个会话（#155-B 探针）—— 成本在**会话数**，不在命中条数。
// events 只在本函数内驻留（返回的是轻量 Map）⇒ 大会话（单次 9.26 MB）不会被攒在调用方。
// 只读，零写入：不写任何会话日志、不写任何文件。
async function senderIndexFor(sessionQuery, sessionId) {
  const surface = await sessionQuery.readSurface(sessionId)
  const events = surface !== null && typeof surface === 'object' && Array.isArray(surface.events) ? surface.events : []
  const index = new Map()
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (typeof event.seq !== 'number') continue
    const data = event.data
    const source = data !== null && typeof data === 'object' ? data.source : undefined
    // kind **取值即折叠小写**（#166-B 裁定 A3）：④ 段的比较表达式按门的负向对照靶串原样保留
    // （它锚在整行上，改写一个字符就会让负向对照装置跑不成 ⇒ rc=2），所以大小写不敏感必须
    // 落在**取值侧**，与 parseSenders 对调用方侧的折叠对称（Agent-Message ≡ agent-message）。
    // #166-B 前本部署 kind 全小写 ⇒ 该不对称不可触发，属静默待改项。
    const kind = source !== null && typeof source === 'object' && typeof source.kind === 'string' ? source.kind.toLowerCase() : null
    const sender = source !== null && typeof source === 'object' && typeof source.senderSessionId === 'string' && source.senderSessionId.length > 0 ? source.senderSessionId : null
    index.set(event.seq, { sender, kind })
  }
  return index
}

export function apply(ctx) {
  // 两个可选服务都等就绪再注册：晚到不会让工具永久消失，永不到就整体静默降级。
  ctx.inject(['tools', 'sessionQuery'], (ready) => {
    const tools = ready.get('tools')
    const sessionQuery = ready.get('sessionQuery')
    if (!tools || !sessionQuery) return
    registerTools(ready, tools, sessionQuery)
  })

  // 路由与工具**各自独立 inject**：缺 webServer 只丢路由、缺 sessionQuery 只丢工具，互不牵连
  // （可选服务缺失一律安静降级，不得让插件整体报错）。
  ctx.inject(['sessionQuery', 'webServer'], (ready) => {
    const webServer = ready.get('webServer')
    const sessionQuery = ready.get('sessionQuery')
    if (!webServer || !sessionQuery) return
    registerSearchRoute(ready, webServer, sessionQuery)
  })
}

// 跨会话内容检索。返回值恒为 JSON 可序列化对象：{ ok:true, ... } 或 { ok:false, error, errorText }，
// 绝不抛未捕获异常（与 session-admin.js / peer-message.js 同风格）。
// **两条边界共用本函数**：模型工具 search_sessions 与只读路由 SEARCH_ROUTE ⇒ 两者的 JSON 载荷
// 逐字节相同（路由的 URL query 由 argsFromSearchUrl 转成同形 args，见文件末尾）。
async function runSearch(sessionQuery, args) {
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
    return { ok: false, error: 'INVALID_SINCE', errorText: 'since 无法解析：请给 ISO 8601 字符串或纯数字的毫秒时间戳字符串（如 2026-10-01T00:00:00Z 或 "1759276800000"）' }
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
  // senders 缺省 ⇒ senderFilter 为 null ⇒ 下面整段来源映射不执行（零额外内核调用）。
  const sendersResult = parseSenders(raw.senders)
  if (!sendersResult.ok) {
    return { ok: false, error: 'INVALID_SENDERS', errorText: sendersResult.errorText }
  }
  const senderFilter = sendersResult.value

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
  let hitsBySession = []
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
      // `hits` 是内部字段（不进载荷）：senders 过滤要用原始命中的 seq/surface 逐条判定。
      hits: take,
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

  // ④ 来源过滤（仅在显式传了 senders 时执行；senderFilter 为 null 时本节一个内核调用都不加）。
  //    设计要点 —— **保留的是「查不到」，丢弃的是「确定不是」**，两类计数分列，
  //    绝不把「近似过滤」伪装成「全量过滤」（这是 A 裁定 #157 ② 的硬口径）：
  //      · 非 current 面命中（shadowed / log-only）、超时未查会话的命中、映射里缺该 seq 的命中
  //        ⇒ 一律**保留** + `sender: null`，计入 `sendersUnfiltered`（查不到，不是「没有发送者」）
  //      · current 面命中但映射里**没有** senderSessionId（user / time-context / plugin:* 等）
  //        ⇒ **丢弃**，计入 `senderlessExcluded`（它们确定不是来自任何会话）
  //      · current 面命中且有 senderSessionId ⇒ 命中 ids 或 kinds 才保留（载荷给 `sender:"<id>"`），
  //        否则丢弃（既有来源、但不是调用方要的）
  let senderlessExcluded = 0
  let sendersUnfiltered = 0
  let sendersSkippedSessions = 0
  let sendersPartial = false
  if (senderFilter !== null) {
    const startedAt = Date.now()
    const indexBySession = new Map()
    const skippedSessions = new Set()
    for (const entry of hitsBySession) {
      // 预算：一旦超时就**不再**对后续会话调 readSurface（顺序即既有会话序），但继续把未覆盖的
      // 会话数点出来 —— 超时必须响亮，不许安静降级成「过滤生效」。
      if (Date.now() - startedAt >= SENDER_BUDGET_MS) {
        skippedSessions.add(entry.sessionId)
        sendersSkippedSessions += 1
        sendersPartial = true
        continue
      }
      try {
        indexBySession.set(entry.sessionId, await senderIndexFor(sessionQuery, entry.sessionId))
      } catch (error) {
        // 单会话 readSurface 失败 ⇒ 该会话按「查不到」处理（保留 + sender:null），不终止整轮。
        skippedSessions.add(entry.sessionId)
        sendersSkippedSessions += 1
        sendersPartial = true
        void error
      }
    }
    const keptSessions = []
    for (const entry of hitsBySession) {
      if (entry.error !== undefined) { keptSessions.push({ entry, matches: entry.matches }); continue }
      const index = indexBySession.get(entry.sessionId)
      const unqueryable = skippedSessions.has(entry.sessionId) || index === undefined
      const source = Array.isArray(entry.hits) ? entry.hits : []
      const keptMatches = []
      for (const hit of source) {
        const found = unqueryable || hit.surface !== 'current' ? undefined : index.get(hit.seq)
        let sender = null
        if (found === undefined) {
          sendersUnfiltered += 1
        } else if (found.sender === null) {
          senderlessExcluded += 1
          continue
        } else {
          // 事件侧来源也过规范化（去前缀 + 小写）：与 senderFilter.ids（同样规范化）可比
          // ⇒ 传 `session-<uuid>` 与传 `<uuid>` 结果相同（#166-B 裁定 A2）。
          const folded = normalizeSenderId(found.sender)
          const matched = senderFilter.ids.includes(folded) || (found.kind !== null && senderFilter.kinds.includes(found.kind))
          if (!matched) continue
          sender = found.sender
        }
        const hitSurface = hit.surface
        keptMatches.push({
          seq: hit.seq,
          type: hit.type,
          time: hit.time,
          surface: hitSurface,
          sender,
          snippet: snippetOf(hit.text, query),
        })
      }
      // 过滤后一条不剩的会话不再出现在载荷里（否则会返回一个「有会话、有 matchCount、却零命中」的
      // 误导条目）。注意 matchCount 仍是**内核报告的命中数**，它表达「内核命中了多少」而不是
      // 「过滤后剩多少」—— 后者的权威读数是 returned.matches。
      if (keptMatches.length === 0) continue
      keptSessions.push({ entry, matches: keptMatches })
    }
    hitsBySession = keptSessions.map((item) => Object.assign({}, item.entry, { matches: item.matches }))
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
  // senders 相关键**只在显式传了 senders 时出现** —— 不传时载荷与引入本参数之前逐字节相同
  // （键集合也不变），这是 A 裁定 #157 ② 的「无回归硬边界」。
  if (senderFilter !== null) {
    payload.senders = senderFilter.idEcho.concat(senderFilter.kindEcho)
    // ↑ 回显**原串**（idEcho / kindEcho），不是比较用的规范化值（#166-B 裁定 A2）。
    // ⚠ 上面 `if (…) {` 与 `payload.senders =` 之间**不得插入任何行**：门 B9 的负向对照
    //   C3/C8 靶串正是这两行的连续文本，插一行注释就会让装置跑不成（rc=2）—— 我第一版这么踩过。
    payload.sendersUnfiltered = sendersUnfiltered
    payload.senderlessExcluded = senderlessExcluded
    payload.sendersPartial = sendersPartial
    payload.sendersSkippedSessions = sendersSkippedSessions
  }
  // 空结果语义：ok:true 且 returned.matches === 0 = 「扫描完成、确实没命中」，
  // 与上面任何 { ok:false } 的失败明确区分（调用方不必靠猜）。
  const surfaceNote = '按 surface=' + surfaces.join('+') + ' 过滤（默认 current+shadowed：含已被压缩出上下文的历史；log-only 是原始日志噪声，默认排除）。'
  // senders 生效时，note 必须把「这是近似过滤」说透：只有 current 面命中能判定来源，非 current 面
  // 与超时未查的部分会被保留但来源未知。不这样写，调用方会把「返回的就是某人的全部消息」当成事实。
  const senderNote = senderFilter === null ? '' : '按 senders=' + payload.senders.join('+') + ' 过滤来源（匹配 source.senderSessionId）。**这是近似过滤**：只有 current 面命中能判定来源，'
    + (sendersUnfiltered > 0 ? sendersUnfiltered + ' 条命中来源未知已保留（sender:null）' : '本次没有来源未知的命中')
    + (senderlessExcluded > 0 ? '；另有 ' + senderlessExcluded + ' 条确定不是来自任何会话、已丢弃' : '')
    + (sendersPartial ? '；⚠ 超过 ' + SENDER_BUDGET_MS + ' ms 预算，有 ' + sendersSkippedSessions + ' 个会话未做来源判定（其命中按「来源未知」保留，sendersPartial=true）' : '')
    + '。'
  payload.note = returnedMatches === 0
    ? '扫描完成，未命中任何内容（这是正常空结果，不是失败）。本工具按字面扫描 semantic text，' + surfaceNote + senderNote
    : 'seq 是事件在会话日志里的坐标 —— 宿主会话读取工具正是吃这两个值（sessionId + seq）；本包自身不暴露读取工具。' + surfaceNote + senderNote
  return payload
}

function registerTools(ctx, tools, sessionQuery) {
  const searchTool = defineTool({
    name: 'search_sessions',
    description: '跨会话按内容检索历史会话（字面扫描，不依赖全文检索索引）。行为：listSessions() → 按 cwd/since 过滤元数据 → 逐会话对提取后的语义文本做字面匹配（大小写不敏感、空白灵活）→ 返回命中的会话标题、事件坐标（sessionId + seq —— 宿主会话读取工具正是吃这两个值；本包自身不暴露读取工具）与片段。**默认返回 surface=current 与 shadowed 的事件**（shadowed = 已被后续快照取代/压缩出上下文的历史，正是「找回」最该覆盖的部分），默认排除 log-only（从未上过任何面的原始日志噪声）；可用 surfaces 参数显式指定子集。还可用 **senders** 参数按「来源会话」过滤命中（来源 = 事件的 source.senderSessionId，本部署唯一表达「谁发的」的字段；元素 = 来源会话 id 或 kind 白名单 agent-message / subagent-settled，大小写不敏感、去重、上限 10）。**senders 是近似过滤**：只有 current 面命中能判定来源 —— 非 current 面与超预算未查的命中会保留并标 sender:null（sendersUnfiltered = 查不到，不等于「没有发送者」），确定不是来自任何会话的命中被丢弃（senderlessExcluded = 确定不是），来源判定超 5000 ms 预算则 sendersPartial=true + sendersSkippedSessions=<n> 并停止后续会话（绝不安静降级）；不传 senders 时零额外内核调用、载荷与不传时逐字节相同。空结果 = ok:true 且 returned.matches 为 0（不是失败）。有扫描上限：默认最多扫 50 个会话（硬顶 200）、每会话最多 5 条命中（硬顶 20）、总命中最多 20 条（硬顶 100）；被截断时 truncated.sessions / truncated.matches 为 true。任何失败都返回 { ok:false, error:<类型化 code>, errorText }，不抛异常。',
    parameters: {
      query: { type: 'string', required: true, description: '要检索的字面文本。大小写不敏感、空白灵活（多词之间按空白切分后按顺序匹配）；不做正则、不做布尔语法。上限 200 字符' },
      cwd: { type: 'string', description: '可选：只检索该工作目录下的会话（与会话 header 的 cwd 精确相等）' },
      since: { type: 'string', description: '可选：只检索该时刻之后创建的会话。ISO 8601 字符串（如 2026-10-01T00:00:00Z）；本参数只接受字符串 —— 裸毫秒数字在工具边界即被拒。' },
      limit: { type: 'number', description: '可选：最多返回多少条命中（默认 20，硬顶 100）' },
      perSession: { type: 'number', description: '可选：每个会话最多返回多少条命中（默认 5，硬顶 20）' },
      maxSessions: { type: 'number', description: '可选：最多扫描多少个会话（默认 50，硬顶 200）。会话按创建时间从新到旧扫描' },
      surfaces: { type: 'array', description: '可选：只回哪些事件面，取值子集来自 current / shadowed / log-only。默认 ["current","shadowed"]（含被压缩出上下文的历史，排除原始日志噪声）。显式传即完全按此过滤；空数组或非法值报 INVALID_SURFACES' },
      senders: { type: 'array', description: '可选：只保留来源 ∈ 该列表的命中（来源 = 事件的 source.senderSessionId，本部署唯一表达「谁发的」的字段）。元素 = 来源会话 id（UUID 形态，大小写不敏感），或 kind 白名单 agent-message / subagent-settled；去重、上限 10 个。**这是近似过滤**：只有 current 面命中能判定来源 —— 非 current 面（shadowed/log-only）与超时未查的命中会保留并标 sender:null（计入 sendersUnfiltered = 查不到）；确定不是来自任何会话的命中（user / time-context / plugin:* 等）丢弃并计入 senderlessExcluded = 确定不是。来源判定超 5000 ms 预算即停止后续会话，置 sendersPartial=true + sendersSkippedSessions=<n>（绝不安静降级）。非法值报 INVALID_SENDERS。不传 ⇒ 零额外内核调用，载荷与不传时逐字节相同' },
    },
    output: {
      schema: { type: 'json' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      try {
        return await runSearch(sessionQuery, args)
      } catch (error) {
        // 兜底：任何未预期异常也变成结构化错误，不砸崩调用方会话。
        return { ok: false, error: 'UNEXPECTED', errorText: describe(error) }
      }
    },
  })
  tools.register(searchTool)
}

// URL query → 与模型工具同形的 args。这里**只做类型转换，不做语义校验**：语义错误全部由
// `runSearch` 产出既有的结构化错误码 ⇒ 路由与工具的错误词表不会各写一份而漂移。
//  · q（必填）· cwd · since · limit · perSession · maxSessions · surfaces（逗号分隔子集）
//  · senders（逗号分隔列表：来源会话 id 或 agent-message / subagent-settled）—— 与模型工具同一个
//    参数、同一个解析函数（parseSenders），保证两条边界的语义与错误词表不会各写一份而漂移。
//  · 数值参数：URL 参数本质是字符串 ⇒ `Number()`；转不出有限数（如 'abc'）⇒ 传 NaN，由 `runSearch`
//    内的 clampInt 回落到默认值。**不新增错误码**（模块既有词表里没有 INVALID_LIMIT，而契约要求沿用）。
//  · surfaces= 空值 ⇒ `[]` ⇒ `runSearch` 按「空数组非法」报 INVALID_SURFACES（400），不是静默兜底。
export function argsFromSearchUrl(rawUrl) {
  const url = new URL(typeof rawUrl === 'string' && rawUrl.length > 0 ? rawUrl : '/', 'http://localhost')
  const params = url.searchParams
  const args = {}
  for (const [param, key] of [['q', 'query'], ['cwd', 'cwd'], ['since', 'since']]) {
    if (params.has(param)) {
      const value = params.get(param)
      if (value !== null) args[key] = value
    }
  }
  for (const key of ['limit', 'perSession', 'maxSessions']) {
    if (params.has(key)) {
      const value = params.get(key)
      if (value !== null) args[key] = Number(value)
    }
  }
  if (params.has('surfaces')) {
    const value = params.get('surfaces')
    if (value !== null) {
      args.surfaces = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
    }
  }
  if (params.has('senders')) {
    const value = params.get('senders')
    if (value !== null) {
      args.senders = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
    }
  }
  return args
}

// 只读检索路由的注册。结构与 STATE_ROUTE 一致：originGuard → 非 GET 405 → 200/400 + JSON。
// 本路由**零写操作**（该模块至今不写任何会话日志，也不写任何文件）。
function registerSearchRoute(ctx, webServer, sessionQuery) {
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: SEARCH_ROUTE,
    handler: (req, res) => {
      if (!originGuard(req, res, webServer.host)) return
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      // 响应写出失败（客户端先断开等）不得变成未捕获拒绝 ⇒ 统一走 send()，它自己吞掉写失败。
      const send = (status, body) => {
        try {
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        } catch (error) {
          void error
        }
      }
      void (async () => {
        let payload
        try {
          payload = await runSearch(sessionQuery, argsFromSearchUrl(req.url))
        } catch (error) {
          payload = { ok: false, error: 'UNEXPECTED', errorText: describe(error) }
        }
        if (payload === null || typeof payload !== 'object') {
          payload = { ok: false, error: 'UNEXPECTED', errorText: 'runSearch 未返回对象（实际 ' + typeof payload + '）' }
        }
        // 成功 200 / 失败 400：判据与模型工具同一个 ok 字段，不另设第二套判据。
        send(payload.ok === true ? 200 : 400, payload)
      })()
    },
  }), 'dsh-session-search: search route')
}

// SEARCH_ROUTE 与 argsFromSearchUrl 在定义处已 export。
export { describe, parseSince, parseSurfaces, parseSenders, snippetOf, titleMapOf }
