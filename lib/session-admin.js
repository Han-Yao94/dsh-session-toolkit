// session-admin — Host half（dsh-session-toolkit 的模块之一）
// 在宿主面注册 create_session / rename_session 两个工具，让会话能自主创建顶层会话、
// 自主修改会话标题。与 peer-message.js 的 send_to_session / list_sessions 同平面、同风格。
//
// 内核依据（DSH checkout 内绝对路径，2026-09-21 只读核验）：
//  · `ctx.agents.create()` 省略 `parentAgent` ⇒ runtime root（根会话判据 = owner === undefined）
//    `packages/core/agent/src/index.ts:388`、`:62-85`（CreateAgentOptions）、`:563-565`（get）
//  · 导航可见性 `origin !== 'subagent' && !archived && (!blank || id === current)`
//    `packages/client/ui-workspace/src/client/tree.ts:208-212`
//  · 无 `cwd` 的离线会话不进列表 `packages/api/session-controller/src/list.ts:131-141`
//  · `blank` 只在 `turn/start` 翻转（`session/title` 不算）`packages/api/session-controller/src/list.ts:48-52`
//  · 官方同路径先例（GUI 新建会话）`packages/api/session-controller/src/agent.ts:487-495`
//  · 改标题 `sessionTitle.rename(session, title)`：非 live 抛错、空标题抛 SessionTitleInvalidError、
//    用户改名会 pin 住不被自动标题覆盖 `packages/session/session-title/src/index.ts:401-420`、`:502`
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const inject = ['agents']

const MAX_PROMPT_CHARS = 100000

// 单一内容构造点：初始 prompt 与结构化错误都从这里出去，避免两套文案漂移。
// 形状与 lib/peer-message.js 的 UserMessage 一致（role/content/source），接收方按普通聊天消息渲染。
function userMessage(text) {
  return {
    id: 'session-admin-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

// 错误对象 → 纯 JSON。内核抛出的 RemoteError 等可能带不可结构化克隆的字段，
// 直接塞进返回值会让工具输出序列化失败，所以在这里取最保守的可读字段。
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

export function apply(ctx) {
  const agents = ctx.agents

  // tools / 其余服务都是可选依赖：用 ctx.inject 等它就绪，而不是在 apply 时刻一次性 ctx.get。
  // 后者有两条无从区分的分支：服务晚到 → 工具永久静默消失；服务永不到 → 与降级同形。
  // （与 lib/peer-message.js:15-19 同款写法。）
  ctx.inject(['tools'], (toolCtx) => {
    const tools = toolCtx.get('tools')
    if (!tools) return
    registerTools(toolCtx, agents, tools)
  })
}

function registerTools(ctx, agents, tools) {
  // 建会话：交给内核拿默认 agent 选项（模型/provider），本模块不自行发明默认值。
  // 返回值：{ ok:true, ... } 或 { ok:false, error, errorText }，绝不抛未捕获异常。
  async function createSession(args) {
    // ④ prompt 必填：与 cwd 同级、同风格的入参校验（AC13）。两者都在**任何创建动作之前**返回。
    const prompt = typeof args.prompt === 'string' ? args.prompt : ''
    if (prompt.trim().length === 0) {
      return { ok: false, error: 'EMPTY_PROMPT', errorText: 'prompt 不能为空：create_session 现在要求给出首条消息，不再支持只登记不说话的临时会话' }
    }
    const cwd = typeof args.cwd === 'string' ? args.cwd.trim() : ''
    if (cwd.length === 0) {
      return { ok: false, error: 'EMPTY_CWD', errorText: 'cwd 不能为空：新会话必须带工作目录，否则不会进入宿主列表' }
    }
    if (!isAbsolutePath(cwd)) {
      return { ok: false, error: 'CWD_NOT_ABSOLUTE', errorText: 'cwd 必须是绝对路径，收到：' + cwd }
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return { ok: false, error: 'PROMPT_TOO_LONG', errorText: 'prompt 超过 ' + MAX_PROMPT_CHARS + ' 字符上限' }
    }
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    if (typeof agents.create !== 'function') {
      return { ok: false, error: 'CREATE_UNAVAILABLE', errorText: 'agents.create 不可用：内核未提供会话创建工厂' }
    }

    const sessionId = randomUUID()
    // 模型选择也在**建会话之前**解析（裁定 #4 硬约束 2）：解析不出来就不建——
    // 缺 agentOptions 的会话没有 provider/model，轮次能起停但没有模型可用 ⇒ **空转会话**
    // （真实宿主实测：只有 turn/start→step/start→step/end→turn/end，无 user/message、无 assistant/message）。
    let modelOptions
    try {
      modelOptions = modelOptionsFor()
    } catch (error) {
      return {
        ok: false,
        error: error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'MODEL_UNAVAILABLE',
        errorText: '默认模型解析失败：' + describe(error),
      }
    }
    // 默认 preset 同样在建会话之前解析（裁定 #2 修正 2）——
    // 这样「不留下残缺会话」是构造性的，不依赖任何回滚手段，也就不必碰 handle.dispose（硬约束 3）。
    let preset
    try {
      preset = await presetSetupFor(sessionId)
    } catch (error) {
      return { ok: false, error: 'PRESET_RESOLVE_FAILED', errorText: '默认 agent preset 解析失败：' + describe(error) }
    }
    let handle
    try {
      // 关键约束（裁定 #1 硬约束 1，措辞经裁定 #3 §14.3 修正）：
      //  · **不得传 `parentAgent`**（否则会话成为子会话，导航永不显示）；
      //  · **`meta` 不得设 `origin`**；
      //  · `cwd` 必填；
      //  · **`agentPreset` 允许且应当传入**（旧措辞「meta 只带 cwd」自裁定 #3 起作废）——
      //    它让会话记录自己实际 mount 的是哪个 preset：内核把它写入 header 并持久化
      //    （core/session/src/index.ts:1041），而恢复/继续时读的是 agentPreset 投影
      //    （agent-presets/src/session.ts 文件头原文：Reconstruction reads the `agentPreset`
      //    Session projection, never the header alone.）——不记录就会让重建的 composition
      //    可能不是该会话实际跑的那一套。
      //  · `undefined` 时**不写该键**（与官方 api/session-controller/src/agent.ts:491 及内核
      //    session/src/index.ts:1041 的 `...(x === undefined ? {} : { agentPreset: x })` 同形）。
      handle = await agents.create({
        sessionId,
        // 裁定 #4 硬约束 1：必须带 agentOptions —— 取值照抄官方同路径
        // （api/session-controller/src/agent.ts:498：`{ provider, model } = agentDefaultModel.currentSelection()`）。
        // 少了它，新建会话 agent.options.provider/model 为空（core/agent-loop/src/agent.ts:513
        // 的 route 退化为空串）⇒ 有 turn 边界、无模型可用 ⇒ 空转。
        agentOptions: modelOptions,
        meta: { cwd, ...(preset.presetId === undefined ? {} : { agentPreset: preset.presetId }) },
        setup: preset.setup,
      })
    } catch (error) {
      return { ok: false, error: 'CREATE_FAILED', errorText: '创建会话失败：' + describe(error) }
    }

    // 硬约束 3：handle 永不 dispose（会从存储移除会话）。见交付说明「handle 生命周期」一节。
    const agent = handle === undefined ? undefined : handle.agent
    if (agent === undefined) {
      return { ok: false, error: 'CREATE_NO_AGENT', errorText: '创建返回了空 handle：会话可能已回滚，未发送初始消息' }
    }

    const result = {
      ok: true,
      sessionId: String(agent.id),
      cwd,
      status: typeof agent.status === 'string' ? agent.status : 'unknown',
      title: null,
      // preset.note 只在「legit 降级」出现（服务缺失）；resolve 失败走的是 ok:false 早退，不会到这里。
      notes: preset.note === undefined ? [] : [preset.note],
    }

    // ⑤ prompt 必填后，「不带 prompt」的分支及其随之为空的字段一并删除：
    //   · 不再有 else 分支（「只登记、保持空白不进导航」的行为已不存在）；
    //   · `promptEnqueued` 已删除——prompt 必填后它恒为 true，恒真字段没有信息量；
    //     也**不再引入任何等价字段**（promptSent / talked 之类），字段没了就不会再有「名字与语义不符」的问题。
    // 唯一保留的是文案：这一跳仍未验证——`turn/start` 只在 agent loop 真跑一轮时产生，
    // 而 prompt 是否已写入会话日志同样未经本工具验证；不因 prompt 变必填就当作已验证。
    try {
      agent.followup(userMessage(prompt))
      result.notes.push('首发消息已入队并唤醒驱动；模型是否真的开跑、prompt 是否已写入会话日志，均未在本工具内验证')
    } catch (error) {
      result.notes.push('会话已创建，但首发消息入队失败：' + describe(error))
    }

    if (title.length > 0) {
      const renamed = renameSession({ sessionId: result.sessionId, title })
      if (renamed.ok) {
        result.title = renamed.title
      } else {
        result.notes.push('会话已创建，但标题设置失败：' + renamed.error + ' — ' + renamed.errorText)
      }
    }
    return result
  }

  // 只做「必须是绝对路径」这一条判据；cwd 是否存在、是否可写交由内核校验，
  // 内核的报错原文经 describe() 原样返回（不自行发明判据，也不吞掉内核的话）。
  function isAbsolutePath(value) {
    if (value.startsWith('/')) return true
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
  }

  // 默认模型选择（裁定 #4）。取值方式照抄官方 api/session-controller/src/agent.ts:498。
  //
  // 形状实测（deepseek-harness 的 packages/core/agent-default-model，2026-09-21 只读核过）：
  // `currentSelection()` 返回 `{ provider, model, reasoningEffort? }` 的**新对象**（未冻结、非同一引用；
  // 本次实测为 `{provider:'deepseek', model:'deepseek-chat'}`，无 reasoningEffort 键）；
  // `AgentOptions` 接受 `provider` / `model` / `reasoningEffort` / `maxTokens`（core/agent/src/runtime-types.ts:26-35）。
  // 官方只取 provider+model；本模块额外带上 reasoningEffort（**仅当存在时**，展开写法同 :1041 的风格）——
  // 理由：`lib/auto-resume.js:126-131` 已确立「带上会话的 reasoning 选择」这一先例，丢掉它会是一次局部回归。
  // 三个必判情形（缺一都会导致**空转会话**，故一律在 `agents.create` 之前拦下）：
  //  · 服务缺失 / `currentSelection` 不是函数        ⇒ MODEL_UNAVAILABLE
  //  · 服务在但调用抛错                              ⇒ MODEL_SELECTION_FAILED（附原文）
  //  · 返回体缺 provider / model（或不是非空字符串） ⇒ MODEL_SELECTION_INVALID
  function modelOptionsFor() {
    const agentDefaultModel = ctx.get('agentDefaultModel')
    if (agentDefaultModel === undefined || typeof agentDefaultModel.currentSelection !== 'function') {
      const error = new Error('agentDefaultModel 服务不可用：无法取得默认 provider/model')
      error.code = 'MODEL_UNAVAILABLE'
      throw error
    }
    let selection
    try {
      selection = agentDefaultModel.currentSelection()
    } catch (error) {
      const wrapped = new Error('agentDefaultModel.currentSelection() 抛错：' + describe(error))
      wrapped.code = 'MODEL_SELECTION_FAILED'
      throw wrapped
    }
    const provider = selection === null || selection === undefined ? undefined : selection.provider
    const model = selection === null || selection === undefined ? undefined : selection.model
    if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
      const error = new Error('默认模型选择缺少 provider/model：' + JSON.stringify(selection))
      error.code = 'MODEL_SELECTION_INVALID'
      throw error
    }
    return {
      provider,
      model,
      ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort.length > 0
        ? { reasoningEffort: selection.reasoningEffort }
        : {}),
    }
  }

  // 恢复出的/新建的 agent 必须 mount 它的 agent preset：Web 层只由 preset 提供工具，
  // 没 mount 的 agent 其工具/prompt/skill 都从空全局层解析（与 lib/auto-resume.js:90-108 同款）。
  //
  // 两种情形必须区分（裁定 #2 修正 2，§13.1）：
  //  · agentPresets 服务**缺失** ⇒ 合法降级：返回形状 { presetId: undefined, setup: undefined, note }，
  //    由调用方补一条说明性 note、会话照建；`presetId === undefined` 同时决定 meta 里**不写**
  //    `agentPreset` 键（裁定 #3 AC18）——因此本函数**始终返回同一形状的对象**，不再返回裸 undefined：
  //    调用点拿到的 presetId 无论成功/降级都是一个可直接判 `=== undefined` 的值。
  //  · 服务**存在但默认 preset 解析失败** ⇒ 环境坏了（不是可选能力缺失），**不静默降级**：
  //    本函数让错误向上抛，由 createSession 在**建会话之前**返回 PRESET_RESOLVE_FAILED。
  //    因此不会产生「ok:true 但没有 preset、工具与提示词段皆空」的残缺会话，也无需任何回滚。
  async function presetSetupFor(sessionId) {
    const presets = ctx.get('agentPresets')
    if (presets === undefined) {
      return { presetId: undefined, setup: undefined, note: 'agentPresets 服务不可用：未 mount agent preset（内核默认行为）' }
    }
    // 不在此处吞异常：resolve 失败要变成结构化错误，而不是一行日志。
    const presetId = (await presets.resolve(undefined)).id
    return {
      presetId,
      setup: async function mountPreset(agentCtx) {
        await presets.mount(agentCtx, presetId)
      },
    }
  }

  function renameSession(args) {
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
    if (sessionId.length === 0) {
      return { ok: false, error: 'EMPTY_TARGET', errorText: 'sessionId 不能为空' }
    }
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    if (title.length === 0) {
      // 空标题内核会抛 SessionTitleInvalidError；这里提前挡成结构化错误（AC6）。
      return { ok: false, error: 'EMPTY_TITLE', errorText: 'title 不能为空或纯空白' }
    }
    const sessionTitle = ctx.get('sessionTitle')
    if (sessionTitle === undefined) {
      return { ok: false, error: 'TITLE_SERVICE_UNAVAILABLE', errorText: 'sessionTitle 服务不可用，无法改名' }
    }

    const agent = agents.get(sessionId)
    if (agent === undefined) {
      return { ok: false, error: 'SESSION_UNAVAILABLE', errorText: '目标会话不在线（rename 需要 live 会话）' }
    }
    const header = agent.session.header || {}
    if (header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)) {
      return { ok: false, error: 'TARGET_IS_SUBAGENT', errorText: '目标是子会话（origin=subagent / delegationDepth>0），子会话不单独改名' }
    }

    // 内核契约：rename(session, title) 需要 live Session 对象（不是 id）。优先取 sessions 服务，
    // 缺失时回落 agent.session（拿到的都是同一个 live 对象）。
    const sessions = ctx.get('sessions')
    const session = sessions !== undefined && typeof sessions.get === 'function'
      ? sessions.get(sessionId)
      : agent.session
    if (session === undefined || session === null) {
      return { ok: false, error: 'SESSION_UNAVAILABLE', errorText: '目标会话不在线（rename 需要 live 会话）' }
    }
    try {
      const snap = sessionTitle.rename(session, title)
      return {
        ok: true,
        sessionId,
        title: snap !== undefined && typeof snap.title === 'string' ? snap.title : title,
        pinned: true,
      }
    } catch (error) {
      const errorText = describe(error)
      // 非 live 判定可能发生在服务内部（与上面的 agents.get 探测之间有时序差），
      // 这里把它归一到同一个码，调用方只需处理一套错误。
      const code = /not live/.test(errorText) ? 'SESSION_UNAVAILABLE' : 'RENAME_FAILED'
      return { ok: false, error: code, errorText }
    }
  }

  const createTool = defineTool({
    name: 'create_session',
    description: '自主创建一个新的顶层会话（GUI 左侧导航里的一个聊天窗口）。cwd 与 prompt 均必填：cwd 必须是绝对路径（无 cwd 的会话不会进宿主列表），prompt 是新会话的首条消息。创建成功即产生一条真实用户消息（会真实跑一轮模型、消耗一次调用）；按内核设计，产生过事件（消息）的会话会被持久化，本工具因此不再提供「只登记、不说话」的临时会话。是否真正开跑、prompt 是否已落盘，均未在本工具内验证。可选 title 立即设定标题（会 pin 住，不被自动标题覆盖）。',
    parameters: {
      cwd: { type: 'string', required: true, description: '新会话的工作目录，必须是绝对路径（如 /Users/me/project 或 D:\\work\\proj）' },
      prompt: { type: 'string', required: true, description: '必填：新会话的首条消息。会真实跑一轮模型（消耗一次调用），并使该会话被持久化' },
      title: { type: 'string', description: '可选：新会话的标题，立即生效并 pin 住（不被自动标题覆盖）' },
    },
    output: {
      schema: { type: 'json' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      try {
        return await createSession(args === undefined || args === null ? {} : args)
      } catch (error) {
        // 兜底：任何未预期异常也变成结构化错误，不砸崩调用方会话（AC6）。
        return { ok: false, error: 'UNEXPECTED', errorText: describe(error) }
      }
    },
  })
  tools.register(createTool)

  const renameTool = defineTool({
    name: 'rename_session',
    description: '修改一个在线（live）会话的标题。改名会 pin 住标题，不再被自动标题生成覆盖。目标必须是顶层会话且当前在线。',
    parameters: {
      sessionId: { type: 'string', required: true, description: '目标会话的精确 session id（用 list_sessions 获取）。本工具不接受 workspace 路径寻址；同名多会话请直接用 id' },
      title: { type: 'string', required: true, description: '新标题，不能为空或纯空白' },
    },
    output: {
      schema: { type: 'json' },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      try {
        return renameSession(args === undefined || args === null ? {} : args)
      } catch (error) {
        return { ok: false, error: 'UNEXPECTED', errorText: describe(error) }
      }
    },
  })
  tools.register(renameTool)
}

export { describe }
