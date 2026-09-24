// 护栏的纯函数：工作区内容对拍（护栏 2）与写路径判定（护栏 1）。
//
// 为什么抽成独立模块（2026-09-24，裁定 #53 那批护栏工作）：
//   两条护栏原先各自内联在 `verify.selftest.mjs` 与 `auto-resume.contract.selftest.mjs` 里，
//   而**门不可被 import** —— 它的顶层就是主流程（先跑用例、最后才对拍）。于是"给护栏加自证"
//   这件事只能把门复制到临时树再跑（贵的、且要处理 exit 语义），或者干脆不加。
//   把纯函数抽出来之后：这些函数**无副作用**，可以直接 import 进断言、喂合成输入；
//   而"门确实调用了它们、并在真 ROOT 上对拍"这一层，由**变异测试**（见各门的自证块）覆盖。
//
// 判据（纳入口径）：**脚本不得改动任何「未忽略」内容**。
//   排除表与仓库自己的忽略声明对齐（.gitignore `node_modules/` `.pnpm-store/` `.DS_Store`）——
//   后者不是"好看"，而是**归因正确性**：
//     · `.pnpm-store/` 是 pnpm 的内容寻址存储（`pnpm install` 会写它）
//     · `.DS_Store` 是 macOS 元数据（Finder 会写它）
//   两者都**与"脚本有没有写工作区"无关**。若不排除，这一格会报 `workspace-immutability`
//   却并非脚本所为 ⇒ **读数正确但归因错**。
//   实测（2026-09-24，本仓库根）：清单 1524 条 = `.pnpm-store/` 1474 + `.DS_Store` 1 + 真被测面 **49**，
//   噪声/信号 = 30.1 : 1；排除后被测面收敛为那 49 条（`lib/**`、`docs/**`、`scripts/**`、`client/` 等），
//   报红时能直接指到"哪一条被改"，而不必在 1474 条噪声里找。
//   四个数的复算见 `scripts/verify.selftest.mjs` 的 `guard2/*` 自证项（会打印清单条数）。
//
// ⚠️ 维护约定（改本文件前先读这三条）：
//   ① **本排除表必须与仓库根 `.gitignore` 保持同步**。`.gitignore` 新增了一条忽略项、而本表没跟，
//      那一格会在下次对拍时报 `workspace-immutability` —— 但**归因是错的**：写它的是 `.gitignore`
//      所忽略的那些工具（构建产物、编辑器临时文件…），不是脚本。看到这类红先查 `.gitignore`，
//      不要先怀疑被测脚本，也不要靠"把它加进本表"来消红（那要同时说清它为什么不是脚本所为）。
//   ② 上面那个「**49**」是 **2026-09-24 的基线**，此后随树增长：新增的源码/文档/脚本都会进被测面。
//      （同刻复量已是 **50** —— 多出来的那一条正是本模块 `scripts/lib/manifest-guard.mjs` 自己。）
//      所以**不要把这个数当判据**：判据只有 `guard2/清单-自证·非空` 的 `>= 10`；这个数只是量级说明。
//   ③ 纯函数、无副作用。改判据时只动导出函数的语义，不要在模块顶层写任何 I/O 或 `process.exit`。

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const IGNORE_DIRS = new Set(['.git', 'node_modules', '.pnpm-store'])
export const IGNORE_FILES = new Set(['.DS_Store'])

/**
 * 对一棵树做内容清单：相对路径 → sha256。跳过 IGNORE_DIRS / IGNORE_FILES。
 * 纯读：不写任何文件。
 * @param {string} dir 树根
 * @returns {Map<string, string>}
 */
export function manifest(dir) {
  const out = new Map()
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) walk(p)
      } else if (e.isFile()) {
        if (IGNORE_FILES.has(e.name)) continue
        out.set(
          path.relative(dir, p).split(path.sep).join('/'),
          createHash('sha256').update(readFileSync(p)).digest('hex'),
        )
      }
    }
  }
  walk(dir)
  return out
}

/**
 * 两份清单的差异，三分支：内容变化 / 新增 / 删除。
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 * @returns {string[]} 差异描述（空数组 = 无差异）
 */
export function manifestDiff(before, after) {
  const diffs = []
  for (const [k, v] of after) if (before.get(k) !== v) diffs.push(before.has(k) ? `内容变化: ${k}` : `新增: ${k}`)
  for (const k of before.keys()) if (!after.has(k)) diffs.push(`删除: ${k}`)
  return diffs
}

/** a 是否等于 b、或位于 b 之下（按路径分量，不做字符串前缀匹配）。 */
export function within(a, b) {
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
}

/**
 * 护栏 1 的判据（裁定 #11）：写路径必须在 `tmpBase` 之下，且与 `root` **双向**无前缀包含关系。
 * 不满足时调用 `onViolation`（默认直接抛错）。返回 true = 放行；抛错 = 拒绝。
 * 注意：这里**不再自己 `process.exit`** —— 让调用方决定拒绝的形式（门用 exit，测试用异常）。
 * @returns {true}
 */
export function assertOutsideWorkspace(p, label, { root, tmpBase, onViolation } = {}) {
  const abs = path.resolve(p)
  const inTmp = within(abs, tmpBase)
  const nested = within(abs, root) || within(root, abs)
  if (inTmp && !nested) return true
  const msg = `护栏 1 触发：${label} → ${abs}\n`
    + `  必须在 ${tmpBase} 之下，且与工作区根（${root}）之间不得存在前缀包含关系（双向）。拒绝继续。`
  if (onViolation) {
    onViolation(msg)
    return true
  }
  throw new Error(msg)
}
