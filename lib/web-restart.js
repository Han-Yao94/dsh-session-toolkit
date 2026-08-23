import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

export const inject = ['webServer', 'timer']

// 隐藏启动器：wscript.exe（GUI 子系统，无控制台窗口）执行同名目录下的
// launcher vbs，由 vbs 以隐藏窗口、独立进程方式运行重启脚本。
const launcherVbs = fileURLToPath(new URL('dsh-web-restart-launcher.vbs', import.meta.url))

export function apply(ctx, cfg) {
  // Config 分键（webRestart.scriptPath 可选覆盖 / spawnDelayMs），缺省兜底默认值。
  // scriptPath 缺省时由 DSH home 推导（$DSH_HOME → ~/.dsh，见 @deepseek-ai/dsh-home-paths）。
  const scriptPath = (cfg && typeof cfg.scriptPath === 'string' && cfg.scriptPath.length > 0)
    ? cfg.scriptPath
    : dshHomePath('autostart', 'dsh-web-restart.cmd')
  const spawnDelayMs = (cfg && typeof cfg.spawnDelayMs === 'number') ? cfg.spawnDelayMs : 500
  let inFlight = false

  // P1-1：register 返回 disposer，包 ctx.effect 绑定插件生命周期（热重载不重复注册、卸载时注销）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/restart',
    handler: (req, res) => {
      if (req.method === 'GET') {
        // 健康探测端点：恒 200（新服务器加载本插件后路由自动恢复，客户端轮询依赖它）
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.method === 'POST') {
        if (inFlight) {
          res.writeHead(409, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'restart already in flight' }))
          return
        }
        inFlight = true
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        // 缓冲 500ms 让 202 送达浏览器后再 spawn（服务器随后自毁）；
        // 用 ctx.timeout（timer 服务）：插件卸载时回调被清理，不会在卸载后触发 spawn。
        ctx.timeout(() => {
          let child
          try {
            // 用 wscript + launcher vbs 启动重启脚本：wscript.exe 无控制台窗口，
            // vbs 以 sh.Run(..., 0, False) 隐藏窗口 + 异步独立运行，从而——
            //  1) 不再弹出 cmd 控制台窗口（此前的 detached cmd 会创建新 console，
            //     windowsHide 对 detached 进程不可靠）；
            //  2) 重启脚本作为独立进程，父进程（GUI，被脚本 taskkill）退出后仍
            //     完整执行（杀旧 → relaunch → 等端口恢复）。
            // 注意：不要手动给 wscript 的参数加引号；spawn(shell:false) 会对含空格
            // 参数按 Windows 规则自动转义。vbs 内部对 cmd /c 的引号是另一套规则。
            child = spawn('wscript.exe', [launcherVbs, scriptPath], {
              detached: true,
              windowsHide: true,
              stdio: 'ignore',
              shell: false,
            })
          } catch (e) {
            console.warn('[dsh-web-restart] spawn failed: ' + (e && e.message ? e.message : String(e)))
            inFlight = false // 重置，允许重试
            return
          }
          child.on('error', (e) => {
            console.warn('[dsh-web-restart] spawn error: ' + (e && e.message ? e.message : String(e)))
            inFlight = false
          })
          // P2-1：脚本结束（成功或失败）即重置 inFlight——避免 taskkill 失败 + elevated 中断后
          // 本进程永久 409 卡死；重启成功场景本进程自毁，重置无副作用。
          // 补充：非零退出码单独告警——cmd 找不到脚本/脚本内部失败时只触发 'exit'（无 'error' 事件），
          // 仅重置 inFlight 会让失败完全静默，需可诊断。
          child.on('exit', (code) => {
            if (code !== 0) {
              console.warn('[dsh-web-restart] restart script exited with code ' + code)
            }
            inFlight = false
          })
          child.unref()
        }, spawnDelayMs)
        return
      }
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
    },
  }), 'dsh-web-restart: routes')
}