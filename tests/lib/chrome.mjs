/**
 * Chrome executable discovery for browser E2E tests.
 * Paths are no longer hard-coded to one machine (the old constant was a macOS-only playwright cache path):
 * 1. PI_WEB_CHROME env var wins;
 * 2. Probe common per-platform defaults and take the first that exists.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
	// playwright cache (all platforms)
	join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
	join(homedir(), "Library/Caches/ms-playwright/chrome-headless-shell-1228/chrome-headless-shell"),
	join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell"),
	// Windows / macOS / Linux system Chrome
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium-browser",
	"/usr/bin/chromium",
];

export const CHROME_PATH =
	process.env.PI_WEB_CHROME ?? CANDIDATES.find((p) => existsSync(p)) ?? "";
