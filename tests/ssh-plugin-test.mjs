/**
 * Editor plugin (vscode-editor, including Remote-SSH) protocol smoke (zero token, self-contained).
 *
 * Uses ssh2's built-in Server to start an in-process mock SSH remote (password auth + PTY shell
 * echo + exec + in-memory SFTP), copies dev/plugins/vscode-editor into a temp data-dir and
 * installs ssh2 offline (copy a node_modules subset from this repo's build dir), then starts an
 * isolated-port server and verifies:
 * - state / hosts_save (validate + redact) / hosts_delete
 * - connect: bad password refused, good password established
 * - shell_open → welcome banner; shell_input echo
 * - exec output and exit code
 * - remote file full path: same local actions with connId (list/read/write/create/
 *   rename/delete routed to that connection's SFTP; checked against the in-memory FS)
 * - local file ops are unaffected (no connId)
 * - disconnect → conn_closed event
 *
 * Run: npm run build:server, then node tests/ssh-plugin-test.mjs
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import { startMockSsh, dirs as mDirs, files as mFiles, ensurePluginSsh2Dep } from "./lib/mock-ssh.mjs";
import WebSocket from "ws";

const PORT = 8964;
const SSH_PORT = 22964;
const PLUGIN_ID = "vscode-editor";
const BASE = `http://127.0.0.1:${PORT}`;
const REPO = fileURLDirname(import.meta.url);

function fileURLDirname(u) {
	return realpathSync(new globalThis.URL("..", u).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
}

const serverPath = realpathSync(process.execPath);
let proc = null;
let sshServer = null;
let shells = [];
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-ssh-test-"));
const plugDst = join(dataDir, "plugins", PLUGIN_ID);

// ---- seed plugin dir + offline ssh2 install --------------------------------------------
mkdirSync(plugDst, { recursive: true });
cpSync(join(REPO, "dev/plugins/vscode-editor/manifest.json"), join(plugDst, "manifest.json"));
cpSync(join(REPO, "dev/plugins/vscode-editor/index.mjs"), join(plugDst, "index.mjs"));
cpSync(join(REPO, "dev/plugins/vscode-editor/client"), join(plugDst, "client"), { recursive: true });
// prepare ssh2 deps: offline copy from the local build dir; CI falls back to npm install
ensurePluginSsh2Dep(plugDst, join(REPO, "dev/plugins/vscode-editor"));

// seed a file in the local workspace (verify local ops are unaffected by the Remote-SSH work)
mkdirSync(join(dataDir, "local-proj"), { recursive: true });

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

// ---- WS helpers ----------------------------------------------------------------
function connect(clientId = "ssh-test") {
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

function rpc(sock, payload, timeoutMs = 25_000) {
	return new Promise((resolve, reject) => {
		const reqId = `t${Math.random().toString(36).slice(2)}`;
		const timer = setTimeout(() => reject(new Error(`rpc timeout: ${payload.action}`)), timeoutMs);
		const onMsg = (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === "plugin_data" && msg.pluginId === PLUGIN_ID && msg.payload?.res && msg.payload?.reqId === reqId) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(msg.payload);
			}
		};
		sock.on("message", onMsg);
		sock.send(JSON.stringify({ type: "plugin_message", pluginId: PLUGIN_ID, payload: { ...payload, reqId } }));
	});
}

/** Collect events until the predicate matches or we time out. */
function waitForEvent(sock, pred, label, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sock.off("message", onMsg);
			reject(new Error(`timeout waiting for event: ${label}`));
		}, timeoutMs);
		const onMsg = (raw) => {
			const m = JSON.parse(raw.toString());
			if (m.type === "plugin_data" && m.pluginId === PLUGIN_ID && m.payload?.event && pred(m.payload)) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(m.payload);
			}
		};
		sock.on("message", onMsg);
	});
}

/** Wait until accumulated shell_data output contains the given text. */
async function expectShellText(sock, connId, text, timeoutMs = 15000) {
	let acc = "";
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sock.off("message", onMsg);
			reject(new Error(`shell never showed 「${text}」, accumulated: ${JSON.stringify(acc.slice(-300))}`));
		}, timeoutMs);
		const onMsg = (raw) => {
			const m = JSON.parse(raw.toString());
			const p = m.payload;
			if (m.type === "plugin_data" && p?.event === "shell_data" && p.connId === connId) {
				acc += Buffer.from(p.b64, "base64").toString("utf8");
				if (acc.includes(text)) {
					clearTimeout(timer);
					sock.off("message", onMsg);
					resolve(acc);
				}
			}
		};
		sock.on("message", onMsg);
	});
}

// ---- main flow ------------------------------------------------------------------
try {
	sshServer = await startMockSsh(plugDst, SSH_PORT);

	proc = spawn(serverPath, [join(REPO, "dist", "server", "index.js")], {
		env: { ...process.env, PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: dataDir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

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

	// -- 0. onAttach push: a new client should receive initial state without sending any request ------
	{
		const statePush = await new Promise((resolve) => {
			const timer = setTimeout(() => resolve(null), 10_000);
			const onMsg = (raw) => {
				const m = JSON.parse(raw.toString());
				if (m.type === "plugin_data" && m.pluginId === PLUGIN_ID && m.payload?.kind === "state") {
					clearTimeout(timer);
					sock.off("message", onMsg);
					resolve(m.payload);
				}
			};
			sock.on("message", onMsg);
		});
		if (!statePush?.state || !Array.isArray(statePush.state.hosts)) fail("onAttach did not push kind:\"state\" initial state");
		else console.log("✓ after attach, received plugin state push (server is the source of truth)");
	}

	// -- 1. state: initial state + deps ready (we copied ssh2) ------------------------
	let r = await rpc(sock, { action: "state" });
	if (!r.ok || !Array.isArray(r.state?.hosts)) fail(`state unexpected: ${JSON.stringify(r)}`);
	else if (!r.state.depsReady) fail("deps should already be ready (ssh2 copied offline)");
	else console.log("✓ state initial return, ssh2 deps ready");

	// -- 1b. local file ops (no connId) are unaffected --------------------------------
	r = await rpc(sock, { action: "write", path: "local-proj/a.txt", text: "local-hello" });
	if (!r.ok) fail(`local write failed: ${r.error}`);
	r = await rpc(sock, { action: "read", path: "local-proj/a.txt" });
	if (!r.ok || r.text !== "local-hello") fail(`local read mismatch: ${JSON.stringify(r)}`);
	else console.log("✓ local file read/write works (no connId, goes straight to fs)");

	// -- 2. host config: validate + redact -------------------------------------------------
	r = await rpc(sock, { action: "hosts_save", host: { name: "", host: "" } });
	if (r.ok) fail("empty host address should be refused");
	else console.log("✓ empty host validation refused");

	r = await rpc(sock, {
		action: "hosts_save",
		host: { name: "bad", host: "127.0.0.1", port: SSH_PORT, username: "tester", password: "wrong" },
	});
	if (!r.ok) fail(`hosts_save bad failed: ${r.error}`);

	r = await rpc(sock, {
		action: "hosts_save",
		host: { name: "local", host: "127.0.0.1", port: SSH_PORT, username: "tester", password: "secret123" },
	});
	if (!r.ok) fail(`hosts_save failed: ${r.error}`);
	r = await rpc(sock, { action: "state" });
	const goodHost = r.state.hosts.find((h) => h.name === "local");
	const badHost = r.state.hosts.find((h) => h.name === "bad");
	if (!goodHost || !goodHost.hasPass || goodHost.password !== undefined) fail(`host echo should be redacted: ${JSON.stringify(goodHost)}`);
	else console.log("✓ hosts_save persisted + echo redacted (password not returned)");

	// Credentials have been migrated into the encrypted secrets store (host.secrets): ssh-hosts.json no longer has plaintext passwords,
	// secrets.bin exists; later connect steps verify the real password still authenticates.
	const plugDirPath = join(dataDir, "plugins", PLUGIN_ID);
	const cfgRaw = readFileSync(join(plugDirPath, "ssh-hosts.json"), "utf8");
	if (cfgRaw.includes("secret123")) fail("plaintext password must not land in ssh-hosts.json (only in the encrypted secrets store)");
	else console.log("✓ ssh-hosts.json no longer has plaintext passwords (migrated into host.secrets)");
	if (!existsSync(join(plugDirPath, "secrets.bin"))) fail("secrets.bin secrets file missing");
	else console.log("✓ encrypted secrets file secrets.bin was created");

	// -- 3. connect: bad password refused ----------------------------------------------------
	r = await rpc(sock, { action: "connect", id: badHost.id }, 30_000);
	if (r.ok) fail("bad password must not connect");
	else console.log(`✓ bad-password connect refused (${r.error.slice(0, 40)}…)`);

	// -- 4. good-password connect ----------------------------------------------------------
	r = await rpc(sock, { action: "connect", id: goodHost.id }, 30_000);
	if (!r.ok || !r.connId) fail(`connect failed: ${JSON.stringify(r)}`);
	else console.log(`✓ connected connId=${r.connId}`);
	const connId = r.connId;

	// -- 5. PTY shell: banner + input echo ---------------------------------------------
	r = await rpc(sock, { action: "shell_open", connId, cols: 120, rows: 30 });
	if (!r.ok || !r.shellId) fail(`shell_open failed: ${JSON.stringify(r)}`);
	await expectShellText(sock, connId, "welcome-to-mock");
	console.log("✓ shell opened and received the welcome banner");

	sock.send(JSON.stringify({
		type: "plugin_message", pluginId: PLUGIN_ID,
		payload: { action: "shell_input", connId, shellId: r.shellId, b64: Buffer.from("ping-test\r").toString("base64") },
	}));
	await expectShellText(sock, connId, "echo:ping-test");
	console.log("✓ terminal input echo works");

	// -- 6. exec --------------------------------------------------------------------
	r = await rpc(sock, { action: "exec", connId, cmd: "echo abc-123" });
	if (!r.ok || r.exitCode !== 0 || !r.output.includes("abc-123")) fail(`exec unexpected: ${JSON.stringify(r)}`);
	else console.log("✓ exec output and exit code 0");

	r = await rpc(sock, { action: "exec", connId, cmd: "fail-now" });
	if (!r.ok || r.exitCode !== 7 || !r.output.includes("boom")) fail(`exec failing-command unexpected: ${JSON.stringify(r)}`);
	else console.log("✓ exec non-zero exit + stderr merged");

	// -- 7. remote dir listing (unified action list + connId) ----------------------------------
	r = await rpc(sock, { action: "list", connId, dir: "/home/test" });
	if (!r.ok) fail(`remote list failed: ${r.error}`);
	else {
		const names = r.entries.map((e) => e.name);
		if (!(names.includes("a.txt") && names.includes("sub") && names.includes("big.bin"))) fail(`listing missing items: ${names}`);
		else if (r.entries[r.entries.length - 1].type !== "file") fail("files should sort after directories");
		else console.log(`✓ remote list (connId routed) ${names.join(", ")}`);
	}

	// -- 8. remote read (text + binary sniff) -----------------------------------------------
	r = await rpc(sock, { action: "read", connId, path: "/home/test/a.txt" });
	if (!r.ok || r.text !== "hello ssh\n第二行\n") fail(`remote read text unexpected: ${JSON.stringify(r)}`);
	else console.log("✓ remote read text content");

	r = await rpc(sock, { action: "read", connId, path: "/home/test/big.bin" });
	if (!r.ok || r.binary !== true) fail(`binary sniff unexpected: ${JSON.stringify(r)}`);
	else console.log("✓ remote read binary flag (NUL sniff)");

	// -- 9. remote write → read-back check ----------------------------------------------------------
	r = await rpc(sock, { action: "write", connId, path: "/home/test/b.txt", text: "written-by-test 中文" });
	if (!r.ok) fail(`remote write failed: ${r.error}`);
	r = await rpc(sock, { action: "read", connId, path: "/home/test/b.txt" });
	if (!r.ok || r.text !== "written-by-test 中文") fail(`write→read mismatch: ${JSON.stringify(r)}`);
	else console.log("✓ remote write then read-back matches (UTF-8)");

	// -- 10. create / rename / delete ---------------------------------------------------
	r = await rpc(sock, { action: "create", connId, path: "/home/test/newdir", kind: "dir" });
	if (!r.ok || !mDirs["/home/test/newdir"]) fail(`create dir unexpected: ${JSON.stringify(r)}`);
	else console.log("✓ remote create directory");

	r = await rpc(sock, { action: "rename", connId, path: "/home/test/b.txt", newName: "renamed.txt" });
	if (!r.ok || !mFiles["/home/test/renamed.txt"] || mFiles["/home/test/b.txt"]) fail(`rename unexpected: ${JSON.stringify(r)}`);
	else console.log("✓ remote rename");

	r = await rpc(sock, { action: "delete", connId, path: "/home/test/renamed.txt", isDir: false });
	if (!r.ok || mFiles["/home/test/renamed.txt"]) fail(`delete unexpected: ${JSON.stringify(r)}`);
	else console.log("✓ remote delete file");

	// rename with a path separator should be refused
	r = await rpc(sock, { action: "rename", connId, path: "/home/test/sub", newName: "../evil" });
	if (r.ok) fail("rename ../ should be refused");
	else console.log("✓ rename illegal name refused");

	// -- 11. disconnect → conn_closed --------------------------------------------------------
	const closedP = waitForEvent(sock, (p) => p.event === "conn_closed" && p.connId === connId, "conn_closed");
	await rpc(sock, { action: "disconnect", connId });
	await closedP;
	console.log("✓ disconnect fired conn_closed event");

	// -- 12. hosts_delete --------------------------------------------------------------------
	r = await rpc(sock, { action: "hosts_delete", id: badHost.id });
	if (!r.ok) fail(`hosts_delete failed: ${r.error}`);
	r = await rpc(sock, { action: "state" });
	if (r.state.hosts.some((h) => h.id === badHost.id)) fail("host was not deleted");
	else console.log("✓ hosts_delete");

	// -- 13. unknown action ------------------------------------------------------------------------
	r = await rpc(sock, { action: "no-such" });
	if (r.ok) fail("unknown action should fail");
	else console.log("✓ unknown action errors without crashing");

	// -- 14. sync config file (workspace .vscode/sftp.json, vscode-sftp compatible format) ---------------------
	r = await rpc(sock, { action: "sync_get" });
	if (!r.ok) fail(`sync_get failed: ${r.error}`);
	else if (r.config.configured) fail("configured should be false when unset");
	else if (r.configPath !== ".vscode/sftp.json") fail("configPath should be .vscode/sftp.json");
	else console.log("✓ sync_get initially unconfigured (configured:false + configPath)");

	// save → land in workspace .vscode/sftp.json using vscode-sftp field names
	r = await rpc(sock, { action: "sync_save", config: {
		host: "127.0.0.1", port: SSH_PORT, username: "test",
		password: "secret", remoteRoot: "/home/test",
		exclude: ["node_modules/**", "**/*.map", "*.log"],
		uploadOnSave: true,
	} });
	if (!r.ok) fail(`sync_save failed: ${r.error}`);
	const cfgFile = join(dataDir, ".vscode", "sftp.json");
	let rawCfg = {};
	try { rawCfg = JSON.parse(readFileSync(cfgFile, "utf8")); } catch {}
	if (rawCfg.host !== "127.0.0.1" || rawCfg.remotePath !== "/home/test"
		|| !Array.isArray(rawCfg.ignore) || rawCfg.uploadOnSave !== true) {
		fail(`sftp.json content unexpected: ${JSON.stringify(rawCfg)}`);
	} else if (rawCfg.password !== "secret") {
		fail("sftp.json should save the password (local-file convention, for vscode-sftp compat reads)");
	} else console.log("✓ sync_save wrote workspace .vscode/sftp.json (remotePath/ignore field names)");

	// read-back: configured + credentials redacted (no plaintext, only hasPass)
	r = await rpc(sock, { action: "sync_get" });
	if (!r.ok || !r.config.configured || r.config.hasPass !== true || r.config.password !== undefined) {
		fail(`sync_get read-back unexpected: ${JSON.stringify(r)}`);
	} else if (r.config.exclude?.length !== 3 || r.config.uploadOnSave !== true) {
		fail("sync_get read-back ignore/uploadOnSave mismatch");
	} else console.log("✓ sync_get read-back redacted (hasPass, no plaintext password)");

	// empty password/key = keep the previous value
	r = await rpc(sock, { action: "sync_save", config: {
		host: "127.0.0.1", port: SSH_PORT, username: "test", remoteRoot: "/home/test",
	} });
	if (!r.ok || r.config.hasPass !== true) fail(`empty password should keep the previous value: ${JSON.stringify(r)}`);
	else console.log("✓ sync_save empty credentials keep previous values");

	// illegal remote root refused
	r = await rpc(sock, { action: "sync_save", config: { host: "x", port: 22, remoteRoot: "relative/path" } });
	if (r.ok) fail("relative remoteRoot should be refused");
	else console.log("✓ relative remote root refused");

	// sync_ensure: when already configured, only return the path, do not overwrite
	r = await rpc(sock, { action: "sync_ensure" });
	if (!r.ok || r.path !== ".vscode/sftp.json") fail(`sync_ensure unexpected: ${JSON.stringify(r)}`);
	rawCfg = JSON.parse(readFileSync(cfgFile, "utf8"));
	if (rawCfg.host !== "127.0.0.1") fail("sync_ensure must not overwrite existing config");
	else console.log("✓ sync_ensure returns the config path and does not overwrite");

	// -- 15. sync round-trip: down/up a single file (real mock SFTP) ---------------------------------
	// write workspace .vscode/sftp.json pointing at mock SSH (tester/secret123)
	r = await rpc(sock, { action: "write", path: ".vscode/sftp.json", text: JSON.stringify({
		host: "127.0.0.1", port: SSH_PORT, username: "tester", password: "secret123",
		remotePath: "/home/test", uploadOnSave: false, ignore: [],
	}) });
	if (!r.ok) fail(`write .vscode/sftp.json failed: ${r.error}`);

	// down: remote a.txt → local workspace
	rmSync(join(dataDir, "a.txt"), { force: true });
	r = await rpc(sock, { action: "sync_run", dir: "down", scope: "file", path: "a.txt" }, 30_000);
	if (!r.ok) fail(`sync_run down failed: ${r.error}`);
	let dlText = "";
	try { dlText = readFileSync(join(dataDir, "a.txt"), "utf8"); } catch {}
	if (dlText !== "hello ssh\n第二行\n") fail(`down content mismatch: ${JSON.stringify(dlText)}`);
	else console.log("✓ sync down: remote file downloaded into the local workspace");

	// up: newly created local file → remote memory
	r = await rpc(sock, { action: "write", path: "b.txt", text: "local-upload\n" });
	if (!r.ok) fail(`write local b.txt failed: ${r.error}`);
	r = await rpc(sock, { action: "sync_run", dir: "up", scope: "file", path: "b.txt" }, 30_000);
	if (!r.ok) fail(`sync_run up failed: ${r.error}`);
	const upBuf = mFiles["/home/test/b.txt"];
	if (!upBuf || !upBuf.toString().includes("local-upload")) fail("after up, remote has no b.txt");
	else console.log("✓ sync up: local file uploaded to remote");
	delete mFiles["/home/test/b.txt"]; // cleanup, do not pollute other assertions
	rmSync(join(dataDir, "b.txt"), { force: true });
	rmSync(join(dataDir, "a.txt"), { force: true });

	// -- 16. download: local file download to the computer (base64 over WS) ---------------------------------
	r = await rpc(sock, { action: "write", path: "dl.bin", text: "download-me\n" });
	if (!r.ok) fail(`write dl.bin failed: ${r.error}`);
	r = await rpc(sock, { action: "download", path: "dl.bin" });
	if (!r.ok || Buffer.from(r.b64, "base64").toString("utf8") !== "download-me\n") {
		fail(`download content mismatch: ${JSON.stringify(r).slice(0, 120)}`);
	} else console.log("✓ download: local file base64 round-trip is correct");

	r = await rpc(sock, { action: "download", path: "../outside.txt" });
	if (r.ok) fail("download ../ out-of-bounds should be refused");
	else console.log("✓ download: path traversal refused");

	// -- 17. remote file/folder download directly to the computer (not via workspace mapping) -------------------------------
	// reconnect to the mock host (§11 already disconnected)
	r = await rpc(sock, { action: "state" });
	const hid2 = r.state.hosts.find((h) => h.name === "local").id;
	r = await rpc(sock, { action: "connect", id: hid2 }, 30_000);
	if (!r.ok) fail(`reconnect failed: ${r.error}`);
	const cid2 = r.connId;

	r = await rpc(sock, { action: "download", connId: cid2, path: "/home/test/a.txt" });
	if (!r.ok || Buffer.from(r.b64, "base64").toString("utf8") !== "hello ssh\n第二行\n" || r.name !== "a.txt") {
		fail(`remote file download unexpected: ${JSON.stringify({ ...r, b64: undefined }).slice(0, 160)}`);
	} else console.log("✓ download remote: single-file content and name are correct");

	r = await rpc(sock, { action: "download", connId: cid2, path: "/home/test/sub" });
	if (!r.ok || !r.name?.endsWith("sub.tar.gz")) {
		fail(`remote folder archive download unexpected: ${JSON.stringify({ ...r, b64: undefined })}`);
	} else {
		const raw = gunzipSync(Buffer.from(r.b64, "base64"));
		if (!raw.includes(Buffer.from("sub", "utf8"))) fail("tar.gz did not contain directory name sub");
		else console.log("✓ download remote: folder tar.gz archive content is correct");
	}

	r = await rpc(sock, { action: "download", connId: cid2, path: "../evil" });
	if (r.ok) fail("remote download ../ should be refused");
	else console.log("✓ download remote: path traversal refused");

	sock.close();
} catch (err) {
	fail(err.message);
	console.error(err);
} finally {
	try {
		for (const s of shells) try { s.end(); } catch {}
		sshServer?.close();
		if (proc?.pid) process.kill(proc.pid, "SIGTERM");
	} catch {}
	await sleep(500);
	rmSync(dataDir, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
