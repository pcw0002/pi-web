/**
 * MCP tool-bridge unit tests (pure Node, millisecond-scale, zero token, no ports):
 * Instantiates McpClient against a local fixture server and runs real JSON-RPC
 * handshake + tool calls.
 *
 * Covers:
 *  - handshake (initialize → initialized → tools/list)
 *  - tool calls echo / add (valid args → result)
 *  - fail tool → isError → throws
 *  - unknown tool / top-level McpBridge.load + getTools adapter
 *  - slow timeout (MCP_SLOW_MS injects a short delay)
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpBridge, McpClient } from "../../server/mcp-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Fixture server: run as .mjs directly with node
const FIXTURE = resolve(__dirname, "../fixtures/mcp-echo-server.mjs");

const clients: McpClient[] = [];
function client() {
	const c = new McpClient("test-srv", { command: process.execPath, args: [FIXTURE] }, () => {});
	clients.push(c);
	return c;
}

afterEach(() => {
	for (const c of clients) {
		try {
			c.close();
		} catch {
			/* already closed */
		}
	}
	clients.length = 0;
});

describe("McpClient handshake and tools", () => {
	it("start handshake + lists 4 tools", async () => {
		const c = client();
		await c.start();
		const names = c.getTools().map((t) => t.name);
		expect(names).toEqual(["echo", "add", "fail", "slow"]);
	});

	it("echo returns args as-is; add sums", async () => {
		const c = client();
		await c.start();
		const echo = (await c.call("echo", { msg: "hi", n: 42 })) as { content: string };
		expect(JSON.parse(echo.content)).toEqual({ msg: "hi", n: 42 });
		const add = (await c.call("add", { a: 3, b: 5 })) as { content: string };
		expect(JSON.parse(add.content)).toBe(8);
	});

	it("fail tool → isError → throws", async () => {
		const c = client();
		await c.start();
		await expect(c.call("fail", {})).rejects.toThrow(/boom/);
	});

	it("unknown tool → isError throws", async () => {
		const c = client();
		await c.start();
		await expect(c.call("nope", {})).rejects.toThrow(/unknown tool/);
	});
});

describe("McpBridge aggregation adapter", () => {
	it("load starts and adapts into PluginAgentTool (execute forwarded via MCP)", async () => {
		const bridge = new McpBridge("/nonexistent", () => {}, {
			specOverride: [{ name: "csrv", spec: { command: process.execPath, args: [FIXTURE] } }],
		});
		await bridge.load();
		const tools = bridge.getTools();
		expect(tools.length).toBe(4);
		const add = tools.find((t) => t.name === "add")!;
		expect(add.label).toContain("csrv");
		expect(typeof add.execute).toBe("function");
		// Call execute directly (no LLM)
		const res = (await add.execute("id", { a: 10, b: 20 })) as { content: string };
		expect(JSON.parse(res.content)).toBe(30);
		bridge.dispose();
	});

	it("no config / all failed → no tools", async () => {
		const bridge = new McpBridge("/nonexistent", () => {}, {
			specOverride: [{ name: "bad", spec: { command: "definitely-not-a-real-cmd-xyz", args: [] } }],
		});
		await bridge.load();
		expect(bridge.getTools().length).toBe(0);
		bridge.dispose();
	});
});

describe("timeout", () => {
	it("slow exceeding injected timeout → throws timeout error", async () => {
		process.env.MCP_SLOW_MS = "300";
		const c = client();
		await c.start();
		// call with ~80ms short timeout
		await expect(c.call("slow", {}, 80)).rejects.toThrow(/timed out/);
	});
});
