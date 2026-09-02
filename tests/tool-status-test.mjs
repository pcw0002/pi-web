/**
 * tool_status smoke test — verifies the new tool_status (tool_execution_end)
 * message arrives the moment a bash command finishes, before the model's next
 * response lands. Runs against a throwaway server on port 9798.
 *
 * Usage: node tool-status-test.mjs
 */
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9798;
const URL = `ws://localhost:${PORT}/ws`;
const PROJ = fileURLToPath(new globalThis.URL("../", import.meta.url));

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

let server = null;
async function startServer() {
	server = spawn(process.execPath, ["dist/server/index.js"], {
		cwd: PROJ,
		env: {
			...process.env,
			PORT: String(PORT),
			// isolate cwd + client-state: never write into the real session store at the repo root;
			// historical snapshots will not contain old toolResults that would mess up ordering assertions.
			// (keep the agent dir — this test needs a real model to run the bash tool)
			PI_WEB_CWD: mkdtempSync(join(tmpdir(), "piweb-toolstatus-")),
			PI_WEB_DATA_DIR: mkdtempSync(join(tmpdir(), "piweb-toolstatus-data-")),
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		try {
			const ws = new WebSocket(URL);
			await new Promise((res, rej) => {
				ws.onopen = res;
				ws.onerror = () => rej(new Error("conn refused"));
			});
			ws.close();
			return true;
		} catch {
			/* not up yet */
		}
	}
	return false;
}
function stopServer() {
	if (server) {
		try {
			server.kill();
		} catch {
			/* noop */
		}
		server = null;
	}
}

async function main() {
	if (!(await startServer())) {
		console.log("✗ server did not start");
		process.exit(1);
	}
	console.log("server up");

	const ws = new WebSocket(URL);
	const msgs = [];
	const waiters = [];
	ws.onmessage = (ev) => {
		const msg = JSON.parse(ev.data);
		msgs.push(msg);
		for (const w of [...waiters]) w(msg);
	};
	const waitFor = (pred, timeoutMs = 120_000) =>
		new Promise((resolve, reject) => {
			const found = msgs.find(pred);
			if (found) return resolve(found);
			const timer = setTimeout(
				() => reject(new Error(`timeout waiting for message`)),
				timeoutMs,
			);
			const listener = (m) => {
				if (pred(m)) {
					clearTimeout(timer);
					const i = waiters.indexOf(listener);
					if (i >= 0) waiters.splice(i, 1);
					resolve(m);
				}
			};
			waiters.push(listener);
		});
	await new Promise((res, rej) => {
		ws.onopen = res;
		ws.onerror = () => rej(new Error("ws error"));
	});
	ws.send(JSON.stringify({ type: "hello", clientId: randomUUID() }));
	await waitFor((m) => m.type === "ready");
	console.log("ready");

	// Fire a prompt that should make the model run a fast bash command.
	ws.send(
		JSON.stringify({
			type: "prompt",
			text: "Run pwd and tell me the output exactly; do nothing else.",
		}),
	);

	// 1) tool_execution_end → tool_status must arrive.
	const status = await waitFor((m) => m.type === "tool_status", 120_000);
	check(
		"tool_status arrived",
		!!status.toolCallId && status.toolName.length > 0,
		`tool=${status.toolName} err=${status.isError} exit=${status.exitCode} dur=${status.durationMs}ms`,
	);
	check("tool_status carries durationMs", status.durationMs !== undefined);

	// 2) tool_status must arrive BEFORE the snapshot containing the toolResult
	//    (i.e. while the model is still chewing on the result).
	const toolResultSnapshot = await waitFor(
		(m) =>
			m.type === "snapshot" &&
			m.state.messages.some((mm) => mm.role === "toolResult"),
		120_000,
	);
	const statusIdx = msgs.indexOf(status);
	// only look at snapshots after tool_status — historical snapshots with old toolResults must not be compared
	const snapIdx = msgs.findIndex(
		(m, i) =>
			i > statusIdx &&
			m.type === "snapshot" &&
			m.state.messages.some((mm) => mm.role === "toolResult"),
	);
	check(
		"tool_status preceded the toolResult snapshot",
		statusIdx >= 0 && snapIdx > statusIdx,
		`status@${statusIdx} snapshot@${snapIdx}`,
	);

	// 3) The run must complete (agent settles → snapshot no longer streaming).
	//    Match the FIRST settled snapshot AFTER our turn (the initial empty
	//    snapshot is also !isStreaming).
	const settled = await waitFor(
		(m) =>
			m.type === "snapshot" &&
			!m.state.isStreaming &&
			m.state.messages.some((mm) => mm.role === "toolResult"),
		120_000,
	);
	check("run settled", !!settled);
	const toolResults = settled.state.messages.filter(
		(mm) => mm.role === "toolResult",
	);
	check("toolResult landed in final snapshot", toolResults.length > 0);
	if (status.exitCode !== undefined) {
		const same = toolResults.some(
			(mm) =>
				mm.toolCallId === status.toolCallId &&
				(mm.isError ?? false) === status.isError,
		);
		check("toolResult matches tool_status toolCallId", same);
	}

	ws.close();
	stopServer();
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("ERROR:", err.message);
	stopServer();
	process.exit(1);
});
