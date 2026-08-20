# dsh-session-toolkit

> DeepSeek Harness 工作台插件整合包 · [English README](README.en.md)

将 6 个独立本地插件整合为一个统一插件的功能包:会话身份、全局提示词、会话自动恢复、Web 服务重启、Session log 按钮平移、会话间对等消息。

## ✨ 功能特性

| 功能 | 说明 |
|---|---|
| 会话身份 | 每会话人设注入(`systemPrompt` 段),支持浮层编辑与双入口按钮(会话头部/输入框左侧),每会话独立开关行 |
| 全局提示词 | 设置页配置 + 系统提示词段注入,含 `/\{+/g` 连续花括号 sanitize 修复 |
| 会话自动恢复 | 开关开启的会话在重启后自动 `resume`,带过滤链、并发控制与失败隔离 |
| Web 服务重启 | 设置页一键重启 DSH Web 服务,零 UAC 提权,带覆盖层进度条 |
| Session log 按钮平移 | 遮蔽官方 utilities 下载按钮,在 actions 槽复刻,复用官方 controller |
| 会话间对等消息 | `send_to_session` / `list_sessions` 工具 + 复制会话 ID 按钮(双入口) |

## 📦 安装

1. 将本包放置到 DSH Web profile 的 `node_modules` 下:

   ```powershell
   # 示例:Windows 用户目录下的 web profile
   C:\Users\<user>\.dsh\profiles\web\node_modules\dsh-session-toolkit
   ```

   推荐使用 junction 链接到源码目录,便于开发时热更新:

   ```powershell
   cmd /c mklink /J "C:\Users\<user>\.dsh\profiles\web\node_modules\dsh-session-toolkit" "D:\path\to\dsh-session-toolkit"
   ```

2. 在 profile 的 `cordis.patch.yml` 中注册插件:

   ```yaml
   - id: session-toolkit
     name: 'dsh-session-toolkit'
   ```

3. 重启 DSH Web 服务(GUI 设置页或命令行)生效。

> 原 6 个独立插件条目需从 `cordis.patch.yml` 移除(或保持 `disabled: true` 抑制,如官方 `dsh-global-prompt`),避免功能重复注册。

## ⚙️ 配置

所有配置经 `settings.yaml` 落盘,各命名空间与整合前完全兼容,已有数据保留。修改后多数配置实时生效(`applies: 'live'`)。

### 会话身份 `session-identity`

```yaml
session-identity:
  default:
    enabled: true
    text: "你是……"          # 未单独配置的会话使用默认身份
  sessions:
    "<sessionId>":
      enabled: true
      text: "本会话专属人设……"
```

解析优先级:会话记录 → 默认身份;`enabled` 非 `true` 或文本为空 → 不注入。单条身份文本上限 8000 字符(超长自动截断并告警,防 token 成本失控)。

### 会话自动恢复 `session-auto-resume`

```yaml
session-auto-resume:
  sessions:
    "<sessionId>": true
```

恢复过滤链:开关开启 + 顶层会话(非 subagent、无 parentSession)+ 非空白(`seedLength !== 0`)。开关关闭仅影响下次重启,不会下线当前会话。自动 resume 时携带默认模型(agentDefaultModel 的 provider/model/reasoningEffort),避免 `{{model}}` 变量无值导致 persona 段渲染失败;会话自定义模型仍走会话请求头/agent/request waterfall,与 GUI 打开行为一致。

### 全局提示词 `global-prompt`

```yaml
global-prompt:
  enabled: true
  content: "你的全局提示词……"
```

## 🚀 使用

- **会话身份**:在会话头部操作区或输入框左侧点击身份按钮,浮层中编辑本会话人设,可一键启用/停用;身份随每轮请求实时注入。
- **自动恢复**:在会话头部开关行开启后,重启 DSH 后该会话自动上线(并发上限 3)。
- **重启服务**:设置页点击"重启服务",覆盖层进度条显示重启进度,90s 超时兜底。
- **复制会话 ID**:会话头部操作区或输入框左侧按钮,点击复制当前会话 ID,配合 `send_to_session` 使用。
- **会话间消息**:在任意会话中调用 `send_to_session` / `list_sessions` 工具,向其他会话发送或接收消息。

## 🏗️ 架构

- **host 半**:`lib/index.js` 组装入口,按功能拆分 6 个子模块(`lib/identity.js`、`lib/global-prompt.js`、`lib/auto-resume.js`、`lib/web-restart.js`、`lib/log-reposition.js`、`lib/peer-message.js`),统一 inject 依赖,模块级 `safe()` 失败隔离。
- **client 半**:`client/client.js` 单文件内联(`__ModuleLoader__` 只解析平台模块),注册 UI 插槽:
  - `settings.section`:全局提示词(id `global-prompt`)
  - `settings.general.item`:重启服务(id `web-restart`)
  - `conversation.session.header.actions`:复制 ID(30)/ 身份(40)/ Session log(41)
  - `conversation.input.left`:身份(40)/ 复制 ID(30)
  - `conversation.session.header.utilities`:遮蔽官方下载按钮(id `session-log-download`,priority -1)

### ⚠️ 红线

- **自动恢复绝不调用 `dispose()`**:会从存储删除会话;关闭开关≠下线,仅影响下次重启。
- **身份注入**:subagent(带 `origin` / `delegationDepth` 标记)不注入身份;`/\{+/g` 连续花括号会被空格化转义,避免被变量插值器误解析。

## 🗑️ 卸载

1. 从 `cordis.patch.yml` 移除 `session-toolkit` insert 条目(如需回退,恢复原插件注册条目)。
2. 删除 profile `node_modules` 下的 `dsh-session-toolkit`(或移除 junction)。
3. 重启 GUI 即回到整合前状态。

## ⚠️ 已知限制

- client 半为单文件内联,功能模块以代码注释分区;新增功能需同步维护 `lib/` 与 `client/client.js` 两处。
- Session log 复刻按钮依赖官方 `sessionLogDownload` controller 接口,官方包升级若变更接口需同步(见 `lib/log-reposition.js` 注释)。
- 身份注入每轮请求携带身份文本 token(与 persona/全局提示词一致)。

## 📄 许可证

[MIT](LICENSE)
