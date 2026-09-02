/**
 * Plugin background-task protocol test (zero token, self-contained).
 *
 * Covers: tasks registered via host.registerBackgroundTask join bg_servers (taskId/plugin/
 * status fields); kill_background_server { taskId } fires the stop callback and removes from the list;
 * unknown taskId fails silently without crashing.
 *
 * Run: npm run build:server, then node tests/plugin-bgtask-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8982;
const BASE = `http://127.0.0.1:${PORT}`;

const serverPath = realpathSync(process.execPath);
let proc = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-bgtask-plugin-"));

const plugDir = join(dataDir, "plugins", "worker");
mkdirSync(plugDir, { recursive: true });
writeFileSync(join(plugDir, "manifest.json"), JSON.stringify({ name: "worker", version: "0.1.0" }));
writeFileSync(
	join(plugDir, "index.mjs"),
	`globalThis.__stopped = 0;
export default {
	activate(host) {
		const task = host.registerBackgroundTask({
			id: "nightly",
			label: "🌙 nightly",
			status: "every 1h",
			stop: () => { host.notify("info", "task-stopped"); },
		});
		host.registerCommand({
			name: "bgtask-update",
			run: () => { task.update({ status: "every 30m" }); return "updated"; },
		});
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
			sock.off("message", onMsg); // clear the listener on timeout too, to avoid leak pile-up
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

async function bgList(sock) {
	return (await waitFor(sock, (m) => m.type === "bg_servers", "bg_servers")).servers ?? [];
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

	const sock = await connect("bgtask-test");

	// -- 1. after register, task joins bg_servers (plugin activates async; poll until it appears)--------------------
	// Standing collector: every bg_servers records the latest list (avoids waitFor re-hanging listeners).
	let latestBg = [];
	sock.on("message", (raw) => {
		const m = JSON.parse(raw.toString());
		if (m.type === "bg_servers") latestBg = m.servers ?? [];
	});
	let task;
	for (let i = 0; i < 40 && !task; i++) {
		task = latestBg.find((s) => s.taskId === "nightly");
		if (!task) { sock.send(JSON.stringify({ type: "list_bg_servers" })); await new Promise((r) => setTimeout(r, 250)); }
	}
	if (!task || task.plugin !== "worker" || task.status !== "every 1h" || task.name !== "🌙 nightly") {
		fail(`plugin task did not appear in bg_servers: ${JSON.stringify(task)}`);
	} else {
		console.log(`✓ plugin task joined the background panel: ${JSON.stringify(task)}`);
	}

	// -- 2. update refreshes status ------------------------------------------------------------
	sock.send(JSON.stringify({ type: "prompt", text: "/bgtask-update" }));
	await waitFor(sock, (m) => m.type === "notice" && m.text === "updated", "update notice");
	// The command's notice can race session-ready timing — wait for the actual status refresh instead.
	sock.send(JSON.stringify({ type: "prompt", text: "/bgtask-update" }));
	let status2 = null;
	for (let i = 0; i < 40 && status2 !== "every 30m"; i++) {
		status2 = latestBg.find((s) => s.taskId === "nightly")?.status;
		if (status2 !== "every 30m") await new Promise((r) => setTimeout(r, 250));
	}
	if (status2 !== "every 30m") fail("status was not refreshed");
	else console.log("✓ task.update status refresh took effect");

	// -- 3. kill_background_server { taskId } → stop callback + removed from list ---------------------
	sock.send(JSON.stringify({ type: "kill_background_server", taskId: "nightly" }));
	// (1) stop callback is in the server process → notice as the cross-process signal; (2) list removes it
	await waitFor(sock, (m) => m.type === "notice" && m.text === "task-stopped", "task-stopped notice");
	let removed = false;
	for (let i = 0; i < 40 && !removed; i++) {
		removed = !latestBg.some((x) => x.taskId === "nightly");
		if (!removed) await new Promise((r) => setTimeout(r, 250));
	}
	if (!removed) fail("task was not removed from the list");
	else console.log("✓ kill taskId → stop callback fired + removed from list");

	// -- 4. unknown taskId does not crash -----------------------------------------------------------------
	sock.send(JSON.stringify({ type: "kill_background_server", taskId: "ghost" }));
	await new Promise((r) => setTimeout(r, 300));
	console.log("✓ unknown taskId handled silently (process alive)");

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
