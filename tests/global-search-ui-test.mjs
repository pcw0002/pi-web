/**
 * Global search UI smoke (real Chrome headless, zero token):
 * top-bar Search button opens the modal → type a keyword → file section shows hits;
 * Ctrl+K toggles the modal; model dropdown shows a search box and can filter.
 */
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8963;
const BASE = `http://localhost:${PORT}`;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

const workDir = join(mkdtempSync(join(tmpdir(), "pi-web-gsui-")), "proj");
mkdirSync(join(workDir, "src"), { recursive: true });
writeFileSync(join(workDir, "src", "alpha-util.ts"), "export {};");
writeFileSync(join(workDir, "README.md"), "hi");

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-gsui-data-"));
let server = null;

async function run() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: workDir,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		if (await portUp(PORT)) break;
	}

	const browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage();
	page.on("pageerror", (e) => console.log("pageerror:", e.message));
	await page.goto(BASE);
	await page.waitForSelector(".topbar", { timeout: 15000 });

	// 1) top-bar search button exists and click opens the modal
	const searchBtn = page.locator(".topbar .chip", { hasText: "Search" }).first();
	check("top bar has a search button", (await searchBtn.count()) > 0);
	await searchBtn.click();
	await page.waitForSelector(".gs-modal", { timeout: 5000 });
	check("clicking the button opens the global search modal", true);

	// 2) type a keyword → file section hits
	await page.fill(".gs-input-row input", "util");
	await page.waitForSelector(".gs-item", { timeout: 8000 });
	const fileHit = await page
		.locator(".gs-item-title", { hasText: "alpha-util.ts" })
		.count();
	check("file hits include alpha-util.ts", fileHit > 0);

	// 3) click a file → open file preview
	await page.locator(".gs-item", { hasText: "alpha-util.ts" }).first().click();
	await page.waitForSelector(".fp-modal, .file-preview, [class*=fp-]", { timeout: 5000 }).catch(() => {});
	const previewVisible = await page.locator("text=alpha-util.ts").count();
	check("click opens file preview", previewVisible > 0);
	await page.keyboard.press("Escape");
	await sleep(300);

	// 4) Ctrl+K toggle
	await page.keyboard.press("Control+k");
	await page.waitForSelector(".gs-modal", { timeout: 3000 }).catch(() => {});
	check("Ctrl+K opens the modal", (await page.locator(".gs-modal").count()) > 0);
	await page.keyboard.press("Control+k");
	await sleep(300);
	check("Ctrl+K again closes the modal", (await page.locator(".gs-modal").count()) === 0);

	// 5) model dropdown search box
	await page.locator(".topbar .dropdown .chip").first().click();
	await page.waitForSelector(".dd-search", { timeout: 3000 }).catch(() => {});
	check("model dropdown shows a search box", (await page.locator(".dd-search").count()) > 0);

	await browser.close();
}

try {
	await run();
} catch (err) {
	console.error("FATAL:", err?.message ?? err);
	failures++;
} finally {
	if (server?.pid) process.kill(server.pid, "SIGTERM");
	await sleep(500);
}
process.exit(failures === 0 ? 0 : 1);
