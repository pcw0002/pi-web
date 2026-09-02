/**
 * Global search (search_files / search_files_result) + BgServer.command protocol smoke.
 * Zero token: self-starts a compiled server (isolated port 8962 + temp data-dir),
 * sends search_files and asserts reqId echo + filename matches; empty query returns [].
 */
import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8962;
const URL = `ws://localhost:${PORT}/ws`;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

// Temp workspace: nested dirs + node_modules (should be ignored)
const workDir = join(mkdtempSync(join(tmpdir(), "pi-web-gs-test-")), "proj");
mkdirSync(join(workDir, "src"), { recursive: true });
mkdirSync(join(workDir, "node_modules", "somepkg"), { recursive: true });
writeFileSync(join(workDir, "README.md"), "hi");
writeFileSync(join(workDir, "src", "alpha-util.ts"), "export {};");
writeFileSync(join(workDir, "src", "beta.txt"), "x");
writeFileSync(join(workDir, "node_modules", "somepkg", "util.js"), "y");

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-gs-data-"));
let server = null;

async function startServer() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: workDir,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		try {
			if (await portUp(PORT)) return;
		} catch {
			// not up yet
		}
	}
	throw new Error("server did not start");
}

function connect() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(URL);
		const inbox = [];
		const waiters = [];
		const api = {
			ws,
			async next(pred, what, ms = 8000) {
				const existing = inbox.findIndex(pred);
				if (existing >= 0) return inbox.splice(existing, 1)[0];
				return new Promise((res, rej) => {
					const t = setTimeout(
						() => rej(new Error(`timeout waiting for ${what}`)),
						ms,
					);
					waiters.push((m) => {
						if (pred(m)) {
							clearTimeout(t);
							res(m);
							return true;
						}
						return false;
					});
				});
			},
			send(m) {
				ws.send(JSON.stringify(m));
			},
		};
		ws.onopen = () => {
			api.send({ type: "hello", clientId: "gs-test" });
			resolve(api);
		};
		ws.onmessage = (ev) => {
			let msg;
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			inbox.push(msg);
			for (let i = 0; i < waiters.length; i++) {
				if (waiters[i](msg)) {
					waiters.splice(i, 1);
					i--;
				}
			}
		};
		ws.onerror = reject;
	});
}

async function run() {
	await startServer();
	await sleep(300);
	const c = await connect();

	// 1) file search hits + reqId echo
	c.send({ type: "search_files", reqId: 42, query: "util" });
	const r1 = await c.next(
		(m) => m.type === "search_files_result" && m.reqId === 42,
		"search_files_result #42",
	);
	check("reqId is echoed", r1.reqId === 42);
	check("ok:true", r1.ok === true, JSON.stringify(r1).slice(0, 200));
	const names = (r1.results ?? []).map((r) => r.name);
	check("hits src/alpha-util.ts", names.includes("alpha-util.ts"), names.join(","));
	const utilHit = (r1.results ?? []).find((r) => r.name === "alpha-util.ts");
	check(
		"relative path is src/alpha-util.ts",
		utilHit?.path === "src/alpha-util.ts",
		utilHit?.path,
	);

	// 2) node_modules is ignored
	c.send({ type: "search_files", reqId: 43, query: "somepkg" });
	const r2 = await c.next(
		(m) => m.type === "search_files_result" && m.reqId === 43,
		"result #43",
	);
	check(
		"node_modules is not in results",
		r2.ok && (r2.results ?? []).length === 0,
		JSON.stringify(r2.results),
	);

	// 3) directories match too
	c.send({ type: "search_files", reqId: 44, query: "src" });
	const r3 = await c.next(
		(m) => m.type === "search_files_result" && m.reqId === 44,
		"result #44",
	);
	check(
		"directory src is hit with type=dir",
		(r3.results ?? []).some((r) => r.name === "src" && r.type === "dir"),
		JSON.stringify(r3.results),
	);

	// 4) empty query → empty list, still echoes
	c.send({ type: "search_files", reqId: 45, query: "   " });
	const r4 = await c.next(
		(m) => m.type === "search_files_result" && m.reqId === 45,
		"result #45",
	);
	check("empty query returns an empty list", r4.ok && r4.results.length === 0);

	c.ws.close();
}

try {
	await run();
} catch (err) {
	console.error("FATAL:", err?.message ?? err);
	failures++;
} finally {
	if (server?.pid) process.kill(server.pid, "SIGTERM");
	await sleep(500);
}
process.exit(failures === 0 ? 0 : 1);
