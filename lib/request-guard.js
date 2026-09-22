// request-guard — 本插件自有 HTTP 路由的共用 Origin 守卫（安全加固）。
//
// 为什么需要它：本插件的两条路由是用 `webServer.register()` 直接注册的**原始路由**，
// 绕过了 harness 覆盖 `/api/` 前缀的鉴权网关（实测：不存在的 `/api/__probe_nonexistent__`
// 都是 401，而 `/api/restart`、`/api/session-toolkit/state` 是 200）。⇒ 浏览器里任意一个
// 页面都能对它们发起**简单请求**（无自定义头 ⇒ 无预检 ⇒ 直接发得出去）：
//   · `/api/restart` 是改状态的（POST）⇒ 可被跨站触发重启（中断/DoS，不丢数据）；
//   · `/api/session-toolkit/state` 只读且响应无 CORS 头 ⇒ 跨域页面能发、读不到，危害低一档。
// 本模块只做**来源判定**：不是鉴权、不引入 token/会话校验，也不依赖 harness 的鉴权 API
// （那是另一件事，另案处理）。
//
// 规则（A 定，本模块实现）：
//   1. 带 `Origin` ⇒ 取其 host（`hostname[:port]`，忽略 scheme）与请求的 `Host` 比对；
//      不一致 ⇒ 403 + {"ok":false,"error":"origin not allowed"}。
//   2. `Origin: null` ⇒ **一律 403**（沙箱 iframe、跨域重定向会发这个）——**不当"缺失"放行**。
//   3. 无 `Origin` ⇒ 放行（curl / 本地脚本 / 同源 GET；浏览器对同源 GET 通常不发 Origin）。
//   4. `Host` 缺失（HTTP/1.0）⇒ **判定为拒绝（403）**。理由见下「Host 缺失为何选拒绝」。
//
// 为什么比较「Origin 的 host」与「Host」而不是比较完整 Origin 与某个白名单：
// 浏览器发送 Origin 时带的是**发出页面的源**，而对同源请求，Host 与 Origin 的 host 必然相同
// ⇒ 「两者 host 相等」是同源的**充要条件**，不需要额外维护一份允许列表（也就不会与部署漂移）。
//
// Host 缺失为何选拒绝（A 要求写清理由）：合法的 HTTP/1.1 请求**必须**带 Host，浏览器一定会带；
// 而缺 Host 的请求无法判断来源，按「默认拒绝」处置与 harness 自身的 `/api/` 鉴权行为一致
// （覆盖整个前缀且默认拒绝）。代价是 HTTP/1.0 客户端与本机某些极简探测工具会被 403 —— 这是
// 有意的：本插件这两条路由没有面向 HTTP/1.0 的承诺，而放行会让守卫在缺 Host 时被绕过。
import { URL } from 'node:url'

/** 保留字面量：与 harness 的 `WebServer.host` 同一取值域（webserver/src/index.ts:61）。 */
export const LOOPBACK_BIND = '127.0.0.1'
export const ALL_INTERFACES_BIND = '0.0.0.0'

/**
 * 与 harness `isLoopbackHostname`（client/connection/src/loopback-hostname.ts:12）**同口径**：
 * `localhost` · `[::1]`（`URL().hostname` 对 IPv6 带方括号）· `127.x.x.x`（四段且各段 0..255）。
 * 兼容无方括号的 `::1` 写法，以免上游解析器变化时静默失效。
 */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string') return false
  const h = hostname.trim().toLowerCase()
  if (h === 'localhost' || h === '[::1]' || h === '::1') return true
  const parts = h.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 把 `host[:port]` 解析成 URL（与 harness `parseAuthority` 同法：喂给 `new URL('http://' + authority)`）。 */
function parseAuthority(authority) {
  try {
    return new URL('http://' + authority)
  } catch {
    return undefined
  }
}

/**
 * 不依赖任何外部服务：仅做字符串/URL 解析，纯函数，便于单独抽取自测（见交付证据）。
 * @param req - Node 的 `IncomingMessage`（只需 `.headers`）。
 * @param opts.bindHost - **webServer 的绑定字面量**（`'127.0.0.1'` | `'0.0.0.0'`）。
 *   生产侧由 `webServer.host` 提供（调用点本来就在 `ctx.inject(['webServer'], …)` 回调里）。
 *   缺省按 `'127.0.0.1'` 处理（安全侧默认，fail-closed）。
 */
export function isSameOriginRequest(req, opts = {}) {
  const headers = (req && req.headers) || {}
  const bindHost = typeof opts.bindHost === 'string' && opts.bindHost.length > 0 ? opts.bindHost : LOOPBACK_BIND
  const host = typeof headers.host === 'string' ? headers.host.trim().toLowerCase() : ''

  // 栅栏 B（纵深防御）：`sec-fetch-site: cross-site` ⇒ 拒。**它堵不住 DNS rebinding**
  // —— rebinding 的请求在浏览器看来是同源，带的是 `same-origin`。别把这一行当 rebinding 的解药。
  // 缺失该头 ⇒ 放行（非浏览器客户端不发它，与 Origin 的处理一致）。
  const secFetchSite = typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'].trim().toLowerCase() : ''
  if (secFetchSite === 'cross-site') return { ok: false, reason: 'sec-fetch-site-cross-site' }

  // 栅栏 A（唯一能防 DNS rebinding 的一道）：除非绑定是"全部接口"，否则 Host 必须是 loopback 字面量。
  // 原理：rebinding 页面相信自己在跟 `evil.com` 说话 ⇒ Host 带攻击者的域 ⇒ 落在这条之外。
  // 只在 `0.0.0.0` 绑定时**不施加**：那种部署下没有"名字"可判别，施加会把局域网正当客户端一起拒掉
  // （残余限制见交付文本与契约表）。
  //
  // ⚠️ **为什么是 `!== ALL_INTERFACES_BIND` 而不是 `=== LOOPBACK_BIND`**（裁定 #11-①，D 第二轮复核挖出）：
  //   等值写法在 `bindHost` 取**任何第三个值**时（如将来新增"绑到某个具体网卡地址"）会**整个跳过**栅栏 A
  //   ⇒ fail-open，且**静默** —— D 实测：`bindHost='10.0.0.1'` + `Host: evil.com:3080` ⇒ 放行。
  //   虽然 `Config.host` 当前类型是 `'127.0.0.1' | '0.0.0.0'`（webserver/src/index.ts:61，注释写明
  //   "the two supported values are loopback and all-interfaces"）⇒ 该分支**当前不可达**；但**契约变宽时，
  //   守卫必须变严而不是变松**。判据：**偏严会被立刻发现，偏松不会。**
  //   代价照实写明：将来若真的出现第三种绑定模式（例如绑到某具体网卡地址），本栅栏会被施加 ⇒
  //   **该部署下局域网正当客户端会被拒**。这是有意的取舍：宁可响得早，也不要哑着漏；
  //   且它会**当场被使用者发现**，从而回来修这条规则。
  if (bindHost !== ALL_INTERFACES_BIND) {
    if (host === '') return { ok: false, reason: 'no-host' }
    const hostUrl = parseAuthority(host)
    if (hostUrl === undefined) return { ok: false, reason: 'host-unparsable' }
    if (!isLoopbackHostname(hostUrl.hostname)) return { ok: false, reason: 'host-not-loopback' }
  }

  // 规则 3：无 Origin ⇒ 放行（此时栅栏 A 已把 Host 限定在 loopback；rebinding 已被挡在上面）。
  const rawOrigin = headers.origin
  if (rawOrigin === undefined || rawOrigin === null) return { ok: true, reason: 'no-origin' }
  const origin = typeof rawOrigin === 'string' ? rawOrigin.trim() : ''
  // 规则 2：`Origin: null` 一律拒绝（**先于**「空 Origin」放行判断，避免被当成缺失）。
  if (origin === '' || origin.toLowerCase() === 'null') return { ok: false, reason: 'origin-null' }
  // 规则 4：Host 缺失（HTTP/1.0）⇒ 拒绝。绑 0.0.0.0 时栅栏 A 不跑，故这条在此仍需独立判定。
  if (host === '') return { ok: false, reason: 'no-host' }
  // 规则 1：取 Origin 的 host（hostname[:port]）与 Host 比对。
  let originHost
  try {
    const parsed = new URL(origin)
    originHost = parsed.host.toLowerCase()
  } catch {
    // 解析不出 host（畸形 Origin）⇒ 拒绝。默认拒绝与 harness 的 /api/ 鉴权取向一致。
    return { ok: false, reason: 'origin-unparsable' }
  }
  if (originHost === '') return { ok: false, reason: 'origin-unparsable' }
  // ⚠️ **两侧必须做同样的规范化**：`new URL('http://h:80').host === 'h'`（URL 解析**省略默认端口**），
  // 而 `Host: h:80` 会保留 `:80` ⇒ 若拿 URL 规范化后的 originHost 去比**原始** Host，
  // 显式写默认端口的同源请求会被误拒（自检当场抓到过这一条）。故 Host 也按同样口径规范化：
  // 显式默认端口（http:80 / https:443）视同省略。
  // 与 harness 同口径的旁证：官方 `parseAuthority` 也是把 authority 喂给 `new URL('http://' + …)`，
  // 即同样省略默认端口 ⇒ 浏览器实际发来的（不含默认端口）两侧行为一致。**不引入允许列表。**
  const normalizeHost = (value) => value
    .replace(/:80$/i, '')
    .replace(/:443$/i, '')
  const hostNorm = normalizeHost(host)
  const originNorm = normalizeHost(originHost)
  if (originNorm !== hostNorm) return { ok: false, reason: 'origin-mismatch' }
  return { ok: true, reason: 'same-origin', originHost, host, bindHost }
}

/**
 * 守卫的 HTTP 薄层：不放行就写出 403 并返回 false，放行返回 true。
 * 两条路由共用本函数 ⇒ 规则不会在两个文件里各写一遍而漂移。
 * 错误体风格与既有 405 分支对齐：{"ok":false,"error":"…"}。
 * @param bindHost - 见 {@link isSameOriginRequest}；生产侧传 `webServer.host`。
 */
export function originGuard(req, res, bindHost) {
  const verdict = isSameOriginRequest(req, { bindHost })
  if (verdict.ok) return true
  res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ ok: false, error: 'origin not allowed' }))
  return false
}
