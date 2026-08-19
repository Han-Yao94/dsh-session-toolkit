# dsh-session-toolkit

> A unified plugin bundle for the DeepSeek Harness workbench · [中文 README](README.md)

Consolidates 6 standalone local plugins into one: session identity, global prompt, session auto-resume, web service restart, session log button reposition, and peer messaging between sessions.

## ✨ Features

| Feature | Description |
|---|---|
| Session Identity | Per-session persona injection (`systemPrompt` section) with an overlay editor and dual entry buttons (session header / input left), plus a per-session enable toggle |
| Global Prompt | Configurable via settings page, injected as a system prompt section, with `/\{+/g` consecutive-brace sanitize fix |
| Session Auto-Resume | Sessions with the toggle enabled are automatically `resume`d after a restart, with a filter chain, concurrency control and per-item failure isolation |
| Web Service Restart | One-click restart of the DSH web service from the settings page, zero-UAC spawn, with an overlay progress bar |
| Session Log Reposition | Shadows the official utilities download button and re-creates it in the actions slot, reusing the official controller |
| Peer Messaging | `send_to_session` / `list_sessions` tools plus a copy-session-ID button (dual entries) |

## 📦 Installation

1. Place this package under the DSH web profile's `node_modules`:

   ```powershell
   # Example: web profile under the user directory on Windows
   C:\Users\<user>\.dsh\profiles\web\node_modules\dsh-session-toolkit
   ```

   A junction to the source directory is recommended for development hot-reload:

   ```powershell
   cmd /c mklink /J "C:\Users\<user>\.dsh\profiles\web\node_modules\dsh-session-toolkit" "D:\path\to\dsh-session-toolkit"
   ```

2. Register the plugin in the profile's `cordis.patch.yml`:

   ```yaml
   - id: session-toolkit
     name: 'dsh-session-toolkit'
   ```

3. Restart the DSH web service (via the GUI settings page or the command line) to take effect.

> The original 6 plugin entries must be removed from `cordis.patch.yml` (or kept suppressed with `disabled: true`, as with the official `dsh-global-prompt`) to avoid duplicate registration.

## ⚙️ Configuration

All configuration is persisted to `settings.yaml`; namespaces are fully compatible with the pre-consolidation layout and existing data is preserved. Most changes apply live (`applies: 'live'`).

### Session Identity `session-identity`

```yaml
session-identity:
  default:
    enabled: true
    text: "You are..."            # default identity for sessions without a specific config
  sessions:
    "<sessionId>":
      enabled: true
      text: "Session-specific persona..."
```

Resolution priority: session record → default identity; non-`true` `enabled` or empty text → no injection. Single identity text is capped at 8000 chars (auto-truncated with a warning to guard token cost).

### Session Auto-Resume `session-auto-resume`

```yaml
session-auto-resume:
  sessions:
    "<sessionId>": true
```

Resume filter chain: toggle enabled + top-level session (not subagent, no `parentSession`) + non-blank (`seedLength !== 0`). Disabling the toggle only affects the next restart; it does not take the current session offline.

### Global Prompt `global-prompt`

```yaml
global-prompt:
  enabled: true
  content: "Your global prompt..."
```

## 🚀 Usage

- **Session Identity**: click the identity button in the session header actions or the input-left area; edit the session persona in the overlay, toggle it on/off; the identity is injected live on every request.
- **Auto-Resume**: after enabling the toggle in the session header, the session comes back online automatically after a DSH restart (max concurrency 3).
- **Restart Service**: click "Restart" on the settings page; the overlay progress bar tracks the restart, with a 90s timeout fallback.
- **Copy Session ID**: button in the session header actions or input-left area; copies the current session ID for use with `send_to_session`.
- **Peer Messaging**: call the `send_to_session` / `list_sessions` tools from any session to send or receive messages with other sessions.

## 🏗️ Architecture

- **Host side**: `lib/index.js` is the assembly entry, splitting functionality into 6 sub-modules (`lib/identity.js`, `lib/global-prompt.js`, `lib/auto-resume.js`, `lib/web-restart.js`, `lib/log-reposition.js`, `lib/peer-message.js`) with unified inject deps and per-module `safe()` failure isolation.
- **Client side**: `client/client.js` is a single inlined file (`__ModuleLoader__` resolves platform modules only), registering UI slots:
  - `settings.section`: global prompt (id `global-prompt`)
  - `settings.general.item`: restart service (id `web-restart`)
  - `conversation.session.header.actions`: copy ID (30) / identity (40) / session log (41)
  - `conversation.input.left`: identity (40) / copy ID (30)
  - `conversation.session.header.utilities`: shadow the official download button (id `session-log-download`, priority -1)

### ⚠️ Red Lines

- **Auto-resume never calls `dispose()`**: it would delete sessions from storage; disabling the toggle ≠ taking offline, it only affects the next restart.
- **Identity injection**: subagents (marked with `origin` / `delegationDepth`) do not get identity injected; consecutive `/\{+/g` braces are space-escaped to avoid being misparsed by the variable interpolator.

## 🗑️ Uninstall

1. Remove the `session-toolkit` insert entry from `cordis.patch.yml` (restore the original plugin entries to roll back).
2. Delete `dsh-session-toolkit` from the profile's `node_modules` (or remove the junction).
3. Restart the GUI to return to the pre-consolidation state.

## ⚠️ Known Limitations

- The client side is a single inlined file with feature modules separated by code comments; new features must be maintained in both `lib/` and `client/client.js`.
- The session log re-created button depends on the official `sessionLogDownload` controller interface; an official upgrade changing the interface requires sync (see comments in `lib/log-reposition.js`).
- Identity injection carries the identity text tokens on every request (consistent with persona / global prompt).

## 📄 License

[MIT](LICENSE)
