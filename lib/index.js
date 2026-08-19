import * as identity from './identity.js'
import * as globalPrompt from './global-prompt.js'
import * as autoResume from './auto-resume.js'
import * as webRestart from './web-restart.js'
import * as peerMessage from './peer-message.js'
import * as logReposition from './log-reposition.js'

export const name = 'dsh-dev'

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

function safe(applyFn, ctx, label) {
  try {
    applyFn(ctx)
  } catch (e) {
    console.warn('[dsh-dev] host module ' + label + ' apply failed: ' + (e && e.message ? e.message : String(e)))
  }
}

export function apply(ctx) {
  safe(identity.apply, ctx, 'identity')
  safe(globalPrompt.apply, ctx, 'global-prompt')
  safe(autoResume.apply, ctx, 'auto-resume')
  safe(webRestart.apply, ctx, 'web-restart')
  safe(peerMessage.apply, ctx, 'peer-message')
  safe(logReposition.apply, ctx, 'log-reposition')
}