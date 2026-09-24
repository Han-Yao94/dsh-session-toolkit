#!/usr/bin/env node
/**
 * 尺子：**一条 peer 消息到底排队了没有？**
 *
 * ── 它回答什么 ─────────────────────────────────────────────────────────────
 * 给定会话日志 + 一条消息 id，回答三件事：
 *   ① 它落进哪条队列（`next-turn` / `next-step`）？
 *   ② 它被消费时是第几个 turn（以及相对 `turn/start` / `turn/end` 的位置）？
 *   ③ **从投递到消费之间有没有新的 `turn/start`** —— 有 ⇒ **排队了**；没有 ⇒ **插进了当前轮**。
 *
 * ── 判据从内核源码来（不是我发明的）──────────────────────────────────────────
 * `packages/experimental/agent-team/src/session-message.ts:12-19`：
 * ```ts
 * const inbox: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
 * for (const event of events) {
 *   if (event.type !== 'agent/inbox/spliced') continue
 *   const pending = inbox[event.data.target]
 *   pending.splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
 * }
 * ```
 * ⇒ 两条队列是**可折叠的投影**：`removedCount` = 本轮从**该队列头**取走了几条；
 *   `inserted` = 新插入的。**同一段日志折叠出的状态就是那一刻的真实队列。**
 *
 * ⚠️ 判"排队"用的是**投递瞬间的队列成员资格**（`inserted 之后的队列里还有没有排在它前面的东西`
 *    ＋ `消费时有没有新的 turn`），**不采信 `target` 字段的声明**——`target` 只作为**独立第二来源**
 *    与判定结果对照；两者矛盾时**报出来**（那说明"声明"与"行为"不一致，正是要抓的形态）。
 *
 * ── 三条硬规矩 ─────────────────────────────────────────────────────────────
 * · **退出码不混淆**：`0` = 判据跑成且被查对象**没有排队**（含"没找到该消息"以外的正常情形）；
 *   `1` = 判据跑成且**发现了缺陷**（该消息排队了）；**`2` = 这把尺子自己没跑成**
 *   （日志读不到 / 解不出事件 / id 不存在 / 队列折叠自检失败）。
 *   ⇒ **`2` 与 `0/1` 在语义上不可能混淆**：`1` 永远意味着"真的排队了"，不可能是"没跑成"。
 * · **多帧 zstd**：按 magic `28 b5 2f fd` 切帧、逐帧解、拼接（只解第一帧会得到假输入）。
 * · **只读**：只读磁盘上的日志，**不打任何端口**（尤其不碰活着的服务）。
 *
 * ── 已知不能判定的部分（诚实边界）──────────────────────────────────────────
 * · 若某消息 id 在日志里**只出现于 `inserted`、之后再无任何 `splice` 取走它**，则它**至今仍挂在队列里**
 *   （未消费）——本工具报 `pending`，**不**判"排队/插入"（那需要一次尚未发生的消费）。
 * · `session.v3.jsonl.zstd`（迁移前）**不适用**：那是冻结的旧世代格式。
 * · 消费点用**两种独立证据**交叉：`user/message` 事件（模型可见）与后续 splice 的 `removedCount`
 *   把它从队列头取走。两者缺一时按能拿到的那个判，并**显式标注**用了哪个。
 *
 * 用法：
 *   node scripts/inbox-queue.verify.mjs --log <session.v4.jsonl.zstd> --id <messageId> [--json]
 *   node scripts/inbox-queue.verify.mjs --session <sessionId> --id <messageId> [--json]
 *   node scripts/inbox-queue.verify.mjs --selftest [--log <session.v4.jsonl.zstd>]
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const EXIT = { OK: 0, DEFECT: 1, TOOL_FAILED: 2, USAGE: 64 }
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSIONS_ROOT = path.join(homedir(), '.dsh', 'sessions', '--Users-hanyao-dsh-session-toolkit--')

const usage = (out = console.error) => {
  out('用法：')
  out('  node scripts/inbox-queue.verify.mjs --log <session.v4.jsonl.zstd> --id <messageId> [--json]')
  out('  node scripts/inbox-queue.verify.mjs --session <sessionId> --id <messageId> [--json]')
  out('  node scripts/inbox-queue.verify.mjs --selftest [--log <session.v4.jsonl.zstd>]')
  out('')
  out('  --log <path>      会话日志路径（session.v4.jsonl.zstd）')
  out('  --session <id>    用 sessionId 定位日志（<会话根>/session-<id>/session.v4.jsonl.zstd）')
  out('  --id <messageId>  要问的 peer 消息 id（形如 peer-muck01kt-lf55qyrvma）')
  out('  --json            以 JSON 输出（便于下游脚本消费）')
  out('  --selftest        跑正反两方向的实例对照（排队 / 插进当前轮），不依赖外部参数')
  out('')
  out('回答：这条消息落进哪条队列 · 消费时是第几个 turn · **从投递到消费之间有没有新 turn**')
  out('')
  out('退出码：0 判据跑成且**没有排队** · 1 判据跑成且**排队了（缺陷）** · 2 **尺子自己没跑成** · 64 用法错')
  out('        ⇒ 1 永远意味"真的排队了"，不可能是"没跑成"（2 才是没跑成）')
}

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) { usage(console.log); process.exit(EXIT.OK) }
let logPath = null; let sessionId = null; let wantId = null; let asJson = false; let selftest = false
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  const next = () => { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) { console.error(`\`${a}\` 缺少值`); usage(); process.exit(EXIT.USAGE) } i += 1; return v }
  if (a === '--log') logPath = next()
  else if (a === '--session') sessionId = next()
  else if (a === '--id') wantId = next()
  else if (a === '--json') asJson = true
  else if (a === '--selftest') selftest = true
  else { console.error(`未知参数：${a}`); usage(); process.exit(EXIT.USAGE) }
}

/** 尺子自己没跑成。**永远走 2**，与"发现了缺陷"（1）在语义上分开。 */
const toolFailed = (why, detail) => {
  console.error(`⛔ 尺子没跑成（EXIT=${EXIT.TOOL_FAILED}）：${why}`)
  if (detail) console.error(`   ${detail}`)
  console.error('   ⚠️ 这不是"发现了缺陷"，也不是"通过"——**这次判定无效**。')
  process.exit(EXIT.TOOL_FAILED)
}

/** 多帧 zstd → 事件数组。只解第一帧会得到**假输入**（帧数会报出来）。 */
function readEvents(p) {
  if (!existsSync(p)) toolFailed('日志文件不存在', p)
  const st = statSync(p)
  const buf = readFileSync(p)
  const offsets = []
  let i = 0
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) { offsets.push(i); i += 4 }
  if (offsets.length === 0) toolFailed('一个 zstd 帧都没找到（magic 28 b5 2f fd 未命中）', p)
  let text = ''
  const failedFrames = []
  for (let k = 0; k < offsets.length; k += 1) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try { text += zlib.zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8') } catch (e) { failedFrames.push(k) }
  }
  const events = []
  let badLines = 0
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try { events.push(JSON.parse(line)) } catch { badLines += 1 }
  }
  if (events.length === 0) toolFailed(`解出 ${offsets.length} 帧但没有一条可解析事件`, `坏行 ${badLines}`)
  return { events, frames: offsets.length, failedFrames, badLines, size: st.size, mtime: st.mtime, bytes: buf.length }
}

/**
 * 把日志折叠成"每条消息在各时刻的队列状态"。
 * 严格照内核 `pendingInboxMessages`：`pending.splice(start, removedCount ?? 0, ...inserted)`。
 */
function foldInbox(events) {
  const queues = { 'next-turn': [], 'next-step': [] }
  const deliveries = new Map()   // id → { idx, seq, time, target, ackOfPromise }
  const consumptions = new Map() // id → { idx, seq, time, via }
  const anomalies = []
  for (let idx = 0; idx < events.length; idx += 1) {
    const e = events[idx]
    if (e.type !== 'agent/inbox/spliced') continue
    const target = e.data?.target
    if (target !== 'next-turn' && target !== 'next-step') { anomalies.push({ idx, seq: e.seq, why: `未知 target：${String(target)}` }); continue }
    const q = queues[target]
    const start = Number(e.data?.start ?? 0)
    const removed = Number(e.data?.removedCount ?? 0)
    if (start < 0 || start > q.length) anomalies.push({ idx, seq: e.seq, why: `start=${start} 超出队列长度 ${q.length}（target=${target}）` })
    const taken = q.splice(Math.min(start, q.length), removed)
    // 被 take 走的 = 本轮从该队列取走的消息 ⇒ 其消费时刻就是这一刻
    for (const m of taken) if (!consumptions.has(m.id)) consumptions.set(m.id, { idx, seq: e.seq, time: e.time, via: 'removed-by-splice', target })
    const inserted = Array.isArray(e.data?.inserted) ? e.data.inserted : []
    const queueBefore = [...q]   // 插入之前该队列余下的（= 排在插入者前面的）
    q.splice(Math.min(start, q.length), 0, ...inserted)
    for (const m of inserted) {
      if (deliveries.has(m.id)) continue
      deliveries.set(m.id, {
        idx, seq: e.seq, time: e.time, target,
        aheadInQueue: queueBefore.length,       // 投递瞬间排在它前面的条数
        sameBatch: inserted.length,
        insertedIds: inserted.map(x => x.id),
      })
    }
  }
  // 另一条独立证据：user/message 使其"模型可见"
  for (let idx = 0; idx < events.length; idx += 1) {
    const e = events[idx]
    if (e.type !== 'user/message') continue
    const id = e.data?.id
    if (typeof id !== 'string') continue
    // 只对"曾经被投递过"的 id 记账（用户自己的消息不算）
    if (!deliveries.has(id)) continue
    const cur = consumptions.get(id)
    if (cur === undefined || idx < cur.idx) consumptions.set(id, { idx, seq: e.seq, time: e.time, via: 'user/message', target: deliveries.get(id).target })
  }
  return { deliveries, consumptions, anomalies, queues }
}

/** 给定 idx 落在第几个 turn（turn/start 计数），以及是否处于一个 turn 之内。 */
function turnContext(events) {
  const starts = []
  for (let i = 0; i < events.length; i += 1) if (events[i].type === 'turn/start') starts.push(i)
  return (idx) => {
    let n = 0; let cur = -1
    for (const s of starts) { if (s <= idx) { n += 1; cur = s } else break }
    return { turnNumber: n, startedAtIdx: cur, insideTurn: cur !== -1 }
  }
}

/** 核心判定。返回 { verdict, ... } —— verdict ∈ {'queued','inserted','pending','unknown'} */
function judge({ events, deliveries, consumptions }, id) {
  const d = deliveries.get(id)
  if (d === undefined) return { verdict: 'unknown', why: '该 id 从未出现在任何 agent/inbox/spliced 的 inserted 里（不是本会话收过的 peer 消息？）' }
  const c = consumptions.get(id)
  const ctx = turnContext(events)
  const dctx = ctx(d.idx)
  if (c === undefined) {
    return {
      verdict: 'pending', delivery: d, deliveryTurn: dctx,
      why: '投递之后日志里再没有任何 splice 把它从队列取走，也没有 user/message ⇒ **至今仍挂在队列里（未消费）**',
      queueNow: true,
    }
  }
  const cctx = ctx(c.idx)
  // 从投递到消费之间，有没有新的 turn/start
  const newTurnsBetween = []
  for (let i = d.idx + 1; i <= c.idx; i += 1) if (events[i].type === 'turn/start') newTurnsBetween.push(i)
  // 投递时**有没有一个 turn 正在跑**（turn/start 在 turn/end 之后且未闭合）
  const lastStart = lastBefore(events, 'turn/start', d.idx)
  const lastEnd = lastBefore(events, 'turn/end', d.idx)
  const runningAtDelivery = lastStart !== -1 && (lastEnd === -1 || lastStart > lastEnd)
  const queued = newTurnsBetween.length > 0
  // ⚠️ 三值判定（不是二值）："无新 turn"只在**投递时真有轮在跑**时才等于"插进了正在执行的轮"。
  //    若投递时**没有轮在跑**，那它只是"在 idle 时被收下" —— 那**不是**需求要的效果，
  //    按二值判据会得**假绿**。故单列 `delivered-idle`，并计入"未达成目标"。
  const verdict = queued ? 'queued' : (runningAtDelivery ? 'inserted-live' : 'delivered-idle')
  const why = queued
    ? `投递（idx=${d.idx}）与消费（idx=${c.idx}）之间有 ${newTurnsBetween.length} 次新的 turn/start ⇒ **排队了**（等了一个新 turn 才被取用）`
    : runningAtDelivery
      ? `投递（idx=${d.idx}）时**有轮在跑**，且投递→消费（idx=${c.idx}）之间**没有**新的 turn/start ⇒ **真的插进了正在执行的那一轮**`
      : `投递（idx=${d.idx}）时**没有任何轮在跑**（最近一次 turn/end 在 idx=${lastEnd === -1 ? '—' : lastEnd}），之后也没有新 turn ⇒ 它只是**在 idle 时被收下**，`
        + `**不是**"插进正在执行的轮"。⚠️ 按"有无新 turn"的二值判据它会得**假绿**，故单列。`
  return {
    verdict,
    delivery: d, consumption: c, deliveryTurn: dctx, consumptionTurn: cctx,
    newTurnStartsBetween: newTurnsBetween.length,
    runningAtDelivery,
    lastTurnEndBeforeDelivery: lastEnd,
    betweenIdx: [d.idx, c.idx],
    why,
  }
}

const lastBefore = (events, type, idx) => {
  for (let i = Math.min(idx, events.length - 1); i >= 0; i -= 1) if (events[i].type === type) return i
  return -1
}

// ───────────────────────────────────────────────────────────── 自检
if (selftest) {
  const p = logPath ?? path.join(SESSIONS_ROOT, 'session-b31c1e22-eca3-4f5a-a2a0-031288df33e1', 'session.v4.jsonl.zstd')
  const meta = readEvents(p)
  const fold = foldInbox(meta.events)
  const T = (t) => new Date(t).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 19)
  console.log('「inbox 队列尺子」自检（inbox-queue.verify.mjs --selftest）')
  console.log(`  日志      ${p}`)
  console.log(`  指纹      ${meta.size} B · mtime ${T(meta.mtime.getTime())} · ${meta.frames} 帧（解出 ${meta.events.length} 事件）`)
  console.log(`  折叠      投递 ${fold.deliveries.size} 条 · 消费 ${fold.consumptions.size} 条 · 异常 ${fold.anomalies.length} 处`)
  console.log('')
  let bad = 0
  const check = (name, cond, detail) => { if (!cond) bad += 1; console.log(`  ${cond ? 'ok  ' : 'RED '} ${name}${detail ? '  ← ' + detail : ''}`) }

  // ⭐ 自保：折叠必须自洽（异常 0；否则判据建立在坏输入上）
  check('折叠自洽（无 start 越界 / 未知 target）', fold.anomalies.length === 0,
    fold.anomalies.length ? JSON.stringify(fold.anomalies.slice(0, 3)) : '')

  // ⭐⭐ 用**合成事件流**给两个方向各造一个实例 —— 自检**不能依赖本份日志恰好含有某种实例**，
  //    否则"数据里没有该情形"会被读成"判据有问题"（本份日志是**改动前**的，真插入实例本就应为 0）。
  //    合成流严格照内核语义：`pending.splice(start, removedCount ?? 0, ...inserted)`。
  const synth = {
    ok: (events) => foldInbox(events).anomalies.length === 0,
    /** queued：投递 → turn/end → turn/start → splice 取走 → user/message */
    queued: () => [
      { type: 'turn/start', seq: 1, time: 1000 },
      { type: 'agent/inbox/spliced', seq: 2, time: 1100, data: { target: 'next-step', start: 0, removedCount: 0, inserted: [{ id: 'M-Q', role: 'user', content: [] }] } },
      { type: 'turn/end', seq: 3, time: 1200 },
      { type: 'turn/start', seq: 4, time: 1300 },
      { type: 'agent/inbox/spliced', seq: 5, time: 1400, data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] } },
      { type: 'user/message', seq: 6, time: 1450, data: { id: 'M-Q' } },
    ],
    /** inserted-live：turn 在跑时投递 → 同一轮内（无新 turn）被取走 */
    live: () => [
      { type: 'turn/start', seq: 1, time: 1000 },
      { type: 'step/start', seq: 2, time: 1050 },
      { type: 'agent/inbox/spliced', seq: 3, time: 1100, data: { target: 'next-step', start: 0, removedCount: 0, inserted: [{ id: 'M-L', role: 'user', content: [] }] } },
      { type: 'step/end', seq: 4, time: 1150 },
      { type: 'step/start', seq: 5, time: 1200 },
      { type: 'agent/inbox/spliced', seq: 6, time: 1250, data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] } },
      { type: 'user/message', seq: 7, time: 1260, data: { id: 'M-L' } },
      { type: 'turn/end', seq: 8, time: 1300 },
    ],
    /** delivered-idle：无轮在跑时投递 → 无新 turn 就被取走（二值判据在此给假绿） */
    idle: () => [
      { type: 'turn/start', seq: 1, time: 1000 },
      { type: 'turn/end', seq: 2, time: 1100 },
      { type: 'agent/inbox/spliced', seq: 3, time: 1200, data: { target: 'next-step', start: 0, removedCount: 0, inserted: [{ id: 'M-I', role: 'user', content: [] }] } },
      { type: 'agent/inbox/spliced', seq: 4, time: 1300, data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] } },
      { type: 'user/message', seq: 5, time: 1350, data: { id: 'M-I' } },
    ],
  }
  const judgeSynth = (events, id) => judge({ events, ...foldInbox(events) }, id)
  const sQueued = judgeSynth(synth.queued(), 'M-Q')
  const sLive = judgeSynth(synth.live(), 'M-L')
  const sIdle = judgeSynth(synth.idle(), 'M-I')
  check('合成流折叠自洽（三条）', synth.ok(synth.queued()) && synth.ok(synth.live()) && synth.ok(synth.idle()))
  check('方向一「排队了」判为 queued（合成实例）', sQueued.verdict === 'queued',
    `实测 ${sQueued.verdict}（投递→消费间新 turn ${sQueued.newTurnStartsBetween} 次）`)
  check('方向二「真的插进正在执行的那一轮」判为 inserted-live（合成实例）', sLive.verdict === 'inserted-live',
    `实测 ${sLive.verdict}（投递时有轮在跑=${sLive.turnActiveAtDelivery ?? sLive.runningAtDelivery}，新 turn ${sLive.newTurnStartsBetween} 次）`)
  check('「idle 时被收下」单列为 delivered-idle（**不许**读成插入）', sIdle.verdict === 'delivered-idle',
    `实测 ${sIdle.verdict} ⇒ 二值判据在这里会得假绿，三值把它分出来了`)

  // ── 真实日志只作**分布报告**（不因"某种实例为 0"而失败：那要由被查数据决定，不由判据决定）
  const byV = { queued: [], 'inserted-live': [], 'delivered-idle': [], pending: [], unknown: [] }
  for (const id of fold.deliveries.keys()) {
    const r = judge({ events: meta.events, ...fold }, id)
    ;(byV[r.verdict] ?? (byV[r.verdict] = [])).push({ id, r })
  }
  console.log('')
  console.log('  ── 本份日志的实际分布（**只报告，不作自检判据**）──')
  console.log(`     queued ${byV.queued.length} · inserted-live ${byV['inserted-live'].length} · delivered-idle ${byV['delivered-idle'].length} · pending ${byV.pending.length} · unknown ${byV.unknown.length}`)
  if (byV.queued.length) console.log(`     例（queued）：${byV.queued[0].id}`)
  if (byV['inserted-live'].length) console.log(`     例（inserted-live）：${byV['inserted-live'][0].id}`)
  if (byV['delivered-idle'].length) console.log(`     例（delivered-idle）：${byV['delivered-idle'][0].id}`)
  console.log(`     ⚠️ 本份日志是**改动前**的 ⇒ inserted-live 应为 0；若改动后它仍为 0，说明改动没生效。`)

  // ⭐ 基线实例（**通用**）：从本份日志里挑**第一条被投递且已消费**的 next-turn 消息 ——
  //    不写死 id，换日志也能跑。（写死的那条是找不找得到的问题，不是判据问题。）
  const base = process.env.INBOX_BASE_ID
    ?? (fold.deliveries.keys().next().value ?? null)
  console.log('')
  if (base === null) {
    console.log('  info  本份日志里没有任何被投递的消息 ⇒ 跳过基线实例（不影响判据自检）')
  }
  const br = base === null ? null : judge({ events: meta.events, ...fold }, base)
  console.log('')
  if (br !== null) {
    console.log(`  ── 基线实例 ${base}（本份日志里的第一条投递）──`)
    console.log(`     投递 idx=${br.delivery?.idx} seq=${br.delivery?.seq} ${T(br.delivery?.time)} target="${br.delivery?.target}"`)
    console.log(`     消费 idx=${br.consumption?.idx} seq=${br.consumption?.seq} ${T(br.consumption?.time)} via=${br.consumption?.via}`)
    console.log(`     判定 ${br.verdict}（投递→消费间新 turn/start ${br.newTurnStartsBetween ?? '—'} 次）`)
    // 这是一个**真实实例**的读数（不是判据的自证 —— 自证已由上面的合成流完成）
    console.log(`     ⇒ 这是被查数据上的实测读数；它的具体结论由该条消息的实际情况决定，**不构成自检通过与否**。`)
    if (process.env.INBOX_BASE_ID) {
      check(`指定实例 ${base} 判为「排队了」（INBOX_BASE_ID 环境变量）`, br.verdict === 'queued', br.verdict)
    }
  }

  console.log('')
  if (bad === 0) {
    console.log('✅ 自检成立：判据**两个方向**都由合成实例证成（queued / inserted-live），'
      + '且把「idle 时被收下」单列为 delivered-idle（二值判据在那一格会给假绿）。')
    console.log(`   真实日志（改动前）分布：queued ${byV.queued.length} · inserted-live ${byV['inserted-live'].length} · `
      + `delivered-idle ${byV['delivered-idle'].length} · pending ${byV.pending.length} · unknown ${byV.unknown.length}`)
    process.exit(EXIT.OK)
  }
  console.error(`❌ 自检失败 ${bad} 项`)
  process.exit(EXIT.TOOL_FAILED)
}

// ───────────────────────────────────────────────────────────── 单条判定
if (logPath === null && sessionId !== null) {
  logPath = path.join(SESSIONS_ROOT, `session-${sessionId}`, 'session.v4.jsonl.zstd')
}
if (logPath === null) { console.error('缺 `--log` 或 `--session`'); usage(); process.exit(EXIT.USAGE) }
if (wantId === null) { console.error('缺 `--id`（要给一条消息 id）'); usage(); process.exit(EXIT.USAGE) }

const meta = readEvents(logPath)
const fold = foldInbox(meta.events)
if (fold.anomalies.length > 0) {
  toolFailed('队列折叠出现异常 ⇒ 判据建立在坏输入上，本次判定无效',
    JSON.stringify(fold.anomalies.slice(0, 5)))
}
const r = judge({ events: meta.events, ...fold }, wantId)
const T = (t) => new Date(t).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 19)

if (asJson) {
  console.log(JSON.stringify({ id: wantId, log: logPath, fingerprint: { size: meta.size, frames: meta.frames, events: meta.events.length }, ...r }, null, 2))
} else {
  console.log(`消息 ${wantId}`)
  console.log(`  日志    ${logPath}`)
  console.log(`  指纹    ${meta.size} B · ${meta.frames} 帧 · ${meta.events.length} 事件`)
  if (r.delivery) {
    console.log(`  投递    idx=${r.delivery.idx} seq=${r.delivery.seq} ${T(r.delivery.time)} target="${r.delivery.target}" 队列里排在它前面的条数=${r.delivery.aheadInQueue}（同批 ${r.delivery.sameBatch} 条）`)
  }
  if (r.consumption) {
    console.log(`  消费    idx=${r.consumption.idx} seq=${r.consumption.seq} ${T(r.consumption.time)} via=${r.consumption.via} ⇒ 第 ${r.consumptionTurn.turnNumber} 个 turn（该 turn 起于 idx=${r.consumptionTurn.startedAtIdx}）`)
  }
  console.log(`  判定    ${r.verdict}`)
  console.log(`  依据    ${r.why}`)
  if (r.newTurnStartsBetween !== undefined) console.log(`  计数    投递→消费之间新 turn/start：${r.newTurnStartsBetween} 次`)
  if (r.delivery?.target !== undefined) {
    // ⚠️ "声明 vs 行为"只在**声明落空**时才报：`next-turn` 排队是本意，**不是**矛盾。
    //    （初版这里写死成"queued 且 target=next-turn 即不一致"，把本意读成了矛盾 —— 已修。）
    const intent = r.delivery.target === 'next-step' ? '插进当前轮（下一个步边界）' : '等下一个 turn（排队）'
    const want = r.delivery.target === 'next-step' ? 'inserted-live' : 'queued'
    if (r.verdict === 'queued' || r.verdict === 'delivered-idle' || r.verdict === 'inserted-live') {
      if (r.verdict !== want) console.log(`  ⚠️ 声明与行为不一致：target="${r.delivery.target}"（本意：${intent}）但实际是 ${r.verdict}`)
      else console.log(`  声明与行为一致：target="${r.delivery.target}"（本意：${intent}）⇒ ${r.verdict}`)
    }
  }
}

if (r.verdict === 'unknown') toolFailed('这条 id 不在本会话日志的收件投递里 ⇒ 无法判定', r.why)
if (r.verdict === 'pending') {
  console.log('（该消息仍挂在队列里、尚未消费 ⇒ 无法判"排队/插入"；这不是缺陷判定）')
  process.exit(EXIT.OK)
}
// 只有「真的插进正在执行的那一轮」才算达成目标。`delivered-idle` 亦为**未达成**（但不是"排队等新 turn"）。
process.exit(r.verdict === 'inserted-live' ? EXIT.OK : EXIT.DEFECT)
