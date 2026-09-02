// clear_provider_api_key — built-in provider key clearing (zero token).
//
// 1. set_provider_api_key writes { provider: { type: "api_key", key } } to
//    <agentDir>/auth.json
// 2. clear_provider_api_key removes the entry + drops the runtime override
// 3. clearing a provider with nothing stored → info notice, no crash
//
// Usage: npm run build && node tests/clear-provider-key-test.mjs [port]
import WebSocket from "ws";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

const PORT = Number(process.argv[2] || 8959);
const base = mkdtempSync(join(tmpdir(), "pi-web-clearkey-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const NODE = realpathSync(process.execPath);
const server = spawn(NODE, ["dist/server/index.js"], {
	env: {
		...process.env,
		PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "ignore", "ignore"],
	windowsHide: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ FAIL ${name}${extra ? ` — ${extra}` : ""}`);
	}
};

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		ws.on("message", (d) => this.received.push(JSON.parse(d.toString())));
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	async waitForNotice(substr, timeout = 20000) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const m = this.received[i];
				if (m.type === "notice" && m.text?.includes(substr)) {
					this.received.splice(i, 1);
					return m;
				}
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for notice "${substr}"`);
	}
}

async function connect() {
	for (let i = 0; i < 60; i++) {
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
			await new Promise((res, rej) => {
				ws.on("open", res);
				ws.on("error", rej);
			});
			return new Client(ws);
		} catch {
			await sleep(500);
		}
	}
	throw new Error("server not ready");
}

const authPath = join(agentDir, "auth.json");
const readAuth = () => {
	try {
		return JSON.parse(readFileSync(authPath, "utf8"));
	} catch {
		return {};
	}
};

let clean = false;
function cleanup() {
	if (clean) return;
	clean = true;
	try {
		process.kill(server.pid, "SIGTERM");
	} catch {
		/* gone */
	}
}
process.on("exit", cleanup);

try {
	await sleep(1000);
	const c = await connect();
	c.send({ type: "hello", clientId: "clear-key-test" });
	await c.waitForNotice("", 1).catch(() => {});
	// do not hard-wait for ready — start immediately; notice matching has its own timeout

	// 1) store a key (deepseek is a built-in static catalog provider, safe offline)
	c.send({ type: "set_provider_api_key", provider: "deepseek", apiKey: "sk-test-123" });
	await c.waitForNotice("Saved API key", 30000);
	check("key stored in auth.json", readAuth().deepseek?.key === "sk-test-123");

	// 2) clear
	c.send({ type: "clear_provider_api_key", provider: "deepseek" });
		await c.waitForNotice("Cleared the saved key", 30000);
	check("auth.json entry removed", !readAuth().deepseek);

	// 3) clear again → friendly notice, no crash
	c.send({ type: "clear_provider_api_key", provider: "deepseek" });
	const n = await c.waitForNotice("no saved API key", 15000);
	check("second clear → friendly notice", !!n);

	// 4) other entries in auth.json are unaffected
	c.send({ type: "set_provider_api_key", provider: "openai", apiKey: "sk-oa" });
	await c.waitForNotice("Saved API key", 30000);
	c.send({ type: "set_provider_api_key", provider: "anthropic", apiKey: "sk-an" });
	await c.waitForNotice("Saved API key", 30000);
	c.send({ type: "clear_provider_api_key", provider: "openai" });
	await c.waitForNotice("Cleared the saved key", 30000);
	const auth = readAuth();
	check("other entries untouched", !auth.openai && auth.anthropic?.key === "sk-an");

	console.log(`\n${passed} passed, ${failed} failed`);
} catch (err) {
	failed++;
	console.error("test crashed:", err);
} finally {
	cleanup();
	await sleep(500);
	process.exit(failed === 0 ? 0 : 1);
}
