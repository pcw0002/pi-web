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
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const PROTOCOL_VERSION = "2025-03-26"; // widely supported tools version
let rpcSeq = 0;
/**
 * Client for a single MCP server: manages the child process, correlates
 * request/response by id, handshake, and tool calls.
 * Threading: no extra concurrency control (MCP allows out-of-order replies
 * and we match responses by request id).
 */
export class McpClient {
    spec;
    child = null;
    buffer = "";
    nextId = 1;
    pending = new Map();
    log;
    name;
    /** Tools after handshake (cached tools/list result). */
    tools = [];
    shuttingDown = false;
    constructor(name, spec, log) {
        this.spec = spec;
        this.name = name;
        this.log = log ?? (() => { });
    }
    /** Spawn the child, handshake, and fetch the tool list. */
    async start(timeoutMs = 8000) {
        if (this.child)
            return;
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
            if (!this.shuttingDown)
                this.rejectAll(new Error(`[mcp:${this.name}] process exited (${sig ?? code})`));
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => this.onData(chunk));
        // Handshake.
        const handshake = await this.request("initialize", {
            protocolVersion: this.spec.protocolVersion ?? PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "pi-web-ui", version: "0.41.0" },
        });
        const version = handshake?.protocolVersion ?? this.spec.protocolVersion ?? PROTOCOL_VERSION;
        // notifications/initialized (notification — no id).
        this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        // Still call tools with the negotiated protocol version (most servers
        // tolerate newer versions; we use whatever was negotiated).
        void version;
        const listed = (await this.request("tools/list", {}) ?? {});
        this.tools = Array.isArray(listed.tools) ? listed.tools : [];
        this.log(`[mcp:${this.name}] ready, ${this.tools.length} tools`);
    }
    /** Discovered tools. */
    getTools() {
        return this.tools.map((t) => ({ ...t }));
    }
    /** Call a tool; return the result text (multiple content parts joined as JSON for fidelity). */
    async call(name, args, timeoutMs = 60000) {
        const res = (await this.request("tools/call", { name, arguments: args }, timeoutMs));
        if (res?.isError) {
            const msg = (res.content ?? []).map((c) => c.text ?? "").join("\n").trim() || "MCP tool error";
            throw new Error(msg);
        }
        // Prefer structured content; fall back to text.
        if (res?.structuredContent !== undefined)
            return res.structuredContent;
        const text = (res.content ?? []).map((c) => c.text ?? "").filter((x) => x).join("\n");
        return { content: text, isError: !!res.isError };
    }
    /** Shut down: kill the child and reject all in-flight requests. */
    close() {
        this.shuttingDown = true;
        this.rejectAll(new Error("[mcp] client closed"));
        if (this.child) {
            try {
                this.child.kill();
            }
            catch {
                /* already exited */
            }
            this.child = null;
        }
    }
    // -- internals --------------------------------------------------------
    send(msg) {
        const stdin = this.child?.stdin;
        if (!stdin || !stdin.writable)
            return;
        stdin.write(JSON.stringify(msg) + "\n");
    }
    request(method, params, timeoutMs = 8000) {
        const id = (rpcSeq++);
        const outId = String(id);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(outId);
                reject(new Error(`[mcp:${this.name}] ${method} timed out (${timeoutMs}ms)`));
            }, timeoutMs);
            this.pending.set(outId, { resolve, reject, timer });
            this.send({ jsonrpc: "2.0", id: id, method, params });
        });
    }
    onData(chunk) {
        this.buffer += chunk;
        let nl;
        while ((nl = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (!line)
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                this.log(`[mcp:${this.name}] non-JSON line (ignored):`, line.slice(0, 120));
                continue;
            }
            this.handleMessage(msg);
        }
    }
    handleMessage(msg) {
        if (msg.id !== undefined) {
            const pending = this.pending.get(String(msg.id));
            if (!pending) {
                this.log(`[mcp:${this.name}] unknown response id=${msg.id}`);
                return;
            }
            this.pending.delete(String(msg.id));
            clearTimeout(pending.timer);
            if (msg.error)
                pending.reject(new Error(`[mcp:${this.name}] ${msg.error.message ?? "MCP error"}`));
            else
                pending.resolve(msg.result);
            return;
        }
        // Server-initiated notifications (log / cancelled, etc.) — log only.
        if (msg.method === "notifications/message") {
            const p = msg.params;
            if (p?.message)
                this.log(`[mcp:${this.name}] ${p.level ?? "message"}:`, p.message);
        }
    }
    rejectAll(err) {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
    }
}
/** Read the server list from <dataDir>/mcp.json (best-effort). */
export function readMcpConfig(dataDir) {
    try {
        const raw = JSON.parse(readFileSync(join(dataDir, "mcp.json"), "utf8"));
        const servers = {};
        for (const [name, s] of Object.entries(raw.servers ?? {})) {
            if (!s || typeof s.command !== "string" || !s.command.trim())
                continue;
            servers[name] = {
                command: s.command,
                args: Array.isArray(s.args) ? s.args.map(String) : [],
                cwd: typeof s.cwd === "string" ? s.cwd : undefined,
                env: s.env && typeof s.env === "object" ? s.env : undefined,
            };
        }
        return { servers };
    }
    catch {
        return { servers: {} };
    }
}
/**
 * Adapt each MCP tool into a PluginAgentTool for the manager.
 * execute forwards to the corresponding McpClient.call.
 */
function adaptMcpTool(serverName, mcpTool, client) {
    const name = sanitizeToolName(mcpTool.name);
    return {
        name,
        label: `${serverName} · ${mcpTool.name}`,
        description: mcpTool.description ?? `MCP tool ${mcpTool.name} from server ${serverName}`,
        parameters: mcpTool.inputSchema ?? {},
        execute: async (_toolCallId, params, _signal) => {
            return client.call(mcpTool.name, params ?? {});
        },
    };
}
/** Tool names must be [A-Za-z0-9_-]+ (same rule as plugin tools). MCP names may contain colons/slashes — normalize. */
function sanitizeToolName(name) {
    const cleaned = (name || "").replace(/[^A-Za-z0-9_-]/g, "_");
    return cleaned || "mcp_tool";
}
/** MCP server manager: owns multi-server lifecycle and aggregates tools. */
export class McpBridge {
    dataDir;
    log;
    opts;
    clients = [];
    tools = [];
    constructor(dataDir, log = () => { }, opts = {}) {
        this.dataDir = dataDir;
        this.log = log;
        this.opts = opts;
    }
    /** Read config and start every server (per-server fail-fast: a single failure is logged and does not take the others down). */
    async load() {
        const cfg = optsOverrideOrRead(this.opts.specOverride, this.dataDir);
        await Promise.all(Object.entries(cfg.servers).map(async ([name, spec]) => {
            try {
                const client = new McpClient(name, spec, this.log);
                await client.start();
                this.clients.push(client);
                for (const t of client.getTools())
                    this.tools.push(adaptMcpTool(name, t, client));
            }
            catch (err) {
                this.log(`[mcp] server "${name}" failed to start:`, err instanceof Error ? err.message : err);
            }
        }));
    }
    getTools() {
        return this.tools;
    }
    hasServers() {
        return this.clients.length > 0;
    }
    dispose() {
        for (const c of this.clients)
            c.close();
        this.clients = [];
        this.tools = [];
    }
}
function optsOverrideOrRead(specOverride, dataDir) {
    if (specOverride && specOverride.length > 0) {
        const servers = {};
        for (const o of specOverride)
            servers[o.name] = o.spec;
        return { servers };
    }
    return readMcpConfig(dataDir);
}
