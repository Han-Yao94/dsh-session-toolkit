/**
 * 轻量 markdown → 纯文本清洗（方案 B：send_to_session 发送前清洗，接收方纯文本渲染下整洁可读）。
 * 1. 代码块：``` / ~~~ 围栏行删除，围栏内内容原样保留（状态机内不做行内处理）
 * 2. 行内代码：`x` → x
 * 3. 粗体 **x** → x；斜体 *x* → x；删除线 ~~x~~ → x（宽松匹配）
 * 4. 标题：# 开头 → 去掉 # 号与随后空格
 * 5. 引用：> 行 → 去掉开头 >
 * 6. 列表：- / * 开头 → • ；数字列表保留原样
 * 7. 链接：[text](url) → text (url)
 * 8. 表格：| a | b | → 去首尾竖线；分隔线行（| --- |）删除
 * 9. 分隔线：--- / *** / ___ 单独成行 → ────
 * 10. 其余原样。中文/URL/文件路径不受影响；宽松匹配不追求完美。
 */
export function toPlainText(markdown) {
  if (typeof markdown !== 'string') return ''
  const lines = markdown.split('\n')
  const out = []
  let inCodeBlock = false
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    // 1. 代码块围栏（``` / ~~~）
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeBlock = !inCodeBlock
      continue // 围栏行删除
    }
    if (inCodeBlock) {
      out.push(line) // 围栏内原样保留
      continue
    }
    // 9. 纯分隔线：--- / *** / ___ 单独成行 → ────
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
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
    // 7. 链接：[text](url) → text (url)
    line = line.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)')
    // 2. 行内代码：`x` → x
    line = line.replace(/`([^`]*)`/g, '$1')
    // 3. 粗体 → 删除线 → 斜体（宽松，顺序避免嵌套误伤）
    line = line.replace(/\*\*([^*]+)\*\*/g, '$1')
    line = line.replace(/~~([^~]+)~~/g, '$1')
    line = line.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1$2')
    out.push(line)
  }
  return out.join('\n')
}