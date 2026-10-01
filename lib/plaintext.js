/**
 * 轻量 markdown → 纯文本清洗（方案 B：send_to_session 发送前清洗，接收方纯文本渲染下整洁可读）。
 * 1. 代码块：``` / ~~~ 围栏行删除，围栏内内容原样保留（状态机内不做行内处理）；
 *    闭栏必须与开栏**同字符**（``` 不会被 ~~~ 关闭）；未闭合的围栏延伸到文末
 * 2. 行内代码：`x` → x（代码跨度内的链接字面量不展开）
 * 3. 粗体 **x** → x；斜体 *x* → x；删除线 ~~x~~ → x（宽松匹配）
 * 4. 标题：# 开头 → 去掉 # 号与随后空格
 * 5. 引用：> 行 → 去掉开头 >
 * 6. 列表：- / * 开头 → • ；数字列表保留原样
 * 7. 链接：[text](url) → text (url)（在代码跨度之外的文本上进行）
 * 8. 表格：| a | b | → 去首尾竖线；分隔线行（| --- |）删除
 * 9. 分隔线：--- / *** / ___ 单独成行 → ────（允许字符间空格，如 `- - -`；允许前置引用标记，如 `> ---`）
 * 10. 其余原样。中文/URL/文件路径不受影响；宽松匹配不追求完美。
 */
export function toPlainText(markdown) {
  if (typeof markdown !== 'string') return ''
  const lines = markdown.split('\n')
  const out = []
  let inCodeBlock = false
  let openFence = null
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    // 1. 代码块围栏（``` / ~~~）：闭栏必须与开栏**同字符**（CommonMark 语义；L9-15）。
    //    未闭合的围栏延伸到文末 —— 这半是原实现已正确的行为，不动。
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const ch = fence[1][0]
      if (!inCodeBlock) { inCodeBlock = true; openFence = ch; continue } // 开栏行删除
      if (ch === openFence) { inCodeBlock = false; openFence = null; continue } // 同字符闭栏行删除
      // 异字符围栏行落在代码块内部 ⇒ 它是代码内容，交给下面的 inCodeBlock 分支原样保留
    }
    if (inCodeBlock) {
      out.push(line) // 围栏内原样保留
      continue
    }
    // 9. 纯分隔线：--- / *** / ___ 单独成行 → ────
    //    L9-17：允许前置引用标记（`> ---` 必须与 `---` 同结果；本判定在下面的引用剥离之前）；
    //    L9-20：允许字符间空格（`- - -` 在 CommonMark 里就是分隔线，不得落进下面的列表规则变成 `• - -`）。
    if (/^\s*(?:>\s?)*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      out.push('────')
      continue
    }
    // 8. 表格分隔线行（含首尾 |）：删除
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue
    // 8. 表格行：去首尾竖线
    if (line.trim().startsWith('|')) {
      let t = line.trim()
      if (t.startsWith('|')) t = t.slice(1)
      if (t.endsWith('|')) t = t.slice(0, -1)
      line = t
    }
    // 4. 标题：去 # 号与随后空格
    line = line.replace(/^\s*#{1,6}\s+/, '')
    // 5. 引用：去开头 >
    line = line.replace(/^\s*>\s?/, '')
    // 6. 列表：- / * 开头 → •
    line = line.replace(/^\s*[-*]\s+/, '• ')
    // 2. 行内代码：`x` → x —— L9-19：链接替换必须在「代码跨度已被剔除」的文本上进行，
    // 否则 `` `[a](b)` `` 这段字面量会被当链接展开。
    // 用 split 把代码跨度与非代码段分开处理，**不用占位符**：占位符必须用输入可达的字符做内部标记，
    // 输入里恰好含同样标记就会被伪造（非作者复核实测 `toPlainText('`REAL` \u00000\u0000')` 会吐出
    // 伪造的代码跨度内容）。split 不引入任何输入可达的内部标记，因而没有这个面。
    line = line.split(/(`[^`]*`)/).map((part, i) => (i % 2 === 1)
      ? part.slice(1, -1) // 代码跨度：去掉反引号、原样保留其内容
      : part.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)')).join('')
    // 3. 粗体 → 删除线 → 斜体（宽松，顺序避免嵌套误伤）
    line = line.replace(/\*\*([^*]+)\*\*/g, '$1')
    line = line.replace(/~~([^~]+)~~/g, '$1')
    // L9-18：斜体要求**左星号后、右星号前都紧邻非空白**（CommonMark 的定界符规则；
    // 但不要求左星号之前非空白 —— `a *b* c` 里的强调是合法的），
    // 否则 `2 * 3 * 4` 这种「星号两端带空格」的算式会被吞掉。
    line = line.replace(/(^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\*)/g, '$1$2')
    out.push(line)
  }
  return out.join('\n')
}