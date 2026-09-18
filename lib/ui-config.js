import z from '@deepseek-ai/schemastery'

export const inject = ['settings']

// 浏览器半的旋钮命名空间。
//
// 为什么需要它：client 条目由 client-modules 以 `loader.create({ name })` 创建，
// boot graph 的行里只有 id/url/rev/inject/immediately/external——**没有任何 config
// 通道**，而且 client bundle 拿不到 @deepseek-ai/schemastery（不在平台模块表里），
// 连自己的 Config 都导不出去。所以 cordis 插件行的 `client.*` 配置根本到不了浏览器。
// settings 命名空间是官方支持的唯一 host→browser 配置通道：host 注册 + client bind。
export const UI_NAMESPACE = 'session-toolkit-ui'

// 兜底默认值：命名空间不可用（host 半未加载、远端连接是 memory 模式等）时 client 用这份。
export const UI_DEFAULTS = {
  identityCharLimit: 4000,
  restartTimeoutMs: 90000,
  restartPollMs: 1000,
  restartFillMs: 600,
  restartFailThreshold: 2,
  restartSettleMs: 8000,
  copyFeedbackMs: 1600,
}

// Config.client（插件行 config.client.*）作为组合 base 层：它照样可以覆盖默认值，
// 用户在 settings.yaml 里的值再覆盖它；三者顺序 = schema 默认 → base → 用户层。
export function apply(ctx, cfg) {
  const base = (cfg && typeof cfg === 'object') ? cfg : {}
  ctx.settings.register(UI_NAMESPACE, z.object({
    identityCharLimit: z.number().default(UI_DEFAULTS.identityCharLimit),
    restartTimeoutMs: z.number().default(UI_DEFAULTS.restartTimeoutMs),
    restartPollMs: z.number().default(UI_DEFAULTS.restartPollMs),
    restartFillMs: z.number().default(UI_DEFAULTS.restartFillMs),
    restartFailThreshold: z.number().default(UI_DEFAULTS.restartFailThreshold),
    restartSettleMs: z.number().default(UI_DEFAULTS.restartSettleMs),
    copyFeedbackMs: z.number().default(UI_DEFAULTS.copyFeedbackMs),
  }), { applies: 'live', base })
}
