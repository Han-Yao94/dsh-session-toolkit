// peer-message — Host half（dsh-session-toolkit 的模块之一）
// Registers send_to_session / list_sessions / inbox_check on the host plane so every
// session can exchange messages (wakeup delivery), can tell whether an inbound peer
// message still owes an answer, and emits the matching prompt discipline. Mounted by
// the package's own cordis.patch.yml row (`id: session-toolkit`, `name: 'dsh-session-toolkit'`).
import { defineTool } from '@deepseek-ai/dsh-tools'
import { toPlainText } from './plaintext.js'

const inject = ['agents']

// ---------------------------------------------------------------------------
// 「未处置的入站 peer 消息」台账（裁定 #80-B-1）
//
// 为什么需要台账，而不是直接读收件箱：
//   内核的收件箱投影只保存**尚未被某一步取走**的输入
//   （packages/core/agent-loop/src/inbox.ts:21-24 的 stateSchema 只有
//   'next-turn' / 'next-step'）。消息一旦被某一步 claim（inbox.ts:109-114），
//   它就从队列里消失、进入会话历史 —— 此后「模型有没有回过这条消息」再也无法
//   从收件箱状态里读出来。人类所有者报的正是这一格：消息送达了、模型也看到了，
//   轮次收尾时却没人提醒它回。所以要在 claim 的瞬间把它记进本进程的一张表，
//   直到本会话真的发出过一条出站消息为止。
//
// 判据（机械、可复核）：
//   · 入账：agent/inbox/claimed（runtime-types.ts:299，payload 带 agent/message/turn）
//     且 message.source.kind === 'agent-message'（= 另一个 Agent 经 send_to_session 发来的）。
//   · 销账：本会话成功执行过 send_to_session 后，该会话早先入账的一律销掉。
//   粒度是**会话级**而非逐条配对：逐条配对需要把回复正文与来件做语义匹配，那是猜。
//   代价照实写明：模型只回了其中一条、其余仍未回时，台账会一并销账（假阴性）。
//
// 内存有界：每会话最多 MAX_LEDGER_PER_SESSION 条，超出丢最旧的。
const MAX_LEDGER_PER_SESSION = 64
/** @type {Map<string, Array<{ id: string, from: string, preview: string }>>} */
const pendingPeer = new Map()
/** 已发出过出站消息的会话 id（收到 send_to_session 成功调用即入集合）。 */
const repliedSessions = new Set()

function peerEntriesOf(sessionId) {
  let list = pendingPeer.get(sessionId)
  if (list === undefined) { list = []; pendingPeer.set(sessionId, list) }
  return list
}

function noteClaimedPeerMessage(sessionId, message) {
  const id = typeof message?.id === 'string' ? message.id : ''
  if (id.length === 0) return
  const list = peerEntriesOf(sessionId)
  if (list.some((e) => e.id === id)) return
  list.push({
    id,
    from: String(message?.source?.senderSessionId ?? '?'),
    preview: summarizeMessage(message)
  })
  if (list.length > MAX_LEDGER_PER_SESSION) list.splice(0, list.length - MAX_LEDGER_PER_SESSION)
}

/** 从一条消息的 content 里取一段纯文本摘要（peer 消息正文首行）。 */
function summarizeMessage(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      text += (text.length > 0 ? '\n' : '') + block.text
    }
  }
  // peer 消息正文形如「来自会话「标题」（id）的消息：\n\n<正文>」——摘要取正文首行。
  const marker = text.indexOf('\n\n')
  const body = marker === -1 ? text : text.slice(marker + 2)
  const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? ''
  return firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine
}

/** 判一条待收消息是不是「另一个 Agent 发来的」。 */
function isPeerMessage(message) {
  return message?.source?.kind === 'agent-message'
}

function apply(ctx) {
  const agents = ctx.agents

  // claim 事件是 agent 作用域派发（serial/emit 都按 payload.agent 过滤），
  // 但插件根 ctx 能收到全部后代——官方 agent-team 同法
  // （packages/experimental/agent-team/src/index.ts:108-109）。
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (!agent || !isPeerMessage(message)) return
    noteClaimedPeerMessage(String(agent.id), message)
  })

  // tools 为可选服务：用 ctx.inject 等它就绪。apply 时刻一次性 ctx.get 有两条无从区分的
  // 分支——服务晚到（loader 是并发创建条目的，不保证 tools 先于本插件就绪）→ 工具永久
  // 静默消失；服务永不到 → 与降级同形。注入等待让「晚到」也能补跑。
  ctx.inject(['tools'], (toolCtx) => {
    const tools = toolCtx.get('tools')
    if (!tools) return
    registerTools(toolCtx, agents, tools)
  })
}

function registerTools(ctx, agents, tools) {
  // sessionTitle / workspaceRegistry 同样是可选服务：改为调用时读取，
  // 服务晚到照样能用（业务面降级为 cwd/路径寻址）。

  function titleOf(agent) {
    const sessionTitle = ctx.get('sessionTitle')
    const snap = sessionTitle === undefined ? undefined : sessionTitle.get(agent.session)
    if (snap !== undefined && typeof snap.title === 'string' && snap.title.length > 0) return snap.title
    const cwd = agent.session.header.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : String(agent.id)
  }

  function snapshotOf(agent) {
    const header = agent.session.header
    return {
      id: String(agent.id),
      title: titleOf(agent),
      workspace: typeof header.cwd === 'string' ? header.cwd : null,
      origin: header.origin === undefined ? null : header.origin,
      parentSession: header.parentSession === undefined ? null : String(header.parentSession),
      status: typeof agent.status === 'string' ? agent.status : 'unknown'
    }
  }

  function availableSessions() {
    return agents.roots().map(snapshotOf)
  }

  const sendTool = defineTool({
    name: 'send_to_session',
    description: '向另一个会话（GUI 聊天窗口）发送一条消息。对方收到后会在其聊天流里看到一条“来自会话 X 的消息”并处理。目标用 session id 或 workspace 路径指定；对方会话也可以用它回复，形成双向对等通信。不要给自己发消息。为避免无意义循环，发送后不要仅因对方回复就再次互发，除非有新的实质内容。',
    parameters: {
      to: { type: 'string', required: true, description: '目标会话：session id，或 workspace 路径（D:\\... 或 /...）' },
      content: { type: 'string', required: true, description: '要发送的消息内容' },
      wakeup: { type: 'boolean', description: '是否投递并唤醒，默认 true。true：目标正在执行 ⇒ 进目标当前轮的下一个步边界（不新开一轮，也不打断当前步）；目标空闲 ⇒ 立刻开一轮（此时本就没有步边界可插，消息在轮首被收下）。⚠️ 两种情形仍会排队：㈠ 目标上一个活动正在被取消（内核 wakingAfterAbort 把唤醒型输入降级为下一轮）；㈡ 目标空闲时投递——没有步边界可插，只能等一个轮次边界。故本参数**不承诺"不排队"**。判据：这条消息要求收件人做一件事吗？要求 ⇒ true（默认）；纯登记、不需对方动作 ⇒ false。false：只投递不唤醒（执行中的目标在下一个步边界读到；空闲的目标留到它下次被唤醒时）。注：followup 已不使用（它走 next-turn ⇒ 对方正在跑时会排队到本轮结束）。' }
    },
    output: {
      schema: { type: 'json' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      }
    },
    async execute(args, exec) {
      let caller = exec.agent
      if (caller === undefined) {
        try { caller = agents.requireInitiator() } catch (e) { caller = undefined }
      }
      if (caller === undefined) return { ok: false, error: 'NO_CALLER', errorText: '工具执行缺少调用方会话上下文' }
      const to = typeof args.to === 'string' ? args.to.trim() : ''
      const content = typeof args.content === 'string' ? args.content : ''
      if (to.length === 0) return { ok: false, error: 'EMPTY_TARGET', errorText: 'to 不能为空' }
      if (content.length === 0) return { ok: false, error: 'EMPTY_CONTENT', errorText: 'content 不能为空' }

      let target = agents.get(to)
      if (target === undefined) {
        const workspaceRegistry = ctx.get('workspaceRegistry')
        if (workspaceRegistry !== undefined) {
          const ws = await workspaceRegistry.resolveByPath(to)
          if (ws !== undefined) {
            const live = ws.sessionIds.map((id) => agents.get(id)).filter((a) => a !== undefined)
            if (live.length === 1) target = live[0]
            else if (live.length > 1) {
              return {
                ok: false, error: 'WORKSPACE_AMBIGUOUS',
                errorText: '该 workspace 有多个在线会话，请用 session id 指定',
                candidates: live.map(snapshotOf)
              }
            }
          }
        }
      }
      if (target === undefined) {
        return {
          ok: false, error: 'SESSION_UNAVAILABLE',
          errorText: '目标会话不在线或不存在（离线消息不持久化，只可发给在线会话）',
          available: availableSessions()
        }
      }
      if (target.id === caller.id) return { ok: false, error: 'SELF', errorText: '不能给自己发消息' }

      const senderTitle = titleOf(caller)
      const message = {
        id: 'peer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12),
        role: 'user',
        content: [{ type: 'text', text: '来自会话「' + senderTitle + '」（' + String(caller.id) + '）的消息：\n\n' + toPlainText(content) }],
        // V4：source 是**生产者归属**，不是渲染提示。这条消息是另一个 Agent 通过工具调用产生的，
        // 不是人类说的 ⇒ 必须用官方的 agent-message 形态，否则接收方记录里会冒充一条"人类说过的话"。
        // 形状受严格校验（session-format-v2-to-v3/src/payload.ts:115-120）：**恰好三个键**、form='relay'、
        // senderSessionId 为非空字符串——多一个少一个都不符。
        // 已知 UX 副作用（A 的取舍，人类所有者知情）：接收方 GUI 由"普通聊天消息"变为"Agent 触发卡片"
        // （ui-chat/.../turn-trigger.ts:35 ⇒ title: message.trigger.agent、icon: 'agent'）。
        source: { kind: 'agent-message', form: 'relay', senderSessionId: String(caller.id) }
      }
      try {
        // 投递语义（裁定 #12）：
        //   wakeup:true  ⇒ steer（内核里 = target 'next-step' + wakeup true）——目标**正在执行**时插进
        //                   当前轮的**下一个步边界**（不新开一轮、不打断当前步）；目标空闲时立刻开一轮。
        //   wakeup:false ⇒ inject（= target 'next-step' + wakeup false）——只投递不唤醒。
        // 为什么不用 followup：它走 'next-turn' ⇒ 目标正在跑时只能等这一轮结束才被读到，消息一多就在
        // 会话里排队（人类所有者看到的现象）。内核三个相邻方法见
        // packages/core/agent-loop/src/agent.ts:160-174；官方 Agent Teams 给运行中的队友投递也用 steer
        // （packages/experimental/agent-team/src/mailbox.ts:251）。
        // 注：steer 自身在空闲目标上会唤醒驱动 ⇒ 一次调用同时覆盖「执行中插入」与「空闲则开一轮」。
        // ⚠️ **口径：不要承诺"不排队"，要写清"何时不排队"+"哪两种情形仍会排队"**（裁定 #12-文案）。
        // ⚠️ 两条仍会排队的情形（`steer` 不是「必定插进当前轮」的保证）：
        //   ① **wakingAfterAbort**（内核有意行为，不是缺陷）：`send()` 里的重分类
        //      （packages/core/agent-loop/src/agent.ts:153-159）——
        //          const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
        //          const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
        //      ⇒ 目标上一个活动**正在被取消**时静默降级为 `next-turn`，真等下一轮（内核注释：
        //      Waking input cannot join an aborted activity）。
        //   ② **目标空闲时投递**：空闲目标没有步边界可插 ⇒ 消息只能在**下一个轮次边界**被 `claim`
        //      收下（inbox.ts:109-114：claim 先抽干 next-step，故其优先级高于 next-turn）。
        // ⚠️ **`target` 是声明，不是行为**（实测反例：peer-mufc7pen-8otia2xlb6，投递时有轮在跑、
        //    等待 3 ms，尺子 scripts/inbox-queue.verify.mjs 仍判 queued）。⇒ **只看 `target === 'next-step'`
        //    会把「空闲投递」那一格误读成"插进正在执行的轮"**；判断插入必须看投递→消费之间
        //    **有没有新的 turn/start**（0 次才是 inserted-live）。
        if (args.wakeup === false) target.inject(message)
        else target.steer(message)
      } catch (error) {
        return {
          ok: false, error: 'DELIVERY_FAILED',
          errorText: '投递失败：' + String(error && error.message ? error.message : error)
        }
      }
      // 本会话发出了一条出站消息 ⇒ 早先入账的 peer 来件视为已处置（销账）。
      repliedSessions.add(String(caller.id))
      pendingPeer.delete(String(caller.id))
      return { ok: true, to: String(target.id), toTitle: titleOf(target), messageId: message.id, wakeup: args.wakeup !== false }
    }
  })
  tools.register(sendTool)

  const listTool = defineTool({
    name: 'list_sessions',
    description: '列出当前所有在线顶层会话（GUI 聊天窗口）的 id、标题、workspace 路径和状态，供 send_to_session 寻址。返回空数组表示当前没有其他在线会话。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      }
    },
    async execute(args, exec) {
      const caller = exec.agent
      return availableSessions().map((s) => ({ ...s, isSelf: caller !== undefined && caller.id === s.id }))
    }
  })
  tools.register(listTool)

  // inbox_check —— 只读，无副作用。目标恒为**调用者自己**（拿不到 caller id 就明确报错，不猜）。
  const inboxTool = defineTool({
    name: 'inbox_check',
    description: '检查本会话当前**未处置的入站 peer 消息**（其他 Agent 经 send_to_session 发来的消息）。只读、无副作用。返回：count（条数）+ items（每条一行：发送者 id / 消息摘要 / messageId）。用法：每轮收尾前调用一次；若 count > 0，先逐条处理（回复或明确无需回复）再收尾。空列表 = 当前没有待处置的入站 peer 消息。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      }
    },
    async execute(args, exec) {
      let caller = exec.agent
      if (caller === undefined) {
        try { caller = agents.requireInitiator() } catch (e) { caller = undefined }
      }
      if (caller === undefined) {
        return { ok: false, error: 'NO_CALLER', errorText: '工具执行缺少调用方会话上下文，无法确定要检查哪个会话' }
      }
      const selfId = String(caller.id)
      const items = []

      // 来源①：收件箱里**尚未被任何一步取走**的入站 peer 消息 —— 这些一定还没进入模型上下文。
      try {
        const inbox = caller.inbox
        const pending = [
          ...(Array.isArray(inbox?.nextStep) ? inbox.nextStep : []),
          ...(Array.isArray(inbox?.nextTurn) ? inbox.nextTurn : [])
        ]
        for (const message of pending) {
          if (!isPeerMessage(message)) continue
          // L9-26：下面是按 `messageId: String(message.id)` 存的，这里必须用**同一形态**比对；
          // 否则非字符串 id（如数字）的去重守卫恒不命中 ⇒ 同一条消息被记两次。
          const messageId = String(message.id)
          if (items.some((e) => e.messageId === messageId)) continue
          items.push({
            messageId,
            from: String(message.source?.senderSessionId ?? '?'),
            preview: summarizeMessage(message),
            queued: true
          })
        }
      } catch (error) {
        // 收件箱不可读（内核形态变化）⇒ 只降级这一半，另一来源照常返回。
        void error
      }

      // 来源②：本进程内已被取走（进入上下文）但本会话此后还没回过任何出站消息的来件。
      for (const entry of pendingPeer.get(selfId) ?? []) {
        if (items.some((e) => e.messageId === entry.id)) continue
        items.push({
          messageId: entry.id,
          from: entry.from,
          preview: entry.preview,
          queued: false
        })
      }

      return {
        ok: true,
        self: selfId,
        replied: repliedSessions.has(selfId),
        count: items.length,
        items
      }
    }
  })
  tools.register(inboxTool)

  // 纪律段与工具是同一份契约（它教模型什么时候调 inbox_check），所以挂在这里：
  // tools 缺席时本模块整体不启用，也就不会有「纪律指向一只不存在的工具」。
  registerDiscipline(ctx)
}

// ---------------------------------------------------------------------------
// 提示词纪律（裁定 #80-B-1 ②）：工具解决「查得到」，纪律解决「会去查」。
//
// 为什么需要：收件箱投影只保留「还没被取走」的消息，claim 之后内核不再记得它
// （见本文件开头的台账说明），所以没有任何机制会在轮末替模型想起来还有 peer 消息
// 没回——只能靠一条固定的「收尾前动作」。
//
// name / order 属对外可见面（章程 §3.2），当前取值：name = 'peer-inbox-discipline'、
// order = 45（实测相邻段：身份 40 / 全局 50 / 组 55 / 工作区 60，45 是空档）。
// interpolate: false —— 本段是固定文案，不参与 {变量} 插值（与身份段同法）。
const DISCIPLINE_SECTION_NAME = 'peer-inbox-discipline'
const DISCIPLINE_SECTION_ORDER = 45

const PEER_INBOX_DISCIPLINE = [
  '【入站 peer 消息纪律】每轮收尾前调用一次 inbox_check（只读、无副作用），再决定是否收尾。',
  '· 返回 count = 0 ⇒ 本会话没有待处置的入站 peer 消息，正常收尾。',
  '· 返回 count > 0 ⇒ 逐条处置后才收尾：需要对方知道结论的，回一条 send_to_session；确认无需动作的，明确判定后继续。',
  '「消息已经被读到」不等于「已经处置」—— 本纪律存在的唯一原因就是这一格。'
].join('\n')

/**
 * subagent 不注入本段：list_sessions 只列顶层会话（agents.roots()），subagent 拿不到
 * peer 消息，注入了只会白烧一次「count 恒为 0」的工具调用。判据与身份段同法
 * （lib/identity.js），只是那一条是「不注入身份」，这里是「不注入纪律」。
 */
function isSubagent(agent) {
  const header = (agent && agent.session && agent.session.header) || {}
  return header.origin === 'subagent' ||
    (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
}

function registerDiscipline(ctx) {
  // systemPrompt 是核心服务，但本模块的业务面不依赖它 ⇒ 按可选依赖处理：
  // 缺席时静默跳过，不拖垮工具面（本文件其余可选服务的同法：ctx.inject + 就绪后回调）。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    const systemPrompt = promptCtx.get('systemPrompt')
    if (!systemPrompt) return

    promptCtx.effect(() => systemPrompt.section({
      name: DISCIPLINE_SECTION_NAME,
      order: DISCIPLINE_SECTION_ORDER,
      interpolate: false,
      text: (context) => {
        const agent = context && context.agent
        if (!agent || !agent.session) return ''
        return isSubagent(agent) ? '' : PEER_INBOX_DISCIPLINE
      }
    }), 'dsh-session-toolkit: peer inbox discipline section')
  })
}

export { apply, inject }
