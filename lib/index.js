import * as identity from './identity.js'
import * as globalPrompt from './global-prompt.js'
import * as autoResume from './auto-resume.js'
import * as webRestart from './web-restart.js'
import * as peerMessage from './peer-message.js'
import * as logReposition from './log-reposition.js'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-session-toolkit'

// 聚合包单一 Config：各功能分键，默认值 = 现状（行为零变化）。
// 可在 cordis.yml / cordis.patch.yml 的插件行 config 字段覆盖，无需改代码。
export const Config = z.object({
  identity: z.object({
    maxText: z.number().default(8000),
    sectionOrder: z.number().default(55),
  }),
  globalPrompt: z.object({
    sectionOrder: z.number().default(50),
  }),
  autoResume: z.object({
    concurrency: z.number().default(3),
  }),
  webRestart: z.object({
    scriptPath: z.string(), // 可选：缺省时推导（schemastery 对象字段缺省即不填）
    spawnDelayMs: z.number().default(500),
  }),
  client: z.object({
    identityCharLimit: z.number().default(4000),
    restartTimeoutMs: z.number().default(90000),
    restartPollMs: z.number().default(1000),
    restartFillMs: z.number().default(600),
    copyFeedbackMs: z.number().default(1600),
  }),
})

// 各功能模块 host 服务依赖并集（去重）。web profile 下服务齐备；
// 若某服务在特定 profile 缺失，对应模块 apply 失败并被 safe() 隔离（与独立插件行为一致）。
export const inject = Array.from(new Set([
  ...(identity.inject || []),
  ...(globalPrompt.inject || []),
  ...(autoResume.inject || []),
  ...(webRestart.inject || []),
  ...(peerMessage.inject || []),
  ...(logReposition.inject || []),
]))

function safe(applyFn, ctx, cfg, label) {
  try {
    applyFn(ctx, cfg)
  } catch (e) {
    console.warn('[dsh-session-toolkit] host module ' + label + ' apply failed: ' + (e && e.message ? e.message : String(e)))
  }
}

// config 由 cordis 注入（schema 默认值已填充）；模块级再做缺省兜底防御。
export function apply(ctx, config) {
  const c = (config && typeof config === 'object') ? config : {}
  safe(identity.apply, ctx, c.identity || {}, 'identity')
  safe(globalPrompt.apply, ctx, c.globalPrompt || {}, 'global-prompt')
  safe(autoResume.apply, ctx, c.autoResume || {}, 'auto-resume')
  safe(webRestart.apply, ctx, c.webRestart || {}, 'web-restart')
  safe(peerMessage.apply, ctx, null, 'peer-message')
  safe(logReposition.apply, ctx, null, 'log-reposition')
}