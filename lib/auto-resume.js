import z from '@deepseek-ai/schemastery'

export const inject = ['settings', 'agents', 'sessionPersistence']

export function apply(ctx) {
  const scope = ctx.settings.register('session-auto-resume', z.object({
    sessions: z.dict(z.boolean()).default({}),
  }), { applies: 'live' })

  // 过滤链：开关开启 + 顶层（非 subagent、无 parentSession）+ 非空白（seedLength !== 0；
  // seedLength 缺失视为可恢复，仅显式 0 跳过）。
  function shouldResume(header, enabled) {
    if (enabled !== true) return false
    if (header.origin === 'subagent') return false
    if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false
    if (header.parentSession !== undefined && header.parentSession !== null) return false
    if (header.seedLength === 0) return false
    return true
  }

  function enabledMap() {
    const v = scope.get()
    return (v && v.sessions && typeof v.sessions === 'object') ? v.sessions : {}
  }

  // 幂等 + 并发保护（P1-1 TOCTOU 修复）：同一会话只允许一个在途 resume。
  // restoreAll（启动恢复）与 watch（立即生效）共用此入口，杜绝双 agent 创建（registry 无重复防护、
  // 覆盖先者会导致先者 machine 泄漏）。resume 的 ownerCtx 由 AgentRegistry 内部绑定（registry 自身 ctx），
  // 不随本插件 fiber 卸载 dispose —— 红线（dispose 会从存储移除会话）不触碰：本插件从不调用 dispose。
  const inflight = new Set()
  async function resumeOne(sessionId) {
    if (inflight.has(sessionId)) return
    if (ctx.agents.get(sessionId) !== undefined) return
    inflight.add(sessionId)
    try {
      await ctx.agents.resume({ resumeSessionId: sessionId })
    } finally {
      inflight.delete(sessionId)
    }
  }

  // 启动恢复（P2-1：并发受限，最多 CONCURRENCY 个在途，避免单会话挂起阻塞全部）；
  // 保留 per-item 失败隔离。fire-and-forget（apply 同步返回，异步流程内部 catch）。
  const CONCURRENCY = 3
  async function restoreAll() {
    try {
      const headers = await ctx.sessionPersistence.list()
      const enabled = enabledMap()
      const targets = headers.filter((h) => shouldResume(h, enabled[String(h.id)]))
      for (let i = 0; i < targets.length; i += CONCURRENCY) {
        const batch = targets.slice(i, i + CONCURRENCY)
        await Promise.allSettled(batch.map((h) => resumeOne(h.id).catch((e) => {
          console.warn('[dsh-auto-resume] resume failed for ' + String(h.id) + ': ' + (e && e.message ? e.message : String(e)))
        })))
      }
    } catch (e) {
      console.warn('[dsh-auto-resume] startup restore failed: ' + (e && e.message ? e.message : String(e)))
    }
  }

  restoreAll()

  // 立即生效：watch 提交变更，false→true 的新开启项立即 resume（同幂等/失败隔离）。
  scope.watch((next, prev) => {
    const nextS = (next && next.sessions && typeof next.sessions === 'object') ? next.sessions : {}
    const prevS = (prev && prev.sessions && typeof prev.sessions === 'object') ? prev.sessions : {}
    for (const id of Object.keys(nextS)) {
      if (nextS[id] === true && prevS[id] !== true) {
        resumeOne(id).catch((e) => {
          console.warn('[dsh-auto-resume] live resume failed for ' + id + ': ' + (e && e.message ? e.message : String(e)))
        })
      }
    }
  })
}
