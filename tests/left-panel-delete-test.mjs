/**
 * Left-panel delete protocol smoke (zero token):
 *   - delete_session: deletes the session file under <agentDir>/sessions/ (disk check + sessions list refresh)
 *   - delete_session out-of-bounds path (outside the sessions dir): error and file untouched
 *   - remove_project: removes the workspace from recent projects (projects message no longer includes it)
 * Self-starts a compiled server (isolated port 8967 + temp data-dir + temp agent-dir) and cleans up.
 */
import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8967;
const URL = `ws://localhost:${PORT}/ws`;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

// Two workspaces: workDir is PI_WEB_CWD; otherDir exists only as a recent-project entry
const baseTmp = mkdtempSync(join(tmpdir(), "pi-web-lp-del-"));
const workDir = join(baseTmp, "proj");
const otherDir = join(baseTmp, "other");
mkdirSync(workDir, { recursive: true });
mkdirSync(otherDir, { recursive: true });
writeFileSync(join(workDir, "a.txt"), "keep me");

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-lp-del-data-"));
const agentDir = join(baseTmp, "agent");

// Seed two session files (one for workDir + one for otherDir), same format as pi CLI/TUI
function seedSession(dirName, id, cwd, text) {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const dir = join(agentDir, "sessions", dirName ?? safePath);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-08-04T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(
		file,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id,
				timestamp: "2026-08-04T00:00:00.000Z",
				cwd,
			}),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-08-04T00:00:01.000Z",
				message: {
					role: "user",
					content: [{ type: "text", text }],
					timestamp: 1722700801000,
				},
			}),
		].join("\n") + "\n",
	);
	return file;
}
const sess1 = seedSession(null, "del-target", workDir, "session to delete");
const sess2 = seedSession(null, "del-keep", workDir, "session to keep");
const sessOther = seedSession(null, "del-other", otherDir, "session in another project");

let server = null;

async function startServer() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: agentDir,
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
			api.send({ type: "hello", clientId: "lp-del-test" });
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

	// 1) list_sessions finds the two seeded sessions (current project workDir)
	c.send({ type: "list_sessions" });
	const s1 = await c.next((m) => m.type === "sessions", "sessions #1");
	const paths1 = (s1.sessions ?? []).map((x) => x.path);
	check("list_sessions hits the two seeded sessions", paths1.includes(sess1) && paths1.includes(sess2), paths1.join(","));

	// 2) delete_session deletes one → gone from disk + list refresh leaves one
	// (attach has a debounced background re-push; wait for the copy that truly omits the deleted item)
	c.send({ type: "delete_session", path: sess1 });
	const s2 = await c.next(
		(m) =>
			m.type === "sessions" &&
			!(m.sessions ?? []).some((x) => x.path === sess1),
		"sessions #2 (without the deleted item)",
	);
	const paths2 = (s2.sessions ?? []).map((x) => x.path);
	check("file is gone from disk after delete", !existsSync(sess1), sess1);
	check("list no longer includes the session after delete", !paths2.includes(sess1), paths2.join(","));
	check("the other session is still there", paths2.includes(sess2));

	// 3) out-of-bounds path refused: files outside the sessions dir cannot be deleted
	c.send({ type: "delete_session", path: join(workDir, "a.txt") });
	const n1 = await c.next(
		(m) => m.type === "notice" && m.level === "error",
		"error notice",
	);
	check("out-of-bounds delete returns an error notice", typeof n1.text === "string" && n1.text.length > 0, n1.text);
	check("out-of-bounds file was not deleted", existsSync(join(workDir, "a.txt")));

	// 4) remove_project: otherDir removed from recent projects
	c.send({ type: "list_projects" });
	const p1 = await c.next((m) => m.type === "projects", "projects #1");
	const projPaths1 = (p1.projects ?? []).map((x) => x.path);
	check("initial recent projects include otherDir", projPaths1.includes(otherDir), projPaths1.join(","));

	c.send({ type: "remove_project", path: otherDir });
	const p2 = await c.next(
		(m) =>
			m.type === "projects" &&
			!(m.projects ?? []).some((x) => x.path === otherDir),
		"projects #2 (without otherDir)",
	);
	const projPaths2 = (p2.projects ?? []).map((x) => x.path);
	check("recent projects omit otherDir after remove", !projPaths2.includes(otherDir), projPaths2.join(","));
	check("remove only changes UI state; dir still on disk", existsSync(otherDir));

	// 5) remove is persistent: check again after reconnect
	const c2 = await connect();
	c2.send({ type: "list_projects" });
	const p3 = await c2.next((m) => m.type === "projects", "projects #3");
	check(
		"after reconnect, otherDir is still not in recent projects",
		!(p3.projects ?? []).some((x) => x.path === otherDir),
	);

	c.ws.close();
	c2.ws.close();
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
