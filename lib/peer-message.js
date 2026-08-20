// peer-message — Host half
// Registers send_to_session / list_sessions on the host plane so every session
// can exchange messages (wakeup delivery). Mounted via the web profile's
// cordis.patch.yml as `name: 'peer-message'`.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { toPlainText } from './plaintext.js'

const inject = ['agents', 'tools']

function apply(ctx) {
  const agents = ctx.agents
  const tools = ctx.tools
  const sessionTitle = ctx.get('sessionTitle')
  const workspaceRegistry = ctx.get('workspaceRegistry')

  function titleOf(agent) {
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
      wakeup: { type: 'boolean', description: '是否唤醒对方立即处理；默认 true。设为 false 则只排队不唤醒' }
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
      if (target === undefined && workspaceRegistry !== undefined) {
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
        // kind: 'user' 让接收方 GUI 按普通聊天消息展示（非 user kind 会渲染成上下文卡片）
        source: { kind: 'user' }
      }
      try {
        if (args.wakeup === false) target.inject(message)
        else target.followup(message)
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
