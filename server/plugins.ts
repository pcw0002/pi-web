/**
 * pi-web-ui plugin manager — load and bridge optional UI components.
 *
 * A plugin is a directory <dataDir>/plugins/<id>/:
 *   manifest.json   metadata { id?, name, version?, description? } (id defaults to the directory name)
 *   index.mjs       server entry (optional): export default { activate(host) → deactivate? }
 *   client/         frontend assets (optional), served as static files at /plugins/<id>/client/*;
 *     entry.mjs      view entry: export default { mount(el, ctx) → cleanup? }
 *
 * Design notes:
 * - Absent means absent: with no directory there is no protocol/UI trace. The directory
 *   is re-scanned on every client attach, so a newly dropped-in plugin appears in the
 *   top bar without a server restart (import happens once and is cached).
 * - id must match ID_RE to block path traversal; the client static server validates each segment too.
 * - Narrow host: broadcast(pluginId, payload) fans out plugin_data, onMessage registers
 *   client uplink handlers, plus dataDir/cwd/log. The send channel is injected by
 *   index.ts (each socket's send); the plugin never touches ws itself.
 * - An activate throw only sets the error field and logs; it must never affect the main process.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ServerMessage, UiPluginInfo, BgServer, UiPluginSettingField } from "./protocol.js";
import { PluginStorage, PluginSecrets, ensurePluginDeps, WorkspaceFS } from "./plugin-facilities.js";
import type { Request, Response } from "express";
import { createHash } from "node:crypto";

/** Legal plugin id: letters/digits/underscore/hyphen; blocks path traversal (same approach as themes.ts). */
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** Tool-execution event delivered to plugins (forwarded from agent-service's SDK tool_execution_start/end). */
export interface PluginToolEvent {
	phase: "start" | "end";
	toolName: string;
	/** Conversation the event belongs to (may be empty if the session is not ready). */
	conversationId?: string;
	/** end-only: real execution duration in ms / whether it errored. */
	durationMs?: number;
	isError?: boolean;
}

/**
 * AI tool registered by a plugin (structured definition, decoupled from the SDK
 * ToolDefinition — agent-service does the conversion). execute returns
 * { content, details? } (content is [{type:"text",text}] or image blocks), or a
 * string/object directly (wrapped as text automatically).
 */
export interface PluginAgentTool {
	/** Tool name (prefer a <plugin>_<action> prefix, e.g. mail_list; globally unique — a duplicate registration is rejected). */
	name: string;
	/** UI display label. */
	label?: string;
	/** Tool description for the LLM. */
	description: string;
	/** Optional: one-line summary in the system prompt's Available tools section. */
	promptSnippet?: string;
	/** Optional: bullets appended to the system prompt Guidelines. */
	promptGuidelines?: string[];
	/** Parameter JSON Schema (TypeBox / JSON Schema compatible). Defaults to an empty object. */
	parameters?: Record<string, unknown>;
	/** Implementation; onUpdate may stream partial results (same shape). */
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: unknown) => void,
	): Promise<unknown>;
}

/** Host interface handed to the plugin's server entry. */
export interface PluginHost {
	/** Broadcast a message from this plugin to every connected browser (plugin_data). */
	broadcast(payload: unknown): void;
	/** Send a system notice to every connected browser. */
	notify(level: "info" | "warning" | "error", text: string): void;
	/** Register a client-uplink (plugin_message) handler; the callback's second arg is
	 *  the sender clientId (usable with sendTo for a directed reply). Returns an unsubscribe. */
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
	/** Send a directed plugin message to one client (not broadcast); clientId comes from onMessage. */
	sendTo(clientId: string, payload: unknown): void;
	/** Register a "new client attached" hook: every browser attach (including connections
	 *  already present when the plugin just activated, and re-attaches after plugins_reload)
	 *  is called back with clientId. Plugins should use this to push their full state
		 *  (kind:"state", etc.) — the server is the source of truth. Do not rely on the
		 *  client pulling after mount (a bare ctx.send({action:"state"}) has no reqId, so
		 *  the response is silently dropped by the client's pending matcher — a pit fallen
		 *  into twice). Returns an unsubscribe. */
	onAttach(handler: (clientId: string) => void): () => void;
	/** Subscribe to agent tool-execution events (bash / file R/W, etc., start+end pairs); returns an unsubscribe. */
	onToolEvent(handler: (ev: PluginToolEvent) => void): () => void;
	/** Register a tool the AI can call (attached when a new conversation is created,
	 *  injected dynamically into existing sessions). Returns an unsubscribe — the plugin
	 *  may register/unregister at any time from its own config toggle (e.g. the mail
	 *  plugin's "let AI manage mail" switch). */
	registerAgentTool(tool: PluginAgentTool): () => void;
	/** This plugin's own persistence directory (<dataDir>/plugins/<id>) — credentials live here. */
	dir: string;
	/** Global data directory (~/.pi-web). */
	dataDir: string;
	/** Current agent workspace — **live**: follows the new root after any client's
	 *  successful set_cwd. Plugins may read it at any time; use onCwdChange to observe changes. */
	get cwd(): string;
	/** Register a workspace-change callback (fired with the new absolute path after the
	 *  main app's set_cwd succeeds). Returns an unsubscribe. Older hosts lack this method (optional-chain compatible). */
	onCwdChange(handler: (cwd: string) => void): () => void;
	/** Register a slash command (/name) that appears in the input-box picker; the server intercepts and runs it.
	 *  Returns an unsubscribe. Duplicate names are rejected (built-ins win, then first-registered plugin). */
	registerCommand(cmd: PluginCommandDef): () => void;
	/** Plugin-private KV store (<pluginDir>/storage.json, atomic write, deleted on uninstall). */
	storage: {
		get<T>(key: string, fallback?: T): T | undefined;
		set(key: string, value: unknown): void;
		delete(key: string): void;
		all(): Record<string, unknown>;
	};
	/** Encrypted secret store (AES-256-GCM; passwords / API keys / tokens).
	 *  Plaintext never hits disk; copied to another machine it cannot decrypt without the host key. */
	secrets: {
		set(name: string, value: string): void;
		get(name: string): string | undefined;
		has(name: string): boolean;
		delete(name: string): void;
		list(): string[];
	};
	/** Ensure dependencies are ready: missing ones are npm-installed into the plugin directory (single-flight).
	 *  import only succeeds after resolve — plugins should await this before dynamically loading heavy deps. */
	ensureDeps(specs: string[], opts?: { onProgress?: (msg: string) => void }): Promise<boolean>;
	/** Mount an HTTP route, actually exposed as /plugins-api/<id><path> (GET/POST/PUT/DELETE).
	 *  The main site's PI_WEB_TOKEN auth covers these automatically; the body has already been
	 *  through express.json. A throwing handler becomes a 500 and does not crash the process.
	 *  Returns an unsubscribe. Requires the "http" capability. */
	route(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		handler: (req: Request, res: Response) => void,
	): () => void;
	/** Sandboxed workspace file access (read/write/list/delete): paths are always
	 *  anchored at the current workspace root (a live value that follows set_cwd).
	 *  Out-of-tree paths are rejected — unlike a plugin importing node:fs itself,
	 *  this layer is enforced by the host. Requires the "fs" capability. */
	fs: {
		list(relDir?: string): Promise<{ name: string; type: "file" | "dir" }[]>;
		read(relPath: string): Promise<Buffer>;
		readText(relPath: string, maxBytes?: number): Promise<string>;
		write(relPath: string, data: string | Uint8Array): Promise<void>;
		remove(relPath: string): Promise<void>;
	};
	/** Register a resident background task (poller / connection pool / background worker…):
	 *  it appears in the top-bar background-tasks panel and the user can stop it in one click.
	 *  Returns { update, unregister }. id is unique within the plugin. */
	registerBackgroundTask(task: {
		id: string;
		/** Panel display name (e.g. "📬 Mail poller"). */
		label: string;
		/** Stop callback (fired by the panel's Stop button; the user may also kill the process tree directly). */
		stop?: () => void;
		/** Optional initial status text; later refreshable via update(). */
		status?: string;
	}): {
		update(next: Partial<{ label: string; status: string; stop: () => void }>): void;
		unregister(): void;
	};
	/** Read host-managed settings values (fields declared in the manifest "settings",
	 *  stored values in storage.json merged with defaults). Plugins should treat this as the source of runtime behavior. */
	getSettings(): Record<string, unknown>;
	/** Subscribe to "the user changed this plugin's declarative settings in the ⚙ panel"
	 *  (fires after save, argument is the new values object). Returns an unsubscribe.
	 *  After a change, re-read getSettings() yourself. */
	onSettingsChanged(handler: (values: Record<string, unknown>) => void): () => void;
	/** Prefixed logger. */
	log(...args: unknown[]): void;
}

interface LoadedPlugin {
	info: UiPluginInfo;
	/** deactivate() if the entry provided one. */
	deactivate?: () => void;
	toolHandlers: Set<(ev: PluginToolEvent) => void>;
	/** onAttach hooks (called one by one when a new client attaches). */
	attachHandlers: Set<(clientId: string) => void>;
	/** onCwdChange hooks (called one by one on a workspace switch). */
	cwdHandlers: Set<(cwd: string) => void>;
	/** Unsubscribers for every AI tool this plugin registered (called one by one on deactivate). */
	agentToolUnsubscribers?: Array<() => void>;
	/** Unsubscribers for every slash command this plugin registered. */
	commandUnsubscribers?: Array<() => void>;
	/** HTTP route table this plugin mounted: "METHOD /path" → handler. */
	httpRoutes: Map<string, (req: Request, res: Response) => void>;
	/** Raw manifest.permissions declaration (empty/absent = undeclared, legacy full-access). Error-path placeholders may omit it. */
	permsDeclared?: string[];
	/** Capability families from the declaration (colon prefix stripped): fs/net/tools/http/terminal… */
	permFamilies?: Set<string>;
	/** Whether the legacy full-access "undeclared" warning has already been issued (once per activation). */
	legacyWarned?: boolean;
	/** onSettingsChanged hooks (fired after the ⚙ panel saves declarative settings). */
	settingsHandlers: Set<(values: Record<string, unknown>) => void>;
}

/** Plugin-facility version the host provides — a manifest apiVersion above this refuses
 *  activation, so the plugin gets a clear "please upgrade pi-web-ui" instead of mysterious
 *  undefined on a new interface. */
export const PLUGIN_API_VERSION = 1;

/** Slash command a plugin registers via host.registerCommand. A non-empty string
 *  return from run is echoed to the initiator as a system notice; view plugins that
 *  need rich display should use broadcast/sendTo instead. Commands are pure config
 *  actions (no tokens) and are intercepted at the same level as built-ins. */
export interface PluginCommandDef {
	name: string;
	description?: string;
	argumentHint?: string;
	run(args: string, ctx: { clientId?: string }): unknown | Promise<unknown>;
}

/** Per-plugin AI-tool registry (name → definition). */
type AgentToolTable = Map<string, PluginAgentTool>;

/** Resident background task registered by a plugin (via host.registerBackgroundTask). */
export interface PluginBgTask {
	id: string;
	label: string;
	stop?: () => void;
	status?: string;
	since: number;
}

/** Message-handler timeout: log threshold only for giving up the wait (the handler itself emits the response). */
const MESSAGE_TIMEOUT_MS = 30_000;

/** Shared rejected promise when host.fs is denied by the capability gate (for type alignment). */
const NO_FS_PROMISE = Promise.reject(new Error('Plugin did not declare "fs" (manifest.permissions) — request denied'));
NO_FS_PROMISE.catch(() => {}); // swallow unhandled-rejection noise; callers still get the error on await

/** Each WS connection registers a sender; cid() returns that socket's clientId (null before attach). */
interface Sender {
	cid: () => string | null;
	send: (msg: ServerMessage) => void;
}

// ---------------------------------------------------------------------------
// Declarative settings schema (manifest "settings")
// ---------------------------------------------------------------------------

const SETTING_TYPES = new Set(["text", "password", "number", "boolean", "select"]);

/** Parse manifest.settings → a legal schema (bad fields skipped, cap 32). */
function parseSettingsSchema(raw: unknown): UiPluginSettingField[] {
	if (!Array.isArray(raw)) return [];
	const out: UiPluginSettingField[] = [];
	for (const f of raw) {
		if (!f || typeof f !== "object") continue;
		const o = f as Record<string, unknown>;
		const key = typeof o.key === "string" ? o.key.trim() : "";
		const type = typeof o.type === "string" ? o.type : "";
		if (!key || !SETTING_TYPES.has(type) || out.some((x) => x.key === key)) continue;
		const field: UiPluginSettingField = {
			key,
			type: type as UiPluginSettingField["type"],
			label: typeof o.label === "string" && o.label ? o.label : key,
			...(o.default !== undefined ? { default: o.default as string | number | boolean } : {}),
			...(typeof o.min === "number" ? { min: o.min } : {}),
			...(typeof o.max === "number" ? { max: o.max } : {}),
			...(Array.isArray(o.options)
				? { options: o.options.filter((x): x is string => typeof x === "string") }
				: {}),
			...(typeof o.hint === "string" ? { hint: o.hint } : {}),
		};
		out.push(field);
		if (out.length >= 32) break;
	}
	return out;
}

/** Read stored settings from <pluginDir>/storage.json and merge with schema defaults. */
function storedSettingsValues(dir: string, schema: UiPluginSettingField[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	let stored: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(join(dir, "storage.json"), "utf8")) as Record<string, unknown>;
		if (parsed && typeof parsed === "object" && parsed.settings && typeof parsed.settings === "object") {
			stored = parsed.settings as Record<string, unknown>;
		}
	} catch {
		/* no storage file = all defaults */
	}
	for (const f of schema) out[f.key] = stored[f.key] ?? f.default;
	return out;
}

/** Validate and write settings back (the settings key in storage.json, atomic write); returns an error string or null. */
function saveSettingsValues(
	dir: string,
	schema: UiPluginSettingField[],
	values: Record<string, unknown> | undefined,
): { error?: string; clean: Record<string, unknown> } {
	const clean: Record<string, unknown> = {};
	for (const f of schema) {
		const v = values?.[f.key];
		if (f.type === "number") {
			const n = v === undefined ? Number(f.default ?? 0) : Number(v);
			if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
				return { error: `${f.label} is out of range`, clean };
			}
			clean[f.key] = n;
		} else if (f.type === "boolean") {
			clean[f.key] = v === undefined ? Boolean(f.default) : Boolean(v);
		} else if (f.type === "select") {
			if (v !== undefined && !f.options?.includes(String(v))) return { error: `${f.label} has an invalid value`, clean };
			clean[f.key] = v === undefined ? f.default : String(v);
		} else {
			clean[f.key] = v === undefined ? (f.default ?? "") : String(v);
		}
	}
	try {
		// Keep other keys in storage.json (the plugin's own data); only touch settings.
		const file = join(dir, "storage.json");
		let existing: Record<string, unknown> = {};
		try {
			existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		} catch {
			/* first time */
		}
		const tmp = `${file}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify({ ...existing, settings: clean }));
		renameSync(tmp, file);
	} catch (err) {
		console.error(`[plugins] settings persist failed (${dir}):`, err);
	}
	return { clean };
}

export class PluginManager {
	private loaded = new Map<string, LoadedPlugin>();
	/** Directories already imported that had no entry / failed — avoid re-importing and re-logging. */
	private attempted = new Set<string>();
	private senders = new Set<Sender>();
	private messageHandlers = new Map<string, Set<(payload: unknown, from?: string) => void>>();
	/** Plugin-registered AI tools: pluginId → (name → definition). The host reads via agentTools(). */
	private agentTools = new Map<string, AgentToolTable>();
	/** Callback when the AI-tool set changes (index.ts wires AgentService to push new tools into active sessions). */
	onAgentToolsChanged: (() => void) | undefined = undefined;
	/** Plugin slash-command registry: pluginId → (name → definition). The host reads via listCommands(). */
	private pluginCommands = new Map<string, Map<string, PluginCommandDef>>();
	/** Callback when the command set changes (index.ts wires AgentService to refresh each client's catalog). */
	onCommandsChanged: (() => void) | undefined = undefined;
	/** Plugin resident tasks: pluginId → Map<taskId, PluginBgTask>. The host reads via bgTasks(). */
	private pluginBgTasks = new Map<string, Map<string, PluginBgTask>>();
	/** Callback when the task set changes (index.ts wires AgentService to re-push bg_servers). */
	onBgTasksChanged: (() => void) | undefined = undefined;
	/** Server reload epoch: +1 on every reload(); the frontend uses it as an import cache-bust query. */
	private epochCounter = 0;
	/** Current global workspace (backing store for host.cwd) — updated by notifyCwd. */
	private cwdValue: string;

	constructor(
		private readonly dataDir: string,
		cwd: string,
	) {
		this.cwdValue = resolve(cwd);
	}

	/** Live workspace root (follows set_cwd). Built-in Local Review tools use this. */
	getCwd(): string {
		return this.cwdValue;
	}

	/** Called by index.ts after a client's set_cwd succeeds: update the global workspace
	 *  and fan out to every activated plugin's onCwdChange hook (exceptions isolated, never crash the process). */
	notifyCwd(next: string): void {
		const abs = resolve(next);
		if (abs === this.cwdValue) return; // idempotent: duplicate notify / same path is a no-op
		this.cwdValue = abs;
		for (const [id, p] of this.loaded) {
			for (const h of p.cwdHandlers) {
				try {
					h(abs);
				} catch (err) {
					console.error(`[plugin:${id}] cwd-change handler failed:`, err);
				}
			}
		}
	}

	get pluginsDir(): string {
		return join(this.dataDir, "plugins");
	}

	/** Slash commands registered by every plugin (stable-sorted by plugin id). */
	listCommands(): PluginCommandDef[] {
		const out: PluginCommandDef[] = [];
		for (const id of [...this.pluginCommands.keys()].sort()) {
			out.push(...this.pluginCommands.get(id)!.values());
		}
		return out;
	}

	/** Look up a command by name (for prompt() intercept; returns null if not found). */
	findCommand(name: string): { def: PluginCommandDef; pluginId: string } | null {
		for (const [pluginId, table] of this.pluginCommands) {
			if (table.has(name)) return { def: table.get(name)!, pluginId };
		}
		return null;
	}

	/** Resident background tasks registered by every plugin (flattened into BgServer shape). */
	bgTasks(): BgServer[] {
		const out: BgServer[] = [];
		for (const [pluginId, table] of this.pluginBgTasks) {
			for (const t of table.values()) {
				out.push({
					taskId: t.id,
					plugin: pluginId,
					since: t.since,
					name: t.label,
					...(t.status ? { status: t.status } : {}),
				});
			}
		}
		return out;
	}

	/** Stop a plugin task (kill_background_server with taskId); returns whether it hit. */
	stopPluginBgTask(taskId: string): boolean {
		for (const [pluginId, table] of this.pluginBgTasks) {
			const t = table.get(taskId);
			if (!t) continue;
			try {
				t.stop?.();
			} catch (err) {
				console.error(`[plugin:${pluginId}] background task ${taskId} stop failed:`, err);
			}
			table.delete(taskId);
			if (table.size === 0) this.pluginBgTasks.delete(pluginId);
			try {
				this.onBgTasksChanged?.();
			} catch {}
			return true;
		}
		return false;
	}

	/** Save a plugin's declarative settings (⚙ panel → plugin_settings message): validate
	 *  against the schema, atomically write the settings key in storage.json, notify the
	 *  plugin via onSettingsChanged, and re-push the catalog so the frontend echoes.
	 *  Returns an error string or null (success). */
	savePluginSettings(pluginId: string, values: Record<string, unknown>): { error?: string } {
		if (!ID_RE.test(pluginId)) return { error: "Invalid plugin id" };
		const dir = join(this.pluginsDir, pluginId);
		const info = this.loaded.get(pluginId)?.info;
		const schema = info?.settingsSchema ?? [];
		if (!schema.length) return { error: "This plugin has no declarative settings (manifest has no settings)" };
		const { error, clean } = saveSettingsValues(dir, schema, values);
		if (error) return { error };
		// Notify the plugin (exceptions isolated)
		for (const h of this.loaded.get(pluginId)?.settingsHandlers ?? []) {
			try {
				h(clean);
			} catch (err) {
				console.error(`[plugin:${pluginId}] onSettingsChanged handler failed:`, err);
			}
		}
		// Re-push the plugins catalog (including new settingsValues) so the frontend echoes.
		void this.pushToAll().catch(() => {});
		return {};
	}

	/** Current reload epoch (sent with the plugins message). */
	get epoch(): number {
		return this.epochCounter;
	}

	addSender(send: (msg: ServerMessage) => void, cid: () => string | null): () => void {
		const s: Sender = { cid, send };
		this.senders.add(s);
		return () => this.senders.delete(s);
	}

	/** Client uplink: route to the matching plugin's handler; unknown/inactive plugins are dropped silently.
	 *  Plugin code is untrusted — both a sync throw and a returned Promise rejection must be
	 *  isolated here and must never crash the process. */
	handleMessage(pluginId: string, payload: unknown, from?: string): void {
		if (!ID_RE.test(pluginId)) return;
		const handlers = this.messageHandlers.get(pluginId);
		if (!handlers) return;
		for (const h of handlers) {
			try {
				const ret = h(payload, from) as unknown;
				if (ret instanceof Promise) {
					ret.catch((err) => {
						console.error(`[plugin:${pluginId}] async message handler failed:`, err);
					});
					// Timeout guard: the handler itself emits the response via sendTo/broadcast;
					// timeout only logs and stops waiting — a single message must never stall
					// the client's pending pipeline forever.
					const timer = setTimeout(() => {
						console.error(
							`[plugin:${pluginId}] message handler timed out (>${MESSAGE_TIMEOUT_MS}ms), no longer waiting`,
						);
					}, MESSAGE_TIMEOUT_MS);
					void ret.finally(() => clearTimeout(timer));
				}
			} catch (err) {
				console.error(`[plugin:${pluginId}] message handler failed:`, err);
			}
		}
	}

	/** Notify online users on first install / capability change (a marker file records the declaration from the last activation). */
	private async maybeConsentNotice(info: UiPluginInfo, dir: string, perms: string[]): Promise<void> {
		try {
			const markerFile = join(dir, ".pi-approved");
			const key = createHash("sha256").update(JSON.stringify(perms)).digest("hex").slice(0, 32);
			let prev = "";
			try {
				prev = JSON.parse(readFileSync(markerFile, "utf8"))?.key ?? "";
			} catch {
				/* no marker = first install */
			}
			if (prev === key) return; // same-version capability list, do not nag
			const list = perms.length ? perms.join(", ") : "none";
			this.notifyAll(
				perms.length ? "warning" : "info",
				`Plugin "${info.name}" activated (${prev ? "permissions changed" : "first install"}; declared: ${list}) — confirm the source is trusted`,
			);
			writeFileSync(markerFile, JSON.stringify({ v: 1, key, perms }), "utf8");
		} catch (err) {
			console.error(`[plugin:${info.id}] consent notice failed:`, err);
		}
	}

	/** index.ts's /plugins-api/:id/* mount forwards here: find the matching plugin's
	 *  registered route and run it; unknown plugin/path → 404, throwing handler → 500 (does not crash the process). */
	handleHttp(pluginId: string, method: string, pathIn: string, req: Request, res: Response): void {
		if (!ID_RE.test(pluginId)) {
			res.status(404).end("plugin not found");
			return;
		}
		const table = this.loaded.get(pluginId)?.httpRoutes;
		const path = "/" + pathIn.replace(/^\/+/, "");
		const handler = table?.get(`${method.toUpperCase()} ${path}`);
		if (!handler) {
			res.status(404).end("not found");
			return;
		}
		try {
			handler(req, res);
		} catch (err) {
			console.error(`[plugin:${pluginId}] http ${method} ${path} failed:`, err);
			if (!res.headersSent) res.status(500).end("internal error");
			else res.end();
		}
	}

	broadcast(pluginId: string, payload: unknown): void {
		this.deliverAll({ type: "plugin_data", pluginId, payload });
	}

	/** System notice: send to every socket (reuses the notice message; the frontend shows a toast). */
	notifyAll(level: "info" | "warning" | "error", text: string): void {
		this.deliverAll({ type: "notice", level, text });
	}

	/** Send a directed plugin message to one client; silently ignored if that socket is not found. */
	sendTo(clientId: string, pluginId: string, payload: unknown): void {
		for (const s of this.senders) {
			if (s.cid() !== clientId) continue;
			try {
				s.send({ type: "plugin_data", pluginId, payload });
			} catch {
				/* dead socket */
			}
		}
	}

	/** Push the catalog + current epoch to every socket. */
	async pushToAll(): Promise<void> {
		const list = await this.scan();
		this.deliverAll({ type: "plugins", plugins: list, epoch: this.epochCounter });
	}

	/** Server hot-reload: deactivate all → clear cache → re-scan and re-activate → epoch+1.
	 *  Returns the new catalog (including activation results). Re-activated plugin
		 *  instances are new modules with initial in-memory state — fire onAttach per
		 *  client so they re-push their own state. */
	async reload(): Promise<UiPluginInfo[]> {
		this.dispose();
		this.attempted.clear();
		this.epochCounter += 1;
		const list = await this.ensureLoaded();
		for (const s of this.senders) {
			const cid = s.cid();
			if (cid) this.notifyAttach(cid);
		}
		return list;
	}

	/** Called after each client attach: let every plugin push its full state to that client.
	 *  Exceptions isolated — one plugin hook failing does not affect other plugins or other hooks. */
	notifyAttach(clientId: string): void {
		for (const [id, p] of this.loaded) {
			for (const h of p.attachHandlers) {
				try {
					h(clientId);
				} catch (err) {
					console.error(`[plugin:${id}] onAttach handler failed:`, err);
				}
			}
		}
	}

	/** Called by agent-service: fan SDK tool-execution events out to every plugin (exceptions isolated). */
	emitToolEvent(ev: PluginToolEvent): void {
		for (const p of this.loaded.values()) {
			for (const h of p.toolHandlers) {
				try {
					h(ev);
				} catch (err) {
					console.error(`[plugin:${p.info.id}] tool-event handler failed:`, err);
				}
			}
		}
	}

	/** AI tools currently registered by every plugin (flattened, stable-sorted by plugin id). */
	getAgentTools(): PluginAgentTool[] {
		const out: PluginAgentTool[] = [];
		for (const table of [...this.agentTools.values()].sort())
			out.push(...table.values());
		return out;
	}
	/** Register a tool the AI can call; a duplicate name is rejected and a no-op unsubscribe is returned. */
	private registerAgentTool(pluginId: string, tool: PluginAgentTool): () => void {
		if (!tool || typeof tool.execute !== "function" || !tool.name || !tool.description) {
			console.error(`[plugin:${pluginId}] registerAgentTool: missing name/description/execute, ignored`);
			return () => {};
		}
		let table = this.agentTools.get(pluginId);
		if (!table) this.agentTools.set(pluginId, (table = new Map()));
		if (table.has(tool.name)) {
			console.error(`[plugin:${pluginId}] AI tool "${tool.name}" already registered, ignored`);
			return () => {};
		}
		table.set(tool.name, tool);
		console.log(`[plugin:${pluginId}] registered AI tool: ${tool.name}`);
		try {
			this.onAgentToolsChanged?.();
		} catch (err) {
			console.error("[plugins] onAgentToolsChanged failed:", err);
		}
		return () => {
			if (table.delete(tool.name)) {
				if (table.size === 0) this.agentTools.delete(pluginId);
				try {
					this.onAgentToolsChanged?.();
				} catch {
					/* shutting down */
				}
			}
		};
	}

	/** Register a slash command: duplicate names across plugins are rejected (first registrant wins); onCommandsChanged notifies a catalog refresh. */
	private registerCommand(pluginId: string, cmd: PluginCommandDef): () => void {
		const name = String(cmd?.name ?? "").replace(/^\/+/, ""); // tolerate a mistaken leading /
		if (!/^[a-zA-Z][a-zA-Z0-9:_-]*$/.test(name)) {
			console.error(
				`[plugin:${pluginId}] registerCommand: illegal name "${cmd?.name}" (must start with a letter; letters/digits/:_- allowed), ignored`,
			);
			return () => {};
		}
		if (typeof cmd?.run !== "function") {
			console.error(`[plugin:${pluginId}] registerCommand: ${name} is missing run, ignored`);
			return () => {};
		}
		for (const [pid, table] of this.pluginCommands) {
			if (table.has(name) && pid !== pluginId) {
				console.error(`[plugin:${pluginId}] command /${name} is already registered by plugin ${pid}, ignoring duplicate`);
				return () => {};
			}
		}
		let table = this.pluginCommands.get(pluginId);
		if (!table) this.pluginCommands.set(pluginId, (table = new Map()));
		if (table.has(name)) {
			console.error(`[plugin:${pluginId}] command /${name} already registered, ignored`);
			return () => {};
		}
		const def: PluginCommandDef = { ...cmd, name };
		table.set(name, def);
		console.log(`[plugin:${pluginId}] registered command: /${name}`);
		try {
			this.onCommandsChanged?.();
		} catch (err) {
			console.error("[plugins] onCommandsChanged failed:", err);
		}
		return () => {
			if (table!.delete(name)) {
				if (table!.size === 0) this.pluginCommands.delete(pluginId);
				try {
					this.onCommandsChanged?.();
				} catch {
					/* shutting down */
				}
			}
		};
	}

	private deliverAll(msg: ServerMessage): void {
		for (const s of this.senders) {
			try {
				s.send(msg);
			} catch {
				/* dead socket — index.ts cleans it up */
			}
		}
	}

	/** Current catalog (re-scan manifests, do not re-import). */
	async list(): Promise<UiPluginInfo[]> {
		return this.scan();
	}

	/**
	 * Called on attach: re-scan the directory + activate new plugins not yet loaded.
	 * Returns the catalog for the browser (including entries that failed to activate, shown as unavailable).
	 */
	async ensureLoaded(): Promise<UiPluginInfo[]> {
		const found = await this.scan();
		for (const info of found) {
			if (this.loaded.has(info.id) || this.attempted.has(info.id)) continue;
			if (!existsSync(join(this.pluginsDir, info.id, "index.mjs"))) continue; // frontend-only plugin
			await this.activate(info);
		}
		// Plugins that have been deleted: call deactivate and drop from the cache
		for (const [id, p] of [...this.loaded]) {
			if (!found.some((f) => f.id === id)) {
				this.deactivateEntry(id, p);
			}
		}
		return found.map((f) => this.loaded.get(f.id)?.info ?? f);
	}

	/** Deactivate a single plugin: deactivate + unregister AI tools + clear cache. */
	private deactivateEntry(id: string, p: LoadedPlugin): void {
		try {
			p.deactivate?.();
		} catch (err) {
			console.error(`[plugin:${id}] deactivate failed:`, err);
		}
		for (const off of [...(p.agentToolUnsubscribers ?? [])]) {
			try {
				off();
			} catch {
				/* already gone */
			}
		}
		this.loaded.delete(id);
		this.messageHandlers.delete(id);
		console.log(`[plugin:${id}] removed`);
	}

	/** Deactivate every plugin on shutdown. */
	dispose(): void {
		for (const [id, p] of this.loaded) {
			try {
				p.deactivate?.();
			} catch (err) {
				console.error(`[plugin:${id}] deactivate failed:`, err);
			}
			for (const off of [...(p.agentToolUnsubscribers ?? []), ...(p.commandUnsubscribers ?? [])]) {
				try {
					off();
				} catch {
					/* shutting down */
				}
			}
			// On deactivate, stop resident background tasks it registered (pollers, etc.) so no orphan timers remain.
			for (const t of this.pluginBgTasks.get(id)?.values() ?? []) {
				try {
					t.stop?.();
				} catch {}
			}
		}
		this.pluginBgTasks.clear();
		this.loaded.clear();
		this.messageHandlers.clear();
	}

	/** Read the manifest catalog; skip bad directories (no manifest / illegal id). */
	private async scan(): Promise<UiPluginInfo[]> {
		let names: string[];
		try {
			names = await readdir(this.pluginsDir);
		} catch {
			return []; // directory missing = no plugins installed
		}
		const out: UiPluginInfo[] = [];
		for (const name of names.sort()) {
			if (!ID_RE.test(name)) continue;
			const dir = join(this.pluginsDir, name);
			try {
				if (!(await stat(dir)).isDirectory()) continue;
				const raw = await readFile(join(dir, "manifest.json"), "utf8");
				const m = JSON.parse(raw) as {
					id?: string;
					name?: string;
					version?: string;
					description?: string;
					icon?: string;
					apiVersion?: number;
					permissions?: unknown;
					settings?: unknown;
				};
				out.push({
					id: name,
					name: typeof m.name === "string" && m.name ? m.name : name,
					version: typeof m.version === "string" ? m.version : undefined,
					description:
						typeof m.description === "string" ? m.description : undefined,
					icon: typeof m.icon === "string" && m.icon.trim() ? m.icon.trim() : undefined,
					hasClient: existsSync(join(dir, "client", "entry.mjs")),
					error: this.loaded.get(name)?.info.error,
					// Capability list declared in the manifest (fs/net/tools…) — shown in the settings panel
					permissions: Array.isArray(m.permissions)
						? m.permissions.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, 16)
						: undefined,
					// Declarative settings schema + current stored values (for the ⚙ panel to auto-render the form)
					settingsSchema: parseSettingsSchema(m.settings),
					settingsValues: storedSettingsValues(dir, parseSettingsSchema(m.settings)),
				// Install source (.pi-source.json written by pi-web-ui install) —
				// the settings panel shows an Update button from this; hand-copied plugins have no such file.
				source: await readFile(join(dir, ".pi-source.json"), "utf8")
					.then((raw) => {
						try {
							const s = JSON.parse(raw) as { source?: unknown };
							return typeof s.source === "string" && s.source ? s.source : undefined;
						} catch {
							return undefined;
						}
					})
					.catch(() => undefined),
				});
			} catch {
				continue; // no manifest / bad JSON — not a plugin
			}
		}
		return out;
	}

	private async activate(info: UiPluginInfo): Promise<void> {
		this.attempted.add(info.id);
		const dir = join(this.pluginsDir, info.id);
		const handlers = new Set<(payload: unknown) => void>();
		this.messageHandlers.set(info.id, handlers);
		const toolHandlers = new Set<(ev: PluginToolEvent) => void>();
		const attachHandlers = new Set<(clientId: string) => void>();
		const cwdHandlers = new Set<(cwd: string) => void>();
		const httpRoutes = new Map<string, (req: Request, res: Response) => void>();
		const unregisterTools: Array<() => void> = [];
		const unregisterCommands: Array<() => void> = [];
		const bgTaskTable = new Map<string, PluginBgTask>();
		const settingsHandlers = new Set<(values: Record<string, unknown>) => void>();
		// Host API version negotiation: if the plugin wants newer than the host → refuse
		// clearly (instead of mysteriously breaking on undefined at runtime). Same handling
		// as activation failure: error field + greyed out.
		let apiVersion = 1;
		try {
			apiVersion = Number(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).apiVersion ?? 1) || 1;
		} catch {}
		if (apiVersion > PLUGIN_API_VERSION) {
			const msg = `Plugin requires host API v${apiVersion}, this host is v${PLUGIN_API_VERSION} — upgrade pi-web-ui`;
			console.error(`[plugin:${info.id}] ${msg}`);
			this.loaded.set(info.id, { info: { ...info, error: msg }, toolHandlers, attachHandlers, cwdHandlers, httpRoutes, settingsHandlers: new Set() });
			return;
		}
		// Capability declaration: permissions present → strict mode (gated host APIs enforced
		// by declared family); absent and apiVersion < 2 → legacy full-access (warn once on
		// first use of a gated API; from v2 the default is deny).
		const permsDeclared = (info.permissions ?? []).slice();
		const strict = permsDeclared.length > 0 || apiVersion >= 2;
		const permFamilies = new Set(permsDeclared.map((x) => x.split(":")[0]!));
		const p: LoadedPlugin = { info, toolHandlers, attachHandlers, cwdHandlers, commandUnsubscribers: unregisterCommands, httpRoutes, settingsHandlers };
		p.permsDeclared = permsDeclared;
		p.permFamilies = permFamilies;
		p.legacyWarned = false;
		// Per-plugin private facilities: KV storage + encrypted secrets + auto dep install (single-flight).
		const storage = new PluginStorage(join(dir, "storage.json"));
		const secrets = new PluginSecrets(this.dataDir, dir);
		// Sandboxed workspace file access (gated by the "fs" capability; root follows the live set_cwd value).
		const workspaceFs = new WorkspaceFS(() => self.cwdValue);
		/** Capability gate: in strict mode check the declared family; legacy mode allows
		 *  but warns once per activation. Return false = already logged, caller should deny. */
		const can = (family: string): boolean => {
			if (permFamilies.has(family)) return true;
			if (!strict) {
				if (!p.legacyWarned) {
					p.legacyWarned = true;
					console.warn(
						`[plugin:${info.id}] manifest did not declare permissions (legacy full-access mode) — allowing "${family}"; from apiVersion 2 this will be denied by default, please declare`,
					);
				}
				return true;
			}
			console.error(`[plugin:${info.id}] missing permission "${family}" (manifest.permissions) — request denied`);
			return false;
		};
		const self = this; // an object-literal getter cannot use the plugin host's this
		const host: PluginHost = {
			broadcast: (payload) => this.broadcast(info.id, payload),
			notify: (level, text) => this.notifyAll(level, text),
			sendTo: (clientId, payload) => this.sendTo(clientId, info.id, payload),
			onMessage: (h) => {
				handlers.add(h);
				return () => handlers.delete(h);
			},
			onToolEvent: (h) => {
				toolHandlers.add(h);
				return () => toolHandlers.delete(h);
			},
			onAttach: (h) => {
				attachHandlers.add(h);
				return () => attachHandlers.delete(h);
			},
			onCwdChange: (h) => {
				cwdHandlers.add(h);
				return () => cwdHandlers.delete(h);
			},
			registerCommand: (cmd) => {
				const off = this.registerCommand(info.id, cmd);
				unregisterCommands.push(off);
				return () => {
					const i = unregisterCommands.indexOf(off);
					if (i >= 0) unregisterCommands.splice(i, 1);
					off();
				};
			},
			storage,
			secrets,
			ensureDeps: (specs, opts) => ensurePluginDeps(dir, specs ?? [], opts?.onProgress),
			route: (method, path, handler) => {
				if (!can("http")) return () => {};
				const m = String(method ?? "GET").toUpperCase();
				if (!["GET", "POST", "PUT", "DELETE"].includes(m) || typeof path !== "string" || !path.startsWith("/") || typeof handler !== "function") {
					console.error(`[plugin:${info.id}] route: illegal args (method=${method} path=${path}), ignored`);
					return () => {};
				}
				httpRoutes.set(`${m} ${path}`, handler);
				return () => httpRoutes.delete(`${m} ${path}`);
			},
			// Wrap: on plugin deactivate, automatically unregister every AI tool it registered so nothing hangs.
			registerAgentTool: (tool) => {
				if (!can("tools")) return () => {};
				const off = this.registerAgentTool(info.id, tool);
				unregisterTools.push(off);
				return () => {
					const i = unregisterTools.indexOf(off);
					if (i >= 0) unregisterTools.splice(i, 1);
					off();
				};
			},
			dir,
			dataDir: this.dataDir,
			get cwd() {
				return self.cwdValue;
			},
			fs: {
				list: (relDir) => (can("fs") ? workspaceFs.list(relDir) : NO_FS_PROMISE),
				read: (p) => (can("fs") ? workspaceFs.read(p) : NO_FS_PROMISE),
				readText: (p, max) => (can("fs") ? workspaceFs.readText(p, max) : NO_FS_PROMISE),
				write: (p, data) => (can("fs") ? workspaceFs.write(p, data) : NO_FS_PROMISE),
				remove: (p) => (can("fs") ? workspaceFs.remove(p) : NO_FS_PROMISE),
			},
			registerBackgroundTask: (task) => {
				const id = String(task?.id ?? "").trim();
				if (!id || bgTaskTable.has(id)) {
					console.error(`[plugin:${info.id}] registerBackgroundTask: illegal/duplicate id "${task?.id}", ignored`);
					return { update: () => {}, unregister: () => {} };
				}
				const entry: PluginBgTask = {
					id,
					label: String(task?.label ?? id),
					since: Date.now(),
					...(typeof task?.stop === "function" ? { stop: task.stop } : {}),
					...(typeof task?.status === "string" ? { status: task.status } : {}),
				};
				bgTaskTable.set(id, entry);
				this.pluginBgTasks.set(info.id, bgTaskTable);
				const fire = () => {
					try {
						this.onBgTasksChanged?.();
					} catch {}
				};
				fire();
				return {
					update: (next) => {
						if (!bgTaskTable.has(id)) return;
						if (next.label !== undefined) entry.label = String(next.label);
						if (next.status !== undefined) entry.status = next.status;
						if (typeof next.stop === "function") entry.stop = next.stop;
						fire();
					},
					unregister: () => {
						if (bgTaskTable.delete(id)) {
							if (bgTaskTable.size === 0) this.pluginBgTasks.delete(info.id);
							fire();
						}
					},
				};
			},
			getSettings: () => storedSettingsValues(dir, info.settingsSchema ?? []),
			onSettingsChanged: (h) => {
				settingsHandlers.add(h);
				return () => settingsHandlers.delete(h);
			},
			log: (...args) => console.log(`[plugin:${info.id}]`, ...args),
		};
		try {
			// Node's import() of the same URL always returns the cached module — append epoch
			// as a query string to bust the cache so a re-activate after plugins_reload picks up new code on disk.
			const mod = (await import(
				pathToFileURL(join(dir, "index.mjs")).href + `?e=${this.epochCounter}`
			)) as {
				default?: {
					activate?: (host: PluginHost) => void | (() => void) | Promise<void | (() => void)>;
				};
			};
			const ret = await mod.default?.activate?.(host);
			this.loaded.set(info.id, {
				info: { ...info },
				deactivate: typeof ret === "function" ? ret : undefined,
				toolHandlers,
				attachHandlers,
				cwdHandlers,
				agentToolUnsubscribers: unregisterTools,
				commandUnsubscribers: unregisterCommands,
				httpRoutes,
				settingsHandlers,
			});
			console.log(`[plugin:${info.id}] activated (v${info.version ?? "?"})`);
			// First-install / capability-change notice (best-effort): <dir>/.pi-approved records
			// the capability list from the last activation — after a new install or permissions
			// change, push a warning to online clients. Visible at install time; daily startup does not nag.
			void this.maybeConsentNotice(info, dir, permsDeclared);
		} catch (err) {
			httpRoutes.clear();
			this.loaded.set(info.id, {
				info: { ...info, error: (err as Error).message },
				toolHandlers,
				attachHandlers,
				cwdHandlers,
				httpRoutes,
				settingsHandlers: new Set(),
			});
			console.error(`[plugin:${info.id}] activate failed:`, err);
		}
	}
}

/**
 * Safely map /plugins/:id/client/<rest> onto <pluginsDir>/<id>/client/<rest>.
 * Returns an absolute path; any traversal / illegal id returns null (caller answers 404).
 */
export function resolvePluginClientFile(
	pluginsDir: string,
	id: string,
	rest: string,
): string | null {
	if (!ID_RE.test(id)) return null;
	const root = resolve(join(pluginsDir, id, "client"));
	// rest is guaranteed by the express route not to contain "..", but belt-and-suspenders: after resolve it must still be inside root
	const abs = resolve(root, rest);
	if (abs !== root && !abs.startsWith(root + sep)) return null;
	return abs;
}

/**
 * Sync plugin AI-tool definitions into a "session-shaped object" (a structural
 * subset of the SDK AgentSession: the internal _customTools array +
 * _refreshToolRegistry() — refresh re-reads the array and new tool names join
 * the active set automatically). Three-way diff of add/update/remove; an
 * incompatible object (SDK renamed) returns null and the caller silently
 * degrades. Returns the new injected-name list.
 *
 * Pure function, does not import the SDK — vitest tests it directly (tests/unit/plugin-tools.test.ts).
 */
export function syncPluginToolsIntoSession(
	session: {
		_customTools?: Array<{ name: string } & Record<string, unknown>>;
		_refreshToolRegistry?: () => void;
	},
	defs: Array<{ name: string } & Record<string, unknown>>,
	prevNames: ReadonlySet<string>,
): ReadonlySet<string> | null {
	if (!Array.isArray(session._customTools) || typeof session._refreshToolRegistry !== "function")
		return null;
	const byName = new Map(session._customTools.map((d) => [d.name, d]));
	let changed = false;
	for (const d of defs) {
		if (byName.get(d.name) !== d) {
			byName.set(d.name, d);
			changed = true;
		}
	}
	for (const name of prevNames) {
		if (!defs.some((d) => d.name === name) && byName.has(name)) {
			byName.delete(name);
			changed = true;
		}
	}
	if (!changed) return new Set(defs.map((d) => d.name));
	session._customTools = [...byName.values()];
	session._refreshToolRegistry();
	return new Set(defs.map((d) => d.name));
}
