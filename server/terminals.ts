/**
 * TerminalManager — conversation-owned PTY sessions (node-pty) bridged over
 * the WebSocket protocol, plus the user command list persisted in
 * `<workspaceRoot>/.pi/commands.json`.
 *
 * Each conversation gets its own manager; terminals are shared across browser
 * tabs through the session emit. A socket drop does not kill them: the
 * conversation owns their lifecycle and releases them on disposal.
 *
 * Commands file format:
 *   { "commands": [ { "name": "dev", "command": "npm run dev", "cwd": "${pwd}" } ] }
 * `${pwd}` inside cwd/command resolves to the agent session's current working
 * directory (the same directory the agent operates in — see set_cwd).
 */
import { chmodSync, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
// MUST run before node-pty is required: rewrites the installed node-pty copies
// so their worker/agent handlers tolerate Node `--watch`'s IPC traffic (see the
// module itself for details).
import "./patch-node-pty.js";
import { spawn, type IPty } from "node-pty";
import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CommandDef, ServerMessage, TerminalInfo } from "./protocol.js";

// ---------------------------------------------------------------------------
// .pi/commands.json
// ---------------------------------------------------------------------------

export interface CommandsFile {
	commands: CommandDef[];
}

/** Location of the command list for a project: <workspaceRoot>/.pi/commands.json */
export function commandsFilePath(workspaceRoot: string): string {
	return join(workspaceRoot, ".pi", "commands.json");
}

/** Expand ${pwd} (and ~) in a cwd/command string against the session's cwd. */
export function expandPwd(input: string, pwd: string): string {
	let out = input.replace(/\$\{pwd\}/g, pwd);
	if (out === "~") return homedir();
	if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
	return out;
}

/** Resolve a command's directory: default to the session cwd, expand ${pwd}/~, resolve relative paths. */
export function resolveCommandCwd(
	cwd: string | undefined,
	pwd: string,
): string {
	if (!cwd || cwd.trim() === "") return pwd;
	const expanded = expandPwd(cwd.trim(), pwd);
	return isAbsolute(expanded) ? expanded : resolve(pwd, expanded);
}

/** Read the command list; missing file → empty list; malformed → empty list + warning text. */
export async function loadCommands(
	workspaceRoot: string,
): Promise<{ commands: CommandDef[]; path: string; warning?: string }> {
	const path = commandsFilePath(workspaceRoot);
	const { commands, warning } = await readCommandsFile(path);
	return { commands, path, warning };
}

async function readCommandsFile(
	path: string,
): Promise<{ commands: CommandDef[]; warning?: string }> {
	if (!existsSync(path)) return { commands: [] };
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		return {
			commands: [],
			warning: `Failed to read commands file: ${(err as Error).message}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { commands: [], warning: `Commands file is not valid JSON: ${path}` };
	}
	if (Array.isArray(parsed)) {
		// Tolerate a bare array: [{name, command, cwd}]
		return {
			commands: parsed
				.filter(
					(c): c is CommandDef =>
						typeof c === "object" &&
						c !== null &&
						typeof (c as CommandDef).name === "string" &&
						typeof (c as CommandDef).command === "string",
				)
				.map((c) => ({ name: c.name, command: c.command, cwd: c.cwd })),
		};
	}
	const obj = parsed as { commands?: unknown };
	if (obj && Array.isArray(obj.commands)) {
		return {
			commands: obj.commands
				.filter(
					(c): c is CommandDef =>
						typeof c === "object" &&
						c !== null &&
						typeof (c as CommandDef).name === "string" &&
						typeof (c as CommandDef).command === "string",
				)
				.map((c) => ({ name: c.name, command: c.command, cwd: c.cwd })),
		};
	}
	return { commands: [], warning: `Commands file has the wrong shape: ${path}` };
}

/** Persist the command list, creating .pi/ if needed. */
export async function saveCommandsFile(
	workspaceRoot: string,
	commands: CommandDef[],
): Promise<{ path: string; error?: string }> {
	const path = commandsFilePath(workspaceRoot);
	try {
		await mkdir(join(workspaceRoot, ".pi"), { recursive: true });
		const payload: CommandsFile = { commands };
		await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
		return { path };
	} catch (err) {
		return { path, error: `Failed to save commands file: ${(err as Error).message}` };
	}
}

// ---------------------------------------------------------------------------
// TerminalManager
// ---------------------------------------------------------------------------

interface TermEntry {
	id: string;
	pty: IPty;
	title: string;
	cwd: string;
	cols: number;
	rows: number;
	exited: boolean;
	exitCode: number | null;
	command?: CommandDef;
	/** Append-only output window. The cursor is an absolute character offset. */
	output: string;
	outputOffset: number;
	waiters: Set<() => void>;
	/** Coalesced outbound output (see OUTPUT_FLUSH_MS) not yet sent to the browser. */
	pendingOut: string;
	/** Timer for the coalescing window; null = nothing pending. */
	flushTimer: ReturnType<typeof setTimeout> | null;
	// ---- Terminal liveness (watchdog; only the agent-tool path participates) ----
	/** true = this terminal has been touched by the agent's terminal_create/input/key
	 *  (user-opened terminals never participate in silence nudges). Also the "current
	 *  epoch is still armed" flag: cleared after the watchdog fires once; the next
	 *  agent touch restarts the timer. */
	agentTouched: boolean;
	/** Timestamp of the last PTY output / input write — silence duration is measured from this. */
	lastActivityAt: number;
	/** Silence-watchdog timer; null = disarmed. */
	idleTimer: ReturnType<typeof setTimeout> | null;
	/** Output watchers (completion detection for terminal-backed bash): after register,
	 *  accumulate new data in appendOutput and match a regex; callback once on hit or
	 *  terminal exit, then remove. buf accumulates from the moment of registration. */
	watches: { re: RegExp; buf: string; cb: (m: RegExpMatchArray | null) => void }[];
	/** true = terminal-backed bash just issued a sentinel-bearing command that has not
	 *  finished yet (terminal_wait uses this to tell "a command is running" from "shell
	 *  idle at the prompt" — waiting for a sentinel in the latter case never completes). */
	sentinelPending?: boolean;
}

const isWindows = process.platform === "win32";
const MAX_TERMINALS = 16;
/** Coalescing window for terminal_output WS messages (one animation frame). */
const OUTPUT_FLUSH_MS = 16;
const MAX_TERMINAL_HISTORY = 32;
const MAX_OUTPUT = 200_000;
const MAX_INPUT = 64 * 1024;
const MAX_ID = 80;

/**
 * Terminal-liveness threshold: when a terminal the agent has touched is silent
 * this long continuously and the conversation is running, notify the host via
 * onAgentIdle (the host injects a steer so the AI goes and checks).
 * Overridden by PI_WEB_TERMINAL_IDLE_MS; 0 = disable. Read on every call (tests can inject).
 */
export function terminalIdleNotifyMs(): number {
	const raw = Number(process.env.PI_WEB_TERMINAL_IDLE_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
}

// ---------------------------------------------------------------------------
// Terminal-backed bash tool
// ---------------------------------------------------------------------------

/** Sentinel line: printed by the shell after the command finishes, carrying the real
 *  exit code. The regex matches digits only, so it will not false-match the printf
 *  format string `[pi-exit:%s]` in the echo. */
const BASH_SENTINEL_RE = /\[pi-exit:(\d+)\]/g;

/**
 * Turn an arbitrary command (including a multi-line script) into a single-line
 * interactive shell command: execute + capture the exit code.
 *
 * A single line is essential: the whole line is fully parsed by the shell before
 * it runs, so a command that reads stdin mid-way will not consume the following
 * sentinel; it also avoids the interactive shell's bracketed-paste handling of
 * multi-line input. Multi-line scripts are ANSI-C quoted with `$'...'` and handed
 * to eval (supported by bash / zsh / busybox ash).
 */
export function buildTerminalBashLine(command: string): string {
	const trimmed = command.replace(/\s+$/, "");
	let body = trimmed;
	if (trimmed.includes("\n")) {
		body = `eval $'${trimmed
			.replace(/\\/g, "\\\\")
			.replace(/'/g, "\\'")
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n")
			.replace(/\t/g, "\\t")}'`;
	}
	return `${body}; __pi_rc=$?; printf '\\n[pi-exit:%s]\\n' "$__pi_rc"`;
}

/** Strip ANSI escape sequences (OSC/CSI/other ESC sequences) and lone CRs (progress-bar
 *  redraws) so PTY echo becomes bash-tool-style plain text. */
export function stripAnsi(s: string): string {
	return s
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC (title / hyperlinks, etc.)
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI (color / cursor / clear, etc.)
		.replace(/\x1b[@-_]/g, "") // remaining single-char ESC sequences
		.replace(/\r(?!\n)/g, ""); // lone CR (in-place progress-bar redraw)
}

/** Truncate an overly long tool result: keep head and tail, omit the middle. */
function truncateMiddle(text: string, max = 30_000): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.3);
	const tail = max - head;
	return `${text.slice(0, head)}\n…(${text.length - max} characters omitted)…\n${text.slice(-tail)}`;
}

/** `-i` makes bash interactive; cmd.exe / powershell.exe are interactive on their own. */
function bashArgs(shell: string): string[] {
	return /[\\/]bash(\.exe)?$/i.test(shell) ? ["-i"] : [];
}

/**
 * Interactive shell for PTYs.
 * - Windows: prefer bash — it matches the SDK's bash tool, so the agent and
 *   the terminal speak the same shell language (no more PowerShell/bash
 *   mix that leaves heredocs / `&&` / `<<` hanging or erroring). Order:
 *   1. PI_WEB_SHELL (explicit override)
 *   2. $SHELL when it exists on disk (user launched from a Git Bash session)
 *   3. Git Bash install paths (ProgramFiles / ProgramFiles(x86))
 *   4. busybox-w32 fallback in <home>/.pi-web/bin/bash.exe (ensure-bash.ts
 *      downloads it automatically when 2–3 are absent)
 *   5. $COMSPEC (cmd.exe — always set)
 *   6. powershell.exe (last resort)
 * - POSIX: the user's login shell, falling back to bash.
 * Resolved per terminal spawn (not at module load) so a busybox download that
 * finishes after startup is picked up by the next terminal.
 */
function resolveShell(): { shell: string; args: string[] } {
	if (isWindows) {
		const explicit = process.env.PI_WEB_SHELL;
		if (explicit) return { shell: explicit, args: bashArgs(explicit) };
		const she = process.env.SHELL;
		if (she && existsSync(she)) return { shell: she, args: bashArgs(she) };
		const pf = process.env.ProgramFiles;
		const pf86 = process.env["ProgramFiles(x86)"];
		for (const cand of [
			pf ? join(pf, "Git", "bin", "bash.exe") : "",
			pf86 ? join(pf86, "Git", "bin", "bash.exe") : "",
		]) {
			if (cand && existsSync(cand)) return { shell: cand, args: ["-i"] };
		}
		const busybox = join(homedir(), ".pi-web", "bin", "bash.exe");
		if (existsSync(busybox)) return { shell: busybox, args: ["-i"] };
		return { shell: process.env.COMSPEC || "powershell.exe", args: [] };
	}
	return { shell: process.env.SHELL || "bash", args: ["-i"] };
}

/**
 * Shell for the terminal-backed bash tool ('ai-bash'): ALWAYS bash, never the
 * user's login shell (often zsh on macOS, whose `read -p` etc. diverge from
 * the bash semantics models write). Windows already prefers Git Bash/busybox
 * bash; on posix pick $SHELL when it is bash, else plain `bash`.
 */
function resolveBashShell(): { shell: string; args: string[] } {
	if (isWindows) {
		const pf = process.env.ProgramFiles;
		const pf86 = process.env["ProgramFiles(x86)"];
		for (const cand of [
			pf ? join(pf, "Git", "bin", "bash.exe") : "",
			pf86 ? join(pf86, "Git", "bin", "bash.exe") : "",
		]) {
			if (cand && existsSync(cand)) return { shell: cand, args: ["-i"] };
		}
		const busybox = join(homedir(), ".pi-web", "bin", "bash.exe");
		if (existsSync(busybox)) return { shell: busybox, args: ["-i"] };
	}
	const she = process.env.SHELL;
	if (she && she.endsWith("bash") && existsSync(she)) {
		return { shell: she, args: ["-i"] };
	}
	return { shell: "bash", args: ["-i"] };
}

/**
 * Environment for spawned shells. System services (launchd/systemd) run with
 * no locale variables, which puts the shell in the C locale: its line editor
 * then renders UTF-8 continuation bytes 0x80–0x9F as C1 control characters
 * (e.g. `�<0091><0098>` for U+5458), garbling CJK input in the terminal.
 * Default a UTF-8 locale so multibyte text round-trips.
 */
function shellEnv(): Record<string, string> {
	const env: Record<string, string> = {
		...process.env,
		TERM: "xterm-256color",
	};
	if (!env.LANG && !env.LC_ALL) env.LANG = "en_US.UTF-8";
	return env;
}

// ---------------------------------------------------------------------------
// node-pty ConoutConnection warning noise (Node --watch)
// ---------------------------------------------------------------------------
// node-pty's ConoutConnection warns about every unknown message from its ConPTY
// worker thread. Under `node --watch` (the dev server: `node --watch --import
// tsx`), Node's watch mode pushes `watch:require` / `watch:import` messages over
// the worker's message channel to track module dependencies; node-pty doesn't
// recognize them and logs one `Unexpected ConoutWorkerMessage { … }` per message
// — hundreds of lines per terminal (the SCM panel's hidden query PTY triggers it
// on every git-view open). The messages are harmless: the worker only ever sends
// its READY sentinel, which the handler does process. Filter that exact warning
// at the console boundary so dev output stays readable. Production runs without
// --watch and never produces these.
const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
	if (args[0] === "Unexpected ConoutWorkerMessage") return;
	originalWarn(...args);
};

// ---------------------------------------------------------------------------
// spawn-helper permission repair (node-pty macOS prebuilds)
// ---------------------------------------------------------------------------
// node-pty 1.1.0 publishes its macOS prebuilds with `spawn-helper` lacking the
// execute bit (mode 0644 in the npm tarball), so posix_spawn fails with EACCES
// and node-pty throws the generic "posix_spawnp failed". Locally-built
// copies (build/Release) are fine; every `npm install` that picks the prebuild
// — e.g. `npm i -g pi-web-ui`, which is what system-service installs run — is
// broken until the bit is restored. Self-heal at startup AND lazily before
// every spawn (an `npm i -g` while the server is running replaces the helper
// under the running process, so the startup-only repair misses it).
// Best-effort: a read-only node_modules just keeps the old failure.

const require = createRequire(import.meta.url);

/** Absolute paths of every node-pty spawn-helper this install can exec. */
function spawnHelperPaths(): string[] {
	try {
		// require.resolve("node-pty") → <pkg>/lib/index.js → package root is two up.
		const pkgDir = dirname(dirname(require.resolve("node-pty")));
		const out: string[] = [];
		const built = join(pkgDir, "build", "Release", "spawn-helper");
		if (existsSync(built)) out.push(built);
		const prebuildsDir = join(pkgDir, "prebuilds");
		if (existsSync(prebuildsDir)) {
			for (const entry of readdirSync(prebuildsDir)) {
				const p = join(prebuildsDir, entry, "spawn-helper");
				if (existsSync(p)) out.push(p);
			}
		}
		return out;
	} catch {
		return [];
	}
}

/** Restore the +x bit on node-pty's spawn-helper binaries (idempotent). */
function repairSpawnHelperPermissions(): void {
	if (isWindows) return;
	for (const p of spawnHelperPaths()) {
		try {
			if ((statSync(p).mode & 0o111) === 0) chmodSync(p, 0o755);
		} catch {
			// best-effort; a read-only node_modules just keeps the old failure
		}
	}
}
repairSpawnHelperPermissions();

/** Path of a still-broken helper, for the error hint ("" when none). */
function brokenSpawnHelper(): string {
	if (isWindows) return "";
	for (const p of spawnHelperPaths()) {
		try {
			if ((statSync(p).mode & 0o111) === 0) return p;
		} catch {
			// ignore
		}
	}
	return "";
}

// ---------------------------------------------------------------------------
// macOS TCC camera/mic warning (launchd-spawned servers)
// ---------------------------------------------------------------------------
// TCC attributes camera/mic access to the process chain's "responsible
// process". When pi-web-ui runs as a launchd LaunchAgent (node ← launchd),
// the responsible process is node itself — a bare CLI binary with no app
// bundle / Info.plist / NSCameraUsageDescription — so TCC silently denies
// camera access (no prompt, nothing to tick in System Settings) and
// ffmpeg-style grabbers hang on frame capture. The identical command works
// from a terminal app that already holds the camera grant. Detect the
// "no GUI ancestor" case (ppid === 1 on macOS) and warn in the terminal.
const TCC_HINT = [
	"\x1b[33m[note] This terminal was started by a background service (launchd). macOS privacy permissions (camera/mic/screen) are unavailable to it.\x1b[0m",
	"\x1b[90m  · Commands that need privacy permissions are silently denied: no prompt, nothing to tick in System Settings, often hangs with no output.",
	"  · Run those in a foreground terminal you have already authorized.",
	"  · Commands that do not need privacy permissions (files, network, remote streams) are fine here.",
	"  · If you run pi-web-ui in a foreground terminal, this note will not appear.\x1b[0m",
].join("\r\n") + "\r\n";

/** True when this server was spawned by launchd (or orphaned) on macOS — no GUI app in the ancestry, so camera/mic TCC grants are unavailable. */
function launchdSpawnedOnMac(): boolean {
	return process.platform === "darwin" && process.ppid === 1;
}

// ---------------------------------------------------------------------------
// Key encoding (pure — byte-exact assertions live in terminal-smoke-test.mjs)
// ---------------------------------------------------------------------------
/** A key translated to the exact byte sequence for the PTY, or an error. */
export type TerminalKeyEncoding = { data: string } | { error: string };

/**
 * Translate a logical key (named key or single character) plus modifiers into
 * the exact byte sequence a PTY expects. Named keys are routed by NAME, so a
 * Ctrl/Alt combo is NEVER derived from the key's first letter: Ctrl+ArrowUp
 * must produce `ESC[1;5A`, not Ctrl+A, and Ctrl+Enter `ESC[13;5u`, not Ctrl+E.
 *  - arrows / F1–F4 / Home / End keep their plain form when unmodified and
 *    gain the xterm modifier parameter (`ESC[1;<m>X`) under Shift/Alt/Ctrl;
 *  - other named keys (Enter/Tab/Backspace/Escape/Insert/Delete/PageUp/PageDown)
 *    fall back to the CSI-u form (`ESC[<code>;<m>u`) once modified;
 *  - plain characters: Ctrl maps A–Z to 0x01–0x1A (error for non-letters),
 *    Shift uppercases, Alt prefixes with ESC.
 */
export function encodeTerminalKey(
	key: string,
	modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): TerminalKeyEncoding {
	const named: Record<string, string> = {
		Enter: "\r", Return: "\r", Tab: "\t", Backspace: "\x7f", Escape: "\x1b",
		Up: "\x1b[A", ArrowUp: "\x1b[A", Down: "\x1b[B", ArrowDown: "\x1b[B",
		Left: "\x1b[D", ArrowLeft: "\x1b[D", Right: "\x1b[C", ArrowRight: "\x1b[C",
		Home: "\x1b[H", End: "\x1b[F", Delete: "\x1b[3~", Insert: "\x1b[2~",
		PageUp: "\x1b[5~", PageDown: "\x1b[6~", F1: "\x1bOP", F2: "\x1bOQ", F3: "\x1bOR", F4: "\x1bOS",
	};
	let data = named[key] ?? (key.length === 1 ? key : "");
	if (!data) return { error: `Unsupported terminal key: ${key}` };
	// xterm modifier encoding: 1=plain, 2=Shift, 3=Alt, 5=Ctrl,
	// 6=Ctrl+Shift, 7=Ctrl+Alt, 8=Ctrl+Alt+Shift.
	const modifier = 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
	const arrow = /^\x1b\[([A-DHF])$/.exec(data);
	const functionKey = /^\x1bO([P-S])$/.exec(data);
	const namedCode: Record<string, number> = {
		Enter: 13, Return: 13, Tab: 9, Backspace: 127, Escape: 27,
		Insert: 2, Delete: 3, Home: 1, End: 4, PageUp: 5, PageDown: 6,
	};
	if (arrow && modifier !== 1) {
		data = `\x1b[1;${modifier}${arrow[1]}`;
	} else if (functionKey && modifier !== 1) {
		data = `\x1b[1;${modifier}${functionKey[1]}`;
	} else if (namedCode[key] !== undefined && modifier !== 1) {
		// CSI-u keeps named keys identifiable. In particular, Ctrl+Enter and
		// Ctrl+Tab must not be derived from the first letter of "Enter"/"Tab".
		data = `\x1b[${namedCode[key]};${modifier}u`;
	} else {
		if (modifiers.ctrl) {
			if (key.length !== 1) return { error: `Invalid Ctrl combo: ${key}` };
			const code = key.toUpperCase().charCodeAt(0);
			if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
			else return { error: `Invalid Ctrl combo: ${key}` };
		} else if (modifiers.shift && key.length === 1) {
			data = key.toUpperCase();
		}
		if (modifiers.alt) data = "\x1b" + data;
	}
	return { data };
}

/**
 * Owns one or more PTYs for a conversation. All output is forwarded as
 * `terminal_output` messages through the provided emit (broadcast to every
 * socket attached to the client session). Failed spawns emit an error notice and
 * terminal_exit instead of throwing into the WebSocket dispatcher.
 */
export class TerminalManager {
	/** Live PTYs only. Exited entries move to history so they no longer consume
	 * the live-terminal limit while their output remains readable/replayable. */
	private terms = new Map<string, TermEntry>();
	private history = new Map<string, TermEntry>();
	private seq = 0;
	private tccHintShown = false;

	/** Host callback: fired when a terminal the AI has touched is silent ≥ the threshold
	 *  (one-shot / epoch semantics: see noteAgentActivity). The host decides whether the
	 *  session is running and whether to inject. */
	onAgentIdle: ((terminalId: string, idleMs: number, title: string) => void) | null = null;

	constructor(
		private emit: (msg: ServerMessage) => void,
		private readonly workspaceRoot: string,
	) {}

	/** Start a plain interactive shell in the given directory. */
	create(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		fallbackCwd: string,
		title?: string,
		opts?: { forceBash?: boolean },
	): TerminalInfo | null {
		const valid = this.validateId(id);
		if (valid) {
			this.fail(id, valid);
			return null;
		}
		if (this.terms.has(id)) return this.info(this.terms.get(id)!);
		// Every spawn path shares the same admission rule (ensureSpawnAllowed):
		// a NEW live PTY needs a free slot under the cap. Reusing an exited name
		// starts a fresh PTY and discards its old history — but only after the
		// slot check, so a rejected request keeps its retained output.
		if (!this.ensureSpawnAllowed(id)) return null;
		this.history.delete(id);
		const safeCwd = this.safeCwd(cwd || fallbackCwd);
		if (!safeCwd) {
			this.fail(id, "Terminal cwd must be inside the current workspace");
			return null;
		}
		if (
			this.spawnShell(
				id,
				safeCwd,
				cols,
				rows,
				title || `Terminal ${++this.seq}`,
				undefined,
				opts?.forceBash,
			)
		) {
			this.maybeEmitTccHint(id);
			this.emitList();
			return this.info(this.terms.get(id)!);
		}
		return null;
	}

	/** Warn about unavailable camera/mic TCC grants in a fresh terminal, once per client. */
	private maybeEmitTccHint(id: string): void {
		if (this.tccHintShown || !launchdSpawnedOnMac()) return;
		this.tccHintShown = true;
		this.writeOut(id, TCC_HINT);
	}

	/**
	 * Start a shell in the command's directory and run the command in it.
	 *
	 * If a terminal with this id already exists it is RESTARTED in place: the
	 * running process is killed and a fresh shell runs the command again in the
	 * same terminal (used when re-running a command by clicking its entry).
	 */
	runCommand(
		id: string,
		def: CommandDef,
		cols: number,
		rows: number,
		pwd: string,
	): void {
		const invalidId = this.validateId(id);
		if (invalidId) {
			this.fail(id, invalidId);
			return;
		}
		const existing = this.terms.get(id);
		// Same admission rule as create(): a live terminal may be restarted in
		// place, but a NEW live PTY needs a free slot — an id sitting in history
		// (exited) does NOT grant one, or re-running exited terminals while at
		// the cap could push the live count past MAX_TERMINALS.
		if (!existing && !this.ensureSpawnAllowed(id)) return;
		const hasHistory = this.history.has(id);
		const rawDir = resolveCommandCwd(def.cwd, pwd);
		const dir = this.safeCwd(rawDir);
		const command = expandPwd(def.command.trim(), pwd);
		const title = def.name || command || `Terminal ${++this.seq}`;
		if (!dir) {
			this.fail(id, "Terminal cwd must be inside the current workspace");
			return;
		}

		if (existing) {
			// Re-run in place: interrupt the current process (kill the PTY's
			// process group) and start a fresh shell with the same id. Keep the
			// last known size so the replacement matches the xterm's dimensions.
			if (!existing.exited) {
				this.flushPending(existing);
				existing.exited = true;
				try {
					existing.pty.kill();
				} catch {
					// already dead
				}
			}
			cols = existing.cols || cols;
			rows = existing.rows || rows;
			this.terms.delete(id);
		}
		this.history.delete(id);

		const ok = this.spawnShell(id, dir, cols, rows, title, def);
		if (!ok) return;
		this.emitList();
		// Clear the previous run's output, then show a banner and run the command
		// (the PTY input buffer holds it until the shell is ready).
		const banner =
			"\x1b[2J\x1b[3J\x1b[H" +
			`\x1b[90m> ${command}\x1b[0m  \x1b[90m(${dir})\x1b[0m\r\n`;
		const fresh = this.terms.get(id);
		if (fresh) this.appendOutput(fresh, banner);
		this.writeOut(id, banner);
		this.maybeEmitTccHint(id);
		if (command) this.input(id, command + "\r");
	}

	/** Spawn the user's shell as a PTY. Returns false when the spawn failed. */
	private spawnShell(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		title: string,
		command?: CommandDef,
		forceBash?: boolean,
	): boolean {
		let abs = cwd;
		if (!abs) abs = homedir();
		else if (!isAbsolute(abs)) abs = resolve(abs);
		try {
			if (!existsSync(abs) || !statSync(abs).isDirectory()) {
				this.fail(id, `Not a directory: ${abs}`);
				return false;
			}
		} catch {
			this.fail(id, `Cannot access terminal directory: ${abs}`);
			return false;
		}
		// node-pty's spawn-helper may have lost its +x bit since the last repair
		// (e.g. a global npm install replaced the helper while this server runs).
		repairSpawnHelperPermissions();
		let pty: IPty;
		try {
			const { shell, args } = forceBash ? resolveBashShell() : resolveShell();
			pty = spawn(shell, args, {
				name: "xterm-256color",
				cols: Math.max(2, Math.floor(cols) || 80),
				rows: Math.max(2, Math.floor(rows) || 24),
				cwd: abs,
				env: shellEnv(),
			});
		} catch (err) {
			const helper = brokenSpawnHelper();
			this.fail(
				id,
				helper
					? `Failed to start terminal: ${(err as Error).message} (node-pty spawn-helper is not executable; run: chmod +x "${helper}")`
					: `Failed to start terminal: ${(err as Error).message}`,
			);
			return false;
		}
		const entry: TermEntry = {
			id,
			pty,
			title,
			cwd: abs,
			cols: Math.max(2, Math.floor(cols) || 80),
			rows: Math.max(2, Math.floor(rows) || 24),
			exited: false,
			exitCode: null,
			command,
			output: "",
			outputOffset: 0,
			waiters: new Set(),
			pendingOut: "",
			flushTimer: null,
			agentTouched: false,
			lastActivityAt: Date.now(),
			idleTimer: null,
			watches: [],
		};
		this.terms.set(id, entry);
		// The closures capture `entry`: after a restart the map points at the
		// replacement, so a late event from the OLD pty must be ignored.
		pty.onData((data) => {
			if (this.terms.get(id) !== entry) return;
			this.appendOutput(entry, data);
			// Coalesce instead of emitting per chunk: node-pty onData fires per
			// ConPTY read buffer (dozens of bytes to a few KB each), so a build or
			// `cat` of a big file used to produce hundreds/thousands of WS frames
			// per second — each paying stringify + frame + parse + dispatch cost.
			// A one-frame micro-batch cuts the frame rate 10-50× at ≤16ms latency
			// (imperceptible; xterm writes batch data more efficiently anyway).
			this.queueOut(entry, data);
		});
		pty.onExit(({ exitCode }) => {
			if (this.terms.get(id) !== entry) return;
			this.exit(id, exitCode);
		});
		return true;
	}

	/**
	 * Record an agent-tool touch and start a new silence epoch (called from the
	 * tool wrappers of terminal_create / terminal_input / terminal_key — the
	 * browser path must never call this, so a user-opened terminal never gets a
	 * silence nudge).
	 *
	 * Epoch semantics (anti-nag): agentTouched is also the "epoch armed" flag.
	 * After the watchdog fires once it disarms; however long the silence lasts
	 * afterwards there is no further nudge until the agent touches again
	 * (sending more input = the AI is waiting on a result again). Every chunk
	 * of output within the epoch resets the countdown.
	 */
	noteAgentActivity(id: string): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		entry.agentTouched = true;
		entry.lastActivityAt = Date.now();
		this.armIdleWatch(entry);
	}

	/** Arm (or reset from the current lastActivityAt) the silence watchdog. */
	private armIdleWatch(entry: TermEntry): void {
		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
		const idleMs = terminalIdleNotifyMs();
		if (!entry.agentTouched || idleMs <= 0) return;
		const delay = Math.max(0, idleMs - (Date.now() - entry.lastActivityAt));
		entry.idleTimer = setTimeout(() => {
			entry.idleTimer = null;
			// After an in-place restart/exit, events from the old entry must be ignored (same guard as onData/onExit).
			if (this.terms.get(entry.id) !== entry || entry.exited) return;
			// One-shot: disarm after firing until the next agent touch.
			entry.agentTouched = false;
			this.onAgentIdle?.(entry.id, Date.now() - entry.lastActivityAt, entry.title);
		}, delay);
		entry.idleTimer.unref?.();
	}

	/** Emit output immediately, bypassing the coalescing window (rare paths:
	 *  one-shot hints/banners — not per-chunk data). */
	private writeOut(id: string, data: string): void {
		this.emit({ type: "terminal_output", terminalId: id, data });
	}

	/** Queue output for the coalescing window; flushes via flushPending. */
	private queueOut(entry: TermEntry, data: string): void {
		entry.pendingOut += data;
		if (entry.flushTimer) return;
		entry.flushTimer = setTimeout(() => {
			entry.flushTimer = null;
			this.flushPending(entry);
		}, OUTPUT_FLUSH_MS);
	}

	/** Emit everything queued for this terminal (no-op when nothing pending). */
	private flushPending(entry: TermEntry): void {
		if (entry.flushTimer) {
			clearTimeout(entry.flushTimer);
			entry.flushTimer = null;
		}
		if (!entry.pendingOut) return;
		const pending = entry.pendingOut;
		entry.pendingOut = "";
		this.emit({ type: "terminal_output", terminalId: entry.id, data: pending });
	}

	private appendOutput(entry: TermEntry, data: string): void {
		entry.output += data;
		if (entry.output.length > MAX_OUTPUT) {
			const drop = entry.output.length - MAX_OUTPUT;
			entry.output = entry.output.slice(drop);
			entry.outputOffset += drop;
		}
		for (const wake of entry.waiters) wake();
		entry.waiters.clear();
		// Output within the epoch resets the silence countdown.
		entry.lastActivityAt = Date.now();
		if (entry.idleTimer) this.armIdleWatch(entry);
		// Output watchers: accumulate and match; remove on first hit (completion detection for terminal-backed bash).
		if (entry.watches.length > 0) {
			type Watch = (typeof entry.watches)[number];
			const remaining: Watch[] = [];
			const hits: { w: Watch; m: RegExpMatchArray }[] = [];
			for (const w of entry.watches) {
				w.buf += data;
				if (w.buf.length > 64_000) w.buf = w.buf.slice(-32_000);
				w.re.lastIndex = 0;
				const m = w.re.exec(w.buf);
				if (m) hits.push({ w, m }); // hit → remove (cb fired together below)
				else remaining.push(w);
			}
			entry.watches = remaining;
			for (const { w, m } of hits) w.cb(m);
		}
	}

	private validateId(id: string): string | null {
		if (!id || id.length > MAX_ID || !/^[A-Za-z0-9._:-]+$/.test(id)) {
			return "Invalid terminal name: letters, digits, .-, _ or : only (max 80 chars)";
		}
		return null;
	}

	/**
	 * Admission control for EVERY spawn path (create / runCommand): spawning a
	 * NEW live PTY is only allowed while the live count is below MAX_TERMINALS.
	 * Restarting an id that is ALREADY live is always allowed (no extra slot).
	 * History entries (exited terminals) do not reserve a slot — re-spawning
	 * one while at the cap is rejected with the standard error feedback.
	 */
	private ensureSpawnAllowed(id: string): boolean {
		if (this.terms.has(id)) return true;
		if (this.terms.size >= MAX_TERMINALS) {
			this.fail(id, `Terminal limit reached (${MAX_TERMINALS})`);
			return false;
		}
		return true;
	}

	private safeCwd(raw: string): string | null {
		try {
			const root = realpathSync(resolve(this.workspaceRoot));
			const candidate = realpathSync(isAbsolute(raw) ? resolve(raw) : resolve(root, raw));
			const rel = relative(root, candidate);
			if (rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))) {
				return candidate;
			}
		} catch {
			// Missing directories and broken symlinks are rejected by the boundary.
		}
		return null;
	}

	private info(entry: TermEntry): TerminalInfo {
		return {
			id: entry.id,
			title: entry.title,
			cwd: entry.cwd,
			cols: entry.cols,
			rows: entry.rows,
			running: !entry.exited,
			exitCode: entry.exitCode,
			command: entry.command,
		};
	}

	has(id: string): boolean {
		return this.terms.has(id) || this.history.has(id);
	}

	private find(id: string): TermEntry | undefined {
		return this.terms.get(id) ?? this.history.get(id);
	}

	list(): TerminalInfo[] {
		return [...this.terms.values(), ...this.history.values()].map((entry) => this.info(entry));
	}

	private emitList(): void {
		this.emit({ type: "terminal_list", terminals: this.list() });
	}

	/** Replay the retained output window after switching back to this conversation. */
	replay(): { terminalId: string; data: string }[] {
		return [...this.terms.values(), ...this.history.values()]
			.filter((entry) => entry.output.length > 0)
			.map((entry) => ({ terminalId: entry.id, data: entry.output }));
	}

	/** Read output after an absolute cursor. */
	read(id: string, cursor = 0, maxBytes = 20_000): { data: string; cursor: number; running: boolean; exitCode: number | null } | null {
		const entry = this.find(id);
		if (!entry) return null;
		const start = Math.max(entry.outputOffset, Math.min(cursor, entry.outputOffset + entry.output.length));
		const end = Math.min(start + Math.max(1, Math.floor(maxBytes) || 20_000), entry.outputOffset + entry.output.length);
		return { data: entry.output.slice(start - entry.outputOffset, end - entry.outputOffset), cursor: end, running: !entry.exited, exitCode: entry.exitCode };
	}

	async waitForOutput(id: string, cursor: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
		const current = this.read(id, cursor, 1);
		if (!current || current.cursor > cursor || !current.running) return;
		await new Promise<void>((resolvePromise) => {
			const entry = this.find(id);
			if (!entry) return resolvePromise();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = () => {
				if (timer) clearTimeout(timer);
				entry.waiters.delete(done);
				signal?.removeEventListener("abort", done);
				resolvePromise();
			};
			entry.waiters.add(done);
			timer = setTimeout(done, Math.max(0, Math.min(timeoutMs, 120_000)));
			signal?.addEventListener("abort", done, { once: true });
		});
	}

	inputChecked(id: string, data: string): string | null {
		if (data.length > MAX_INPUT) return `Input too long (max ${MAX_INPUT} chars)`;
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return "Terminal does not exist or the process has exited";
		// In an armed epoch, anyone writing input (including the user typing) counts as new activity and resets the countdown.
		entry.lastActivityAt = Date.now();
		if (entry.idleTimer) this.armIdleWatch(entry);
		entry.pty.write(data);
		return null;
	}

	key(id: string, key: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}): string | null {
		const encoded = encodeTerminalKey(key, modifiers);
		if ("error" in encoded) return encoded.error;
		return this.inputChecked(id, encoded.data);
	}


	/** Disarm the silence watchdog (on exit / close / stop-all). */
	private disarmIdleWatch(entry: TermEntry): void {
		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
		entry.agentTouched = false;
	}

	/** Tear down the timer without clearing the flag (suspend liveness nudges while terminal-backed bash is blocked, to avoid a double notify). */
	suspendIdleWatch(id: string): void {
		const entry = this.terms.get(id);
		if (!entry || !entry.idleTimer) return;
		clearTimeout(entry.idleTimer);
		entry.idleTimer = null;
	}

	/** Absolute cursor at the end of output (read start for terminal-backed bash). */
	endCursor(id: string): number | null {
		const entry = this.find(id);
		if (!entry) return null;
		return entry.outputOffset + entry.output.length;
	}

	/**
	 * Block until the current foreground command finishes (sentinel appears or the
	 * terminal exits). terminal_wait uses this to "rejoin the wait" after a silence
	 * unblock — the AI does not have to poll with terminal_read.
	 *
	 * @param afterCursor only accept a sentinel after this absolute offset (exclude
	 *                    leftover markers from the previous command; passing endCursor()
	 *                    means "wait for an end that appears after I called")
	 * @returns finished=false means timeout/abort (the command is still running); call again to keep waiting
	 */
	async waitForCompletion(
		id: string,
		timeoutMs: number,
		signal?: AbortSignal,
		afterCursor = 0,
	): Promise<{ finished: boolean; exitCode: number | null }> {
		const entry = this.find(id);
		if (!entry) return { finished: false, exitCode: null };
		return new Promise((resolve) => {
			// The command may already have finished before this call: first scan the existing buffer after afterCursor.
			const relStart = Math.max(0, afterCursor - entry.outputOffset);
			const segment = entry.output.slice(relStart);
			const scan = new RegExp(BASH_SENTINEL_RE.source, BASH_SENTINEL_RE.flags);
			scan.lastIndex = 0;
			const existing = [...segment.matchAll(scan)].pop();
			if (existing) {
				resolve({ finished: true, exitCode: Number(existing[1]) });
				return;
			}
			if (entry.exited) {
				resolve({ finished: true, exitCode: entry.exitCode });
				return;
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			let unwatch: () => void = () => {};
			const onAbort = () => done({ finished: false, exitCode: null });
			const done = (r: { finished: boolean; exitCode: number | null }) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				unwatch();
				resolve(r);
			};
			unwatch = this.watchOutput(id, BASH_SENTINEL_RE, (m) => {
				// m=null = the terminal was closed/exited → the command has definitely finished (exit code unknown).
				done({ finished: true, exitCode: m ? Number(m[1]) : null });
			});
			timer = setTimeout(
				() => done({ finished: false, exitCode: null }),
				Math.max(1, Math.min(timeoutMs, 600_000)),
			);
			timer.unref?.();
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** Set/clear the "sentinel pending" flag (terminal-backed bash tool only). */
	setSentinelPending(id: string, pending: boolean): void {
		const entry = this.find(id);
		if (entry) entry.sentinelPending = pending;
	}

	/** Whether a sentinel-bearing command has not finished yet (applicability check for terminal_wait). */
	isSentinelPending(id: string): boolean {
		return this.find(id)?.sentinelPending === true;
	}

	/** Register a one-shot output watcher: callback once on matching re or terminal exit. Returns an unsubscribe. */
	watchOutput(
		id: string,
		re: RegExp,
		cb: (m: RegExpMatchArray | null) => void,
	): () => void {
		const entry = this.find(id);
		if (!entry) {
			cb(null);
			return () => {};
		}
		// Each watcher gets its own regex instance (a global regex's lastIndex is shared mutable state).
		const own = new RegExp(re.source, re.flags);
		const watch = { re: own, buf: "", cb };
		entry.watches.push(watch);
		return () => {
			const cur = this.find(id);
			if (!cur) return;
			cur.watches = cur.watches.filter((w) => w !== watch);
		};
	}

	/** Emit a terminal failure (bad cwd, spawn error) and mark the terminal dead. */
	private fail(id: string, text: string): void {
		this.emit({ type: "notice", level: "error", text });
		this.emit({
			type: "terminal_output",
			terminalId: id,
			data: `\x1b[91m${text}\x1b[0m\r\n`,
		});
		this.emit({ type: "terminal_exit", terminalId: id, exitCode: null });
	}


	private exit(id: string, exitCode: number): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		this.disarmIdleWatch(entry);
		// Flush queued output BEFORE the exit banner so ordering is preserved.
		this.flushPending(entry);
		const banner = `\r\n\x1b[90m[process exited, code ${exitCode}]\x1b[0m\r\n`;
		this.appendOutput(entry, banner);
		this.emit({ type: "terminal_output", terminalId: id, data: banner });
		entry.exited = true;
		// Terminal exit → unmatched output watchers are called back with null (the host can notify "terminal closed").
		const pendingWatches = entry.watches;
		entry.watches = [];
		for (const w of pendingWatches) w.cb(null);
		entry.exitCode = exitCode;
		this.terms.delete(id);
		while (this.history.size >= MAX_TERMINAL_HISTORY) {
			const oldest = this.history.keys().next().value;
			if (typeof oldest !== "string") break;
			this.history.delete(oldest);
		}
		this.history.set(id, entry);
		this.emit({ type: "terminal_exit", terminalId: id, exitCode });
		this.emitList();
	}

	input(id: string, data: string): void {
		void this.inputChecked(id, data);
	}

	resize(id: string, cols: number, rows: number): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		try {
			entry.pty.resize(
				Math.max(2, Math.floor(cols) || 80),
				Math.max(2, Math.floor(rows) || 24),
			);
			// Remember the size so an in-place restart spawns at the same dims.
			entry.cols = Math.max(2, Math.floor(cols) || 80);
			entry.rows = Math.max(2, Math.floor(rows) || 24);
		} catch {
			// PTY already gone — nothing to do.
		}
	}

	/** Kill one terminal (tab closed), including an exited terminal's retained history. */
	kill(id: string): void {
		const entry = this.terms.get(id);
		if (entry) {
			this.disarmIdleWatch(entry);
			const killedWatches = entry.watches;
			entry.watches = [];
			for (const w of killedWatches) w.cb(null);
			this.flushPending(entry);
			entry.exited = true;
			try {
				entry.pty.kill();
			} catch {
				// already dead
			}
			this.terms.delete(id);
			this.emit({ type: "terminal_exit", terminalId: id, exitCode: null });
			this.emitList();
			return;
		}
		if (this.history.delete(id)) this.emitList();
	}

	/** Kill every terminal owned by this conversation. */
	killAll(): void {
		for (const entry of this.terms.values()) {
			this.disarmIdleWatch(entry);
			if (entry.exited) continue;
			entry.exited = true;
			try {
				entry.pty.kill();
			} catch {
				// already dead
			}
		}
		for (const entry of this.terms.values()) {
			for (const wake of entry.waiters) wake();
			entry.waiters.clear();
			for (const w of entry.watches) w.cb(null);
			entry.watches = [];
		}
		this.terms.clear();
		this.history.clear();
		this.emitList();
	}
}

// ---------------------------------------------------------------------------
// Terminal-backed bash: a bash-style tool that runs inside a persistent visible terminal
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Last sentinel match in the tail of collected (a sentinel can only appear at the end of new output). */
function lastSentinel(collected: string): RegExpMatchArray | null {
	const tail = collected.length > 8000 ? collected.slice(-8000) : collected;
	BASH_SENTINEL_RE.lastIndex = 0;
	return [...tail.matchAll(BASH_SENTINEL_RE)].pop() ?? null;
}

/** Strip input echo, the sentinel, following shell-prompt junk, and ANSI sequences, restoring bash-style plain text. */
function cleanBashOutput(raw: string): string {
	let text = stripAnsi(raw).replace(/\r\n/g, "\n");
	// The echoed command line may be wrapped by readline into multiple lines, so
	// stripping by line is unreliable — instead anchor on the printf format
	// literal [pi-exit:%s] (the real sentinel is the numeric version) and drop
	// the whole line it sits on. Note: the same command is echoed twice (PTY
	// input echo + readline prompt echo), so this must loop.
	for (;;) {
		const fmtIdx = text.indexOf("[pi-exit:%s]");
		if (fmtIdx < 0) break;
		const nl = text.indexOf("\n", fmtIdx);
		text = nl >= 0 ? text.slice(nl + 1) : "";
	}
	// Everything after the last sentinel is the shell's new prompt — chop the whole tail.
	BASH_SENTINEL_RE.lastIndex = 0;
	let last: RegExpExecArray | null = null;
	for (let m = BASH_SENTINEL_RE.exec(text); m; m = BASH_SENTINEL_RE.exec(text)) {
		last = m;
	}
	if (last) text = text.slice(0, last.index);
	const lines = text.split("\n");
	while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
	return truncateMiddle(lines.join("\n").trim());
}

/**
 * Terminal-backed bash tool: the parameters the model sees are identical to SDK
 * bash (command + optional timeout seconds), but the implementation writes the
 * command into a persistent terminal and waits for the sentinel line to get the
 * real exit code.
 *
 * Behavior:
 * - Block by default: wait until the command finishes, then return the full
 *   output (ANSI stripped) + real exit code;
 * - Silence unblock: idleMs milliseconds of no new output and still not finished
 *   → immediately return "still running" + output so far; the command keeps
 *   running in the terminal, a completion watcher is registered, and the host
 *   notifies the AI via notifyBackgroundDone when it ends (steer mid-stream /
 *   nextTurn when idle);
 * - abort_bash: AbortController is registered in the kills set; abort sends
 *   Ctrl+C to the PTY to kill the foreground process; the conversation continues
 *   (same set as makeKillableBashTool);
 * - Shell state is kept across calls (cd / venv activate / ssh session) — something
 *   the native bash tool cannot do.
 */
export function makeTerminalBashTool(
	terminals: TerminalManager,
	opts: {
		cwd: string;
		/** Silence-unblock threshold in ms; read on every call (setting takes effect immediately); 0 = never unblock. */
		idleMs: () => number;
		/** abort_bash controller set. */
		kills: Set<AbortController>;
		/** Host notification when a background command finally ends (exitCode null = the terminal was closed). */
		notifyBackgroundDone: (info: {
			terminalId: string;
			command: string;
			exitCode: number | null;
		}) => void;
	},
): ToolDefinition {
	const TERM_ID = "ai-bash";

	return defineTool({
		name: "bash",
		label: "Run bash command",
		description:
			"Run a shell command and return its full output plus exit code. Commands execute in a PERSISTENT visible terminal ('ai-bash'): shell state such as cd, venv activation or ssh sessions is retained across calls. Run the bare command — do NOT pipe through tail/head/more/less (output is returned complete anyway, and pipes hide live progress in the visible terminal). If a command stays silent for a while it keeps running in the background and you get an automatic notice when it finishes; use terminal_wait to re-block until it finishes, or terminal_read / terminal_input / terminal_key on 'ai-bash' to observe or interact anytime.",
		promptSnippet: "run commands in the persistent visible terminal (state retained across calls)",
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run" }),
			timeout: Type.Optional(
				Type.Number({ description: "Optional timeout in seconds" }),
			),
			tail: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5000,
					description:
						"Only return the LAST N lines of output (like `| tail -N`). Use this for verbose commands instead of piping through tail — the command keeps streaming live to the visible terminal while you only get the tail back.",
				}),
			),
		}),
		execute: async (_id, p, signal) => {
			// create() returns a still-alive same-name terminal as-is, and in-place
			// restarts one that has already exited. forceBash: this terminal always
			// runs bash (not the user's login shell), so bash syntax the model writes
			// (arrays / read -p / process substitution…) will not trip zsh differences.
			if (
				terminals.create(TERM_ID, opts.cwd, 120, 40, opts.cwd, "AI bash", {
					forceBash: true,
				}) === null
			) {
				throw new Error(`Cannot open AI bash terminal (${TERM_ID})`);
			}
			// Suspend liveness nudges while we are blocked waiting (we are detecting silence ourselves, to avoid a double notify).
			terminals.suspendIdleWatch(TERM_ID);
			const start = terminals.endCursor(TERM_ID)!;
			const ac = new AbortController();
			opts.kills.add(ac);
			const idleMs = Math.max(0, opts.idleMs());
			const deadline =
				p.timeout && p.timeout > 0 ? Date.now() + p.timeout * 1000 : null;
			// tail parameter: return only the last N lines (instead of a `| tail -N`
			// pipe — a pipe buffers output, leaves the visible terminal mute the whole
			// time, and easily trips a wasted silence-unblock).
			const applyTail = (t: string): string => {
				if (!p.tail || p.tail <= 0) return t;
				const lines = t.split("\n");
				return lines.length > p.tail
					? `…(${lines.length - p.tail} earlier lines omitted)\n${lines.slice(-p.tail).join("\n")}`
					: t;
			};
			try {
				let collected = "";
				let cursor = start;
				let lastDataAt = Date.now();
				// Mark "a sentinel command is running": terminal_wait uses this to tell waiting from idle.
				terminals.setSentinelPending(TERM_ID, true);
				const inputErr = terminals.inputChecked(TERM_ID, buildTerminalBashLine(p.command) + "\r");
				if (inputErr) throw new Error(inputErr);
				for (;;) {
					if (ac.signal.aborted || signal?.aborted) {
						// Ctrl+C kills the foreground process; the terminal itself is kept (session state is still there).
						terminals.setSentinelPending(TERM_ID, false);
						terminals.inputChecked(TERM_ID, "\x03");
						throw new Error("Command aborted");
					}
					await sleep(60);
					const read = terminals.read(TERM_ID, cursor);
					if (read?.data) {
						collected += read.data;
						cursor = read.cursor;
						lastDataAt = Date.now();
					}
					const m = lastSentinel(collected);
					if (m) {
						terminals.setSentinelPending(TERM_ID, false);
						const text = applyTail(cleanBashOutput(collected));
						return {
							content: [
								{
									type: "text",
									text: `${text}${text ? "\n" : ""}[exit:${m[1]}]`,
								},
							],
							details: { exitCode: Number(m[1]), output: text },
						};
					}
					if (deadline !== null && Date.now() > deadline) {
						terminals.setSentinelPending(TERM_ID, false);
						terminals.inputChecked(TERM_ID, "\x03");
						throw new Error(
							`Command timed out after ${p.timeout}s (sent Ctrl+C; output so far: ${truncateMiddle(stripAnsi(collected), 4000)})`,
						);
					}
					// Silence unblock: background it + register a completion watcher, then immediately return control to the model.
					if (idleMs > 0 && Date.now() - lastDataAt >= idleMs) {
						return backgroundResult(
							terminals,
							opts,
							p.command,
							applyTail(cleanBashOutput(collected)),
							Math.round((Date.now() - lastDataAt) / 1000),
						);
					}
				}
			} finally {
				opts.kills.delete(ac);
			}
		},
	});
}

/** Silence-unblock path: after registering a completion watcher, immediately return "still running in the background". */
function backgroundResult(
	terminals: TerminalManager,
	opts: Parameters<typeof makeTerminalBashTool>[1],
	command: string,
	partialText: string,
	silentSeconds: number,
): { content: { type: "text"; text: string }[]; details: unknown } {
	terminals.watchOutput("ai-bash", BASH_SENTINEL_RE, (m) => {
		// Background command finally ended (or the terminal was closed) → clear the pending flag; terminal_wait no longer applies.
		terminals.setSentinelPending("ai-bash", false);
		opts.notifyBackgroundDone({
			terminalId: "ai-bash",
			command,
			exitCode: m ? Number(m[1]) : null,
		});
	});
	// partialText has already been through cleanBashOutput + applyTail at the caller.
	const partial = truncateMiddle(partialText, 6000);
	return {
		content: [
			{
				type: "text",
				text:
					`Command is still running in persistent terminal ai-bash (no output for ${silentSeconds}s, not finished).` +
					`This call is not blocking — it keeps running in the background and you will be notified when it finishes.\n` +
					`Output so far:\n${partial || "(none yet)"}\n` +
					`To wait until it finishes, call terminal_wait(terminalId="ai-bash") (no polling). For input use terminal_input / terminal_key (Ctrl+C to stop).`,
			},
		],
		details: { running: true, terminalId: "ai-bash", silentSeconds },
	};
}

/** Names of the agent-facing persistent-terminal tools (used by the settings toggle gate). */
export const TERMINAL_TOOL_NAMES = [
	"terminal_create",
	"terminal_list",
	"terminal_close",
	"terminal_input",
	"terminal_key",
	"terminal_read",
	"terminal_wait",
] as const;

/** System-prompt guidance teaching the model WHEN to prefer the terminal tools
 *  over one-shot bash. Without it models almost never pick them — bash returns
 *  complete output in a single call, so it always wins on convenience. */
export const TERMINAL_TOOLS_GUIDANCE = `Persistent interactive terminal tools are available (terminal_create / terminal_list / terminal_close / terminal_input / terminal_key / terminal_read / terminal_wait). The one-shot bash tool stays the DEFAULT for ordinary commands - it runs once and returns the full output. Switch to the terminal tools only when:
- The program is interactive or TUI-based (REPLs like python/node, vim/htop, installers asking y/n, anything waiting on stdin).
- You start a long-running server or watcher and want to keep watching its output (terminal_read with waitMs), send keys to it later (e.g. interrupt via terminal_key with Ctrl+c), or block until a backgrounded command finishes without polling (terminal_wait).
- The user explicitly asks you to work in the visible terminal panel.
Liveness watchdog: terminals you touched (create/input/key) are monitored - if one goes silent with no new output while you are working (default 15s), an automatic system reminder is injected into the conversation. Treat it as a prompt to check that terminal (terminal_read), respond to an input prompt (terminal_input / terminal_key), or close it (terminal_close) if it is no longer needed.
Do NOT use them for simple one-shot commands; bash remains cheaper and simpler there.`;

/** Build the agent-facing persistent terminal tools for one conversation. */
export function makePersistentTerminalTools(
	terminals: TerminalManager,
	cwd: string,
): ToolDefinition[] {
	const result = (text: string, details: unknown = {}): {
		content: { type: "text"; text: string }[];
		details: unknown;
	} => ({ content: [{ type: "text", text }], details });
	const failIf = (error: string | null): void => {
		if (error) throw new Error(error);
	};

	return [
		defineTool({
			name: "terminal_create",
			label: "Create terminal",
			description:
				"Create a named persistent interactive PTY in the current workspace. Use terminal_input or terminal_key to interact with it and terminal_read to inspect incremental output. Prefer this over bash when the program is interactive/TUI-based (REPLs, vim/htop, y/n prompts), when starting a long-running server you want to keep observing or interrupt, or when the user asks to work in the visible terminal. For simple one-shot commands use bash instead.",
			promptSnippet:
				"run interactive programs or long-running servers in a persistent visible PTY (multi-step: create → input/key → read)",
			parameters: Type.Object({
				terminalId: Type.String({ description: "Stable terminal name" }),
				cwd: Type.Optional(Type.String({ description: "Workspace-relative directory" })),
				cols: Type.Optional(Type.Integer({ minimum: 2, maximum: 500 })),
				rows: Type.Optional(Type.Integer({ minimum: 2, maximum: 200 })),
			}),
			execute: async (_id, p) => {
				const info = terminals.create(
					p.terminalId,
					p.cwd ?? cwd,
					p.cols ?? 120,
					p.rows ?? 40,
					cwd,
					p.terminalId,
				);
				if (!info) throw new Error(`Failed to create terminal: ${p.terminalId}`);
				// AI created → start a liveness epoch (silence nudges only target terminals the agent has touched).
				terminals.noteAgentActivity(p.terminalId);
				return result(`Terminal created: ${JSON.stringify(info)}`, info);
			},
		}),
		defineTool({
			name: "terminal_list",
			label: "List terminals",
			description: "List all persistent PTY terminals owned by this conversation.",
			promptSnippet: "list persistent terminals",
			parameters: Type.Object({}),
			execute: async () => result(JSON.stringify(terminals.list()), terminals.list()),
		}),
		defineTool({
			name: "terminal_close",
			label: "Close terminal",
			description: "Close a persistent PTY and terminate its process tree.",
			parameters: Type.Object({ terminalId: Type.String() }),
			execute: async (_id, p) => {
				if (!terminals.has(p.terminalId)) throw new Error(`Terminal not found: ${p.terminalId}`);
				terminals.kill(p.terminalId);
				return result(`Terminal closed: ${p.terminalId}`);
			},
		}),
		defineTool({
			name: "terminal_input",
			label: "Send terminal input",
			description: "Send arbitrary text to a persistent PTY. Include newline when a command should be submitted.",
			parameters: Type.Object({ terminalId: Type.String(), data: Type.String() }),
			execute: async (_id, p) => {
				failIf(terminals.inputChecked(p.terminalId, p.data));
				// AI sent input = waiting on a result; start a new silence epoch.
				terminals.noteAgentActivity(p.terminalId);
				return result(`Sent ${p.data.length} character(s) to ${p.terminalId}`);
			},
		}),
		defineTool({
			name: "terminal_key",
			label: "Send terminal key",
			description: "Send Enter, Tab, arrows, function keys, or Ctrl/Alt combinations to a persistent PTY.",
			parameters: Type.Object({
				terminalId: Type.String(),
				key: Type.String({ description: "Enter, Tab, ArrowUp, c, etc." }),
				modifiers: Type.Optional(Type.Object({
					ctrl: Type.Optional(Type.Boolean()),
					alt: Type.Optional(Type.Boolean()),
					shift: Type.Optional(Type.Boolean()),
				})),
			}),
			execute: async (_id, p) => {
				failIf(terminals.key(p.terminalId, p.key, p.modifiers));
				// Same as terminal_input: restart the timer after the AI actively interacts.
				terminals.noteAgentActivity(p.terminalId);
				return result(`Sent key ${p.key} to ${p.terminalId}`);
			},
		}),
		defineTool({
			name: "terminal_read",
			label: "Read terminal output",
			description: "Read incremental output from a persistent PTY. Keep the returned cursor and pass it on the next read; optionally wait for new output or process exit.",
			parameters: Type.Object({
				terminalId: Type.String(),
				cursor: Type.Optional(Type.Integer({ minimum: 0 })),
				maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
				waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 120000 })),
			}),
			execute: async (_id, p, signal) => {
				const cursor = p.cursor ?? 0;
				if (p.waitMs) await terminals.waitForOutput(p.terminalId, cursor, p.waitMs, signal);
				const read = terminals.read(p.terminalId, cursor, p.maxBytes ?? 20000);
				if (!read) throw new Error(`Terminal not found: ${p.terminalId}`);
				return result(JSON.stringify(read), read);
			},
		}),
		defineTool({
			name: "terminal_wait",
			label: "Wait for terminal command",
			description:
				"Block until a command started THROUGH THE BASH TOOL finishes (its exit marker appears) or the timeout expires — no polling needed. Only applies to terminals with a pending bash-tool command; terminals driven manually via terminal_input (e.g. interactive programs) have no completion marker — use terminal_read(waitMs=…) to observe those instead. Returns {finished, exitCode} plus the output produced while waiting; finished=false means it is STILL running (call again to keep waiting).",
			promptSnippet: "block until a terminal's current command finishes (no polling)",
			parameters: Type.Object({
				terminalId: Type.String(),
				cursor: Type.Optional(
					Type.Integer({ minimum: 0, description: "Ignore exit markers before this absolute offset (default: now)" }),
				),
				maxWaitMs: Type.Optional(
					Type.Integer({ minimum: 100, maximum: 600000, description: "Max wait in ms (default 300000)" }),
				),
			}),
			execute: async (_id, p, signal) => {
				if (!terminals.has(p.terminalId)) {
					throw new Error(`Terminal not found: ${p.terminalId} (closed or session reset; terminal_create first)`);
				}
				// No pending sentinel-bearing command: the shell is idle at the prompt, or
				// this terminal's command was sent by hand via terminal_input (no completion
				// marker) — waiting for a sentinel would never finish. Explain that and
				// steer toward terminal_read so the AI does not retry forever. (A call that
				// explicitly passes cursor is a purposeful look-back and is not blocked.)
				if (p.cursor === undefined && !terminals.isSentinelPending(p.terminalId)) {
					const why = `Terminal ${p.terminalId} has no bash-tool command waiting to finish (idle shell, or the command was sent via terminal_input with no completion marker). terminal_wait does not apply; use terminal_read(terminalId="${p.terminalId}", waitMs=…).`;
					return result(
						JSON.stringify({ applicable: false, reason: why }),
						{ applicable: false },
					);
				}
				const cursor = p.cursor ?? terminals.endCursor(p.terminalId) ?? 0;
				const wait = await terminals.waitForCompletion(
					p.terminalId,
					p.maxWaitMs ?? 300_000,
					signal,
					cursor,
				);
				const read = terminals.read(p.terminalId, cursor, 20_000);
				const outputTail = read?.data ? stripAnsi(read.data).slice(-4000) : "";
				return result(JSON.stringify({ ...wait, outputTail }), {
					...wait,
					outputTail,
				});
			},
		}),
	];
}
