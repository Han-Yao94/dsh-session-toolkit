import * as identity from './identity.js'
import * as globalPrompt from './global-prompt.js'
import * as autoResume from './auto-resume.js'
import * as webRestart from './web-restart.js'
import * as peerMessage from './peer-message.js'
import * as sessionAdmin from './session-admin.js'
import * as logReposition from './log-reposition.js'
import * as promptDedup from './prompt-dedup.js'
import * as promptLiteral from './prompt-literal.js'
import * as uiConfig from './ui-config.js'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-session-toolkit'

// 聚合包单一 Config：各功能分键，默认值 = 现状（行为零变化）。
// 可在 cordis.yml / cordis.patch.yml 的插件行 config 字段覆盖，无需改代码。
export const Config = z.object({
  identity: z.object({
    maxText: z.number().default(8000),
    sectionOrder: z.number().default(40),
  }),
  globalPrompt: z.object({
    sectionOrder: z.number().default(50),
    workspaceSectionOrder: z.number().default(60),
    workspaceSyncRetryMax: z.number().default(40),
    workspaceSyncRetryIntervalMs: z.number().default(500),
    // 引用文件读取上限：单文件 / 全部文件合计（字节）。防止一次 readFileSync
    // 阻塞事件循环并把提示词撑爆；超限的文件按 fail 状态上报 UI，不注入。
    maxFileBytes: z.number().default(262144),
    maxTotalBytes: z.number().default(1048576),
  }),
  autoResume: z.object({
    concurrency: z.number().default(3),
  }),
  webRestart: z.object({
    scriptPath: z.string(), // 可选：缺省时推导（schemastery 对象字段缺省即不填）
    spawnDelayMs: z.number().default(500),
  }),
  promptDedup: z.object({
    enabled: z.boolean().default(true),
  }),
  // 【提醒】新增 client 分键必须同步三处：本 Config.client（作为 session-toolkit-ui 命名空间的
  // base 层）、lib/ui-config.js 的 UI_DEFAULTS/UI_NAMESPACE schema、client/client.js 的
  // UI_FALLBACK（浏览器读取通道 = settingsScope.bind，不再走 cordis 行配置）。
  client: z.object({
    identityCharLimit: z.number().default(4000),
    restartTimeoutMs: z.number().default(90000),
    restartPollMs: z.number().default(1000),
    restartFillMs: z.number().default(600),
    copyFeedbackMs: z.number().default(1600),
    // host/client schema 对齐：该键为 client 状态机参数，host 逻辑不使用，仅保持一致
    restartFailThreshold: z.number().default(2),
    // host/client schema 对齐：reload 前给 DSH 后端会话数据就绪的额外稳定窗口（ms）
    restartSettleMs: z.number().default(8000),
  }),
})

// 各功能模块 host 服务依赖并集（去重）。仅保留"注册 settings 必需 + 几乎必有"的核心服务
// （settings/systemPrompt/agents/timer）。各子模块的可选服务（sessionPersistence/webServer/tools 等）
// 一律在模块内用 ctx.get(...) 判空降级：缺失时对应功能静默跳过，不拖垮整包、不影响 client 设置页。
export const inject = Array.from(new Set([
  ...(identity.inject || []),
  ...(globalPrompt.inject || []),
  ...(autoResume.inject || []),
  ...(webRestart.inject || []),
  ...(peerMessage.inject || []),
  ...(sessionAdmin.inject || []),
  ...(logReposition.inject || []),
  ...(promptDedup.inject || []),
  ...(promptLiteral.inject || []),
  ...(uiConfig.inject || []),
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
  safe(sessionAdmin.apply, ctx, null, 'session-admin')
  safe(logReposition.apply, ctx, null, 'log-reposition')
  safe(promptDedup.apply, ctx, c.promptDedup || {}, 'prompt-dedup')
  safe(promptLiteral.apply, ctx, null, 'prompt-literal')
  safe(uiConfig.apply, ctx, c.client || {}, 'ui-config')
}
