import * as identity from './identity.js'
import * as globalPrompt from './global-prompt.js'
import * as autoResume from './auto-resume.js'
import * as webRestart from './web-restart.js'
import * as peerMessage from './peer-message.js'
import * as sessionAdmin from './session-admin.js'
import * as logReposition from './log-reposition.js'
import * as promptDedup from './prompt-dedup.js'
import * as promptLiteral from './prompt-literal.js'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-session-toolkit'

// 聚合包单一 Config：各功能分键，默认值 = 现状（行为零变化）。
// 可在 cordis.yml / cordis.patch.yml 的插件行 config 字段覆盖，无需改代码。
//
// 用户数据（身份文本、全局/工作区提示词、自动上线开关、UI 旋钮）标 `.volatile()`：
// 它们是 DSH 0.1.7 起 settings 表单的唯一数据面——settings 只投影 volatile 字段，
// 浏览器半通过 `ctx.configForms.get('session-toolkit')` 读写本条目 config，落盘在
// 当前 profile 的 cordis.patch.yml（不再是 settings.yaml 的命名空间）。
// 普通字段（上限、顺序、重试、并发等部署参数）保持非 volatile：它们只走 cordis 配置。
export const Config = z.object({
  identity: z.object({
    maxText: z.number().default(8000),
    sectionOrder: z.number().default(40),
    // 身份文本：默认身份 + 每会话记录（键 = session id）
    default: z.object({
      enabled: z.boolean().default(false),
      text: z.string().default(''),
    }).volatile(),
    sessions: z.dict(z.object({
      enabled: z.boolean().default(true),
      text: z.string().default(''),
    })).default({}).volatile(),
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
    // 全局提示词：启用开关 + 文本 + 引用文件列表
    enabled: z.boolean().default(false).volatile(),
    content: z.string().default('').volatile(),
    files: z.array(z.string()).default([]).volatile(),
  }),
  // 按工作区提示词：每个工作区 enabled/content/files + removed（用户已移除的 path）
  workspacePrompt: z.object({
    workspaces: z.dict(z.object({
      enabled: z.boolean().default(false),
      content: z.string().default(''),
      files: z.array(z.string()).default([]),
    })).default({}).volatile(),
    removed: z.array(z.string()).default([]).volatile(),
  }),
  autoResume: z.object({
    concurrency: z.number().default(3),
    // 每会话「重启后自动上线」开关；缺省键视为关闭
    sessions: z.dict(z.boolean()).default({}).volatile(),
  }),
  webRestart: z.object({
    scriptPath: z.string(), // 可选：缺省时推导（schemastery 对象字段缺省即不填）
    spawnDelayMs: z.number().default(500),
  }),
  promptDedup: z.object({
    enabled: z.boolean().default(true),
  }),
  // 【提醒】新增 client 旋钮必须同步两处：本 Config.client（浏览器经 configForms 读到的
  // 真源）与 client/client.js 的 UI_FALLBACK（表单不可用时的冻结兜底值）。
  client: z.object({
    identityCharLimit: z.number().default(4000).volatile(),
    restartTimeoutMs: z.number().default(90000).volatile(),
    restartPollMs: z.number().default(1000).volatile(),
    restartFillMs: z.number().default(600).volatile(),
    copyFeedbackMs: z.number().default(1600).volatile(),
    // host/client schema 对齐：该键为 client 状态机参数，host 逻辑不使用，仅保持一致
    restartFailThreshold: z.number().default(2).volatile(),
    // host/client schema 对齐：reload 前给 DSH 后端会话数据就绪的额外稳定窗口（ms）
    restartSettleMs: z.number().default(8000).volatile(),
  }),
})

// 各功能模块 host 服务依赖并集（去重）。仅保留"几乎必有"的核心服务
// （systemPrompt/agents/timer）。各子模块的可选服务（settings/sessionPersistence/webServer/tools 等）
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
  safe(globalPrompt.apply, ctx, { global: c.globalPrompt || {}, workspace: c.workspacePrompt || {} }, 'global-prompt')
  safe(autoResume.apply, ctx, c.autoResume || {}, 'auto-resume')
  safe(webRestart.apply, ctx, c.webRestart || {}, 'web-restart')
  safe(peerMessage.apply, ctx, null, 'peer-message')
  safe(sessionAdmin.apply, ctx, null, 'session-admin')
  safe(logReposition.apply, ctx, null, 'log-reposition')
  safe(promptDedup.apply, ctx, c.promptDedup || {}, 'prompt-dedup')
  safe(promptLiteral.apply, ctx, null, 'prompt-literal')
}
