/* Terminal-backed bash tool regression: instantiate TerminalManager +
 * makeTerminalBashTool directly (real PTY, no server, zero token):
 *   1. pure functions: buildTerminalBashLine single/multi-line, stripAnsi;
 *   2. blocking semantics: a fast echo waits for the sentinel and returns full output + real exit code;
 *   3. multi-line scripts (eval $'...' escape path) execute correctly;
 *   4. silent unblock: after idle-threshold with no output, return running:true immediately; when
 *      the command finishes in the background, notifyBackgroundDone reports the exit code;
 *   5. shell state is kept across calls (pwd after cd stays — native bash cannot do this);
 *   6. abort_bash: abort while blocked → Ctrl+C kills the foreground process, returns quickly.
 * Run:  npm run build:server && node tests/terminal-bash-test.mjs */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const { TerminalManager, makeTerminalBashTool, makePersistentTerminalTools, buildTerminalBashLine, stripAnsi } =
	await import(join(REPO, "dist", "server", "terminals.js"));

const workdir = mkdtempSync(join(tmpdir(), "piweb-tbash-"));
mkdirSync(join(workdir, "subdir"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const check = (name, cond, extra = "") => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name} ${extra}`);
		process.exitCode = 1;
	}
};

// ---- 1. pure functions ----
{
	const line = buildTerminalBashLine("ls -la");
	check("single-line command appends the sentinel sequence", line.includes("ls -la") && line.includes("[pi-exit:%s]") && line.includes("__pi_rc=$?"));
	const ml = buildTerminalBashLine("for i in 1 2\ndo\n echo $i\ndone");
	check("multi-line script is wrapped in eval $'...'", ml.startsWith("eval $'") && ml.includes("\\n") && !ml.includes("\n"));
	check("multi-line script is still one physical input line", !ml.includes("\n"));
	const stripped = stripAnsi("\x1b[31m红\x1b[0m\x1b]0;title\x07文\r\nx\ry");
	check("stripAnsi strips color/OSC/orphan CR", stripped === "红文\r\nxy");
}

const mgr = new TerminalManager(() => {}, workdir);
let bgDone = null;
let idleMsOverride = 0; // default: never silent-unblock (pure blocking); some cases inject a small threshold
const tool = makeTerminalBashTool(mgr, {
	cwd: workdir,
	idleMs: () => idleMsOverride,
	kills: new Set(),
	notifyBackgroundDone: (info) => {
		bgDone = info;
	},
});

// take terminal_wait from the persistent terminal tool set (re-block after unblock until done, no polling)
const persistentTools = makePersistentTerminalTools(mgr, workdir);
const waitTool = persistentTools.find((t) => t.name === "terminal_wait");
check("terminal_wait is registered", waitTool !== undefined);

async function run(commandOrParams, timeout) {
	const params =
		typeof commandOrParams === "string"
			? { command: commandOrParams }
			: { ...commandOrParams };
	if (timeout) params.timeout = timeout;
	let result, error;
	try {
		result = await tool.execute("t1", params, undefined);
	} catch (e) {
		error = e;
	}
	return { result, error };
}

try {
	// ---- 2. blocking semantics: fast command returns output + exit code ----
	{
		const t0 = Date.now();
		const { result, error } = await run("echo hello-tbash");
		check("echo completes with no error", !error);
		const text = result?.content?.[0]?.text ?? "";
		check("output includes the command result", text.includes("hello-tbash"), JSON.stringify(text));
		check("exit code 0", /\[exit:0\]$/.test(text.trim()));
		check("does not contain sentinel text or echo markers", !text.includes("__pi_rc") && !text.includes("pi-exit"));
		check("blocked until the command actually finished", Date.now() - t0 >= 50);
	}
	{
		const { result } = await run("sh -c 'exit 3'");
		check("non-zero exit code is passed through", /\[exit:3\]/.test(result?.content?.[0]?.text ?? ""));
	}

	// ---- 3. multi-line script ----
	{
		const script = "for i in a b c\ndo\n echo item=$i\ndone";
		const { result } = await run(script);
		const text = result?.content?.[0]?.text ?? "";
		check(
			"multi-line script runs and collects all output",
			text.includes("item=a") && text.includes("item=b") && text.includes("item=c"),
			JSON.stringify(text),
		);
	}

	// ---- 3b. tail param: return only the last N lines (replaces a | tail pipe)----
	{
		const { result } = await run({ command: "seq 1 30", tail: 5 });
		const text = result?.content?.[0]?.text ?? "";
		const numLines = text
			.split("\n")
			.filter((l) => /^\d+$/.test(l.trim()))
			.map((l) => l.trim())
			.join(",");
		check(
			"tail:5 keeps only the last 5 lines (26–30)",
			numLines === "26,27,28,29,30",
			JSON.stringify(text),
		);
		const full = await run("seq 1 30");
		const fullLines = (full.result?.content?.[0]?.text ?? "")
			.split("\n")
			.filter((l) => /^\d+$/.test(l.trim())).length;
		check("without tail, all 30 lines are returned", fullLines === 30);
	}

	// ---- 4. silent unblock + completion notice ----
	{
		idleMsOverride = 500;
		bgDone = null;
		const t0 = Date.now();
		const { result } = await run("echo started-bg; sleep 1.5; echo finished-bg");
		const elapsed = Date.now() - t0;
		const text = result?.content?.[0]?.text ?? "";
		check("silent unblock: returns early without blocking", elapsed < 1400, `${elapsed}ms`);
		check("returns still-running explanation", text.includes("still running in persistent terminal ai-bash"));
		check("returns the partial output so far", text.includes("started-bg"));
		check("details marks running", result?.details?.running === true);
		// wait until the background command actually finishes → notifyBackgroundDone
		for (let i = 0; i < 60 && !bgDone; i++) await sleep(100);
		check("completion callback fires", bgDone !== null);
		if (bgDone) {
			check("notice carries the correct exit code", bgDone.exitCode === 0);
			check("notice carries the original command", typeof bgDone.command === "string" && bgDone.command.includes("sleep"));
		}
		idleMsOverride = 0;
		await sleep(300); // wait for the shell prompt to settle
	}

	// ---- 4b. terminal_wait: re-block after unblock until done, no polling ----
	{
		idleMsOverride = 500;
		mgr.kill("ai-bash"); // fresh terminal, drop leftover from the previous case
		await run("echo w-start; sleep 2.5; echo w-end"); // silent-unblock return
		const t0 = Date.now();
		let wr = null;
		try {
			wr = await waitTool.execute("tw", { terminalId: "ai-bash", maxWaitMs: 8000 });
		} catch (e) {
			wr = { error: e };
		}
		const parsed = JSON.parse(wr?.content?.[0]?.text ?? "{}");
		check("terminal_wait blocks until the command actually finished", parsed.finished === true && Date.now() - t0 >= 1200);
		check("terminal_wait got exit code 0", parsed.exitCode === 0);
		check("terminal_wait includes output from the wait", (parsed.outputTail ?? "").includes("w-end"));
		// explicit cursor=0: existing sentinel can match (pre-scan path); should return immediately, not idle-wait
		const t2 = Date.now();
		const wr2 = JSON.parse(
			(await waitTool.execute("tw2", { terminalId: "ai-bash", cursor: 0, maxWaitMs: 3000 }))?.content?.[0]?.text ?? "{}",
		);
		check("pre-scan of an existing sentinel returns immediately", wr2.finished === true && Date.now() - t2 < 1500);
		// timeout path: wait on a silent command that will not finish
		await run("sleep 5");
		const t1 = Date.now();
		const wr3 = JSON.parse(
			(await waitTool.execute("tw3", { terminalId: "ai-bash", maxWaitMs: 800 }))?.content?.[0]?.text ?? "{}",
		);
		check("timeout returns finished:false and elapsed ≈ threshold", wr3.finished === false && Date.now() - t1 >= 700 && Date.now() - t1 < 2500);
		idleMsOverride = 0;
		await sleep(5500); // let sleep 5 finish so it does not pollute later cases
	}

	// ---- 4c. terminal_wait on an idle terminal: return immediately with an explanation, do not hang ----
	{
		idleMsOverride = 0;
		mgr.kill("ai-bash");
		await run("echo idle-probe"); // completes normally → sentinel consumed, no pending command
		const t3 = Date.now();
		const wr4 = JSON.parse(
			(await waitTool.execute("tw4", { terminalId: "ai-bash", maxWaitMs: 60000 }))?.content?.[0]?.text ?? "{}",
		);
		check(
			"idle-terminal terminal_wait returns immediately with applicable:false",
			wr4.applicable === false && Date.now() - t3 < 1500,
			JSON.stringify(wr4),
		);
	}

	// ---- 5. shell state kept across calls ----
	{
		await run("cd subdir");
		const { result } = await run("pwd");
		check("cd state is kept for the next call", (result?.content?.[0]?.text ?? "").includes("subdir"));
		await run(`cd "${workdir}"`);
	}

	// ---- 6. abort_bash (abort while blocked)----
	{
		mgr.kill("ai-bash"); // fresh terminal, ensure no leftover foreground process
		const kills = new Set();
		const abortTool = makeTerminalBashTool(mgr, {
			cwd: workdir,
			idleMs: () => 0, // never unblock → abort is the only way out
			kills,
			notifyBackgroundDone: () => {},
		});
		const execPromise = abortTool.execute("t2", { command: "sleep 30" }, undefined);
		await sleep(700); // let the command start first
		for (const ac of [...kills]) ac.abort();
		const t0 = Date.now();
		let abortedErr = null;
		try {
			await execPromise;
		} catch (e) {
			abortedErr = e;
		}
		check("returns quickly after abort", abortedErr !== null && Date.now() - t0 < 2000);
		check("reports Command aborted", /aborted/i.test(abortedErr?.message ?? ""));
		check("the terminal itself was not killed (session kept)", mgr.read("ai-bash", 0, 1)?.running !== false);
	}
} finally {
	mgr.killAll();
	await sleep(200);
	rmSync(workdir, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed${process.exitCode ? " (failures)" : ""}`);
