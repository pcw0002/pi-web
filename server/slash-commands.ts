/**
 * slash-commands — slash-command catalog and native-command execution,
 * extracted from agent-service.ts.
 *
 * Owns:
 *  - NATIVE_COMMANDS: slash commands implemented by the web server (pi CLI
 *    interactive built-ins like /model /new must not go through SDK prompt()
 *    — unintercepted they would be sent to the model as plain text)
 *  - push(): catalog = built-ins + the active conversation's extension
 *    commands / prompt templates / skills (same expansion as the SDK),
 *    pushed as slash_commands for the input-box picker
 *  - exec(): intercept and run built-ins; return false for non-native
 *    commands so prompt falls through to the SDK
 *
 * Decoupled from ClientSession via SlashHost (same pattern as settings-service/goal-service).
 * Server notices are English. /help and /copy are client-only (never reach the
 * server); they stay in the catalog for the picker, and exec swallows them so
 * the SDK does not treat them as text.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ServerMessage, SlashCommandInfo } from "./protocol.js";
import type { PluginCommandDef } from "./plugins.js";

/** Host capabilities ClientSession provides to this service (narrow interface, easy to unit-test). */
export interface SlashHost {
	emit: (msg: ServerMessage) => void;
	/** Current working directory (echoed by /cwd with no argument). */
	cwd: () => string;
	/** Session of the active conversation. */
	getSession: () => AgentSession;
	newChat: () => Promise<void>;
	setModel: (modelId: string) => Promise<void>;
	setCwd: (path: string) => Promise<void>;
	setThinking: (level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
	refreshSessions: () => Promise<void>;
	/** Supervisor graceful-restart scheduler; exec falls back to process.exit(0) when this returns false. */
	onQuit?: () => boolean;
	/** Hook after session.reload() (replay settings gates such as the terminal-tools toggle). */
	afterReload?: () => void;
	setSessionName?: (name: string) => void;
	emitSessionTree?: () => void;
	exportSession?: () => Promise<void>;
	/** Plugin-registered slash commands (registerCommand) — catalog display + exec intercept. */
	pluginCommands?: () => PluginCommandDef[];
	/** Run a plugin command: find and call run, return true; return false if there is no such command.
	 *  Lives on the host, not this service, because clientId / notice echo need the ClientSession environment. */
	execPluginCommand?: (name: string, args: string) => Promise<boolean> | boolean;
}

/** Slash commands implemented natively by the web server (the pi CLI's built-in
 * interactive commands like /model and /new are NOT handled by the SDK's
 * prompt() — without this they'd be sent to the model as plain text). Keep in
 * sync with exec(). */
export const NATIVE_COMMANDS: {
	name: string;
	description: string;
	argumentHint?: string;
}[] = [
	{ name: "new", description: "New chat" },
	{ name: "model", description: "Switch model", argumentHint: "[name]" },
	{ name: "compact", description: "Compact context", argumentHint: "[instructions]" },
	{ name: "cwd", description: "Switch workspace", argumentHint: "<path>" },
	{
		name: "thinking",
		description: "Set thinking level",
		argumentHint: "<off|minimal|low|medium|high|xhigh|max>",
	},
	{ name: "resume", description: "Refresh session list" },
	{ name: "name", description: "Name this session", argumentHint: "<name>" },
	{ name: "tree", description: "Session tree: jump to an earlier question" },
	{ name: "export", description: "Export this session as HTML" },
	{ name: "reload", description: "Reload extensions, skills & templates" },
	{ name: "help", description: "Show all commands" },
	{ name: "copy", description: "Copy last assistant reply" },
	{ name: "pi-web-ui:quit", description: "Quit server (supervisor will restart)" },
];

/** Parse a prompt into "/command args" — returns null when it isn't one. */
export function parseSlash(text: string): { name: string; args: string } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const m = trimmed.match(/^\/([^\s]+)\s*([\s\S]*)$/);
	if (!m || !m[1]) return null;
	return { name: m[1], args: m[2].trim() };
}

export class SlashCommandsService {
	constructor(private readonly host: SlashHost) {}

	/**
	 * Catalog of slash commands for the chat input: web-native builtins first,
	 * then the SDK's invokable commands for the ACTIVE conversation (extension
	 * commands, prompt templates, skills) — the same set the SDK expands when a
	 * prompt text starts with "/" (see AgentSession.prompt).
	 */
	async push(): Promise<void> {
		const commands: SlashCommandInfo[] = [];
		const seen = new Set<string>();
		for (const c of NATIVE_COMMANDS) {
			commands.push({ ...c, source: "builtin" });
			seen.add(c.name);
		}
		try {
			const s = this.host.getSession();
			// Extension commands — the SDK already suffixes collisions with builtin
			// names ("new:2"), and those still reach the SDK since exec() only
			// intercepts the exact native names.
			for (const cmd of s.extensionRunner.getRegisteredCommands()) {
				if (seen.has(cmd.invocationName)) continue;
				commands.push({
					name: cmd.invocationName,
					description: cmd.description,
					source: "extension",
				});
				seen.add(cmd.invocationName);
			}
			// Prompt templates: /templatename args
			for (const t of s.promptTemplates) {
				if (seen.has(t.name)) continue;
				commands.push({
					name: t.name,
					description: t.description,
					source: "prompt",
				});
				seen.add(t.name);
			}
			// Skills: /skill:name args
			for (const skill of s.resourceLoader.getSkills().skills) {
				const name = `skill:${skill.name}`;
				if (seen.has(name)) continue;
				commands.push({
					name,
					description: skill.description,
					source: "skill",
				});
				seen.add(name);
			}
		} catch {
			// Session not ready yet — native-only catalog still serves the picker.
		}
		// UI-plugin-registered commands (host.registerCommand) — global, do not require a ready session.
		for (const cmd of this.host.pluginCommands?.() ?? []) {
			if (seen.has(cmd.name)) continue; // first-come on name clash with built-in/extension (built-in wins)
			commands.push({
				name: cmd.name,
				description: cmd.description,
				argumentHint: cmd.argumentHint,
				source: "plugin",
			});
			seen.add(cmd.name);
		}
		this.host.emit({ type: "slash_commands", commands });
	}

	/** Run a native slash command (see NATIVE_COMMANDS). Returns false when the
	 *  name is not a native command (the prompt falls through to the SDK). */
	async exec(name: string, args: string): Promise<boolean> {
		switch (name) {
			case "new":
				await this.host.newChat();
				return true;
			case "model": {
				if (!args) {
					const current = this.host.getSession().model;
					this.host.emit({
						type: "notice",
						level: "info",
						text: current
							? `Current model: ${current.name} (${current.provider}/${current.id}). Usage: /model <name>`
							: `Usage: /model <name>`,
					});
					return true;
				}
				const query = args.toLowerCase();
				const available = await this.host.getSession().modelRuntime.getAvailable();
				// Prefer an exact "provider/id" match, else id/name substring.
				const exact = available.find(
					(m) => m.provider + "/" + m.id === args.trim(),
				);
				const matches = exact
					? [exact]
					: available.filter(
							(m) =>
								m.id.toLowerCase().includes(query) ||
								m.name.toLowerCase().includes(query) ||
								m.provider.toLowerCase().includes(query),
						);
				if (matches.length === 0) {
					this.host.emit({
						type: "notice",
						level: "error",
						text: `No matching model: ${args} (see the model list in the top bar)`,
					});
					return true;
				}
				const pick = matches[0];
				if (matches.length > 1) {
					this.host.emit({
						type: "notice",
						level: "warning",
						text: `Found ${matches.length} matching models, using ${pick.name} (use provider/id for an exact match)`,
					});
				}
				await this.host.setModel(`${pick.provider}/${pick.id}`);
				return true;
			}
			case "compact":
				try {
					await this.host.getSession().compact(args || undefined);
				} catch (err) {
					this.host.emit({
						type: "notice",
						level: "error",
						text: `Failed to compact context: ${(err as Error).message}`,
					});
				}
				return true;
			case "cwd":
				if (!args) {
					this.host.emit({
						type: "notice",
						level: "info",
						text: `Current workspace: ${this.host.cwd()}. Usage: /cwd <path>`,
					});
				} else {
					await this.host.setCwd(args);
				}
				return true;
			case "thinking": {
				const level = args.trim().toLowerCase();
				const allowed = new Set([
					"off",
					"minimal",
					"low",
					"medium",
					"high",
					"xhigh",
					"max",
				]);
				if (!allowed.has(level)) {
					this.host.emit({
						type: "notice",
						level: "error",
						text: `Invalid thinking level: ${args || "(empty)"}. Use: off / minimal / low / medium / high / xhigh / max`,
					});
					return true;
				}
				this.host.setThinking(level as Parameters<SlashHost["setThinking"]>[0]);
				return true;
			}
			case "resume":
				await this.host.refreshSessions();
				this.host.emit({
					type: "notice",
					level: "info",
					text: "Session list refreshed — pick one from History on the left",
				});
				return true;
			case "name": {
				const n = args.trim();
				if (!n) {
					const current = this.host.getSession().sessionManager.getSessionName();
					this.host.emit({
						type: "notice",
						level: "info",
						text: current ? `Current session name: ${current}. Usage: /name <name>` : "Usage: /name <name>",
					});
					return true;
				}
				this.host.setSessionName?.(n);
				return true;
			}
			case "tree":
				this.host.emitSessionTree?.();
				return true;
			case "export":
				await this.host.exportSession?.();
				return true;
			case "reload":
				try {
					// Re-discovers extensions / skills / prompt templates from disk and
					// re-pushes the picker catalog (the CLI's /reload semantics).
					await this.host.getSession().reload();
					// reload() puts custom tools back into the active set — replay settings gates (terminal toggle, etc.).
					this.host.afterReload?.();
					await this.push();
					this.host.emit({
						type: "notice",
						level: "info",
						text: "Reloaded extensions, skills, and prompt templates",
					});
				} catch (err) {
					this.host.emit({
						type: "notice",
						level: "error",
						text: `Reload failed: ${(err as Error).message}`,
					});
				}
				return true;
			case "pi-web-ui:quit": {
				this.host.emit({
					type: "notice",
					level: "info",
					text: "Exiting pi-web-ui… the supervisor will restart the server",
				});
				setTimeout(() => {
					const didSchedule = this.host.onQuit?.() ?? false;
					if (!didSchedule) {
						setTimeout(() => process.exit(0), 100);
					}
				}, 300);
				return true;
			}
			case "help":
			case "copy":
				// Client-side UI actions — the client handles them before sending;
				// swallow here so the SDK never sees them as plain prompt text.
				return true;
			default:
				// Plugin command: intercept and run (pure config action, same level as built-ins, never reaches the SDK).
				return (await this.host.execPluginCommand?.(name, args)) ?? false;
		}
	}
}
