/**
 * MCP tool bridge — exposes tools from external Model Context Protocol
 * (stdio) servers into the pi session so the agent can call real third-party
 * tools (files, databases, GitHub, …).
 *
 * Contract (streaming subset of the MCP spec):
 *  - stdio transport = newline-delimited JSON-RPC 2.0 (NDJSON) on
 *    stdin/stdout; no third-party packages; stderr is a free-form log channel.
 *  - handshake: initialize (with protocolVersion) → notifications/initialized →
 *    tools/list → tools/call.
 *  - tool enrollment: this module adapts each remote tool into a
 *    PluginAgentTool and feeds it through pluginToolsProvider — the same
 *    customTools pipeline as plugin tools.
 *
 * Config: <PI_WEB_DATA_DIR>/mcp.json, shaped like
 *   { "servers": { "gitserv": { "command": "node", "args": ["mcp.js"], "cwd": "/x" } } }
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginAgentTool } from "./plugins.js";

/** JSON-RPC 2.0 over stdio: one JSON object per line. */
export interface McpServerSpec {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	// Optional MCP protocol version (defaults to the latest known).
	protocolVersion?: string;
}

interface RpcIncoming {
	id?: number | string;
	method?: string;
	params?: { [k: string]: unknown };
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = "2025-03-26"; // widely supported tools version

let rpcSeq = 0;

/**
 * Client for a single MCP server: manages the child process, correlates
 * request/response by id, handshake, and tool calls.
 * Threading: no extra concurrency control (MCP allows out-of-order replies
 * and we match responses by request id).
 */
export class McpClient {
	private child: ChildProcess | null = null;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	private log: (...a: unknown[]) => void;
	readonly name: string;
	/** Tools after handshake (cached tools/list result). */
	private tools: McpToolDefinition[] = [];
	private shuttingDown = false;

	constructor(name: string, private spec: McpServerSpec, log?: (...a: unknown[]) => void) {
		this.name = name;
		this.log = log ?? (() => {});
	}

	/** Spawn the child, handshake, and fetch the tool list. */
	async start(timeoutMs = 8000): Promise<void> {
		if (this.child) return;
		const { command, args = [], cwd, env } = this.spec;
		this.log(`[mcp:${this.name}] starting: ${command} ${args.join(" ")}`);
		const child = spawn(command, args, {
			cwd: cwd ?? undefined,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;
		child.stderr.on("data", (d) => this.log(`[mcp:${this.name}] stderr:`, d.toString().trimEnd()));
		child.on("error", (err) => this.rejectAll(new Error(`[mcp:${this.name}] spawn error: ${err.message}`)));
		child.on("exit", (code, sig) => {
			this.child = null;
			if (!this.shuttingDown) this.rejectAll(new Error(`[mcp:${this.name}] process exited (${sig ?? code})`));
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onData(chunk));

		// Handshake.
		const handshake = await this.request("initialize", {
			protocolVersion: this.spec.protocolVersion ?? PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "pi-web-ui", version: "0.41.0" },
		});
		const version = (handshake as { protocolVersion?: string })?.protocolVersion ?? this.spec.protocolVersion ?? PROTOCOL_VERSION;
		// notifications/initialized (notification — no id).
		this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		// Still call tools with the negotiated protocol version (most servers
		// tolerate newer versions; we use whatever was negotiated).
		void version;
		const listed = (await this.request("tools/list", {}) ?? {}) as {
			tools?: McpToolDefinition[];
		};
		this.tools = Array.isArray(listed.tools) ? listed.tools : [];
		this.log(`[mcp:${this.name}] ready, ${this.tools.length} tools`);
	}

	/** Discovered tools. */
	getTools(): McpToolDefinition[] {
		return this.tools.map((t) => ({ ...t }));
	}

	/** Call a tool; return the result text (multiple content parts joined as JSON for fidelity). */
	async call(name: string, args: Record<string, unknown>, timeoutMs = 60000): Promise<unknown> {
		const res = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as {
			content?: Array<{ type?: string; text?: string }>;
			isError?: boolean;
			structuredContent?: unknown;
		};
		if (res?.isError) {
			const msg = (res.content ?? []).map((c) => c.text ?? "").join("\n").trim() || "MCP tool error";
			throw new Error(msg);
		}
		// Prefer structured content; fall back to text.
		if (res?.structuredContent !== undefined) return res.structuredContent;
		const text = (res.content ?? []).map((c) => c.text ?? "").filter((x) => x).join("\n");
		return { content: text, isError: !!res.isError };
	}

	/** Shut down: kill the child and reject all in-flight requests. */
	close(): void {
		this.shuttingDown = true;
		this.rejectAll(new Error("[mcp] client closed"));
		if (this.child) {
			try {
				this.child.kill();
			} catch {
				/* already exited */
			}
			this.child = null;
		}
	}

	// -- internals --------------------------------------------------------
	private send(msg: unknown): void {
		const stdin = this.child?.stdin;
		if (!stdin || !stdin.writable) return;
		stdin.write(JSON.stringify(msg) + "\n");
	}

	private request(method: string, params: Record<string, unknown>, timeoutMs = 8000): Promise<unknown> {
		const id = (rpcSeq++);
		const outId = String(id);
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(outId);
				reject(new Error(`[mcp:${this.name}] ${method} timed out (${timeoutMs}ms)`));
			}, timeoutMs);
			this.pending.set(outId, { resolve, reject, timer });
			this.send({ jsonrpc: "2.0", id: id, method, params });
		});
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let nl: number;
		while ((nl = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (!line) continue;
			let msg: RpcIncoming;
			try {
				msg = JSON.parse(line) as RpcIncoming;
			} catch {
				this.log(`[mcp:${this.name}] non-JSON line (ignored):`, line.slice(0, 120));
				continue;
			}
			this.handleMessage(msg);
		}
	}

	private handleMessage(msg: RpcIncoming): void {
		if (msg.id !== undefined) {
			const pending = this.pending.get(String(msg.id));
			if (!pending) {
				this.log(`[mcp:${this.name}] unknown response id=${msg.id}`);
				return;
			}
			this.pending.delete(String(msg.id));
			clearTimeout(pending.timer);
			if (msg.error) pending.reject(new Error(`[mcp:${this.name}] ${msg.error.message ?? "MCP error"}`));
			else pending.resolve(msg.result);
			return;
		}
		// Server-initiated notifications (log / cancelled, etc.) — log only.
		if (msg.method === "notifications/message") {
			const p = msg.params as { level?: string; message?: string } | undefined;
			if (p?.message) this.log(`[mcp:${this.name}] ${p.level ?? "message"}:`, p.message);
		}
	}

	private rejectAll(err: Error): void {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}
}

export interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

/** Read the server list from <dataDir>/mcp.json (best-effort). */
export function readMcpConfig(dataDir: string): { servers: Record<string, McpServerSpec> } {
	try {
		const raw = JSON.parse(readFileSync(join(dataDir, "mcp.json"), "utf8")) as {
			servers?: Record<string, McpServerSpec>;
		};
		const servers: Record<string, McpServerSpec> = {};
		for (const [name, s] of Object.entries(raw.servers ?? {})) {
			if (!s || typeof s.command !== "string" || !s.command.trim()) continue;
			servers[name] = {
				command: s.command,
				args: Array.isArray(s.args) ? s.args.map(String) : [],
				cwd: typeof s.cwd === "string" ? s.cwd : undefined,
				env: s.env && typeof s.env === "object" ? (s.env as Record<string, string>) : undefined,
			};
		}
		return { servers };
	} catch {
		return { servers: {} };
	}
}

/**
 * Adapt each MCP tool into a PluginAgentTool for the manager.
 * execute forwards to the corresponding McpClient.call.
 */
function adaptMcpTool(serverName: string, mcpTool: McpToolDefinition, client: McpClient): PluginAgentTool {
	const name = sanitizeToolName(mcpTool.name);
	return {
		name,
		label: `${serverName} · ${mcpTool.name}`,
		description: mcpTool.description ?? `MCP tool ${mcpTool.name} from server ${serverName}`,
		parameters: mcpTool.inputSchema ?? {},
		execute: async (_toolCallId: string, params: Record<string, unknown>, _signal?: AbortSignal) => {
			return client.call(mcpTool.name, params ?? {});
		},
	};
}

/** Tool names must be [A-Za-z0-9_-]+ (same rule as plugin tools). MCP names may contain colons/slashes — normalize. */
function sanitizeToolName(name: string): string {
	const cleaned = (name || "").replace(/[^A-Za-z0-9_-]/g, "_");
	return cleaned || "mcp_tool";
}

/** MCP server manager: owns multi-server lifecycle and aggregates tools. */
export class McpBridge {
	private clients: McpClient[] = [];
	private tools: PluginAgentTool[] = [];

	constructor(
		private dataDir: string,
		private log: (...a: unknown[]) => void = () => {},
		private opts: { specOverride?: { name: string; spec: McpServerSpec }[] } = {},
	) {}

	/** Read config and start every server (per-server fail-fast: a single failure is logged and does not take the others down). */
	async load(): Promise<void> {
		const cfg = optsOverrideOrRead(this.opts.specOverride, this.dataDir);
		await Promise.all(
			Object.entries(cfg.servers).map(async ([name, spec]) => {
				try {
					const client = new McpClient(name, spec, this.log);
					await client.start();
					this.clients.push(client);
					for (const t of client.getTools()) this.tools.push(adaptMcpTool(name, t, client));
				} catch (err) {
					this.log(`[mcp] server "${name}" failed to start:`, err instanceof Error ? err.message : err);
				}
			}),
		);
	}

	getTools(): PluginAgentTool[] {
		return this.tools;
	}

	hasServers(): boolean {
		return this.clients.length > 0;
	}

	dispose(): void {
		for (const c of this.clients) c.close();
		this.clients = [];
		this.tools = [];
	}
}

function optsOverrideOrRead(specOverride: { name: string; spec: McpServerSpec }[] | undefined, dataDir: string): {
	servers: Record<string, McpServerSpec>;
} {
	if (specOverride && specOverride.length > 0) {
		const servers: Record<string, McpServerSpec> = {};
		for (const o of specOverride) servers[o.name] = o.spec;
		return { servers };
	}
	return readMcpConfig(dataDir);
}
