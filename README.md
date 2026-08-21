# dsh-session-toolkit

English | [中文](README.zh.md)

Consolidated plugin toolkit for the DeepSeek Harness. Six previously separate local plugins — session identity, global prompt, session auto-resume, web restart service, Session-log button relocation, and peer-session messaging — merged into one installable package (official bundle form, `dsh.bundle.patch`), installed with `dsh plugin add`.

## Features

- **Session Identity** — a per-session persona prompt injected into that session's system prompt (independent section `session-identity`, order 55, resolved per agent at every assembly), with a default identity and per-session overrides. UI: identity dialog (enable switch, 4000-char soft limit, save/reset, edit default, inherit default) and status buttons in both `conversation.session.header.actions` (id `session-identity`, order 40) and `conversation.input.left` (id `session-identity-input`, order 40).
- **Global Prompt** — a settings page (`settings.section`, id `global-prompt`, order 30) injecting one prompt into every conversation's system prompt (section `global-prompt`, order 50). `{` runs are spaced out (`/\{+/g`) to avoid prompt-variable conflicts.
- **Session Auto-Resume** — sessions with the per-session switch on are resumed automatically after a GUI restart (`ctx.agents.resume`, carrying the default model from `agentDefaultModel`); switching a session on resumes it immediately (false→true edge). Filters: switch on, top-level only (no subagent origin, no `delegationDepth > 0`, no `parentSession`), non-blank (`seedLength !== 0`). Concurrency-bounded (`CONCURRENCY = 3`) with per-item failure isolation and an in-flight set against duplicate resume.
- **Web Restart** — a "Restart service" entry in the General settings (`settings.general.item`, id `web-restart`, order 90) that restarts the GUI server with **no UAC prompt** (the spawn inherits the server process token, so the restart script's elevated branch is never reached) and shows a full-screen progress overlay (probe-driven progress, fill-up animation before reload, 90 s timeout fallback with manual refresh). Routes: `GET /api/restart` (health probe, constant 200) and `POST /api/restart` (trigger, 409 while a restart is in flight, 202 + 500 ms buffer before spawn).
- **Session-Log Button Relocation** — shadows the official download button in `conversation.session.header.utilities` (same id `session-log-download`, priority −1, cell-shadowing) and registers a copy in `conversation.session.header.actions` (id `session-log-download-moved`, order 41), reusing the official `sessionLogDownload` controller (`ctx.get('sessionLogDownload')`) so download behavior stays identical to stock.
- **Peer Messaging** — `send_to_session` / `list_sessions` tools on the host plane (session addressing by id or workspace path, wakeup delivery) plus a "copy session ID" button in both `conversation.session.header.actions` (id `copy-session-id`, order 30) and `conversation.input.left` (id `copy-session-id-input`, order 30). Outgoing message content is converted to plain text (`toPlainText`) before delivery so recipients see tidy text rather than raw markdown.

## Architecture

- **Host half** — `lib/index.js` composes six feature modules (`identity.js`, `global-prompt.js`, `auto-resume.js`, `web-restart.js`, `peer-message.js`, `log-reposition.js`). `inject` is the deduplicated union of module dependencies; each module's `apply` runs inside a `safe()` guard so one failing module never takes the whole package down. Every contribution is lifecycle-bound (`ctx.effect` for prompt sections and HTTP routes, plugin-fiber registrations for tools; timers go through the `timer` service).
- **Client half** — `client/client.js` is a single `window.__ModuleLoader__.load` bundle; the five UI modules are inlined in IIFEs and collected into one `apply` that registers all slots in order (guarded per module). All UI uses `React.createElement`; styles are injected as `data-plugin` style tags with theme CSS variables and dark-mode coverage; no global DOM manipulation.

### Registered slots

| Slot | Id | Order / priority | Feature |
|---|---|---|---|
| `settings.section` | `global-prompt` | order 30 | Global Prompt page |
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
| `global-prompt` | `{ enabled: boolean, content: string }` | Injected into every conversation when enabled. |
| `file-blocklist` | `{ global: string[], sessions: Record<sessionId, string[]> }` | Glob patterns of files never loaded into the model context (`**`/`*`/`?`, case-insensitive paths). Reliably blocked for read-like tools; shell command text heuristic (literal path inclusion or pattern regex). **Boundary**: shell indirect reads (variable expansion, renamed copies, concatenation) are not guaranteed. |

### Plugin Config (cordis)

The plugin exposes a single `Config` (schemastery schema) with per-feature keys. Defaults equal current behavior; override via the plugin row's `config` in `cordis.yml` / `cordis.patch.yml` without touching code. The client half follows the same cordis mechanism (it exports `Config` and receives `config.client`); if schemastery is unavailable in the client bundle, the client half degrades to defaults without exporting `Config`:

```yaml
- id: session-toolkit
  name: 'dsh-session-toolkit'
  config:
    identity:
      maxText: 8000
      sectionOrder: 55
    globalPrompt:
      sectionOrder: 50
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
      copyFeedbackMs: 1600
```

| Key | Default | Meaning |
|---|---|---|
| `identity.maxText` | 8000 | Identity text clip limit (chars, token guard). |
| `identity.sectionOrder` | 55 | System-prompt order of the identity section. |
| `globalPrompt.sectionOrder` | 50 | System-prompt order of the global prompt section. |
| `autoResume.concurrency` | 3 | Max in-flight resumes during startup restore. |
| `webRestart.scriptPath` | derived | Restart script path; default `<DSH_HOME>/autostart/dsh-web-restart.cmd` via dsh-home-paths. |
| `webRestart.spawnDelayMs` | 500 | Delay before spawning the restart script (202 buffer). |
| `client.identityCharLimit` | 4000 | Identity editor character limit (UI soft limit). |
| `client.restartTimeoutMs` | 90000 | Restart overlay timeout before the manual-refresh hint. |
| `client.restartPollMs` | 1000 | Restart health-poll interval. |
| `client.restartFillMs` | 600 | Progress fill animation after recovery detected. |
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

Published on **npm** as `dsh-session-toolkit` (v0.1.0, MIT) and mirrored on **GitHub** at `github.com/Han-Yao94/dsh-session-toolkit`. Pure-JS package — **no build step, no prepare script**. `files` whitelists `lib/`, `client/`, `cordis.patch.yml` and READMEs.

- **npm**: consumers run `dsh plugin --profile <name> add dsh-session-toolkit`; new versions are released with `npm publish` (or `pnpm publish`).
- **GitHub**: `dsh plugin --profile <name> add github:Han-Yao94/dsh-session-toolkit`.
- **Tarball**: `pnpm pack` → `dsh plugin --profile <name> add ./dsh-session-toolkit-<version>.tgz`.

Runtime dependencies (`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-home-paths`) are declared in `dependencies` and install automatically; platform modules (`react`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-*`) are `peerDependencies` provided by the DSH host. Verified: clean install of the packed tarball resolves all imports without any local junction.

## Model Experience

### System prompt contributions

#### What the model sees

Two sections are contributed per assembly: `global-prompt` (order 50) and `session-identity` (order 55), placed after the deployment persona and before tool guidance (100–199). The identity section is resolved per agent (`AssembleContext.agent`) at assembly time from `session-identity` settings and is skipped for subagents (`origin`/`delegationDepth`). Empty sections are dropped at render.

#### Token effect

Both sections repeat their text on every request when enabled. The global prompt applies to every conversation; the identity text applies only to sessions that resolve it (its own record or the default). Identity text is clipped to 8000 chars as a token guard.

#### KV Cache effect

Each section's rendered text is a fixed part of the request prefix while its settings are unchanged; editing a session identity or the global prompt may invalidate provider cache reuse from the first changed token (same semantics as stock persona sections).

### Tool surface

`send_to_session` and `list_sessions` are registered on the host plane and visible to every session (subagents inherit them through the standing preset composition). Their arguments and results are JSON-compatible.

## Mechanisms and Red Lines

- **Identity injection** uses a single global section whose text provider resolves per agent — no per-agent registration, no lifecycle churn, real-time on settings change.
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

## Recovery

Uninstall the bundle: `dsh plugin --profile <name> remove dsh-session-toolkit`, then restart the GUI. To roll back to the pre-consolidation layout, re-enable the original plugins instead of installing this package.
