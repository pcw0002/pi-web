/* Terminal liveness watchdog unit-level regression: instantiate TerminalManager
 * directly (real PTY, but no server, no tokens) and verify with a small threshold:
 *   1. a user-opened terminal (no noteAgentActivity) never fires an idle reminder;
 *   2. a terminal the agent touched, idle ≥ threshold, fires onAgentIdle once;
 *   3. one-shot: stays silent after firing, re-arms only when the agent touches again;
 *   4. output/input within the epoch resets the countdown;
 *   5. after the terminal exits the watchdog is disarmed (does not fire).
 * Run:  npm run build:server && node tests/terminal-idle-test.mjs */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Small threshold to speed the test; armIdleWatch reads env on each call, so inject takes effect immediately.
process.env.PI_WEB_TERMINAL_IDLE_MS = "700";

const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const { TerminalManager } = await import(join(REPO, "dist", "server", "terminals.js"));

const workdir = mkdtempSync(join(tmpdir(), "piweb-term-idle-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

function makeManager(events) {
	const mgr = new TerminalManager(() => {}, workdir);
	mgr.onAgentIdle = (terminalId, idleMs, title) => {
		events.push({ terminalId, idleMs, title, at: Date.now() });
	};
	return mgr;
}

try {
	// ---- 1. user-opened terminal: no agent touch → does not fire ----
	{
		const events = [];
		const mgr = makeManager(events);
		check("user terminal created", mgr.create("user-term", workdir, 80, 24, workdir) !== null);
		await sleep(1200);
		check("user terminal idle 1.2s does not fire a reminder", events.length === 0);
		mgr.killAll();
	}

	// ---- 2+3. agent touch: fires once; stays silent; touch again re-arms ----
	{
		const events = [];
		const mgr = makeManager(events);
		mgr.create("agent-term", workdir, 80, 24, workdir);
		mgr.noteAgentActivity("agent-term");
		const t0 = Date.now();
		// wait for the first fire (threshold 700ms + slack)
		for (let i = 0; i < 40 && events.length === 0; i++) await sleep(50);
		check("agent terminal fires a reminder after idle", events.length === 1);
		if (events.length === 1) {
			check("reminder comes from the correct terminal", events[0].terminalId === "agent-term");
			check("idleMs ≥ threshold", events[0].idleMs >= 650);
			check("idleMs is reasonable (<3s)", events[0].idleMs < 3000);
			check("fires at or after the threshold", events[0].at - t0 >= 650);
		}
		// stay idle another threshold+: one-shot, must not fire again
		await sleep(1100);
		check("one-shot: staying idle does not re-fire", events.length === 1);
		// agent touches again (e.g. more input) → new epoch, fires once more
		mgr.noteAgentActivity("agent-term");
		for (let i = 0; i < 40 && events.length < 2; i++) await sleep(50);
		check("after another agent touch, re-arms and fires a second time", events.length === 2);
		mgr.killAll();
	}

	// ---- 4. output within the epoch resets the countdown ----
	{
		const events = [];
		const mgr = makeManager(events);
		mgr.create("reset-term", workdir, 80, 24, workdir);
		mgr.noteAgentActivity("reset-term");
		// produce a chunk of output every 300ms, 3 times (900ms total > 700ms threshold)
		for (let i = 0; i < 3; i++) {
			await sleep(300);
			// go through the internal output path: simulate shell output (appendOutput is private; inputChecked+
			// echo is too slow — the public read/waitForOutput path is not usable here; instead noteAgent
			// stays put and we feed output via the equivalent entry: inputChecked resets the countdown, same semantics).
			mgr.inputChecked("reset-term", "");
		}
		await sleep(500); // only 500ms since last activity < 700ms
		check("activity keeps resetting the countdown → does not fire within the threshold", events.length === 0);
		await sleep(600); // now past the threshold since last activity
		check("still fires normally after activity stops", events.length === 1);
		mgr.killAll();
	}

	// ---- 5. disarm after exit ----
	{
		const events = [];
		const mgr = makeManager(events);
		mgr.create("exit-term", workdir, 80, 24, workdir);
		mgr.inputChecked("exit-term", "exit\r");
		// wait for the shell to actually exit (onExit disarms), then touching the exited terminal should be a no-op
		for (let i = 0; i < 60; i++) {
			await sleep(50);
			if (!mgr.list().find((t) => t.id === "exit-term")?.running) break;
		}
		mgr.noteAgentActivity("exit-term"); // already exited → no-op, does not arm
		await sleep(1100);
		check("does not fire an idle reminder after the terminal exits", events.length === 0);
		mgr.killAll();
	}

	console.log(`\n${passed} checks passed${process.exitCode ? " (failures)" : ""}`);
} finally {
	rmSync(workdir, { recursive: true, force: true });
}
