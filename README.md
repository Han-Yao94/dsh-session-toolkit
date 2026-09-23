# dsh-session-toolkit

[English](README.md) | [中文](README.zh.md)

A consolidated plugin toolkit for the **DeepSeek Harness**. Six previously separate local plugins — **session identity**, **global prompt**, **session auto-resume**, **web restart service**, **Session-log button relocation**, and **peer-session messaging** — merged into a single installable package that ships in the official bundle form (`dsh.bundle.patch`) and installs with `dsh plugin add`; it also includes a **Prompt Dedup** feature.

Current version: **0.1.11**, verified against **DeepSeek Harness `dsh-v0.1.7-alpha.1`** — which is also its **minimum supported version**: 0.1.6 and earlier fail loudly by design rather than degrading silently (see [Compatibility](#compatibility)).

---

## Features

### Session Identity
Per-session persona prompt injected into that session's system prompt (independent section `session-identity`, order 40, resolved per agent at every assembly), with a default identity plus per-session overrides. UI provides an identity dialog (enable switch, 4000-char soft limit, save/reset, edit default, inherit default) and status buttons in both `conversation.session.header.actions` (id `session-identity`, order 40) and `conversation.input.left` (id `session-identity-input`, order 40). The dialog card can be dragged by its title row: the offset is clamped to the viewport on every move and re-clamped on window resize, and when the card is larger than the viewport **each axis stays movable**, so every edge remains reachable. The position is not persisted — it resets when the dialog is closed.

### Global Prompt
A settings page (`settings.section`, id `global-prompt`, order 30) rendered as **Tabs (Global / Per workspace)**. The *Global* tab injects one prompt into every conversation's system prompt (section `global-prompt`, order 50); the *Per workspace* tab injects per-workspace prompts (section `workspace-prompt`, order 60). Both sections are registered with **`interpolate: false`**, so `{{...}}` inside prompt text and referenced files stays literal — user content is never rewritten, and an unregistered `{{name}}` can never fail assembly. On kernels older than 0.1.6 (no per-section `interpolate` flag) `lib/prompt-literal.js` falls back to escaping `{` runs in the assembled text.

### Workspace Prompt
Per-workspace prompt injected for sessions whose `cwd` prefix-matches a configured workspace directory (that directory plus its subdirectories). The workspace list is derived from **active sessions' `cwd`** (`ctx.agents.roots()`), deduplicated and counted. When several enabled workspaces prefix-match a session's `cwd`, the **most-specific (longest matching path)** one wins. `removed` records paths the user removed so the active-workspace sync never re-adds them. The workspace row's enable switch is **live-save** (persisted immediately); the Save button only persists the prompt **content + referenced files**.

### Referenced Files
Both global and workspace prompts can reference a **list of files**. Every assembly re-reads each referenced file (UTF-8, content cached by `mtimeMs` + size, so an unchanged file is not re-read) and injects it after the prompt text. Byte budgets are enforced (`globalPrompt.maxFileBytes` / `maxTotalBytes`, defaults 256 KiB / 1 MiB): an oversized file is **skipped** rather than blocking assembly. A read failure is skipped too, and both cases are reported in the UI with the reason. Supports plain text and markdown. Per-file read status is a host **runtime projection** delivered to the UI by the read-only route `GET /api/session-toolkit/state` (`ok`: N chars / `fail`: reason / pending); the browser half polls it only while the settings page is open. The status **never touches a configuration file**, and its projection object is only replaced when the content actually changed.

### Session Auto-Resume
Sessions with the per-session switch on are resumed automatically after a GUI restart, through the **official resume path** (`ctx.sessionController.resolveAgent`) when it exists — that is what restores the session's own model selection (via `installSelection`) in addition to the preset mount, and it validates subagent ownership and de-duplicates concurrent resumes. Older kernels without `sessionController` fall back to `ctx.agents.resume` plus a preset mount, carrying the default model from `agentDefaultModel`. Switching a session on resumes it immediately (false→true edge). Filters: switch on, top-level only (no subagent origin, no `delegationDepth > 0`, no `parentSession`), non-blank (`eventCount !== 0`, snapshot shape). Concurrency-bounded (`CONCURRENCY = 3`) with per-item failure isolation and an in-flight set that prevents duplicate resume.

### Web Restart
A "Restart service" entry in the General settings (`settings.general.item`, id `web-restart`, order 90) that restarts the GUI server and shows a full-screen progress overlay (probe-driven progress, fill-up animation before reload, 90 s timeout fallback with manual refresh). Two platform chains, both **detached and independent of the dying server**:

- **Windows** (`windows-script`): `wscript.exe` runs the launcher VBS, which hides the console and runs `<DSH_HOME>/autostart/dsh-web-restart.cmd`; the spawn inherits the server process token, so the elevated branch (the only UAC source) is never reached.
- **macOS / Linux** (`posix-relaunch`, or `posix-script` when `webRestart.scriptPath` is set): with no configuration the host **restarts itself** — it generates a one-shot `/bin/sh` script that SIGTERMs the current PID, waits up to 10 s (then SIGKILLs), `cd`s back to the original CWD and re-executes `process.execPath` with the original `process.argv.slice(1)`, appending output to `<DSH_HOME>/autostart/dsh-web-restart.log`. Point `webRestart.scriptPath` at your own `.sh` to take over instead (useful when the server was started by a supervisor).

The client probes `GET /api/restart` on mount and hides the entry when the host reports `available: false` (unsupported platform); `POST` returns 501 there. The same web server also exposes the read-only state route `GET /api/session-toolkit/state` (live workspaces + referenced-file read status; any other method answers 405), which is how the settings page reads those two runtime projections — they no longer occupy a settings namespace and are never persisted. Routes: `GET /api/restart` (health probe, constant 200 + `available`/`mode`/`platform`) and `POST /api/restart` (trigger; **409** while a restart is in flight, **500** with the reason when the configured script is missing or self-relaunch is impossible, **202** + 500 ms buffer before spawn). The client only enters the overlay on 202 — any other status is shown inline as an error instead of a 90 s dead wait. Recovery is detected by **interruption-then-restore**: the overlay only reloads after it observes the probe fail for `restartFailThreshold` consecutive checks and then return 200 again; if the probe is reachable the whole time it reports "no restart detected" (`noRestart`) until the timeout, offering a manual refresh.

### Session-Log Button Relocation
Shadows the official entry in `conversation.session.header.utilities` (same id `session-log-download`, priority −1, cell-shadowing) and registers a copy in `conversation.session.header.actions` (id `session-log-download-moved`, order 41), reusing the official `sessionLogDownload` controller (`ctx.get('sessionLogDownload')`) so download behavior stays identical to stock. The copy mirrors the **0.1.6** official surface — a "⋯ More actions" menu whose single item triggers the shared download dialog (localized through this plugin's own locale namespace) — and is a frozen replica: a stock upgrade that changes that UI must be synced by hand, and the shadowing registration must be re-checked whenever the official entry gains new menu items.

### Session Admin
The host plane registers two more tools on the **same plane as `send_to_session` / `list_sessions`**:

- **`create_session`** — create a new top-level session (a chat window in the GUI's left navigation). **Both `cwd` and `prompt` are required**: `cwd` must be an absolute path (a session without `cwd` never enters the host list) and `prompt` is the new session's first message. A successful create produces a real user message (**it genuinely runs one model turn and consumes one call**); by kernel design any session with events is persisted, so **this tool deliberately offers no "register-only, never speaks" ephemeral session**. An optional `title` sets the title immediately and pins it. The result carries `sessionId`, `cwd`, `status`, `title` and `notes`.
- **`rename_session`** — retitle a **live** session. A rename **pins** the title so automatic title generation no longer overwrites it. The target must be a top-level session and currently live: a subagent target (`origin=subagent` or `delegationDepth>0`) is refused explicitly rather than silently rewritten.

Both return **structured results** and **never throw an uncaught exception from the tool body**: success is `{ ok: true, … }`, failure is `{ ok: false, error: '<code>', errorText: '<original reason>' }`. Codes: `MODEL_UNAVAILABLE` / `MODEL_SELECTION_FAILED` / `MODEL_SELECTION_INVALID` / `EMPTY_CWD` / `CWD_NOT_ABSOLUTE` / `EMPTY_PROMPT` / `PROMPT_TOO_LONG` / `PRESET_RESOLVE_FAILED` / `CREATE_FAILED` / `CREATE_UNAVAILABLE` / `CREATE_NO_AGENT` / `EMPTY_TARGET` / `EMPTY_TITLE` / `SESSION_UNAVAILABLE` / `TARGET_IS_SUBAGENT` / `TITLE_SERVICE_UNAVAILABLE` / `UNEXPECTED`.
(A missing `prompt` is rejected by the kernel's tool-argument validation at the **framework layer** — the kernel turns that into a tool-error result, and the exception never passes through this plugin's code; only a `prompt` that is present but blank is answered with this plugin's `EMPTY_PROMPT`. Neither creates a session.)

**Two honest disclosures**:
- **Visibility is not verified inside the tool** — whether a session created with `prompt` actually appears in the left navigation depends on the kernel **genuinely starting a turn** (navigation filters on the "blank session" bit, which only flips on `turn/start`; `followup` merely enqueues and wakes the driver). The result therefore draws **no** "it is in the navigation" conclusion, and `notes` says so.
- **Preset degradation** — when the `agentPresets` service exists but default-preset resolution fails, the tool **returns `PRESET_RESOLVE_FAILED` instead of handing back a crippled session with no preset mounted**; when the service is absent entirely that is a legitimate degradation, and the session is still created with an explanatory `notes` entry.

### Peer Messaging
`send_to_session` / `list_sessions` tools on the host plane (session addressing by id or workspace path, wakeup delivery) plus a "copy session ID" button in both `conversation.session.header.actions` (id `copy-session-id`, order 30) and `conversation.input.left` (id `copy-session-id-input`, order 30). Outgoing message content is converted to plain text (`toPlainText`) before delivery so recipients see tidy text rather than raw markdown.

### Prompt Dedup
Performs **cross-section line-level deduplication** across the identity / global / workspace system-prompt sections (`session-identity`, `global-prompt`, `workspace-prompt`, orders 40/50/60). `promptDedup.enabled` is on by default (disable only by setting it to `false`). Splits each section on `\n` and keeps only the **first occurrence** of each identical original line (a single `seen` set spans all three sections, so intra-section self-duplicates also collapse); duplicate lines in later sections are dropped. **Blank lines (including whitespace-only lines) never take part in deduplication** — they are markdown's paragraph/list separators, and treating them as duplicates silently collapsed every section after the first one. Every section's unique content is preserved. It does not parse `{{name}}` placeholders (single-line complete groups, never split by line), does not break markdown, never sets `complete`, and never touches harness-owned sections (`harness:identity` / `deployment:persona` / tool sections). Mechanism: subscribe to the `system-prompt/assemble` waterfall on the plugin's root ctx, `await next()`, then deduplicate `sections` on the returned result before returning it.

---

## Compatibility

The plugin is verified against **DeepSeek Harness `dsh-v0.1.7-alpha.1`**, which is also its **minimum supported version**: 0.1.7 replaced the settings model (a plugin registering a namespace, read through `ctx.settingsScope.bind`) with entry `Config` `volatile` fields read through `ctx.configForms`, so the whole user-data surface moved (see [Settings fields](#settings-fields-volatile-parts-of-the-entry-config)). On 0.1.6 and earlier the client entry stays at `pending (waiting for service: configForms)` and `web boot` reports `Failed to load plugins` — a **loud failure** rather than a silent degradation; upgrade the harness or uninstall this plugin. The existing fallbacks for `interpolate: false` and `ctx.sessionController.resolveAgent` are unchanged.

- **Framework**: `@deepseek-ai/cordis` 4.0.3 and `@deepseek-ai/schemastery` 3.18.3 (the versions `dsh-v0.1.7-alpha.1` vendors). The `@deepseek-ai/schemastery` floor is `^3.18.3`: `volatile()` exists only from that version, and earlier 3.18.x builds make the `Config` constructor throw. The plugin loads through the cordis harness and registers as a bundle via `dsh.bundle.patch`.
- **Host services** (verified against the native source): this entry `Config`'s `volatile()` fields read live through `.get()`, with `ctx.on('loader/volatile-update', …)` notifying after a commit (no remount); `ctx.get('settings').update('session-toolkit', patch)` as the host write path back into the entry config (used by the workspace auto-add); `ctx.systemPrompt.section({ name, order, text, interpolate: false })`; `ctx.agents.{ get, resume({ resumeSessionId, agentOptions, setup }), roots, requireInitiator }`; `ctx.sessionController.resolveAgent(sessionId)`; `session.header` fields (`cwd`, `origin`, `delegationDepth`, `parentSession`, `agentPreset`; there is no `seedLength`); `ctx.inject(names, cb)` for late-arriving optional services; `ctx.get('webServer').register({ kind: 'exact', path, handler })`; `@deepseek-ai/dsh-tools` `defineTool` + `tools.register()`; and `ctx.get('agentDefaultModel')`, `sessionPersistence`, `sessionTitle`, `workspaceRegistry`, `sessionLogDownload`, `timer`, `on`, `effect`.
- **Client services** (verified): `window.__ModuleLoader__.load({ id, factory })`; `ctx.get('slots')` → `slots.register(meta, render)` / `slots.inject(name, fn)` with **lower-priority shadows**; `ctx.get('configForms').get('session-toolkit')` → form `{ getSnapshot()/.value/.status, subscribe, set(field, value), unset(field), mutate(ops, expectedRevision) }`, whose host-validated writes land in the active profile's `cordis.patch.yml`; `ctx.get('locale')` → `register(ns, { zh, en })` / `bind(ns)`; and the `timer` client service (`ctx.timeout`). The bundle's runtime `require`s resolve against the platform seed words (`react`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-primitives`, …).

### Configuration and the settings data plane
The plugin's **host-side** `Config` validates the entire configuration tree with schemastery as soon as the plugin loads; resolution order is schema default → profile patch (user layer), both resolved on the host before the plugin sees them.

From DSH 0.1.7 on, settings projects **only fields declared `volatile()`**, and a settings surface is identified by exactly two facts: the **id of the edited entry** (`session-toolkit`) and **that entry's `Config`**. Consequently:

- User data (identity texts, global and per-workspace prompts, the auto-resume switches, the UI knobs) are `volatile` fields: the browser half reads and writes the same entry `Config` through `ctx.get('configForms').get('session-toolkit')`, and host-validated writes land in the **active profile's `cordis.patch.yml`** (there is no `settings.yaml` namespace and no `settingsScope` service any more).
- The host half calls `.get()` wherever it needs a value: a committed `volatile` update **does not remount the plugin**, so the identity and global-prompt sections pick the new text up on the next assembly, and `auto-resume` resumes a newly enabled session immediately through `loader/volatile-update`.
- Ordinary fields (orders, budgets, retry and concurrency knobs) stay non-`volatile`: they are still visible in the settings form, but editing them goes through the normal cordis configuration lifecycle.
- The **read-only runtime projections** (live workspaces, referenced-file read status) are not configuration at all: they go straight to the browser through `GET /api/session-toolkit/state` and never land in a file or in a form.

---

## Architecture

- **Host half** — `lib/index.js` composes nine feature modules (`identity.js`, `global-prompt.js`, `auto-resume.js`, `web-restart.js`, `peer-message.js`, `session-admin.js`, `log-reposition.js`, `prompt-dedup.js`, `prompt-literal.js`). `inject` is the deduplicated union of module dependencies; each module's `apply` runs inside a `safe()` guard so one failing module never takes the whole package down. Every contribution is lifecycle-bound (`ctx.effect` for prompt sections and HTTP routes, plugin-fiber registrations for tools; timers go through the `timer` service). `global-prompt.js` owns the `globalPrompt` and `workspacePrompt` volatile fields, the `readPromptFiles` helper (mtime/size-cached live read), the live-workspace aggregation (`agents.roots()` → `GET /api/session-toolkit/state`), and the config write that adds newly discovered workspace paths back into the entry (`ctx.get('settings').update('session-toolkit', …)`); `prompt-literal.js` is the pre-0.1.6 fallback for literal prompt rendering.
- **Client half** — `client/client.js` is a single `window.__ModuleLoader__.load` bundle; the five UI modules live in IIFEs and are collected into one `apply` that registers all slots in order (guarded per module). All UI uses `React.createElement`; styles are injected as `data-plugin` style tags with theme CSS variables and dark-mode coverage; no global DOM manipulation. The global-prompt module renders the **Tabs (Global / Per workspace)** page plus a reusable `FileRefsPanel` (add/remove referenced files, per-file status from the polled `GET /api/session-toolkit/state` projection).

### Registered slots

| Slot | Id | Order / priority | Feature |
|---|---|---|---|
| `settings.section` | `global-prompt` | order 30 | Global + workspace prompt page (Tabs) |
| `settings.general.item` | `web-restart` | order 90 | Restart entry |
| `conversation.session.header.actions` | `copy-session-id` | order 30 | Copy session ID |
| `conversation.session.header.actions` | `session-identity` | order 40 | Identity button |
| `conversation.session.header.actions` | `session-log-download-moved` | order 41 | Session log download |
| `conversation.input.left` | `copy-session-id-input` | order 30 | Copy session ID (tool row) |
| `conversation.input.left` | `session-identity-input` | order 40 | Identity button (tool row) |
| `conversation.session.header.utilities` | `session-log-download` | priority −1 (shadow) | Hide stock button |

---

## Configuration

### Settings fields (volatile parts of the entry config)

The entry id is fixed at `session-toolkit`; the `volatile()` fields below are exactly the data the settings page reads and writes. They are schema-validated and land in the active profile's `cordis.patch.yml`. The field name is the config path (`identity.sessions` etc.), and the browser half addresses the same paths through `configForms.get('session-toolkit')`.

| Field | Schema | Notes |
|---|---|---|
| `identity.default` | `{enabled: boolean, text: string}` | Default identity. Resolution: session record → default → empty. Disabled or empty entries inject nothing. |
| `identity.sessions` | `Record<sessionId, {enabled, text}>` | Per-session identity, clipped to `identity.maxText` (8000 chars, token guard). |
| `autoResume.sessions` | `Record<sessionId, boolean>` | Per-session "resume after restart" switch; absent keys mean off. |
| `globalPrompt.{enabled,content,files}` | `{enabled: boolean, content: string, files: string[]}` | Injected into every conversation when enabled. `files` is the list of referenced files appended at assembly (live read with mtime/size cache; failed or oversized files skipped). |
| `workspacePrompt.workspaces` | `Record<path,{enabled, content, files: string[]}>` | Per-workspace prompt. A session gets the most-specific (longest matching path) enabled workspace whose directory prefix-matches its `cwd`. |
| `workspacePrompt.removed` | `string[]` | Paths the user removed, so the active-workspace sync never re-adds them. |
| `client.*` | 7 UI knobs (see the table below) | Browser-half runtime parameters (char limit, restart timeout/poll/fill, copy feedback). |

**Runtime projections (never persisted, not configuration):** live workspaces `[{path, sessionCount}]` aggregated from **`ctx.agents.roots()`** (each agent's `session.header.cwd`, deduped and counted; never sourced from `workspaceRegistry`, which is not visible in this plugin's scope) and referenced-file read status `Record<global\|path, [{filePath, status: 'ok'\|'fail', charCount?, reason?}]>`; both reach the settings page through `GET /api/session-toolkit/state`.

### Plugin Config (cordis)

The plugin exposes a single `Config` (schemastery schema) with per-feature keys. Defaults equal current behavior; override them via the plugin row's `config` in `cordis.yml` / `cordis.patch.yml` without touching code. The `.volatile()` keys (user data plus `client.*`) are exactly what the settings page reads and writes, and the browser half sees the same resolved values through `configForms.get('session-toolkit')` (see [Configuration and the settings data plane](#configuration-and-the-settings-data-plane)).

```yaml
- id: session-toolkit
  name: 'dsh-session-toolkit'
  config:
    identity:
      maxText: 8000
      sectionOrder: 40
      default:                # volatile: default identity
        enabled: false
        text: ''
      sessions: {}            # volatile: Record<sessionId, {enabled, text}>
    globalPrompt:
      sectionOrder: 50
      workspaceSectionOrder: 60
      maxFileBytes: 262144    # per referenced file; oversized files are skipped and reported as fail
      maxTotalBytes: 1048576  # across all referenced files of one section
      enabled: false          # volatile: global prompt switch
      content: ''             # volatile: global prompt body
      files: []               # volatile: referenced file list
    workspacePrompt:          # volatile: per-workspace prompts
      workspaces: {}          # Record<path, {enabled, content, files}>
      removed: []             # paths the user removed
    autoResume:
      concurrency: 3
      sessions: {}            # volatile: Record<sessionId, boolean>
    webRestart:
      scriptPath: ''          # optional; default derived as <DSH_HOME>/autostart/dsh-web-restart.cmd
      spawnDelayMs: 500
    promptDedup:
      enabled: true           # cross-section line-level dedup across identity/global/workspace; default true (disable only by setting false)
    client:
      identityCharLimit: 4000 # volatile: the 7 keys below are read by the browser half
      restartTimeoutMs: 90000
      restartPollMs: 1000
      restartFillMs: 600
      restartFailThreshold: 2
      restartSettleMs: 8000
      copyFeedbackMs: 1600
```

| Key | Default | Meaning |
|---|---|---|
| `identity.maxText` | 8000 | Identity text clip limit (chars, token guard). UI soft limit is `client.identityCharLimit` (4000, editor); **host hard-clip** is this value (8000). |
| `identity.sectionOrder` | 40 | System-prompt order of the identity section. **Migration**: users who explicitly pinned `identity.sectionOrder: 55` must set it to 40 to keep the identity-before-global ordering. |
| `globalPrompt.sectionOrder` | 50 | System-prompt order of the global prompt section. |
| `globalPrompt.workspaceSectionOrder` | 60 | System-prompt order of the workspace prompt section (placed last). |
| `globalPrompt.maxFileBytes` | 262144 | Per referenced file byte limit; an oversized file is skipped (status `fail`) instead of blocking assembly. |
| `globalPrompt.maxTotalBytes` | 1048576 | Combined byte budget for all referenced files of one section. |
| `autoResume.concurrency` | 3 | Max in-flight resumes during startup restore. |
| `webRestart.scriptPath` | derived | Restart script path. Empty (default) = derive `<DSH_HOME>/autostart/dsh-web-restart.cmd` on Windows / `…/dsh-web-restart.sh` on macOS+Linux, and on POSIX additionally enable **self-relaunch** (no script needed). Set a path to take over with your own script — on POSIX it runs via `/bin/sh`, and a missing file makes `POST` fail fast with 500 instead of hanging the overlay. |
| `webRestart.spawnDelayMs` | 500 | Delay before spawning the restart script (202 buffer). |
| `promptDedup.enabled` | true | Cross-section line-level deduplication across the identity/global/workspace system-prompt sections (on by default; disable only by setting it to `false`). When on, each **identical non-blank original line** across the three sections keeps only its "first occurrence" (a single `seen` set spans all three); duplicate lines in later sections are dropped, while **blank lines are always preserved** (they are markdown's paragraph/list separators). Every section's unique content is preserved. It does not parse `{{name}}` placeholders, does not break markdown, never sets `complete`, and never touches harness-owned sections. |
| `identity.default` / `identity.sessions` | empty | **User data** (volatile): default identity and per-session identities. Written by the "Session identity" settings page; also editable directly in the profile patch. |
| `globalPrompt.enabled` / `.content` / `.files` | off / empty | **User data** (volatile): global prompt switch, body, and referenced file list. |
| `workspacePrompt.workspaces` / `.removed` | empty | **User data** (volatile): per-workspace prompts plus the removed-path list. The active-workspace sync adds newly discovered paths to `workspaces` (through `ctx.get('settings').update`); paths listed in `removed` are never re-added. |
| `autoResume.sessions` | empty | **User data** (volatile): per-session "resume after restart". A false→true edge resumes that session immediately. |
The `client.*` keys below are validated by the host; they are the very fields the browser half reads through `configForms.get('session-toolkit')` (when the form is unavailable the client falls back to `UI_FALLBACK` in `client/client.js`, whose values equal the historical defaults). You can edit them in the plugin's settings page.

| Key | Default | Meaning |
|---|---|---|
| `client.identityCharLimit` | 4000 | Identity editor character limit (UI soft limit; the global-prompt editor uses it too). |
| `client.restartTimeoutMs` | 90000 | Restart overlay timeout before the manual-refresh hint. |
| `client.restartPollMs` | 1000 | Restart health-poll interval (and progress tick). |
| `client.restartFillMs` | 600 | Progress fill animation after recovery detected. |
| `client.restartFailThreshold` | 2 | Consecutive failed health polls before an interruption is considered observed. |
| `client.restartSettleMs` | 8000 | Settle window (ms) after recovery before the auto-reload. DSH session titles are **generated asynchronously by the LLM** with no "ready" signal, so this is the wait window for the first post-restart reload to reduce the title fallback (showing the workspace name). If a session title still shows the workspace name, refresh manually or raise this value. A full fix requires DSH to expose a "titles ready" signal. |
| `client.copyFeedbackMs` | 1600 | Copy-feedback checkmark duration. |

---

## Deployment

Install into any profile (bundle layer; single source, no copies):

```powershell
# from npm
dsh plugin --profile web add dsh-session-toolkit

# from GitHub
dsh plugin --profile web add github:Han-Yao94/dsh-session-toolkit

# from a local checkout / tarball
dsh plugin --profile web add ./dsh-session-toolkit-<version>.tgz
```

The package's `dsh.bundle.patch` (`cordis.patch.yml`) registers the single entry (`id: session-toolkit`, `name: 'dsh-session-toolkit'`) as a **bundle layer** — applied after `dsh-base` / `dsh-web-app` and before the profile patch layer (layer order: bundles in sequence → profile patch → home patch → `--patch` overlay).

Uninstall: `dsh plugin --profile web remove dsh-session-toolkit`.

### Local development

To iterate on the source without publishing, install the checkout directly (`dsh plugin --profile web add <path-to-checkout>`, which uses a pnpm `link:` dependency), or use a manual junction into the profile's `node_modules` plus an explicit `- insert:` entry in the profile's `cordis.patch.yml`. Prefer `dsh plugin add`.

Verification gate for the source checkout only (`scripts/` is not shipped in the published package; no build step and no dependency install needed):

```powershell
pnpm check    # syntax gate — node --check over every shipped JS file
pnpm verify   # + packaging contract — entry reachability, undeclared imports, EN/ZH README version parity
```

`pnpm verify` asserts that the working-tree content equals the tarball content, so it fails on purpose if a `prepare`/`prepack`/`prepublishOnly` script is ever added. The DSH integration-point inventory used when upgrading the harness lives in `docs/agents/integration-contracts.md`.

### Share & Install

Published on **npm** as `dsh-session-toolkit` (**latest published version: v0.1.11**, MIT) and mirrored on **GitHub** at `github.com/Han-Yao94/dsh-session-toolkit`. Pure-JS package — **no build step, no prepare script**. `files` whitelists `lib/`, `client/`, `cordis.patch.yml` and the READMEs.

> **npm carries the current version.** `0.1.11` is published, so `dsh plugin --profile web add dsh-session-toolkit` gives you the session-management tools (`create_session` / `rename_session`) and everything else described above. `0.1.9` and `0.1.10` were tagged but never reached npm, so this is the first published version since `0.1.8`. Installing from this checkout or from GitHub (`dsh plugin --profile web add github:Han-Yao94/dsh-session-toolkit`) is equivalent.

- **npm**: consumers run `dsh plugin --profile web add dsh-session-toolkit`; new versions are released with `npm publish` (or `pnpm publish`).
- **GitHub**: `dsh plugin --profile web add github:Han-Yao94/dsh-session-toolkit`.
- **Tarball**: `pnpm pack` → `dsh plugin --profile web add ./dsh-session-toolkit-<version>.tgz`.

Runtime dependencies (`@deepseek-ai/schemastery` — floor `^3.18.3`, the first version with `volatile()` —, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-home-paths`) are declared in `dependencies` and install automatically; platform modules (`react`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-locale`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-primitives`) are `peerDependencies` provided by the DSH host. Harness-provided ranges name **one prerelease generation each** — `^0.1.7-alpha.1` — because a caret range never crosses a minor line, and semver additionally requires a comparator carrying a prerelease **of the candidate's own `major.minor.patch`**; that is why `^0.1.2-alpha.5 || ^0.1.6-alpha.2` used to be written as a union, and it is exactly how the §F resolution skew happened (the plugin kept its own older copy while the host ran a newer one). With `dsh-v0.1.7-alpha.1` as the minimum supported version, the older union members are gone: **a harness upgrade now requires bumping these ranges**, and `node scripts/dependency-skew.measure.mjs --profile <DSH_HOME>/profiles/web` (expect `SKEW_COUNT=0`) is the check that tells you when. Ranges take effect at install time only — reinstall and restart the GUI before re-measuring. `@deepseek-ai/dsh-client-ui-slots` is intentionally absent: the `slots` service is seeded by the web shell, so a npm peer declaration was dead weight. Verified: a clean install of the packed tarball resolves all imports without any local junction. Two install-side tools back this up (they need an external checkout/profile, so they are not CI jobs — see `docs/agents/integration-contracts.md` §D/§E/§F):

```bash
node scripts/dependency-skew.measure.mjs --profile <DSH_HOME>/profiles/web   # §F: 期望 SKEW_COUNT=0
node scripts/dsh-log-ui.drift.mjs --harness <deepseek-harness 路径>          # §E: 复刻件漂移
```

---

## Model Experience

### System prompt contributions

#### What the model sees

Three sections are contributed per assembly, in order: `session-identity` (order 40) → `global-prompt` (order 50) → `workspace-prompt` (order 60), placed after the deployment persona and before tool guidance (100–199). The identity section is resolved per agent (`AssembleContext.agent`) at assembly time from `session-identity` settings and is skipped for subagents (`origin`/`delegationDepth`). The workspace section injects the most-specific (longest matching path) enabled workspace prompt for a session whose `cwd` prefix-matches a configured workspace; otherwise nothing.

Each of the global and workspace sections appends its **referenced files' content** after the prompt text: every assembly re-reads `files` with `fs.readFileSync` (UTF-8, live), sanitizes each file's content (spaces out `{` runs), and concatenates them. A file that cannot be read is **skipped** (its content is not injected) but its read status is recorded for the UI. Empty sections are dropped at render.

#### Token effect

All three sections repeat their text on every request when enabled. The global prompt applies to every conversation; the identity text applies only to sessions that resolve it (their own record or the default); the workspace text applies only to sessions whose `cwd` prefix-matches an enabled configured workspace (most-specific match wins). Referenced files add their full content to the effective prompt and therefore consume additional tokens — a large referenced file meaningfully increases the per-request token cost. Identity text is clipped to 8000 chars as a token guard.

#### KV Cache effect

Each section's rendered text is a fixed part of the request prefix while its settings are unchanged. Editing a session identity or a global/workspace prompt (or editing / adding a referenced file) may invalidate provider cache reuse from the first changed token (same semantics as stock persona sections).

### Tool surface

`send_to_session`, `list_sessions`, `create_session` and `rename_session` are registered on the host plane and visible to every session (subagents inherit them through the standing preset composition). Their arguments and results are JSON-compatible. **All four are exposed to the model**, so `create_session`'s semantic consequence — creating one produces a real user message and consumes one model call — is model-visible.

---


### Migrating from the old `settings.yaml` (0.1.6 → 0.1.7)

Up to 0.1.6 this plugin kept its user data in namespaces inside `<DSH_HOME>/settings.yaml`. When 0.1.7 boots, it renames that file to `settings.yaml.imported` and imports **only** sections whose name equals a live entry id; this plugin's old namespaces (`session-identity`, …) match no entry id, so they are refused and left untouched in `settings.yaml.imported`.

Migration map (old section → new config path); a single pass moves everything:

| Old `settings.yaml` section | New config path |
|---|---|
| `session-identity.default` / `.sessions` | `identity.default` / `identity.sessions` |
| `global-prompt.{enabled,content,files}` | `globalPrompt.{enabled,content,files}` |
| `workspace-prompt.{workspaces,removed}` | `workspacePrompt.{workspaces,removed}` |
| `session-auto-resume.sessions` | `autoResume.sessions` |
| `session-toolkit-ui.*` | `client.*` (same defaults; usually nothing to move) |
| `workspace-registry-active`, `prompt-file-status` | **Discard**: runtime projections, now served by `GET /api/session-toolkit/state` |

Two ways to land it, pick one:

1. **Settings page**: open the `dsh-session-toolkit` entry in Plugins and paste the old values into the matching fields (the form writes them into the profile patch).
2. **Edit the profile patch directly** (handy for bulk moves): append a `- id: session-toolkit` item to `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` and put the right-hand paths above under `config:`. Validate the shape first with the plugin's own `Config`:

   ```js
   import plugin from 'dsh-session-toolkit'   // or import the checkout's lib/index.js
   plugin.Config(migratedConfig)              // throws when the shape is wrong
   ```

---
## Mechanisms and Red Lines

- **Identity injection** uses a single global section whose text provider resolves per agent — no per-agent registration, no lifecycle churn, real-time on settings change.
- **Frozen-config rule (red line)** — a `volatile` field's `ref.get()` returns a **`deepFreeze` snapshot** (immutable). Anything that edits it must **first `{ ... }` copy (and `.slice()` arrays)**: the host half hands the new value to `ctx.get('settings').update(...)`, the browser half hands it to the form's `set` / `mutate` (which submit by config path instead of replacing the whole section). Writing to the frozen object directly throws `object is not extensible` (this was the root cause of the "workspace list empty" bug fixed here). The same `{ ... }` copy rule applies on the client for `workspacePrompt.workspaces` writes (`onWsFilesChange` / `save` / `saveWsEnabled` / `removeWorkspace`).
- **Referenced files are read live and failures are skipped** — `readPromptFiles` runs inside the prompt `text()` on every assembly; a failing file never breaks assembly and its status is recorded into the in-process projection served by `GET /api/session-toolkit/state` and shown by the settings page.
- **Auto-resume never calls `dispose()`** — `AgentHandle.dispose()` removes the session from storage; turning a switch off only affects the next restart, it never takes a live session down.
- **Restart is UAC-free by construction** — the spawn inherits the server process token (SYSTEM or user), so `taskkill` targets a same-privilege process and the script's elevated branch (the only UAC source) is unreachable. If port 3080 is held by another program, an elevated retry may still appear (documented in the restart script).
- **Shadowing is cell-based** — the utilities entry re-registers the stock `session-log-download` cell at a lower priority; the stock entry abdicates gracefully if the shadow crashes.
- **Plain-text conversion** — `toPlainText` (10 rules, code-fence state machine, loose matching) runs at send time only; the message structure and `source: { kind: 'user' }` are unchanged.

---

## Known Limitations and Deferred Work

- Client half is a hand-maintained single-file IIFE bundle; adding a feature touches both `lib/` and `client/client.js`.
- **No gate covers identifier scope in the client half.** A block that calls `react.useState` must also call `require('react')`: `react/jsx-runtime` does not provide it, and a missing binding throws while the component renders. The slot renderer catches that throw and drops the entry, so the symptom is a button that is silently not there -- not an error anyone sees. This shipped from 2026-09-18 (`3e44642`, which added the hooks calls without adding the require) until 2026-09-22, through every gate.
- **A received peer message shows up as a collapsed row, not as a readable message.** `send_to_session` records the delivery with producer attribution — `source: { kind: 'agent-message', form: 'relay', senderSessionId }` — and the client renders every non-human source through its turn-trigger row, which is collapsed until you click it. Writing `kind: 'user'` instead would render inline like a human message, but would record another agent's words as the user's in the one field the V4 format made producer-owned. The attribution wins; click the row to read the body (it still names its sender in the first line).
- **Icon names are part of the integration surface.** DSH 0.1.7 renamed the `@deepseek-ai/dsh-client-ui-primitives` icons from `IconXxxOutline<size>` to `IconXxxOutlineRegular` / `IconXxxOutlineMedium` (1 px vs 1.3 px stroke; the artwork keeps the old default `size`), so the client half must use the **target harness's** names. A name that no longer exists evaluates to `undefined` and `React.createElement(undefined, …)` throws, which blanks that component's subtree **while its navigation entry still appears** (registration and rendering are separate). Every other gate stays green on this — syntax, packaging and the anchor gate all passed. Gate it with `node scripts/primitives-export.assert.mjs --harness <checkout>`: exit 1 lists every member the plugin references that the installed harness does not export.
- The relocated Session-log entry depends on the official `sessionLogDownload` controller interface **and** mirrors the 0.1.6 official surface (a "⋯ More actions" menu). It is a frozen replica: run `node scripts/dsh-log-ui.drift.mjs --harness <checkout>` after a DSH upgrade — it audits both sides for the same anchors and exits non-zero on drift (§E). **Deliberate divergence:** the official header menu has since gained a second item (`feedback`); this replica carries download only. That is a decided state, not an open question — the drift gate reports it as a note rather than a failure because following a new upstream capability is itself a decision, and that decision was taken on 2026-09-22: **do not follow**. Re-open it only if the feedback entry is wanted here too.
- Loose emphasis matching in `toPlainText` can drop `*` pairs in non-format positions (e.g. `a * b * c`); acceptable for agent-generated messages, boundary tightening is optional.
- The aggregate `inject` union waits for every listed service; a profile missing one service delays the whole package (web profile provides all of them today).
- Harness-provided dependency ranges are prerelease unions; `pnpm install` must be re-run after changing them, and the resulting install should be checked with `node scripts/dependency-skew.measure.mjs --profile <DSH_HOME>/profiles/web` (expect `SKEW_COUNT=0`; `DE-INSTANCE` = same version, different instance, which §F treats as acceptable).
- `ctx.get('agentDefaultModel')`, `sessionTitle` and `workspaceRegistry` are resolved lazily at call time and degrade to `cwd`/path addressing; `tools` and `webServer` are awaited through `ctx.inject` so a late-arriving service cannot silently disable a feature (the loader creates entries concurrently, so apply-time `ctx.get` had no ordering guarantee).
- **Restart probe window** — a restart is only detected when the health probe fails for `restartFailThreshold × restartPollMs` (default 2 × 1000 ms = 2 s) and then recovers. If a relaunch completes in under that window, the overlay can misreport "no restart detected" (`noRestart`); lowering `restartFailThreshold` to 1 makes detection more sensitive but also lets a single transient failure masquerade as a restart interruption.
- **Referenced files are warmed on the assembly path** — `readPromptFiles` runs a `statSync` per referenced file on every assembly and reads only when `mtimeMs`/size changed; the per-file and total byte budgets prevent a huge file from blocking assembly or inflating the prompt, and the status projection is written only on change. On the client, `files` are saved immediately (`onWsFilesChange` / `save`).
- **UI knobs come from the same entry's `client.*`** — the browser half reads those fields through `configForms.get('session-toolkit')` and falls back to the frozen `UI_FALLBACK` when the form is unavailable. A client entry still receives no cordis row config, but reading settings no longer needs a host mirror: one entry `Config` is visible to both sides.
- **Minimum harness version is `dsh-v0.1.7-alpha.1`** — the settings data plane became entry-`Config` `volatile` fields plus `configForms` in 0.1.7. On 0.1.6 and earlier there is no `configForms`, so the client entry stays `pending` and the web client reports `Failed to load plugins`; that is a deliberate loud failure (hard inject), not a silent degradation.

---

## Recovery

Uninstall the bundle: `dsh plugin --profile web remove dsh-session-toolkit`, then restart the GUI. To roll back to the pre-consolidation layout, re-enable the original plugins instead of installing this package.
