// 提示词 sanitize（旧内核兜底，唯一调用方是 lib/prompt-literal.js）：
// 连续 { 全部空格化（`{{{x}}}` → `{ { {x}}}`），避免重叠匹配残留完整 {{var}} 组，
// 被变量插值器当作引用（未注册则 throw，导致该会话每轮组装失败）。
// 新内核直接把段声明为 interpolate: false 即可，本函数只在旧内核上被触发。
export function sanitize(content) {
  return content.replace(/\{+/g, (m) => m.split('').join(' '))
}
