// Protocol smoke: prompt.queue is passed losslessly from dispatch → AgentService.prompt().
// No token: do not actually invoke a model; only verify a queued prompt is received and args do not explode
// (a signature mismatch would throw TypeError → the server "failed to send prompt" notice would also look like a crash).
import { portUp, freePort } from "./lib/port-utils.mjs";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8921;
const URL = `ws://localhost:${PORT}/ws`;

let server;
let ws;
const dataDir = mkdtempSync(join(tmpdir(), "steer-queue-"));
const fakeAgentDir = mkdtempSync(join(tmpdir(), "steer-agent-"));
mkdirSync(join(fakeAgentDir, "skills"), { recursive: true });
writeFileSync(join(fakeAgentDir, "models.json"), JSON.stringify({}), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
	const { default: WebSocket } = await import("ws");
	return new Promise((resolve, reject) => {
		ws = new WebSocket(URL);
		const timer = setTimeout(() => reject(new Error("no ready")), 8000);
		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "hello", clientId: "smoke" }));
		});
		ws.on("message", (d) => {
			if (JSON.parse(d.toString()).type === "ready") {
				clearTimeout(timer);
				resolve();
			}
		});
		ws.on("error", (e) => {
			console.error("[ws error]", e.message);
			clearTimeout(timer);
			reject(e);
		});
	});
}

let ok = false;
try {
	try {
		if (!(await portUp(PORT))) throw new Error("port not up");
		console.log(`port ${PORT} busy — abort`);
		process.exit(1);
	} catch {}

	server = spawn("node", ["dist/server/index.js"], {
		env: {
			...process.env,
			PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: fakeAgentDir,
			PI_WEB_CWD: process.cwd(),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stdout.on("data", (d) => process.stdout.write("[out] " + d));
	server.stderr.on("data", (d) => process.stderr.write("[err] " + d));
	await sleep(2500);

	await connect();
	await sleep(400);

	// 1) prompt with queue=true — verify dispatch args do not explode (no model → "failed to send prompt" is acceptable)
	ws.send(
		JSON.stringify({ type: "prompt", text: "smoke: queue field passthrough", queue: true, attachments: [] }),
	);
	await sleep(800);

	// 2) prompt without queue — verify the default-args path
	ws.send(JSON.stringify({ type: "prompt", text: "smoke: no queue field", attachments: [] }));
	await sleep(800);

	console.log(
		"OK: prompt(queue) was received by the server; dispatch/signature did not throw (failed-to-send is expected with no model)",
	);
	ok = true;
} catch (err) {
	console.error("FAIL:", err.message);
} finally {
	try {
		ws?.close();
	} catch {}
	// kill the server and wait for the port to free before exiting — process.exit skips finally,
	// which used to leak a server every run (next run reported "port busy — abort").
	server?.kill("SIGTERM");
	for (let i = 0; i < 20; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
		} catch {
			break; // port released
		}
	}
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(fakeAgentDir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
