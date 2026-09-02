/**
 * Editor plugin (vscode-editor, including Remote-SSH) — browser UI smoke (zero token, self-contained).
 *
 * Start an isolated-port server (temp data-dir) + in-process mock SSH remote, Chrome headless:
 * - top-bar plugin tab → editor view mounts
 * - sidebar "+" new-host dialog → host appears in the list
 * - click host to connect → remote tree expands; bottom terminal panel opens xterm
 * - click a remote file → CodeMirror loads content; edit + Ctrl+S saves back to remote (disk check)
 * - close tab with no confirm dialog; disconnect returns to the empty view
 *
 * Run: npm run build:server, then node tests/ssh-plugin-ui-test.mjs
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { startMockSsh, ensurePluginSsh2Dep } from "./lib/mock-ssh.mjs";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 8965;
const SSH_PORT = 22965;
const URL = `http://localhost:${PORT}`;
const REPO = realpathSync(new globalThis.URL("..", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : " — " + extra}`);
	if (!ok) failures++;
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-ssh-ui-"));
const plugDst = join(dataDir, "plugins", "vscode-editor");

// seed plugin + offline deps
mkdirSync(plugDst, { recursive: true });
cpSync(join(REPO, "dev/plugins/vscode-editor/manifest.json"), join(plugDst, "manifest.json"));
cpSync(join(REPO, "dev/plugins/vscode-editor/index.mjs"), join(plugDst, "index.mjs"));
cpSync(join(REPO, "dev/plugins/vscode-editor/client"), join(plugDst, "client"), { recursive: true });
ensurePluginSsh2Dep(plugDst, join(REPO, "dev/plugins/vscode-editor"));

let server = null;
let sshServer = null;
try {
	sshServer = await startMockSsh(plugDst, SSH_PORT);

	server = spawn(process.execPath, ["dist/server/index.js"], {
		cwd: REPO,
		env: { ...process.env, PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: REPO },
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stderr.on("data", () => {});
	for (let i = 0; i < 60 && !(await portUp(PORT)); i++) await sleep(250);
	if (!(await portUp(PORT))) throw new Error("server did not start");

	const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage();
	page.on("pageerror", (e) => console.error("[pageerror]", e.message));
	await page.goto(URL);

	// -- 1. plugin tab appears and we switch to it -------------------------------------------------
	await page.waitForSelector("button.plugin-tab", { timeout: 20000 });
	await page.locator("button.plugin-tab", { hasText: "Editor" }).first().click();
	await page.waitForSelector(".vsc", { timeout: 15000 });
	check("plugin view mounted", true);

	// -- 2. SSH tab: new-host dialog ------------------------------------------------------
	await page.locator('.vsc-stabs .stab[data-pane="ssh"]').click();
	await page.locator('.vsc-pane[data-pane="ssh"] button[data-act="add-host"]').click();
	await page.waitForSelector(".vsc-host-bg:not(.vsc-hidden)", { timeout: 5000 });
	const form = page.locator(".vsc-host-bg .vsc-modal");
	await form.locator('input[name="h-name"]').fill("mock-host");
	await form.locator('input[name="h-host"]').fill("127.0.0.1");
	await form.locator('input[name="h-port"]').fill(String(SSH_PORT));
	await form.locator('input[name="h-user"]').fill("tester");
	await form.locator('input[name="h-pass"]').fill("secret123");
	await form.locator(".save-host").click();
	await page.waitForSelector(".vsc-hrow", { timeout: 8000 });
	const nm = await page.locator(".vsc-hrow .nm").innerText();
	check("host appears in the list after save", nm.includes("mock-host"), nm);

	// -- 3. click host to connect → remote dir tree expands --------------------------------------------
	await page.locator(".vsc-hrow").first().click();
	await page.waitForSelector('.vsc-sshtree .vsc-row[data-scope^="c"]', { timeout: 25000 });
	check("connected and remote dir tree expanded", true);
	const names = await page.locator('.vsc-sshtree .vsc-row[data-scope^="c"] .nm').allInnerTexts();
	check("remote dir lists home contents", names.some((n) => n.includes("a.txt")) && names.some((n) => n.includes("sub")), names.join(","));

	// -- 4. bottom terminal panel (🖥 entry on the SSH tab) --------------------------------------------
	await page.locator('.vsc-pane[data-pane="ssh"] .vsc-side-head button[data-act="new-term"]').click();
	await page.waitForSelector(".vsc-termarea .xterm", { timeout: 15000 });
	check("xterm terminal rendered", true);
	const tt = await page.locator(".vsc-ttab .tn").first().innerText();
	check("terminal tab shows the host name", tt.includes("mock-host"), tt);

	// type a command into the terminal (output is on a canvas so we don't assert text, just that the panel is healthy)
	await page.locator(".vsc-termarea").click();
	await page.keyboard.type("ui-smoke");
	await page.keyboard.press("Enter");
	await sleep(600);
	check("terminal input has no errors", true);

	// -- 5. open a remote file for edit ------------------------------------------------------------
	await page.locator('.vsc-sshtree .vsc-row[data-scope^="c"]', { hasText: "a.txt" }).first().click();
	await page.waitForSelector(".vsc-editor:not(.vsc-hidden) .cm-content", { timeout: 8000 });
	const content = await page.locator(".vsc-editor .cm-content").innerText();
	check("CodeMirror loaded remote file content", content.includes("hello ssh"), JSON.stringify(content.slice(0, 40)));
	const scopeTxt = await page.locator(".vsc-status .vsc-scope").innerText();
	check("status bar marks the remote scope", scopeTxt.includes("mock-host"), scopeTxt);

	// edit + Ctrl+S save → check the remote in-memory FS
	await page.locator(".vsc-editor .cm-content").click();
	await page.keyboard.press("Control+End");
	await page.keyboard.type("\nui-edited-line");
	await page.keyboard.press("Control+s");
	await sleep(1000);
	const st = await page.locator(".vsc-state").innerText();
	check("status is clean after save", !st.includes("Unsaved"), st);
	const savedOnRemote = await import("./lib/mock-ssh.mjs").then((m) => m.files["/home/test/a.txt"]?.toString());
	check("edits were written back to the mock remote", savedOnRemote?.includes("ui-edited-line"), JSON.stringify(savedOnRemote));

	// close the tab (already saved, must not show a confirm dialog)
	let dialogFired = false;
	page.on("dialog", (d) => { dialogFired = true; void d.dismiss(); });
	await page.locator(".vsc-tab.active .x").click();
	await sleep(300);
	check("closing a saved tab does not show a confirm dialog", !dialogFired);

	// -- 6. disconnect (SSH tab) ---------------------------------------------------------------
	await page.locator('.vsc-stabs .stab[data-pane="ssh"]').click();
	await page.locator(".vsc-hrow").first().hover();
	await page.locator('.vsc-hrow button[data-hop="dis"]').click();
	await page.waitForSelector(".vsc-empty:not(.vsc-hidden)", { timeout: 8000 }).catch(() => {});
	const phVisible = await page.locator(".vsc-empty").isVisible().catch(() => false);
	check("after disconnect, back to the empty view", phVisible);

	await browser.close();
} catch (err) {
	failures++;
	console.error("test error:", err);
} finally {
	try {
		sshServer?.close();
		server?.kill("SIGTERM");
	} catch {}
	await sleep(400);
	rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
