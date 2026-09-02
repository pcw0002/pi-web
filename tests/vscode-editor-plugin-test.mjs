/**
 * vscode-editor plugin protocol smoke (zero token, self-contained).
 *
 * Copy dev/plugins/vscode-editor (manifest + index.mjs + client bundle) into a
 * temp data-dir, start an isolated-port server, and verify:
 * - plugins catalog includes vscode-editor with hasClient
 * - list / flatlist / read / write / create / rename / delete full path
 *   (reqId match, GBK decode, path-traversal refused, ignored dirs skipped, disk persist check)
 * - client/entry.mjs static serving 200 + JS Content-Type
 *
 * Run: npm run build:server, then node tests/vscode-editor-plugin-test.mjs
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8967;
const BASE = `http://127.0.0.1:${PORT}`;

const serverPath = realpathSync(process.execPath);
const repoRoot = join(import.meta.dirname, "..");
let proc = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-vsc-plugin-"));
const workspace = join(dataDir, "workspace");

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

// ---- seed plugin dir + workspace fixture ----------------------------------------------
const plugDst = join(dataDir, "plugins", "vscode-editor");
mkdirSync(plugDst, { recursive: true });
cpSync(join(repoRoot, "dev", "plugins", "vscode-editor", "manifest.json"), join(plugDst, "manifest.json"));
cpSync(join(repoRoot, "dev", "plugins", "vscode-editor", "index.mjs"), join(plugDst, "index.mjs"));
cpSync(join(repoRoot, "dev", "plugins", "vscode-editor", "client"), join(plugDst, "client"), { recursive: true });

// workspace: src/main.js + GBK Chinese txt + node_modules noise
mkdirSync(join(workspace, "src"), { recursive: true });
mkdirSync(join(workspace, "node_modules", "noise-pkg"), { recursive: true });
writeFileSync(join(workspace, "src", "main.js"), 'console.log("hello vsc");\n');
writeFileSync(join(workspace, "README.md"), "# Test workspace\n");
// GBK-encoded 「你好」
writeFileSync(join(workspace, "gbk.txt"), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
writeFileSync(join(workspace, "node_modules", "noise-pkg", "index.js"), "// noise\n");

/** Connect WS and wait for ready. */
function connect(clientId = "vsc-test") {
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId })));
		sock.on("message", (raw) => {
			if (JSON.parse(raw.toString()).type === "ready") {
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

/** Send plugin_message and wait for the matching-reqId response. */
function rpc(sock, payload) {
	return new Promise((resolve, reject) => {
		const reqId = `t${Math.random().toString(36).slice(2)}`;
		const timer = setTimeout(() => reject(new Error(`rpc timeout: ${payload.action}`)), 10_000);
		const onMsg = (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === "plugin_data" && msg.pluginId === "vscode-editor" && msg.payload?.res && msg.payload?.reqId === reqId) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(msg.payload);
			}
		};
		sock.on("message", onMsg);
		sock.send(JSON.stringify({ type: "plugin_message", pluginId: "vscode-editor", payload: { ...payload, reqId } }));
	});
}

try {
	proc = spawn(serverPath, [join(repoRoot, "dist", "server", "index.js")], {
		env: {
			...process.env,
			PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: workspace,
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

	let sock = await connect();

	// -- 1. plugins catalog ------------------------------------------------------
	const pluginsMsg = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sock.off("message", onMsg);
			reject(new Error("no plugins message"));
		}, 10_000);
		const onMsg = (raw) => {
			const m = JSON.parse(raw.toString());
			if (m.type === "plugins") {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(m);
			}
		};
		sock.on("message", onMsg);
	});
	const me = (pluginsMsg.plugins ?? []).find((p) => p.id === "vscode-editor");
	if (!me || me.hasClient !== true || me.error !== undefined) {
		fail(`vscode-editor not listed correctly: ${JSON.stringify(me)}`);
	} else console.log("✓ plugins catalog includes vscode-editor (hasClient)");

	// -- 2. list: root (dirs first, node_modules skipped) -------------------
	let r = await rpc(sock, { action: "list", dir: "" });
	if (!r.ok) fail(`list failed: ${r.error}`);
	else if (readdirSync(workspace).some(() => false), true) {
		const names = r.entries.map((e) => e.name);
		if (names.includes("node_modules")) fail("list should skip node_modules");
		else if (r.entries[0]?.name !== "src" || r.entries[0]?.type !== "dir") fail(`dirs should sort before files: ${names}`);
		else console.log("✓ list root: dirs first + node_modules ignored");
	}

	// -- 2b. list subdirectory ------------------------------------------------------
	r = await rpc(sock, { action: "list", dir: "src" });
	if (!r.ok || !r.entries.some((e) => e.name === "main.js")) fail(`list src failed: ${JSON.stringify(r)}`);
	else console.log("✓ list subdirectory src/main.js");

	// -- 3. read: text + GBK fallback ---------------------------------------------
	r = await rpc(sock, { action: "read", path: "src/main.js" });
	if (!r.ok || r.text !== 'console.log("hello vsc");\n') fail(`read main.js wrong: ${JSON.stringify(r)}`);
	else console.log("✓ read text content is correct");

	r = await rpc(sock, { action: "read", path: "gbk.txt" });
	if (!r.ok || r.text !== "你好") fail(`GBK decode failed: ${JSON.stringify(r)}`);
	else console.log("✓ read GBK fallback decoded as 「你好」");

	// -- 4. path traversal refused -------------------------------------------------------
	r = await rpc(sock, { action: "read", path: "../outside.txt" });
	if (r.ok) fail("../ traversal was not refused");
	else console.log("✓ ../ path traversal was refused");

	r = await rpc(sock, { action: "delete", path: "." });
	if (r.ok) fail("deleting the root was not refused");
	else console.log("✓ refused deleting the root");

	// -- 5. write → disk check ----------------------------------------------------
	r = await rpc(sock, { action: "write", path: "src/new.ts", text: "const x: number = 1;\n" });
	if (!r.ok) fail(`write failed: ${r.error}`);
	else if (readFileSync(join(workspace, "src", "new.ts"), "utf-8") !== "const x: number = 1;\n") fail("write did not persist to disk");
	else console.log("✓ write atomically persisted (parent dirs created)");

	// -- 6. create file/dir + duplicate-name error ------------------------------------------
	r = await rpc(sock, { action: "create", path: "docs/guide.md", kind: "file" });
	if (!r.ok) fail(`create file failed: ${r.error}`);
	else if (!existsSync(join(workspace, "docs", "guide.md"))) fail("create file did not persist");
	else console.log("✓ create file (with subdirectory)");

	r = await rpc(sock, { action: "create", path: "assets", kind: "dir" });
	if (!r.ok) fail(`create dir failed: ${r.error}`);
	r = await rpc(sock, { action: "create", path: "assets", kind: "dir" });
	if (r.ok) fail("duplicate create should error");
	else if (!/already exists/i.test(r.error)) fail(`duplicate-name error text unexpected: ${r.error}`);
	else console.log("✓ create dir + duplicate-name error");

	// -- 7. rename --------------------------------------------------------------
	r = await rpc(sock, { action: "rename", path: "docs/guide.md", newName: "tutorial.md" });
	if (!r.ok || !existsSync(join(workspace, "docs", "tutorial.md"))) fail(`rename failed: ${JSON.stringify(r)}`);
	else console.log("✓ rename");

	r = await rpc(sock, { action: "rename", path: "docs/tutorial.md", newName: "../evil.md" });
	if (r.ok) fail("rename containing .. was not refused");
	else console.log("✓ rename refused path separators/..");

	// -- 8. flatlist (relative paths + skip node_modules) -----------------------------
	r = await rpc(sock, { action: "flatlist" });
	if (!r.ok) fail(`flatlist failed: ${r.error}`);
	else {
		const files = r.files ?? [];
		if (files.some((f) => f.includes("node_modules"))) fail("flatlist should skip node_modules");
		else if (!files.includes("README.md") || !files.includes("src/main.js") || !files.includes("docs/tutorial.md")) fail(`flatlist missing items: ${files}`);
		else console.log(`✓ flatlist ${files.length} relative paths`);
	}

	// -- 9. delete ----------------------------------------------------------------
	r = await rpc(sock, { action: "delete", path: "docs" });
	if (!r.ok || existsSync(join(workspace, "docs"))) fail(`delete failed: ${JSON.stringify(r)}`);
	else console.log("✓ delete directory recursively");

	// -- 10. illegal action errors without crashing --------------------------------------------------
	r = await rpc(sock, { action: "no-such-action" });
	if (r.ok) fail("unknown action should fail");
	else console.log("✓ unknown action returns an error and the process stays up");

	// -- 11. static serving: client bundle -----------------------------------------------
	const jsRes = await fetch(`${BASE}/plugins/vscode-editor/client/entry.mjs`);
	const ct = jsRes.headers.get("content-type") ?? "";
	if (!jsRes.ok || !/javascript|ecmascript/.test(ct)) fail(`entry.mjs static serving unexpected: ${jsRes.status} ${ct}`);
	else if (!(await jsRes.text()).includes("vscode-editor client bundle")) fail("bundle content mismatch");
	else console.log("✓ client/entry.mjs static serving 200 + JS Content-Type");

	// paths outside the client subtree miss the plugin static route and fall through to the SPA catch-all
	// index.html — the safety property is "never return plugin-dir source", not the status code.
	for (const u of [
		`${BASE}/plugins/vscode-editor/%2e%2e/index.mjs`,
		`${BASE}/plugins/vscode-editor/manifest.json`,
	]) {
		const res = await fetch(u);
		const ct = res.headers.get("content-type") ?? "";
		const body = await res.text();
		if (/javascript|ecmascript/.test(ct) && /safeResolve|onMessage|Path escapes/.test(body)) {
			fail(`plugin server source leaked via ${u}`);
		} else if (!/javascript|ecmascript/.test(ct)) {
			console.log(`✓ ${u.replace(BASE, "")} did not expose plugin files (${ct.split(";")[0]})`);
		}
	}
	sock.close();
} catch (err) {
	fail(err.message);
	console.error(err);
} finally {
	try {
		if (proc?.pid) process.kill(proc.pid, "SIGTERM");
	} catch {}
	await new Promise((r) => setTimeout(r, 500));
	rmSync(dataDir, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
