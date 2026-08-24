# dsh-session-toolkit

English | [中文](README.zh.md)

Consolidated plugin toolkit for the DeepSeek Harness. Six previously separate local plugins — session identity, global prompt, session auto-resume, web restart service, Session-log button relocation, and peer-session messaging — merged into one installable package (official bundle form, `dsh.bundle.patch`), installed with `dsh plugin add`.

## Features

- **Session Identity** — a per-session persona prompt injected into that session's system prompt (independent section `session-identity`, order 40, resolved per agent at every assembly), with a default identity and per-session overrides. UI: identity dialog (enable switch, 4000-char soft limit, save/reset, edit default, inherit default) and status buttons in both `conversation.session.header.actions` (id `session-identity`, order 40) and `conversation.input.left` (id `session-identity-input`, order 40).
- **Global Prompt** — a settings page (`settings.section`, id `global-prompt`, order 30) rendered as **Tabs (Global / Per workspace)**. The *Global* tab injects one prompt into every conversation's system prompt (section `global-prompt`, order 50); the *Per workspace* tab injects per-workspace prompts (section `workspace-prompt`, order 60). `{` runs are spaced out (`/\{+/g`) to avoid prompt-variable conflicts.
- **Workspace Prompt** — per-workspace prompt injected for sessions whose `cwd` prefix-matches a configured workspace directory (the directory + its subdirectories). The workspace list is derived from **active sessions' `cwd`** (`ctx.agents.roots()`), deduplicated and counted. When several enabled workspaces prefix-match a session's `cwd`, the **most-specific (longest matching path)** one wins. `removed` records paths the user removed so the active-workspace sync never re-adds them. The workspace row's enable switch is **live-save** (persisted immediately); the Save button only persists the prompt **content + referenced files**.
- **Referenced Files** — both global and workspace prompts can reference a **list of files**. Every assembly re-reads each referenced file with `fs.readFileSync` (UTF-8, live), sanitizes its content (`{` runs spaced out), and injects it after the prompt text. A read failure is **skipped** (the file's content is not injected) and reported in the UI with the reason. Supports plain text and markdown; no size cap. Per-file read status is projected to the UI via the `prompt-file-status` namespace (`ok`: N chars / `fail`: reason / pending).
- **Session Auto-Resume** — sessions with the per-session switch on are resumed automatically after a GUI restart (`ctx.agents.resume`, carrying the default model from `agentDefaultModel`); switching a session on resumes it immediately (false→true edge). Filters: switch on, top-level only (no subagent origin, no `delegationDepth > 0`, no `parentSession`), non-blank (`seedLength !== 0`). Concurrency-bounded (`CONCURRENCY = 3`) with per-item failure isolation and an in-flight set against duplicate resume.
- **Web Restart** — a "Restart service" entry in the General settings (`settings.general.item`, id `web-restart`, order 90) that restarts the GUI server with **no UAC prompt** (the spawn inherits the server process token, so the restart script's elevated branch is never reached) and shows a full-screen progress overlay (probe-driven progress, fill-up animation before reload, 90 s timeout fallback with manual refresh). Routes: `GET /api/restart` (health probe, constant 200) and `POST /api/restart` (trigger, 409 while a restart is in flight, 202 + 500 ms buffer before spawn). Recovery is detected by **interruption-then-restore**: the overlay only reloads after it observes the probe fail for `client.restartFailThreshold` consecutive checks and then return 200 again; if the probe is reachable the whole time it reports "no restart detected" (`noRestart`) until the timeout, offering a manual refresh.
- **Session-Log Button Relocation** — shadows the official download button in `conversation.session.header.utilities` (same id `session-log-download`, priority −1, cell-shadowing) and registers a copy in `conversation.session.header.actions` (id `session-log-download-moved`, order 41), reusing the official `sessionLogDownload` controller (`ctx.get('sessionLogDownload')`) so download behavior stays identical to stock.
- **Peer Messaging** — `send_to_session` / `list_sessions` tools on the host plane (session addressing by id or workspace path, wakeup delivery) plus a "copy session ID" button in both `conversation.session.header.actions` (id `copy-session-id`, order 30) and `conversation.input.left` (id `copy-session-id-input`, order 30). Outgoing message content is converted to plain text (`toPlainText`) before delivery so recipients see tidy text rather than raw markdown.

## Architecture

- **Host half** — `lib/index.js` composes six feature modules (`identity.js`, `global-prompt.js`, `auto-resume.js`, `web-restart.js`, `peer-message.js`, `log-reposition.js`). `inject` is the deduplicated union of module dependencies; each module's `apply` runs inside a `safe()` guard so one failing module never takes the whole package down. Every contribution is lifecycle-bound (`ctx.effect` for prompt sections and HTTP routes, plugin-fiber registrations for tools; timers go through the `timer` service). `global-prompt.js` owns `global-prompt`, `workspace-prompt`, `workspace-registry-active`, and `prompt-file-status` namespaces, the `readPromptFiles` helper (which does the live `fs.readFileSync` read), and the workspace/live-workflow projection (`agents.roots()` → active workspaces).
- **Client half** — `client/client.js` is a single `window.__ModuleLoader__.load` bundle; the five UI modules are inlined in IIFEs and collected into one `apply` that registers all slots in order (guarded per module). All UI uses `React.createElement`; styles are injected as `data-plugin` style tags with theme CSS variables and dark-mode coverage; no global DOM manipulation. The global-prompt module renders the **Tabs (Global / Per workspace)** page plus a reusable `FileRefsPanel` (add/remove referenced files, per-file status via the bound `prompt-file-status` scope).

### Registered slots

| Slot | Id | Order / priority | Feature |
|---|---|---|---|
| `settings.section` | `global-prompt` | order 30 | Global Prompt + workspace prompt page (Tabs) |
| `settings.general.item` | `web-restart` | order 90 | Restart entry |
| `conversation.session.header.actions` | `copy-session-id` | order 30 | Copy session ID |
| `conversation.session.header.actions` | `session-identity` | order 40 | Identity button |
| `conversation.session.header.actions` | `session-log-download-moved` | order 41 | Session log download |
| `conversation.input.left` | `copy-session-id-input` | order 30 | Copy session ID (tool row) |
| `conversation.input.left` | `session-identity-input` | order 40 | Identity button (tool row) |
| `conversation.session.header.utilities` | `session-log-download` | priority −1 (shadow) | Hide stock button |

## Configuration

Settings namespaces (schema-validated, `applies: live`, persisted in `settings.yaml`):

| Namespace | Schema | Notes |
|---|---|---|
| `session-identity` | `{ default: {enabled: boolean, text: string}, sessions: Record<sessionId, {enabled, text}> }` | Resolution: session record → default → empty. Empty or disabled entries inject nothing. Identity text is clipped to 8000 chars (token guard). |
| `session-auto-resume` | `{ sessions: Record<sessionId, boolean> }` | Switch per session; absent keys mean off. |
| `global-prompt` | `{ enabled: boolean, content: string, files: string[] }` | Injected into every conversation when enabled. `files` is a list of referenced files appended at assembly (live read, failed files skipped). |
| `workspace-prompt` | `{ workspaces: Record<path,{enabled, content, files: string[]}>, removed: string[] }` | Per-workspace prompt. A session gets the most-specific (longest matching path) enabled workspace whose directory prefix-matches its `cwd`. `removed` lists paths the user removed so the active-workspace sync never re-adds them. |
| `workspace-registry-active` | `{ active: [{path, sessionCount}] }` | Read-only projection of live workspaces aggregated from **`ctx.agents.roots()`** (each agent's `session.header.cwd`, deduped and counted). Never sourced from `workspaceRegistry` (which is not visible in this plugin's scope). |
| `prompt-file-status` | `{ byScope: Record<global\|path, [{filePath, status: 'ok'\|'fail', charCount?, reason?}]> }` | Read-only projection of the most recent read result of each scoped referenced file; the UI's `FileRefsPanel` reads it to show `ok: N chars` / `fail: reason`. |

### Plugin Config (cordis)

The plugin exposes a single `Config` (schemastery schema) with per-feature keys. Defaults equal current behavior; override via the plugin row's `config` in `cordis.yml` / `cordis.patch.yml` without touching code. The client half follows the same cordis mechanism (it exports `Config` and receives `config.client`); if schemastery is unavailable in the client bundle, the client half degrades to defaults without exporting `Config`:

```yaml
- id: session-toolkit
  name: 'dsh-session-toolkit'
  config:
    identity:
      maxText: 8000
      sectionOrder: 40
    globalPrompt:
      sectionOrder: 50
      workspaceSectionOrder: 60
    autoResume:
      concurrency: 3
    webRestart:
      scriptPath: ''          # optional; default derived as <DSH_HOME>/autostart/dsh-web-restart.cmd
      spawnDelayMs: 500
    client:
      identityCharLimit: 4000
      restartTimeoutMs: 90000
      restartPollMs: 1000
      restartFillMs: 600
      restartFailThreshold: 2
      copyFeedbackMs: 1600
```

| Key | Default | Meaning |
|---|---|---|
| `identity.maxText` | 8000 | Identity text clip limit (chars, token guard). |
| `identity.sectionOrder` | 40 | System-prompt order of the identity section. **Migration**: users who explicitly pinned `identity.sectionOrder: 55` must set it to 40 to keep the identity-before-global ordering. |
| `globalPrompt.sectionOrder` | 50 | System-prompt order of the global prompt section. |
| `globalPrompt.workspaceSectionOrder` | 60 | System-prompt order of the workspace prompt section (placed last). |
| `autoResume.concurrency` | 3 | Max in-flight resumes during startup restore. |
| `webRestart.scriptPath` | derived | Restart script path; default `<DSH_HOME>/autostart/dsh-web-restart.cmd` via dsh-home-paths. |
| `webRestart.spawnDelayMs` | 500 | Delay before spawning the restart script (202 buffer). |
| `client.identityCharLimit` | 4000 | Identity editor character limit (UI soft limit). |
| `client.restartTimeoutMs` | 90000 | Restart overlay timeout before the manual-refresh hint. |
| `client.restartPollMs` | 1000 | Restart health-poll interval. |
| `client.restartFillMs` | 600 | Progress fill animation after recovery detected. |
| `client.restartFailThreshold` | 2 | Consecutive failed health polls before an interruption is considered observed. |
| `client.copyFeedbackMs` | 1600 | Copy-feedback checkmark duration. |

## Deployment

Install into any profile (bundle layer; single source, no copies):

```powershell
# from npm
dsh plugin --profile <name> add dsh-session-toolkit

# from GitHub
dsh plugin --profile <name> add github:Han-Yao94/dsh-session-toolkit

# from a local checkout / tarball
dsh plugin --profile <name> add ./dsh-session-toolkit-<version>.tgz
```

The package's `dsh.bundle.patch` (`cordis.patch.yml`) registers the single entry (`id: session-toolkit`, `name: 'dsh-session-toolkit'`) as a **bundle layer** — applied after `dsh-base` / `dsh-web-app` and before the profile patch layer (layer order: bundles in sequence → profile patch → home patch → `--patch` overlay).

Uninstall: `dsh plugin --profile <name> remove dsh-session-toolkit`.

### Local development

For iterating on the source without publishing, install the checkout directly (`dsh plugin --profile <name> add <path-to-checkout>`, which uses a pnpm `link:` dependency), or use a manual junction into the profile's `node_modules` plus an explicit `- insert:` entry in the profile's `cordis.patch.yml`. Prefer `dsh plugin add`.

### Share & Install

Published on **npm** as `dsh-session-toolkit` (v0.1.3, MIT) and mirrored on **GitHub** at `github.com/Han-Yao94/dsh-session-toolkit`. Pure-JS package — **no build step, no prepare script**. `files` whitelists `lib/`, `client/`, `cordis.patch.yml` and READMEs.

- **npm**: consumers run `dsh plugin --profile <name> add dsh-session-toolkit`; new versions are released with `npm publish` (or `pnpm publish`).
- **GitHub**: `dsh plugin --profile <name> add github:Han-Yao94/dsh-session-toolkit`.
- **Tarball**: `pnpm pack` → `dsh plugin --profile <name> add ./dsh-session-toolkit-<version>.tgz`.

Runtime dependencies (`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-home-paths`) are declared in `dependencies` and install automatically; platform modules (`react`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-*`) are `peerDependencies` provided by the DSH host. Verified: clean install of the packed tarball resolves all imports without any local junction.

## Model Experience

### System prompt contributions

#### What the model sees

Three sections are contributed per assembly, in order: `session-identity` (order 40) -> `global-prompt` (order 50) -> `workspace-prompt` (order 60), placed after the deployment persona and before tool guidance (100–199). The identity section is resolved per agent (`AssembleContext.agent`) at assembly time from `session-identity` settings and is skipped for subagents (`origin`/`delegationDepth`). The workspace section injects the most-specific (longest matching path) enabled workspace prompt for a session whose `cwd` prefix-matches a configured workspace; otherwise nothing.

Each of the global and workspace sections appends its **referenced files' content** after the prompt text: every assembly re-reads `files` with `fs.readFileSync` (UTF-8, live), sanitizes each file's content (spaces out `{` runs), and concatenates them. A file that cannot be read is **skipped** (its content is not injected) but its read status is recorded for the UI. Empty sections are dropped at render.

#### Token effect

All three sections repeat their text on every request when enabled. The global prompt applies to every conversation; the identity text applies only to sessions that resolve it (its own record or the default); the workspace text applies only to sessions whose `cwd` prefix-matches an enabled configured workspace (most-specific match wins). Referenced files add their full content to the effective prompt and therefore consume additional tokens — a large referenced file meaningfully increases the per-request token cost. Identity text is clipped to 8000 chars as a token guard.

#### KV Cache effect

Each section's rendered text is a fixed part of the request prefix while its settings are unchanged; editing a session identity or a global/workspace prompt (or editing / adding a referenced file) may invalidate provider cache reuse from the first changed token (same semantics as stock persona sections).

### Tool surface

`send_to_session` and `list_sessions` are registered on the host plane and visible to every session (subagents inherit them through the standing preset composition). Their arguments and results are JSON-compatible.

## Mechanisms and Red Lines

- **Identity injection** uses a single global section whose text provider resolves per agent — no per-agent registration, no lifecycle churn, real-time on settings change.
- **Frozen-settings rule (red line)** — DSH's `ctx.settings.register(...).scope.get()` returns a value **frozen by `deepFreeze`** (immutable). Any host write to a scope must **first `{ ... }` copy the object (and `.slice()` arrays) into a mutable object, then use `update()`** (the register scope has `get`/`watch`/`update`/`replace`, **no `set`**); writing to the frozen object directly throws `object is not extensible` (this was the root cause of the "workspace list empty" bug fixed here). On the client side, `settingsScope.bind().set()` is used (the client scope supports `set`). The same `{ ... }` copy rule applies on the client for `workspace-prompt` writes (`onWsFilesChange` / `save` / `saveWsEnabled` / `removeWorkspace`).
- **Referenced files are read live and failures are skipped** — `readPromptFiles` runs inside the prompt `text()` on every assembly; a failing file never breaks assembly and its status is recorded in `prompt-file-status` for the UI.
- **Auto-resume never calls `dispose()`** — `AgentHandle.dispose()` removes the session from storage; turning a switch off only affects the next restart, it never takes a live session down.
- **Restart is UAC-free by construction** — the spawn inherits the server process token (SYSTEM or user), so `taskkill` targets a same-privilege process and the script's elevated branch (the only UAC source) is unreachable. If port 3080 is held by another program, an elevated retry may still appear (documented in the restart script).
- **Shadowing is cell-based** — the utilities entry re-registers the stock `session-log-download` cell at a lower priority; the stock entry abdicates gracefully if the shadow crashes.
- **Plain-text conversion** — `toPlainText` (10 rules, code-fence state machine, loose matching) runs at send time only; the message structure and `source: { kind: 'user' }` are unchanged.

## Known Limitations and Deferred Work

- Client half is a hand-maintained single-file IIFE bundle; adding a feature touches both `lib/` and `client/client.js`.
- The relocated Session-log button depends on the official `sessionLogDownload` controller interface; a stock upgrade that changes it requires a sync (see `lib/log-reposition.js`).
- Loose emphasis matching in `toPlainText` can drop `*` pairs in non-format positions (e.g. `a * b * c`); acceptable for agent-generated messages, boundary tightening is optional.
- The aggregate `inject` union waits for every listed service; a profile missing one service delays the whole package (web profile provides all of them today).
- `ctx.get('agentDefaultModel')` is resolved at `apply` time (non-lazy); the gateway mounts the service before this package, so the web profile always has a value.
- **Restart probe window** — a restart is only detected when the health probe fails for `restartFailThreshold × restartPollMs` (default 2 × 1000 ms = 2 s) and then recovers. If a relaunch completes in under that window, the overlay can misreport "no restart detected" (`noRestart`); lowering `restartFailThreshold` to 1 makes detection more sensitive but also lets a single transient failure masquerade as a restart interruption.
- **Referenced files are read synchronously inside assembly** — `readPromptFiles` uses `fs.readFileSync` for every referenced file on every assembly; many or very large files block assembly (the "no size cap" requirement is a deliberate trade-off). `prompt-file-status` is updated on the assembly path each time (and the UI's `FileRefsPanel` re-renders per status), which is a minor performance noisiness. On the client, `files` are saved immediately (`onWsFilesChange` / `save`).

## Recovery

Uninstall the bundle: `dsh plugin --profile <name> remove dsh-session-toolkit`, then restart the GUI. To roll back to the pre-consolidation layout, re-enable the original plugins instead of installing this package.
