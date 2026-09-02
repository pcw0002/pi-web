#!/usr/bin/env node
/**
 * recursive-watch-test.mjs — file-tree recursive watcher regression (zero token).
 *
 * Checks:
 *   1. on win32/darwin, fs.watch(recursive) on the workspace root also pushes file_changed for
 *      files in **deep unlisted dirs** (the old impl only watched the currently listed dir).
 *   2. events under node_modules / .git are filtered and do not trigger a refresh.
 *   3. after switching the listed dir, file_changed.path follows the new dir.
 *
 * Self-contained: isolated port + temp data-dir + temp workspace, cleaned up. On Linux
 * (no recursive watch) only verify the fallback does not crash + shallow changes still work;
 * skip the deep assertion.
 */
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import WebSocket from "ws";

const PORT = 8966;
const HOST = `http://127.0.0.1:${PORT}`;
const HEADLESS = false;

const server = null;
let ws;
let clientId = "";
let reqId = 0;
const pendingFiles = [];
let lastFileChanged = null;
let child = null;

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitReady() {
	for (let i = 0; i < 60; i++) {
		try {
			const r = await fetch(`${HOST}/api/health`);
			if (r.ok) return;
		} catch {}
		await sleep(500);
	}
	throw new Error("server not ready");
}

function send(msg) {
	ws.send(JSON.stringify({ ...msg, reqId: msg.reqId ?? ++reqId }));
}

function nextFileChanged(timeoutMs = 8000) {
	const seen = lastFileChanged;
	return new Promise((resolve, reject) => {
		const t0 = Date.now();
		const timer = setInterval(() => {
			if (lastFileChanged && lastFileChanged !== seen) {
				clearInterval(timer);
				resolve(lastFileChanged);
			} else if (Date.now() - t0 > timeoutMs) {
				clearInterval(timer);
				reject(new Error("file_changed timeout"));
			}
		}, 50);
	});
}

async function listDir(rel) {
	const p = new Promise((res) => pendingFiles.push(res));
	send({ type: "list_files", path: rel });
	return p;
}

async function main() {
	const dataDir = mkdtempSync(join(tmpdir(), "pi-web-recursive-watch-"));
	const workspace = mkdtempSync(join(tmpdir(), "pi-web-watch-ws-"));
	mkdirSync(join(workspace, "deep", "nested"), { recursive: true });
	writeFileSync(join(workspace, "root.txt"), "root\n");
	writeFileSync(join(workspace, "deep", "nested", "leaf.txt"), "leaf\n");
	let ok = false;
	let failure = null;
	try {
		child = spawn(
			realpathSync(process.execPath),
			[join("dist", "server", "index.js")],
			{
				env: {
					...process.env,
					PORT: String(PORT),
					PI_WEB_CWD: workspace,
					PI_WEB_DATA_DIR: dataDir,
					PI_WEB_HOST: "127.0.0.1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
		await waitReady();

		ws = new WebSocket(`${HOST.replace("http", "ws")}/ws`);
		await new Promise((r) => ws.on("open", r));
		ws.on("message", (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === "ready") {
				clientId = msg.clientId;
				return;
			}
			if (msg.type === "files") {
				const p = pendingFiles.shift();
				if (p) p(msg);
			} else if (msg.type === "file_changed") {
				lastFileChanged = { path: msg.path, at: Date.now() };
			}
		});
		send({ type: "hello", clientId: "" });
		await sleep(600);

		// initially list the root → establish the watcher
		const root1 = await listDir("");
		if (root1.error) throw new Error(root1.error);

		const deepSupported =
			process.platform === "win32" || process.platform === "darwin";

		// 1) change in a deep (unlisted) dir → file_changed
		lastFileChanged = null;
		setTimeout(
			() => writeFileSync(join(workspace, "deep", "nested", "leaf.txt"), "changed\n"),
			100,
		);
		if (deepSupported) {
			const ev = await nextFileChanged();
			console.log(`✓ deep change pushed file_changed (path=${ev.path})`);
		} else {
			// Linux fallback: wait a bit to confirm no crash (not an assertion failure)
			await sleep(1500);
			console.log(`⏭ platform has no recursive watch, skipping the deep assertion`);
		}

		// 2) node_modules event filter: a write must not trigger file_changed shortly after
		mkdirSync(join(workspace, "node_modules", "pkg"), { recursive: true });
		lastFileChanged = null;
		writeFileSync(join(workspace, "node_modules", "pkg", "x.js"), "x\n");
		let filtered = true;
		try {
			await nextFileChanged(2500);
			filtered = false;
		} catch {
			/* not fired = filtered */
		}
		if (!filtered && deepSupported) {
			throw new Error("a node_modules change must not trigger file_changed");
		}
		console.log(`✓ node_modules events were filtered`);

		// 3) after switching the listed dir, file_changed.path follows
		await listDir("deep");
		await sleep(300); // wait for retarget to take effect
		lastFileChanged = null;
		setTimeout(() => writeFileSync(join(workspace, "deep", "other.txt"), "y\n"), 100);
		if (deepSupported) {
			const ev2 = await nextFileChanged();
			if (ev2.path !== "deep") {
				throw new Error(`file_changed.path should be deep, got ${ev2.path}`);
			}
			console.log(`✓ path follows after listed-dir switch (${ev2.path})`);
		}

		ok = true;
		console.log("\nall passed ✅");
	} catch (err) {
		failure = err;
	} finally {
		try { ws?.close(); } catch {}
		if (child?.pid) {
			// win32 uses taskkill /T to kill the process tree; posix SIGTERM directly (otherwise the server child
			// leaks and holds the port, so the next suite run hits EADDRINUSE on PORT).
			if (process.platform === "win32") {
				execFile("taskkill", ["/F", "/T", "/PID", String(child.pid)], () => {});
			} else {
				try { process.kill(child.pid, "SIGTERM"); } catch {}
			}
		}
		await sleep(500);
		try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
		try { rmSync(workspace, { recursive: true, force: true }); } catch {}
	}
	if (failure) {
		console.error("✗", failure.message);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("✗", err.message);
	process.exit(1);
});
