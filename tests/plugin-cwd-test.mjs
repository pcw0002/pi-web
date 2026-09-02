/**
 * Plugin workspace-follow (cwd-follow) protocol test (zero token, self-contained).
 *
 * Covers the whole chain: WS set_cwd → ClientSession.onCwdChanged →
 * AgentService.onClientCwdChanged → PluginManager.notifyCwd →
 * plugin onCwdChange hook → plugin_data {kind:"workspace"} broadcast.
 * This is the server-side source of truth for vscode-editor "dir follows project switch".
 *
 * Run: npm run build:server, then node tests/plugin-cwd-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const PORT = 8989;
const BASE = `http://127.0.0.1:${PORT}`;

const serverPath = realpathSync(process.execPath);
let proc = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-cwd-plugin-"));
// Two real project dirs: start workspace + switch target
const dirA = mkdtempSync(join(tmpdir(), "cwd-proj-a-"));
const dirB = mkdtempSync(join(tmpdir(), "cwd-proj-b-"));

// ---- probe plugin: record cwd at activate, register onCwdChange to broadcast workspace ----------
const plugDir = join(dataDir, "plugins", "probe");
mkdirSync(plugDir, { recursive: true });
writeFileSync(
	join(plugDir, "manifest.json"),
	JSON.stringify({ name: "cwd-probe", version: "0.1.0" }),
);
writeFileSync(
	join(plugDir, "index.mjs"),
	`globalThis.__cwdProbe = { activatedCwd: null, seen: [] };
export default {
	activate(host) {
		globalThis.__cwdProbe.activatedCwd = host.cwd;
		host.broadcast({ kind: "workspace", root: host.cwd }); // push current root on activate
		return host.onCwdChange((cwd) => {
			globalThis.__cwdProbe.seen.push(cwd);
			host.broadcast({ kind: "workspace", root: cwd });
		});
	},
};`,
);

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

// Collect workspace broadcasts from the first message — the initial one arrives between ready/plugins,
// so we cannot wait by message type in segments (would miss early arrivals).
const workspaces = []; // resolve()'d root paths, in arrival order

function handleMessage(raw) {
	const msg = JSON.parse(raw.toString());
	if (
		msg.type === "plugin_data" &&
		msg.pluginId === "probe" &&
		msg.payload?.kind === "workspace"
	) {
		workspaces.push(resolve(String(msg.payload.root)));
	}
	return msg;
}

function connect(clientId) {
	return new Promise((resolve2, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId })));
		sock.on("message", (raw) => {
			if (handleMessage(raw).type === "ready") {
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

/** Wait until the i-th (0-based) workspace broadcast has been collected. */
function nextWorkspace(i, label, timeoutMs = 10_000) {
	return new Promise((resolve2, reject) => {
		const t0 = Date.now();
		const poll = () => {
			if (workspaces.length > i) return resolve2(workspaces[i]);
			if (Date.now() - t0 > timeoutMs)
				return reject(new Error(`timeout waiting for ${label}`));
			setTimeout(poll, 50);
		};
		poll();
	});
}

try {
	proc = spawn(serverPath, [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: {
			...process.env,
			PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: dirA,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

	await new Promise((resolve2, reject) => {
		const t0 = Date.now();
		const ping = async () => {
			try {
				const r = await fetch(`${BASE}/api/health`);
				if (r.ok) return resolve2();
			} catch {}
			if (Date.now() - t0 > 20_000) return reject(new Error("server not ready"));
			setTimeout(ping, 300);
		};
		void ping();
	});

	// -- attach: plugin broadcasts the server start dir on activate ----------------------------------
	const sock = await connect("cwd-test");
	const first = await nextWorkspace(0, "initial workspace broadcast");
	if (first !== resolve(dirA)) {
		fail(`activate-broadcast root wrong: ${first} ≠ ${resolve(dirA)}`);
	} else {
		console.log(`✓ on attach the plugin got the server workspace ${first}`);
	}

	// -- set_cwd → workspace broadcast follows -----------------------------------------
	sock.send(JSON.stringify({ type: "set_cwd", path: dirB }));
	const second = await nextWorkspace(1, "workspace after set_cwd");
	if (second !== resolve(dirB)) {
		fail(`plugin root did not follow after project switch: ${second} ≠ ${resolve(dirB)}`);
	} else {
		console.log(`✓ after set_cwd the plugin received new root ${second}`);
	}

	// repeating set_cwd on the same path must not broadcast again (idempotent)
	const countBefore = workspaces.length;
	sock.send(JSON.stringify({ type: "set_cwd", path: dirB }));
	await new Promise((r) => setTimeout(r, 1200));
	if (workspaces.length > countBefore) {
		fail(`repeat set_cwd on the same path triggered extra broadcasts: ${workspaces.slice(countBefore).join(", ")}`);
	} else {
		console.log("✓ repeat set_cwd on the same path is idempotent (no extra broadcast)");
	}

	// seen recorded by the activate hook should match broadcasts (internal check)
	sock.close();
} catch (err) {
	fail(err?.stack ?? String(err));
} finally {
	if (proc?.pid) {
		try {
			process.kill(proc.pid, "SIGTERM");
		} catch {}
	}
	// wait for the port to free before deleting the temp dir (win file handles release slowly)
	await new Promise((r) => setTimeout(r, 600));
	for (const d of [dataDir, dirA, dirB]) rmSync(d, { recursive: true, force: true });
}
if (!process.exitCode) console.log("\nall ok");
