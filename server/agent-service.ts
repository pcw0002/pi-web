/**
 * AgentService — wraps the pi SDK (@earendil-works/pi-coding-agent) for the web
 * frontend. Each browser client (identified by a persistent clientId) gets its
 * own AgentSessionRuntime, but sessions live in the SDK default per-project
 * directory (<agentDir>/sessions/--<cwd>--/) — the same transcript files the
 * pi CLI/TUI use — so every conversation of a folder shows up everywhere.
 *
 * Streaming model: the SDK emits AgentSessionEvents; we forward lightweight
 * `tool_delta` messages for live tool output and schedule throttled full-state
 * snapshots. The frontend is snapshot-driven (server is the source of truth),
 * so reconnects just re-request a snapshot.
 */
import { spawn } from "node:child_process";
import {
	existsSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
	mkdirSync,
	watch,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createBashTool,
	createLocalBashOperations,
	defineTool,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	VERSION,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BgServerTracker } from "./bg-servers.js";
import type { PluginAgentTool, PluginCommandDef, PluginToolEvent } from "./plugins.js";
import { syncPluginToolsIntoSession } from "./plugins.js";
import { SettingsService } from "./settings-service.js";
import { GoalService } from "./goal-service.js";
import { SlashCommandsService, parseSlash } from "./slash-commands.js";
import { ModelAdminService } from "./model-admin.js";
import { FilesService, workspacePath } from "./files-service.js";
import {
	isExtensionDisabled,
	type PromptMode,
	ClientStateStore,
} from "./client-state.js";
import { saveUpload } from "./uploads.js";
import {
	makePersistentTerminalTools,
	makeTerminalBashTool,
	stripAnsi,
	TERMINAL_TOOLS_GUIDANCE,
	TERMINAL_TOOL_NAMES,
} from "./terminals.js";
import { WebUIContext } from "./webui-context.js";
import {
	buildAttachmentMessages,
	parseModelSpec,
} from "./attachments.js";
import type {
		BgServer,
		CommandDef,
		ConversationSummary,
		FileEntry,
		GoalStatus,
		ProjectSummary,
		ServerMessage,
		SessionSummary,
		UiMessage,
		UiModelConfigEntry,
		UiProviderConfig,
		UiSettingsState,
		UiVisionBridgeModel,
		UiState,
} from "./protocol.js";
import {
	serializeMessage,
	serializeStreamingMessage,
	type AgentMessage,
} from "./serialize.js";
import {
	loadCommands,
	saveCommandsFile,
	TerminalManager,
} from "./terminals.js";
import {
	buildVisionBridgePrompt,
	SYSTEM_PROMPT,
	transcribeImages,
} from "./vision-bridge.js";

const SNAPSHOT_INTERVAL_MS = 60;
/** While assistant deltas are flowing, live rendering is carried by
 *  message_delta — full snapshots become pure reconciliation checkpoints, so
 *  send them on a slow event-driven cadence (see flushSnapshot call-sites:
 *  agent_end / tool_execution_end always checkpoint immediately). */
const STREAMING_SNAPSHOT_INTERVAL_MS = 2000;
/** Deltas newer than this keep the streaming (low-frequency) snapshot cadence. */
const DELTA_ACTIVE_WINDOW_MS = 1500;
const WIDGET_REFRESH_MS = 2000;
/** Model-stall watchdog: warn (don't abort — deep thinking can be legitimately
 *  quiet for minutes) when a streaming run produced NO SDK events for this long.
 *  Covers the failure class the per-tool watchdog cannot see: half-open API
 *  connections / hung proxies where no tool is running and no error is thrown.
 *  Override: PI_WEB_STALL_NOTIFY_MS (milliseconds; 0 disables). */
const STALL_NOTIFY_MS = (() => {
	const v = Number(process.env.PI_WEB_STALL_NOTIFY_MS);
	return Number.isFinite(v) && v >= 0 ? v : 180_000;
})();
/** Serialization-cache cap per conversation (see serializeCached): cached
 *  UiMessage objects are pure-function results, so eviction only costs a
 *  recompute on next access. Bounds memory for marathon sessions. */
const UI_MESSAGE_CACHE_CAP = 4096;
/** Preview panel cap: only the first 512KB of a file is ever read/sent. */

/** Thrown when the service is quiesced (draining) and the request is NEW work
 *  the admission controller refuses: a brand-new client attach, a prompt,
 *  a fork, a session resume, or a goal wizard start. index.ts closes the
 *  WebSocket with 4403 so the browser reconnect loop can retry after the
 *  server reopens admission (see AgentService.quiesce). */
export class QuiesceRejectedError extends Error {
	readonly code = "QUIESCED";
	constructor(detail: string) {
		super(`Server is draining (quiesce) — ${detail}`);
		this.name = "QuiesceRejectedError";
	}
}

// ---------------------------------------------------------------------------
// Preview kind classification. The preview panel only opens image / video /
// text-editable files; everything else (exe, jar, archives, …) is refused so
// it is never read or sent to the browser. Media files are served over the
// /api/file HTTP endpoint instead of the WebSocket, so they are classified
// here but never read into the snapshot path.
// ---------------------------------------------------------------------------


/** Windows persona appendix — appended to the SDK system prompt on win32 only.
 *  Two failure modes it guards against: (1) the SDK bash tool has NO default
 *  timeout, so a long-running command hangs the whole conversation forever;
 *  (2) the in-app terminal is an interactive TTY where heredocs / interactive
 *  programs wait for input that never comes. Legacy Chinese files are often
 *  GBK/GB2312 — read them with the right encoding, never paste mojibake into
 *  reasoning/answers. */
const WINDOWS_PERSONA = `You are a coding agent running on Windows. The bash tool runs Git Bash (bash.exe), not PowerShell. Follow these rules to avoid hanging the session:



- ALWAYS pass a timeout parameter to the bash tool (in seconds). There is NO default timeout — a command that never finishes (servers, watchers, infinite loops, slow downloads/installs) will hang the entire conversation indefinitely. Pick a generous timeout for long-running work, but never omit it.
- NEVER run interactive or foreground long-running commands through the bash tool (vi, less, top, python -, node -, npm run dev, sleep 10000). For servers/daemons use background execution with output redirected to a log file, then poll the log; stop them when done.
- In the interactive terminal (TTY) — which is Git Bash too, not PowerShell — NEVER use heredocs (<<'EOF' ... EOF) or here-strings, and NEVER start interactive programs (vi, less, python -, node -, npm init): they wait for keyboard input that never arrives and hang the terminal forever. Prefer writing a temp script file (e.g. .pi-tmp.sh) and running it non-interactively. ALWAYS pass a timeout to long-running commands (e.g. \`timeout 120 npm run dev\`).

Many legacy Chinese text files (.html/.txt/.md/.log, exported documents) are GBK/GB2312 encoded: the read tool decodes UTF-8 only and will show mojibake for them. If a file's content looks garbled, read it through the terminal instead: in Git Bash use \`cat file | iconv -f GBK -t UTF-8\` (or \`iconv -f GBK -t UTF-8 file\`); in cmd use \`chcp 65001 && type file\`; in PowerShell use \`Get-Content -Encoding Default file\`. Never paste mojibake into your reasoning or answer — describe the decoded content instead.`;
/**
 * Killable bash tool: wraps the SDK bash tool with operations that register
 * their own AbortController into a client-level set. abortBash() aborts only
 * those controllers → the command's process tree is killed while the agent
 * run and the conversation continue (the tool returns an aborted error and
 * the model moves on). Injected as a customTool overriding the builtin bash.
 */
function makeKillableBashTool(
	cwd: string,
	kills: Set<AbortController>,
): ToolDefinition {
	const base = createLocalBashOperations();
	const tool = createBashTool(cwd, {
		operations: {
			exec: async (command, c, opts) => {
				const ac = new AbortController();
				kills.add(ac);
				try {
					const signals = [opts.signal, ac.signal].filter(
						(s): s is AbortSignal => s !== undefined,
					);
					return await base.exec(command, c, {
						...opts,
						signal:
							signals.length > 1 ? AbortSignal.any(signals) : signals[0],
					});
				} finally {
					kills.delete(ac);
				}
			},
		},
	});
	// AgentTool → ToolDefinition (same fields; customTools expects definitions).
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: (toolCallId, params, signal, onUpdate) =>
			tool.execute(
				toolCallId,
				params as { command: string; timeout?: number },
				signal,
				onUpdate,
			),
	} as ToolDefinition;
}

/**
 * Dynamic bash dispatch: at call time the setting picks which implementation
 * runs — so the "terminal-backed bash" toggle takes effect immediately
 * (customTools is fixed when the runtime is created, so you cannot pick one at creation).
 */
function makeAdaptiveBashTool(
	killable: ToolDefinition,
	terminalBacked: ToolDefinition,
	useTerminal: () => boolean,
): ToolDefinition {
	return {
		...killable,
		execute: (id, params, signal, onUpdate, ctx) =>
			(useTerminal() ? terminalBacked : killable).execute(
				id,
				params as never,
				signal,
				onUpdate,
				ctx,
			),
	};
}

/**
 * Plugin structured tool → SDK ToolDefinition.
 * execute return values are handled permissively: {content,details} is taken as-is; a string/object is wrapped as a text block.
 */
function pluginToolToDefinition(tool: PluginAgentTool): ToolDefinition {
	const normalize = (result: unknown): {
		content: Array<{ type: "text"; text: string }>;
		details?: unknown;
	} => {
		if (
			result &&
			typeof result === "object" &&
			Array.isArray((result as { content?: unknown }).content)
		) {
			return result as {
				content: Array<{ type: "text"; text: string }>;
				details?: unknown;
			};
		}
		const text =
			typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2);
		return { content: [{ type: "text", text }] };
	};
	return {
		name: tool.name,
		label: tool.label ?? tool.name,
		description: tool.description,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
		parameters: (tool.parameters ?? {
			type: "object",
			properties: {},
		}) as ToolDefinition["parameters"],
		execute: async (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((partial: unknown) => void) | undefined,
		) => {
			const raw = await tool.execute(
				toolCallId,
				params as Record<string, unknown>,
				signal,
				onUpdate
					? (partial) => onUpdate(normalize(partial) as never)
					: undefined,
			);
			return normalize(raw) as never;
		},
	} as unknown as ToolDefinition;
}


/**
 * Cheap per-message discriminator for the serialization cache key. Persisted
 * message content never changes, so this is stable across snapshots, while
 * several same-role messages created within one millisecond (attachment
 * asides) get distinct keys. Text blocks are fingerprinted by a short hash of
 * their head (paths embedded in <file> tags can share long prefixes — e.g.
 * uploads created in the same millisecond differ only at the tail); image
 * payloads by data length (identical lengths within the same ms are far too
 * unlikely to matter).
 */
function contentFingerprint(m: AgentMessage): string {
	const content = (m as unknown as { content?: unknown }).content;
	if (!Array.isArray(content) || content.length === 0) return "empty";
	const first = content[0] as { type?: string; text?: string; data?: string };
	if (first?.type === "image") {
		return `img:${(first.data ?? "").length}`;
	}
	const text = typeof first?.text === "string" ? first.text : "";
	// djb2 — fast enough to run per snapshot, distinct enough for asides.
	let h = 5381;
	for (let i = 0; i < text.length && i < 512; i++) {
		h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
	}
	return `txt:${h.toString(36)}:${text.length}`;
}

// ---------------------------------------------------------------------------
// Web UI context adapter — bridges extension UI calls (setWidget/notify) to the
// browser. Extensions like rpiv-todo render a TUI widget via
// `ui.setWidget(key, (tui, theme) => comp)`; we capture the component, render it
// with a mock theme to plain text lines, and push them to the client.
// ---------------------------------------------------------------------------



function extractPartialText(partial: unknown): string | null {
	const content = (partial as { content?: unknown } | null | undefined)
		?.content;
	if (Array.isArray(content)) {
		const text = content
			.map((c) =>
				(c as { type?: string; text?: string })?.type === "text"
					? (c as { text: string }).text
					: "",
			)
			.join("");
		return text.length > 0 ? text : null;
	}
	return null;
}

export { workspacePath };
// ---------------------------------------------------------------------------
// Per-client persisted UI state (<dataDir>/client-state.json)
// ---------------------------------------------------------------------------

/**
 * One open conversation (chat thread) of a client. Each conversation owns its
 * OWN AgentSessionRuntime, so starting a new chat or switching between chats
 * never interrupts another conversation's in-flight run.
 */
interface Conversation {
	id: string;
	/** Display title: first user prompt (truncated) or the default. */
	title: string;
	runtime: AgentSessionRuntime;
	session: AgentSession;
	cwd: string;
	createdAt: number;
	/** In the per-project "running conversations" list. A conversation enters
	 *  the list when it is displaced to the background while still streaming;
	 *  it leaves (and its runtime is freed) when it is opened again and left
	 *  without continuing. */
	listed: boolean;
	/** A prompt was sent while this conversation was active (cleared whenever
	 *  it becomes active). A listed conversation that is displaced while idle
	 *  with this still false counts as "opened but not continued" and is
	 *  dismissed from the list. */
	promptedSinceActive: boolean;
	/** Last time this conversation became active — set_cwd picks the target
	 *  project's most recently active conversation. */
	lastActiveAt: number;
	/** Last time ANY SDK event arrived for this conversation — drives the
	 *  model-stall watchdog (#7): a run that produces no events at all for
	 *  STALL_NOTIFY_MS is probably a half-open API connection. */
	lastSdkEventAt: number;
	/** Set once the stall notice has been sent for the current silent period;
	 *  cleared on every SDK event and on each new prompt. */
	stallNoticed: boolean;
	/** Independent goal/review state for this conversation. */
	goal: GoalStatus;
	goalGeneration: number;
	goalReviewGeneration: number;
	/** Wizard execution is per conversation; dialog transport itself remains
	 * client-wide because the browser can display one dialog at a time. */
	wizardRunning: boolean;
	/** Session event subscription — events are routed to THIS conversation. */
	unsubscribe?: () => void;
	/** Monotonic sequence for message_delta/tool_delta pushes of this conversation —
	 *  a gap on the client triggers a get_state resync. */
	deltaSeq: number;
	/** PTYs belong to the conversation, not the browser socket or client. */
	terminals: TerminalManager;
	// Per-conversation serialization caches. Message ids derive from
	// (role, timestamp); two conversations can produce identical pairs, so
	// these must never be shared across conversations.
	msgIds: Map<string, number>;
	nextMsgId: number;
	/** Per-timestamp 1-based user-message seq (drives the `u-<ts>-<seq>` id suffix). */
	userSeqByTs: Map<number, number>;
	uiMessageCache: Map<string, UiMessage>;
	lastMessagesSig: string;
	lastMessagesArray: UiMessage[];
	/** Actual queued prompt TEXTS (steer = cut in, followUp = queued) — the UI
	 *  renders them as pending bubbles in the real message list. */
	queueSteering: string[];
	queueFollowUp: string[];
	/** tool_execution_start timestamps keyed by toolCallId — lets tool_status
	 *  report how long a tool actually ran (vs. waiting on the model). */
	toolStartTimes: Map<string, number>;
	/** tool_call watchdog timers keyed by toolCallId — a tool that runs past
	 *  TOOL_WATCHDOG_TIMEOUT_MS gets the session aborted instead of hanging
	 *  the conversation forever (the SDK bash tool has no default timeout). */
	toolWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
}

/** Hard cap on how long ONE tool call may run before the watchdog aborts the
 *  session. The SDK bash tool has NO default timeout, so a command that never
 *  finishes (servers, watchers, infinite loops) would otherwise hang the whole
 *  conversation indefinitely. Override with the PI_WEB_TOOL_TIMEOUT_MS env var
 *  (milliseconds). */
const TOOL_WATCHDOG_TIMEOUT_MS = (() => {
	const v = Number(process.env.PI_WEB_TOOL_TIMEOUT_MS);
	return Number.isFinite(v) && v > 0 ? v : 20 * 60_000;
})();

/** Cap on simultaneously open conversations of ONE project (each keeps a full
 *  runtime alive; conversations of other projects keep their own lists). */
const MAX_OPEN_CONVERSATIONS = 8;
const DEFAULT_CONV_TITLE = "New chat";


/** First user text in a session, truncated for the conversation list. */
function conversationTitle(session: AgentSession): string {
	try {
		for (const m of session.agent.state.messages) {
			if (m.role !== "user") continue;
			const content = m.content as unknown;
			let text = "";
			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				for (const p of content) {
					if (
						p &&
						typeof p === "object" &&
						(p as { type?: unknown }).type === "text" &&
						typeof (p as { text?: unknown }).text === "string"
					) {
						text = (p as { text: string }).text;
						break;
					}
				}
			}
			const trimmed = text.trim().replace(/\s+/g, " ");
			if (trimmed.length > 0) {
				return trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
			}
		}
	} catch {
		// best-effort
	}
	return DEFAULT_CONV_TITLE;
}

export class ClientSession {
	readonly clientId: string;
	/** Set by AgentService.attach: reflects the SERVICE-wide quiesce flag
	 *  (server draining — new work rejected). Default false for direct use. */
	isQuiesced: () => boolean = () => false;
	cwd: string;
	/** pi config dir (auth/models/skills). */
	private readonly agentDir: string;
	/** Persisted per-client UI state (last workspace + recent projects). */
	private readonly stateStore: ClientStateStore;
	/** Open conversations — each owns its OWN runtime, so starting a new chat
	 *  or switching chats never interrupts an in-flight run. `runtime` and
	 *  `session` accessors below target the ACTIVE conversation. */
	private convs = new Map<string, Conversation>();
	private activeId = "";
	private convSeq = 0;
	/** One ModelRuntime shared by all conversations — the model chosen in the
	 *  top bar applies to every chat, not just the one that set it. Seeded by
	 *  the first conversation and reused by later ones. */
	private sharedModelRuntime:
		| Awaited<ReturnType<typeof createAgentSessionServices>>["modelRuntime"]
		| undefined;

	// -----------------------------------------------------------------------
	// Goal / review / wizard — self-contained module, see goal-service.ts. Each
	// conversation has its own GoalStatus; reviews can run concurrently. Host callbacks are wired in the constructor.
	// -----------------------------------------------------------------------
	private readonly goalSvc: GoalService;
	/** Settings-panel state (system prompt + disabled skills/extensions) —
	 *  Self-contained module, see settings-service.ts. resource-loader overrides
	 *  read the latest current values on every reload(), so session.reload() applies them to the running runtime. */
	private settingsSvc!: SettingsService; // created in the constructor (needs clientId/stateStore)
	/** How long a hard abort waits for session.abort() to make the run idle
	 *  before force-resetting the conversation (model streams that ignore the
	 *  abort signal would otherwise leave the chat stuck forever). */
	private static readonly HARD_ABORT_TIMEOUT_MS = 15_000;
	/** Extra settle window after session.abort() returns: the run is only
	 *  considered stopped once its agent_end event arrives. If it doesn't
	 *  (model stream stuck before the run even started), force-reset. */
	private static readonly HARD_ABORT_SETTLE_MS = 8_000;
	/** Live AbortControllers of THIS client's running bash tool calls — aborting
	 *  them kills only the command (agent run and conversation continue). */
	private bashKills = new Set<AbortController>();
	/** Background-server tracking (port snapshots + background-tasks panel state) —
	 *  self-contained module, see bg-servers.ts. The list lives per CLIENT and survives conversation switches/ends. */
	/** File tree / preview R/W / SCM queries / watcher — self-contained module, see files-service.ts. */
	private readonly files = new FilesService({
		emit: (msg) => this.emit(msg),
		isDisposed: () => this.disposed,
		getCwd: () => this.cwd,
		getActiveCwd: () => this.conv?.cwd ?? this.cwd,
	});
	private readonly bg = new BgServerTracker({
		emit: (msg) => this.emit(msg),
		flushSnapshot: () => this.flushSnapshot(),
		isDisposed: () => this.disposed,
		// Plugin-registered resident tasks (host.registerBackgroundTask) are folded into the same background-tasks panel.
		pluginTasks: () => this.pluginBgTasksProvider?.() ?? [],
	});

	/** Injected by index.ts (copied onto every new session via AgentService): forward
	 *  SDK tool-execution events to plugins (PluginManager.emitToolEvent). No-op when unset. */
	onToolEvent: ((ev: PluginToolEvent) => void) | undefined = undefined;
	/** Injected by index.ts: read AI tools currently registered by plugins (copied onto every new session at attach). */
	pluginToolsProvider: (() => PluginAgentTool[]) | undefined = undefined;
	/** Injected by index.ts: read slash commands currently registered by plugins (catalog display + prompt intercept). */
	pluginCommandsProvider: (() => PluginCommandDef[]) | undefined = undefined;
	/** Injected by index.ts: read resident background tasks registered by plugins (folded into the bg_servers panel). */
	pluginBgTasksProvider: (() => BgServer[]) | undefined = undefined;
	/** Injected by index.ts: stop a plugin task (kill_background_server with taskId). */
	pluginStopBgTask: ((taskId: string) => boolean) | undefined = undefined;
	/** Plugin tool names injected into the session last round (used to detect unregister/remove). */
	private appliedPluginToolNames = new Set<string>();

	/** The active conversation (all session operations target it). */
	private get conv(): Conversation {
		const conv = this.convs.get(this.activeId);
		if (!conv) throw new Error("no active conversation");
		return conv;
	}
	/** Runtime of the active conversation. */
	get runtime(): AgentSessionRuntime {
		return this.conv.runtime;
	}
	/** Session of the active conversation. */
	get session(): AgentSession {
		return this.conv.session;
	}

	/** PTYs are owned by individual conversations; this getter targets the active one
	 * for compatibility with the existing terminal-panel dispatch path. */
	get terminals(): TerminalManager {
		return this.conv.terminals;
	}

	getTerminalManager(conversationId?: string): TerminalManager | undefined {
		return (conversationId ? this.convs.get(conversationId) : this.conv)?.terminals;
	}

	getTerminalCwd(conversationId?: string): string {
		return (conversationId ? this.convs.get(conversationId) : this.conv)?.cwd ?? this.cwd;
	}

	private makeTerminalManager(conversationId: string, cwd: string): TerminalManager {
		const mgr = new TerminalManager((msg) => this.emitTerminal(conversationId, msg), cwd);
		// Terminal liveness: when a terminal the AI has touched is silent for ≥ the
		// threshold (PI_WEB_TERMINAL_IDLE_MS, default 15s) and this conversation is
		// running, inject a steer message so the AI goes and checks.
		mgr.onAgentIdle = (terminalId, idleMs, title) =>
			this.notifyTerminalIdle(conversationId, terminalId, idleMs, title);
		return mgr;
	}

	/** Terminal liveness nudge: injected only while this conversation is streaming
	 *  (sendUserMessage mid-stream is steer semantics — delivered after the current
	 *  turn settles, the agent responds immediately); idle conversations are left alone.
	 *  One-shot semantics are guaranteed by TerminalManager (disarmed after firing;
	 *  the agent must touch the terminal again to restart the timer), so it will not spam. */
	private notifyTerminalIdle(
		conversationId: string,
		terminalId: string,
		idleMs: number,
		title: string,
	): void {
		const conv = this.convs.get(conversationId);
		if (!conv || this.disposed) return;
		if (!conv.runtime.session.isStreaming) return;
		const seconds = Math.max(1, Math.round(idleMs / 1000));
		void conv.runtime.session
			.sendUserMessage(
				`(System: the terminal "${title}" you started has had no new output for ${seconds} seconds.` +
					`It may be waiting for input, stuck, or hung. Use terminal_read to check;` +
					`if it needs input, use terminal_input / terminal_key; if you are done, terminal_close it.)`,
			)
			.catch(() => {
				// best effort — a failed inject does not affect the terminal itself
			});
	}

	/**
	 * Completion notice after terminal-backed bash silently backgrounds: tell the AI
	 * when the command actually finishes. Mid-stream → sendUserMessage (steer, wake
	 * immediately); idle → sendCustomMessage nextTurn queue (does not wake the agent
	 * or spend tokens; it rides along on the next turn).
	 */
	private notifyTerminalBashDone(
		terminals: TerminalManager,
		info: { terminalId: string; command: string; exitCode: number | null },
	): void {
		const conv = [...this.convs.values()].find((c) => c.terminals === terminals);
		if (!conv || this.disposed) return;
		let tail = "";
		try {
			const end = terminals.endCursor(info.terminalId);
			if (end !== null) {
				tail = terminals.read(info.terminalId, Math.max(0, end - 4000))?.data ?? "";
			}
		} catch {
			// The terminal may already have been closed
		}
		const exitText =
			info.exitCode === null ? "terminal closed" : `exit code ${info.exitCode}`;
		const cmdShort = info.command.length > 120 ? `${info.command.slice(0, 120)}…` : info.command;
		const text =
			`(System: the command you left running in terminal ${info.terminalId} finished (${exitText}): ${cmdShort}\n` +
			`Last output:\n${stripAnsi(tail).trim() || "(no output)"})`;
		const session = conv.runtime.session;
		if (session.isStreaming) {
			void session.sendUserMessage(text).catch(() => {});
		} else {
			// Do not wake the agent while idle — queue as nextTurn context, visible on the next conversation automatically.
			void session
				.sendCustomMessage({
					customType: "terminal-bash-done",
					content: [{ type: "text", text }],
					display: true,
				})
				.catch(() => {});
		}
	}

	private emitTerminal(conversationId: string, msg: ServerMessage): void {
		// Background conversations keep collecting output in their own PTY buffer.
		// Do not stream it into the active xterm; push the retained window on switch.
		if (msg.type === "terminal_output" && conversationId !== this.activeId) return;
		if (msg.type === "terminal_output" || msg.type === "terminal_exit" || msg.type === "terminal_list") {
			this.emit({ ...msg, conversationId } as ServerMessage);
			return;
		}
		this.emit(msg);
	}

	private pushTerminals(conversation = this.conv): void {
		this.emit({
			type: "terminal_list",
			conversationId: conversation.id,
			terminals: conversation.terminals.list(),
		});
		for (const output of conversation.terminals.replay()) {
			this.emit({
				type: "terminal_output",
				conversationId: conversation.id,
				terminalId: output.terminalId,
				data: output.data,
			});
		}
	}

	/**
	 * Vision-bridge transcript cache (batch hash → text). A re-sent / re-asked
	 * prompt with the same images skips the vision API call entirely — editing
	 * a question doesn't re-burn tokens on re-transcribing identical screenshots.
	 */

	/** Most recent built-in (default) system prompt observed by the
	 *  resource-loader override — surfaced via settings_state so the
	 *  replace-mode editor can show the prompt it would otherwise replace.
	 *  Only non-empty when the user has a system-prompt file. */
	private lastBaseSystemPrompt = "";

	/** The system prompt the replace-mode editor should show as its seed:
	 *  the user's system-prompt file content if one exists, otherwise the
	 *  SDK's built-in default actually in effect (agent.state.systemPrompt,
	 *  which the loader rebuilds at session init). If the user HAS a custom
	 *  prompt the seed is only cosmetic — an unmodified seed is saved as
	 *  empty and the server falls back to the true base. */
	private effectiveDefaultSystemPrompt(): string {
		if (this.lastBaseSystemPrompt) return this.lastBaseSystemPrompt;
		try {
			const sp = this.session.agent.state.systemPrompt;
			if (typeof sp === "string" && sp) return sp;
		} catch {
			// Session not ready yet.
		}
		return "";
	}

	/** The FULL system prompt actually in effect right now (AgentSession getter,
	 *  includes the append/replace override + auto-appended sections like
	 *  project context, skills and tool guidance). Read-only view source for
	 *  the settings panel. */
	private effectiveSystemPrompt(): string {
		try {
			const sp = this.session.systemPrompt;
			return typeof sp === "string" ? sp : "";
		} catch {
			// Session not ready yet.
			return "";
		}
	}

	/** Web-facing extension UI context (widgets, notifications). */
	private webUi = new WebUIContext((msg) => this.emit(msg));
	private widgetsTimer: ReturnType<typeof setInterval> | null = null;
	/** Model-stall watchdog interval (see startStallTimer). */
	private stallTimer: ReturnType<typeof setInterval> | null = null;

	/** Connected sockets for this client (multiple tabs share the session). */
	private sinks = new Set<(msg: ServerMessage) => void>();
	private pendingNotices: ServerMessage[] = [];
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	/** Timestamp of the most recent message_delta push — while fresh, snapshots
	 *  use the slower STREAMING_SNAPSHOT_INTERVAL_MS cadence. */
	private lastDeltaAt = 0;
	private sessionsTimer: ReturnType<typeof setTimeout> | null = null;
	private version = 0;
	/** Snapshot revision counter (see emitSnapshotNow / protocol snapshot_delta). */
	private snapRev = 0;
	/** Messages array as of the last emitted snapshot/delta — identity-walked
	 *  against the current array to detect append-only growth. */
	private emittedMessages: UiMessage[] | null = null;
	/** Conversation whose messages emittedMessages belongs to. A conversation
	 *  switch (set_cwd / new_chat / switch_*) must fall back to a FULL snapshot:
	 *  two empty conversations have identical (empty) arrays, so the identity
	 *  walk alone would misread the switch as "nothing changed" → delta. */
	private emittedConvId: string | null = null;
	/** snapRev value at which emittedMessages was captured. */
	private emittedRev = 0;
	/**
	 * Per-conversation serialization caches (stable message ids, UiMessage
	 * object cache, message-array signature, queue counts) live inside each
	 * Conversation — see Conversation above.
	 */
	private disposed = false;
	/** pi-config readiness check, cached briefly so 60ms snapshots don't hit disk. */
	private piCheckCache: { at: number; configured: boolean } | null = null;

	/** fs.watch on the currently-listed directory — file changes push an instant
	 *  refresh (`file_changed`) so the tree updates without waiting for the 10s
	 *  poll. Only the listed directory is watched (one level); navigating
	 *  re-watches the new target. fs.watch isn't available on every platform /
	 *  filesystem — failures silently fall back to the poll. */
	private fsWatcher: ReturnType<typeof watch> | null = null;
	private watchPath: string | null = null;
	/** fs.watch on the active repo's git dir — external changes (CLI commit,
	 *  IDE branch switch) push `scm_changed` so the panel refreshes itself.
	 *  One watcher per client session, re-targeted when the queried cwd
	 *  changes; failures (bare repo, unsupported fs) silently disable it. */
	private gitWatcher: ReturnType<typeof watch> | null = null;
	private gitWatchCwd: string | null = null;
	private gitDirtyTimer: ReturnType<typeof setTimeout> | null = null;
	private watchTimer: ReturnType<typeof setTimeout> | null = null;

	private constructor(
		clientId: string,
		cwd: string,
		agentDir: string,
		stateStore: ClientStateStore,
	) {
		this.clientId = clientId;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.stateStore = stateStore;
		this.settingsSvc = new SettingsService({
			clientId,
			stateStore,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			getSession: () => this.session,
			isStreaming: () => this.session.isStreaming,
			reloadSession: async () => {
				await this.session.reload();
				// reload() puts custom tools back into the active set — replay the terminal toggle.
				this.applyTerminalToolGating(this.session);
				await this.pushSlashCommands();
			},
			effectiveDefaultSystemPrompt: () => this.effectiveDefaultSystemPrompt(),
			effectiveSystemPrompt: () => this.effectiveSystemPrompt(),
		});
		this.goalSvc = new GoalService({
			clientId,
			agentDir,
			stateStore,
			webUi: this.webUi,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			quiesceBlocked: () => this.quiesceBlocked(),
			activeConvId: () => this.activeId,
			activeConv: () => this.conv,
			getConv: (id) => this.convs.get(id),
			cwd: () => this.cwd,
			reviewSettings: () => this.settingsSvc.reviewPrefs,
			gitDiff: (dir) => this.gitDiff(dir),
		});

		this.modelAdmin = new ModelAdminService({
			agentDir,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			modelRuntime: () => this.runtime.services.modelRuntime,
			invalidatePiConfig: () => {
				this.piCheckCache = null;
			},
			pushModels: async () => this.listModels(),
		});
		// Prune dead background tasks every 30s (only spawns netstat/lsof while
		// the list is non-empty). unref: must not keep the process alive.
		this.bg.start();
	}

	static async create(
		clientId: string,
		cwd: string,
		stateStore: ClientStateStore,
	): Promise<ClientSession> {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();

		const cs = new ClientSession(clientId, cwd, agentDir, stateStore);
		const conversationId = cs.nextConversationId();
		const terminals = cs.makeTerminalManager(conversationId, cwd);
		const runtime = await createAgentSessionRuntime(cs.makeRuntimeFactory(terminals), {
			cwd,
			agentDir,
			// Resume the most recent session for this project — the SDK default
			// per-project dir (<agentDir>/sessions/--<cwd>--/, shared with the
			// pi CLI/TUI) — or start a fresh one on first visit.
			sessionManager: SessionManager.continueRecent(cwd),
		});
		// First conversation = the resumed session; it also seeds the shared
		// ModelRuntime that every later conversation reuses.
		cs.sharedModelRuntime = runtime.services.modelRuntime;
		const conv = cs.makeConversation(runtime, conversationId, terminals);
		cs.convs.set(conv.id, conv);
		cs.activeId = conv.id;
		for (const d of runtime.diagnostics) {
			if (d.type !== "info") {
				cs.pendingNotices.push({
					type: "notice",
					level: d.type,
					text: d.message,
				});
			}
		}
		await cs.bindSession();
		return cs;
	}

	/**
	 * Factory for cwd-bound runtimes. All conversations share ONE ModelRuntime
	 * (the model choice is client-wide), so later conversations reuse the
	 * instance created with the first one.
	 */
	private makeRuntimeFactory(terminals: TerminalManager): CreateAgentSessionRuntimeFactory {
		return async ({ cwd: effectiveCwd, sessionManager }) => {
			const services = await createAgentSessionServices({
				cwd: effectiveCwd,
				modelRuntime: this.sharedModelRuntime,
				// Settings-panel hooks (official SDK resourceLoader overrides): the three
				// overrides replay on every resourceLoader.reload() and read the current
				// this.settings values — so session.reload() is enough to make the system
				// prompt / skill / plugin toggles take effect, and a new conversation
				// (new runtime) also picks up the current settings automatically.
				resourceLoaderOptions: {
					additionalSkillPaths: this.extraSkillPaths(),
					additionalPromptTemplatePaths: this.bundledPromptPaths(),
					// System prompt: replace mode replaces the whole thing; append mode appends to the end.
					systemPromptOverride: (base?: string) => {
						// Remember the built-in default so the settings panel can show
						// it when the user edits in replace mode.
						if (typeof base === "string" && base) {
							this.lastBaseSystemPrompt = base;
						}
						return this.settingsSvc.current.promptMode === "replace" &&
							this.settingsSvc.current.customSystemPrompt.trim()
							? this.settingsSvc.current.customSystemPrompt
							: base;
					},
					appendSystemPromptOverride: (base: string[]) => {
						const out = [...base];
						const custom = this.settingsSvc.current.customSystemPrompt.trim();
						if (this.settingsSvc.current.promptMode === "append" && custom) {
							out.push(custom);
						}
						if (process.platform === "win32") {
							// Windows-only persona: the bash tool runs Git Bash with no default
							// timeout, and the terminal is an interactive TTY — inject constraints
							// so heredoc / interactive / long-running commands cannot hang the
							// whole session. For legacy GBK Chinese files, tell the model to read
							// via the terminal with the right encoding (iconv/chcp/Get-Content).
							out.push(WINDOWS_PERSONA);
						}
						if (this.settingsSvc.current.terminalToolsEnabled !== false) {
							// Terminal-tool usage guidance (all platforms): tell the model when to
							// use a persistent terminal instead of one-shot bash — without this the
							// model almost never picks the terminal tools on its own.
							out.push(TERMINAL_TOOLS_GUIDANCE);
						}
						return out;
					},
					// Skill toggle: disabled skills are stripped from the system prompt and the /skill: catalog.
					skillsOverride: (res) => ({
						...res,
						skills: res.skills.filter(
							(s) => !this.settingsSvc.current.disabledSkills.includes(s.name),
						),
					}),
					// Plugin toggle: a disabled extension is fully unloaded (its tools / commands disappear).
					// Note the SDK only attaches sourceInfo AFTER extensionsOverride, so package
					// extensions can only be matched by path here — isExtensionDisabled also
					// compares npm:<pkg> candidate keys.
					extensionsOverride: (res) => ({
						...res,
						extensions: res.extensions.filter(
							(e) => !isExtensionDisabled(e, this.settingsSvc.current.disabledExtensions),
						),
					}),
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				// Manually-stoppable bash tool: overrides the SDK built-in bash (customTools
				// overrides by name). On execute it registers its AbortController in the client
				// set — abortBash() kills only those commands; the agent run and conversation continue.
				customTools: [
					// Dual bash implementations, dispatched dynamically: when "terminal-backed"
					// is on, commands run in a persistent visible terminal (shell state kept,
					// silence auto-backgrounds); when off, native killable bash.
					makeAdaptiveBashTool(
						makeKillableBashTool(effectiveCwd, this.bashKills),
						makeTerminalBashTool(terminals, {
							cwd: effectiveCwd,
							idleMs: () =>
								this.settingsSvc.current.terminalBash
									? Math.max(
											0,
											Math.floor(this.settingsSvc.current.terminalBashIdleMs) ||
												0,
										)
									: 0,
							kills: this.bashKills,
							notifyBackgroundDone: (info) =>
								this.notifyTerminalBashDone(terminals, info),
						}),
						() => this.settingsSvc.current.terminalBash,
					),
					...makePersistentTerminalTools(terminals, effectiveCwd),
					// Plugin-registered AI tools (live snapshot at creation time; later
					// registrations are patched into existing sessions via refreshPluginTools).
					...(this.pluginToolsProvider?.() ?? []).map(pluginToolToDefinition),
				],
			});
			// The terminal-tools toggle takes effect from creation (tools stay in the registry; only the active set is adjusted).
			this.applyTerminalToolGating(created.session);
			return {
				...created,
				services,
				diagnostics: services.diagnostics,
			};
		};
	}

	/** Create independent goal state for one conversation. Preferences are
	 * client-wide defaults, while goal text/review progress is not shared. */
	private makeGoalStatus(): GoalStatus {
		return this.goalSvc.makeGoalStatus();
	}

	/** Allocate a stable conversation id before constructing its runtime/tools. */
	private nextConversationId(): string {
		return `c${++this.convSeq}`;
	}

	/** Wrap a fresh runtime as a new conversation record. */
	private makeConversation(
		runtime: AgentSessionRuntime,
		id: string,
		terminals: TerminalManager,
	): Conversation {
		return {
			id,
			title: conversationTitle(runtime.session),
			runtime,
			session: runtime.session,
			cwd: runtime.cwd,
			createdAt: Date.now(),
			// A brand-new conversation is not yet in the running list — it enters
			// only when it is displaced to the background while still streaming.
			listed: false,
			promptedSinceActive: false,
			lastActiveAt: Date.now(),
			lastSdkEventAt: Date.now(),
			stallNoticed: false,
			goal: this.makeGoalStatus(),
			goalGeneration: 0,
			goalReviewGeneration: 0,
			wizardRunning: false,
			deltaSeq: 0,
			terminals,
			msgIds: new Map(),
			nextMsgId: 1,
			userSeqByTs: new Map(),
			uiMessageCache: new Map(),
			lastMessagesSig: "",
			lastMessagesArray: [],
			queueSteering: [],
			queueFollowUp: [],
			toolStartTimes: new Map(),
			toolWatchdogs: new Map(),
		};
	}

	/** Summaries of conversations currently streaming — captured at shutdown
	 *  so the next attach can tell the user their run was interrupted. */
	streamingSummaries(): { title: string; cwd: string }[] {
		const out: { title: string; cwd: string }[] = [];
		for (const conv of this.convs.values()) {
			if (conv.session.isStreaming) out.push({ title: conv.title, cwd: conv.cwd });
		}
		return out;
	}

	/** Tell the user about runs lost to the last server restart (once). */
	notifyInterrupted(
		list: { title: string; cwd: string; at: number }[] | undefined,
	): void {
		if (!list || list.length === 0) return;
		const names = list
			.map((r) => `「${r.title}」（${r.cwd}）`)
			.join("、");
		this.pendingNotices.push({
			type: "notice",
			level: "warning",
			text: `Last restart interrupted ${list.length} running conversation(s): ${names}. Resume them from history.`,
		});
	}

	/** Add a socket to this client's broadcast set; flushes buffered startup notices. */
	attachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.add(send);
		for (const msg of this.pendingNotices) send(msg);
		this.pendingNotices = [];
		// Replay current extension widgets (setWidget may have fired during
		// session creation, before any socket was attached).
		const widgets = this.webUi.snapshot();
		if (widgets.length > 0) send({ type: "widgets", widgets });
		const statuses = this.webUi.statusSnapshot();
		if (statuses.length > 0) send({ type: "statuses", statuses });
		// Reconnect: push the current project's running-conversation list so the
		// left panel shows every background chat (a fresh socket never got the
		// newChat/switch pushes).
		this.emitConversations();
		// Reconnect: same for the slash-command catalog (the picker needs it even
		// before the client asks).
		void this.pushSlashCommands();
		// Reconnect: push the remembered goal prefs (model choice, rounds cap,
		// locked) so the goal bar restores them on reload — "global memory".
		this.goalSvc.emitGoalStatus();
		// Reconnect: push the settings panel state (prompt text/mode, skill &
		// extension toggles, saved presets).
		this.pushSettings();
		// Reconnect: push the background-task list — it must survive reconnects
		// and outlive the conversation that started the tasks.
		this.bg.push();
		// PTYs are conversation-owned and survive a socket reconnect.
		this.pushTerminals();
		void this.pushReviewStatus();
	}

	detachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.delete(send);
		// PTYs intentionally survive a socket drop: they are owned by the
		// conversation and can be inspected after reconnecting. Only conversation
		// disposal or server shutdown kills them.
		if (this.sinks.size === 0) {
			this.files.unwatchDir();
		}
	}

	/** Broadcast to every connected socket of this client. */
	private emit(msg: ServerMessage): void {
		if (this.disposed) return;
		for (const sink of [...this.sinks]) sink(msg);
	}

	/** (Re)attach event plumbing to the ACTIVE conversation's session. */
	private async bindSession(): Promise<void> {
		const conv = this.conv;
		conv.unsubscribe?.();
		conv.session = conv.runtime.session;
		await conv.session.bindExtensions({
			mode: "rpc",
			uiContext: this.webUi,
			onError: (err) => {
				this.emit({ type: "notice", level: "error", text: err.error });
			},
		});
		conv.unsubscribe = conv.session.subscribe((event) =>
			this.onEvent(conv, event),
		);
		this.scheduleSnapshot();
		this.webUi.refresh();
		this.startWidgetsTimer();
		this.startStallTimer();
	}

	/** Poll extension widgets so TUI-only overlays (e.g. rpiv-todo) stay live. */
	private startWidgetsTimer(): void {
		if (this.widgetsTimer) return;
		this.widgetsTimer = setInterval(() => {
			if (!this.disposed) this.webUi.refresh();
		}, WIDGET_REFRESH_MS);
	}

	/** Model-stall watchdog: warn when a streaming run went completely silent
	 *  (no SDK events at all) for STALL_NOTIFY_MS. Deliberately does NOT abort:
	 *  deep-thinking models can legitimately be quiet for minutes — the notice
	 *  just tells the user the run looks stuck so they can Stop it themselves. */
	private startStallTimer(): void {
		if (this.stallTimer || STALL_NOTIFY_MS === 0) return;
		this.stallTimer = setInterval(() => {
			if (this.disposed) return;
			const now = Date.now();
			for (const conv of this.convs.values()) {
				if (
					!conv.stallNoticed &&
					conv.session.isStreaming &&
					now - conv.lastSdkEventAt > STALL_NOTIFY_MS
				) {
					conv.stallNoticed = true;
					const mins = Math.round((now - conv.lastSdkEventAt) / 60_000);
					this.emit({
						type: "notice",
						level: "warning",
						text: `Conversation "${conv.title}" has had no response for ${mins} minute(s) and may be stalled. Stop and retry.`,
					});
				}
			}
		}, 30_000);
	}

	/** Arm the hang-guard for a tool call: if it is still running after
	 *  TOOL_WATCHDOG_TIMEOUT_MS, abort the session instead of letting the
	 *  conversation hang forever (the SDK bash tool has no default timeout). */
	private armToolWatchdog(conv: Conversation, toolCallId: string): void {
		const t = setTimeout(() => {
			conv.toolWatchdogs.delete(toolCallId);
			// The tool finished before the deadline — nothing to do.
			if (!conv.toolStartTimes.has(toolCallId)) return;
			this.emit({
				type: "notice",
				level: "warning",
				text: `Tool ran over ${Math.round(TOOL_WATCHDOG_TIMEOUT_MS / 60_000)} minute(s) and was aborted. Override with PI_WEB_TOOL_TIMEOUT_MS (ms).`,
			});
			conv.toolStartTimes.delete(toolCallId);
			// Abort the run (kills the process tree via the SDK's abort signal);
			// agent_end will fire with stopReason "aborted" and existing logic
			// clears any goal / review loop. interruptRun adds a force-reset
			// fallback in case the model stream ignores the abort signal.
			void this.interruptRun(conv, "Tool timed out");
		}, TOOL_WATCHDOG_TIMEOUT_MS);
		t.unref?.();
		conv.toolWatchdogs.set(toolCallId, t);
	}

	/** Cancel a tool's watchdog — called when the tool finishes normally. */
	private clearToolWatchdog(conv: Conversation, toolCallId: string): void {
		const t = conv.toolWatchdogs.get(toolCallId);
		if (t) {
			clearTimeout(t);
			conv.toolWatchdogs.delete(toolCallId);
		}
	}

	/** Cancel every watchdog of a conversation (removeConversation / dispose). */
	private clearAllToolWatchdogs(conv: Conversation): void {
		for (const t of conv.toolWatchdogs.values()) clearTimeout(t);
		conv.toolWatchdogs.clear();
	}

	private onEvent(conv: Conversation, event: AgentSessionEvent): void {
		// Any SDK event proves the run is alive — feeds the stall watchdog below.
		conv.lastSdkEventAt = Date.now();
		conv.stallNoticed = false;
		switch (event.type) {
			case "bash_execution_update": {
				if (event.id) {
					this.emit({
						type: "tool_delta",
						conversationId: conv.id,
						seq: ++conv.deltaSeq,
						toolCallId: event.id,
						toolName: "bash",
						delta: event.delta,
					});
				}
				break;
			}
			case "tool_execution_start": {
				// Record the moment the tool actually starts so tool_status can
				// report real execution time (vs. time spent waiting on the model).
				conv.toolStartTimes.set(event.toolCallId, Date.now());
				// Snapshot listeners before a bash run — the post-run diff catches
				// servers the agent started in the background.
				if (event.toolName === "bash") {
					this.bg.snapshotBefore();
				}
				this.armToolWatchdog(conv, event.toolCallId);
				// Plugin extension point: tool execution started (exceptions isolated by emitToolEvent).
				this.onToolEvent?.({ phase: "start", toolName: event.toolName, conversationId: conv.id });
				break;
			}
			case "tool_execution_end": {
				const startedAt = conv.toolStartTimes.get(event.toolCallId);
				conv.toolStartTimes.delete(event.toolCallId);
				this.clearToolWatchdog(conv, event.toolCallId);
				// Bash finished — wait briefly for background servers to bind their
				// ports, then diff against the pre-run snapshot and record them.
				if (event.toolName === "bash") void this.bg.trackAfterBash();
				const durationMs =
					startedAt !== undefined ? Date.now() - startedAt : undefined;
				// Plugin extension point: tool execution ended (with duration and error flag).
				this.onToolEvent?.({
					phase: "end",
					toolName: event.toolName,
					conversationId: conv.id,
					...(durationMs !== undefined ? { durationMs } : {}),
					isError: event.isError,
				});
				// The bash tool does not put its exit code in result.details — on
				// failure it throws "Command exited with code N" and the agent
				// wraps that into the error result text. Try details first (future
				// tools / SDK changes), then parse the error text.
				const details = (event.result as { details?: unknown })?.details;
				let exitCode: number | undefined;
				if (
					typeof details === "object" &&
					details !== null &&
					typeof (details as { exitCode?: unknown }).exitCode === "number"
				) {
					exitCode = (details as { exitCode: number }).exitCode;
				} else if (event.isError) {
					const content = (event.result as { content?: unknown })?.content;
					const text = Array.isArray(content)
						? content
								.map((c) =>
									(typeof c === "object" &&
										c !== null &&
										(c as { type?: unknown }).type === "text")
											? ((c as { text?: unknown }).text ?? "")
											: "",
								)
								.join("\n")
						: "";
					const m = text.match(/exited with code (\d+)/);
					if (m) exitCode = Number(m[1]);
				}
				this.emit({
					type: "tool_status",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					exitCode,
					durationMs,
				});
				break;
			}
			case "tool_execution_update": {
				const text = extractPartialText(event.partialResult);
				if (text) {
					this.emit({
						type: "tool_delta",
						conversationId: conv.id,
						seq: ++conv.deltaSeq,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						delta: text,
					});
				}
				break;
			}
			case "queue_update":
				conv.queueSteering = [...event.steering];
				conv.queueFollowUp = [...event.followUp];
				break;
			// A run finished or a new entry was persisted — keep the session list fresh
			// (new chat + first message, completed turns, compaction, etc.).
			case "agent_end": {
				this.scheduleSessionsRefresh();
				// Manual interrupt (Stop button / abort): the last assistant message
				// carries stopReason "aborted". A half-finished run should NOT be
				// reviewed (it would fail and inject a revision, only to be stopped
				// again → an endless review loop). Clear the goal so the review loop
				// stops too, then let the user give a fresh instruction.
				const aborted = (event.messages as unknown[]).some((m) => {
					const a = m as { role?: string; stopReason?: string };
					return a.role === "assistant" && a.stopReason === "aborted";
				});
				if (aborted) {
					const stopNotice = this.goalSvc.onAgentEnd(conv, true);
					if (stopNotice) {
						this.emit({ type: "notice", level: "warning", text: stopNotice });
					}
					break;
				}
				// Goal review hook lives in GoalService.onAgentEnd(conv, false).
				this.goalSvc.onAgentEnd(conv, false);
				if (conv.id === this.conv.id) {
					void this.maybeNudgeReview();
				}
				// Deferred settings reload: settings (system prompt / skills /
				// extensions) changed while the run was streaming — applying now
				// would have torn down the in-flight run.
				if (this.settingsSvc.hasPendingReload() && !this.disposed) {
					this.settingsSvc.consumePendingReload();
					void this.applySettingsReload();
				}
				break;
			}
			case "entry_appended":
				this.scheduleSessionsRefresh();
				break;
			case "message_update": {
				// Live assistant-message increment, deliberately OUTSIDE the snapshot
				// channel: send() drops snapshots under backpressure (big sessions),
				// but this small message must always get through or the UI freezes on
				// stale state. Only the ACTIVE conversation streams to the browser —
				// background conversations would clobber the streaming view; their
				// state arrives via snapshot when switched to.
				if (conv.id !== this.conv.id) break;
				const ame = event.assistantMessageEvent;
				const m = event.message as { timestamp?: number };
				this.lastDeltaAt = Date.now();
				this.emit({
					type: "message_delta",
					conversationId: conv.id,
					seq: ++conv.deltaSeq,
					// Must match serializeStreamingMessage()'s stable id so deltas
					// patch onto the snapshot's streamingMessage and reconcile.
					messageId: `stream-${m?.timestamp ?? 0}`,
					usage: (() => {
						try {
							const t = this.session.getSessionStats().tokens;
							return t ? { input: t.input, output: t.output, total: t.total } : null;
						} catch {
							return null;
						}
					})(),
					// Strip `partial` (the cumulative message): re-serializing it per
					// token is exactly what we're trying to avoid. The next snapshot
					// carries the authoritative full message anyway.
					assistantMessageEvent: {
						type: ame.type,
						contentIndex: "contentIndex" in ame ? ame.contentIndex : undefined,
						delta: "delta" in ame ? ame.delta : undefined,
					},
				});
				break;
			}
			default:
				break;
		}
		// Snapshot checkpoint policy: deltas carry live rendering during streaming;
		// full snapshots are reconciliation checkpoints taken immediately at
		// run/tool boundaries and on a slow timer otherwise.
		if (event.type === "agent_end" || event.type === "tool_execution_end") {
			this.flushSnapshot();
		} else {
			this.scheduleSnapshot();
		}
	}

	/** Debounced push of the persisted session list + open conversations. */
	private scheduleSessionsRefresh(): void {
		if (this.sessionsTimer) return;
		this.sessionsTimer = setTimeout(() => {
			this.sessionsTimer = null;
			if (this.disposed) return;
			this.emitConversations();
			void this.pushSessions();
		}, 800);
		// pushSessions no-ops unless the client opted in via list_sessions.
	}

	/** Serialize a persisted message with a STABLE id + cached object reference. */
	private serializeCached(m: AgentMessage): UiMessage | null {
		const conv = this.conv;
		// toolResult messages are keyed by toolCallId; everything else by
		// role+timestamp. A single prompt can emit several same-role messages
		// within the SAME millisecond (multiple attachment asides), so the
		// timestamp alone collides in the cache and only the first one renders
		// — append a cheap content fingerprint to keep them distinct while
		// staying stable across snapshots (content never changes once persisted).
		const key =
			m.role === "toolResult"
				? `t:${m.toolCallId}`
				: `${m.role}:${m.timestamp}:${contentFingerprint(m)}`;
		let n = conv.msgIds.get(key);
		if (n === undefined) {
			n = conv.nextMsgId++;
			conv.msgIds.set(key, n);
		}
		const cacheKey = `${key}#${n}`;
		const cached = conv.uiMessageCache.get(cacheKey);
		if (cached) return cached;
		// User-message id suffix is a 1-based count of user messages sharing
		// this timestamp (that's what resolveUserMessageEntryId() expects). n is
		// a global per-conversation counter across ALL roles, so it can't be
		// reused as the seq — otherwise editing anything but the first question
		// fails to resolve ("could not find the message to edit").
		let seq = n;
		if (m.role === "user") {
			const ts = m.timestamp ?? 0;
			seq = (conv.userSeqByTs.get(ts) ?? 0) + 1;
			conv.userSeqByTs.set(ts, seq);
		}
		const msg = serializeMessage(m, seq);
		if (msg) {
			conv.uiMessageCache.set(cacheKey, msg);
			// Bound the cache (marathon sessions otherwise grow without limit;
			// single messages can reach TEXT_CAP = 200K chars). Map iteration is
			// insertion order, so dropping from the front evicts the oldest —
			// recent messages (the ones every snapshot touches) always survive.
			// Safe: a miss just recomputes an identical object on next access.
			let excess = conv.uiMessageCache.size - UI_MESSAGE_CACHE_CAP;
			while (excess-- > 0) {
				const oldest = conv.uiMessageCache.keys().next().value;
				if (oldest === undefined) break;
				conv.uiMessageCache.delete(oldest);
			}
		}
		return msg;
	}

	/** Current messages array (with the existing sig-reuse optimization).
	 *  Element objects are reference-stable (serializeCached cache), which is
	 *  what lets emitSnapshotNow detect append-only growth via identity walk. */
	private currentMessages(): UiMessage[] {
		const conv = this.conv;
		const rawMessages = conv.session.agent.state.messages
			.map((m) => this.serializeCached(m))
			.filter((m): m is NonNullable<typeof m> => m !== null);
		// Reuse the previous array when nothing changed: the element objects are
		// cached (reference-stable) anyway, and a stable array reference lets the
		// frontend memoize derived maps instead of rebuilding them every 60ms.
		const sig = rawMessages.map((m) => m.id).join("\u0001");
		const messages =
			conv.lastMessagesSig === sig ? conv.lastMessagesArray : rawMessages;
		conv.lastMessagesSig = sig;
		conv.lastMessagesArray = rawMessages;
		return messages;
	}

	/** Build every UiState field EXCEPT messages (the expensive part). */
	private buildLightState(
		rev: number,
	): Omit<UiState, "messages" | "rev"> & { rev: number } {
		const conv = this.conv;
		const state = conv.session.agent.state;
		const model = state.model;
		let stats: UiState["stats"] = {
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { tokens: null, contextWindow: 0, percent: null },
		};
		try {
			const s = this.session.getSessionStats();
			stats = {
				totalMessages: s.totalMessages,
				tokens: s.tokens,
				cost: s.cost,
				contextUsage: s.contextUsage
					? {
							tokens: s.contextUsage.tokens,
							contextWindow: s.contextUsage.contextWindow,
							percent: s.contextUsage.percent,
						}
					: stats.contextUsage,
			};
		} catch {
			// stats are best-effort
		}
		return {
			clientId: this.clientId,
			cwd: this.cwd,
			sessionId: this.session.sessionId,
			sessionFile: this.session.sessionFile,
			conversationId: this.activeId,
			rev,
			// The in-progress assistant message lives in state.streamingMessage
			// (the SDK only pushes it into state.messages at message_end). Surfacing
			// it here is what makes thinking + text stream into the browser at
			// ~60ms granularity instead of appearing only when the turn finishes.
			streamingMessage: state.streamingMessage
				? serializeStreamingMessage(state.streamingMessage)
				: null,
			isStreaming: this.session.isStreaming,
			model: model
				? {
						id: model.id,
						name: model.name,
						provider: model.provider,
						vision: model.input?.includes("image") ?? false,
				  }
				: null,
			thinkingLevel: state.thinkingLevel,
			// Only the levels the current model actually supports — the SDK clamps
			// anything else, so the UI must not offer (or must disable) the rest.
			availableThinkingLevels: this.session.getAvailableThinkingLevels(),
			queue: { steering: conv.queueSteering, followUp: conv.queueFollowUp },
			errorMessage: state.errorMessage,
			tools: state.tools.map((t) => t.name),
			version: ++this.version,
			piConfigured: this.isPiConfigured(),
			stats,
		};
	}

	/** Emit one snapshot update — incremental when possible, full otherwise.
	 *
	 *  Persisted messages are content-immutable with reference-stable objects
	 *  (serializeCached), so an IDENTITY WALK over the previous array detects
	 *  append-only growth in O(n) pointer compares. Appends travel as
	 *  snapshot_delta carrying only the new tail + light fields; any mid-array
	 *  change/truncation (switch session, edit fork, compaction) or a forced
	 *  resync falls back to a full snapshot. The 10MB-stringify-per-checkpoint
	 *  cost of big sessions collapses to a few hundred bytes for the common
	 *  "nothing but stats/version changed" checkpoint. */
	private emitSnapshotNow(forceFull = false): void {
		if (this.disposed) return;
		const cur = this.currentMessages();
		const prev = this.emittedMessages;
		let incremental =
			!forceFull &&
			prev !== null &&
			this.emittedConvId === this.activeId &&
			prev.length <= cur.length;
		if (incremental && prev) {
			for (let i = 0; i < prev.length; i++) {
				if (prev[i] !== cur[i]) {
					incremental = false;
					break;
				}
			}
		}
		const rev = ++this.snapRev;
		if (incremental && prev) {
			const baseRev = this.emittedRev;
			this.emittedMessages = cur;
			this.emittedConvId = this.activeId;
			this.emittedRev = rev;
			this.emit({
				type: "snapshot_delta",
				conversationId: this.activeId,
				rev,
				baseRev,
				appended: cur.slice(prev.length),
				state: this.buildLightState(rev),
			});
		} else {
			this.emittedMessages = cur;
			this.emittedConvId = this.activeId;
			this.emittedRev = rev;
			this.emit({
				type: "snapshot",
				state: { ...this.buildLightState(rev), messages: cur },
			});
		}
	}

	/** Resolve a browser-bridged dialog (select/confirm/input) for this session. */
	resolveDialog(id: number, value: string | boolean | null): void {
		this.webUi.resolveDialog(id, value);
	}

	/**
	 * Whether the pi agent config looks ready: the agent dir exists and
	 * auth.json has at least one provider credential. Cached for 2s.
	 */
	isPiConfigured(): boolean {
		const now = Date.now();
		const cached = this.piCheckCache;
		if (cached && now - cached.at < 2000) return cached.configured;
		let configured = false;
		try {
			const authPath = join(this.agentDir, "auth.json");
			if (existsSync(authPath)) {
				const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<
					string,
					unknown
				>;
				configured =
					typeof data === "object" &&
					data !== null &&
					Object.keys(data).length > 0;
			}
		} catch {
			configured = false;
		}
		this.piCheckCache = { at: now, configured };
		return configured;
	}

	/**
	 * Run a command async, collecting stdout+stderr; kills on timeout.
	 * Never throws / never crashes the server: spawn errors (ENOENT etc.)
	 * resolve with code -1 so callers can report them as notices.
	 */
	private runAsync(
		cmd: string,
		args: string[],
		timeoutMs: number,
		cwd?: string,
	): Promise<{ code: number | null; out: string }> {
		return new Promise((resolve) => {
			let p;
			try {
				p = spawn(cmd, args, {
					...(cwd ? { cwd } : {}),
					stdio: ["ignore", "pipe", "pipe"],
					// Windows: npm and friends are .cmd shims — Node can only exec
					// them through the shell (otherwise spawn npm → ENOENT).
					shell: process.platform === "win32",
				});
			} catch (err) {
				resolve({ code: -1, out: String(err) });
				return;
			}
			let out = "";
			let settled = false;
			const done = (code: number | null, text?: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(t);
				resolve({ code, out: text ?? out });
			};
			const t = setTimeout(() => p.kill(), timeoutMs);
			p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
			p.stderr?.on("data", (d: Buffer) => (out += d.toString()));
			p.on("error", (err) => done(-1, String(err)));
			p.on("close", (code) => done(code));
		});
	}

	/**
	 * Auto-install the pi agent: ensure the config dir exists and install the
	 * pi CLI globally (npm i -g). Auth is configured afterwards via the API key
	 * form or by running `pi` in a terminal.
	 */

	/**
	 * Version of the RUNNING pi-web-ui package (read from its own package.json,
	 * resolved from this compiled module: <pkg>/dist/server → <pkg>).
	 */
	private static currentAppVersion(): string {
		try {
			const here = dirname(fileURLToPath(import.meta.url));
			const pkgRoot = resolve(here, "..", "..");
			const pkg = JSON.parse(
				readFileSync(join(pkgRoot, "package.json"), "utf8"),
			) as { version?: string };
			return pkg.version ?? "0.0.0";
		} catch {
			return "0.0.0";
		}
	}

	/** Simple numeric semver compare: >0 means a newer than b. */
	private static compareVersions(a: string, b: string): number {
		const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
		const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
		for (let i = 0; i < 3; i++) {
			const x = pa[i] ?? 0;
			const y = pb[i] ?? 0;
			if (x !== y) return x - y;
		}
		return 0;
	}

	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;
	/** Fired after this client successfully switches workspace (set_cwd); argument is the new absolute path.
	 *  On attach, AgentService wires this to the global onClientCwdChanged — workspace-following
	 *  plugins (editor, etc.) use it to point their root at the user's current project. */
	onCwdChanged: ((abs: string) => void) | undefined = undefined;

	/** Ask the npm registry for the latest pi-web-ui version and report it. */
	async checkUpdate(): Promise<void> {
		const current = ClientSession.currentAppVersion();
		try {
			// Fetch the full package doc (not /latest): it carries the per-version
			// publish timestamps so the UI can hint when a version was JUST
			// published and the registry/CDN caches may not have caught up yet.
			const res = await fetch("https://registry.npmjs.org/pi-web-ui", {
				signal: AbortSignal.timeout(8_000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as {
				"dist-tags"?: { latest?: string };
				time?: Record<string, string>;
			};
			const latest = data["dist-tags"]?.latest ?? null;
			const latestPublishedAt =
				latest && data.time ? (data.time[latest] ?? null) : null;
			const upToDate =
				latest === null || ClientSession.compareVersions(current, latest) >= 0;
			this.emit({
				type: "update_status",
				current,
				latest,
				latestPublishedAt,
				upToDate,
			});
		} catch (err) {
			this.emit({
				type: "update_status",
				current,
				latest: null,
				latestPublishedAt: null,
				upToDate: false,
				error: `Update check failed: ${(err as Error).message}`,
			});
		}
	}

	async installPiAgent(): Promise<void> {
		try {
			mkdirSync(this.agentDir, { recursive: true });
			this.emit({
				type: "notice",
				level: "info",
				text: "Installing pi agent CLI (npm i -g @earendil-works/pi-coding-agent)…",
			});
			const { code, out } = await this.runAsync(
				"npm",
				["i", "-g", "@earendil-works/pi-coding-agent"],
				180_000,
			);
			if (code === 0) {
				this.emit({
					type: "notice",
					level: "info",
					text: "pi agent CLI installed. Enter an API key to start, or run pi in a terminal to log in.",
				});
				this.emit({ type: "install_result", ok: true, detail: "" });
			} else {
				this.emit({
					type: "notice",
					level: "error",
					text: `pi agent install failed (${code ?? "timeout"}): ${out.slice(0, 400)}`,
				});
				this.emit({
					type: "install_result",
					ok: false,
					detail: out.slice(0, 600),
				});
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `pi agent install failed: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Send a snapshot immediately (cancels any pending throttled one).
	 *  forceFull skips the incremental path — used by get_state so a (re)
	 *  connecting or desynced client always receives an authoritative full
	 *  state it can rebuild from. */
	flushSnapshot(forceFull = false): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		this.emitSnapshotNow(forceFull);
	}

	private scheduleSnapshot(): void {
		if (this.snapshotTimer || this.disposed) return;
		// During active streaming the deltas carry live rendering — full snapshots
		// are just a periodic reconciliation checkpoint, so send them far less
		// often (they serialize the whole session; big sessions made this path OOM).
		const interval =
			Date.now() - this.lastDeltaAt < DELTA_ACTIVE_WINDOW_MS
				? STREAMING_SNAPSHOT_INTERVAL_MS
				: SNAPSHOT_INTERVAL_MS;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			this.emitSnapshotNow();
		}, interval);
	}

	/** Slash-command catalog + native command execution — self-contained module, see
	 *  slash-commands.ts (built-in intercept + extension/template/skill catalog push). */
	private readonly slash = new SlashCommandsService({
		emit: (msg) => this.emit(msg),
		cwd: () => this.cwd,
		getSession: () => this.session,
		newChat: () => this.newChat(),
		setModel: (id) => this.setModel(id),
		setCwd: (path) => this.setCwd(path),
		setThinking: (level) => this.setThinking(level),
		refreshSessions: () => this.refreshSessions(),
		afterReload: () => this.applyTerminalToolGating(this.session),
		setSessionName: (name) => this.setSessionName(name),
		emitSessionTree: () => this.emitSessionTree(),
		exportSession: () => this.exportSession(),
		pluginCommands: () => this.pluginCommandsProvider?.() ?? [],
		execPluginCommand: async (name, args) => {
			const def = this.pluginCommandsProvider?.().find((c) => c.name === name);
			if (!def) return false;
			try {
				const result = await def.run(args, { clientId: this.clientId });
				// A string return → echoed to the initiator as a notice; use broadcast/sendTo for rich display.
				if (typeof result === "string" && result.trim()) {
					this.emit({ type: "notice", level: "info", text: result });
				}
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `Plugin command /${name} failed: ${(err as Error).message}`,
				});
			}
			return true;
		},
		onQuit: () => this.onQuit?.() ?? false,
	});

	/** Catalog push — called from index.ts get_commands / attach / cwd switch, etc. */
	pushSlashCommands(): Promise<void> {
		return this.slash.push();
	}

	/** Model / provider config management — self-contained module, see model-admin.ts. */
	private readonly modelAdmin!: ModelAdminService;

	/** Persist an api-key credential for a provider (auth.json). */
	setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		return this.modelAdmin.setProviderApiKey(provider, apiKey);
	}
	clearProviderApiKey(provider: string): Promise<void> {
		return this.modelAdmin.clearProviderApiKey(provider);
	}
	listProviders(): Promise<void> {
		return this.modelAdmin.listProviders();
	}
	listModelsConfig(): Promise<void> {
		return this.modelAdmin.listModelsConfig();
	}
	fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
	): Promise<void> {
		return this.modelAdmin.fetchModelsList(reqId, baseUrl, apiKey, authHeader, api);
	}
	refreshProviderModels(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.refreshProviderModels(providerId, reqId);
	}
	/** Copy a built-in provider into an editable custom-provider draft
	 *  (clone_provider_result) — lets the user run a second API key without
	 *  overwriting the built-in one. */
	cloneProvider(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.cloneProvider(providerId, reqId);
	}
	saveModelConfig(providerId: string, config: unknown): Promise<void> {
		return this.modelAdmin.saveModelConfig(providerId, config as never);
	}
	deleteModelConfig(providerId: string): Promise<void> {
		return this.modelAdmin.deleteModelConfig(providerId);
	}

	// ---------------------------------------------------------------------------
	// Settings (system prompt / skills / extensions / presets)
	// ---------------------------------------------------------------------------

	/** Push the full settings state (current settings + loaded skills/extensions
	 *  with enabled flags + saved presets). Pushed on attach and after every
	 *  settings change. */
	pushSettings(): void {
		this.settingsSvc.push();
	}

	/** Extensions/skills changed externally (e.g. `pi remove` finished in the
	 *  terminal): re-run session.reload() and re-push state. Streaming-safe —
	 *  deferred to agent_end, same as settings reloads. */
	async reloadExtensions(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	/** Persist + apply a partial settings update (prompt text/mode, toggles). */
	async setSettings(partial: {
		promptMode?: PromptMode;
		customSystemPrompt?: string;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		thinkingWrap?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: PromptMode;
		visionBridgePrompt?: string;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
		disabledPlugins?: string[];
		additionalSkillPaths?: string[];
	}): Promise<void> {
		await this.settingsSvc.set(partial);
	}

	/** Save the CURRENT settings as a named preset (overwrites if exists). */
	async savePreset(name: string): Promise<void> {
		return this.settingsSvc.savePreset(name);
	}

	/** Replace the current settings with the named preset and apply it. */
	async applyPreset(name: string): Promise<void> {
		return this.settingsSvc.applyPreset(name);
	}

	/** Remove a named preset. */
	async deletePreset(name: string): Promise<void> {
		return this.settingsSvc.deletePreset(name);
	}

		/** Make settings effective in the running runtime (deferred to agent_end if currently streaming). */
	private async applyRuntimeSettings(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	/** Apply the terminal-tools toggle to the session's active tool set: when off,
	 *  strip terminal_* from the active set (tools stay in the registry and can be
	 *  added back on re-enable). session.reload() and new-session creation both put
	 *  custom tools back into the active set, so this method must be replayed after both. */
	private applyTerminalToolGating(session: AgentSession): void {
		try {
			const enabled = this.settingsSvc.current.terminalToolsEnabled !== false;
			const names = new Set(session.getActiveToolNames());
			for (const n of TERMINAL_TOOL_NAMES) {
				if (enabled) names.add(n);
				else names.delete(n);
			}
			session.setActiveToolsByName([...names]);
		} catch {
			// Session not ready — will be applied again on next create/reload.
		}
	}

	/** Sync plugin AI tools into an existing session (add/update/remove).
	 *  The actual diff lives in plugins.ts syncPluginToolsIntoSession (unit-testable). */
	private syncPluginTools(session: AgentSession): void {
		try {
			const defs = (this.pluginToolsProvider?.() ?? []).map(pluginToolToDefinition);
			const next = syncPluginToolsIntoSession(
				session as unknown as Parameters<typeof syncPluginToolsIntoSession>[0],
				defs as unknown as Parameters<typeof syncPluginToolsIntoSession>[1],
				this.appliedPluginToolNames,
			);
			if (next) this.appliedPluginToolNames = new Set(next);
		} catch (err) {
			console.error("[plugins] sync tools to session failed:", err);
		}
	}

	/** Triggered by index.ts via pluginMgr.onAgentToolsChanged: push plugin AI tools into every session. */
	refreshPluginTools(): void {
		for (const conv of this.convs.values()) this.syncPluginTools(conv.session);
	}

	private async applySettingsReload(): Promise<void> {
		// Compat with the old entry: reload + catalog refresh happen in the host callback
		return this.settingsSvc.applyRuntime();
	}

	// ---------------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------------

	/** True when the service is draining (quiesced): emits a rejection notice
	 *  and returns true. Guards every NEW-work entry point (prompt / new chat /
	 *  edit-resend / session resume / goal wizard) — existing runs keep going.
	 *  Called BEFORE any LLM/token work starts so quiesce is a hard admission
	 *  gate, not a best-effort hint. */
	private quiesceBlocked(): boolean {
		if (!this.isQuiesced()) return false;
		this.emit({
			type: "notice",
			level: "error",
			text: "Server is draining (quiesce): new chats/messages/edits are refused. In-flight work will finish. Run pi-web-ui server unquiesce to reopen.",
		});
		this.flushSnapshot();
		return true;
	}

	/** Conversations with an in-flight run — active work for quiesce status. */
	activeConversations(): number {
		let n = 0;
		for (const c of this.convs.values()) {
			try {
				if (c.session.isStreaming) n += 1;
			} catch {
				// session being replaced — not running
			}
		}
		return n;
	}

	/** Messages queued in the SDK (steer + follow-up) — pending work for
	 *  quiesce status. Quiesce refuses to add more, so this only drains. */
	pendingMessages(): number {
		let n = 0;
		for (const c of this.convs.values())
			n += c.queueFollowUp.length + c.queueSteering.length;
		return n;
	}

	async prompt(
		text: string,
		attachments?: {
			path: string;
			mode?: "inline" | "reference" | "lines";
			lines?: { start: number; end: number };
			/** Raw pasted/dropped/uploaded image (base64) — bypasses workspace path. */
			imageData?: string;
			/** Raw uploaded file bytes (base64) — persisted, attached as reference. */
			fileData?: string;
			mimeType?: string;
			name?: string;
			size?: number;
		}[],
		/**
		 * true = followUp: while streaming, queue the prompt and deliver it only
		 * after the WHOLE run finishes (supplement button — "send only after AI generation ends").
		 * false/undefined = steer: the pi CLI Enter semantic — injected right
		 * after the current turn settles, skipping remaining planned tool calls.
		 */
		queue = false,
	): Promise<void> {
		try {
			const s = this.session;
			// Native slash commands (see NATIVE_COMMANDS) are executed here and
			// never reach the SDK. Extension / skill / template commands fall
			// through — AgentSession.prompt() handles those itself.
			const slash = parseSlash(text);
			if (slash && (await this.slash.exec(slash.name, slash.args))) {
				this.flushSnapshot();
				return;
			}
			// Native commands above are pure config tweaks (no tokens) — allow them
			// even while quiesced. Everything that reaches the SDK is NEW work and
			// is refused until admission reopens.
			if (this.quiesceBlocked()) return;
			// Attach files as independent nextTurn context messages (asides) so the
			// user message stays clean; they render as separate attachment cards.
			const asides = await buildAttachmentMessages(
				{
					cwd: this.cwd,
					clientId: this.clientId,
					emit: (msg) => this.emit(msg),
					settings: this.settingsSvc.current,
					session: this.session,
				},
				attachments,
			);
			for (const aside of asides) {
				await s.sendCustomMessage(aside.message, { deliverAs: "nextTurn" });
			}
			if (s.isStreaming) {
				// queue=true (supplement button) → followUp: the message is delivered only
				// after the whole run finishes — the agent finishes what it started,
				// then responds to the queued message. queue=false/undefined
				// (plain Enter) → steer: interrupts the current run — the message
				// is delivered right after the current assistant turn settles
				// (remaining planned tool calls are skipped) and the agent
				// immediately responds to it. This is the pi CLI
				// Enter-during-streaming semantic (docs/usage: Enter queues a
				// steering message); followUp would wait for the whole run
				// to finish, which users perceive as ordinary queueing.
				await s.prompt(text, {
					streamingBehavior: queue ? "followUp" : "steer",
				});
			} else {
				await s.prompt(text);
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to send prompt: ${(err as Error).message}`,
			});
		}
		// Name the conversation after its first user prompt.
		const conv = this.conv;
		if (conv.title === DEFAULT_CONV_TITLE && text.trim()) {
			const trimmed = text.trim().replace(/\s+/g, " ");
			conv.title = trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
			this.emitConversations();
		}
		// The active conversation has been continued since it was opened — it
		// must not be dismissed when the user switches away. (Also bumps the
		// per-project "most recently active" order used by set_cwd.)
		conv.promptedSinceActive = true;
		conv.lastActiveAt = Date.now();
		// Fresh run — restart the stall watchdog window.
		conv.lastSdkEventAt = Date.now();
		conv.stallNoticed = false;
		this.flushSnapshot();
	}

	/**
	 * Turn attached files into custom-message payloads.
	 *
	 * Text files are size-aware: small files are inlined into the message so the
	 * model sees them immediately; large files are passed as a <file path="...">
	 * reference and the model reads them on demand with its read tool (which has
	 * built-in truncation). Images are always passed as image content. Mode
	 * "lines" inlines only a 1-based inclusive line range of the file. Raw
	 * pasted/dropped/uploaded images (attachment.imageData) skip the workspace
	 * path entirely and go straight to the model as image content. Raw uploaded
	 * files (attachment.fileData) are persisted under <dataDir>/uploads/ and
	 * attached as absolute-path references (small text ones are inlined).
	 */

	/**
	 * Hard-abort the running agent (Stop button / global interrupt). Tries
	 * session.abort() first; if the run is not idle within
	 * HARD_ABORT_TIMEOUT_MS (model stream ignoring the abort signal), the
	 * conversation's runtime is force-disposed and recreated from the last
	 * persisted session so the chat ALWAYS comes back usable — never stuck
	 * overnight. The notice fires only on the forced-reset path.
	 */
	async abort(): Promise<void> {
		// Stop only the agent run itself; services the AI started in the background
		// are managed separately by the background-tasks panel (stop one or all) and
		// are not killed as a side effect of stopping the conversation.
		await this.interruptRun(this.conv, "Stopped");
		this.flushSnapshot();
	}

	/** Re-push the current list on request (panel opened); prunes dead entries first. */
	async listBgServers(): Promise<void> {
		await this.bg.listAndPush();
	}

	/** Called by the host when the plugin-task set changes: re-push bg_servers (including plugin tasks). */
	refreshBgTasks(): void {
		this.bg.push();
	}

	/** Used when index.ts needs to send a notice (plugin-settings save result, etc.; emit is private). */
	emitNotice(level: "info" | "warning" | "error", text: string): void {
		this.emit({ type: "notice", level, text });
	}

	/** Kill ONE background server (by port); returns whether anything was killed. */
	/** Kill ONE background server (by port) OR a plugin task (by taskId). */
	async killBackgroundServer(port: number | undefined, taskId?: string): Promise<boolean> {
		if (taskId) {
			// Plugin task: hand to the plugin manager's stop callback (do not kill a process tree — the task lives in the host process).
			const ok = this.pluginStopBgTask?.(taskId) ?? false;
			if (!ok) {
				this.emit({
					type: "notice",
					level: "info",
					text: `Background task "${taskId}" is missing or already stopped`,
				});
			}
			this.bg.push();
			this.flushSnapshot();
			return ok;
		}
		if (typeof port !== "number") return false;
		return this.bg.killOne(port);
	}

	/** Kill every background server the agent started; returns the freed ports. */
	async killAllBackgroundServers(): Promise<string[]> {
		return this.bg.killAll();
	}

	/** Kill only the running bash command(s) — the agent run itself continues
	 *  (the bash tool returns an aborted error and the model moves on). Uses
	 *  the per-client AbortController set registered by
	 *  makeKillableBashTool. */
	async abortBash(): Promise<void> {
		if (this.bashKills.size === 0) {
			this.emit({
				type: "notice",
				level: "info",
				text: "No bash command is running",
			});
			this.flushSnapshot();
			return;
		}
		for (const ac of [...this.bashKills]) ac.abort();
		this.emit({
			type: "notice",
			level: "info",
			text: "Stopped the bash command (conversation continues)",
		});
		// Make it explicit to the AI that the user stopped it: sendUserMessage
		// kicks the next turn; the agent sees "command aborted by the user" rather
		// than a generic failure and continues from there (instead of wondering why the command failed).
		try {
			await this.conv.runtime.session.sendUserMessage(
				"(System: the user stopped the bash command. Output up to abort is in the tool result. Continue from that; do not rerun it unless necessary.)",
			);
		} catch {
			// best effort — a failed message inject does not change the fact that the command was stopped
		}
		this.flushSnapshot();
	}

	/** Interrupt a run: abort, with a force-reset fallback on timeout. */
	private async interruptRun(conv: Conversation, reason: string): Promise<void> {
		// The run is only truly stopped when its agent_end event arrives:
		// session.abort() can return without stopping anything when the run is
		// stuck before the agent even started (e.g. a model stream that never
		// begins), so we watch for agent_end and force-reset when it never
		// comes — covers both abort stuck (timeout) and spinning (settle window).
		let ended = false;
		let forced = false;
		const off = conv.session.subscribe((e) => {
			if (e.type === "agent_end") {
				ended = true;
			}
		});
		const force = () => {
			if (forced) return;
			forced = true;
			void this.forceResetConversation(
				conv,
				`${reason}: run did not stop, forced a reset of this conversation`,
			);
		};
		// 1) abort itself hangs (model stream ignores the signal) → hard kill.
		const abortTimer = setTimeout(() => {
			if (!ended) force();
		}, ClientSession.HARD_ABORT_TIMEOUT_MS);
		abortTimer.unref?.();
		// 2) abort itself (Stop semantics: kills the process tree, emits
		//    agent_end with stopReason "aborted" on the normal path).
		try {
			await conv.runtime.session.abort();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Abort failed: ${(err as Error).message}`,
			});
		}
		// 3) abort returned but no agent_end within the settle window → the
		//    run was stuck before it started; force-reset to recover.
		if (!ended) {
			await new Promise((r) => setTimeout(r, ClientSession.HARD_ABORT_SETTLE_MS));
		}
		clearTimeout(abortTimer);
		off();
		if (!ended) force();
	}

	/** Force-reset a conversation: dispose the stuck runtime (kills the hung
	 *  model stream / child processes) and rebuild it from the most recent
	 *  persisted session. The conversation record itself is kept (same id,
	 *  same cwd, same serialization caches), so the UI stays attached. */
	private async forceResetConversation(conv: Conversation, reason: string): Promise<void> {
		try {
			conv.unsubscribe?.();
			conv.unsubscribe = undefined;
			this.clearAllToolWatchdogs(conv);
			conv.toolStartTimes.clear();
			await conv.runtime.dispose();
			const runtime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(conv.terminals),
				{
					cwd: conv.cwd,
					agentDir: this.agentDir,
					sessionManager: SessionManager.continueRecent(conv.cwd),
				},
			);
			conv.runtime = runtime;
			conv.session = runtime.session;
			this.emit({ type: "notice", level: "warning", text: reason });
			await this.bindSession();
			this.emitConversations();
			void this.pushSlashCommands();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Force-interrupt failed: ${(err as Error).message}`,
			});
		}
	}

	async newChat(): Promise<void> {
		if (this.quiesceBlocked()) return;
		// Reuse an already-open blank conversation instead of piling up new ones
		// on every click: if the active chat has no messages it IS the new chat
		// (focus already on it); otherwise switch to the first blank one (under
		// the per-project running-list model displaced blanks are disposed, so
		// this branch normally can't exist — kept as a safety net).
		const isBlank = (c: Conversation): boolean => {
			try {
				return c.session.getSessionStats().totalMessages === 0 && c.terminals.list().length === 0;
			} catch {
				// session being replaced — treat as used so we don't switch onto it
				return false;
			}
		};
		const active = this.conv;
		if (active && isBlank(active)) {
			this.flushSnapshot();
			return;
		}
		for (const conv of this.convs.values()) {
			if (conv.id === this.activeId) continue;
			if (isBlank(conv)) {
				await this.switchConversation(conv.id);
				this.flushSnapshot();
				return;
			}
		}
		// Cap is per project — conversations of other projects keep their own
		// lists and don't consume this project's slots.
		const openInProject = [...this.convs.values()].filter(
			(c) => c.cwd === this.cwd,
		).length;
		if (openInProject >= MAX_OPEN_CONVERSATIONS) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `This project already has ${MAX_OPEN_CONVERSATIONS} running conversations. Open one and leave it (without prompting) to free a slot`,
			});
			return;
		}
		// The outgoing conversation is left behind — apply the running-list
		// lifecycle. Removal is deferred until the new chat exists so the active
		// conversation stays valid during the (async) runtime creation.
		const displaced = this.displaceActive();
		// Carry the model chosen in the active chat over to the new chat so it
		// doesn't silently revert to the ModelRuntime default model.
		const prevModel = this.conv.session.agent.state.model ?? null;
		try {
			const conversationId = this.nextConversationId();
			const terminals = this.makeTerminalManager(conversationId, this.cwd);
			const runtime = await createAgentSessionRuntime(
				this.makeRuntimeFactory(terminals),
				{
					cwd: this.cwd,
					agentDir: this.agentDir,
					sessionManager: SessionManager.create(this.cwd),
				},
			);
			const conv = this.makeConversation(runtime, conversationId, terminals);
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			// New session seeds with the ModelRuntime default model — restore the
			// model the user had selected in the previous chat.
			if (prevModel && this.sharedModelRuntime) {
				try {
					await this.session.setModel(prevModel);
				} catch {
					// model no longer resolvable — keep the default
				}
			}
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			this.pushTerminals();
			// The new runtime re-discovered skills/templates — refresh the catalog
			// so the picker stops showing the previous runtime's list.
			void this.pushSlashCommands();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to create chat: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * The active conversation is being left (new_chat / switch_conversation /
	 * set_cwd). Runs the running-list lifecycle:
	 *
	 * - still streaming → it becomes a background run: ensure it is listed;
	 * - idle + listed + continued → keep it (the user did continue it);
	 * - any retained terminal state → keep it listed until the terminals are closed;
	 * - idle + listed + opened-but-not-continued, or never listed at all → the
	 *   caller must drop it (returns it so removal happens only after the
	 *   active conversation has been switched away).
	 */
	private displaceActive(): Conversation | null {
		const conv = this.conv;
		// An isolated reviewer can keep working while the main session is idle;
		// retain that conversation so its review is not disposed when the user
		// switches away without sending another prompt.
		if (conv.goal.reviewing || conv.wizardRunning) {
			conv.listed = true;
			return null;
		}
		if (conv.session.isStreaming) {
			conv.listed = true;
			return null;
		}
		// Terminal state is a reason to keep an otherwise idle conversation alive:
		// switching chats must not kill a PTY the user or agent may still need.
		if (conv.terminals.list().length > 0) {
			conv.listed = true;
			return null;
		}
		if (conv.listed && conv.promptedSinceActive) return null;
		return conv;
	}

	/** Remove a conversation from the running list and free its runtime. The
	 *  session stays persisted on disk, so it remains recoverable from the
	 *  history list. Never removes the active conversation. */
	private removeConversation(id: string): void {
		const conv = this.convs.get(id);
		if (!conv || id === this.activeId) return;
		this.convs.delete(id);
		this.clearAllToolWatchdogs(conv);
		conv.terminals.killAll();
		conv.unsubscribe?.();
		conv.unsubscribe = undefined;
		void conv.runtime.dispose().catch(() => {});
	}

	/** Switch the ACTIVE conversation without interrupting any other chat. */
	async switchConversation(id: string): Promise<void> {
		if (!this.convs.has(id) || id === this.activeId) return;
		const displaced = this.displaceActive();
		this.activeId = id;
		this.cwd = this.conv.cwd;
		// All listed conversations share the current project's cwd, so this is
		// normally a no-op — kept defensive for stale clients.
		if (displaced) this.removeConversation(displaced.id);
		this.conv.promptedSinceActive = false;
		this.conv.lastActiveAt = Date.now();
		this.webUi.refresh();
		this.emitConversations();
		this.goalSvc.emitGoalStatus();
		this.pushTerminals();
		// The switched-to conversation has its own runtime (own resource cache).
		void this.pushSlashCommands();
		this.flushSnapshot();
	}

	/** Push the current project's running-conversation list to the client. */
	private emitConversations(): void {
		const conversations: ConversationSummary[] = [];
		for (const conv of this.convs.values()) {
			// The running-conversation list is per project and only contains
			// conversations that were displaced to the background while running.
			if (conv.cwd !== this.cwd || !conv.listed) continue;
			let messageCount = 0;
			let isStreaming = false;
			try {
				messageCount = conv.session.getSessionStats().totalMessages;
				isStreaming = conv.session.isStreaming;
			} catch {
				// session being replaced — report defaults
			}
			conversations.push({
				id: conv.id,
				title: conv.title,
				cwd: conv.cwd,
				messageCount,
				isStreaming,
			});
		}
		this.emit({
			type: "conversations",
			conversations,
			activeId: this.activeId,
		});
	}

	/** List persisted sessions for this client, newest first. */
	/** The client asked for the session list at least once (lazy loading) —
	 *  background refreshes only re-push when this is true, so a mobile
	 *  client that never opened the panel never pays the disk scan. */
	private sessionsRequested = false;

	/** Push the persisted session list to the client (client-requested). */
	async refreshSessions(): Promise<void> {
		this.sessionsRequested = true;
		await this.pushSessions();
	}

	private async pushSessions(): Promise<void> {
		if (!this.sessionsRequested) return;
		if (!this.sessionsRequested) return;
		try {
			// Sessions live in the SDK default per-project dir
			// (<agentDir>/sessions/--<cwd>--/), the same files the pi CLI/TUI
			// use — one listing covers every conversation of the current folder.
			const infos = await SessionManager.list(this.cwd);

			const sessions = new Map<string, SessionSummary>();
			for (const s of infos) {
				sessions.set(s.path, {
					path: s.path,
					name: s.name,
					firstMessage: s.firstMessage,
					messageCount: s.messageCount,
					modified: s.modified.getTime(),
					source: "web",
				});
			}
			const sorted = [...sessions.values()]
				.sort((a, b) => b.modified - a.modified)
				.slice(0, 200); // newest first — the panel shows recent history
			this.emit({ type: "sessions", sessions: sorted });
		} catch {
			this.emit({ type: "sessions", sessions: [] });
		}
	}

	/** Remove an entry from the client's recent-project list (UI state only). */
	async removeProject(path: string): Promise<void> {
		this.stateStore.removeProject(this.clientId, path);
		await this.pushProjects();
	}

	/** Permanently delete a persisted session transcript file (history list ✕). */
	async deleteSession(path: string): Promise<void> {
		try {
			const abs = resolve(path);
			// Guardrail: only transcripts under the shared sessions root
			// (<agentDir>/sessions/) may be deleted — never arbitrary files.
			const sessionsRoot = resolve(this.agentDir, "sessions");
			if (!abs.startsWith(sessionsRoot + sep)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "Can only delete session files inside the sessions directory",
				});
				return;
			}
			// Refuse to pull the file out from under a live conversation.
			for (const conv of this.convs.values()) {
				if (conv.session.sessionFile === abs) {
					this.emit({
						type: "notice",
						level: "warning",
						text: "That conversation is in use; switch away before deleting",
					});
					return;
				}
			}
			rmSync(abs, { force: true });
			await this.refreshSessions();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to delete session: ${(err as Error).message}`,
			});
		}
	}

	/** Switch the active session to a persisted one (from listSessions). */
	async switchSession(path: string): Promise<void> {
		if (this.quiesceBlocked()) return;
		try {
			await this.runtime.switchSession(path);
			await this.bindSession();
			// The resumed session carries its own cwd — sync it into the ACTIVE
			// conversation (other open conversations are untouched).
			this.conv.cwd = this.runtime.cwd;
			this.cwd = this.runtime.cwd;
			this.conv.title = conversationTitle(this.runtime.session);
			// Deliberately resumed — must not be dismissed when the user later
			// switches away without sending a new message.
			this.conv.promptedSinceActive = true;
			this.emitConversations();
			// switchSession replaced the runtime — its resource cache is fresh.
			void this.pushSlashCommands();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch session: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Map a rendered user-message id (`u-<timestamp>-<seq>`, assigned in
	 * serialize.ts) back to its append-only session entry id. The seq handles
	 * two user messages sharing the same millisecond timestamp.
	 */
	private resolveUserMessageEntryId(messageId: string): string | null {
		const m = /^u-(\d+)(?:-(\d+))?$/.exec(messageId);
		if (!m) return null;
		const ts = Number(m[1]);
		const seq = m[2] ? Number(m[2]) : 1;
		let count = 0;
		// Resolve against the compaction-aware current leaf path — the same list
		// the UI renders (state.messages). Scanning the whole file (getEntries)
		// could match a summarized entry or one on a different branch.
		for (const entry of this.session.sessionManager.buildContextEntries()) {
			if (entry.type !== "message") continue;
			const msg = (entry as unknown as { message?: AgentMessage }).message;
			if (!msg || msg.role !== "user" || msg.timestamp !== ts) continue;
			count += 1;
			if (count === seq) return entry.id;
		}
		return null;
	}

	/**
	 * Edit a past user question and re-ask it: forks a NEW session file that
	 * keeps everything up to (but not including) that question, then sends the
	 * edited text there. The original thread is untouched and stays in the
	 * session list, so nothing is ever lost.
	 *
	 * Attachments (attachments) travel through the SAME pipeline as prompt()
	 * — the fork intentionally drops the original attachment asides because
	 * they live on the old branch past the fork point, so the browser re-sends
	 * the images it kept in the edit composer (original image blocks + any
	 * newly pasted/dropped ones). Text-only edits pass undefined.
	 */
	async editMessage(
		messageId: string,
		text: string,
		attachments?: Parameters<ClientSession["prompt"]>[1],
	): Promise<void> {
		if (this.quiesceBlocked()) return;
		const trimmed = text.trim();
		if (!trimmed) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "Edit was empty, cancelled",
			});
			this.flushSnapshot();
			return;
		}
		const entryId = this.resolveUserMessageEntryId(messageId);
		if (!entryId) {
			this.emit({
				type: "notice",
				level: "error",
				text: "Cannot find that message to edit (compacted or not on this branch)",
			});
			this.flushSnapshot();
			return;
		}
		try {
			// Preserve the model the user had selected — fork() seeds a new
			// branch with the ModelRuntime default model otherwise.
			const prevModel = this.session.agent.state.model ?? null;
			const result = await this.runtime.fork(entryId);
			if (result.cancelled) {
				this.emit({
					type: "notice",
					level: "info",
					text: "Cancelled edit & re-ask",
				});
				this.flushSnapshot();
				return;
			}
			await this.bindSession();
			// Restore the previously-selected model on the forked branch.
			if (prevModel && this.sharedModelRuntime) {
				try {
					await this.session.setModel(prevModel);
				} catch {
					// model no longer resolvable — keep the default
				}
			}
			await this.prompt(trimmed, attachments);
			this.emit({
				type: "notice",
				level: "info",
				text: "Re-asked from that question (original conversation stays in the list)",
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Edit & re-ask failed: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Push the recent-project list (persisted per client, merged with every cwd
	 * that has persisted sessions in this client's session store — so workspaces
	 * opened before the recent-list feature existed still show up).
	 */
	async pushProjects(): Promise<void> {
		try {
			const saved = this.stateStore.get(this.clientId);
			const removedProjects = new Set(
				this.stateStore.getRemovedProjects(this.clientId),
			);
			const map = new Map<string, number>();
			for (const p of saved.projects) map.set(p.path, p.lastUsed);
			const all = await SessionManager.listAll();
			for (const s of all) {
				if (s.cwd) {
					const t = s.modified.getTime();
					const prev = map.get(s.cwd);
					if (prev === undefined || t > prev) map.set(s.cwd, t);
				}
			}
			// Only keep directories that still exist — a deleted/unmounted workspace
			// is useless in the picker. Tombstoned entries (explicitly removed by
			// the user) stay hidden even though session files still mention them.
			const projects: ProjectSummary[] = [...map.entries()]
				.filter(([path]) => !removedProjects.has(path) && existsSync(path))
				.map(([path, lastUsed]) => ({ path, lastUsed }))
				.sort((a, b) => b.lastUsed - a.lastUsed)
				.slice(0, 20);
			this.emit({ type: "projects", projects });
		} catch {
			this.emit({ type: "projects", projects: [] });
		}
	}

	/** List a workspace directory (relative to the configured cwd). */
	async listFiles(relPath?: string): Promise<void> {
		return this.files.listFiles(relPath);
	}

	/** Global search: recursive filename match (results pushed back as search_files_result, matched by reqId). */
	async searchFiles(query: string, reqId: number): Promise<void> {
		return this.files.searchFiles(query, reqId);
	}

	/** Read-only SCM query (structured JSON, matched by reqId). */
	async scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		arg?: { path?: string; hash?: string },
	): Promise<void> {
		return this.files.scmQuery(kind, reqId, arg);
	}

	/** Local Review: parsed working-tree / branch diff for line comments. */
	async reviewDiff(reqId: number, mode?: string, base?: string): Promise<void> {
		const { emitReviewDiff } = await import("./review/wire.js");
		return emitReviewDiff(this.cwd, reqId, mode, base, (msg) => this.emit(msg));
	}

	/** Local Review: persist line comments under .local-review/. */
	async reviewSubmit(
		reqId: number,
		mode: string | undefined,
		baseBranch: string | undefined,
		comments: import("./review/types.js").ReviewComment[],
	): Promise<void> {
		const { emitReviewSubmit } = await import("./review/wire.js");
		return emitReviewSubmit(this.cwd, reqId, mode, baseBranch, comments, (msg) => this.emit(msg));
	}

	async reviewSetStatus(
		status: "applied" | "dismissed",
		id?: string,
	): Promise<void> {
		const { emitReviewSetStatus } = await import("./review/wire.js");
		return emitReviewSetStatus(this.cwd, status, id, (msg) => this.emit(msg));
	}

	async pushReviewStatus(): Promise<void> {
		try {
			const { pendingReviewSummary } = await import("./review/review.js");
			const summary = await pendingReviewSummary(this.cwd);
			this.emit({
				type: "review_status",
				pending: summary.pending,
				commentCount: summary.commentCount,
			});
		} catch {
			this.emit({ type: "review_status", pending: [], commentCount: 0 });
		}
	}

	/** Inject pending review comments into the current conversation and run. */
	async reviewApply(): Promise<void> {
		if (this.quiesceBlocked()) return;
		try {
			const { applyPendingPrompt, pendingReviewsMarkdown } = await import("./review/review.js");
			const markdown = await pendingReviewsMarkdown(this.cwd);
			if (markdown.startsWith("No pending Local Review")) {
				this.emit({ type: "notice", level: "info", text: "No pending Local Review comments." });
				return;
			}
			await this.prompt(applyPendingPrompt(markdown));
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to apply Local Review: ${(err as Error).message}`,
			});
		}
	}

	private async maybeNudgeReview(): Promise<void> {
		try {
			const { pendingReviewSummary } = await import("./review/review.js");
			const summary = await pendingReviewSummary(this.cwd);
			// The pending-review chip already covers this workspace.
			if (summary.pending.length > 0) return;
			const { isWorkingTreeDirty } = await import("./review/git.js");
			if (await isWorkingTreeDirty(this.cwd)) {
				this.emit({ type: "review_nudge" });
			}
		} catch {
			/* not a git repo or git missing */
		}
	}

	setSessionName(name: string): void {
		try {
			this.session.setSessionName(name);
			void this.refreshSessions();
			this.emit({ type: "notice", level: "info", text: `Session named: ${name}` });
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to name session: ${(err as Error).message}`,
			});
		}
	}

	emitSessionTree(): void {
		try {
			const leafId = this.session.sessionManager.getLeafId();
			const items = this.session.getUserMessagesForForking().map((m) => ({
				entryId: m.entryId,
				text: m.text.trim().slice(0, 200) || "(empty)",
				current: m.entryId === leafId,
			}));
			this.emit({ type: "session_tree_data", leafId, items });
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to read session tree: ${(err as Error).message}`,
			});
		}
	}

	async navigateTree(entryId: string): Promise<void> {
		if (this.quiesceBlocked()) return;
		try {
			await this.session.navigateTree(entryId);
			this.flushSnapshot();
			void this.refreshSessions();
			this.emit({ type: "notice", level: "info", text: "Jumped to that question; later replies will fork from here." });
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to jump in the session tree: ${(err as Error).message}`,
			});
		}
	}

	async exportSession(): Promise<void> {
		try {
			const path = await this.session.exportToHtml();
			this.emit({ type: "notice", level: "info", text: `Exported session: ${path}` });
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to export session: ${(err as Error).message}`,
			});
		}
	}

	private bundledPromptPaths(): string[] {
		const root = this.pkgRoot();
		const dir = join(root, "prompts");
		return existsSync(dir) ? [dir] : [];
	}

	private extraSkillPaths(): string[] {
		const root = this.pkgRoot();
		const home = homedir();
		const candidates = [
			join(root, "skills"),
			join(home, ".claude", "skills"),
			join(home, ".agents", "skills"),
			join(home, ".cursor", "skills"),
			...(this.settingsSvc.current.additionalSkillPaths ?? []),
		];
		const seen = new Set<string>();
		const out: string[] = [];
		for (const p of candidates) {
			const abs = resolve(p);
			if (seen.has(abs) || !existsSync(abs)) continue;
			seen.add(abs);
			out.push(abs);
		}
		return out;
	}

	private pkgRoot(): string {
		if (process.env.PI_WEB_PKG_ROOT) return process.env.PI_WEB_PKG_ROOT;
		let dir = dirname(fileURLToPath(import.meta.url));
		for (let i = 0; i < 5; i += 1) {
			if (existsSync(join(dir, "package.json"))) return dir;
			dir = dirname(dir);
		}
		return dirname(fileURLToPath(import.meta.url));
	}

	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	async readFile(relPath: string): Promise<void> {
		return this.files.readFile(relPath);
	}

	/** Save text from the file preview panel within the active workspace. */
	async writeFile(relPath: string, text: string): Promise<void> {
		return this.files.writeFile(relPath, text);
	}

	async cycleModel(): Promise<void> {
		try {
			await this.session.cycleModel();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Path completion for the cwd input: expand ~/relative paths, list the parent
	 * directory, and return prefix matches (dirs first, capped).
	 */
	async completePath(input: string): Promise<void> {
		return this.files.completePath(input);
	}

	async setCwd(newCwd: string): Promise<void> {
		try {
			const { resolve } = await import("node:path");
			this.files.unwatchGit(); // stale repo's watcher must not fire across projects
			const fs = await import("node:fs/promises");
			const abs = resolve(newCwd);
			const st = await fs.stat(abs);
			if (!st.isDirectory()) {
				throw new Error("Path is not a directory");
			}
			if (abs === this.cwd) {
				this.emit({
					type: "notice",
					level: "info",
					text: `Already in workspace: ${abs}`,
				});
				this.flushSnapshot();
				return;
			}

			// The outgoing conversation is left behind — apply the running-list
			// lifecycle (removal is deferred until the active conversation is
			// safely switched away).
			const displaced = this.displaceActive();

			// Prefer the target project's own most recently active conversation;
			// only create a fresh one (resuming its most recent session) when the
			// project has none open yet.
			let target: Conversation | undefined;
			for (const c of this.convs.values()) {
				if (
					c.cwd === abs &&
					(!target || c.lastActiveAt > target.lastActiveAt)
				) {
					target = c;
				}
			}

			if (target) {
				this.activeId = target.id;
				if (displaced) this.removeConversation(displaced.id);
			} else {
				// First visit to this project: resume its most recent session.
				const conversationId = this.nextConversationId();
				const terminals = this.makeTerminalManager(conversationId, abs);
				const newRuntime = await createAgentSessionRuntime(
					this.makeRuntimeFactory(terminals),
					{
						cwd: abs,
						agentDir: this.agentDir,
						sessionManager: SessionManager.continueRecent(abs),
					},
				);
				const conv = this.makeConversation(newRuntime, conversationId, terminals);
				this.convs.set(conv.id, conv);
				this.activeId = conv.id;
				if (displaced) this.removeConversation(displaced.id);
				for (const d of newRuntime.diagnostics) {
					if (d.type !== "info") {
						this.emit({ type: "notice", level: d.type, text: d.message });
					}
				}
				await this.bindSession();
			}

			this.pushTerminals();
			this.conv.promptedSinceActive = false;
			this.conv.lastActiveAt = Date.now();
			this.cwd = abs;
			// Workspace-following plugins (editor file tree, etc.) switch roots in sync.
			try {
				this.onCwdChanged?.(abs);
			} catch {
				/* a hook exception must not affect the main flow */
			}
			// Remember the new workspace (restore target + recent-project entry).
			this.stateStore.remember(this.clientId, abs);
			void this.pushProjects();
			this.webUi.refresh();
			this.emitConversations();
			this.goalSvc.emitGoalStatus();
			// Skills / prompt templates are project-bound — refresh the catalog.
			void this.pushSlashCommands();
			this.emit({
				type: "notice",
				level: "info",
				text: `Switched workspace to: ${abs}`,
			});
			void this.refreshSessions();
			void this.listFiles(undefined);
			// Commands are per-project (.pi/commands.json in the current cwd).
			void this.listCommands();
			void this.pushReviewStatus();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch workspace: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** List models that have valid authentication configured. */
	async listModels(): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			const available = await mr.getAvailable();
			const models = available.map((m) => ({
				id: `${m.provider}/${m.id}`,
				name: m.name,
				provider: m.provider,
				reasoning: m.reasoning,
				vision: m.input?.includes("image") ?? false,
			}));
			this.emit({ type: "models", models });
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to list models: ${(err as Error).message}`,
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Goal / review
	// ---------------------------------------------------------------------------

	/** Goal family delegates to GoalService (see goal-service.ts). */
	async setGoal(
		goalText: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			autoStart?: boolean;
		},
	): Promise<void> {
		return this.goalSvc.setGoal(goalText, opts);
	}

	async startGoalWizard(
		text: string,
		opts?: {
			wizardModel?: string;
			maxRounds?: number;
			locked?: boolean;
		},
	): Promise<void> {
		return this.goalSvc.startGoalWizard(text, opts);
	}

	async setGoalPrefs(opts?: {
		reviewModel?: string;
		maxRounds?: number;
		locked?: boolean;
	}): Promise<void> {
		return this.goalSvc.setGoalPrefs(opts);
	}

	async clearGoal(): Promise<void> {
		return this.goalSvc.clearGoal();
	}

	/** Run a git diff (unstaged + staged) in a conversation's workspace, or
	 * "" when not a repo. */
	private async gitDiff(cwd: string): Promise<string> {
		try {
			const { code, out } = await this.runAsync(
				"git",
				["diff", "HEAD"],
				10_000,
				cwd,
			);
			if (code !== 0) return "";
			return out.slice(0, 60_000);
		} catch {
			return "";
		}
	}

	/** Switch to a specific model by "provider/id" (e.g. "anthropic/claude-sonnet-5"). */
	async setModel(modelId: string): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			const slash = modelId.indexOf("/");
			if (slash <= 0 || slash === modelId.length - 1) {
				throw new Error(`Invalid model ID: ${modelId}`);
			}
			const provider = modelId.slice(0, slash);
			const id = modelId.slice(slash + 1);
			const model = mr.getModel(provider, id);
			if (!model) throw new Error(`Model not found: ${modelId}`);
			await this.session.setModel(model);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Set the thinking level for future turns. */
	setThinking(level: string): void {
		try {
			this.session.setThinkingLevel(
				level as Parameters<AgentSession["setThinkingLevel"]>[0],
			);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to set thinking level: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	cycleThinking(): void {
		try {
			this.session.cycleThinkingLevel();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to set thinking level: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Push the user command list (.pi/commands.json) to the client. */
	async listCommands(): Promise<void> {
		const { commands, path, warning } = await loadCommands(this.cwd);
		if (warning) {
			this.emit({ type: "notice", level: "warning", text: warning });
		}
		this.emit({ type: "commands", commands, path });
	}

	/** Persist the user command list (.pi/commands.json). */
	async saveCommands(commands: CommandDef[]): Promise<void> {
		const { path, error } = await saveCommandsFile(this.cwd, commands);
		if (error) {
			this.emit({ type: "notice", level: "error", text: error });
			return;
		}
		this.emit({ type: "commands", commands, path });
		this.emit({ type: "notice", level: "info", text: `Commands saved: ${path}` });
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const conv of this.convs.values()) conv.terminals.killAll();
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		if (this.sessionsTimer) {
			clearTimeout(this.sessionsTimer);
			this.sessionsTimer = null;
		}
		if (this.widgetsTimer) {
			clearInterval(this.widgetsTimer);
			this.widgetsTimer = null;
		}
		if (this.stallTimer) {
			clearInterval(this.stallTimer);
			this.stallTimer = null;
		}
		this.files.unwatchDir();
		this.files.unwatchGit();
		this.webUi.dispose();
		this.bg.stop();
		for (const conv of this.convs.values()) {
			this.clearAllToolWatchdogs(conv);
			conv.unsubscribe?.();
			try {
				await conv.runtime.dispose();
			} catch {
				// best effort
			}
		}
	}
}

export class AgentService {
		/** Injected by index.ts: plugin-forwarding hook for SDK tool-execution events; copied onto every new session at attach. */
	onToolEvent: ((ev: PluginToolEvent) => void) | undefined = undefined;
	/** Injected by index.ts: read AI tools currently registered by plugins (copied onto every new session at attach). */
	pluginToolsProvider: (() => PluginAgentTool[]) | undefined = undefined;
	/** Injected by index.ts: read slash commands currently registered by plugins (copied onto every new session at attach). */
	pluginCommandsProvider: (() => PluginCommandDef[]) | undefined = undefined;
	/** Injected by index.ts: read resident background tasks registered by plugins (folded into the bg_servers panel). */
	pluginBgTasksProvider: (() => BgServer[]) | undefined = undefined;
	/** Injected by index.ts: stop a plugin task (kill_background_server with taskId). */
	pluginStopBgTask: ((taskId: string) => boolean) | undefined = undefined;
	private clients = new Map<string, ClientSession>();
	/** Quiesce (draining) state — the service refuses NEW work (prompts, forks,
	 *  session resumes, new clients) so a deploy/upgrade/backup can stop cleanly
	 *  once existing runs finish. Controlled via the local control socket:
	 *  `pi-web-ui server quiesce|unquiesce`. */
	private quiesced = false;
	private quiescedAt = 0;
	/** Attached browser sockets (reported by index.ts on open/close) — the
	 *  control socket reports real sockets, not cached client-session objects. */
	private socketCount = 0;
	private pending = new Map<string, Promise<ClientSession>>();
	private stateStore: ClientStateStore;
	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;
	/** Fired after any client successfully switches workspace (new absolute path).
	 *  index.ts wires PluginManager.notifyCwd so the plugin host's host.cwd follows the current project live. */
	onClientCwdChanged: ((cwd: string) => void) | undefined = undefined;

	constructor(
		private cwd: string,
		stateFile: string,
	) {
		this.stateStore = new ClientStateStore(stateFile);
	}

	/** Get or create the session for a client, racing attach calls safely. */
	/** True while the service is draining — new work is refused. */
	isQuiesced(): boolean {
		return this.quiesced;
	}

	/** Enter quiesce: stop admitting new work. Existing runs keep going. */
	quiesce(): void {
		this.quiesced = true;
		this.quiescedAt = Date.now();
	}

	/** Leave quiesce: admit new work again. */
	unquiesce(): void {
		this.quiesced = false;
		this.quiescedAt = 0;
	}

	/** Snapshot for the control socket / status command. */
	quiesceInfo(): { quiesced: boolean; quiescedSince?: number } {
		return this.quiesced
			? { quiesced: true, quiescedSince: this.quiescedAt }
			: { quiesced: false };
	}

	/** Aggregate across every client session: conversations with in-flight runs. */
	activeConversations(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.activeConversations();
		return n;
	}

	/** Aggregate across every client session: messages queued in the SDK. */
	pendingMessages(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.pendingMessages();
		return n;
	}

	/** index.ts calls this when a browser socket opens/closes. */
	noteSocketOpen(): void {
		this.socketCount += 1;
	}
	noteSocketClose(): void {
		this.socketCount = Math.max(0, this.socketCount - 1);
	}

	/** Full status for the control socket / `server status` command. */
	serviceStatus(): {
		pid: number;
		version: string;
		cwd: string;
		quiesced: boolean;
		quiescedSince?: number;
		connectedClients: number;
		activeConversations: number;
		pendingMessages: number;
	} {
		return {
			pid: process.pid,
			version: VERSION,
			cwd: this.cwd,
			...this.quiesceInfo(),
			connectedClients: this.socketCount,
			activeConversations: this.activeConversations(),
			pendingMessages: this.pendingMessages(),
		};
	}

	/** Get or create the session for a client, racing attach calls safely. */
	async attach(
		clientId: string,
		send: (msg: ServerMessage) => void,
	): Promise<ClientSession> {
		let cs = this.clients.get(clientId);
		if (!cs) {
			const inflight = this.pending.get(clientId);
			if (inflight) {
				cs = await inflight;
			} else {
				// Restore this client's last-used workspace when it still exists;
				// Admission gate: while quiesced, only clients with an EXISTING
				// session may attach (they can watch their runs drain); brand-new
				// clients are refused — index.ts closes their socket (4403) and the
				// browser reconnect loop retries after admission reopens.
				if (this.quiesced) {
					throw new QuiesceRejectedError("New connections are refused until the server unquiesces");
				}
				// otherwise fall back to the server's configured default cwd.
				let cwd = this.cwd;
				const saved = this.stateStore.get(clientId);
				if (saved.lastCwd && saved.lastCwd !== this.cwd) {
					try {
						if (statSync(saved.lastCwd).isDirectory()) cwd = saved.lastCwd;
					} catch {
						// gone (unmounted drive / deleted) — fall back to the default
					}
				}
				// Sessions use the SDK default per-project dir — no per-client dir.
				const creating = ClientSession.create(
					clientId,
					cwd,
					this.stateStore,
				).finally(() => {
					this.pending.delete(clientId);
				});
				this.pending.set(clientId, creating);
				cs = await creating;
				this.clients.set(clientId, cs);
				// Make sure the restored/default workspace appears in the project list.
				this.stateStore.remember(clientId, cwd);
				if (cwd !== this.cwd) {
					send({
						type: "notice",
						level: "info",
						text: `Restored last workspace: ${cwd}`,
					});
				}
			}
		}
		// First attach after a restart: report runs that were interrupted when
		// the previous process shut down (consumed once, then cleared). Queue
		// BEFORE attachSink so the notice rides the initial pending-notice flush.
		cs.notifyInterrupted(this.stateStore.takeInterrupted(clientId));
		cs.attachSink(send);
		// Forward hooks (set once by index.ts) to every session.
		cs.onQuit = this.onQuit;
		cs.onToolEvent = this.onToolEvent;
		cs.pluginToolsProvider = this.pluginToolsProvider;
		cs.pluginCommandsProvider = this.pluginCommandsProvider;
		cs.pluginBgTasksProvider = this.pluginBgTasksProvider;
		cs.pluginStopBgTask = this.pluginStopBgTask;
		cs.isQuiesced = () => this.quiesced;
		// Plugin-host workspace follow: also sync once on first attach (restored lastCwd
		// may ≠ the server start directory). notifyCwd is idempotent; later successful
		// set_cwd continues to drive via cs.onCwdChanged.
		cs.onCwdChanged = (abs) => this.onClientCwdChanged?.(abs);
		this.onClientCwdChanged?.(cs.cwd);
		return cs;
	}

	/** Triggered by index.ts when the plugin AI-tool set changes (register/unregister): push into every session of every client. */
	applyPluginAgentTools(): void {
		for (const cs of this.clients.values()) cs.refreshPluginTools();
	}

	/** Triggered by index.ts when the plugin slash-command set changes: re-push each client's command catalog. */
	applyPluginCommandCatalog(): void {
		for (const cs of this.clients.values()) void cs.pushSlashCommands();
	}

	/** After local_review_mark_applied, refresh the pending-review chip. */
	broadcastReviewStatus(): void {
		for (const cs of this.clients.values()) void cs.pushReviewStatus();
	}

	/** Triggered by index.ts when plugin resident background tasks change: re-push each client's bg_servers. */
	refreshBackgroundServers(): void {
		for (const cs of this.clients.values()) cs.refreshBgTasks();
	}

	/** Remove a socket from a client's broadcast set (called on socket close). */
	detach(clientId: string, send: (msg: ServerMessage) => void): void {
		this.clients.get(clientId)?.detachSink(send);
	}

	get(clientId: string): ClientSession | undefined {
		return this.clients.get(clientId);
	}

	async disposeAll(): Promise<void> {
		// Record still-streaming conversations BEFORE tearing anything down, so
		// the next attach can tell the user what was lost (SIGTERM / update).
		for (const [clientId, cs] of [...this.clients]) {
			try {
				const running = cs.streamingSummaries();
				if (running.length > 0) {
					this.stateStore.saveInterrupted(
						clientId,
						running.map((r) => ({ ...r, at: Date.now() })),
					);
				}
			} catch {
				// best effort — never block shutdown on bookkeeping
			}
		}
		const all = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(all.map((cs) => cs.dispose()));
	}
}
