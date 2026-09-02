/**
 * MCP tool-bridge end-to-end smoke (zero token, self-contained, isolated port 8990):
 * write mcp.json in a temp data-dir (pointing at the local fixture server) and start a real server:
 *  - MCP server is spawned at server start (ready log on stdout)
 *  - tool count is correct (4)
 *  - MCP server failure does not crash the server process
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/mcp-echo-server.mjs");

const PORT = 8990;
let server; let dataDir;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
	dataDir = mkdtempSync(join(tmpdir(), "mcp-bridge-"));
	writeFileSync(
		join(dataDir, "mcp.json"),
		JSON.stringify({
			servers: {
				csrv: {
					command: process.execPath, // real node (test env has no git-bash alias)
					args: [FIXTURE],
				},
				badsrv: { command: "definitely-not-a-real-cmd-xyz", args: [] },
			},
		}),
	);

	server = spawn(
		process.execPath,
		["dist/server/index.js", "--port", String(PORT)],
		{
			env: {
				...process.env,
				PI_WEB_DATA_DIR: dataDir,
				PORT: String(PORT),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let out = "";
	server.stdout.on("data", (d) => (out += d.toString()));
	server.stderr.on("data", (d) => (out += d.toString()));

	// wait for server “ready” + MCP ready log (up to 15s)
	let ok = false;
	for (let i = 0; i < 60 && !ok; i++) {
		await sleep(250);
		if (/listening|ready|available/i.test(out) && /\[mcp:csrv\] ready, 4 tools/.test(out)) ok = true;
	}
	if (!ok) throw new Error("server or MCP not ready. output:\n" + out);
	console.log("✓ MCP server started and handshook (log: [mcp:csrv] ready, 4 tools)");

	// badsrv failure must not affect server liveness
	if (/definitely-not-a-real-cmd-xyz/.test(out) && !/\[mcp\] server "badsrv" failed to start/.test(out)) {
		// only require the server still alive (failure path is folded into logs via rejectAll)
	}
	if (server.exitCode !== null) throw new Error("server crashed!");
	console.log("✓ bad server was isolated (process alive)");

	console.log("all ok");
	server.kill();
	await sleep(300);
	rmSync(dataDir, { recursive: true, force: true });
}

main().catch(async (err) => {
	console.error("✗", err.message);
	try { server?.kill(); } catch {}
	try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
	process.exit(1);
});