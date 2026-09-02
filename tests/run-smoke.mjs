#!/usr/bin/env node
/**
 * run-smoke.mjs — zero-token protocol smoke aggregator (shared by local and CI).
 *
 * Runs a set of self-starting *-test.mjs scripts in sequence (each with its own port +
 * temp data-dir, cleaned up at the end). A failure does not stop later scripts; a
 * summary is printed and we exit non-zero if any failed.
 *
 * Scripts not on the list, and why:
 *   - browser E2E (playwright/chromium, path hard-coded to this machine): *-browser*, scm-test,
 *     freeze, goal-pill/ui/rounds, panel/left/sound/settings-ui, etc. → run locally by hand;
 *   - live with a real model: goal-review-loop, live-test (needs a running server), update-test.
 *
 * Usage: node tests/run-smoke.mjs [name1 name2 …]   # no args = full set
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Known local Windows failures (not logic bugs; ubuntu CI is fine):
//   - terminal-smoke-test: under ConPTY, node-pty shell-exit events / console-list agent
//     (AttachConsole failed) behave differently, so exit-detection checks time out;
//   - restart-handoff-test: after all assertions pass, libuv asserts on named-pipe close
//     in win\\async.c (exit 127) — a libuv close-timing issue.
const WIN32_KNOWN_ENV_FAIL = new Set(["terminal-smoke-test", "restart-handoff-test"]);

const ALL = [
	"clear-provider-key-test",
	"conv-cwd-test",
	"db-client-test",
	"fetch-models-test",
	"global-search-test",
	"goal-prefs-test",
	"goal-test",
	"left-panel-delete-test",
	"plugin-bgtask-test",
	"plugin-command-test",
	"plugin-cwd-test",
	"plugin-http-test",
	"mcp-bridge-test",
	"plugin-settings-test",
	"plugin-test",
	"plugin-update-test",
	"preview-test",
	"quiesce-test",
	"recursive-watch-test",
	"refresh-models-test",
	"restart-handoff-test",
	"scm-features-test",
	"settings-test",
	"slash-commands-test",
	"snapshot-delta-test",
	"ssh-plugin-test",
	"steer-queue-smoke",
	"terminal-smoke-test",
	"vision-bridge-test",
	"vscode-editor-plugin-test",
];

// Scripts not on the default list:
//   - need an already-running external server (attach-style, default 8787): ws-session-test /
//     file-upload-test / image-paste-test / commands-test(8791) /
//     edit-reask-test / projects-test — start a server locally, then run them separately;
//   - need a real model (runnable locally; CI without creds will fail): goal-abort-test /
//     goal-autostart-test / goal-wizard-test / goal-wizard-cancel-test /
//     tool-status-test (needs a real model to run the bash tool; runnable from repo root or any dir);
//   - platform-specific: spawn-helper-test (macOS spawn-helper binary); on win32
//     terminal-smoke / restart-handoff are skipped automatically (see WIN32_KNOWN_ENV_FAIL);
//   - title-jsonl-test: fixed (was a Windows lsof/URL.pathname compat issue), runnable locally;
//   - browser E2E: see the file-header comment (headless Chrome path hard-coded to this machine).


const targets = process.argv.length > 2 ? process.argv.slice(2) : ALL;
const results = [];

for (const name of targets) {
	if (process.platform === "win32" && WIN32_KNOWN_ENV_FAIL.has(name) && process.argv.length <= 2) {
		results.push({ name, ok: true, skipped: true });
		console.log(`\n⏭ ${name} — known Windows env noise (node-pty/libuv), skipped; ubuntu CI runs it`);
		continue;
	}
	const file = join(here, `${name}.mjs`);
	process.stdout.write(`\n▶ ${name}\n`);
	const ok = await new Promise((resolveRun) => {
		const child = spawn(process.execPath, [file], {
			// relative paths inside the test script (e.g. dist/server/index.js) are relative to the repo root
			cwd: dirname(here),
			stdio: "inherit",
			env: process.env,
		});
		child.on("exit", (code) => resolveRun(code === 0));
		child.on("error", () => resolveRun(false));
	});
	results.push({ name, ok });
}

console.log("\n===== smoke summary =====");
let failures = 0;
for (const r of results) {
	console.log(`${r.skipped ? "⏭" : r.ok ? "✓" : "✗"} ${r.name}${r.skipped ? " (skipped)" : ""}`);
	if (!r.ok) failures++;
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
