# AGENTS.md — Local Review (pi-web-ui fork) project guide

> This file is the project spec for AI coding assistants (pi / Claude Code / Cursor, etc.):
> structure, architectural conventions, development workflow, GitHub push and npm publish.
> After editing this file, run `/reload` in pi to pick up changes.

## 1. What this project is

This repo is a **pi-web-ui fork used internally as Local Review**. Upstream pi-web-ui is the
web chat UI for the pi coding agent (`@earendil-works/pi-coding-agent` SDK): talk in the
browser, browse the file tree, attach files, built-in terminal (xterm.js + node-pty), model
management, sound alerts. One command to run (`pi-web-ui`); deployable via Docker / systemd /
launchd / Windows scheduled tasks.

**Daily path for this fork:** `npm run dev` (Vite `:5173` + server `:8788`). UI copy is
English-only via `useT()` in `web/src/i18n.tsx`. Server notices are English. There is no
Chinese locale or language switcher.

- Repo (public upstream): `git@github.com:xing-shuyin/pi-web-ui.git`
- npm package: `pi-web-ui` (publisher npm account `xingshuyin`)
- Node requirement: **>= 22.19.0** (the pi SDK dist uses `import … with { type: "json" }`)
- Version: keep `package.json` and `package-lock.json` in sync

## 2. Tech stack

| Layer | Tech |
| --- | --- |
| Backend | Node + Express (static + `/api/health`) + `ws` (`/ws` WebSocket protocol) |
| Frontend | React 18 + Vite 6 + react-markdown + highlight.js + xterm.js |
| Agent | `@earendil-works/pi-coding-agent` SDK (in-process, reads `~/.pi/agent` config) |
| Terminal | node-pty (server-side PTY) + `@xterm/xterm` (browser render, forwarded via terminal bridge) |
| Styles | Single file `web/src/styles.css` (CSS-variable theme, dark) |

## 3. Directory layout

```
pi-web-ui/
├── server/                     # Backend (Node ESM, compiles to dist/server/)
│   ├── index.ts                # Entry: express static + /ws, message dispatch, heartbeat, graceful shutdown
│   │                           #   On win32 startup, prepend ~/.pi-web/bin to PATH + background ensureWindowsBash
│   ├── protocol.ts             # ★ Single source of truth: wire protocol types (client↔server messages)
│   ├── agent-service.ts        # Core: ClientSession (one session group per client, parallel conversations) + AgentService
│   │                           #   · Multi-conversation concurrency: convs Map<convId, Conversation>, each conversation
│   │                           #     has its own AgentSessionRuntime (new_chat no longer kills the old conversation;
│   │                           #     switch_conversation only swaps activeId; models share one ModelRuntime; message
│   │                           #     serialization cache is isolated per conversation; set_cwd switches to the target
│   │                           #     project's own conversation, no rebuild; "running conversations" list is per-project,
│   │                           #     a running conversation is listed only when displaced to background, and is removed
│   │                           #     only after it is opened and then left without continuing)
│   │                           #   · WebUIContext: bridges extension widget/status/dialog to the browser
│   │                           #   · Attachment build (inline/reference/lines modes)
│   │                           #   · readFile preview (512KB cap, binary detect, path-escape reject) → extracted to files-service.ts
│   │                           #   · File listing split by platform (readDirForUI, extracted to files-service.ts):
│   │                           #     win32 prefers stable+complete — ACL-protected dirs degrade to empty list + warning
│   │                           #     (does not crash the panel), follow directory symlinks/junctions, cap 2000 and
│   │                           #     report truncated; posix (mac/linux) keeps original logic (cap 500).
│   │                           #     IGNORED_ENTRIES is also per-platform: win only hides node_modules/.git/.pi-web/junk,
│   │                           #     dist/.next/venv etc. stay visible
│   │                           #   · Model admin / auth.json / models.json / session list / cwd switch
│   │                           #     (fetch_models: custom-provider form "auto-fetch model list" button → server
│   │                           #     probes the OpenAI-compatible /models endpoint at baseUrl (server-side request
│   │                           #     bypasses CORS; api type picks the auth header: openai→Bearer, anthropic→
│   │                           #     x-api-key, google→x-goog-api-key; authHeader=false sends no header; bare
│   │                           #     /models 404 falls back to /v1/models; 15s timeout; reqId echoed for concurrent
│   │                           #     matching). **Best-effort model metadata parse** fills the form:
│   │                           #     context_window/context_length/max_model_len→context, modalities/input_modalities/
│   │                           #     supports_vision/vision→text+image, reasoning/supports_reasoning→reasoning,
│   │                           #     display_name→display name, max_output_tokens etc.→max output; Google format
│   │                           #     {models:[…]} (strip models/ prefix from name + inputTokenLimit/outputTokenLimit)
│   │                           #     also supported; rows that already have an id only fill empty fields, keep
│   │                           #     hand-typed values); refresh_provider_models: one-click refresh of a saved
│   │                           #     provider on the list page — server probes with stored baseUrl/apiKey/headers
│   │                           #     (credentials never leave the server), merge semantics match the form
│   │                           #     (hand-typed wins + new ids appended), hot-update runtime; regression
│   │                           #     refresh-models-test); clone_provider: "copy as custom" — pack a built-in
│   │                           #     provider's baseUrl + model catalog into an editable draft
│   │                           #     (clone_provider_result returns UiProviderConfig, apiKey deliberately empty),
│   │                           #     for dual-key coexistence; suggested id auto-avoids taken ids (<pid>-2/-3…);
│   │                           #     api takes the majority type; no baseUrl (OAuth-style) is rejected; regression
│   │                           #     clone-provider-test
│   │                           #   · Per-client persist lastCwd + recent projects (<dataDir>/client-state.json,
│   │                           #     restore last working directory after restart; projects message pushes the list)
│   │                           #   · Edit-and-resend (edit_message): resolve message id → entryId → runtime.fork
│   │                           #     a new branch session (keep history before that question, original conversation
│   │                           #     untouched) → re-prompt; may include attachments (protocol v9, PromptAttachment
│   │                           #     shared with prompt) — fork strips that question's own attachment asides
│   │                           #     (persisted after that user entry, after the fork point); the browser resends
│   │                           #     original attachments (image imageData / uploaded file uploadPath / path
│   │                           #     path+mode, collected via question-attachments.ts, may be several) plus new
│   │                           #     pastes/files; server uses the same buildAttachmentMessages pipeline as prompt
│   │                           #     (uploadPath re-read from the uploads directory)
│   │                           #   · Self-update (check_update): read own package.json version, compare npm
│   │                           #     registry, push update_status; applying the update no longer goes through the
│   │                           #     server — frontend "Update now" reuses a visible terminal tab to run
│   │                           #     npm i -g pi-web-ui@latest (same pattern as SCM write ops); user then
│   │                           #     manually pi-web-ui server restart; before shutdown, still-streaming
│   │                           #     conversations are recorded in client-state.interrupted; next attach notices
│   │                           #     "last restart interrupted N tasks"
│   │                           #   · Goal review (goal): GoalBar above the input sets a goal (text + review model +
│   │                           #     max rounds + lock). Goal is bound to the conversationId at set time; each
│   │                           #     conversation independently triggers runGoalReview; multiple conversations can
│   │                           #     review in parallel; switching/creating a conversation never mis-reviews:
│   │                           #     an isolated ModelRuntime + createAgentSessionFromServices builds an in-memory
│   │                           #     review session (does not pollute the main session; can use a different model),
│   │                           #     fed "goal + final text + git diff HEAD" → parse {"verdict":"pass|fail","feedback"};
│   │                           #     pass clears the goal and inserts a ✅ card; fail and not yet at maxRounds
│   │                           #     injects the feedback as a user message into the main session to revise, then
│   │                           #     reviews again. Protocol: set_goal / clear_goal / goal_status (GoalStatus)
│   │                           #   · Review results are ordinary conversation messages (**no separate goal-review
│   │                           #     card**): both pass and fail go through mainSession.sendUserMessage injecting
│   │                           #     "verdict + goal + review feedback" as a normal user message (on fail with
│   │                           #     remaining rounds, that message is the steer that triggers revision).
│   │                           #     sendUserMessage rather than sendCustomMessage → the result also carries
│   │                           #     "goal mode released, respond to new instructions" semantics so the main
│   │                           #     agent does not stay stuck on the old goal and treat later instructions
│   │                           #     (e.g. "publish") as goal-confirmation echoes.
│   │                           #   · Goal discovery wizard (start_goal_wizard): user enters a raw requirement;
│   │                           #     backend starts an isolated discovery session (isolated ModelRuntime +
│   │                           #     in-memory session + custom tool goal_ask, bound to WebUIContext, reusing
│   │                           #     select/input dialog bridging to ask one question at a time, single-choice
│   │                           #     or free text; after convergence, parse the GOAL: marker as the final goal
│   │                           #     and set it). Triggered by GoalBar "AI distill" button; discovery and review
│   │                           #     are mutually exclusive on the current conversation only (during discovery,
│   │                           #     that conversation's agent_end review trigger is paused). Discovery progress
│   │                           #     cards land on the main session via sendCustomMessage (customType "goal-wizard").
│   │                           #     Protocol: start_goal_wizard + GoalStatus.wizard (WizardStatus)
│   │                           #   · Discovery cancel/timeout: each goal_ask races ui.select/input against an
│   │                           #     AbortController (wizardAbort) via Promise.race. Clicking ✗ (clear_goal) or
│   │                           #     idle timeout (WIZARD_IDLE_TIMEOUT_MS=5 min) or total duration cap
│   │                           #     (WIZARD_MAX_TOTAL_MS=20 min) all ac.abort(): cancel pending dialogs
│   │                           #     (WebUIContext.cancelPendingDialogs sends dialog_closed) → wizard.abort()
│   │                           #     stops the agent run → setGoal is not called (wizardCancelled flag,
│   │                           #     judged via ac.signal.aborted).
│   │                           #   · Rounds and preference memory: review maxRounds 0=unlimited (default, keep
│   │                           #     revising until pass), >0=capped (cap 50); discovery questions have no cap
│   │                           #     (self-converge, duration/idle timeouts as backstop). Model choice + rounds +
│   │                           #     lock persist via set_goal_prefs to client-state.json (stateStore.goalPrefs;
│   │                           #     attachSink re-pushes goal_status on reconnect, so refresh restores).
│   │                           #   · Settings panel (settings_state / set_settings / save_preset / apply_preset /
│   │                           #     delete_preset): opened from the top-bar ⚙, **sidebar-paginated layout**
│   │                           #     (`.settings-layout` = left `.settings-rail` nav + right `.modal-body`; only
│   │                           #     the active one of 9 group blocks is rendered: prompts / terminal / message
│   │                           #     display / skills / plugins / UI plugins / goal review / vision bridge /
│   │                           #     presets; tab icon + count badge; narrow windows (≤640px) collapse to an
│   │                           #     icon-only rail; modal has a fixed height (min(74vh,720px)); overflow scrolls
│   │                           #     only the right content pane; switching tabs scrolls back to top; long
│   │                           #     descriptions (settingsDesc) live in a "?" hover next to the title, not
│   │                           #     laid out in the body; `SettingsModal.tsx` `tabs` array is the only grouping
│   │                           #     config — new blocks must add id + label + a conditional render section).
│   │                           #     ① System prompt: append (append after the default prompt) or replace
│   │                           #     (full replace; project context / skill sections still auto-attach) — via
│   │                           #     resourceLoaderOptions systemPromptOverride + appendSystemPromptOverride
│   │                           #     (official hooks, replayed on every reload()); **replace-mode input is
│   │                           #     prefilled with the default prompt** (settings_state.defaultSystemPrompt =
│   │                           #     system-prompt file contents, falling back to the current session's effective
│   │                           #     full systemPrompt if no file); blur-saving unmodified default text as empty
│   │                           #     → server falls back to default (avoids baking in the full text and
│   │                           #     double-appending after switching back to append); ② Skill/plugin toggles:
│   │                           #     skillsOverride / extensionsOverride filter by name/source (npm spec or path);
│   │                           #     after session.reload() they immediately disappear from the system prompt,
│   │                           #     /skill: catalog, and extension commands; terminal-tools toggle
│   │                           #     terminalToolsEnabled (on by default, stored in presets): when off,
│   │                           #     applyTerminalToolGating uses session.setActiveToolsByName to drop
│   │                           #     terminal_* from the active set (tools stay in the registry) and stops
│   │                           #     sending TERMINAL_TOOLS_GUIDANCE; reload()/new sessions re-add custom tools
│   │                           #     to the active set, so gating must be replayed after create/reloadSession/
│   │                           #     /reload; ③ Goal review: review prompt and review-skill toggle are
│   │                           #     configurable separately in settings and do not pollute the main session;
│   │                           #     ④ Presets: store the current settings (main prompt/toggles + review
│   │                           #     prompt/skill toggle) as a named combo, one-click apply/delete. Settings live
│   │                           #     in client-state.json (stateStore.settings/presets, per client); known-list
│   │                           #     cache (knownSkills / knownExtensions) keeps disabled entries in the panel
│   │                           #     so they can be re-enabled; changing settings mid-stream does not reload
│   │                           #     immediately (would tear down a running run) — pendingSettingsReload applies
│   │                           #     after agent_end. Frontend imports protocol.ts via `export type *` in
│   │                           #     web/src/types.ts (single source, no manual sync).
│   ├── serialize.ts            # SDK message → UiMessage serialization (truncate, stable ids, object cache)
│   ├── text-sniff.ts           # File-preview pure functions: previewKind/looksLikeText/decodeText (UTF-8→GBK→latin1)/
│   │                           #   sniffImageMime magic-byte sniff/hexDump/countLines — extracted from agent-service, unit-tested
│   ├── process-utils.ts        # Process helpers: snapshotListeningPorts (bg-task detect)/killPidTree/lookupProcessName
│   ├── client-state.ts         # ClientStateStore: <dataDir>/client-state.json persist (recent projects/goalPrefs/
│   │                           #   settings/presets + extensionKey); all I/O best-effort, atomic writes
│   │                           #   (tmp+rename so a truncated JSON cannot wipe all state) — extracted from agent-service
│   ├── uploads.ts              # File-chat uploads: <dataDir>/uploads/<clientId>/ store (saveUpload) + retention cleanup
│   ├── bg-servers.ts           # Background-task tracking: port snapshot diff around bash + liveness refresh + stop one/all;
│   │                           #   best-effort process name + full command line per item (lookupProcessCommandLine:
│   │                           #   win32 PowerShell CIM / posix ps -o command=) for panel hover;
│   │                           #   decoupled from ClientSession via callbacks — extracted from agent-service
│   ├── settings-service.ts     # Settings-panel state machine: prompts/toggles/presets/vision-bridge prefs + knownSkills cache +
│   │                           #   pendingReload delayed apply; narrow host interface (SettingsHost) — extracted from agent-service
│   │                           #   (cleanupUploads/scheduleUploadCleanup, default 14 days, PI_WEB_UPLOAD_RETENTION_DAYS override)
│   ├── goal-service.ts         # Goal / review loop / discovery wizard: setGoal/clearGoal/setGoalPrefs + runGoalReview
│   │                           #   (isolated review session) + startGoalWizard (goal_ask one question at a time); narrow host
│   │                           #   (GoalHost + structured GoalConversation subset) — extracted from agent-service
│   ├── slash-commands.ts       # Slash commands: NATIVE_COMMANDS intercept+exec + catalog push (built-in/extension/
│   │                           #   template/skill); narrow host SlashHost
│   ├── model-admin.ts          # Model/provider config: auth.json key I/O, models.json CRUD,
│   │                           #   fetch_models endpoint probe (OpenAI-compatible + Google format + /v1 fallback),
│   │                           #   refresh_provider_models, clone_provider (built-in→custom draft, dual-key coexistence);
│   │                           #   narrow host ModelAdminHost
│   ├── attachments.ts          # Attachment build: inline/reference/lines, imageData, fileData to disk + vision-bridge wiring;
│   │                           #   buildAttachmentMessages(ctx, attachments) + parseModelSpec — extracted from agent-service
│   ├── webui-context.ts        # Extension UI bridge: WebUIContext (widgets/statuses/dialog → browser messages;
│   │                           #   TUI-only capabilities are lazy no-ops) — extracted from agent-service
│   ├── themes.ts               # Theme management: listThemes(builtinDir, userDir) merges built-in + user themes,
│   │                           #   resolveThemeFile maps id → file path (user dir wins);
│   │                           #   id must match ID_RE (^[A-Za-z0-9_-]+$) to prevent path traversal
│   ├── plugins.ts              # Optional UI-component plugins: scan <dataDir>/plugins/<id>/ (manifest.json +
│   │                           #   index.mjs server entry + client/entry.mjs view entry); re-scan on attach and
│   │                           #   dynamically import to activate new dirs; scan() best-effort reads .pi-source.json
│   │                           #   (install source written by CLI install) → UiPluginInfo.source, used by the
│   │                           #   settings-panel "Update" button; narrow host PluginHost (broadcast/onMessage/
│   │                           #   dir/dataDir/cwd/log; **cwd is a live value**: after any client set_cwd succeeds,
│   │                           #   AgentService.onClientCwdChanged → PluginManager.notifyCwd updates and fans out
│   │                           #   onCwdChange hooks, idempotent de-dupe, exception-isolated); plugin_message uplink
│   │                           #   routing, plugin_data broadcast;
│   │                           #   host facilities (plugin-facilities.ts): storage (<pluginDir>/storage.json atomic KV)
│   │                           #   + secrets (AES-256-GCM encrypted secrets, key <dataDir>/secrets.key, fail-closed
│   │                           #   if the machine is copied) + ensureDeps (single-flight auto npm install);
│   │                           #   registerCommand slash commands (SlashCommandInfo source=plugin → picker + prompt
│   │                           #   intercept; string return values echo as notice; re-push catalog after attach to
│   │                           #   avoid first-load races); host.route mounts HTTP routes (/plugins-api/:id/*,
│   │                           #   index.ts catch-all forwards to handleHttp, inherits main-site token auth;
│   │                           #   handler throw → 500, does not crash the process); manifest apiVersion >
│   │                           #   PLUGIN_API_VERSION refuses activation and prompts to upgrade;
│   │                           #   **capability declaration and enforcement** (manifest.permissions): if present =
│   │                           #   strict mode; host-controlled APIs (registerAgentTool→tools / route→http /
│   │                           #   host.fs→fs) are gated by declared families; undeclared families are refused
│   │                           #   with "which family is missing"; absent and apiVersion<2 = legacy full access
│   │                           #   (allowed but warned once per activation; v2 default-deny is already wired);
│   │                           #   host.fs = WorkspaceFS (plugin-facilities, restricted workspace file access:
│   │                           #   paths anchored at the live cwd root, out-of-tree rejected — this is the layer
│   │                           #   the host actually enforces; native fs/net in dependencies cannot be intercepted,
│   │                           #   declaration is informed consent); first install / capability change compares
│   │                           #   sha256 via a .pi-approved marker and pushes one reminder notice (quiet otherwise);
│   │                           #   host.registerBackgroundTask: plugin long-lived tasks (pollers/pools) join the
│   │                           #   top-bar "Background tasks" panel (BgServer gains taskId/plugin/status; port/pid
│   │                           #   become optional); kill_background_server {taskId} fires the stop callback and
│   │                           #   removes the item (does not kill a process tree — the task lives in the host
│   │                           #   process); update() refreshes status; deactivate/dispose auto-stops tasks so no
│   │                           #   orphan timers remain;
│   │                           #   **MCP tool bridge** (server/mcp-bridge.ts): read <dataDir>/mcp.json and start
│   │                           #   external MCP servers (stdio, newline-delimited JSON-RPC, zero third-party deps;
│   │                           #   {servers:{name:{command,args,cwd,env}}}), handshake initialize→initialized→
│   │                           #   tools/list→tools/call then adapt each remote tool into a PluginAgentTool
│   │                           #   (name normalized via sanitizeToolName) and fold into plugin.d.ts
│   │                           #   pluginToolsProvider (same customTools pipeline as plugin tools, injected via
│   │                           #   applyPluginAgentTools); single-server failure is isolated (rejectAll + log,
│   │                           #   does not crash the process); dispose kills the child; requests matched by id
│   │                           #   + timeout watchdog; structuredContent/text content results returned faithfully;
│   │                           #   server-initiated notifications (log) are recorded only. Tests: unit mcp-bridge
│   │                           #   + mcp-bridge-test E2E (fixture tests/fixtures/mcp-echo-server.mjs, tools
│   │                           #   echo/add/fail/slow)
│   │                           #   **Declarative settings** (manifest.settings schema → ⚙ panel auto-renders a form):
│   │                           #   UiPluginSettingField (text/password/number/boolean/select + default/min/max/
│   │                           #   options/hint); values stored under the settings key in <pluginDir>/storage.json
│   │                           #   (defaults merged, atomic write, plugin-owned keys preserved); plugin_settings
│   │                           #   save → validate (out-of-range/bad option rejected) + notify plugin
│   │                           #   onSettingsChanged + re-push catalog echo; host.getSettings() reads live
│   │                           #   onMessage async handler 30s timeout guardrail (log and drop)
│   │                           #   resolvePluginClientFile serves /plugins/:id/client/* statically (only the
│   │                           #   client/ subtree is exposed; manifest and server code never leave the machine);
│   │                           #   activation failure is recorded in the error field and does not crash the host
│   ├── vision-bridge.ts        # Vision bridge: when the text-only main model has no vision, hand images to a configured vision model and transcribe them into textual evidence
│   ├── files-service.ts        # File service: extracted from agent-service (file-tree listing readDirForUI / readFile
│   │                           #   preview R/W / path complete / directory and git-dir watcher / global search searchFiles —
│   │                           #   recursive filename match, skip IGNORED_ENTRIES, triple cap on results/visits/time
│   │                           #   so large repos cannot stall); IGNORED_ENTRIES is maintained here, per platform;
│   │                           #   decoupled from ClientSession via FilesHost callbacks
│   ├── scm.ts                  # SCM read-only git queries: execFile("git") direct (no shell),
│   │                           #   status/branches/history/filediff/commit parsed into structured JSON
│   ├── review/                 # Local Review: parsed git diff, `.local-review/` store at the git
│   │                           #   toplevel (subdir cwd still reads/writes the same artifacts),
│   │                           #   WS handlers (review_diff/submit/apply/set_status), agent tools
│   │                           #   (local_review_pending / local_review_mark_applied). Status
│   │                           #   pending → applied | dismissed. entry.dir is contained under
│   │                           #   `.local-review/`. Unit tests: tests/unit/review-*.test.ts
│   ├── patch-node-pty.ts       # node-pty × Node --watch compatibility self-heal patch (must import before node-pty; see §4 Terminal)
│   ├── ensure-bash.ts          # Windows lightweight bash fallback: auto-download busybox-w32 when Git Bash is absent
│   ├── control-socket.ts       # Local control socket (status / quiesce / unquiesce): POSIX mode-0600
│   │                           #   unix socket (<dataDir>/pi-web-ui.sock) / Windows named pipe
│   │                           #   (\\.\pipe\pi-web-ui-<port>); JSON-line protocol, 5s idle timeout; CLI uses it
│   │                           #   for live status and toggling drain mode; no network port, no HTTP admin endpoint
│   │                           #   (single exe ~660KB, including bash/iconv/sh/timeout) to ~/.pi-web/bin/bash.exe
│   │                           #   (busybox dispatches applets by argv[0]); download failure silently falls back to cmd
│   └── terminals.ts            # TerminalManager (persistent PTY per conversation + incremental output/key tools) + .pi/commands.json R/W;
│                               #   exports TERMINAL_TOOL_NAMES / TERMINAL_TOOLS_GUIDANCE (system-prompt guidance on when
│                               #   to use the terminal instead of bash; agent-service injects it when terminalToolsEnabled)
├── web/                        # Frontend (React + Vite, compiles to web/dist/)
│   ├── vite.config.ts          # Dev port 5173, /ws proxied to the backend
│   ├── src/
│   │   ├── App.tsx             # Top-level layout: TopBar / LeftPanel / MessageList / ChatInput /
│   │   │                       #   RightPanel / FooterBar / Dialog / modals / FilePreview /
│   │   │                       #   view switch chat | terminal | git (source control)
│   │   ├── use-chat.ts         # ★ useChat(): WebSocket connection, reducer state machine,
│   │   │                       #   terminal-output bridge (isolated by conversationId; buffer output until the terminal is mounted)
│   │   ├── types.ts            # ★ Wire-protocol re-export shim (`export type * from "../../server/protocol"` + frontend-local types)
│   │   ├── i18n.tsx            # ★ English UI copy; every user-visible string goes through useT()
│   │   ├── styles.css          # ★ All styles (sectioned by component, commented separators); also the default dark-theme body
│   │   ├── theme.ts            # Theme switch: /api/themes list + localStorage persist +
│   │   │                       #   applyTheme() injects <link id="theme-stylesheet"> whole-file replace
│   │   │                       #   (each theme = a full independent copy of styles.css, not variable overrides; null = default dark)
│   │   │                       #   buildTermTheme() reads --term-* CSS variables → xterm canvas theme;
│   │   │                       #   after switch, dispatch pi-web-ui:theme-change so TermXterm hot-updates the canvas
│   │   ├── sounds.ts           # WebAudio notification sounds
│   │   ├── download.ts         # Downloads: downloadFile (fetch→blob→objectURL, bypasses Chrome
│   │   │                       #   Safe Browsing blocking of HTTP downloads; errors are readable; in a Chromium
│   │   │                       #   secure context prefer showSaveFilePicker — the workaround when Windows still
│   │   │                       #   silently intercepts blob downloads), Windows auto-sanitizes illegal save names
│   │   ├── message-delta.ts    # message_delta incremental patch (pure, immutable, StrictMode-safe), unit-tested
│   │   ├── lazy-window.ts      # Message-list lazy-windowing pures: planWindow / applyPlan / pickAlways / estimateMessageHeight, unit-tested
│   │   ├── search-text.ts      # In-session search index pures (zero-dep structured type mirror), unit-tested
│   │   ├── skill-block.ts      # parseSkillBlock: <skill> block parse (mirrors SDK regex), unit-tested
│   │   ├── auth-token.ts       # PI_WEB_TOKEN injection (localStorage + cookie), unit-tested via initAuthToken
│   │   ├── image-paste.ts      # Pasted images scaled ≤1568px + PNG/JPEG transcode (payload ≤2MB)
│   │   ├── uuid.ts             # randomUuid (crypto fallback), unit-tested
│   │   ├── protocol-version.ts # Protocol version constant (paired with the same-named file under server/; check:protocol asserts they match)
│   │   ├── main.tsx            # Entry: apply theme before first paint to avoid flash + initAuthToken
│   │   └── components/         # See below
│   └── dist/                   # Build output (gitignore, but packed into the npm package)
├── bin/pi-web-ui.mjs           # CLI: foreground start (opens browser when ready; --no-browser to disable) / --port --cwd --data-dir / server install|uninstall|start|stop|restart|status
#                             / install <source>|plugins|uninstall <id> (UI plugin management: install from GitHub or a local
#                               dir into <dataDir>/plugins/; source supports owner/repo, full URL (/tree/branch/subdir),
#                               #branch suffix; git clone --depth 1 first, fall back to codeload tarball + system tar;
#                               after install write the original source to <pluginDir>/.pi-source.json (settings-panel
#                               "Update" re-runs the same install --force; config.json is kept across upgrades);
#                               plugin-updater.ts: before overwrite-install, auto-backup the old version to
#                               <dataDir>/plugin-backups/<id>-<ts>/ (keep the latest 3, including .pi-backup.json);
#                               copy failure auto-rolls back; success path records the remote sha (.pi-git-sha,
#                               git ls-remote HEAD — local git-repo sources also work, fully offline);
#                               plugins --check-updates compares shas one by one and lists updatable plugins;
#                               plugins --rollback <id> restores the latest backup; async paths that fail must
#                               throw + exitCode — never process.exit, which can trip a win32 libuv assert crash)
│                               #   (macOS→launchd, Linux→systemd, Windows→schtasks scheduled task, hidden window)
├── themes/                     # Built-in themes (full independent CSS files, shipped in the npm package; light.css/white.css/md-preview.css generated by make-light-theme.mjs; first line /* theme-name: x */ supplies the display name)
├── make-light-theme.mjs        # Theme generator: styles.css → light.css (soft purple) / white.css ("White": pure white + blue) / md-preview.css ("Purple glow": dark + full-window purple radial glow, chrome translucent) (re-run after styles.css changes)
├── future-work/                # Shelved: VS Code/Cursor extension and host-agnostic package split (current product is the pi-web Review page)
├── tests/                      # All test scripts (self-contained: isolated port ≥8900 + temp data-dir, self-cleanup)
│   ├── run-smoke.mjs           # Zero-token protocol smoke aggregator (shared by local and CI; `npm run test:smoke`)
│   ├── unit/                   # vitest pure-function unit tests (millisecond, zero deps; `npm test`):
│   │                           #   message-delta / skill-block / terminal-key / text-sniff / uploads / search-text
│   │                           #   + attachments (buildAttachmentMessages edit-and-resend restore: upload:true marker /
│   │                           #     uploadPath disk re-read / out-of-tree reject / cleaned skip / workspace-path re-attach)
│   │                           #     + question-attachments (frontend original-attachment collect pures: image imageData /
│   │                           #     uploaded file uploadPath / path path+mode)
│   ├── *-test.mjs              # Hand-written Playwright E2E / WS protocol tests (browser path hardcoded via HEADLESS)
│   └── scratch/                # One-off debug scripts (gitignore, not committed)
├── scripts/check-protocol-sync.mjs  # Guards the types.ts shim single-source mechanism + protocol.ts type-only constraint (required in CI)
├── .github/workflows/ci.yml    # CI: protocol sync → typecheck → build → vitest → smoke
├── extensions/                 # pi extension: webui.ts (/webui starts the local server and opens the browser), shipped in the npm package
├── assets/                     # README screenshots
├── dev/                        # Local development helpers (not in the npm package)
└── tsconfig.server.json / tsconfig.extensions.json / tsconfig.tests.json / web/tsconfig.json
```

`web/src/components/` at a glance:

| Component | Role |
| --- | --- |
| `FilePreview.tsx` | File-preview modal: line numbers, click/drag/Shift range, add to conversation (lines attachments); Markdown rendered by default, switchable to source; text files can be edited and saved via an edit toggle that is off by default |
| `LeftPanel.tsx` | Left pane: recent projects (click to switch cwd; hover ✕ two-step confirm to remove — only deletes the client-state entry + a tombstone so session scans cannot refill) + running conversations (shown when ≥1; active highlighted, streaming green dot, filtered to the current project; pinned above history with its own scroll) + conversation history (title does not scroll with the list; hover ✕ two-step confirm delete — server checks the path is inside `<agentDir>/sessions/` and not used by any live conversation before truly deleting the file; protocol `remove_project` / `delete_session`; regression left-panel-delete-test) |
| `RightPanel.tsx` | File-tree browse (`list_files`; truncation notice when a directory is too large); click a filename → preview; 📎/🔗/👁 attach buttons; server watcher is two-tier: win32/darwin open a native recursive `fs.watch(root, {recursive:true})` on the **workspace root** (changes in deep unlisted dirs also push `file_changed` → silent re-list; filter node_modules/.git event storms; a single-segment filename with no "/" must not `slice(0,-1)`); other platforms fall back to per-directory non-recursive watch + 10s poll |
| `ChatInput.tsx` | Input + attachment chips (inline/reference/lines, three colors); **the whole window is a drop target (issue #19)**: App root onDragOver/onDrop receives file drops, full-screen `.app-drop-overlay` highlight, drop anywhere to attach; the input bar/editor handlers stopPropagation to keep priority; while a reply is in progress a "Queue" button is shown (**followUp queue** — send only after the entire run finishes generating; does not interrupt and does not skip tools; distinct from Enter/Send **steer** cut-in: inject as soon as the current turn's tools settle, skip remaining tools, agent responds immediately — pi CLI Enter-interrupt semantics; frontend distinguishes via `prompt.queue=true`); queued/steering message text is pushed in the snapshot `queue: {steering[], followUp[]}` and rendered at the bottom of MessageList as pending bubbles (dashed border + label), replacing the old count hint + "Stop"; **slash commands**: typing `/` opens the command picker (built-in/extension/template/skill tags, ↑↓ + Enter/Tab complete, Esc close); `/help` opens the command-list modal, `/copy` copies the last assistant reply (pure client); built-in commands (/new /model /compact /cwd /thinking /resume /reload /pi-web-ui:quit) are intercepted by server `AgentService.prompt()` (/help /copy handled client-side, server swallows them as a fallback so they are not passed through); extension/skill/template commands pass through to SDK prompt (SDK expands them natively); unknown `/xxx` is sent as ordinary text |
| `Message.tsx` / `MessageList.tsx` | Message render: attachment cards (`stripFileWrapper` peels `<file>` wrappers), streaming cursor, tool-result association; **edit-and-resend keeps original attachments (images + files + paths, several allowed, issue #18)**: pure `collectQuestionAttachments` in `web/src/question-attachments.ts` collects the custom "file" cards immediately after each question — ① image blocks restore to imageData attachments (including vision-bridge thumbnails); ② uploaded-file cards (`details.upload: true`, see `pushUploadAside` in attachments.ts) restore to `uploadPath` attachments — server `buildAttachmentMessages` checks the path is inside `<dataDir>/uploads/<clientId>/` then re-reads bytes from disk (no repeated base64, no snapshot bloat); if the file was cleaned by retention, skip with a notice; ③ workspace-path attachments (inline/reference/lines/folder) restore to `path+mode(+lines)` and resend. The editor renders all three as removable chips (image thumbnail / 📄 file / 📎 path) and supports paste/drop of new images and drop of new files (20MB cap), resent through the full attachment pipeline via `edit_message.attachments` (fork strips the original asides, so they are not duplicated); `/skill:name` expanded `<skill>` blocks render as collapsible skill cards (`parseSkillBlock` in `web/src/skill-block.ts` mirrors the SDK regex; collapsed shows `[skill] name`, expanded shows the full SKILL.md; the user's own args render separately; edit-and-resend rebuilds `/skill:name args`; question navigation uses args, not skill body); after 30 messages, older ones collapse to summary rows (`CollapsedMessage`, lazy render, click to expand; constants `KEEP_RECENT`/`COLLAPSE_MIN` at the top of MessageList); **recent-segment lazy windowing**: heavy messages outside the viewport ±1200px buffer are replaced with equal-height placeholder divs (`LazyMount` + pures in `web/src/lazy-window.ts`); scrolling nearby swaps them back in the same frame and compensates scrollTop (`.messages` has `overflow-anchor` off to prevent double-jump); the sticky bottom region is truncated from the end by a 1600px height budget — a single giant message cannot blow through the sticky region; placeholders keep `data-msg-id` so question navigation/jump/search are unaffected; jump targets and open search force full render; **dual-channel question navigation**: right-side floating `.qn-rail` (hover reveals a question-text chip; with many questions the `.many` variant becomes a scrollable `.qn-list` panel, hide immediately on leave with no delay) + a persistent `.qn-tag` at the right of each question header (bar + index, click to jump, on-screen question highlighted); **streaming body uses `StreamMarkdown`** (prefix-cached render; split in `web/src/stream-markdown.ts` + unit tests): frozen paragraphs are each memoized and parsed once, the active tail is re-parsed throttled, unclosed fences stay plain text without highlight, after persist switch back to a one-shot full `Markdown` authoritative render — eliminates O(n²) full re-parse on every delta |
| `ToolCallBlock.tsx` / `ThinkingBlock.tsx` / `BashBlock` | Tool-call cards, thinking blocks, bash output |
| `TerminalPanel.tsx` / `TermXterm.tsx` | Terminal view + xterm instance bridge |
| `SCMPanel.tsx` | **Source control (Git) view**: status/branch/diff for the current cwd; commit/switch-branch/push/pull buttons reuse the terminal bridge to run commands in a visible terminal (auto-switch to the terminal view); read-only queries go through **server execFile** (`scm_status` / `scm_filediff` / `scm_commit` → structured JSON `scm_data`, matched by reqId) |
| `TopBar.tsx` / `FooterBar.tsx` | Top bar (model / thinking level / background tasks / sound / new conversation / view switch), footer (context / cost / working directory) |
| `Dialog.tsx` | Extension `ui.select/confirm/input` → browser modal |
| `ModelConfigModal.tsx` / `PiSetupModal.tsx` | models.json admin / first-run setup |
| `SettingsModal.tsx` | Settings panel (**sidebar pagination**: 9 left-nav groups, only the active group is rendered, narrow screens collapse to an icon rail): system prompt (append/replace + text, apply on blur), skill/plugin toggles (immediate), **terminal-backed bash toggle + silent-to-background idle threshold**, presets (save/apply/delete the current combo), uninstall of `pi install` plugins (two-step confirm → visible terminal tab runs `pi remove npm:<pkg>`; after exit the frontend sends `extensions_reload` to rediscover the list), **UI-plugin update/uninstall** (update = when `.pi-source.json` source exists, run `pi-web-ui install <source> --name <id> --force` in a visible terminal, keeping config.json; uninstall = two-step confirm → `pi-web-ui uninstall <id>`; after the command tab exits, an App observer sends `plugins_reload` to re-scan the catalog) |
| `GoalBar.tsx` | Goal bar above the input: set goal (text + review model + rounds + lock) / clear / AI distill (discovery wizard) / rounds dropdown |
| `ReviewPanel.tsx` / `ReviewChip.tsx` | Local Review: comment on a parsed git diff; submit writes `.local-review/reviews/<id>/` (append-only). Status is `pending` until **Mark applied** / `local_review_mark_applied` or **Dismiss**. The chat chip lists pending counts; Apply in chat injects them as a prompt. |
| `BgTasksModal.tsx` | Background-tasks modal: list of AI-started listening-port processes (full command line: single-line ellipsis by default + hover tooltip, click to wrap); stop one / stop all / refresh |
| `ModelThinking.tsx` | Model + thinking-level dropdown (reused by TopBar; only levels the current model actually supports; model dropdown has a search filter at the top, matching name/provider/id) |
| `GlobalSearchModal.tsx` | Global-search modal (top-bar "Search" / Ctrl+K): one input searches history conversations (client-side filter of firstMessage/name, click switch_session), recent projects (click set_cwd), and workspace filenames (server search_files, reqId match to avoid cross-talk, click opens file preview); ↑↓/Enter navigate |
| `PluginView.tsx` | Plugin-view host: thin React shell hands a DOM container + narrow context to the plugin bundle's mount(); switching away only hides, does not unmount (plugin state is kept); companion `web/src/plugin-loader.ts` (dynamic import `/plugins/<id>/client/entry.mjs`, registry, plugin_data fanned out via window CustomEvent) |
| `CollapsedMessage.tsx` / `LazyMount.tsx` | Collapsed summary rows for messages beyond 30 (lazy render, click to expand); LazyMount: per-message lazy-mount wrapper — when hidden, render an equal-height placeholder that keeps `data-msg-id`; on show, measure height in a layout effect and compensate scrollTop for the delta above the viewport |
| `SearchBar.tsx` | In-session search bar (Ctrl+F / Cmd+F, browser-find style): hit count n/m + prev/next + Esc to close; index via pures in `web/src/search-text.ts`; **inline highlight uses the CSS Custom Highlight API** (`CSS.highlights` + `::highlight()` builds Ranges on text nodes, does not invade the react-markdown tree; unsupported browsers degrade to jump + message flash); flushSync-expand collapsed old messages before jumping; clear the highlight registry on close |
| `Markdown.tsx` / `Dropdown.tsx` / `copy-button.tsx` / `SoundSettings.tsx` | Shared pieces |

## 4. Core architecture (read before changing code)

### Snapshot-driven

- **The server is the single source of truth**: after every SDK event, a snapshot (`UiState`) is
  pushed throttled at 60ms; the browser only renders from snapshots. Reconnect just resends
  `get_state`.
- **Incremental snapshots (protocol v2)**: persisted message content is immutable + object
  references are stable; `emitSnapshotNow` walks with O(n) pointer identity to detect
  append-only growth — if appendable, send `snapshot_delta` (light fields + `appended` tail,
  baseRev chain); mid-stream mutation / truncation / conversation switch / forced resync fall
  back to a full `snapshot`. The frontend reducer merges along the rev chain; a gap triggers
  a debounced `get_state`; under backpressure, delta and snapshot are equally droppable;
  lost packets self-heal via a broken rev chain. `get_state` always returns a full snapshot.
  Regression: `snapshot-delta-test`.
  **Test adaptation**: tests waiting for a "post-action snapshot" must also accept
  snapshot_delta (see the rev-chain merge in conv-cwd / vision-bridge); the first snapshot
  after connect is always full.
- **WS permessage-deflate**: WebSocketServer enables compression (threshold 16KB); multi-MB
  snapshots of large sessions shrink several times on the wire; small messages (notice /
  heartbeat) stay uncompressed to save CPU.
- **Multi-tab serialization sharing**: emit sends the same message object to every socket of
  the client; index.ts caches stringify results in a WeakMap keyed by object identity — N
  tabs share one serialization; a new snapshot is a new object and invalidates automatically.
- Serialization keeps **stable object references**: `uiMessageCache` + message-array signature
  compare; if messages did not change, the array is not rebuilt, so frontend `React.memo` can
  skip whole messages — **do not** break this cache (stable ids, reference reuse).
- `UiState` carries `thinkingLevel` (currently in effect) and `availableThinkingLevels` (levels
  the current model actually supports; the SDK silently clamps requests outside the set — the
  UI must only enable these, otherwise clicking "low/medium" looks like it "won't change").
- **`message_delta` real-time incremental channel**: `message_update` event → push
  `message_delta` only for the **active conversation** (`conversationId` + per-conversation
  monotonic `seq` + `messageId = stream-<ts>` (matches the stable id from
  `serializeStreamingMessage`) + live usage + thinking/text delta with `partial` stripped).
  It **does not go through the snapshot channel** — `send()` backpressure only drops
  snapshots; increments are always reachable, so large sessions no longer stall under
  backpressure. Frontend `applyMessageDelta` (`web/src/message-delta.ts`, pure, immutable —
  StrictMode double-invoking the reducer would double in-place mutation) patches
  `streamingMessage` + `stats.tokens`; a seq gap triggers a debounced `get_state` resync;
  snapshot is the authoritative converge. Meanwhile: while deltas are active (an increment
  within 1.5s) snapshots degrade to **event-driven checkpoints** — agent_end /
  tool_execution_end flush immediately, other events use a 2s fallback timer (increments
  own smoothness; snapshots only calibrate boundaries). Unit tests:
  `tests/unit/message-delta.test.ts`.
- **`tool_delta` same protocol**: also carries `conversationId` + `seq`, sharing the same
  per-conversation monotonic sequence (`conv.deltaSeq`); frontend tracks seq in a per-
  conversation Map; only an active-conversation gap triggers resync (background
  conversations converge via snapshot when switched back).
- **Protocol version negotiation**: `hello` may include `protocolVersion`; `ready` echoes the
  server version; on mismatch the frontend shows a persistent refresh banner (guard against
  mixed "new UI / old WS" after an in-place app update). Constants live in a
  protocol-version.ts under both server/ and web/; `check:protocol` asserts they match —
  bump both when changing the protocol.

### Protocol single source (`types.ts` is a re-export shim; no more hand-sync)

`server/protocol.ts` is the only source of truth; `web/src/types.ts` re-exports it in full
with `export type * from "../../server/protocol"` (types only, erased at build); frontend-local
types (FileContent/FileListing/ToolStatus) sit below the shim.
Add/change any message: edit only `protocol.ts`, then add a branch in both the
`dispatch` switch in `server/index.ts` and the `onmessage` switch in `web/src/use-chat.ts`.
`protocol.ts` must stay **type-only exports** (no const/function runtime code, or the
type-only premise breaks); `npm run check:protocol` guards both invariants.

### Three attachment modes (`ClientMessage.prompt.attachments[].mode`)

### Security boundary (loopback / Origin check / quiesce / credential isolation)

- **Bind loopback by default** (`PI_WEB_HOST`, default `127.0.0.1`): a local personal tool
  is not exposed to the network; LAN access requires an explicit `PI_WEB_HOST=0.0.0.0`.
- **WS upgrade does Origin/Host same-authority check** (`originAllowed` in `server/index.ts`,
  `WebSocketServer({ noServer: true })` + manual `handleUpgrade`): when Origin is present,
  its hostname + **effective port** must match the request Host (in a browser,
  `example-host:8445` and `example-host:9443` are different origins); non-browser clients
  (no Origin) are allowed; `PI_WEB_ALLOW_ORIGINS` whitelist bypasses (dev:server already
  includes `http://localhost:5173,http://127.0.0.1:5173`; configure for reverse-proxy
  setups); `PI_WEB_ALLOW_HOSTS` is an optional strict hostname whitelist. **Do not** put
  back "any local port is allowed" — that is exactly the hole the proposal was fixing.
- **quiesce admission control** (`AgentService.quiesce/unquiesce`): once draining,
  **refuse all new work** — new prompt (native slash commands excepted: pure config, no
  tokens), new_chat, edit_message fork, switch_session, goal wizard; in-flight runs finish.
  Known clientIds may still attach to watch in-flight work (a notice is sent);
  **a brand-new client attach throws `QuiesceRejectedError` → index.ts closes the WS with
  4403**; the browser reconnect loop recovers automatically after unquiesce.
- **Control socket** (`server/control-socket.ts`): CLI `server status|quiesce|unquiesce`
  talks to the running process over a local mode-0600 unix socket / Windows named pipe
  (`\\.\pipe\pi-web-ui-<port>`); `status` reports real socket counts (`noteSocketOpen/Close`,
  maintained in index.ts), active/pending counts, quiesce state; no authenticated HTTP
  endpoint.
- **Provider headers never go to the browser** (`models_config` no longer carries a
  `headers` field, which may contain Authorization/API key): `saveModelConfig` keeps the
  old value (`prevHeaders`) when the incoming config has no headers.
  `UiProviderConfig.headers` was removed from protocol.ts / types.ts; the frontend never
  edits headers (only apiKey goes through the browser, via the separate
  `set_provider_api_key` message).
- **Dev compatibility**: when vite :5173 proxies /ws to :8788, Origin(:5173) ≠ Host(:8788);
  `PI_WEB_ALLOW_ORIGINS` (built into dev:server) allows it — do not remove.

### Theme switching (whole-file style replace; no variable extraction)

- **Mechanism**: each theme = a **full independent copy** of `web/src/styles.css` (different
  palette), not CSS-variable overrides. The default dark theme is still the bundled
  `styles.css`; picking another theme injects
  `<link id="theme-stylesheet" href="/themes/<id>.css">` as a whole-file override; picking
  default again removes that link (`applyTheme` in `web/src/theme.ts`, localStorage key
  `pi-web-ui:theme`, applied in `main.tsx` before first paint to avoid flash).
- **Server**: `GET /api/themes` lists themes (`listThemes` in `server/themes.ts`);
  `GET /themes/:id.css` serves the file (`resolveThemeFile`, user dir wins). id must match
  `ID_RE` (`^[A-Za-z0-9_-]+$`) to prevent path traversal. Both routes are registered in
  `server/index.ts` **before** the SPA catch-all (otherwise they would be swallowed and
  return index.html). Dev-mode Vite must proxy `/themes` in `web/vite.config.ts` (already
  added).
- **Theme sources**: built-in `<pkgRoot>/themes/*.css` (shipped in the npm package;
  `package.json` files whitelist includes `themes/`); user custom themes are dropped as CSS
  files into `<dataDir>/themes/` (on id conflict, user overrides built-in). `pkgRoot` is
  resolved by `resolvePkgRoot()` walking up to an ancestor with package.json; correct for
  both dev (server/) and prod (dist/server/).
- **Light themes**: `themes/light.css` (soft purple) and `themes/white.css` (display name
  "White": pure white background + GitHub-blue accents; links/selection/cursor all go blue,
  clearly distinct from light) are both generated from `styles.css` by the root script
  `make-light-theme.mjs` (`:root` light palette + hardcoded dark-color remaps + `.hljs`
  syntax-highlight light overlay + `--term-*` terminal light variables; the white theme
  additionally maps purple-family links to blue). **Dark purple glow**:
  `themes/md-preview.css` (display name "Purple glow") = original dark passthrough + body
  gets the same purple radial gradient as `.fp-markdown`, and `.topbar/.panel/.statusbar`
  backgrounds are **fully transparent** — the gradient *is* the window background; chrome
  keeps only borders for structure. Re-run `node make-light-theme.mjs` after styles.css
  changes.
- **Theme display names**: the CSS first line `/* theme-name: Display Name */` is the name
  in the dropdown (`listThemes` reads the first 300 bytes); missing that, fall back to the
  file id — filenames must be ASCII (`ID_RE` check); the display name lives in this marker.
  **Terminal follows the theme**: the xterm canvas uses `buildTermTheme()` in
  `web/src/theme.ts` to read `--term-*` variables; on theme change `TermXterm.tsx` listens
  for `pi-web-ui:theme-change` and hot-updates via `term.options.theme`; CSS containers
  `.term-main` / `.term-xterm .xterm-viewport` use `var(--term-bg)` so they blend with the
  canvas automatically (the historic black bar at the bottom was caused by container
  background disagreeing with the canvas). Re-run `node make-light-theme.mjs` after
  styles.css changes.
- **Regression**: `theme-test.mjs` (port 8937, isolated data-dir): list / built-in / user
  themes, inject link, light theme takes effect, persist across refresh, user theme can be
  applied, returning to default removes the link.

| mode | Meaning | Server handling |
| --- | --- | --- |
| `inline` | Inline full text | Inline if ≤ `PI_WEB_INLINE_FILE_MAX` (default 12KB); over that, auto-downgrade to reference |
| `reference` | Path only | Send `<file path="..." size="..."/>`; the model uses the read tool as needed |
| `lines` | Selected lines | Send `<file path="..." lines="2-3">```selected lines```</file>`; read only that range (read cap 2MB; over that, downgrade to reference) |

**Image Q&A (no workspace path)**: paste (Ctrl+V) / drop onto the input (**the whole window
is a drop target**, issue #19: `.app` root handles file dragover/drop + full-screen
`.app-drop-overlay` highlight; the input bar and editor handlers stopPropagation to keep
priority) / 🖼 uploaded images are sent with `attachments[].imageData` (base64) +
`mimeType` + `name` — the server attaches them directly as image content and does not use
a file path (`path` is ignored). The browser (`web/src/image-paste.ts`) first scales the
image to ≤1568px and transcodes to PNG/JPEG as needed so the payload stays within the
server 2MB cap (`MAX_PASTED_IMAGE_BYTES`). If the current model does not support vision
(`model.vision`), the frontend shows a warning.

**Vision bridge (text-only models looking at images, following the modlens idea)**: when
the **current conversation model does not support vision** (DeepSeek/GLM etc. have `input`
of only `text`), `buildAttachmentMessages` no longer sends the image as image content
(it would be ignored) and instead hands it to a **configured vision model** to transcribe
into textual evidence, then feeds that to the main model (`server/vision-bridge.ts`):
- **Zero-config auto-discovery**: `findVisionModels` scans every `ModelRuntime` provider
  with **`hasConfiguredAuth`** and finds models whose `input` includes `"image"`
  (qwen-vl, GLM-4V, Gemini, …) — reuses credentials already in models.json/auth.json; no
  new config. ⚠️ Must filter unconfigured SDK built-in providers (e.g. amazon-bedrock
  ships Nova vision models but has no auth; without the filter the call fails).
- **Transcription**: `transcribeImages` uses `runtime.completeSimple` to send the whole
  batch (multiple images in one call) to the vision model. The prompt is evidence-first —
  verbatim OCR, layout, chart coordinates/legends, entities; if unreadable, say
  "unreadable", do not invent (modlens evidence-not-imagination contract). Default 90s
  timeout (`PI_WEB_VISION_TIMEOUT_MS`), maxTokens 4000 to avoid blowing the context.
- **Result shape**: attachment-card content becomes `[text(<vision-bridge> wrapper),
  image(thumbnail)]`, `details.mode` = `"bridged"` (frontend AttachmentCard shows an
  "👁 transcribed" tag + expand to see the thumbnail and transcription;
  `stripFileWrapper` also peels the `<vision-bridge>` wrapper). Notices report
  start/complete/fail (on fail, send the original as-is).
- **File-list referenced images trigger the same path**: in the `buildAttachmentMessages`
  preprocess, besides `imageData`, **path attachments that point at images** (extension ∈
  IMAGE_EXT and not SVG, confirmed by `sniffImageMime` magic bytes, ≤5MB
  `MAX_PATH_IMAGE_BYTES`) are read as base64 — text-only models go through the vision
  bridge (bridged cards keep `path`); vision models send them as image content (no longer
  making the model read binary garbage with the read tool); SVG stays an ordinary file
  (the model reads the source).
- **Cache**: `visionBridgeCache` caches transcription text by batch hash (name + first 48
  chars of base64) — edit-and-resend of the same image does not spend vision tokens again.
- **No vision model**: a warning notice "no usable vision model found" + images sent as-is
  (status quo).
- **Settings panel can pick model/toggle/prompt** (vision-bridge block in `SettingsModal`,
  via `set_settings` + `UiSettingsState`, persisted per client in client-state.json):
  ① toggle `visionBridgeEnabled` (on by default; when off, images are sent as-is + warning
  notice "vision bridge is disabled in settings"); ② transcription model
  `visionBridgeModel` ("provider/id", default null = auto-pick the first; server
  `buildAttachmentMessages` uses `resolveReviewModel` to parse and checks
  `getModel().input` contains image, otherwise falls back to auto-discovery);
  ③ transcription prompt `visionBridgePromptMode` ("append"/"replace", same semantics as
  promptMode) + `visionBridgePrompt` (custom text; empty = built-in default) — assembled
  by `buildVisionBridgePrompt` (exported from vision-bridge.ts) and passed as
  `systemPrompt` to `transcribeImages`; append adds after the default prompt, replace
  replaces entirely (empty text still falls back to default); **the prompt is part of the
  batch cache key** — changing the prompt and resending the same image no longer hits the
  old transcription cache. `settings_state` includes `visionModels`
  (`collectVisionModels()` = `findVisionModels` result) for the dropdown; presets
  **do not include** vision-bridge prefs (`SettingsPreset extends Omit<ClientSettings,
  "visionBridge…">`; apply keeps current values); changing vision-bridge fields in
  `setSettings` **does not** trigger `applyRuntimeSettings()` (no reload needed; the next
  prompt picks it up). **Both replace inputs are prefilled with "the original prompt"**
  (`settings_state` carries `defaultSystemPrompt` + `visionBridgeDefaultPrompt`): switching
  to replace mode auto-fills an empty box with the built-in default for editing; if the
  content still matches the default, save as empty (= use default) so switching back to
  append does not double-append.

**File chat (no workspace path)**: dropping onto the input / 📎 uploading an arbitrary
file sends `attachments[].fileData` (base64) — the server writes to the global directory
`~/.pi-web/uploads/<clientId>/` (**not inside the project**, `MAX_UPLOAD_BYTES` 20MB cap);
small text (≤ `PI_WEB_INLINE_FILE_MAX` and sniffed as text) is inlined; everything else is
attached as an **absolute-path** reference (the read tool supports absolute paths).
Frontend split (`isRasterImage`): **only raster images** (png/jpeg/gif/webp/bmp/avif…)
go through the imageData pipeline; **SVG and other vector formats are excluded** —
createImageBitmap fails on SVG, and attaching SVG as an ordinary file so the model reads
the source is more useful; remaining files go through fileData.

Attachments are sent as independent custom messages (`sendCustomMessage` +
`deliverAs: "nextTurn"` asides) and rendered as collapsible cards. The client
`stripFileWrapper` regex must accept a `lines="..."` attribute.
**The message serialization cache is keyed by `role:timestamp` — multiple asides of the
same prompt created in the same millisecond collide; they must be distinguished by a
content fingerprint (`contentFingerprint`), otherwise only the first renders (already
fixed; do not revert).**

### File-preview protocol

- Client sends `{ type: "read_file", path }` → server replies `{ type: "file_content", path, name, text, truncated, binary, lines, size }`.
- Only the first **512KB** of the file is read (`MAX_PREVIEW_BYTES`); **content sniff
  decides text vs binary**: no NUL and control-character ratio < 2% is treated as text
  (`looksLikeText`) — unknown / extensionless files (jsonl, .log.1, etc.) can still be
  opened; **text decode has a GBK fallback** (`decodeText`: strict UTF-8 fail → GBK →
  latin1; used by preview / inline attachments / line attachments), so legacy Chinese
  Windows files no longer mojibake; binary returns `binary: true`, `text` is a
  **hex dump** of the first 4KB (`hexDump`, rendered by frontend `.fp-hex`; the full file
  can be downloaded). Paths are checked with `resolve + relative`; `..` escape is
  rejected outright.
- **Media preview goes over HTTP**: image/video streamed via
  `/api/file?clientId=…&path=…` (`sendFile` supports Range); the path is resolved against
  **that client's session cwd** (the open project), not the server start directory — the
  two can differ; missing `clientId` or a missing session falls back to the server-start
  `CWD`. Path checks all go through `workspacePath()` (exported from agent-service).
- Line-number semantics: **a trailing newline does not produce an empty line**
  (`countLines` is already corrected); frontend and backend split logic must stay in
  sync.
- **Download button** (`web/src/download.ts`): do not use `<a download href>` (Chrome
  Safe Browsing blocks untrusted file types such as .zip/.exe from non-HTTPS origins,
  reporting "couldn't download / contact your organization"); instead fetch → blob save;
  >200MB falls back to native-navigation streaming download; failure toast shows the
  server error body (`downloadFailed` i18n key). **Windows special case**: blob-anchor
  downloads on Windows can still be silently intercepted by Safe Browsing (no JS error;
  looks like "clicked and nothing happened") — in a Chromium secure context
  (localhost/HTTPS) prefer `showSaveFilePicker` to write directly to a user-chosen file
  (bypasses the download pipeline); on Windows the save name is cleaned by
  `sanitizeFileName` (`<>:"\|?*`, trailing dots/spaces, reserved device names like
  CON/COM1); cancelling the save dialog is not an error (`cancelled`, no toast).
  `download-test.mjs` covers the regression (picker disabled so the blob path is tested).

### Terminal

- One `TerminalManager` per `Conversation`; the agent can call `terminal_create`,
  `terminal_list`, `terminal_close`, `terminal_input`, `terminal_key`, `terminal_read`;
  supports named multiple terminals, incremental cursor, Enter/Tab/arrows and Ctrl/Alt
  combos. The PTY working directory is restricted to that conversation's workspace; at
  most 16 terminals; input/read have size and wait caps.
- **All spawn paths share one admission gate**: `terminal_create` (browser/agent) and
  `run_command` (command list) both use `validateId` (letters/digits/.-_:/ ≤80 chars) +
  `ensureSpawnAllowed` (a new live PTY must be under `MAX_TERMINALS`; restarting an
  already-running same-named terminal in place does not consume a new slot; **exited
  terminals in history do not keep a slot** — re-running an exited terminal while full
  is also refused, closing the "unique IDs generate unbounded PTYs" hole); failures all
  go through `fail()` (notice + red error in the terminal + terminal_exit).
- **terminal_key encoding is a pure function** `encodeTerminalKey(key, modifiers)`
  (exported; byte-level asserts in terminal-smoke-test.mjs): named keys route by name;
  Ctrl/Alt combos never fall back to "Ctrl+first letter" — Ctrl+ArrowUp=`ESC[1;5A` (not
  Ctrl+A), Ctrl+Enter=`ESC[13;5u` (not Ctrl+E); arrows/F1–F4/Home/End with modifiers use
  the xterm modifier sequence `ESC[1;<m>X`; other named keys use CSI-u
  `ESC[<code>;<m>u`; ordinary characters map Ctrl A–Z→0x01–0x1A, Shift uppercase, Alt
  prefixes ESC.
- Output is pushed to the browser as `terminal_output` carrying `conversationId`;
  unmounted terminals keep a 200KB output window, replayed when switching back to the
  conversation. Socket disconnect does not kill PTYs; switch/reconnect keep state; all
  PTYs are killed only when the conversation is released or the server shuts down.
- **node-pty × Node `--watch` compatibility self-heal** (`server/patch-node-pty.ts`, must
  be imported before node-pty):
- **Terminal-output micro-batching** (`queueOut`/`flushPending` in `terminals.ts`, window
  `OUTPUT_FLUSH_MS=16ms`): each `pty.onData` chunk goes into `pendingOut` then flushes as
  one `terminal_output` — WS frame storms of hundreds/thousands of tiny chunks per second
  during builds drop 10–50×; exit/kill/in-place restart flush first, then send the exit
  event, to preserve order. The dev script uses `node --watch`; watch mode pushes
  `watch:require`/`watch:import` messages onto node-pty's ConPTY worker / console-list
  agent IPC — node-pty 1.1.0 does not recognize them, causing ① a
  `console.warn('Unexpected ConoutWorkerMessage')` flood per message and ② the kill path
  treating the watch message as an agent reply, with `message.consoleProcessList`
  undefined, then `.forEach` crashing. The patch module idempotently rewrites the
  installed copy at startup (following the spawn-helper chmod precedent); `terminals.ts`
  also has a console.warn filter as a backstop. Production (no `--watch`) is unaffected.
- **Source-control (`SCMPanel`, view `git`) read-only git queries**: server
  `server/scm.ts` runs `execFile("git", …)` directly (no shell — no prompt / echo / ANSI /
  zsh differences) and parses into structured JSON. Protocol: client sends `scm_status`
  (status+branches (including remotes, for-each-ref)+numstat) / `scm_history` (commit
  graph, lazy-loaded — queried only when switching to the "commit tree" tab, so large-repo
  refreshes do not pay for it) / `scm_filediff` (single-file staged+worktree diff) /
  `scm_commit` (hash whitelist then git show); the server always replies with one
  `scm_data` (echo reqId + kind, ok/error/notRepo); the frontend matches pending slots by
  reqId — every request has exactly one response, so the UI cannot stick on loading;
  sendScm does not occupy a slot or set busy when the socket is down (prevents a stuck
  spinner). Path check: filediff path must still be inside the workspace after resolve;
  a non-git repo returns ok:true + notRepo:true (the panel shows a hint, not an error).
  15s timeout / maxBuffer 16MB.
  **git-dir watcher**: on the first scm_status, `git rev-parse --absolute-git-dir` locates
  .git and fs.watch (non-recursive — HEAD/index/packed-refs are all at the top, covering
  commit/stage/checkout); events are debounced 600ms and push `scm_changed` → frontend
  silent refresh (external CLI/IDE repo changes show up live); unwatch on
  setCwd/dispose/notRepo; watch failure silently degrades to a 30s visible poll fallback.
  **Auto-refresh triggers** (all silent refresh, no spinner flash): scm_changed / SCM-
  generated git write commands in a terminal tab going running→exit (title `/^git /`) /
  view activation / cwd switch / 30s poll.
  **Writes** still go through a visible terminal tab (same tab-reuse logic as
  TerminalPanel) and switch to the terminal view: commit/push/pull/switch branch (remote
  `origin/x` → `git checkout -b x origin/x || git checkout x`) / stage a single file
  (`git add -- <path>`, + button on row hover) / unstage (`git reset HEAD -- <path>`, −
  button); paths are single-quote escaped. Branch dropdown groups local/remote
  (optgroup, i18n scmRemoteBranches).
  Historical lesson (abandoned old implementation): a hidden PTY + shell-variable
  concatenated sentinel to split text hit three pits — xterm writer overwriting the
  parser, zsh prompts with no trailing newline gluing lines and swallowing the
  `## main` status header, and a global queue blocked by a slow query during streaming.
- **Terminal liveness watchdog** (`noteAgentActivity` / `armIdleWatch` in `terminals.ts` +
  `notifyTerminalIdle` in agent-service): agent-tool-path terminal_create/input/key start
  a "silence epoch" — if that terminal has no output for `PI_WEB_TERMINAL_IDLE_MS`
  (default 15s) continuously **and that conversation is currently streaming**, the
  onAgentIdle callback has the host `sendUserMessage` inject a steer reminding the AI to
  check (waiting for input / hung). Anti-harassment: ① user-opened terminals never
  participate (only the tool wrapper calls noteAgentActivity; the browser path does not);
  ② one-shot — after firing, disarm; the agent must touch again to restart the timer;
  ③ any output/input in the epoch resets the countdown; ④ exit/close tears down the
  clock. System-prompt guidance TERMINAL_TOOLS_GUIDANCE already tells the model about
  this. Regression: `tests/terminal-idle-test.mjs` (instantiate TerminalManager directly +
  a small threshold; zero token, no server; win32 unverified).
- **Terminal-backed bash** (settings-panel toggle `terminalBash`, off by default)
  (`makeTerminalBashTool` in `terminals.ts` + `makeAdaptiveBashTool` in agent-service for
  dynamic split): when on, the bash tool body writes commands into the persistent visible
  terminal `ai-bash` (single-line sentinel:
  `{cmd}; __pi_rc=$?; printf '\\n[pi-exit:%s]\\n' "$__pi_rc"`; multi-line scripts are
  eval'd via `$'...'` escaping so the interactive shell's stdin/bracketed-paste cannot
  eat them), waits for the sentinel line to get the **real exit code**, then returns the
  full output (`stripAnsi` cleans ANSI/OSC/orphan CR and trims echo + the new prompt).
  Behavior: ① block until the command ends by default; ② `terminalBashIdleMs` (default
  15s, 0 = wait forever) of continuous silence → **silent unblock**: immediately return
  "still running in the background" + output so far, and register a `watchOutput`
  completion observer; when the command actually finishes the host
  `notifyTerminalBashDone` notifies the AI (steer via sendUserMessage while streaming /
  queue via sendCustomMessage nextTurn when idle, without waking); ③ shell state is kept
  across calls (cd/venv/ssh); ④ abort_bash reuses the same kills set; abort sends Ctrl+C
  to the PTY to kill the foreground process, terminal is kept. The toggle is read from
  settings on every call by makeAdaptiveBashTool → takes effect immediately (customTools
  are fixed at runtime creation, so you cannot pick one or the other at create time);
  the threshold is stored with presets. Regression: `tests/terminal-bash-test.mjs`
  (instantiate directly + inject a small threshold; zero token, no server; win32
  unverified).
- On macOS, if the service is launched by launchd (`process.ppid === 1`, LaunchAgent /
  orphan), TCC attributes camera/mic permission to node itself (no App Bundle, no
  Info.plist) and silently denies — ffmpeg capture hangs on grabbing a frame.
  `terminals.ts` detects this and prints a hint the first time the client creates a
  terminal (switch to a url/file source, or run in the foreground in a terminal that
  already has permission).

### Plugins (optional UI components, <dataDir>/plugins)

- **Shape**: one plugin = a `<dataDir>/plugins/<id>/` directory: `manifest.json`
  (name/version/description) + `index.mjs` server entry (optional,
  `export default { activate(host) → deactivate? }`) + `client/entry.mjs` view entry
  (optional, `export default { mount(el, ctx) → cleanup? }`).
  **If it is not installed, it does not exist** — with no directory there is no protocol
  or UI trace; directories are re-scanned on attach, so a plugin dropped in appears on
  the top-bar view tab without restarting the server (import once per process and
  cache; deleting the directory → deactivate on the next attach).
- **Protocol**: uplink `{type:"plugin_message", pluginId, payload}` (routed to that
  plugin's onMessage handler; the callback's second arg is the sender clientId;
  unknown/illegal ids are silently dropped) and `{type:"plugins_reload"}` (server hot
  reload: deactivate all → re-scan activate → epoch+1 → re-push catalog); downlink
  `{type:"plugins", plugins, epoch}` (catalog pushed on attach; epoch is the frontend
  import cache-buster `?e=`) and `{type:"plugin_data", pluginId, payload}` (broadcast to
  all sockets by default; frontend fans out by pluginId to loaded views).
- **Host extension points**: `host.notify(level,text)` sends a system notice (frontend
  toast);
	`host.sendTo(clientId, payload)` sends to a single socket (clientId from the
  onMessage callback);
  `host.onToolEvent(h)` subscribes to SDK tool-execution events
  (`{phase:start|end, toolName, conversationId?, durationMs?, isError?}`; agent-service
  forwards via `AgentService.onToolEvent` → `PluginManager.emitToolEvent`; handler
  exceptions are isolated); `host.registerAgentTool(tool)` registers a **tool for the AI
  to call** (returns an unregister function, can be toggled anytime) — via
  `PluginManager.onAgentToolsChanged` → wiring in `index.ts` →
  `AgentService.applyPluginAgentTools()` pushes tools into all sessions: new
  conversations get them with customTools; existing sessions use
  `syncPluginToolsIntoSession()` (pure in plugins.ts, vitest-tested) which reuses the
  SDK internals `_customTools + _refreshToolRegistry()` three-way diff (new names
  automatically enter the active set; on SDK rename, silently degrade; new conversations
  still get them). The background-tasks panel is not migrated for now (safety-net stays
  built-in); these points are for future plugins.
	`host.onAttach(h)` registers a "new client attached" hook (every browser attach,
  including re-attach after plugins_reload, called with clientId, exception-isolated) —
  **plugin initial state must be pushed proactively here**
  (`host.sendTo(clientId, {kind:"state", state})`); do not rely on the client pulling
  after mount: a bare `ctx.send({action:"state"})` has no reqId and the response is
  silently dropped by the client's pending matcher (db-client and vscode-editor each
  hit this once). Client pull (request() with a reqId) is only a fallback for older
  hosts; client onData console.warns on responses with no reqId as a guardrail.
- **Optional manifest fields**: `icon` (emoji/single character, replaces the generic
  puzzle icon on the top-bar tab), `description` (tab hover), `version`. Settings ⚙ has
  a "UI plugins" toggle section (`set_settings.disabledPlugins`, persisted in
  client-state, pure UI hide, does not trigger a runtime reload; presets do not capture
  this field) + **per-row "Update/Uninstall" buttons** (update requires the CLI-install
  recorded source `.pi-source.json` → `UiPluginInfo.source`; hand-copied plugins without
  that file only show uninstall; both operations go through a visible terminal tab;
  after exit an App observer sends `plugins_reload` for a hot reload); frontend
  `syncPluginViews(plugins, epoch)` keeps the registry in sync: disappearing/disabled
  catalog entries unmount the view (call cleanup); epoch change clears failed and
  re-fetches the bundle.
- **Frontend**: App dynamically imports each plugin's client bundle from chat.plugins
  (`/* @vite-ignore */`); TopBar adds a 🧩 tab per plugin (failed activations are
  greyed); plugins do not share a React instance; the only channels to the host app are
  ctx.send/onData.
- **Static serving**: `GET /plugins/:id/client/*` maps to the plugin directory's client/
  subtree (**only that subtree is exposed** — manifest and server index.mjs may contain
  credentials and must never be downloadable; id check + resolve prefix prevent
  traversal). Dev-mode vite already proxies /plugins.
- **Example**: `dev/plugins/demo-mailbox/` (in-memory mailbox demo, also the plugin-test
  fixture; manifest declares a settings schema; server activate reads host.getSettings +
  subscribes host.onSettingsChanged to demo the full declarative-settings loop; dev/ is
  not in the npm package). Local try-out: copy to `~/.pi-web/plugins/demo-mailbox/` and
  refresh.
- **Real plugin**: `dev/plugins/webmail/` (📬 web mail, IMAP/SMTP): inbox browse/search/
  read/flag/delete + SMTP send (imapflow/mailparser/nodemailer, not shipped — first
  activate or saving an account auto npm-installs into the plugin directory; on failure
  it can be triggered manually in the view); periodic INBOX unread poll → new-mail
  host.notify + view badge; settings stored in `<pluginDir>/config.json` (plaintext on
  this machine; state echo is redacted to hasPass only; passwords go through host.secrets
  (AES-256-GCM, `<dataDir>/secrets.key`; historical plaintext config.json is migrated on
  first start). **"Allow AI to manage mail" toggle** (config.aiEnabled) controls
  registration of mail_list/mail_read/mail_search/mail_send/mail_manage/mail_folders;
  turning it off unregisters them. Install: `pi-web-ui install <github-source>` or copy
  the directory to `~/.pi-web/plugins/webmail/`. Regression:
  `tests/unit/plugin-tools.test.ts` (sync diff + registration lifecycle) +
  `tests/scratch/webmail-e2e-test.mjs` (protocol smoke: catalog/state echo/save_config
  write/password not echoed) + `tests/scratch/webmail-crash-test.mjs` (missing deps must
  not crash the host + auto-install on activate).
- **Real plugin**: `dev/plugins/vscode-editor/` (📝 editor + SSH; originally separate
  vscode-editor and ssh plugins, now merged; old host config
  `<oldPluginDir>/ssh-hosts.json` is auto-migrated on first activate): multi-root file
  tree (local workspace + SSH hosts) + multi-tab CodeMirror editor (local and remote
  files open together, Ctrl+P quick-open is local-only, Ctrl+S save, CRLF preserved) +
  Remote-SSH remote file browse/create/rename/delete (after connect, exec pwd to detect
  home as the starting path; ".." goes up) + a bottom draggable multi-terminal panel
  (xterm.js PTY stream forwarded as base64, window-size sync, keepalive, multiple shells
  per host) + SFTP sync (☁ menu: whole-workspace upload/download, single-file upload,
  edit config; context menu: upload a local file to remote or download to this computer;
  remote files/folders download directly to this computer (folders packed as tar.gz on
  the remote, user picks the save location); whole-workspace sync still goes through the
  ☁ menu (uploadOnSave); config lives in workspace .vscode/sftp.json with vscode-sftp
  compatible field names host/port/username/password/passphrase/privateKeyPath/remotePath/
  uploadOnSave/ignore (glob); form and editing the file are dual channels, Ctrl+S save
  takes effect immediately; old plugin-dir sync-configs.json is auto-migrated on first
  access; ignore is vscode-sftp-style glob, a bare name with no slash matches at any
  depth).
  **SSH host credentials encrypted**: hosts' password/privateKey/passphrase live in
  host.secrets (keyed by host id); ssh-hosts.json no longer stores plaintext; first start
  auto-migrates historical config. **Unified scope model**: scope = "local" | connId;
  file ops (list/read/write/create/rename/delete) with a connId route to that
  connection's SFTP; frontend and backend share one code path. ssh2 is not shipped —
  first activate preloads and auto npm-installs into the plugin directory (failure can
  be triggered manually via the sidebar ⚠ssh2 button). Install: copy manifest.json +
  index.mjs + client/ to `~/.pi-web/plugins/vscode-editor/`. **Workspace follows**:
  host.cwd live value + onCwdChange — after the main app set_cwd the editor root
  switches to the new project in real time (broadcast kind:"workspace"); frontend clears
  cache/expand state, closes local tabs (dirty-tab count hint), re-reads the new
  project's .vscode/sftp.json (old sync connections are void); remote SSH tabs are
  unaffected. Regression: `tests/plugin-cwd-test.mjs` (port 8989, probe plugin verifies
  set_cwd→notifyCwd→broadcast full chain + idempotence). Regression:
  `tests/ssh-plugin-test.mjs` (port 8964, zero-token self-contained, already on the
  run-smoke list; uses ssh2's built-in Server as an in-memory mock remote — auth
  fail/success, PTY I/O, exec exit code, remote-file full-chain connId routing, local
  ops unaffected) + `tests/lib/mock-ssh.mjs` (shared mock remote) +
  `tests/ssh-plugin-ui-test.mjs` (real Chrome: host modal / connection-tree expand /
  xterm terminal / CodeMirror edit-save writeback).
- **Real plugin**: `dev/plugins/db-client/` (🗄️ database connection manager, similar to
  vscode-database-client): connection-config CRUD (stored in
  `<pluginDir>/db-connections.json`; connection passwords go through host.secrets keyed
  by conn id, historical plaintext auto-migrated; echo is redacted to hasPass/hasUri
  only) + database/table tree browse (filter) + table structure (columns/indexes/DDL) +
  paged data view (click a column header to sort, NULL de-emphasized, large-table
  estimated row counts) + SQL query editor (Ctrl+Enter, elapsed / rows affected). Six
  drivers behind one adapter interface: mysql2 / pg (lazy client per database) /
  mssql (auto-detect schema + lazy pool per database) / **sqlite opened read-only via
  Node built-in `node:sqlite`** (zero native deps, ≥22.13) / mongodb (JSON filter paged
  docs, no SQL tab) / redis (pattern-scan keys + type-aware value render + raw command
  line).
  **Row editing**: row_update/row_insert/row_delete parameterized writes (located by
  primary key; SQLite tables with no PK fall back to rowid carried as a __rid__ column;
  page responses carry editable/pkCol); double-click a cell to edit + hover to delete a
  row + insert-row form; mongo doc_save/doc_insert/doc_delete (BSON→plain JSON echo,
  _id hex strings auto-restored to ObjectId); redis_key_set is string keys only. sqlite
  is opened writable via node:sqlite. Drivers are not shipped — first activate does a
  one-shot `npm install` into the plugin directory; **availability is probed per
  driver** (depsAvail; installing only some still enables the matching types);
  `PI_DB_CLIENT_NO_AUTOINSTALL=1` disables auto-install (for tests). Install: copy to
  `~/.pi-web/plugins/db-client/` (client/entry.mjs is produced by the plugin's
  `npm run build` and checked in). Regression: `tests/db-client-test.mjs` (port 8968,
  SQLite full-chain protocol smoke: CRUD redaction / connect / tables/describe/page
  sort+paging / query success + bad SQL + read-only intercept / conn_closed event
  cascade / traversal reject; already on the run-smoke list).
- **Regression**: `tests/plugin-test.mjs` (port 8978, zero-token self-contained, already
  on the run-smoke list): catalog push / message round-trip / silent drop / static
  Content-Type / server code not leaked / path-traversal reject.
- **Regression**: `tests/plugin-command-test.mjs` (port 8979, zero-token self-contained,
  already on the run-smoke list): plugin-command full chain — catalog includes
  source=plugin entries / prompt intercept exec (broadcast + notice echo, not passed
  through to the SDK) / empty-args branch; unit
  `tests/unit/plugin-facilities.test.ts` (storage round-trip / secrets encrypt and
  fail-closed on machine copy / deps probe / apiVersion gate / command-registry
  collision and cleanup).
- **Regression**: `tests/plugin-http-test.mjs` (port 8981, zero-token self-contained,
  already on the run-smoke list): host.route full chain — GET/POST hit + query/body,
  unregistered paths and unregistered routes 404, unknown plugin 404, handler throw 500
  does not crash the process.

- **Regression**: `tests/plugin-bgtask-test.mjs` (port 8982, zero-token self-contained,
  already on the run-smoke list): registerBackgroundTask joins bg_servers
  (taskId/plugin/status) / update refresh / kill_background_server{taskId} → stop
  callback + remove / unknown id silent.
- **Regression**: `tests/plugin-settings-test.mjs` (port 8983, zero-token self-contained,
  already on the run-smoke list): catalog carries schema+defaults / plugin_settings save
  to disk + echo / out-of-range reject and stored value unchanged; unit
  `tests/unit/plugin-settings.test.ts` (6 cases: schema parse/validate/persist keeps
  plugin-owned keys/getSettings live/onSettingsChanged fire and unregister).
- **Regression**: `tests/mcp-bridge-test.mjs` (port 8990, zero-token self-contained,
  already on the run-smoke list): mcp.json → MCP server launched at server start (stdout
  ready log) / bad server isolated, does not crash the process; unit
  `tests/unit/mcp-bridge.test.ts` (7 cases: handshake tool list / echo/add call /
  fail+unknown-tool error / bridge aggregate adapter execute forwards directly / no
  config / slow timeout).
- **Regression**: `tests/plugin-update-test.mjs` (local git repo as mock remote, zero
  network zero token, already on the run-smoke list): install records .pi-git-sha →
  remote adds a commit → check-updates reports updatable → install --force updates
  (auto-backup + sha refresh) → reports current → --rollback restores the old version +
  backup cleanup → reports updatable again; unit
  `tests/unit/plugin-updater.test.ts` (9 cases: backup/rollback/prune / backup excludes
  .git+node_modules / resource parse of GitHub sources with # and /tree/ / local git
  path real ls-remote / checkPluginUpdates updatable · current · conservative-updatable
  · fail). Must run after changing server/plugin-updater.ts or the bin install/plugins
  commands.

### Other bridges

- **Real-time tool-end status (`tool_status`)**: server `onEvent` listens for
  `tool_execution_start/end` (AI-calling-a-tool path; distinct from
  `bash_execution_update`, which is exclusive to the `!cmd` / terminal-direct-exec
  path). On `tool_execution_end` it immediately pushes `tool_status`
  (toolCallId/toolName/isError/exitCode/durationMs), **before** the toolResult snapshot
  lands — the browser tool card switches from "running" to "done · waiting for model ·
  elapsed" so you can tell "the command is still running" vs "the command finished and
  we are waiting for the model". bash-tool details do not carry exitCode (success
  returns truncation info; failure error text contains `Command exited with code N`);
  the server extracts it with a regex; `tool_execution_start` time is stored in
  `conv.toolStartTimes` (isolated per conversation) to compute real elapsed. Frontend
  `toolStatuses` Map is cleared after toolResult lands (snapshot prune) and falls back
  to the authoritative toolResult status.

### Multi-conversation concurrency (per-project "running conversations")

- Per client `convs: Map<convId, Conversation>`, **each conversation has its own
  `AgentSessionRuntime`**: `new_chat` creates a new runtime + a new session file (the
  old conversation keeps running in the background, not interrupted);
  `switch_conversation` only swaps `activeId` (does not touch other runtimes);
  `runtime`/`session` accessors point at the current active conversation.
  **Conversations belong to a project**: `conv.cwd` is the owning project; each
  project's active conversation is independent.
- **`set_cwd` no longer rebuilds the current conversation** — it switches to the target
  project's own conversation (that project's most recently active one; if none, create
  one and restore that project's most recent persisted session). Conversations left
  behind stay in place and keep running in the background; title/cwd never cross
  projects (the old "after switching projects the highlighted conversation name is
  still the previous project's" root cause was the rebuild).
- **"Running conversations" list lifecycle** (each conversation has `listed` /
  `promptedSinceActive` / `lastActiveAt`):
  - Enter the list: the active conversation is displaced to the background **while
    streaming** (new_chat / switch_conversation / set_cwd) → `listed=true`;
  - Stay on the list: finishing in the background does not remove it (the user may not
    have seen the result yet);
  - Leave the list: open it (make it active) → no further conversation (no prompt sent
    in between) → when leaving, `displaceActive()` returns it and `removeConversation`
    releases the runtime (the session is already persisted; history can still restore
    it). Empty conversations that were never listed are also released when left.
- Cap `MAX_OPEN_CONVERSATIONS = 8` is **per project**; exceeding it, new_chat sends a
  warning notice.
- All conversations share **one ModelRuntime** (seeded when the first conversation is
  created, passed into `makeRuntimeFactory` for reuse) — changing the model in the top
  bar applies to every conversation. **Message serialization cache (msgIds /
  uiMessageCache / signature) is isolated per conversation**: two conversations can
  produce the same (role, timestamp) key; sharing would mix ids.
- `snapshot` carries `conversationId`; `conversations` (ServerMessage) only pushes
  **listed conversations of the current project** + `activeId` (activeId may be unlisted,
  e.g. a just-created new_chat that has not run yet); `switch_conversation`
  (ClientMessage) only switches within the same project.
- Unchanged behavior: `switch_session` (restore a persisted session) replaces the
  **current** conversation's runtime (treated as continued after success);
  `edit_message` forks inside the **current** conversation; `dispose` walks and destroys
  every conversation; attachSink re-pushes conversations on reconnect.
- Frontend: left-pane "Running conversations" section (shown when ≥1, active
  highlighted, streaming green dot); MessageList uses conversationId as key so a switch
  force-remounts.

- Extension `setWidget/setStatus/notify/select/confirm/input` →
  `widgets/statuses/notice/dialog` messages; dialogs return via `dialog_response`; Esc
  is treated as cancel.
- In `snapshot`, `streamingMessage` is the in-progress message (60ms-granularity
  stream); `messages` are the ones already persisted.

## 5. Development workflow

```bash
npm run dev          # Parallel: node --watch --import tsx backend (:8788, the dev:server script, cross-env pins PORT=8788
#                     so it does not collide with a global pi-web-ui default :8787) + vite frontend (:5173, proxies /ws to :8788).
#                     Do not start the backend with `tsx watch` — on Windows, when stdio is a pipe (concurrently's spawn
#                     style), it hangs silently (tsx upstream bug). Use Node native --watch instead.
npm run typecheck    # Both ends tsc --noEmit (required before commit)
npm run check:protocol  # Guards the protocol single-source shim (required in CI)
npm run build        # build:web (vite) + build:server (tsc)
npm start            # Run the compiled dist/server/index.js (production)
npm test             # vitest pure-function unit tests (tests/unit/, millisecond, zero token)
npm run test:smoke   # Zero-token protocol smoke aggregator (tests/run-smoke.mjs, 17 self-contained tests)
npm run test:freeze  # Freeze/reconnect regression (Playwright; needs local chromium headless)
```

### CI (`.github/workflows/ci.yml`, push/PR → main)

GitHub Actions ubuntu-latest: `check:protocol → typecheck → build → vitest → test:smoke`.
The smoke list (ALL in tests/run-smoke.mjs, 17 items) only takes **self-contained,
zero-token, cross-platform** tests; attach-style (need an external server), tests that
need a real model, and platform-specific scripts stay out of CI and are run locally
(classification is in the header comment of run-smoke.mjs).

### Coding conventions

- **Indent with tabs.** Frontend component files are lowercase (`copy-button.tsx` is the exception). UI copy is English.
- **User-visible strings** in the web app go through `useT()` in `web/src/i18n.tsx` (English only). There is no Chinese locale or language switcher.
- **Server notices** are English; they are not i18n'd.
- **Styles**: all in `styles.css`, sectioned by `/* ---- ComponentName ---- */`; colors use CSS variables
  (`--bg-elev*`, `--border*`, `--text*`, `--accent*`, `--amber`, `--green`, `--red`).
- File-list `IGNORED_ENTRIES` (node_modules/.git/dist etc.) is maintained at the top of `files-service.ts` (two platform sets).
- New protocol messages → edit only server/protocol.ts (see §4 "Protocol single source"), then add a branch in both ends' dispatch/onmessage switch.
- **Slash-command catalog**: server `pushSlashCommands()` collects the current active session's extension commands
  (`session.extensionRunner.getRegisteredCommands()`) + templates (`promptTemplates`) +
  skills (`resourceLoader.getSkills()` → `skill:<name>`) plus 10 built-in commands
  (NATIVE_COMMANDS: /new /model /compact /cwd /thinking /resume /reload
  /help /copy /pi-web-ui:quit), pushed via the
  `slash_commands` message (refreshed on attach / set_cwd / new_chat / switch_conversation /
  switch_session / get_commands); built-in commands are intercepted in `prompt()`
  (`execNativeCommand`, including /model fuzzy match, /thinking levels,
  `/reload` calling `session.reload()` to rediscover extensions/skills/templates then re-push
  the catalog); the rest pass through to the SDK (the SDK expands extension/skill/template
  commands). Note that SDK `getSkills()` returns an in-memory snapshot from session creation —
  after deleting/adding a skill file you must `/reload` (or /new / switch project to rebuild
  the runtime) for it to take effect. Keep `NATIVE_COMMANDS` and `execNativeCommand()` in
  sync when changing. Regression: `slash-commands-test.mjs`.

### Verification checklist (self-check after a change)

1. `npm run typecheck` with zero errors
2. If UI is involved → `npm run dev` and walk the interaction by hand
3. If the ws protocol is involved → existing scripts under `tests/` to follow: first run `npm run test:smoke`
   (full self-contained protocol suite); a single one with `node tests/xxx-test.mjs` (build first with
   `npm run build`; browser E2E needs the local `/Users/c/Library/Caches/ms-playwright/.../chrome-headless-shell`)

### Test rules (read before writing tests / testing code)

- **Global vs local**: the user may be running a **globally installed** `pi-web-ui`
  (`~/.local/share/fnm/node-versions/…/lib/node_modules/pi-web-ui`, default port `8787`)
  with live conversations/work. The development target is always the **local repo**
  `/Users/patrickwilliams/Work/local-review`. The user will manually stop the global
  instance and switch to local when they want to test.
- **Never kill the global process / never occupy 8787**: do not `pkill -f "dist/server/index.js"` —
  that would hit the global server (port 8787) and interrupt the user's live session.
  Cleanup targets **only the test server you started**.
- **Isolated ports**: each `*-test.mjs` uses its own port (≥8900, avoid 8787/5173/3300), and
  before starting the server confirm the port is free with `lsof -ti :PORT -sTCP:LISTEN`; if
  it is taken, pick another port rather than force-killing.
- **Kill only the processes you spawned**: after spawn, record `server.pid`; on teardown
  (including catch paths) use `process.kill(pid, 'SIGTERM')` on only what you started. When
  several servers are up, kill each by its own PID; do not use a broad pattern match.
- **data-dir isolation**: the test server sets `PI_WEB_DATA_DIR` to `mkdtempSync(tmpdir…)`,
  `PI_WEB_CWD` to the local repo — do not pollute real user data / client-state / sessions.
- **Self-contained vs external deps**: tests that can go on the `tests/run-smoke.mjs` list
  **must start their own server and clean it up**; tests not on the list fall into two
  groups (reasons in the run-smoke.mjs header comment): ① attach-style, need an already-
  running external server — ws-session-test / file-upload-test / image-paste-test /
  commands-test(8791) / edit-reask-test / projects-test; ② need a real model —
  goal-abort-test / goal-autostart-test / goal-wizard-test / goal-wizard-cancel-test /
  tool-status-test. (title-jsonl-test is fixed and can run locally; on win32 terminal-smoke
  / restart-handoff skip automatically.)
- **Tests that need a real model / go through review or discovery** (goal-*, wizard) actually
  call an LLM, spend tokens, and depend on a local model (opencode-go can be slow/stuck) —
  when writing tests, distinguish "protocol smoke (no token, e.g. goal-test/goal-prefs
  set/clear sequencing)" from "live (real calls)" so a hang is not mistaken for a product bug.
- **Verification items**: after each revision, `npm run check:protocol` + `npm test` → local
  server (isolated port + independent data-dir) → matching `tests/*-test.mjs` or
  `npm run test:smoke` → `npm run typecheck` → if UI is involved, also `playwright` browser
  tests (chromium path is the HEADLESS constant in each test file).
- **goal family** (`tests/goal-*.mjs`): `goal-test` = protocol smoke (set/clear/locked/
  review-model/rounds sequencing, no token); `goal-prefs-test` = prefs persist across reload;
  `goal-pill-test` = GoalBar UI (pills, upward dropdown); `goal-rounds-test` = max-rounds
  **direct-input** control (any value / 0 = unlimited); `goal-autostart-test` = a direct
  set_goal (no wizard) also **auto-triggers generation**; `goal-abort-test` = **manual Stop
  clears the goal and stops the review loop** (agent_end treats assistant stopReason==="aborted"
  as interrupt); `goal-wizard-test` = questionnaire converges auto-set + **auto-generate
  auto-triggers generation**; `goal-wizard-cancel-test` = discovery cancel/timeout;
  `goal-review-loop-test` = lock + unlimited rounds real review loop (needs a real model;
  local deepseek may stall; fail is environmental, not a flaky product bug).
- **settings family** (`settings-test.mjs`, port 8931): settings-panel protocol smoke —
  settings_state push / get_settings / set_settings (prompt append+replace, skill and plugin
  toggles) / save_preset / apply_preset / delete_preset / persist across reconnect; a fake
  agent dir (isolated) tests protocol only; pointing at a real agent dir can cover toggle
  round-trips.
- **global-search family**: `global-search-test.mjs` (port 8962) = search_files protocol smoke
  (reqId echo / file+dir hits as relative paths / node_modules ignored / empty query);
  `global-search-ui-test.mjs` (port 8963, real Chrome headless) = top-bar search button opens
  the modal / file-section hit click opens preview / Ctrl+K toggle / model-dropdown search
  box renders.
- **scm-features-test.mjs**: SCM v2 feature protocol tests (zero token): lazy-load history /
  remote branches (for-each-ref + remote flag) / git-dir watcher (external CLI commit →
  scm_changed push).
- **lazy-window-test.mjs**: message-list lazy-windowing E2E (zero token, starts its own
  server): seed a long session + oversized messages → far-from-viewport messages collapse to
  equal-height placeholders (keep data-msg-id) / sticky bottom region is not placeholdered /
  scroll near remounts / search open forces full render / question-nav jump pin+flash /
  back-to-bottom button. Companion unit `tests/unit/lazy-window.test.ts` (planWindow /
  applyPlan / pickAlways / estimateMessageHeight).
- **scm-test.mjs**: source-control panel E2E (isolated port + temp git-repo cwd + temp
  data-dir, real Chrome headless): status list / branch chip / single-file diff / untracked
  hint / commit end-to-end (terminal tab + disk verify + auto-refresh back to clean) /
  branch switch (select + terminal checkout). Note that local `process.execPath` is an fnm
  multishell temp shim; `realpathSync(process.execPath)` first to get the real node before
  spawning the server.

- **terminal-bash-test.mjs**: terminal-backed bash regression (zero token, instantiate
  TerminalManager + tools directly): sentinel-line construction pures / stripAnsi / blocking
  semantics (real exit code passed through) / multi-line script eval $'...' / silent unblock +
  watchOutput completion callback / cd state kept across calls / abort_bash Ctrl+C. Must run
  after changing makeTerminalBashTool / cleanBashOutput.
- **quiesce-test.mjs** (port 8911): security-hardening smoke — control-socket
  status/quiesce/unquiesce (Windows named pipe / POSIX unix socket auto-adapt), Origin/Host
  same-authority check (cross-origin reject, same-origin pass, **same-host different-port
  reject**), models_config no longer contains headers, after quiesce existing clients can
  attach but prompt is refused, a brand-new client attach is closed with 4403, unquiesce
  restores. Must run after changing the security boundary (`npm run build:server` then
  `node quiesce-test.mjs`).
- **fetch-models-test.mjs** (port 8955): protocol test for auto-fetching a custom provider's
  model list (mock /models endpoint, zero token) — happy path (de-dupe+sort + **metadata
  parse**: context_window/max_model_len→contextWindow, modalities/supports_vision→input,
  reasoning, display_name/max_output_tokens), reqId echo, authHeader=true sends Bearer /
  false sends none, bare /models 404 falls back to /v1, **Google format {models:[…]} parse**
  (strip models/ prefix + inputTokenLimit), empty baseUrl / illegal URL / non-http(s) /
  empty list / non-JSON / 404 error paths, concurrent requests do not mix reqIds.
- **clone-provider-test.mjs** (port 8965): protocol test for built-in provider "copy as
  custom" (zero token) — deepseek → deepseek-2 draft (api/baseUrl/model catalog come along,
  **apiKey/authHeader are absent**), clone does not persist (list_models_config unchanged),
  re-clone after save auto-avoids the id (deepseek-3), a provider with no baseUrl
  (opencode-go) is refused, unknown provider is refused, reqId echo. Must run after changing
  model-admin cloneProvider.
- **model-config-ui-test.mjs** (real Chrome headless): model-admin modal "auto-fetch model
  list" button E2E — fill the new-provider form with baseUrl/apiKey → after click the model
  rows auto-fill (3 rows mock-a/b/c) + success hint "fetched 3 models" + **metadata fill
  asserts** (contextWindow number box, text+image select, reasoning checkbox; rows with no
  metadata keep defaults); illegal baseUrl shows an inline error. Run after changing the
  model-config UI.
- **vision-bridge-test.mjs** (port 8945): vision-bridge end-to-end protocol test, **a local
  mock OpenAI-compatible API acting as both the main model and the vision model** (real
  calls, zero token): text-only main model + image-capable vision model (temp agent dir) →
  send a prompt with imageData and assert "using vision bridge" / "transcription complete"
  notices, mock received a vision request containing the image, attachment card
  mode=bridged and contains `<vision-bridge>` transcription text, thumbnail kept, **the
  same image reuses the cache and does not send a second vision request**, settings_state
  carries vision-bridge fields and the model list, **a specified transcription model takes
  effect** (after setting visionBridgeModel the mock receives that model), **turning the
  vision bridge off warns and does not transcribe**. Must run after changing the vision
  bridge.
- **vision-bridge-ui-test.mjs**: vision-bridge settings-panel UI test (system Chrome
  headless): ⚙ open settings → vision-bridge block renders, toggle on by default, dropdown
  lists auto + every vision model, selecting a specific model is echoed back by the server,
  after turning off the dropdown hides and a disabled hint is shown.

## 6. Release process (GitHub + npm)

> The npm publisher account is `xingshuyin` (verify with `npm whoami`). `dist/` and
> `web/dist/` are gitignored and do not go into git, but the `package.json` `files`
> whitelist packs them into the npm package; `prepublishOnly` automatically runs
> `npm run build` before publish.

### Steps

```bash
# 1) Bump the version (patch/minor depending on the change; an already-published version on npm is 404-refused)
#    Edit both, keep them in sync:
#      package.json "version" and package-lock.json "version" (line 3 + packages[""])

# 2) Self-check + build
npm run typecheck
npm run build

# 3) Commit (Conventional Commits: feat/fix/perf/chore(scope): description, explain why)
git add -A
git commit -m "feat(files): <one-line description>"

# 4) Push GitHub (public repo: xing-shuyin/pi-web-ui, branch main)
git push origin main

# 5) Publish npm (automatically runs the prepublishOnly build)
npm publish

# 6) Verify
npm view pi-web-ui version        # should show the new version (registry cache lag is normal)
curl -s https://registry.npmjs.org/pi-web-ui/latest | jq .version
```

### Notes

- The version **must** be higher than what is already on the npm registry (currently `0.29.x`).
- Commit messages must not include `Co-authored-by` (P1 rule; the repo hook will block it).
- `.pi/commands.json` is **per-project** personal commands (under the current cwd's `.pi/`), already gitignored, and will never enter the public repo;
  switching cwd auto-refreshes the command list to that project's commands.
- Before publishing a large change, ask the user whether to `npm publish` (it really consumes account permissions and triggers a build).
- **Restart after upgrade**: `npm i -g` only updates files on disk; the already-running process still has the old code in memory — the frontend is read from disk on every request (it will look new first), but WS message handling is the in-process old logic; mixed new/old looks like "the UI is new, some feature stays loading". In-UI "Update now" (top-bar update dropdown) now runs `npm i -g pi-web-ui@latest` in a visible terminal tab (same tab pattern as SCM / plugin uninstall); after that the service must be restarted by hand to take effect: `pi-web-ui server restart` (launchd/systemd is pulled up by the service manager).
  The server keeps a `PI_WEB_RESTART_CHILD` port waiting for a handshake (restart-handoff-test regression) for externally orchestrated replacement children.
- **Before publish, check sample files do not leak secrets**: files shipped with the repo such as README **must never contain real IPs / domains / keys** — use placeholders (`<LAN_IP>`, `<PUBLIC_IP>:<PUBLIC_PORT>`, `your-host`). Real environment config is changed only locally and does not enter the repo.
- **How to scrub historically leaked IPs** (done in 2026-08; old `deploy/nginx-subpath.conf` once contained `192.168.1.101` / `39.99.235.208:60018`, affecting 53/128 commits):
  1. First change the working-tree files to placeholders;
  2. `git filter-branch --force --index-filter 'if git cat-file -e :<file> 2>/dev/null; then BLOB=$(git cat-file blob :<file> | sed -e "s/<old-IP>/<placeholder>/g" ... | git hash-object -w --stdin); git update-index --cacheinfo "100644,$BLOB,<file>"; fi' -- --all` (**do not pass cacheinfo via xargs** — on Git for Windows the args fragment and you get `option 'cacheinfo' expects <mode>,<sha1>,<path>`);
  3. After rewrite, **manually move tags onto the rewritten commits** (`git tag -f vX.Y.Z $(git log main --format='%h %s' | grep -F '<tag-message>' | head -1 | cut -d' ' -f1)`; filter-branch does not follow tags automatically);
  4. Delete backup branches + `rm -rf .git/refs/original` + `git reflog expire --expire=now --all` + `git gc --prune=now --aggressive`;
  5. Verify `git rev-list --all | while read c; do git grep -l '<IP>' $c -- . 2>/dev/null; done` is empty, then `git push --force` main + tags.
  **Residue reminder**: already-published npm tarballs cannot be recalled (only a new version can replace them); old objects overwritten by a GitHub force-push are invisible to visitors but remain on the server (contact GitHub support for a hard delete).

## 7. Environment variables

| Variable | Default | Role |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `PI_WEB_CWD` | `process.cwd()` | Agent workspace (read/write/terminal all rooted here) |
| `PI_WEB_DATA_DIR` | `~/.pi-web` | Per-client persisted UI state (client-state.json, recent projects/working directory); conversations live in the SDK default dir `<agentDir>/sessions/--<cwd>--/` (same conversation list as pi CLI/TUI) |
| `PI_WEB_INLINE_FILE_MAX` | `12288` (12KB) | Inline-attachment inlining threshold; over that, auto-downgrade to a path reference |
| `PI_WEB_TOOL_TIMEOUT_MS` | `1200000` (20 min) | Max duration of a single tool call; the timeout watchdog auto-aborts the session (prevents hangs) |
| `PI_WEB_VISION_TIMEOUT_MS` | `90000` | Vision-bridge single transcription (whole image batch) timeout, so a slow vision model cannot stall a prompt |
| `PI_WEB_STALL_NOTIFY_MS` | `180000` | Model no-progress watchdog: if a streaming run has no SDK events for N ms, send a warning that it may be disconnected (does not auto-abort — deep thinking can legally be silent for minutes); 0 = off |
| `PI_WEB_TERMINAL_IDLE_MS` | `15000` | Terminal liveness: an agent-touched terminal (terminal_create/input/key) with N ms of no output while that conversation is running auto-injects a steer reminding the AI to check (one-shot; the agent must touch again to restart the timer); 0 = off |
| `PI_WEB_UPLOAD_RETENTION_DAYS` | `14` | Upload retention days (`<dataDir>/uploads/`, one scan at start + every 6 hours); 0 = disable cleanup |
| `PI_WEB_SHELL` | auto-detect | Shell for the Windows terminal panel (node-pty): Git Bash first by default (same as the SDK bash tool); this variable can pin it (`powershell.exe` / `cmd.exe`) |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi config directory (auth.json / models.json / skills) |
| `PI_WEB_HOST` | `127.0.0.1` | Listen address. **Bind loopback by default** (local personal tool, not exposed to the network); LAN access requires an explicit `0.0.0.0` |
| `PI_WEB_ALLOW_ORIGINS` | empty | Comma-separated extra Origin whitelist (e.g. `http://localhost:5173` for the dev proxy, reverse-proxy setups), used to bypass the WS Origin/Host same-authority check |
| `PI_WEB_ALLOW_HOSTS` | empty | Optional strict mode: enabled only when set; the request Host hostname must be in this whitelist (comma-separated) |
| `PI_WEB_TOKEN` | empty | **Optional shared-token auth**: when set, every HTTP/WS request must carry it (`Authorization: Bearer` / `X-PI-Token` header, `?token=` query, or `pi_web_token` cookie — any match; the browser first enters via `?token=xxx`, then stores localStorage and sets an HttpOnly cookie); `/api/health` stays open for probes. Frontend injects via `web/src/auth-token.ts`; regression: `tests/token-auth-test.mjs` (port 8975) |

## 8. Deploy (cheat sheet)

This fork's daily path is `npm run dev` / `npm start` in the repo. It does not publish an Electron desktop package and does not maintain Docker.

```bash
npm run dev                                 # Vite :5173 + server :8788
npm run build && npm start                  # Production build, default :8787
pi-web-ui --port 9000 --cwd /path          # Foreground
pi-web-ui install <source> [--name --force --data-dir]  # Install a GitHub UI plugin into <dataDir>/plugins/
#                                source: owner/repo · https://github.com/o/r[/tree/branch/subdir] · #branch · local dir; refresh the browser to take effect
pi-web-ui plugins / uninstall <id>          # List / uninstall UI plugins
pi-web-ui plugins --check-updates          # Compare remote HEAD one by one; list updatable plugins
pi-web-ui plugins --rollback <id>          # Roll back to the latest pre-update backup (<dataDir>/plugin-backups/)
pi-web-ui server install [--port --cwd --data-dir --name]   # Start on login:
                                           #   macOS→launchd (no sudo)
                                           #   Linux→systemd (auto sudo)
                                           #   Windows→scheduled task (start on login, hidden window, no console)
pi-web-ui server shortcut [--port --cwd --data-dir --name]  # Desktop "one-click start" icon (start the service and open the browser):
                                           #   Windows→desktop .lnk (WScript.Shell COM, OneDrive-safe; if the service is not running,
                                           #     start it in this hidden-window foreground and record the PID; server stop/uninstall can stop it)
                                           #   macOS→desktop .command double-click launcher (kickstart if launchd is installed, otherwise foreground in a terminal)
                                           #   Linux→desktop .desktop icon + ~/.local/share/pi-web-ui launch script (systemctl preferred)
pi-web-ui server status|restart|stop|uninstall
```
> uninstall also removes the desktop icon; instances started by the desktop shortcut when no service is installed are reported separately in status/stop (PS1 foreground + recorded PID).

## 9. Common pitfalls

- **Changed `protocol.ts` but forgot to add a branch in both ends' dispatch/onmessage switch** → the frontend receives an unknown message type that the switch silently drops, looking like "nothing happened" (types.ts is already a re-export shim so the type layer cannot drift, but switch branches still have to be added by hand). Run `npm run typecheck` first.
- **Snapshot 60ms throttle**: while debugging, `get_state` can push immediately (`cs.flushSnapshot()`).
- **snapshot send backpressure (issue #11)**: `send()` in `index.ts` checks `ws.bufferedAmount` **before** serializing; over `max(256KB, 3× last snapshot byte size)` it drops the snapshot (full snapshots are idempotent and another will follow; ready/notice/error etc. must be delivered). A long session's full snapshot string is ~10MB; without backpressure a low-memory host OOMs on piled-up temporary strings. Every ws connection registers an error handler (illegal frames no longer crash the process).
  **Absolute floor + drop-and-retry (small-session false-positive fix)**: the relative threshold is only a few KB on a small session — a normal burst of settings_state/slash_commands can push bufferedAmount over the limit and silently drop the snapshot_delta that follows; if no further events arrive there is never a new snapshot and the client stays on the old state forever (the frontend self-heals via a rev-gap get_state; protocol tests hang outright; conv-cwd-test used to false-fail this way). Now a drop schedules `snapshotRetryTimer` (250ms later cs.flushSnapshot retries; if the buffer is still not drained, it postpones again), cleaned up on close.
- **Commands before `hello` / before the session is ready**: the `pending` queue in `server/index.ts` buffers them and replays after attach.
- **clientId is per-tab (issue #10)**: frontend `getClientId()` lives in sessionStorage (not localStorage); same-origin multiple tabs are independent clients — sharing a clientId used to hit the same backend ClientSession, so switching conversations on tab B would force-interrupt a running agent on tab A. Regression: `tests/multi-tab-test.mjs` (browser E2E).
- **Half-open sockets**: server 10s heartbeat; client disconnects and reconnects after 30s with no message (exponential backoff 1s→10s).
- **Preview and attachment line numbers**: `countLines` does not count a trailing newline; after frontend `split("\n")` also pop the trailing empty string.
- **Terminal shell (Windows)**: `resolveShell()` in `terminals.ts` is resolved every time a terminal is created, bash first — `PI_WEB_SHELL` explicit → `$SHELL` → Git Bash (ProgramFiles) → busybox fallback (`~/.pi-web/bin/bash.exe`, `ensure-bash.ts` auto-downloads busybox-w32 when Git Bash is missing) → `$COMSPEC` → powershell. Stay consistent with the SDK bash tool (Git Bash / bash on PATH) so a PowerShell/bash mix cannot hang.
- **Legacy Chinese Windows file mojibake**: preview / inline attachments / line attachments all go through `decodeText` (strict UTF-8 fail → GBK → latin1); on win32 `makeRuntimeFactory` injects `WINDOWS_PERSONA` via `resourceLoaderOptions.systemPromptOverride`, constraining the model: the bash tool must carry a timeout (the SDK has no default), no heredoc / interactive / long-running foreground commands (prevents overnight hangs); GBK files are read in the terminal with the correct encoding (iconv / chcp / Get-Content -Encoding Default) and garbled text is never pasted into reasoning/replies.
- **Tool-hang watchdog**: every `tool_execution_start` arms a `TOOL_WATCHDOG_TIMEOUT_MS` timer for that toolCallId (default 20 minutes, override with env `PI_WEB_TOOL_TIMEOUT_MS` in ms) — if still running at timeout, `session.abort()` (kill the process tree) + a warning notice; `tool_execution_end` / `removeConversation` / `dispose` all clear the matching timer.
	Recover by rebuild + rebind the session (same conv record, UI stays connected); watchdog timeout also goes through the same `interruptRun`.
	**Stop the run only; do not touch background services**: abort no longer also kills AI-started services — those are managed separately by the "Background tasks" panel.
- **Background-task list (top-bar "Background tasks" button, replacing the old "Interrupt" button)**: the bash tool takes a listening-port snapshot before and after (`snapshotListeningPorts`, Windows netstat / POSIX lsof); newly LISTENING processes from the diff are recorded in `bgServers` (port→pid→since→name; name is best-effort via `lookupProcessName` tasklist/ps); after start a notice says they can be stopped individually or all at once from the top-bar "Background tasks"; **the list is persisted per client** (a ClientSession field, not per conversation) — conversation end/switch/reconnect does not clear it (attachSink re-pushes `bg_servers`); an item is removed only when it is stopped or the process exits on its own (a 30s timer `refreshBgServers` re-snapshots ports; port+pid both matching counts as still alive; dead items are silently dropped).
  Protocol: `bg_servers` (ServerMessage, full list push) / `kill_background_server` (stop one by port) / `kill_background_servers` (stop all; `killAllBackgroundServers` `killPidTree`s each pid, Windows `taskkill /F /T`) / `list_bg_servers` (refresh requested when the panel opens); frontend `BgTasksModal` (per-row "Stop" + bottom "Stop all" / "Refresh"; empty list has placeholder copy).
- **Stop only the bash command (conversation continues)**: a running bash-tool card shows "Stop" → send `{ type: "abort_bash" }` → `ClientSession.abortBash()`. The server uses a **killable bash tool** (`makeKillableBashTool`, overlaying the SDK built-in bash by name via `customTools`): on execute it registers its AbortController into the client-level `bashKills` set; abort kills only those controllers → the bash child process tree is killed (the tool throws "Command aborted", caught by the agent-loop as a tool-error result) → **the agent run and the conversation continue**; unlike SDK `session.abortBash()` (only effective on the extension `executeBash` path, not the agent-tool path), this actually works for in-conversation bash tool calls (verified against the SDK directly: sleep 30 is killed within 1.5s and the registry is cleaned).
  When a command is aborted the SDK concatenates **output produced before the kill into the tool-error result** (the AI sees the output + "Command aborted"); then `abortBash()` `sendUserMessage`s a "user stopped this manually" hint so the AI knows it was manual, not a failure.
- **Playwright scripts**: the headless-shell path is hardcoded to this machine; CI / another machine needs the `HEADLESS` constant changed.
- **Do not call `process.exit` directly inside a try in test scripts**: `process.exit` skips `finally`, so the spawned server is never killed → every run leaks a process, and the next run of the same-port test reports "port busy — abort" (steer-queue-smoke hit this; fixed: set an ok flag + kill in finally and wait for the port to free before exit).

---
*When structure or process changes, update this file in the same change (including new components, protocol messages, and release steps).*
