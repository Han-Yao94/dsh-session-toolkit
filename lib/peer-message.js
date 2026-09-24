// peer-message — Host half（dsh-session-toolkit 的模块之一）
// Registers send_to_session / list_sessions on the host plane so every session
// can exchange messages (wakeup delivery). Mounted by the package's own
// cordis.patch.yml row (`id: session-toolkit`, `name: 'dsh-session-toolkit'`).
import { defineTool } from '@deepseek-ai/dsh-tools'
import { toPlainText } from './plaintext.js'

const inject = ['agents']

function apply(ctx) {
  const agents = ctx.agents
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
      wakeup: { type: 'boolean', description: '是否投递并唤醒，默认 true。true：目标正在执行 ⇒ 该消息进入当前轮的下一个步边界（不排队）；目标空闲 ⇒ 立刻开始一轮。false：只投递不唤醒（执行中的目标在下一个步边界读到；空闲的目标留到它下次被唤醒时）' }
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
        //                   当前轮的**下一个步边界**（不排队）；目标空闲时立刻开始一轮。
        //   wakeup:false ⇒ inject（= target 'next-step' + wakeup false）——只投递不唤醒。
        // 为什么不用 followup：它走 'next-turn' ⇒ 目标正在跑时只能等这一轮结束才被读到，消息一多就在
        // 会话里排队（人类所有者看到的现象）。内核三个相邻方法见
        // packages/core/agent-loop/src/agent.ts:160-174；官方 Agent Teams 给运行中的队友投递也用 steer
        // （packages/experimental/agent-team/src/mailbox.ts:251）。
        // 注：steer 自身在空闲目标上会唤醒驱动 ⇒ 一次调用同时覆盖「执行中插入」与「空闲则开一轮」。
        // ⚠️ **steer 不是"必定不排队"的保证**（内核有意行为，不是缺陷）：`send()` 里有 `wakingAfterAbort`
        // 重分类（packages/core/agent-loop/src/agent.ts:153-159）——
        //     const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
        //     const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
        // ⇒ 目标上一个活动**正在被取消**时，steer 会静默降级为 `next-turn`（内核注释：Waking input cannot
        // join an aborted activity）。**别把 steer 当成"一定插进当前轮"的契约来依赖**：在那个窗口里它
        // 仍会排到下一轮。这是内核的安全设计（唤醒型输入不加入已被取消的活动），本插件照其语义行事。
        if (args.wakeup === false) target.inject(message)
        else target.steer(message)
      } catch (error) {
        return {
          ok: false, error: 'DELIVERY_FAILED',
          errorText: '投递失败：' + String(error && error.message ? error.message : error)
        }
      }
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
}

export { apply, inject }
