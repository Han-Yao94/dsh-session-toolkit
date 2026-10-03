# dsh-session-toolkit

[English](README.md) | [中文](README.zh.md)

A consolidated plugin toolkit for the **DeepSeek Harness**. Five previously separate local plugins — **session identity**, **global prompt**, **session auto-resume**, **Session-log button relocation**, and **peer-session messaging** — merged into a single installable package that ships in the official bundle form (`dsh.bundle.patch`) and installs with `dsh plugin add`; it also includes a **Prompt Dedup** feature.

Current version: **1.0.0**, verified against **DeepSeek Harness `dsh-v0.2.0-rc.1`** — which is also its **minimum supported version** (**contract surfaces + the full gate suite — not a complete functional regression**): 0.1.6 and earlier fail loudly by design rather than degrading silently (see [Compatibility](#compatibility)).

---

## Install

Into any profile — a bundle layer, single source, no copies:

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

### What you are installing

Published on **npm** as `dsh-session-toolkit` (**latest published version: v1.0.0**, MIT) and mirrored on **GitHub** at `github.com/Han-Yao94/dsh-session-toolkit`. Pure-JS package — **no build step, no prepare script**. `files` whitelists `lib/`, `client/`, `cordis.patch.yml` and the READMEs.

> **npm carries the current version.** `1.0.0` is published, so `dsh plugin --profile web add dsh-session-toolkit` gives you the session-management tools (`create_session` / `rename_session`) and everything else described above. `0.1.9` and `0.1.10` were tagged but never reached npm; `0.1.11` was the first published version since `0.1.8`. Installing from this checkout or from GitHub (`dsh plugin --profile web add github:Han-Yao94/dsh-session-toolkit`) is equivalent.

- **npm**: consumers run `dsh plugin --profile web add dsh-session-toolkit`; new versions are released with `npm publish` (or `pnpm publish`).
- **GitHub**: `dsh plugin --profile web add github:Han-Yao94/dsh-session-toolkit`.
- **Tarball**: `pnpm pack` → `dsh plugin --profile web add ./dsh-session-toolkit-<version>.tgz`.

Runtime dependencies (`@deepseek-ai/schemastery` — floor `^3.18.4` —, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-home-paths`) are declared in `dependencies` and install automatically; platform modules (`react`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-locale`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-primitives`) are `peerDependencies` provided by the DSH host. Harness-provided ranges name **one prerelease generation each** — `^0.2.0-rc.1` — because a caret range never crosses a minor line, and semver additionally requires a comparator carrying a prerelease **of the candidate's own `major.minor.patch`**; that is why `^0.1.2-alpha.5 || ^0.1.6-alpha.2` used to be written as a union, and it is exactly how the resolution skew happened (the plugin kept its own older copy while the host ran a newer one). With `dsh-v0.2.0-rc.1` as the minimum supported version, the older union members are gone: **a harness upgrade now requires bumping these ranges**, and a dependency skew measurement against a live profile (expect `SKEW_COUNT=0`) is the check that tells you when. Ranges take effect at install time only — reinstall and restart the GUI before re-measuring. `@deepseek-ai/dsh-client-ui-slots` is intentionally absent: the `slots` service is seeded by the web shell, so a npm peer declaration was dead weight. Verified: a clean install of the packed tarball resolves all imports without any local junction. Two install-side checks back this up (they need an external checkout/profile, so they are not CI jobs): a dependency skew measurement against a live profile, and a drift audit of the frozen session-log replica against the harness checkout. Both live in the maintainers' working copy.

### Local development

To iterate on the source without publishing, install the checkout directly (`dsh plugin --profile web add <path-to-checkout>`, which uses a pnpm `link:` dependency), or use a manual junction into the profile's `node_modules` plus an explicit `- insert:` entry in the profile's `cordis.patch.yml`. Prefer `dsh plugin add`.

The maintainers' verification gate — syntax over every shipped JS file, plus a packaging contract (entry reachability, undeclared imports, EN/ZH README version parity) — runs against the source checkout. It is **not part of this repository and not part of the published package**: only `lib/`, `client/`, `cordis.patch.yml`, the READMEs and `package.json` are tracked here. The gate asserts that the working-tree content equals the tarball content, so it fails on purpose if a `prepare`/`prepack`/`prepublishOnly` script is ever added. The two aggregate commands (`pnpm check`, `pnpm verify`) cover only syntax and this packaging contract — **neither runs any assertion gate**: each assertion gate is invoked on its own and carries its own exit-code contract.

---

## Features

Two families: **prompt layers** (what the model sees) and **session plumbing** (the tools and UI buttons that drive sessions).

### Prompt layers

#### Session Identity
Per-session persona prompt injected into that session's system prompt (independent section `session-identity`, order 40, resolved per agent at every assembly), with a default identity plus per-session overrides. UI provides an identity dialog (enable switch, 4000-char soft limit, save/reset, edit default, inherit default) and status buttons in both `conversation.session.header.actions` (id `session-identity`, order 40) and `conversation.input.left` (id `session-identity-input`, order 40). The dialog card can be dragged by its title row: the offset is clamped to the viewport on every move and re-clamped on window resize, and when the card is larger than the viewport **each axis stays movable**, so every edge remains reachable. The position is not persisted — it resets when the dialog is closed.

#### Global Prompt
A settings page (`settings.section`, id `global-prompt`, order 30) rendered as **Tabs (Global / Per workspace / Groups)**. The *Global* tab injects one prompt into every conversation's system prompt; the *Per workspace* tab injects per-workspace prompts; the *Groups* tab injects per-group prompts (see [Group Prompt](#group-prompt)). Those three, plus the session identity and the peer-inbox discipline section, make up the five prompt sections this plugin contributes — the map below lists them all with their orders.

The plugin also exposes a read-only state route `GET /api/session-toolkit/state` (live workspaces + referenced-file read status + the live session list the group picker needs; any other method answers 405), which is how the settings page reads those runtime projections — they no longer occupy a settings namespace and are never persisted.

#### Workspace Prompt
Per-workspace prompt injected for sessions whose `cwd` prefix-matches a configured workspace directory (that directory plus its subdirectories). The workspace list is derived from **active sessions' `cwd`** (`ctx.agents.roots()`), deduplicated and counted. When several enabled workspaces prefix-match a session's `cwd`, the **most-specific (longest matching path)** one wins. `removed` records paths the user removed so the active-workspace sync never re-adds them. The workspace row's enable switch is **live-save** (persisted immediately); the Save button only persists the prompt **content + referenced files**.

#### Group Prompt
A tab of its own on the same settings page: **Groups** inject a prompt into **arbitrary sessions across workspaces**. Each group is a named entry holding an enable switch, a prompt body, a referenced-file list and an explicit **member list of session ids**; a session is matched by **its own session id**, not by its directory — which is exactly what lets one group span several workspaces. Membership is an **additional** injection layer: it never replaces the global or the per-workspace prompt. Every enabled group whose `sessions` contains the current session id injects into the section `group-prompt` (order 55, between global 50 and workspace 60), and several matched groups stack in **group-key order** with one blank line between their blocks. The picker lists **live sessions only** and **never auto-adds** one: a brand-new session joins no group until you tick it, and a session still listed in a group but currently offline is shown as *not online* (removable). When the assembly context carries no session id, the section injects nothing.

#### Referenced Files
Global, workspace and group prompts can each reference a **list of files**. Every assembly re-reads each referenced file (UTF-8, content cached by `mtimeMs` + size, so an unchanged file is not re-read) and injects it after the prompt text. Byte budgets are enforced (`globalPrompt.maxFileBytes` / `maxTotalBytes`, defaults 256 KiB / 1 MiB): an oversized file is **skipped** rather than blocking assembly. A read failure is skipped too, and both cases are reported in the UI with the reason. Supports plain text and markdown. Per-file read status is a host **runtime projection** delivered to the UI by the read-only route `GET /api/session-toolkit/state` (`ok`: N chars / `fail`: reason / pending); the browser half polls it only while the settings page is open. The status **never touches a configuration file**, and its projection object is only replaced when the content actually changed.

#### Prompt Dedup
Performs **cross-section line-level deduplication** across the identity / global / group / workspace system-prompt sections (`session-identity`, `global-prompt`, `group-prompt`, `workspace-prompt`, orders 40/50/55/60). `promptDedup.enabled` is on by default (disable only by setting it to `false`). Splits each section on `\n` and keeps only the **first occurrence** of each identical original line (a single `seen` set spans all four sections, so intra-section self-duplicates also collapse); duplicate lines in later sections are dropped. **Blank lines (including whitespace-only lines) never take part in deduplication** — they are markdown's paragraph/list separators, and treating them as duplicates silently collapsed every section after the first one. Every section's unique content is preserved. It does not parse `{{name}}` placeholders (single-line complete groups, never split by line), does not break markdown, never sets `complete`, and never touches harness-owned sections (`harness:identity` / `deployment:persona` / tool sections). Mechanism: subscribe to the `system-prompt/assemble` waterfall on the plugin's root ctx, `await next()`, then deduplicate `sections` on the returned result before returning it.

#### Prompt section map

| Section id | Order | Injected for | Notes |
|---|---|---|---|
| `session-identity` | 40 | sessions that resolve an identity (their own record, else the default) | resolved per agent at every assembly; skipped for subagents (`origin` / `delegationDepth`) |
| `peer-inbox-discipline` | 45 | every non-subagent session | fixed reminder of the inbound-peer-message rule (see [Peer Messaging](#peer-messaging)); no settings of its own |
| `global-prompt` | 50 | every conversation | |
| `group-prompt` | 55 | sessions whose **own id** is listed in an enabled group | several matched groups concatenate in group-key order, one blank line between blocks; no match injects nothing |
| `workspace-prompt` | 60 | sessions whose `cwd` prefix-matches an enabled workspace | the most-specific (longest matching path) match wins; otherwise nothing |

All five prompt sections are registered with **`interpolate: false`**, so `{{...}}` inside prompt text and referenced files stays literal — user content is never rewritten, and an unregistered `{{name}}` can never fail assembly. On kernels older than 0.1.6 (no per-section `interpolate` flag) `lib/prompt-literal.js` falls back to escaping `{` runs in the assembled text.

### Session plumbing

#### Session Auto-Resume
Sessions with the per-session switch on are resumed automatically after a GUI restart, through the **official resume path** (`ctx.sessionController.resolveAgent`) when it exists — that is what restores the session's own model selection (via `installSelection`) in addition to the preset mount, and it validates subagent ownership and de-duplicates concurrent resumes. Older kernels without `sessionController` fall back to `ctx.agents.resume` plus a preset mount, carrying the default model from `agentDefaultModel`. Switching a session on resumes it immediately (false→true edge). Filters: switch on, top-level only (no subagent origin, no `delegationDepth > 0`, no `parentSession`), non-blank (`eventCount !== 0`, snapshot shape). Concurrency-bounded (default 3, configurable via `autoResume.concurrency`) with per-item failure isolation and an in-flight set that prevents duplicate resume.

#### Session Admin
The host plane registers two more tools on the **same plane as `send_to_session` / `list_sessions`**:

- **`create_session`** — create a new top-level session (a chat window in the GUI's left navigation). **Both `cwd` and `prompt` are required**: `cwd` must be an absolute path (a session without `cwd` never enters the host list) and `prompt` is the new session's first message. A successful create produces a real user message (**it genuinely runs one model turn and consumes one call**); by kernel design any session with events is persisted, so **this tool deliberately offers no "register-only, never speaks" ephemeral session**. An optional `title` sets the title immediately and pins it. The result carries `sessionId`, `cwd`, `status`, `title` and `notes`.
- **`rename_session`** — retitle a **live** session. A rename **pins** the title so automatic title generation no longer overwrites it. The target must be a top-level session and currently live: a subagent target (`origin=subagent` or `delegationDepth>0`) is refused explicitly rather than silently rewritten.

Both return **structured results** and **never throw an uncaught exception from the tool body**: success is `{ ok: true, … }`, failure is `{ ok: false, error: '<code>', errorText: '<original reason>' }`. Codes: `MODEL_UNAVAILABLE` / `MODEL_SELECTION_FAILED` / `MODEL_SELECTION_INVALID` / `EMPTY_CWD` / `CWD_NOT_ABSOLUTE` / `EMPTY_PROMPT` / `PROMPT_TOO_LONG` / `PRESET_RESOLVE_FAILED` / `CREATE_FAILED` / `CREATE_UNAVAILABLE` / `CREATE_NO_AGENT` / `EMPTY_TARGET` / `EMPTY_TITLE` / `SESSION_UNAVAILABLE` / `TARGET_IS_SUBAGENT` / `TITLE_SERVICE_UNAVAILABLE` / `UNEXPECTED`.
(A missing `prompt` is rejected by the kernel's tool-argument validation at the **framework layer** — the kernel turns that into a tool-error result, and the exception never passes through this plugin's code; only a `prompt` that is present but blank is answered with this plugin's `EMPTY_PROMPT`. Neither creates a session.)

**Two honest disclosures**:
- **Visibility is not verified inside the tool** — whether a session created with `prompt` actually appears in the left navigation depends on the kernel **genuinely starting a turn** (navigation filters on the "blank session" bit, which only flips on `turn/start`; `followup` merely enqueues and wakes the driver). The result therefore draws **no** "it is in the navigation" conclusion, and `notes` says so.
- **Preset degradation** — when the `agentPresets` service exists but default-preset resolution fails, the tool **returns `PRESET_RESOLVE_FAILED` instead of handing back a crippled session with no preset mounted**; when the service is absent entirely that is a legitimate degradation, and the session is still created with an explanatory `notes` entry.

#### Peer Messaging
`send_to_session` / `list_sessions` tools on the host plane (session addressing by id or workspace path, wakeup delivery) plus a "copy session ID" button in both `conversation.session.header.actions` (id `copy-session-id`, order 30) and `conversation.input.left` (id `copy-session-id-input`, order 30). Outgoing message content is converted to plain text (`toPlainText`) before delivery so recipients see tidy text rather than raw markdown. **`wakeup` has two distinct delivery paths**: with `wakeup: true` (`steer`) a message delivered while the target is executing enters the **next step boundary of the running turn** — it neither starts a new turn nor interrupts the current step — and a message delivered while the target is idle starts a turn immediately; with `wakeup: false` (`inject`) the message is only deposited and nobody is woken. **Two windows still queue rather than splice**: the target is idle at delivery (no step boundary exists to splice into, so the message is taken at the next turn boundary) and the kernel's `wakingAfterAbort` re-classification, which silently degrades `steer` to `next-turn` while the previous activity is being cancelled. `steer` is therefore **not** a promise that a message never waits — whether a message was actually spliced is decided by three things together: `target` was `next-step`, a turn was running at delivery time, and **no new `turn/start`** appeared between delivery and consumption.

#### Session-Log Button Relocation
Shadows the official entry in `conversation.session.header.utilities` (same id `session-log-download`, priority −1, cell-shadowing) and registers a copy in `conversation.session.header.actions` (id `session-log-download-moved`, order 41), reusing the official `sessionLogDownload` controller (`ctx.get('sessionLogDownload')`) so download behavior stays identical to stock. The copy mirrors the **0.1.6** official surface — a "⋯ More actions" menu whose single item triggers the shared download dialog (localized through this plugin's own locale namespace) — and is a frozen replica: a stock upgrade that changes that UI must be synced by hand, and the shadowing registration must be re-checked whenever the official entry gains new menu items.

#### Cross-session search

`search_sessions` is the sixth model tool: a literal, case-insensitive, whitespace-flexible content search across sessions ("where did we discuss X?"), built on the harness `sessionQuery` service. It lists sessions, filters them by `cwd` / `since`, matches the query against each session's extracted semantic text, and returns the session title plus event coordinates (`sessionId` + `seq` — the two values the host's session-query reading tools take; this package exposes no reader tool of its own) and a text excerpt. Every failure comes back as a structured `{ ok: false, error, errorText }` object — the tool never throws into the calling session.

**Surfaces are the part worth knowing.** By default the tool returns matches from `current` (text still in a session's effective model context) **and** `shadowed` (text a later snapshot replaced, or context compression dropped) — `shadowed` is usually where the thing you are trying to recover actually lives. `log-only` (raw-log-only records that never reached a surface) is excluded unless you pass `surfaces` explicitly. The scan is always literal — it goes through the harness `filterEvents` path and never touches the FTS index, so enabling the index changes nothing here. When the `sessionQuery` service is absent, the module registers nothing and the rest of the package keeps working.

Scan budget: 50 sessions / 5 matches per session / 20 matches total by default (`maxSessions`, `perSession` and `limit` raise these, with hard caps of 200 / 20 / 100); `truncated.sessions` / `truncated.matches` report when a session or match cap was hit, and an empty result is `ok: true` with zero matches, not a failure.

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
| `groupPrompt.groups` | `Record<groupKey,{enabled, content, files: string[], sessions: string[]}>` | Named groups (**the dictionary key is the group name**). A group injects its prompt (section `group-prompt`, order 55) when `enabled` and its `sessions` contains the current session id — membership is by session id, so a group can span workspaces, and it is **additive** (the global and per-workspace prompts still apply). v1 lists live sessions only and never auto-adds one. |
| `client.*` | 2 UI knobs (see the table below) | Browser-half runtime parameters (char limit, copy feedback). |

**Runtime projections (never persisted, not configuration):** live workspaces `[{path, sessionCount}]` aggregated from **`ctx.agents.roots()`** (each agent's `session.header.cwd`, deduped and counted; never sourced from `workspaceRegistry`, which is not visible in this plugin's scope), the live session list `[{id, cwd, title}]` the group picker consumes (the title comes from the optional `sessionTitle` service and is `null` when that service is missing or throws — reading it must never fail the route), and referenced-file read status `Record<global\|path, [{filePath, status: 'ok'\|'fail', charCount?, reason?}]>`; both reach the settings page through `GET /api/session-toolkit/state`.

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
    groupPrompt:
      sectionOrder: 55
      groups: {}              # volatile: Record<groupKey, {enabled, content, files, sessions}>
    autoResume:
      concurrency: 3
      sessions: {}            # volatile: Record<sessionId, boolean>
    promptDedup:
      enabled: true           # cross-section line-level dedup across identity/global/group/workspace; default true (disable only by setting false)
    client:
      identityCharLimit: 4000 # volatile: the 2 keys below are read by the browser half
      copyFeedbackMs: 1600
```

| Key | Default | Meaning |
|---|---|---|
| `identity.maxText` | 8000 | Identity text clip limit (chars, token guard). UI soft limit is `client.identityCharLimit` (4000, editor); **host hard-clip** is this value (8000). |
| `identity.sectionOrder` | 40 | System-prompt order of the identity section. **Migration**: users who explicitly pinned `identity.sectionOrder: 55` must set it to 40 to keep the identity-before-global ordering. |
| `globalPrompt.sectionOrder` | 50 | System-prompt order of the global prompt section. |
| `globalPrompt.workspaceSectionOrder` | 60 | System-prompt order of the workspace prompt section (placed last). |
| `groupPrompt.sectionOrder` | 55 | System-prompt order of the group prompt section (between global 50 and workspace 60; several matched groups are concatenated in group-key order with one blank line between blocks). |
| `globalPrompt.maxFileBytes` | 262144 | Per referenced file byte limit; an oversized file is skipped (status `fail`) instead of blocking assembly. |
| `globalPrompt.maxTotalBytes` | 1048576 | Combined byte budget for all referenced files of one section. |
| `autoResume.concurrency` | 3 | Max in-flight resumes during startup restore. |
| `promptDedup.enabled` | true | Cross-section line-level deduplication across the identity/global/group/workspace system-prompt sections (on by default; disable only by setting it to `false`). When on, each **identical non-blank original line** across the four sections keeps only its "first occurrence" (a single `seen` set spans all four); duplicate lines in later sections are dropped, while **blank lines are always preserved** (they are markdown's paragraph/list separators). Every section's unique content is preserved. It does not parse `{{name}}` placeholders, does not break markdown, never sets `complete`, and never touches harness-owned sections. |
| `identity.default` / `identity.sessions` | empty | **User data** (volatile): default identity and per-session identities. Written by the "Session identity" settings page; also editable directly in the profile patch. |
| `globalPrompt.enabled` / `.content` / `.files` | off / empty | **User data** (volatile): global prompt switch, body, and referenced file list. |
| `workspacePrompt.workspaces` / `.removed` | empty | **User data** (volatile): per-workspace prompts plus the removed-path list. The active-workspace sync adds newly discovered paths to `workspaces` (through `ctx.get('settings').update`); paths listed in `removed` are never re-added. |
| `autoResume.sessions` | empty | **User data** (volatile): per-session "resume after restart". A false→true edge resumes that session immediately. |

The `client.*` keys below are validated by the host; they are the very fields the browser half reads through `configForms.get('session-toolkit')` (when the form is unavailable the client falls back to `UI_FALLBACK` in `client/client.js`, whose values equal the historical defaults). You can edit them in the plugin's settings page.

| Key | Default | Meaning |
|---|---|---|
| `client.identityCharLimit` | 4000 | Identity editor character limit (UI soft limit; the global-prompt editor uses it too). |
| `client.copyFeedbackMs` | 1600 | Copy-feedback checkmark duration. |

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

## Architecture

- **Host half** — `lib/index.js` composes nine modules (`identity.js`, `global-prompt.js`, `auto-resume.js`, `peer-message.js`, `session-admin.js`, `log-reposition.js`, `prompt-dedup.js`, `prompt-literal.js`, `session-search.js`). `inject` is the deduplicated union of module dependencies; each module's `apply` runs inside a `safe()` guard so one failing module never takes the whole package down. Every contribution is lifecycle-bound (`ctx.effect` for prompt sections and HTTP routes, plugin-fiber registrations for tools; timers go through the `timer` service). `global-prompt.js` owns the `globalPrompt`, `workspacePrompt` and `groupPrompt` volatile fields, the three prompt sections (`global-prompt` order 50 / `workspace-prompt` order 60 / `group-prompt` order 55), the `readPromptFiles` helper (mtime/size-cached live read; the cache is **namespaced per section**, so one section's eviction never drops another section's entries), the live runtime projections (active workspaces plus the live session list behind `GET /api/session-toolkit/state`), and the config write that adds newly discovered workspace paths back into the entry (`ctx.get('settings').update('session-toolkit', …)`); `prompt-literal.js` is the pre-0.1.6 fallback for literal prompt rendering.
- **Client half** — `client/client.js` is a single `window.__ModuleLoader__.load` bundle; the four UI modules live in IIFEs and are collected into one `apply` that registers all slots in order (guarded per module). All UI uses `React.createElement`; styles are injected as `data-plugin` style tags with theme CSS variables and dark-mode coverage; no global DOM manipulation. The global-prompt module renders the **Tabs (Global / Per workspace / Groups)** page plus a reusable `FileRefsPanel` (add/remove referenced files, per-file status from the polled `GET /api/session-toolkit/state` projection) and the group editor (add/rename/remove groups, enable switches, prompt body, referenced files, and a session picker that lists live sessions as `title ?? short id` and marks saved-but-offline members *not online*).

### Registered slots

| Slot | Id | Order / priority | Feature |
|---|---|---|---|
| `settings.section` | `global-prompt` | order 30 | Global + workspace + group prompt page (Tabs) |
| `conversation.session.header.actions` | `copy-session-id` | order 30 | Copy session ID |
| `conversation.session.header.actions` | `session-identity` | order 40 | Identity button |
| `conversation.session.header.actions` | `session-log-download-moved` | order 41 | Session log download |
| `conversation.input.left` | `copy-session-id-input` | order 30 | Copy session ID (tool row) |
| `conversation.input.left` | `session-identity-input` | order 40 | Identity button (tool row) |
| `conversation.session.header.utilities` | `session-log-download` | priority −1 (shadow) | Hide stock button |
| `sidebar.workspaces.session.menu.item` | `dsh-session-toolkit.copy-session-id` | order 500 | Copy session ID (session row ⋯ menu) |

---

## Model Experience

### System prompt contributions

#### What the model sees

Five sections are contributed per assembly, in order: `session-identity` (order 40) → `peer-inbox-discipline` (order 45) → `global-prompt` (order 50) → `group-prompt` (order 55) → `workspace-prompt` (order 60), placed after the deployment persona and before tool guidance (100–199). The identity section is resolved per agent (`AssembleContext.agent`) at assembly time from `session-identity` settings and is skipped for subagents (`origin`/`delegationDepth`). The peer-inbox discipline section emits a fixed reminder of the inbound-peer-message rule; it is likewise skipped for subagents and has no settings of its own. The workspace section injects the most-specific (longest matching path) enabled workspace prompt for a session whose `cwd` prefix-matches a configured workspace; otherwise nothing. The group section injects every enabled group whose `sessions` list contains the session's **own id** — groups match by session id, not directory, so one group may span workspaces; multiple matching groups concatenate in group-key order with a blank line between blocks, and no match injects nothing. (See the [prompt section map](#prompt-section-map) for the same five sections as a table.)

Each of the global and workspace sections appends its **referenced files' content** after the prompt text: every assembly re-reads `files` with `fs.readFileSync` (UTF-8, live), appends each file's text **verbatim** (nothing rewrites it; the `{`-run escaping only happens on the pre-0.1.6 fallback path in `lib/prompt-literal.js`), and concatenates them. A file that cannot be read is **skipped** (its content is not injected) but its read status is recorded for the UI. Empty sections are dropped at render.

#### Token effect

All five sections repeat their text on every request — the four prompt sections when enabled, the peer-inbox discipline section for every non-subagent session. The global prompt applies to every conversation; the identity text applies only to sessions that resolve it (their own record or the default); the workspace text applies only to sessions whose `cwd` prefix-matches an enabled configured workspace (most-specific match wins); the group text applies only to sessions whose own id is listed in an enabled group (all matching groups concatenate in key order); the peer-inbox discipline text applies to every non-subagent session. Referenced files add their full content to the effective prompt and therefore consume additional tokens — a large referenced file meaningfully increases the per-request token cost. Identity text is clipped to 8000 chars as a token guard.

#### KV Cache effect

Each section's rendered text is a fixed part of the request prefix while its settings are unchanged. Editing a session identity or a global/workspace prompt (or editing / adding a referenced file) may invalidate provider cache reuse from the first changed token (same semantics as stock persona sections).

### Tool surface

`send_to_session`, `list_sessions`, `inbox_check`, `create_session`, `rename_session` and `search_sessions` are registered on the host plane and visible to every session (subagents inherit them through the standing preset composition). Their arguments and results are JSON-compatible. **All six are exposed to the model**, so `create_session`'s semantic consequence — creating one produces a real user message and consumes one model call — is model-visible. (`inbox_check` is read-only, has no side effects, and always targets the calling session itself; `search_sessions` is read-only too — it scans session logs and returns coordinates, writing nothing.)

---

## Compatibility

The plugin is verified against **DeepSeek Harness `dsh-v0.2.0-rc.1`** — its **minimum supported version** (**contract surfaces + the full gate suite, not a complete functional regression**; the declared dependency ranges, `^0.2.0-rc.1` for the harness packages and `^3.18.4` for schemastery, apply): 0.1.7 replaced the settings model (a plugin registering a namespace, read through `ctx.settingsScope.bind`) with entry `Config` `volatile` fields read through `ctx.configForms`, so the whole user-data surface moved (see [Settings fields](#settings-fields-volatile-parts-of-the-entry-config)). On 0.1.6 and earlier the client entry stays at `pending (waiting for service: configForms)` and `web boot` reports `Failed to load plugins` — a **loud failure** rather than a silent degradation; upgrade the harness or uninstall this plugin. The existing fallbacks for `interpolate: false` and `ctx.sessionController.resolveAgent` are unchanged.

- **Framework**: `@deepseek-ai/cordis` 4.0.4 and `@deepseek-ai/schemastery` 3.18.4 (the versions `dsh-v0.2.0-rc.1` vendors). The `@deepseek-ai/schemastery` floor is `^3.18.4`: `volatile()` exists only from 3.18.3, and earlier builds make the `Config` constructor throw. The plugin loads through the cordis harness and registers as a bundle via `dsh.bundle.patch`.
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

## Mechanisms and Red Lines

- **Identity injection** uses a single global section whose text provider resolves per agent — no per-agent registration, no lifecycle churn, real-time on settings change.
- **Frozen-config rule (red line)** — a `volatile` field's `ref.get()` returns a **`deepFreeze` snapshot** (immutable). Anything that edits it must **first `{ ... }` copy (and `.slice()` arrays)**: the host half hands the new value to `ctx.get('settings').update(...)`, the browser half hands it to the form's `set` / `mutate` (which submit by config path instead of replacing the whole section). Writing to the frozen object directly throws `object is not extensible` (this was the root cause of the "workspace list empty" bug fixed here). The same `{ ... }` copy rule applies on the client for `workspacePrompt.workspaces` writes (`onWsFilesChange` / `save` / `saveWsEnabled` / `removeWorkspace`).
- **Referenced files are read live and failures are skipped** — `readPromptFiles` runs inside the prompt `text()` on every assembly; a failing file never breaks assembly and its status is recorded into the in-process projection served by `GET /api/session-toolkit/state` and shown by the settings page.
- **Auto-resume never calls `dispose()`** — `AgentHandle.dispose()` removes the session from storage; turning a switch off only affects the next restart, it never takes a live session down.
- **Shadowing is cell-based** — the utilities entry re-registers the stock `session-log-download` cell at a lower priority; the stock entry abdicates gracefully if the shadow crashes.
- **Plain-text conversion** — `toPlainText` (10 rules, code-fence state machine, loose matching) runs at send time only; the message structure and `source: { kind: 'user' }` are unchanged.

---

## Known Limitations and Deferred Work

- Client half is a hand-maintained single-file IIFE bundle; adding a feature touches both `lib/` and `client/client.js`.
- **No gate covers identifier scope in the client half.** A block that calls `react.useState` must also call `require('react')`: `react/jsx-runtime` does not provide it, and a missing binding throws while the component renders. The slot renderer catches that throw and drops the entry, so the symptom is a button that is silently not there -- not an error anyone sees. This shipped from 2026-09-18 (`3e44642`, which added the hooks calls without adding the require) until 2026-09-22, through every gate.
- **A received peer message shows up as a collapsed row, not as a readable message.** `send_to_session` records the delivery with producer attribution — `source: { kind: 'agent-message', form: 'relay', senderSessionId }` — and the client renders every non-human source through its turn-trigger row, which is collapsed until you click it. Writing `kind: 'user'` instead would render inline like a human message, but would record another agent's words as the user's in the one field the V4 format made producer-owned. The attribution wins; click the row to read the body (it still names its sender in the first line).
- **Icon names are part of the integration surface.** DSH 0.1.7 renamed the `@deepseek-ai/dsh-client-ui-primitives` icons from `IconXxxOutline<size>` to `IconXxxOutlineRegular` / `IconXxxOutlineMedium` (1 px vs 1.3 px stroke; the artwork keeps the old default `size`), so the client half must use the **target harness's** names. A name that no longer exists evaluates to `undefined` and `React.createElement(undefined, …)` throws, which blanks that component's subtree **while its navigation entry still appears** (registration and rendering are separate). Every other gate stays green on this — syntax, packaging and the anchor gate all passed. The maintainers' gate for this compiles the list of members the plugin references and fails on any that the installed harness does not export.
- The relocated Session-log entry depends on the official `sessionLogDownload` controller interface **and** mirrors the 0.1.6 official surface (a "⋯ More actions" menu). It is a frozen replica: after a DSH upgrade the maintainers re-run a drift audit against the harness checkout, which inspects both sides for the same anchors and reports drift rather than passing silently. **Deliberate divergence:** the official header menu has since gained a second item (`feedback`); this replica carries download only. That is a decided state, not an open question — the drift gate reports it as a note rather than a failure because following a new upstream capability is itself a decision, and that decision was taken on 2026-09-22: **do not follow**. Re-open it only if the feedback entry is wanted here too.
- Loose emphasis matching in `toPlainText` can drop `*` pairs in non-format positions (e.g. `a * b * c`); acceptable for agent-generated messages, boundary tightening is optional.
- The aggregate `inject` union waits for every listed service; a profile missing one service delays the whole package (web profile provides all of them today).
- Harness-provided dependency ranges are prerelease unions; `pnpm install` must be re-run after changing them, and the resulting install should be checked with a dependency skew measurement against a live profile (expect `SKEW_COUNT=0`; `DE-INSTANCE` = same version, different instance, which is treated as acceptable). A measurement is only meaningful when the **host side is given explicitly**: a profile root is the root of an *installed dependency tree*, not the *running host instance* — a `--profile` run is a **self-consistency** measurement, labelled `HOST_BASELINE=PROFILE-SELF`, and its own output states that it does not constitute a conclusion about the running host.
- `ctx.get('agentDefaultModel')`, `sessionTitle` and `workspaceRegistry` are resolved lazily at call time and degrade to `cwd`/path addressing; `tools` and `webServer` are awaited through `ctx.inject` so a late-arriving service cannot silently disable a feature (the loader creates entries concurrently, so apply-time `ctx.get` had no ordering guarantee).
- **Referenced files are warmed on the assembly path** — `readPromptFiles` runs a `statSync` per referenced file on every assembly and reads only when `mtimeMs`/size changed; the per-file and total byte budgets prevent a huge file from blocking assembly or inflating the prompt, and the status projection is written only on change. On the client, `files` are saved immediately (`onWsFilesChange` / `save`).
- **UI knobs come from the same entry's `client.*`** — the browser half reads those fields through `configForms.get('session-toolkit')` and falls back to the frozen `UI_FALLBACK` when the form is unavailable. A client entry still receives no cordis row config, but reading settings no longer needs a host mirror: one entry `Config` is visible to both sides.
- **Minimum harness version is `dsh-v0.2.0-rc.1`** — the settings data plane became entry-`Config` `volatile` fields plus `configForms` in 0.1.7. On 0.1.6 and earlier there is no `configForms`, so the client entry stays `pending` and the web client reports `Failed to load plugins`; that is a deliberate loud failure (hard inject), not a silent degradation.

---

## Recovery

Uninstall the bundle: `dsh plugin --profile web remove dsh-session-toolkit`, then restart the GUI. To roll back to the pre-consolidation layout, re-enable the original plugins instead of installing this package.
