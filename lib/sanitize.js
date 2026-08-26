// 提示词 sanitize（identity.js / global-prompt.js 共享）：
// 连续 { 全部空格化（`{{{x}}}` → `{ { {x}}}`），避免重叠匹配残留完整 {{var}} 组，
// 被变量插值器当作引用（未注册则 throw，导致该会话每轮组装失败）。
export function sanitize(content) {
  return content.replace(/\{+/g, (m) => m.split('').join(' '))
}
