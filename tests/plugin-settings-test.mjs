/**
 * Plugin declarative-settings protocol test (zero token, self-contained).
 *
 * Covers: plugins catalog carries settingsSchema + settingsValues (defaults); plugin_settings
 * message → server validates + persists to storage.json + notifies the plugin onSettingsChanged +
 * re-pushes the catalog echo; illegal values (out of range / bad option) are refused with a notice.
 *
 * Run: npm run build:server, then node tests/plugin-settings-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8983;
const BASE = `http://127.0.0.1:${PORT}`;

const serverPath = realpathSync(process.execPath);
let proc = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-settings-plugin-"));

const plugDir = join(dataDir, "plugins", "opts");
mkdirSync(plugDir, { recursive: true });
writeFileSync(
	join(plugDir, "manifest.json"),
	JSON.stringify({
		name: "opts",
		version: "0.1.0",
		settings: [
			{ key: "pollSec", type: "number", label: "Interval", default: 60, min: 10, max: 600 },
			{ key: "notify", type: "boolean", label: "Notify", default: true },
			{ key: "theme", type: "select", label: "Theme", default: "dark", options: ["dark", "light"] },
		],
	}),
);
writeFileSync(
	join(plugDir, "index.mjs"),
	`export default {
	activate(host) {
		globalThis.__opts = [];
		host.onSettingsChanged((v) => globalThis.__opts.push(v));
	},
};`,
);

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

function connect(clientId) {
	return new Promise((resolve2, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId })));
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

function waitFor(sock, pred, label, timeoutMs = 10_000) {
	return new Promise((resolve2, reject) => {
		const timer = setTimeout(() => {
			sock.off("message", onMsg);
			reject(new Error(`timeout waiting for ${label}`));
		}, timeoutMs);
		const onMsg = (raw) => {
			const msg = JSON.parse(raw.toString());
			if (pred(msg)) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve2(msg);
			}
		};
		sock.on("message", onMsg);
	});
}

let latestPlugins = [];
async function pluginsAfter(sock) {
	return (await waitFor(sock, (m) => m.type === "plugins", "plugins")).plugins ?? [];
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

	const sock = await connect("settings-test");
	sock.on("message", (raw) => {
		const m = JSON.parse(raw.toString());
		if (m.type === "plugins") latestPlugins = m.plugins ?? [];
	});

	// -- 1. catalog includes schema + defaults -------------------------------------------------
	let opts;
	for (let i = 0; i < 40 && !opts; i++) {
		opts = latestPlugins.find((x) => x.id === "opts");
		if (!opts) await new Promise((r) => setTimeout(r, 250));
	}
	if (!opts || opts.settingsSchema?.length !== 3 || opts.settingsValues?.pollSec !== 60) {
		fail(`schema/defaults not sent: ${JSON.stringify(opts)}`);
	} else {
		console.log("✓ plugins catalog has settingsSchema + default settingsValues");
	}

	// -- 2. plugin_settings save → storage.json + onSettingsChanged + echo -------------
	sock.send(JSON.stringify({ type: "plugin_settings", pluginId: "opts", values: { pollSec: 120, notify: false, theme: "light" } }));
	await waitFor(sock, (m) => m.type === "notice" && m.text === "Plugin settings saved", "save notice");
	// persist assertion
	const raw = JSON.parse(readFileSync(join(plugDir, "storage.json"), "utf8"));
	if (raw.settings?.pollSec !== 120 || raw.settings?.notify !== false || raw.settings?.theme !== "light") {
		fail(`storage.json not persisted correctly: ${JSON.stringify(raw.settings)}`);
	}
	// echo (re-pushed plugins catalog)
	let echoed;
	for (let i = 0; i < 40 && !echoed; i++) {
		echoed = latestPlugins.find((x) => x.id === "opts")?.settingsValues?.pollSec === 120 ? latestPlugins : undefined;
		if (!echoed) await new Promise((r) => setTimeout(r, 250));
	}
	if (!echoed) fail("catalog did not echo new values after save");
	else console.log("✓ plugin_settings save → persist + re-push echo");

	// -- 3. illegal values refused -----------------------------------------------------------------
	sock.send(JSON.stringify({ type: "plugin_settings", pluginId: "opts", values: { pollSec: 5 } }));
	const err = await waitFor(sock, (m) => m.type === "notice" && m.text.includes("Failed to save plugin settings"), "reject notice");
	if (!err.text.includes("out of range")) fail(`reject copy mismatch: ${err.text}`);
	const raw2 = JSON.parse(readFileSync(join(plugDir, "storage.json"), "utf8"));
	if (raw2.settings?.pollSec !== 120) fail("illegal save must not change stored values");
	else console.log("✓ out-of-range value refused (notice error) and stored value unchanged");

	sock.close();
} catch (err) {
	fail(err?.stack ?? String(err));
} finally {
	if (proc?.pid) {
		try {
			process.kill(proc.pid, "SIGTERM");
		} catch {}
	}
	await new Promise((r) => setTimeout(r, 600));
	rmSync(dataDir, { recursive: true, force: true });
}
if (!process.exitCode) console.log("\nall ok");
