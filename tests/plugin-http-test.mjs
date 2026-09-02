/**
 * Plugin HTTP-route protocol test (zero token, self-contained).
 *
 * host.route("GET"/"POST", path, handler) is exposed as /plugins-api/<id><path>:
 * covers GET/POST hits, unknown plugin 404, unregistered path 404, throwing handler 500,
 * route gone after unregister.
 *
 * Run: npm run build:server, then node tests/plugin-http-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8981;
const BASE = `http://127.0.0.1:${PORT}`;

const serverPath = realpathSync(process.execPath);
let proc = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-http-plugin-"));

const plugDir = join(dataDir, "plugins", "api");
mkdirSync(plugDir, { recursive: true });
writeFileSync(join(plugDir, "manifest.json"), JSON.stringify({ name: "api", version: "0.1.0" }));
writeFileSync(
	join(plugDir, "index.mjs"),
	`export default {
	activate(host) {
		host.route("GET", "/ping", (req, res) => {
			res.type("application/json").send({ pong: true, q: req.query?.echo ?? "" });
		});
		host.route("POST", "/submit", (req, res) => {
			res.json({ got: req.body ?? null });
		});
		const off = host.route("GET", "/gone", (_req, res) => res.send("bye"));
		off(); // register then immediately unregister → should 404
		host.route("GET", "/boom", () => { throw new Error("boom"); });
	},
};`,
);

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

async function connectWs() {
	return new Promise((resolve2, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("ws connect timeout")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId: "http-test" })));
		sock.on("message", (raw) => {
			if (JSON.parse(raw.toString()).type === "ready") {
				clearTimeout(timer);
				resolve2(sock);
			}
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

try {
	proc = spawn(serverPath, [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: { ...process.env, PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: import.meta.dirname },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

	await new Promise((resolve2, reject) => {
		const t0 = Date.now();
		const ping = async () => {
			try {
				if ((await fetch(`${BASE}/api/health`)).ok) return resolve2();
			} catch {}
			if (Date.now() - t0 > 20_000) return reject(new Error("server not ready"));
			setTimeout(ping, 300);
		};
		void ping();
	});

	// WS attach triggers plugin activation (routes mount with it)
	const sock = await connectWs();
	await new Promise((r) => setTimeout(r, 800));

	// -- GET hit + query ------------------------------------------------------
	let r = await fetch(`${BASE}/plugins-api/api/ping?echo=hi`);
	if (r.status !== 200 || (await r.json()).pong !== true) fail(`GET /ping unexpected: ${r.status}`);
	else console.log('✓ GET /plugins-api/api/ping → {"pong":true}');

	// -- POST + express.json body ---------------------------------------------
	r = await fetch(`${BASE}/plugins-api/api/submit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ x: 42 }),
	});
	if (r.status !== 200 || (await r.json()).got?.x !== 42) fail(`POST /submit unexpected: ${r.status}`);
	else console.log("✓ POST body parsed and forwarded to handler");

	// -- unregistered path 404 / unregistered-after-off route 404 --------------------------------------
	r = await fetch(`${BASE}/plugins-api/api/nope`);
	if (r.status !== 404) fail(`unregistered path should 404, got ${r.status}`);
	r = await fetch(`${BASE}/plugins-api/api/gone`);
	if (r.status !== 404) fail(`route after unregister should 404, got ${r.status}`);
	console.log("✓ unregistered/unmounted route → 404");

	// -- unknown plugin 404 / throwing handler 500 ----------------------------------------
	r = await fetch(`${BASE}/plugins-api/nosuch/ping`);
	if (r.status !== 404) fail(`unknown plugin should 404, got ${r.status}`);
	r = await fetch(`${BASE}/plugins-api/api/boom`);
	if (r.status !== 500) fail(`throwing handler should 500, got ${r.status}`);
	console.log("✓ unknown plugin → 404; throwing handler → 500");

	sock.close();
} catch (err) {
	fail(err?.stack ?? String(err));
} finally {
	if (proc?.pid) {
		try {
			process.kill(proc.pid, "SIGTERM");
		} catch {}
	}
	await new Promise((r2) => setTimeout(r2, 600));
	rmSync(dataDir, { recursive: true, force: true });
}
if (!process.exitCode) console.log("\nall ok");
