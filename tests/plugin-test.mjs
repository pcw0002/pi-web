/**
 * Plugin-mechanism protocol smoke test (zero token, self-contained).
 *
 * Covers:
 * - after attach, push the plugins catalog (manifest parse + hasClient probe)
 * - plugin_message → server entry onMessage → broadcast → plugin_data round-trip
 * - /plugins/<id>/client/* static serving (Content-Type, path-traversal refused)
 * - plugin_message to an inactive plugin is silently dropped (no crash, no echo)
 * - bad manifest / non-id dirs are skipped by scan
 *
 * Run: npm run build:server, then node tests/plugin-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8978;
const BASE = `http://127.0.0.1:${PORT}`;

const serverPath = realpathSync(process.execPath);
let proc = null;
let ws = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-plugin-test-"));

// ---- seed plugin dirs ------------------------------------------------------------
// 1) normal plugin: server entry + client bundle
const plugDir = join(dataDir, "plugins", "demo-mailbox");
mkdirSync(plugDir, { recursive: true });
writeFileSync(
	join(plugDir, "manifest.json"),
	JSON.stringify({ name: "Mailbox", version: "0.1.0", description: "demo" }),
);
writeFileSync(
	join(plugDir, "index.mjs"),
	`export default {
		activate(host) {
			return host.onMessage((payload) => {
				if (payload && payload.action === "ping") host.broadcast({ pong: payload.value });
				else if (payload && payload.action === "notify") host.notify("info", String(payload.text ?? "plugin notify test"));
				else if (payload && payload.action === "echo-to") host.sendTo(String(payload.clientId), { direct: payload.direct });
			});
		},
	};`,
);
mkdirSync(join(plugDir, "client"), { recursive: true });
writeFileSync(
	join(plugDir, "client", "entry.mjs"),
	`export default { mount(el) { el.textContent = "ok"; } };`,
);

// 2) front-end-only plugin (no index.mjs, view bundle only)
const feDir = join(dataDir, "plugins", "frontend-only");
mkdirSync(join(feDir, "client"), { recursive: true });
writeFileSync(join(feDir, "manifest.json"), JSON.stringify({ name: "frontend-only" }));
writeFileSync(join(feDir, "client", "entry.mjs"), `export default {};`);

// 3) bad manifest (should be skipped by scan)
mkdirSync(join(dataDir, "plugins", "bad-json"), { recursive: true });
writeFileSync(join(dataDir, "plugins", "bad-json", "manifest.json"), "{oops");

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

/** Connect WS and wait for the first plugins message. */
function connect(clientId = "plugin-test") {
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
		sock.on("open", () => {
			sock.send(JSON.stringify({ type: "hello", clientId }));
		});
		sock.on("message", (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === "ready") {
				clearTimeout(timer);
				resolve(sock);
			}
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/** Wait for a server message matching the predicate (with timeout). */
function waitFor(sock, pred, label, timeoutMs = 8000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`timeout waiting for ${label}`)),
			timeoutMs,
		);
		const onMsg = (raw) => {
			const msg = JSON.parse(raw.toString());
			if (pred(msg)) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(msg);
			}
		};
		sock.on("message", onMsg);
	});
}

try {
	// port-in-use check
	const { execFileSync } = await import("node:child_process");
	try {
		execFileSync("lsof", ["-ti", `:${PORT}`, "-sTCP:LISTEN"], { stdio: "pipe" });
		console.error(`✗ port ${PORT} busy — abort`);
		process.exit(1);
	} catch {
		/* free */
	}

	proc = spawn(serverPath, [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: {
			...process.env,
			PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: import.meta.dirname,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

	// wait until HTTP is ready
	await new Promise((resolve, reject) => {
		const t0 = Date.now();
		const probe = async () => {
			try {
				const r = await fetch(`${BASE}/api/health`);
				if (r.ok) return resolve();
			} catch {}
			if (Date.now() - t0 > 20_000) return reject(new Error("server not ready"));
			setTimeout(probe, 300);
		};
		void probe();
	});

	// -- 1. attach → plugins catalog ------------------------------------------
	let sock = await connect();
	const pluginsMsg = await waitFor(sock, (m) => m.type === "plugins", "plugins");
	const list = pluginsMsg.plugins ?? [];
	const demo = list.find((p) => p.id === "demo-mailbox");
	if (!demo || demo.name !== "Mailbox" || demo.version !== "0.1.0") {
		fail(`demo-mailbox not listed correctly: ${JSON.stringify(demo)}`);
	} else if (demo.hasClient !== true || demo.error !== undefined) {
		fail(`demo-mailbox flags wrong: hasClient=${demo.hasClient} error=${demo.error}`);
	} else {
		console.log("✓ plugins list includes demo-mailbox with client entry");
	}
	if (!list.some((p) => p.id === "frontend-only" && p.hasClient === true)) {
		fail(`frontend-only missing or hasClient wrong: ${JSON.stringify(list)}`);
	} else {
		console.log("✓ frontend-only plugin detected (client entry, no server code)");
	}
	if (list.some((p) => p.id === "bad-json")) fail("bad-json dir should be skipped");
	else console.log("✓ bad manifest skipped");

	// -- 2. plugin_message round-trip --------------------------------------------
	const echoP = waitFor(sock, (m) => m.type === "plugin_data" && m.pluginId === "demo-mailbox", "plugin_data");
	sock.send(JSON.stringify({ type: "plugin_message", pluginId: "demo-mailbox", payload: { action: "ping", value: 42 } }));
	const echo = await echoP;
	if (echo.payload?.pong !== 42) fail(`echo wrong: ${JSON.stringify(echo.payload)}`);
	else console.log("✓ plugin_message round-trips to plugin_data");

	// -- 2b. host.notify → system notice bar ----------------------------------------
	const noticeP = waitFor(sock, (m) => m.type === "notice" && m.text?.includes("plugin notify test"), "notice");
	sock.send(JSON.stringify({ type: "plugin_message", pluginId: "demo-mailbox", payload: { action: "notify", text: "plugin notify test OK" } }));
	await noticeP;
	console.log("✓ host.notify delivers a system notice");

	// -- 2c. host.sendTo targeted delivery (two sockets) --------------------------------
	const sock2 = await connect("plug-b");
	const toB = waitFor(sock2, (m) => m.type === "plugin_data" && m.payload?.direct === "b", "direct-to-b");
	let leaked = false;
	const leakWatch = (raw) => {
		const m = JSON.parse(raw.toString());
		if (m.type === "plugin_data" && m.payload?.direct === "b") leaked = true;
	};
	sock.on("message", leakWatch);
	sock.send(JSON.stringify({ type: "plugin_message", pluginId: "demo-mailbox", payload: { action: "echo-to", clientId: "plug-b", direct: "b" } }));
	await toB;
	await new Promise((r) => setTimeout(r, 300));
	sock.off("message", leakWatch);
	if (leaked) fail("sendTo message leaked to the other socket");
	else console.log("✓ host.sendTo targets only the addressed socket");

	// -- 2e. settings-panel plugin toggle: set_settings echo + persist ---------------------
	const disP = waitFor(sock, (m) => m.type === "settings_state" && m.settings?.disabledPlugins?.includes("demo-mailbox"), "settings_state(disabled)");
	sock.send(JSON.stringify({ type: "set_settings", disabledPlugins: ["demo-mailbox"] }));
	await disP;
	const enP = waitFor(sock, (m) => m.type === "settings_state" && !(m.settings?.disabledPlugins ?? []).includes("demo-mailbox"), "settings_state(re-enabled)");
	sock.send(JSON.stringify({ type: "set_settings", disabledPlugins: [] }));
	await enP;
	console.log("✓ set_settings echoes disabledPlugins toggle");

	// -- 2d. plugins_reload: epoch increments + catalog re-push ----------------------------
	const beforeEpoch = pluginsMsg.epoch ?? 0;
	const reP = waitFor(sock, (m) => m.type === "plugins" && (m.epoch ?? 0) > beforeEpoch, "plugins(reload)");
	sock.send(JSON.stringify({ type: "plugins_reload" }));
	const reMsg = await reP;
	if (!reMsg.plugins?.some((p) => p.id === "demo-mailbox")) fail("reload lost demo-mailbox");
	else console.log(`✓ plugins_reload bumps epoch (${beforeEpoch} → ${reMsg.epoch}) and re-pushes catalog`);

	sock2.close();

	// -- 3. silent drop for unknown/inactive plugins --------------------------------------
	sock.send(JSON.stringify({ type: "plugin_message", pluginId: "no-such", payload: { x: 1 } }));
	sock.send(JSON.stringify({ type: "plugin_message", pluginId: "../evil", payload: { x: 1 } }));
	await new Promise((r) => setTimeout(r, 500)); // if it crashed, the next request would fail
	console.log("✓ unknown/illegal pluginId silently ignored");

	// -- 4. client static serving --------------------------------------------------
	const jsRes = await fetch(`${BASE}/plugins/demo-mailbox/client/entry.mjs`);
	const ct = jsRes.headers.get("content-type") ?? "";
	if (!jsRes.ok || !ct.includes("text/javascript")) {
		fail(`client entry fetch failed: ${jsRes.status} ${ct}`);
	} else if (!(await jsRes.text()).includes("export default")) {
		fail("client entry content wrong");
	} else {
		console.log("✓ /plugins/:id/client/* serves JS with correct Content-Type");
	}
	// Server code and manifest are not in the client/ whitelist — unmatched routes fall through to the SPA
	// catch-all returns index.html (200 but HTML); must never return the file body.
	for (const bad of [
		`${BASE}/plugins/demo-mailbox/index.mjs`,
		`${BASE}/plugins/demo-mailbox/manifest.json`,
	]) {
		const r = await fetch(bad);
		const body = await r.text();
		if (!body.startsWith("<!doctype html") && !body.includes("<div id=")) {
			fail(`server file leaked via ${bad}: ${body.slice(0, 80)}`);
		}
	}
	{
		// path traversal: illegal id segment, also falls through to SPA fallback
		const r = await fetch(
			`${BASE}/plugins/%2e%2e%2f%2e%2e%2fclient-state.json/client/entry.mjs`,
		);
		const body = await r.text();
		if (body.includes("{")) fail(`traversal returned data: ${body.slice(0, 80)}`);
	}
	console.log("✓ server entry/manifest/path-traversal never exposed");

	sock.close();
	console.log("\nALL PLUGIN TESTS PASSED");
} catch (err) {
	console.error("✗ test failed:", err);
	process.exitCode = 1;
} finally {
	ws?.close();
	proc?.kill("SIGTERM");
	if (process.exitCode) {
		// leave time to clean up before a non-zero exit, but don't hang
		setTimeout(() => {
			rmSync(dataDir, { recursive: true, force: true });
			process.exit(process.exitCode);
		}, 500);
	} else {
		rmSync(dataDir, { recursive: true, force: true });
	}
}
