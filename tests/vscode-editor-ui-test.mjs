/**
 * vscode-editor plugin — browser UI smoke (zero token).
 *
 * Start an isolated-port server (temp data-dir + temp workspace), Chrome headless loads the page:
 * - top bar shows the 📝 plugin tab; click switches to the plugin view
 * - file tree renders workspace entries
 * - click a file → tab appears + CodeMirror editor has content
 * - edit + Ctrl+S → disk persist check
 *
 * Run: npm run build:server, then node tests/vscode-editor-ui-test.mjs
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = CHROME_PATH;
const PORT = 8968;
const URL = `http://localhost:${PORT}`;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : " — " + extra}`);
	if (!ok) failures++;
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-vsc-ui-"));
const workspace = join(dataDir, "ws");

// seed plugin + workspace
const plugDst = join(dataDir, "plugins", "vscode-editor");
mkdirSync(plugDst, { recursive: true });
const repo = new globalThis.URL("../", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");
cpSync(join(repo, "dev/plugins/vscode-editor/manifest.json"), join(plugDst, "manifest.json"));
cpSync(join(repo, "dev/plugins/vscode-editor/index.mjs"), join(plugDst, "index.mjs"));
cpSync(join(repo, "dev/plugins/vscode-editor/client"), join(plugDst, "client"), { recursive: true });
mkdirSync(join(workspace, "src"), { recursive: true });
writeFileSync(join(workspace, "README.md"), "# Hello\n");
writeFileSync(join(workspace, "src", "app.js"), "let n = 1;\n");
// CRLF line-ending file (common in Windows repos): regression for false "unsaved" right after open
writeFileSync(join(workspace, "src", "crlf.js"), "let a = 1;\r\nlet b = 2;\r\n");

let server = null;
try {
	server = spawn(process.execPath, ["dist/server/index.js"], {
		cwd: repo,
		env: { ...process.env, PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: workspace },
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
	for (let i = 0; i < 60 && !(await portUp(PORT)); i++) await sleep(250);
	if (!(await portUp(PORT))) throw new Error("server did not start");

	const browser = await chromium.launch({ executablePath: CHROME, headless: true });
	const page = await browser.newPage();
	page.on("pageerror", (e) => console.error("[pageerror]", e.message));
	await page.goto(URL);

	// wait for the plugin catalog (plugin tab appears in the top bar)
	await page.waitForSelector("button.plugin-tab", { timeout: 20000 });
	const tab = page.locator("button.plugin-tab", { hasText: "Editor" }).first();
	check("top bar shows the 📝 plugin tab", (await tab.count()) > 0);
	await tab.click();

	// view mounted + file tree rendered
	await page.waitForSelector(".vsc .vsc-tree .vsc-row", { timeout: 15000 });
	const rows = await page.locator(".vsc-row .nm").allInnerTexts();
	check("file tree renders the workspace root", rows.includes("src") && rows.includes("README.md"), rows.join(","));

	// expand directory
	await page.locator(".vsc-row", { hasText: "src" }).first().click();
	await sleep(400);
	check("expanding src shows app.js", (await page.locator(".vsc-row", { hasText: "app.js" }).count()) > 0);

	// click to open README.md → tab + CodeMirror content
	await page.locator(".vsc-row", { hasText: "README.md" }).first().click();
	await page.waitForSelector(".vsc-tab.active", { timeout: 10000 });
	check("tab appears and is active", (await page.locator(".vsc-tab.active .tn").innerText()).includes("README.md"));
	await page.waitForSelector(".vsc-editor .cm-content", { timeout: 10000 });
	const cmText = await page.locator(".vsc-editor .cm-content").innerText();
	check("editor loaded file content", cmText.includes("Hello"), cmText);
	const statusPath = await page.locator(".vsc-path").innerText();
	check("status bar shows the path", statusPath === "README.md", statusPath);

	// edit + Ctrl+S save → disk check
	await page.locator(".vsc-editor .cm-content").click();
	await page.keyboard.press("Control+End");
	await page.keyboard.type("\nedited-by-test\n");
	await page.keyboard.press("Control+s");
	await sleep(600);
	const onDisk = readFileSync(join(workspace, "README.md"), "utf-8");
	check("Ctrl+S save persisted to disk", onDisk.includes("edited-by-test"), JSON.stringify(onDisk));
	const stState = await page.locator(".vsc-state").innerText();
	check("status bar shows saved", stState.includes("Saved"), stState);
	const dirtyDot = await page.locator(".vsc-tab .dot").count();
	check("dirty marker gone after save", dirtyDot === 0, `dot=${dirtyDot}`);

	// CRLF regression: open an unmodified CRLF file and close it immediately; must not show an "unsaved" confirm
	let dialogFired = false;
	page.on("dialog", (d) => { dialogFired = true; void d.dismiss(); });
	await page.locator(".vsc-row", { hasText: "crlf.js" }).first().click();
	await sleep(400);
	await page.locator(".vsc-tab.active .x").click();
	await sleep(300);
	check("closing an unmodified CRLF file does not show a confirm dialog", !dialogFired);

	// after CRLF save, disk line endings are kept
	await page.locator(".vsc-row", { hasText: "crlf.js" }).first().click();
	await sleep(400);
	await page.locator(".vsc-editor .cm-content").click();
	await page.keyboard.press("Control+End");
	await page.keyboard.type("\nlet c = 3;");
	await page.keyboard.press("Control+s");
	await sleep(600);
	const crlfDisk = readFileSync(join(workspace, "src", "crlf.js"), "utf-8");
	check("CRLF file keeps \\r\\n endings after save", crlfDisk.includes("let c = 3;") && !/(?<!\r)\n/.test(crlfDisk), JSON.stringify(crlfDisk));

	// Ctrl+P quick open
	await page.keyboard.press("Control+p");
	await page.waitForSelector(".vsc-quickopen input", { timeout: 5000 });
	await page.locator(".vsc-quickopen input").fill("app");
	await sleep(300);
	await page.keyboard.press("Enter");
	await sleep(500);
	const activeTab = await page.locator(".vsc-tab.active .tn").innerText().catch(() => "");
	check("Ctrl+P quick-opened app.js", activeTab.includes("app.js"), activeTab);

	await browser.close();
} catch (err) {
	failures++;
	console.error("test error:", err);
} finally {
	try {
		server?.kill("SIGTERM");
	} catch {}
	await sleep(400);
	rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
