export const inject = ['agents']

export function apply(ctx, cfg) {
  // Config 分键（autoResume.concurrency），缺省兜底默认值
  const concurrency = (cfg && typeof cfg.concurrency === 'number') ? cfg.concurrency : 3
  // agentDefaultModel 为可选服务（规范：可选依赖用 ctx.get，勿 inject 硬依赖拖累全包）
  const agentDefaultModel = ctx.get('agentDefaultModel')

  // 官方恢复链路（0.1.6 起公开：`ctx.sessionController.resolveAgent(id)`）。它等价于 GUI
  // 打开会话：composeAgent → installSelection（会话自己的模型/effort）+ mount preset，
  // 外加 subagent 归属与 cwd 校验、并发恢复去重。此前本模块手工 ctx.agents.resume 只做
  // 了 mount preset，重启后自动上线的会话会丢掉会话模型选择（退回默认模型）。
  // 服务不存在（老内核）时保持原有回落逻辑。
  let sessionController
  ctx.inject(['sessionController'], (childCtx) => {
    const controller = childCtx.get('sessionController')
    if (!controller || typeof controller.resolveAgent !== 'function') return
    sessionController = controller
    childCtx.effect(() => () => {
      if (sessionController === controller) sessionController = undefined
    }, 'dsh-auto-resume: session controller face')
  })

  // 每会话开关是本条目 Config 的 volatile 字段（DSH 0.1.7 起 settings 的唯一数据面）。
  const sessionsRef = cfg ? cfg.sessions : undefined

  /**
   * 归一化一条持久化列表项：按**形状**判别，不按 harness 版本号判别。
   * - 快照形状（0.1.5 现行契约）：list() 返回 SessionPersistenceSnapshot[]，header 在里层
   *   （@deepseek-ai/dsh-session-persistence `lib/types/index.d.ts:22-31`、`:155`）；
   * - 裸 header 形状：列表项本身即 header。
   * 保留后者只多读两个字段，却使本模块不绑定 harness 版本；只认快照形状时，一旦后端返回裸
   * header 就会静默选出 0 个目标——正是本次故障的形态，故两者都认。
   */
  function normalizeEntry(item) {
    if (item === null || typeof item !== 'object') return undefined
    const isSnapshot = item.header !== null && typeof item.header === 'object'
    return {
      header: isSnapshot ? item.header : item,
      eventCount: isSnapshot ? item.eventCount : undefined,
    }
  }

  /**
   * 会话是否应启动恢复（逐条件业务含义）：
   * - enabled === true：用户在本插件显式开启了该会话的自动开关；
   * - origin !== 'subagent'：仅恢复顶层会话（子代理会话由父会话生命周期管理，不单独常驻恢复）；
   * - delegationDepth 不被视为 >0：排除被委派深度的会话；
   * - parentSession 为空：排除有父会话的后代（避免父子并发恢复）；
   * - eventCount !== 0：非空白会话（无任何事件）。原判据取的是 `header.seedLength`，而该字段在
   *   0.1.2 与 0.1.5 的 SessionHeader 中**都不存在**（0.1.5 见 `@deepseek-ai/dsh-session`
   *   `lib/types/types.d.ts:58-94`；前缀长度是 header 之外的 inheritedEventCount；
   *   0.1.2 侧依据 QA 的 tarball 对照，裁定 #31 勘误），即该条判据从未生效。现改用快照的
   *   `eventCount`（`@deepseek-ai/dsh-session-persistence` `lib/types/index.d.ts:28`：后端能从元数据
   *   廉价取得时才提供）；后端不提供时视为可恢复——与旧「seedLength 缺失视为可恢复」同精神。
   */
  function shouldResume(entry, enabled) {
    const header = entry.header
    if (enabled !== true) return false
    if (header.origin === 'subagent') return false
    if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false
    if (header.parentSession !== undefined && header.parentSession !== null) return false
    if (typeof entry.eventCount === 'number' && entry.eventCount === 0) return false
    return true
  }

  function enabledMap() {
    if (!sessionsRef || typeof sessionsRef.get !== 'function') return {}
    const v = sessionsRef.get()
    return (v && typeof v === 'object') ? v : {}
  }

  // 幂等 + 并发保护（P1-1 TOCTOU 修复）：同一会话只允许一个在途 resume。
  // restoreAll（启动恢复）与 watch（立即生效）共用此入口，杜绝双 agent 创建（registry 无重复防护、
  // 覆盖先者会导致先者 machine 泄漏）。resume 的 ownerCtx 由 AgentRegistry 内部绑定（registry 自身 ctx），
  // 不随本插件 fiber 卸载 dispose —— 红线（dispose 会从存储移除会话）不触碰：本插件从不调用 dispose。
  const inflight = new Set()

  /**
   * 恢复发布出的 agent 必须重新 join 它的 agent preset：Web 层把 read/glob/grep/pwsh 等工具
   * 全部 disabled，只由 preset 提供；没 join preset 的 agent，其工具/prompt/skill 都从**空全局层**
   * 解析（`@deepseek-ai/dsh-agent-presets` 的 `agent/created` 只 warn 不 veto，见该包 src/index.ts）。
   * 官方链路同 `packages/api/session-controller/src/agent.ts` 的 composeAgent：mount 放进 setup，
   * 失败即回滚该次恢复；preset id 取自 projection 而非 header——会话可在 blank 期改 preset，
   * header 只是创建值（preset id 取法见 `@deepseek-ai/dsh-agent-presets/session`）。
   * agentPresets / sessionQuery 缺失时返回 undefined（保持旧行为），不硬 inject 拖累全包。
   */
  async function presetSetupFor(sessionId) {
    const presets = ctx.get('agentPresets')
    if (presets === undefined) return undefined
    let presetId
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery !== undefined) {
      const observation = await sessionQuery.observeSession(sessionId)
      try {
        presetId = observation.projections?.values.agentPreset
          ?? observation.header.agentPreset
          ?? undefined
      } finally {
        observation[Symbol.dispose]()
      }
    }
    return async function mountPreset(agentCtx) {
      await presets.mount(agentCtx, (await presets.resolve(presetId)).id)
    }
  }

  async function resumeOne(sessionId) {
    if (inflight.has(sessionId)) return
    if (ctx.agents.get(sessionId) !== undefined) return
    inflight.add(sessionId)
    try {
      // 官方链路优先：模型选择、归属校验、并发去重都在 controller 内完成。
      if (sessionController !== undefined) {
        const found = await sessionController.resolveAgent(sessionId)
        if (found && found.error) throw found.error
        return
      }
      // 回落（老内核无 sessionController）：手工 compose。
      // 携带默认模型（agentDefaultModel）：否则 {{model}} 变量无值，deployment:persona 渲染抛错。
      // 字段名 provider/model/reasoningEffort 与 dsh-agent-loop AgentOptions 一致；
      // 会话若另有自定义模型，实际请求仍走会话请求头/agent/request waterfall（与 GUI 打开行为一致）。
      const agentOptions = {}
      const dm = agentDefaultModel ? agentDefaultModel.currentSelection() : undefined
      if (dm && dm.provider && dm.model) {
        agentOptions.provider = dm.provider
        agentOptions.model = dm.model
        if (dm.reasoningEffort) agentOptions.reasoningEffort = dm.reasoningEffort
      }
      const setup = await presetSetupFor(sessionId)
      await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    } finally {
      inflight.delete(sessionId)
    }
  }

  // 启动恢复（P2-1：并发受限，最多 CONCURRENCY 个在途，避免单会话挂起阻塞全部）；
  // 保留 per-item 失败隔离。fire-and-forget（apply 同步返回，异步流程内部 catch）。
  const CONCURRENCY = concurrency
  async function restoreAll(persistence) {
    try {
      const listed = await persistence.list()
      const enabled = enabledMap()
      const entries = []
      let unrecognized = 0
      for (const item of listed) {
        const entry = normalizeEntry(item)
        if (!entry || typeof entry.header.id !== 'string') { unrecognized++; continue }
        entries.push(entry)
      }
      // 契约漂移不再静默：形状不认识时至少留一条可诊断的告警（本次故障的形态正是「无任何报错」）。
      if (unrecognized > 0) {
        console.warn('[dsh-auto-resume] ' + unrecognized + '/' + listed.length + ' persistence list entries had an unrecognized shape and were skipped')
      }
      const targets = entries.filter((entry) => shouldResume(entry, enabled[entry.header.id]))
      for (let i = 0; i < targets.length; i += CONCURRENCY) {
        const batch = targets.slice(i, i + CONCURRENCY)
        await Promise.allSettled(batch.map((entry) => resumeOne(entry.header.id).catch((e) => {
          console.warn('[dsh-auto-resume] resume failed for ' + entry.header.id + ': ' + (e && e.message ? e.message : String(e)))
        })))
      }
    } catch (e) {
      console.warn('[dsh-auto-resume] startup restore failed: ' + (e && e.message ? e.message : String(e)))
    }
  }

  // sessionPersistence 是可选服务：用 ctx.inject 等它就绪，而不是在 apply 时刻 ctx.get 一次性取值。
  // 后者有两条无从区分的分支：服务晚到 → 特性永久静默失效；服务永不到 → 与降级同形。
  // 判据（cordis 4.0.2 `cordis/lib/index.js:1316-1343` `_refresh`/`_setEpoch`）：注入名无实现时 fiber
  // 处于 INACTIVE、apply 不执行；实现出现后 `_reload` 触发 apply；实现始终不存在则永不执行且不报错。
  // 代价：服务每次（重新）就绪都会重跑一次恢复——由 resumeOne 的 inflight + ctx.agents.get 兜幂等。
  ctx.inject(['sessionPersistence'], function autoResumeStartupRestore(childCtx) {
    const persistence = childCtx.get('sessionPersistence')
    if (!persistence) return
    restoreAll(persistence)
  })

  // 立即生效：volatile 配置提交后（表单写入 / profile patch 编辑）对比新旧开关，
  // false→true 的新开启项立即 resume（同幂等/失败隔离）。事件只带变更路径，
  // 故这里重读整张表并自行做前后差分。
  let lastEnabled = enabledMap()
  ctx.on('loader/volatile-update', () => {
    const next = enabledMap()
    for (const id of Object.keys(next)) {
      if (next[id] === true && lastEnabled[id] !== true) {
        resumeOne(id).catch((e) => {
          console.warn('[dsh-auto-resume] live resume failed for ' + id + ': ' + (e && e.message ? e.message : String(e)))
        })
      }
    }
    lastEnabled = next
  })
}
