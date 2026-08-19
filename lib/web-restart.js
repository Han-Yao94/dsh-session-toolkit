import { spawn } from 'node:child_process'

export const inject = ['webServer']

const RESTART_SCRIPT = 'C:\\Users\\Francis Han\\.dsh\\autostart\\dsh-web-restart.cmd'

export function apply(ctx) {
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
        // 缓冲 500ms 让 202 送达浏览器后再 spawn（服务器随后自毁）
        setTimeout(() => {
          let child
          try {
            child = spawn('cmd.exe', ['/c', '"' + RESTART_SCRIPT + '"'], {
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
          child.on('exit', () => {
            inFlight = false
          })
          child.unref()
        }, 500)
        return
      }
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
    },
  }), 'dsh-web-restart: routes')
}