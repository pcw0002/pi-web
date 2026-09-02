#!/usr/bin/env node
/**
 * MCP test fixture server — minimal NDJSON JSON-RPC peer for mcp-bridge.
 * Tools: echo (echoes parameters), add (a+b), fail (isError tool),
 * slow (returns after a delay, for timeout checks).
 * Usage: node mcp-echo-server.mjs [delay-resp-ms]
 */
import { createInterface } from "node:readline";

const RESP_DELAY = Number(process.argv[2] ?? 0);

const TOOLS = [
	{
		name: "echo",
		description: "echo the incoming parameters object as-is",
		inputSchema: { type: "object", properties: { msg: { type: "string" } } },
	},
	{
		name: "add",
		description: "add two numbers",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
	},
	{ name: "fail", description: "always fails (isError)", inputSchema: { type: "object" } },
	{ name: "slow", description: "sleep then return after resp-delay", inputSchema: { type: "object" } },
];

function reply(msg) {
	process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
	const raw = line.trim();
	if (!raw) return;
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	// notification (no id)
	if (msg.id === undefined) return;

	if (msg.method === "initialize") {
		return finish(msg.id, {
			protocolVersion: "2025-03-26",
			capabilities: { tools: {} },
			serverInfo: { name: "mcp-echo", version: "1.0.0" },
		});
	}
	if (msg.method === "tools/list") {
		return finish(msg.id, { tools: TOOLS });
	}
	if (msg.method === "tools/call") {
		const { name, arguments: args } = msg.params ?? {};
		if (name === "echo") return finish(msg.id, { content: [{ type: "text", text: JSON.stringify(args ?? {}) }] });
		if (name === "add") {
			const s = (args?.a ?? 0) + (args?.b ?? 0);
			return finish(msg.id, { content: [{ type: "text", text: String(s) }] });
		}
		if (name === "fail") {
			return finish(msg.id, {
				content: [{ type: "text", text: "boom: known failure" }],
				isError: true,
			});
		}
		if (name === "slow") {
			// delay from process args; default 5000ms (tests inject a shorter window → timeout)
			const d = Number(process.env.MCP_SLOW_MS ?? 5000);
			return setTimeout(() => finish(msg.id, { content: [{ type: "text", text: "slow done" }] }), d);
		}
		return finish(msg.id, {
			content: [{ type: "text", text: `unknown tool: ${name}` }],
			isError: true,
		});
	}
	if (msg.method === "shutdown") {
		return finish(msg.id, null);
	}
	return finish(msg.id, null);
});

function finish(id, result) {
	if (RESP_DELAY) setTimeout(() => reply({ jsonrpc: "2.0", id, result }), RESP_DELAY);
	else reply({ jsonrpc: "2.0", id, result });
}

process.stdin.resume();
