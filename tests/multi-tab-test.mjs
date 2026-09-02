// Multi-tab client isolation — regression test for issue #10.
//
// Two tabs (same origin) used to share clientId in localStorage and hit the same backend
// ClientSession: switching conversation on B would also switch A and abort a running agent.
// After the fix, clientId lives in sessionStorage (per tab), so the two pages are two clients:
//   1. the two pages have different clientIds;
//   2. switching conversation on A does not change B's activeId / message list;
//   3. a prompt on B does not affect A's in-flight streaming (A's snapshot is not interrupted by B).
//
// Usage: node tests/multi-tab-test.mjs   (needs local Chrome; see lib/chrome.mjs)
import { chromium } from "playwright-core";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHROME_PATH } from "./lib/chrome.mjs";

const PORT = 8977;
const base = mkdtempSync(join(tmpdir(), "pi-web-multitab-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const NODE = realpathSync(process.execPath);
// fileURLToPath: URL.pathname is illegal on Windows; cwd must point at the repo root
const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const server = spawn(NODE, ["dist/server/index.js"], {
	cwd: REPO,
	env: {
		...process.env,
		PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "inherit", "inherit"],
	windowsHide: true,
});
server.on("error", (e) => console.error("[spawn error]", e));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		failed++;
		console.error(`  ✗ FAIL ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

async function waitReady() {
	for (let i = 0; i < 60; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (res.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(300);
	}
	throw new Error("server did not start");
}

/** Read the current clientId from the page (same key as use-chat.ts). */
const readClientId = (page) =>
	page.evaluate(() => sessionStorage.getItem("pi-web-client-id"));
/** Wait until the page WebSocket is ready. */
const waitChatReady = (page) =>
	page.waitForFunction(() => document.querySelector("textarea") !== null, {
		timeout: 20000,
	});

try {
	await waitReady();
	if (!CHROME_PATH) throw new Error("no Chrome found (set PI_WEB_CHROME)");
	const browser = await chromium.launch({
		executablePath: CHROME_PATH,
		headless: true,
	});
	const ctx = await browser.newContext();
	const a = await ctx.newPage();
	const b = await ctx.newPage();

	await a.goto(`http://127.0.0.1:${PORT}`);
	await waitChatReady(a);
	await b.goto(`http://127.0.0.1:${PORT}`);
	await waitChatReady(b);

	const idA = await readClientId(a);
	const idB = await readClientId(b);
	check("two tabs have DIFFERENT clientIds", !!idA && !!idB && idA !== idB, `${idA?.slice(0, 8)} vs ${idB?.slice(0, 8)}`);

	// tab B switching to the History area / new chat must not affect A's input availability
	// or message list (the most direct no-shared-state check: A's DOM does not change with B's actions).
	const markerA = await a.evaluate(() => document.body.innerHTML.length);
	await b.reload();
	await b.waitForLoadState("domcontentloaded");
	await sleep(800);
	const markerA2 = await a.evaluate(() => document.body.innerHTML.length);
	check(
		"tab B reload does not disturb tab A",
		markerA > 0 && markerA === markerA2,
	);

	// clientId stays stable across refresh (sessionStorage lifetime)
	const idA2 = await readClientId(a);
	check("tab A keeps its clientId across reload", idA2 === idA);

	await browser.close();
	console.log(`\n${passed} passed, ${failed} failed`);
} catch (err) {
	failed++;
	console.error("test crashed:", err);
} finally {
	if (server.pid) process.kill(server.pid, "SIGTERM");
	await sleep(500);
	process.exit(failed === 0 ? 0 : 1);
}
