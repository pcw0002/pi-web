#!/usr/bin/env node
/**
 * pi-web-ui CLI.
 *
 *   pi-web-ui                              Start the production server (foreground, Ctrl+C to stop, opens the browser)
 *   pi-web-ui --port 9000 --cwd /path      Same, overriding port / workspace / data directory
 *   pi-web-ui --no-browser                 Start without opening the browser
 *   pi-web-ui --version | --help
 *   pi-web-ui server install [options]     Install a system service (starts on login) and start it
 *   pi-web-ui server shortcut [options]    Create a desktop "one-click start" icon (starts the server and opens the browser)
 *   pi-web-ui server uninstall [options]   Uninstall the system service (also removes the desktop icon)
 *   pi-web-ui server start|stop|restart|status [options]
 *   pi-web-ui install <source> [options]   Install a GitHub UI plugin (see --help)
 *   pi-web-ui plugins / uninstall <id>     List / uninstall UI plugins
 *
 * System service:
 *   - macOS   → launchd user agent, default label com.xingshuyin.pi-web-ui
 *              (com.<name>.server when --name is customized); no sudo needed
 *   - Linux   → systemd unit <name>.service (/etc/systemd/system/, auto sudo)
 *   - Windows → scheduled task (Task Scheduler / schtasks, starts at logon, no admin),
 *              hidden window (no black console); PowerShell launcher and task XML live in
 *              %APPDATA%\pi-web-ui\
 *
 * Environment (foreground and system service): PORT / PI_WEB_CWD / PI_WEB_DATA_DIR /
 * PI_CODING_AGENT_DIR.
 */
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { get as httpGet } from "node:http";
import {
	ensureBackup as ensurePluginBackup,
	restoreBackup as restorePluginBackup,
	checkPluginUpdates,
	resolveRemoteSha,
} from "../dist/server/plugin-updater.js";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
/** <pkg>/dist/server/index.js — the actual server entry. */
const SERVER_ENTRY = join(BIN_DIR, "..", "dist", "server", "index.js");
const NODE = process.execPath;
let pkg = { version: "0.0.0" };
try {
	pkg = JSON.parse(readFileSync(join(BIN_DIR, "..", "package.json"), "utf8"));
} catch {
	// version is best-effort — the server itself doesn't need it
}

const HELP = `pi-web-ui v${pkg.version} — web chat for the pi coding agent

Usage:
  pi-web-ui                               Start the server (foreground, Ctrl+C to stop, opens the browser)
  pi-web-ui --port 9000 --cwd /path       Start with a port / workspace / data directory
  pi-web-ui --no-browser                  Start without opening the browser
  pi-web-ui server install [options]      Install a system service (starts on login) and start it
  pi-web-ui server shortcut [options]     Create a desktop "one-click start" icon (starts the server and opens the browser)
  pi-web-ui server uninstall [options]    Uninstall the system service (also removes the desktop icon)
  pi-web-ui server start|stop|restart|status [options]
  pi-web-ui server quiesce [options]      Drain mode: reject new chats/messages/edits; in-flight work finishes
  pi-web-ui server unquiesce [options]    Leave drain mode and accept new work again
  pi-web-ui --version / --help

server options:
  --port <n>        Port (default 8787, or $PORT)
  --cwd <dir>       Workspace (default $PI_WEB_CWD or the current directory)
  --data-dir <dir>  Session data directory (default <cwd>/.pi-web)
  --name <name>     Service name (default pi-web-ui; macOS launchd label
                    is com.xingshuyin.pi-web-ui, or com.<name>.server when customized)
  --print           Print the generated config file without installing

Platforms: macOS → launchd user agent · Linux → systemd · Windows → scheduled task (schtasks)
      (Windows task starts on login, no admin required, hidden window; stop to stop, uninstall to remove)
Shortcuts: Windows → desktop .lnk · macOS → desktop .command launcher · Linux → desktop .desktop icon

UI plugins (install to <data-dir>/plugins/; refresh the browser while the server is running):
  pi-web-ui install <source>        Install a UI plugin from GitHub
  pi-web-ui uninstall <id>          Uninstall an installed UI plugin
  pi-web-ui plugins                 List installed UI plugins

  Source: owner/repo · https://github.com/owner/repo · local directory
          A URL with /tree/<branch>/<subdir> selects a branch and subdirectory;
          append #<branch-or-tag> on any form (e.g. owner/repo#v1.2)
  install options: --name <id> custom plugin directory name (default: repo name)
                   --data-dir <dir> data directory (default ~/.pi-web)
                   --force overwrite if the target already exists

Environment (foreground and system service):
  PORT / PI_WEB_CWD / PI_WEB_DATA_DIR / PI_CODING_AGENT_DIR
`;

/** Minimum Node required by the pi SDK (its dist uses `import … with { type: "json" }`). */
const NODE_MIN = [22, 19, 0];
function checkNodeVersion() {
	const v = process.versions.node.split(".").map(Number);
	const tooOld =
		v[0] < NODE_MIN[0] ||
		(v[0] === NODE_MIN[0] && v[1] < NODE_MIN[1]) ||
		(v[0] === NODE_MIN[0] && v[1] === NODE_MIN[1] && v[2] < NODE_MIN[2]);
	if (tooOld) {
		console.error(
			`✖ pi-web-ui requires Node.js >= ${NODE_MIN.join(".")} (current ${process.versions.node}).\n` +
				`  The pi SDK uses import attributes (with { type: "json" }), which older Node cannot parse.\n` +
				`  Upgrade Node at https://nodejs.org (or nvm-windows / fnm), then reinstall: npm i -g pi-web-ui`,
		);
		process.exit(1);
	}
}

function fail(msg) {
	console.error(`✖ ${msg}`);
	process.exit(1);
}

/** Run a command, inheriting stdio; exits on failure unless ignoreError. */
function run(cmd, args, { ignoreError = false, silent = false } = {}) {
	const res = spawnSync(cmd, args, {
		stdio: silent ? ["inherit", "ignore", "ignore"] : "inherit",
	});
	if (!ignoreError && res.status !== 0) process.exit(res.status ?? 1);
	return res;
}

/** Parse --flag value / --flag=value options; returns { opts, positionals }. */
function parseFlags(argv) {
	const opts = {
		port: undefined,
		cwd: undefined,
		dataDir: undefined,
		name: undefined,
		print: false,
		noBrowser: false,
		force: false,
		checkUpdates: false,
		rollback: undefined,
		help: false,
	};
	const positionals = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const eq = a.indexOf("=");
		const key = eq >= 0 ? a.slice(0, eq) : a;
		const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
		const take = (flag) => {
			if (inline !== undefined) return inline;
			if (i + 1 < argv.length) {
				i++;
				return argv[i];
			}
			fail(`missing value for ${flag}`);
		};
		switch (key) {
			case "--port":
				opts.port = take("--port");
				break;
			case "--cwd":
				opts.cwd = take("--cwd");
				break;
			case "--data-dir":
				opts.dataDir = take("--data-dir");
				break;
			case "--name":
				opts.name = take("--name");
				break;
			case "--print":
				opts.print = true;
				break;
			case "--no-browser":
				opts.noBrowser = true;
				break;
			case "--force":
				opts.force = true;
				break;
			case "--check-updates":
				opts.checkUpdates = true;
				break;
			case "--rollback":
				opts.rollback = take("--rollback");
				break;
			case "--help":
			case "-h":
				opts.help = true;
				break;
			default:
				if (key.startsWith("-")) fail(`unknown option: ${key}`);
				positionals.push(a);
		}
	}
	return { opts, positionals };
}

// ---------------------------------------------------------------------------
// Foreground start
// ---------------------------------------------------------------------------

/** Open a URL in the OS default browser; failures are ignored (best-effort). */
function openBrowser(url) {
	let res;
	if (isMac) {
		res = spawnSync("open", [url], { stdio: "ignore" });
	} else if (isWin) {
		res = spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
	} else {
		res = spawnSync("xdg-open", [url], { stdio: "ignore" });
	}
	// spawnSync does not throw: a missing opener (headless server) puts an error field on the result.
	if (res?.error) {
		if (res.error.code === "ENOENT") {
			console.warn(
				`[browser] no opener found (${res.error.path || "command not found"}); ` +
					"use --no-browser on a headless server to skip auto-open"
			);
		} else {
			console.warn("[browser] failed to open the browser:", res.error.message);
		}
	}
}

/**
 * Poll `url` until the server answers (or ~15s pass), then open it in the
 * default browser. The foreground server runs in this process, so the first
 * HTTP response is the "listening" signal; if the server crashes meanwhile
 * (e.g. port already taken), the pending timers die with the process and
 * nothing is opened.
 */
function openBrowserWhenUp(url) {
	const deadline = Date.now() + 15_000;
	const attempt = () => {
		const req = httpGet(url, (res) => {
			res.resume();
			console.log(`  🌐 opened browser: ${url} (--no-browser to skip)`);
			openBrowser(url);
		});
		req.setTimeout(1000, () => {
			req.destroy();
			if (Date.now() < deadline) setTimeout(attempt, 150);
		});
		req.on("error", () => {
			if (Date.now() < deadline) setTimeout(attempt, 150);
		});
	};
	attempt();
}

async function startForeground(opts) {
	if (opts.port) process.env.PORT = opts.port;
	if (opts.cwd) process.env.PI_WEB_CWD = resolve(opts.cwd);
	if (opts.dataDir) process.env.PI_WEB_DATA_DIR = resolve(opts.dataDir);
	const url = `http://localhost:${String(
		opts.port ?? process.env.PORT ?? "8787",
	)}`;
	await import(pathToFileURL(SERVER_ENTRY).href);
	if (!opts.noBrowser) openBrowserWhenUp(url);
}

// ---------------------------------------------------------------------------
// System service management
// ---------------------------------------------------------------------------

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin = process.platform === "win32";

function uid() {
	try {
		return userInfo().uid;
	} catch {
		return process.getuid?.() ?? 501;
	}
}

/** launchd label / systemd unit name / Windows task name for a service name. */
function serviceLabel(name) {
	if (isMac) {
		return name === "pi-web-ui"
			? "com.xingshuyin.pi-web-ui"
			: `com.${name}.server`;
	}
	return name;
}

function launchAgentPlist(name) {
	return join(
		homedir(),
		"Library",
		"LaunchAgents",
		`${serviceLabel(name)}.plist`,
	);
}

function systemdUnitPath(name) {
	return `/etc/systemd/system/${name}.service`;
}

/** Windows: per-user config dir (%APPDATA%\pi-web-ui) holding the .cmd wrapper + task XML. */
function winServiceDir() {
	return join(
		process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
		"pi-web-ui",
	);
}

function winCmdPath(name) {
	return join(winServiceDir(), `${name}.cmd`);
}

function winPs1Path(name) {
	return join(winServiceDir(), `${name}.ps1`);
}

function winTaskXmlPath(name) {
	return join(winServiceDir(), `${name}.xml`);
}

function winLogPath() {
	return join(homedir(), "pi-web-ui.log");
}

/** True when a scheduled task with this name exists (schtasks exits 0). */
function winTaskExists(name) {
	return (
		spawnSync("schtasks", ["/Query", "/TN", name], { stdio: "ignore" })
			.status === 0
	);
}

// ---------------------------------------------------------------------------
// Desktop shortcut (server shortcut)
// ---------------------------------------------------------------------------

const SHORTCUT_LNK_NAME = "pi-web-ui.lnk"; // Windows desktop shortcut
const SHORTCUT_MAC_NAME = "pi-web-ui.command"; // macOS double-click launcher
const SHORTCUT_LINUX_NAME = "pi-web-ui.desktop"; // Linux desktop icon

/** Shortcut icon (branded .ico, shipped with the package; .lnk / .desktop point at it). */
const APP_ICO_NAME = "pi-web-ui-logo.ico"; // Stable filename after copy into the user dir (avoid pi-web-ui.ico — Windows has a stale/corrupt icon cache for that path)
const APP_ICO_SOURCE = join(BIN_DIR, "..", "web", "public", "icon.ico"); // Packaged brand icon source (10 multi-resolution frames; DPI density frames keep desktop/taskbar colors sharp)
/** Branded SVG logo (source of truth: web/public/favicon.svg) — used on Linux. */
const APP_SVG_PACKAGE = join(BIN_DIR, "..", "web", "public", "favicon.svg");

/** Windows: per-user copy of the branded .ico (stable path for the .lnk icon). */
function winIcoPath() {
	return join(winServiceDir(), APP_ICO_NAME);
}

/** Full path to Windows PowerShell 5.1. */
function winPowershell() {
	return join(
		process.env.SystemRoot ?? "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
}


/** Full path to wscript.exe — a console-free host (no conhost window, so no black
 * console box ever appears in the taskbar on double-click). Used as the .lnk target;
 * it launches the .ps1 hidden via a thin VBS launcher. */
function winWscript() {
	return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
}

/**
 * Resolve the real node binary. fnm/volta/nvm shims (e.g. fnm_multishells)
 * point into temp dirs that vanish when the installing shell exits — the
 * baked-in launcher scripts must use the stable real path instead.
 */
function realNode() {
	try {
		return realpathSync(process.execPath);
	} catch {
		return process.execPath;
	}
}

/** Windows: launcher ps1 the desktop .lnk runs (hidden). */
function winShortcutPs1Path(name) {
	return join(winServiceDir(), `${name}-shortcut.ps1`);
}


/** Windows: launcher vbs the desktop .lnk actually runs (wscript.exe, console-free). */
function winShortcutVbsPath(name) {
	return join(winServiceDir(), `${name}-shortcut.vbs`);
}

/** Windows: PID file of a shortcut-started (no scheduled task) instance. */
function winPidFilePath(name) {
	return join(winServiceDir(), `${name}.pid`);
}

/** Read the recorded PID of a shortcut-started Windows instance. */
function winReadPid(name) {
	try {
		const pid = Number(readFileSync(winPidFilePath(name), "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/** True when a PID exists (signal 0; EPERM means exists but not ours). */
function pidAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
}

/** Single-quote a string for embedding in a POSIX shell script. */
function shQuote(s) {
	return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/**
 * Windows shortcut launcher. Double-click the .lnk → this script runs hidden:
 * server already up → just open the browser; scheduled task installed → start
 * it (manageable via `server stop`); otherwise run the server in the foreground
 * of this hidden window and record its PID so `server stop` / `server
 * uninstall` can terminate it too.
 */
function buildWinShortcutPs1(env, cwd, taskName, url, logPath, pidPath) {
	const sets = Object.entries(env)
		.map(([k, v]) => `$env:${k} = ${psQuote(v)}`)
		.join("\r\n");
	const node = realNode();
	return [
		"# Generated by: pi-web-ui server shortcut (rerun to change)",
		"# Runs hidden from the desktop shortcut: if the server is already up it",
		"# opens the browser; a scheduled task (if installed) is used; otherwise",
		"# the server runs in the foreground of this hidden window and its PID is",
		"# recorded so `server stop` / `server uninstall` can terminate it.",
		"$ErrorActionPreference = 'Continue'",
		`$url = ${psQuote(url)}`,
		`$health = ${psQuote(url + "/api/health")}`,
		`$taskName = ${psQuote(taskName)}`,
		`$pidFile = ${psQuote(pidPath)}`,
		`$log = ${psQuote(logPath)}`,
		"",
		"function Test-Up {",
		"  try { return (Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }",
		"}",
		"function Open-Browser { Start-Process $url | Out-Null }",
		"",
		"# Already running → just open the browser",
		"if (Test-Up) { Open-Browser; exit 0 }",
		"",
		"# Scheduled task installed → start the service (manageable via server stop)",
		"if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {",
		"  schtasks /Run /TN $taskName | Out-Null",
		"  for ($i = 0; $i -lt 120; $i++) {",
		"    Start-Sleep -Milliseconds 250",
		"    if (Test-Up) { Open-Browser; exit 0 }",
		"  }",
		"  Write-Host ('✖ pi-web-ui did not become ready within 30s; see the log: ' + $log)",
		"  exit 1",
		"}",
		"",
		"# No service installed → run in the foreground of this hidden window (record PID so server stop can terminate it)",
		`$PID | Out-File -Encoding ascii $pidFile`,
		sets,
		`Set-Location ${psQuote(cwd)}`,
		"# Poll in the background and open the browser when ready (in parallel with foreground node)",
		"$job = Start-Job -ScriptBlock { param($u)",
		"  $h = $u + '/api/health'",
		"  for ($i = 0; $i -lt 120; $i++) {",
		"    Start-Sleep -Milliseconds 250",
		"    try { if ((Invoke-WebRequest -Uri $h -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { Start-Process $u | Out-Null; break } } catch {}",
		"  }",
		"} -ArgumentList $url",
		`& ${psQuote(node)} ${psQuote(SERVER_ENTRY)} *>> $log`,
		"Remove-Item $pidFile -ErrorAction SilentlyContinue",
		"",
	].join("\r\n");
}


/**
 * Build the tiny VBS launcher the desktop .lnk invokes. Its purpose is purely to
 * start the .ps1 *without* creating any console host: wscript.exe has no console,
 * and WScript.Shell.Run(…, 0, False) launches the child hidden and returns at once
 * (0 = hidden window, False = don't wait). Result: double-clicking the icon never
 * flashes a black box and no leftover console appears in the taskbar.
 */
function buildWinShortcutVbs(ps1Path) {
	const cmd = `${winPowershell()} -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1Path}"`;
	// VBScript strings have no \" escape (and no \uXXXX); embedded quotes must be written as "";
	// JSON.stringify cannot be used — it emits \" which ends the VBScript string early (800A0401),
	// and turns non-ASCII paths into \uXXXX literals (wscript does not decode them, so Chinese usernames become garbage paths).
	const vbsCmd = cmd.replace(/"/g, '""');
	return [
		"Option Explicit",
		"Dim sh, cmd",
		"Set sh = CreateObject(\"WScript.Shell\")",
		`cmd = "${vbsCmd}"`,
		"sh.Run cmd, 0, False",
		"Set sh = Nothing",
		"",
	].join("\r\n");
}

/**
 * Create the Windows desktop .lnk via WScript.Shell COM (correct Desktop path
 * even with OneDrive redirection). Target is powershell.exe with
 * -WindowStyle Hidden so nothing flashes on double-click.
 */
function installWinShortcut(opts) {
	const { name, port, cwd, dataDir } = serviceOptions(opts);
	const env = serviceEnv(port, cwd, dataDir);
	const url = `http://localhost:${port}`;
	const ps1Path = winShortcutPs1Path(name);
	const ps1 = buildWinShortcutPs1(
		env,
		cwd,
		name,
		url,
		winLogPath(),
		winPidFilePath(name),
	);
	if (opts.print) {
		console.log(`# ${ps1Path}\n${ps1}`);
		return;
	}
	mkdirSync(dirname(ps1Path), { recursive: true });
	writeFileSync(ps1Path, "\uFEFF" + ps1, "utf8"); // PS 5.1 needs a BOM
	// wscript host + VBS launcher: no console window / taskbar black box on double-click.
	const vbsPath = winShortcutVbsPath(name);
	writeFileSync(vbsPath, "\uFEFF" + buildWinShortcutVbs(ps1Path), "utf16le"); // wscript only accepts UTF-16/ANSI; a UTF-8 BOM reports "invalid character"; utf16le + BOM keeps non-ASCII paths intact
	// Stage the brand icon: copy into the user dir (.lnk icon points at a stable path)
	if (existsSync(APP_ICO_SOURCE)) {
		copyFileSync(APP_ICO_SOURCE, winIcoPath());
	} else {
		console.log(`⚠ brand icon not found at ${APP_ICO_SOURCE}; the shortcut will use the default icon`);
	}
	const powershell = winPowershell();
	const ps = [
		"$ErrorActionPreference = 'Stop'",
		"$ws = New-Object -ComObject WScript.Shell",
		"$desktop = [Environment]::GetFolderPath('Desktop')",
		`$lnk = $ws.CreateShortcut((Join-Path $desktop ${psQuote(SHORTCUT_LNK_NAME)}))`,
		`$lnk.TargetPath = ${psQuote(winWscript())}`,
		`$lnk.Arguments = ${psQuote(vbsPath)}`,
		`$lnk.WorkingDirectory = ${psQuote(cwd)}`,
		"$lnk.Description = 'pi-web-ui — double-click to start the server and open the browser'",
		`$lnk.IconLocation = ${psQuote(winIcoPath())} + ',0'`,
		"$lnk.Save()",
		`Write-Output (Join-Path $desktop ${psQuote(SHORTCUT_LNK_NAME)})`,
	].join("\r\n");
	const res = spawnSync(
		powershell,
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			ps,
		],
		{ encoding: "utf8" },
	);
	if (res.status !== 0) {
		fail(`failed to create desktop shortcut: ${(res.stderr || res.stdout || "").trim()}`);
	}
	const lnk = (res.stdout ?? "").trim();
	console.log(`✅ created desktop shortcut: ${lnk}`);
	console.log(`   Double-click : starts the server if it is not running (hidden window, no black console) and opens the browser when ready`);
	console.log(`   Stop        : pi-web-ui server stop (also stops an instance started from the shortcut)`);
	console.log(`   Port      : ${port}`);
	console.log(`   Directory : ${cwd}`);
}

/** macOS: double-clickable .command launcher (the .lnk equivalent). */
function buildMacShortcut(label, plist, url, env) {
	const exports = Object.entries(env)
		.map(([k, v]) => `export ${k}=${shQuote(v)}`)
		.join("\n");
	const node = realNode();
	return `#!/bin/bash
# pi-web-ui launcher — generated by: pi-web-ui server shortcut
# Double-click: make sure the server is running, then open the browser.
#   · launchd service installed (starts at login) → kickstart; the icon is mainly "start + open"
#   · no service installed → run in the foreground of this terminal (closing the window stops it)
LABEL=${shQuote(label)}
PLIST=${shQuote(plist)}
URL=${shQuote(url)}
LOG=/tmp/pi-web-ui-shortcut.log
NODE=${shQuote(node)}
ENTRY=${shQuote(SERVER_ENTRY)}
${exports}

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart "gui/$(id -u)/$LABEL"
elif [ -f "$PLIST" ]; then
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  # No service installed: run the server in the foreground of this terminal (closing the window stops it)
  "$NODE" "$ENTRY" >>"$LOG" 2>&1 &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
fi

# Wait until the server is ready, then open the browser (up to ~30s)
for i in $(seq 1 120); do
  curl -sf "$URL/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
open "$URL"
if [ -n "\${SERVER_PID:-}" ]; then wait "$SERVER_PID"; fi
`;
}

function installMacShortcut(opts) {
	const { name, port, cwd, dataDir } = serviceOptions(opts);
	const url = `http://localhost:${port}`;
	const script = buildMacShortcut(
		serviceLabel(name),
		launchAgentPlist(name),
		url,
		serviceEnv(port, cwd, dataDir),
	);
	const path = join(homedir(), "Desktop", SHORTCUT_MAC_NAME);
	if (opts.print) {
		console.log(`# ${path}\n${script}`);
		return;
	}
	writeFileSync(path, script);
	chmodSync(path, 0o755);
	console.log(`✅ created desktop launcher: ${path}`);
	console.log(`   Double-click : make sure the server is running and open the browser; if no service is installed, runs in this terminal`);
	console.log(`   Note        : macOS has no Windows-style shortcut; this is the equivalent .command launcher;`);
	console.log(`                 the launchd service starts at login; the icon is mainly a quick "start + open browser"`);
	console.log(`   Port      : ${port}`);
	console.log(`   Directory : ${cwd}`);
}

/** Linux: launcher script run by the .desktop icon. */
function buildLinuxStartScript(unitName, url) {
	const log = join(homedir(), ".local", "share", "pi-web-ui", "pi-web-ui.log");
	const node = realNode();
	return `#!/bin/bash
# pi-web-ui launcher — generated by: pi-web-ui server shortcut
# Double-click: make sure the server is running, then open the browser.
#   · systemd unit installed → systemctl start (system units need authorization; falls back to foreground)
#   · not installed → run in the foreground of this process (closing the terminal stops it)
LOG=${shQuote(log)}
URL=${shQuote(url)}
NODE=${shQuote(node)}
ENTRY=${shQuote(SERVER_ENTRY)}
UNIT=${shQuote(unitName)}.service

if ! curl -sf "$URL/api/health" >/dev/null 2>&1; then
  systemctl start "$UNIT" 2>/dev/null || true
  if ! curl -sf "$URL/api/health" >/dev/null 2>&1; then
    mkdir -p "$(dirname "$LOG")"
    "$NODE" "$ENTRY" >>"$LOG" 2>&1 &
    SERVER_PID=$!
    trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
  fi
fi

for i in $(seq 1 120); do
  curl -sf "$URL/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
xdg-open "$URL" >/dev/null 2>&1 &
if [ -n "\${SERVER_PID:-}" ]; then wait "$SERVER_PID"; fi
`;
}

function installLinuxShortcut(opts) {
	const { name, port, cwd, dataDir } = serviceOptions(opts);
	const url = `http://localhost:${port}`;
	const scriptDir = join(homedir(), ".local", "share", "pi-web-ui");
	const scriptPath = join(scriptDir, `${name}-start.sh`);
	const desktopPath = join(homedir(), "Desktop", SHORTCUT_LINUX_NAME);
	const icoPath = join(scriptDir, APP_ICO_NAME); // fallback; SVG is preferred
	const svgPath = join(scriptDir, "pi-web-ui.svg");
	const script = buildLinuxStartScript(name, url);
	const desktopIcon = existsSync(APP_SVG_PACKAGE) ? svgPath : APP_ICO_NAME;
	const desktop = `[Desktop Entry]
Version=1.0
Type=Application
Name=pi-web-ui
Comment=Start the pi-web-ui server and open the browser
Exec=${shQuote(scriptPath)}
Icon=${shQuote(desktopIcon)}
Terminal=false
Categories=Network;WebBrowser;
`;
	if (opts.print) {
		console.log(`# ${scriptPath}\n${script}`);
		console.log(`# ${desktopPath}\n${desktop}`);
		return;
	}
	mkdirSync(scriptDir, { recursive: true });
	// Brand icon (skip if missing; the desktop falls back to a default icon)
	if (existsSync(APP_SVG_PACKAGE)) copyFileSync(APP_SVG_PACKAGE, svgPath);
	else if (existsSync(APP_ICO_SOURCE)) copyFileSync(APP_ICO_SOURCE, icoPath);
	writeFileSync(scriptPath, script);
	chmodSync(scriptPath, 0o755);
	writeFileSync(desktopPath, desktop);
	chmodSync(desktopPath, 0o755);
	// GNOME needs a trusted mark before double-click will run it
	run("gio", ["set", desktopPath, "metadata::trusted", "true"], {
		ignoreError: true,
		silent: true,
	});
	console.log(`✅ created desktop icon: ${desktopPath}`);
	console.log(`   If GNOME says "Untrusted application", right-click and choose Allow Launching`);
	console.log(`   Port      : ${port}`);
	console.log(`   Directory : ${cwd}`);
}

/** Remove desktop shortcut artifacts created by `server shortcut`. */
function removeShortcut(name) {
	if (isWin) {
		for (const f of [winShortcutPs1Path(name), winShortcutVbsPath(name), winPidFilePath(name), winIcoPath()]) {
			if (existsSync(f)) rmSync(f);
		}
		spawnSync(
			winPowershell(),
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				`$d=[Environment]::GetFolderPath('Desktop');$p=Join-Path $d ${psQuote(SHORTCUT_LNK_NAME)};if(Test-Path $p){Remove-Item $p -Force}`,
			],
			{ stdio: "ignore" },
		);
	} else if (isMac) {
		const p = join(homedir(), "Desktop", SHORTCUT_MAC_NAME);
		if (existsSync(p)) rmSync(p);
	} else if (isLinux) {
		const p = join(homedir(), "Desktop", SHORTCUT_LINUX_NAME);
		if (existsSync(p)) rmSync(p);
		rmSync(join(homedir(), ".local", "share", "pi-web-ui"), {
			recursive: true,
			force: true,
		});
	}
}

/** Single-quote a string for embedding in a generated PowerShell script. */
function psQuote(s) {
	return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Build the PowerShell launcher the scheduled task runs. Task Scheduler
 * launches it with -WindowStyle Hidden, so the console window is created
 * hidden (SW_HIDE) — no black cmd window stays open while the server runs,
 * and there is nothing to accidentally close/kill. The script sets the env,
 * cd's to the workspace, then runs node in the foreground with output
 * appended to the log, so the task instance IS the powershell process and
 * `schtasks /End` still stops the whole tree.
 */
function buildWinStartPs1(env, cwd, logPath) {
	const sets = Object.entries(env)
		.map(([k, v]) => `$env:${k} = ${psQuote(v)}`)
		.join("\r\n");
	return [
		"# Generated by: pi-web-ui server install (rerun to change)",
		"# Starts the server with a hidden console window (no black cmd box).",
		sets,
		`Set-Location ${psQuote(cwd)}`,
		`& ${psQuote(NODE)} ${psQuote(SERVER_ENTRY)} *>> ${psQuote(logPath)}`,
		"",
	].join("\r\n");
}

/**
 * Build the Task Scheduler XML for a user task: LogonTrigger (starts at logon,
 * like a launchd agent — no admin needed), InteractiveToken, auto-restart on
 * failure. The task runs the PowerShell launcher via
 * powershell.exe -WindowStyle Hidden, so no console window ever appears.
 */
function buildWinTaskXml(ps1Path, cwd) {
	const powershell = winPowershell();
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>pi-web-ui — web chat for the pi coding agent (auto-start at logon)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(powershell)}</Command>
      <Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${esc(ps1Path)}"</Arguments>
      <WorkingDirectory>${esc(cwd)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function esc(s) {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Build the launchd plist XML. */
function buildPlist(label, cwd, env) {
	const entries = Object.entries(env)
		.map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by: pi-web-ui server install (do not edit by hand — rerun to change) -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${esc(NODE)}</string>
    <string>${esc(SERVER_ENTRY)}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <!-- Restart if it crashes -->
  <key>KeepAlive</key>
  <true/>

  <key>WorkingDirectory</key>
  <string>${esc(cwd)}</string>

  <key>EnvironmentVariables</key>
  <dict>
${entries}
  </dict>

  <key>StandardOutPath</key>
  <string>/tmp/pi-web-ui.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/pi-web-ui.err</string>
</dict>
</plist>
`;
}

/** Build the systemd unit file. */
function buildUnit(cwd, env) {
	const envLines = Object.entries(env)
		.map(([k, v]) => `Environment=${k}=${v}`)
		.join("\n");
	return `# Generated by: pi-web-ui server install (do not edit by hand — rerun to change)
[Unit]
Description=pi-web-ui — web chat for the pi coding agent
After=network.target

[Service]
Type=simple
User=${process.env.SUDO_USER ?? userInfo().username}
WorkingDirectory=${cwd}
${envLines}
ExecStart=${JSON.stringify(NODE)} ${JSON.stringify(SERVER_ENTRY)}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

/** If not root on Linux, re-exec the same server command through sudo. */
function ensureRootForSystemctl() {
	if (typeof process.getuid === "function" && process.getuid() === 0) return;
	// process.argv = [node, <bin>, "server", <action>, ...rest] — forward
	// everything after "server" so flags like --port/--cwd survive.
	const res = spawnSync(
		"sudo",
		[NODE, fileURLToPath(import.meta.url), "server", ...process.argv.slice(3)],
		{ stdio: "inherit" },
	);
	process.exit(res.status ?? 1);
}

/** Shared option normalization for install. */
function serviceOptions(opts) {
	const name = opts.name ?? "pi-web-ui";
	const port = String(opts.port ?? process.env.PORT ?? "8787");
	if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
		fail(`invalid port: ${port}`);
	}
	const cwd = resolve(opts.cwd ?? process.env.PI_WEB_CWD ?? process.cwd());
	if (!existsSync(cwd)) fail(`workspace does not exist: ${cwd}`);
	let dataDir;
	if (opts.dataDir) {
		dataDir = resolve(opts.dataDir);
	} else if (process.env.PI_WEB_DATA_DIR) {
		dataDir = resolve(process.env.PI_WEB_DATA_DIR);
	}
	return { name, port, cwd, dataDir };
}

function serviceEnv(port, cwd, dataDir) {
	const env = {
		PORT: port,
		PI_WEB_CWD: cwd,
	};
	// Interactive Windows tasks inherit the user's PATH; only systemd/launchd
	// run with a minimal environment that needs an explicit PATH.
	if (!isWin) env.PATH = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
	// Same for the locale: launchd/systemd drop LANG/LC_ALL, and a C-locale
	// shell garbles multibyte input in the terminal (UTF-8 continuation
	// bytes 0x80–0x9F rendered as C1 control chars). Bake the installing
	// shell's locale into the service env so spawned terminals are UTF-8.
	if (!isWin && process.env.LANG) env.LANG = process.env.LANG;
	if (!isWin && process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;
	if (dataDir) env.PI_WEB_DATA_DIR = dataDir;
	return env;
}

function installLaunchd(opts) {
	const { name, port, cwd, dataDir } = serviceOptions(opts);
	const label = serviceLabel(name);
	const plist = launchAgentPlist(name);
	const content = buildPlist(label, cwd, serviceEnv(port, cwd, dataDir));
	if (opts.print) {
		console.log(`# ${plist}\n${content}`);
		return;
	}
	// Unload any existing instance (ignore "not loaded"), then (re)install.
	run("launchctl", ["bootout", `gui/${uid()}/${label}`], {
		ignoreError: true,
		silent: true,
	});
	mkdirSync(dirname(plist), { recursive: true });
	writeFileSync(plist, content);
	run("launchctl", ["bootstrap", `gui/${uid()}`, plist]);
	console.log(`✅ installed and started launchd service ${label}`);
	console.log(`   Port      : ${port}`);
	console.log(`   Directory : ${cwd}`);
	console.log(`   URL       : http://localhost:${port}`);
	console.log(`   Log       : /tmp/pi-web-ui.log  /tmp/pi-web-ui.err`);
	console.log(`   Manage    : pi-web-ui server status|restart|stop|uninstall`);
	console.log(`   Tip       : pi-web-ui server shortcut creates a desktop "one-click start" icon`);
}

function installSystemd(opts) {
	const { name, port, cwd, dataDir } = serviceOptions(opts);
	const content = buildUnit(cwd, serviceEnv(port, cwd, dataDir));
	const unitPath = systemdUnitPath(name);
	if (opts.print) {
		console.log(`# ${unitPath}\n${content}`);
		return;
	}
	ensureRootForSystemctl();
	writeFileSync(unitPath, content);
	run("systemctl", ["daemon-reload"]);
	run("systemctl", ["enable", "--now", `${name}.service`]);
	console.log(`✅ installed and started systemd service ${name}.service`);
	console.log(`   Port      : ${port}`);
	console.log(`   Directory : ${cwd}`);
	console.log(`   URL       : http://localhost:${port}`);
	console.log(`   Log       : journalctl -u ${name}.service -f`);
	console.log(`   Manage    : pi-web-ui server status|restart|stop|uninstall`);
	console.log(`   Tip       : pi-web-ui server shortcut creates a desktop "one-click start" icon`);
}

function uninstallLaunchd(opts) {
	const name = opts.name ?? "pi-web-ui";
	const label = serviceLabel(name);
	const plist = launchAgentPlist(name);
	run("launchctl", ["bootout", `gui/${uid()}/${label}`], {
		ignoreError: true,
		silent: true,
	});
	if (existsSync(plist)) rmSync(plist);
	removeShortcut(name);
	console.log(`🗑  uninstalled ${label} (plist removed, will not start at login)`);
	console.log(`🗑  removed desktop shortcut`);
}

function uninstallSystemd(opts) {
	const name = opts.name ?? "pi-web-ui";
	ensureRootForSystemctl();
	run("systemctl", ["disable", "--now", `${name}.service`], {
		ignoreError: true,
	});
	const unitPath = systemdUnitPath(name);
	if (existsSync(unitPath)) rmSync(unitPath);
	run("systemctl", ["daemon-reload"]);
	removeShortcut(name);
	console.log(`🗑  uninstalled ${name}.service (will not start at login)`);
	console.log(`🗑  removed desktop shortcut`);
}

function installWindows(opts) {
	const { name, port, cwd, dataDir } = serviceOptions(opts);
	const env = serviceEnv(port, cwd, dataDir);
	const ps1Path = winPs1Path(name);
	const xmlPath = winTaskXmlPath(name);
	const ps1 = buildWinStartPs1(env, cwd, winLogPath());
	const xml = buildWinTaskXml(ps1Path, cwd);
	if (opts.print) {
		console.log(`# ${ps1Path}\n${ps1}`);
		console.log(`# ${xmlPath}\n${xml}`);
		return;
	}
	mkdirSync(dirname(ps1Path), { recursive: true });
	// UTF-8 with BOM: Windows PowerShell 5.1 misreads BOM-less UTF-8 as ANSI.
	writeFileSync(ps1Path, "\uFEFF" + ps1, "utf8");
	// Remove the old-style .cmd wrapper from previous installs.
	if (existsSync(winCmdPath(name))) rmSync(winCmdPath(name));
	// schtasks /Create /XML requires a UTF-16 file (with BOM).
	writeFileSync(xmlPath, "\uFEFF" + xml, "utf16le");
	if (winTaskExists(name)) {
		run("schtasks", ["/Delete", "/TN", name, "/F"], {
			ignoreError: true,
			silent: true,
		});
	}
	run("schtasks", ["/Create", "/TN", name, "/XML", xmlPath, "/F"]);
	run("schtasks", ["/Run", "/TN", name], { ignoreError: true });
	console.log(`✅ installed and started scheduled task ${name} (hidden window, no black console)`);
	console.log(`   Port      : ${port}`);
	console.log(`   Directory : ${cwd}`);
	console.log(`   URL       : http://localhost:${port}`);
	console.log(`   Log       : ${winLogPath()}`);
	console.log(
		`   Note    : starts at logon (same as a launchd user agent); stop to stop, uninstall to remove`,
	);
	console.log(`   Manage    : pi-web-ui server status|restart|stop|uninstall`);
	console.log(`   Tip       : pi-web-ui server shortcut creates a desktop "one-click start" icon`);
}

function uninstallWindows(opts) {
	const name = opts.name ?? "pi-web-ui";
	if (winTaskExists(name)) {
		run("schtasks", ["/Delete", "/TN", name, "/F"], { ignoreError: true });
	}
	for (const f of [winCmdPath(name), winPs1Path(name), winTaskXmlPath(name)]) {
		if (existsSync(f)) rmSync(f);
	}
	// Hidden instance started from the shortcut
	const pid = winReadPid(name);
	if (pid && pidAlive(pid)) {
		run("taskkill", ["/PID", String(pid), "/T", "/F"], {
			ignoreError: true,
			silent: true,
		});
	}
	removeShortcut(name);
	console.log(`🗑  uninstalled ${name} (scheduled task removed, will not auto-start)`);
	console.log(`🗑  removed desktop shortcut`);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Local control socket (status / quiesce / unquiesce). The server listens on
// a mode-0600 Unix socket (POSIX) or a named pipe (Windows) under its data
// dir; same path rules as server/control-socket.ts so the CLI and server
// always agree without sharing code.
// ---------------------------------------------------------------------------

/** Resolve the control socket path for the given options. */
function controlPath(opts) {
	const dir = opts.dataDir
		? resolve(opts.dataDir)
		: process.env.PI_WEB_DATA_DIR
			? resolve(process.env.PI_WEB_DATA_DIR)
			: join(homedir(), ".pi-web");
	return isWin
		? `\\\\.\\pipe\\pi-web-ui-${String(opts.port ?? process.env.PORT ?? "8787")}`
		: join(dir, "pi-web-ui.sock");
}

/** Send one control command to a RUNNING server; resolves null if unreachable. */
function controlCommand(opts, cmd) {
	const path = controlPath(opts);
	return new Promise((resolvePromise) => {
		const sock = createConnection(path);
		let done = false;
		const finish = (v) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.destroy();
			resolvePromise(v);
		};
		const timer = setTimeout(() => finish(null), 3000);
		let buf = "";
		sock.on("connect", () => sock.write(JSON.stringify({ cmd }) + "\n"));
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				try {
					finish(JSON.parse(buf.slice(0, nl)));
				} catch {
					finish(null);
				}
			}
		});
		sock.on("error", () => finish(null));
		sock.on("close", () => finish(null));
	});
}

/** Append the live server status (via the control socket) to `server status`. */
async function printLiveStatus(opts) {
	const st = await controlCommand(opts, "status");
	if (!st || !st.ok) {
		console.log("   (server is not running or the control channel is unreachable — start it, then server status shows live info)");
		return;
	}
	console.log("   --- live status (control socket) ---");
	console.log(`   Version : ${st.version} · PID ${st.pid}`);
	console.log(`   Directory : ${st.cwd}`);
	console.log(
		`   Drain   : ${st.quiesced ? `yes (since ${new Date(st.quiescedSince).toLocaleString()})` : "no"}`,
	);
	console.log(
		`   Clients : ${st.connectedClients} browser(s) · ${st.activeConversations} running conversation(s) · ${st.pendingMessages} queued message(s)`,
	);
}

/** `server quiesce|unquiesce` — toggle the admission gate on a RUNNING server. */
async function setQuiesce(opts, on) {
	const st = await controlCommand(opts, on ? "quiesce" : "unquiesce");
	if (!st || !st.ok) {
		fail(`server is not running or the control channel is unreachable (${controlPath(opts)})`);
	}
	console.log(
		on
			? "⏸  Drain mode on (quiesce): new chats/messages/edits are rejected; in-flight work finishes.\n" +
				"    Use pi-web-ui server unquiesce to accept new work again."
			: "▶  Drain mode off (unquiesce): accepting new chats/messages/edits again.",
	);
}

function controlService(action, opts) {
	const name = opts.name ?? "pi-web-ui";

	if (isMac) {
		const label = serviceLabel(name);
		const target = `gui/${uid()}/${label}`;
		const loaded = () =>
			spawnSync("launchctl", ["print", target], { stdio: "ignore" }).status ===
			0;

		if (action === "status") {
			if (loaded()) {
				const res = spawnSync("launchctl", ["print", target], {
					encoding: "utf8",
				});
				const state = (res.stdout.match(/state = (\w+)/) ?? [])[1] ?? "loaded";
				console.log(`${label}: ${state} (loaded, starts at login)`);
			} else {
				console.log(`${label}: not installed (run pi-web-ui server install)`);
			}
			return;
		}

		if (action === "start") {
			if (loaded()) {
				run("launchctl", ["kickstart", target]);
			} else {
				const plist = launchAgentPlist(name);
				if (!existsSync(plist)) {
					fail(`${plist} not found; run pi-web-ui server install first`);
				}
				run("launchctl", ["bootstrap", `gui/${uid()}`, plist]);
			}
			console.log(`✅ started ${label}`);
			return;
		}

		if (action === "restart") {
			if (!loaded()) fail(`${label} is not loaded; run pi-web-ui server start first`);
			run("launchctl", ["kickstart", "-k", target]);
			console.log(`✅ restarted ${label}`);
			return;
		}

		if (action === "stop") {
			run("launchctl", ["bootout", target], {
				ignoreError: true,
				silent: true,
			});
			console.log(`⏹  stopped ${label} (unloaded, will not start at login; start to restore)`);
			return;
		}

		fail(`unknown action: ${action}`);
	}

	if (isLinux) {
		ensureRootForSystemctl();
		if (action === "status") {
			run("systemctl", ["status", `${name}.service`, "--no-pager"]);
			return;
		}
		run("systemctl", [action, `${name}.service`]);
		console.log(`✅ ${action} ${name}.service`);
		return;
	}

	if (isWin) {
		const exists = winTaskExists(name);

		if (action === "status") {
			const pid = winReadPid(name);
			const instAlive = pid && pidAlive(pid);
			if (!exists) {
				console.log(`${name}: not installed (run pi-web-ui server install)`);
				if (instAlive) console.log(`   Shortcut instance : running (PID ${pid})`);
				return;
			}
			// Get-ScheduledTask outputs English state enums — locale-independent,
			// unlike `schtasks /Query` tables on localized Windows.
			const ps = spawnSync(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"$t=Get-ScheduledTask -TaskName '" +
						name +
						"' -ErrorAction SilentlyContinue;" +
						"if(!$t){'NOT_INSTALLED';exit}" +
						"$i=$t|Get-ScheduledTaskInfo;" +
						"'State: '+$t.State;" +
						"'LastRunTime: '+$i.LastRunTime;" +
						"'LastTaskResult: '+$i.LastTaskResult",
				],
				{ encoding: "utf8" },
			);
			if (ps.status !== 0 || (ps.stdout ?? "").includes("NOT_INSTALLED")) {
				console.log(`${name}: not installed (run pi-web-ui server install)`);
				return;
			}
			console.log(`${name}: scheduled task\n${(ps.stdout ?? "").trim()}`);
			if (pid) {
				if (instAlive) console.log(`   Shortcut instance : running (PID ${pid})`);
				else console.log(`   Shortcut instance : exited (PID ${pid})`);
			}
			return;
		}

		if (action === "start") {
			if (!exists) fail(`${name} does not exist; run pi-web-ui server install first`);
			run("schtasks", ["/Run", "/TN", name]);
			console.log(`✅ started ${name}`);
			return;
		}

		if (action === "restart") {
			if (!exists) fail(`${name} does not exist; run pi-web-ui server install first`);
			run("schtasks", ["/End", "/TN", name], {
				ignoreError: true,
				silent: true,
			});
			run("schtasks", ["/Run", "/TN", name]);
			console.log(`✅ restarted ${name}`);
			return;
		}

		if (action === "stop") {
			run("schtasks", ["/End", "/TN", name], {
				ignoreError: true,
				silent: true,
			});
			const pid = winReadPid(name);
			if (pid) {
				if (pidAlive(pid)) {
					run("taskkill", ["/PID", String(pid), "/T", "/F"], {
						ignoreError: true,
						silent: true,
					});
					console.log(`⏹  stopped shortcut instance (PID ${pid})`);
				}
				rmSync(winPidFilePath(name), { force: true });
			}
			console.log(`⏹  stopped ${name} (auto-start kept; uninstall to remove)`);
			return;
		}

		fail(`unknown action: ${action}`);
	}

	fail(
		`unsupported system-service platform: ${process.platform} (macOS / Linux / Windows only)`,
	);
}

// ---------------------------------------------------------------------------
// UI plugin management (<dataDir>/plugins/, install from GitHub)
// ---------------------------------------------------------------------------

/** Valid plugin id (same ID_RE as server/plugins.ts). */
const PLUGIN_ID_RE = /^[A-Za-z0-9_-]+$/;

const PLUGIN_HELP = `Usage:
  pi-web-ui install <source> [options]  Install a UI plugin from GitHub
  pi-web-ui uninstall <id> [options]    Uninstall an installed UI plugin
  pi-web-ui plugins [options]           List installed UI plugins

Source (any of):
  owner/repo                                        shorthand
  https://github.com/owner/repo                     full URL (.git optional)
  https://github.com/o/r/tree/dev/sub/dir           branch + subdirectory in the repo
  any of the above plus #branch-or-tag              pin a branch/tag (e.g. owner/repo#v1.2)
  /path/to/plugin-dir                               install a local directory (for development)

install options:
  --name <id>       plugin directory name/id (default: repo name or manifest.id; letters, digits, -_)
  --data-dir <dir>  data directory (default ~/.pi-web or $PI_WEB_DATA_DIR)
  --force           overwrite if the target exists (backs up the old version first)

plugins options:
  --check-updates   compare each plugin's last installed version with remote HEAD
  --rollback <id>   restore the most recent pre-update backup (<dataDir>/plugin-backups/)
`;

function pluginDataDir(opts) {
	return resolve(opts.dataDir ?? process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));
}

/** Parse an install source into { owner, repo, ref, subpath, cloneUrl } or a local path; exits on invalid input. */
function parsePluginSource(rawSpec) {
	let spec = rawSpec.trim();
	let ref;
	const hash = spec.indexOf("#");
	if (hash >= 0) {
		ref = spec.slice(hash + 1).trim();
		if (!ref) fail(`invalid source "${rawSpec}": missing branch/tag after #`);
		spec = spec.slice(0, hash).replace(/\/+$/, "");
	}
	// Convert ssh form to https (no local ssh key required); strip the URL scheme and parse path segments
	const ssh = spec.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
	if (ssh) [, , spec] = ssh;
	else {
		const url = spec.match(/^https?:\/\/(?:www\.)?github\.com\/(.+?)(?:\.git)?\/?$/i);
		if (url) [, spec] = url;
	}
	const segs = spec.split("/").filter(Boolean);
	if (segs.length < 2)
		fail(`unrecognized plugin source "${rawSpec}"\n${PLUGIN_HELP}`);
	for (const s of segs) {
		if (s === "." || s === "..") fail(`invalid source "${rawSpec}": path segments cannot be . or ..`);
	}
	const [owner, repo] = segs;
	let subpath;
	if (segs[2] === "tree" || segs[2] === "blob") {
		if (!ref && segs.length > 3) ref = segs[3];
		subpath = segs.slice(4).join("/") || undefined;
	} else if (segs.length > 2) {
		subpath = segs.slice(2).join("/"); // owner/repo/sub/dir — subdirectory form
	}
	return { owner, repo, ref, subpath, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

/** Fetch the repo into tmpDir and return the checkout root. Prefer git clone --depth 1; fall back to a codeload tarball + system tar. */
async function acquireRepo(src, tmpDir) {
	const dst = join(tmpDir, "src");
	const hasGit = spawnSync("git", ["--version"], { stdio: "ignore", timeout: 10_000 }).status === 0;
	if (hasGit) {
		const args = ["clone", "--depth", "1", "--single-branch"];
		if (src.ref) args.push("--branch", src.ref);
		args.push(src.cloneUrl, dst);
		console.log(`· git clone --depth 1 ${src.cloneUrl}${src.ref ? ` (${src.ref})` : ""}`);
		const res = spawnSync("git", args, {
			stdio: "inherit",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
			timeout: 300_000,
		});
		if (res.status === 0 && existsSync(dst)) return dst;
		console.log("· git clone failed, falling back to a direct tarball download…");
	}
	const url = `https://codeload.github.com/${src.owner}/${src.repo}/tar.gz/${src.ref || "HEAD"}`;
	console.log(`· downloading ${url}`);
	// Do not fail()/process.exit here — exiting while an async socket is still open
	// trips a Windows libuv "UV_HANDLE_CLOSING" assertion; throw instead and let
	// pluginInstallCmd catch it, set exitCode, and drain the event loop naturally.
	let res;
	try {
		res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
	} catch (err) {
		throw new Error(`download failed: ${err?.message ?? err}\n  check the network/proxy and retry.`);
	}
	if (!res.ok)
		throw new Error(
			`download failed HTTP ${res.status}: ${url}` +
				(res.status === 404
					? "\n  the repo/branch does not exist, or it is private (configure git credentials locally and retry; git clone is tried first)."
					: ""),
		);
	writeFileSync(join(tmpDir, "src.tar.gz"), Buffer.from(await res.arrayBuffer()));
	const extractTo = join(tmpDir, "tar");
	mkdirSync(extractTo, { recursive: true });
	// Extract via relative paths: win32 GNU tar treats the C: in "C:\..." as a remote host (Cannot connect to C:)
	const tarRes = spawnSync("tar", ["-xzf", "src.tar.gz", "-C", "tar"], {
		cwd: tmpDir,
		stdio: "inherit",
	});
	if (tarRes.status !== 0) fail("tar extract failed (retry, or download the release tarball and unpack it yourself)");
	const entries = readdirSync(extractTo);
	if (entries.length !== 1) fail("unexpected tarball layout (expected a single top-level directory)");
	return join(extractTo, entries[0]);
}

/** Find directories that contain manifest.json in the checkout (depth ≤3, skip .git/node_modules). */
function findManifestDirs(root) {
	const hits = [];
	const walk = (dir, depth) => {
		if (existsSync(join(dir, "manifest.json"))) {
			hits.push(dir);
			return; // this directory is itself a plugin; do not search nested plugins
		}
		if (depth >= 3) return;
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (!ent.isDirectory() || ent.name === ".git" || ent.name === "node_modules") continue;
			walk(join(dir, ent.name), depth + 1);
		}
	};
	walk(root, 0);
	return hits;
}

/** Locate the plugin root: explicit subpath > root manifest > tree search (continue only on a unique hit). */
function locatePluginRoot(checkout, subpath, repoLabel) {
	if (subpath) {
		const dir = join(checkout, ...subpath.split("/"));
		if (!existsSync(join(dir, "manifest.json")))
			fail(`no manifest.json in subdirectory "${subpath}"`);
		return dir;
	}
	if (existsSync(join(checkout, "manifest.json"))) return checkout;
	const hits = findManifestDirs(checkout);
	if (hits.length === 0)
		fail(`no manifest.json in "${repoLabel}" — not a pi-web-ui UI plugin`);
	if (hits.length > 1)
		fail(
			`${repoLabel} contains multiple plugins (multiple manifest.json files); specify one with a subdirectory path:\n  ` +
				hits.map((h) => `${repoLabel}/${relative(checkout, h).split(/[\\/]/).join("/")}`).join("\n  "),
		);
	console.log(`· plugin is in subdirectory: ${relative(checkout, hits[0]).split(/[\\/]/).join("/")}`);
	return hits[0];
}

async function pluginInstallCmd(argv) {
	const { opts, positionals } = parseFlags(argv);
	if (opts.help) {
		console.log(PLUGIN_HELP);
		return;
	}
	if (positionals.length !== 1)
		fail(`usage: pi-web-ui install <source> [--name <id>] [--data-dir <dir>] [--force]\n${PLUGIN_HELP}`);
	const rawSpec = positionals[0];
	const pluginsDir = join(pluginDataDir(opts), "plugins");
	// Install a local directory as-is (offline development); otherwise fetch from GitHub
	const localCandidate = resolve(rawSpec.replace(/^file:\/\//, ""));
	const isLocal = existsSync(localCandidate);
	const src = isLocal ? null : parsePluginSource(rawSpec);
	const tmp = mkdtempSync(join(tmpdir(), "pi-web-ui-plugin-"));
	let backupTs = null;
	try {
		let checkout;
		try {
			checkout = isLocal ? localCandidate : await acquireRepo(src, tmp);
		} catch (err) {
			console.error(`✖ ${err?.message ?? err}`);
			process.exitCode = 1;
			return;
		}
		const repoLabel = isLocal ? localCandidate : `${src.owner}/${src.repo}`;
		const pluginRoot = locatePluginRoot(checkout, src?.subpath, repoLabel);
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
		} catch (err) {
			fail(`manifest.json is not valid JSON: ${err?.message ?? err}`);
		}
		// Default id: subdirectory name > repo name > local directory name
		const sourceName = src?.subpath
			? src.subpath.split("/").pop()
			: (src?.repo ?? localCandidate.split(/[\\/]/).pop());
		const fallbackId =
			String(manifest.id ?? sourceName)
				.replace(/[^A-Za-z0-9_-]/g, "-")
				.replace(/^-+|-+$/g, "") || "plugin";
		const id = opts.name ?? fallbackId;
		if (!PLUGIN_ID_RE.test(id))
			fail(`invalid plugin id "${id}" (letters, digits, -_ only; use --name <id> to override)`);
		const target = join(pluginsDir, id);
		let prevConfig = null;
		const CONFIG_NAME = "config.json";
		if (existsSync(target)) {
			if (!opts.force)
				fail(`plugin directory already exists: ${target}\n  pass --force to overwrite, or --name <id> to pick another name.`);
			// Back up the old version before updating (<dataDir>/plugin-backups/<id>-<ts>/, keep the last 3),
			// and roll back automatically on failure. Same filter as install: no .git/node_modules.
			backupTs = ensurePluginBackup(pluginDataDir(opts), id, { source: rawSpec });
			// Keep plugin credentials/config across upgrades: stash the old config.json and put it back after the copy
			try {
				prevConfig = readFileSync(join(target, CONFIG_NAME), "utf8");
			} catch {
				/* no config file */
			}
			rmSync(target, { recursive: true, force: true });
		}
		mkdirSync(target, { recursive: true });
		try {
			cpSync(pluginRoot, target, {
				recursive: true,
				filter: (s) => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(s),
			});
		} catch (err) {
			// Copy failed → roll back from backup if one exists so the old version stays usable
			if (backupTs && restorePluginBackup(pluginDataDir(opts), id)) {
				fail(`plugin update failed: ${err?.message ?? err}\n  automatically rolled back to the previous version.`);
			}
			fail(`plugin update failed: ${err?.message ?? err}\n  (no backup available; retry with install --force)`);
		}
		if (prevConfig !== null && !existsSync(join(target, CONFIG_NAME))) {
			writeFileSync(join(target, CONFIG_NAME), prevConfig);
		}
		// Record the install source: the settings "Update" button re-runs the same install command (--force overwrite).
		try {
			writeFileSync(
				join(target, ".pi-source.json"),
				JSON.stringify({ source: rawSpec }, null, 2) + "\n",
			);
		} catch {
			/* best-effort: missing source info only hides the update button */
		}
		// Record the remote sha for this install (git ls-remote HEAD; local git sources work offline):
		// used by `pi-web-ui plugins --check-updates`. Failures are silent (no sha = conservatively updatable).
		try {
			const sha = await resolveRemoteSha(rawSpec);
			if (sha) writeFileSync(join(target, ".pi-git-sha"), sha + "\n");
		} catch {
			/* best-effort */
		}
		console.log(
			`✔ Installed plugin ${id}${manifest.name && manifest.name !== id ? ` (${manifest.name})` : ""}${manifest.version ? ` v${manifest.version}` : ""}`,
		);
		if (manifest.description) console.log(`  ${manifest.description}`);
		console.log(`  Location: ${target}`);
		console.log(`  Takes effect: refresh the browser if the server is running; otherwise on next start. Uninstall: pi-web-ui uninstall ${id}`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

function pluginUninstallCmd(argv) {
	const { opts, positionals } = parseFlags(argv);
	if (opts.help || positionals.length !== 1) {
		console.log(PLUGIN_HELP);
		if (!opts.help) process.exit(1);
		return;
	}
	const id = positionals[0];
	if (!PLUGIN_ID_RE.test(id)) fail(`invalid plugin id: ${id}`);
	const target = join(pluginDataDir(opts), "plugins", id);
	if (!existsSync(target)) fail(`plugin "${id}" is not installed (pi-web-ui plugins lists installed plugins)`);
	rmSync(target, { recursive: true, force: true });
	console.log(`✔ Uninstalled plugin ${id} — refresh the browser if the server is running and it will disappear.`);
}

function pluginListCmd(argv) {
	const { opts, positionals } = parseFlags(argv);
	if (opts.help) {
		console.log(PLUGIN_HELP);
		return;
	}
	const dataDir = pluginDataDir(opts);
	// --rollback <id>: restore the most recent pre-update backup
	if (opts.rollback) {
		const id = String(opts.rollback);
		if (!PLUGIN_ID_RE.test(id)) fail(`invalid plugin id: ${id}`);
		const target = join(dataDir, "plugins", id);
		if (!existsSync(target)) fail(`plugin "${id}" is not installed (pi-web-ui plugins lists installed plugins)`);
		const ts = restorePluginBackup(dataDir, id);
		if (!ts) fail(`plugin "${id}" has no update backup (never overwritten / backups pruned)`);
		console.log(`✔ Rolled back plugin ${id} to the ${ts} snapshot — refresh the browser if the server is running.`);
		return;
	}
	// --check-updates: compare each plugin's last installed sha with remote HEAD (git ls-remote)
	if (opts.checkUpdates) {
		return checkUpdatesCmd(dataDir).then(() => {});
	}
	const pluginsDir = join(dataDir, "plugins");
	const rows = [];
	let names = [];
	try {
		names = readdirSync(pluginsDir).sort();
	} catch {
		/* missing directory = no plugins installed */
	}
	for (const n of names) {
		if (!PLUGIN_ID_RE.test(n)) continue;
		try {
			const m = JSON.parse(readFileSync(join(pluginsDir, n, "manifest.json"), "utf8"));
			rows.push(`  ${n.padEnd(24)} ${[m.name, m.version ? `v${m.version}` : "", m.description].filter(Boolean).join("  ")}`);
		} catch {
			continue; // skip a bad directory
		}
	}
	if (rows.length === 0) {
		console.log(`No UI plugins installed (directory: ${pluginsDir})\nInstall example: pi-web-ui install owner/repo`);
		return;
	}
	console.log(`Installed UI plugins (${pluginsDir}):\n${rows.join("\n")}`);
}

async function checkUpdatesCmd(dataDir) {
	console.log("Checking UI plugin updates (git ls-remote vs last installed version)…\n");
	let rows;
	try {
		rows = await checkPluginUpdates(dataDir);
	} catch (err) {
		fail(`update check failed: ${err?.message ?? err}`);
	}
	if (rows.length === 0) {
		console.log(`No UI plugins with a recorded source are installed (directory: ${join(dataDir, "plugins")})`);
		return;
	}
	let any = false;
	for (const r of rows) {
		const label = r.name && r.name !== r.id ? `${r.id} (${r.name})` : r.id;
		if (r.updatable) {
			console.log(`  🔄 ${label}${r.version ? ` v${r.version}` : ""}  update available (installed ${r.localSha ?? "unknown"} → remote ${r.remoteSha})`);
			console.log(`     Update: pi-web-ui install ${r.source} --name ${r.id} --force`);
			any = true;
		} else if (r.remoteSha) {
			console.log(`  ✓ ${label}${r.version ? ` v${r.version}` : ""}  up to date (${r.remoteSha})`);
		} else {
			console.log(`  ? ${label}  ${r.error ?? "could not check"} (source: ${r.source})`);
		}
	}
	if (!any) console.log("\nAll plugins are up to date.");
}

async function serverCmd(argv) {
	const { opts, positionals } = parseFlags(argv);
	if (opts.help) {
		console.log(HELP);
		return;
	}
	if (positionals.length === 0) {
		console.log(HELP);
		console.log("--- current service status ---");
		controlService("status", opts);
		return;
	}
	const action = positionals[0];
	if (positionals.length > 1)
		fail(`extra arguments: ${positionals.slice(1).join(" ")}`);
	switch (action) {
		case "shortcut": {
			if (isWin) {
				installWinShortcut(opts);
			} else if (isMac) {
				installMacShortcut(opts);
			} else if (isLinux) {
				installLinuxShortcut(opts);
			} else {
				fail(`unsupported system-service platform: ${process.platform}`);
			}
			break;
		}
		case "install": {
			if (isMac) {
				installLaunchd(opts);
			} else if (isLinux) {
				installSystemd(opts);
			} else if (isWin) {
				installWindows(opts);
			} else {
				fail(`unsupported system-service platform: ${process.platform}`);
			}
			break;
		}
		case "uninstall": {
			if (isMac) {
				uninstallLaunchd(opts);
			} else if (isLinux) {
				uninstallSystemd(opts);
			} else if (isWin) {
				uninstallWindows(opts);
			} else {
				fail(`unsupported system-service platform: ${process.platform}`);
			}
			break;
		}
		case "start":
		case "stop":
		case "restart":
			controlService(action, opts);
			break;
		case "status":
			controlService("status", opts);
			await printLiveStatus(opts);
			break;
		case "quiesce":
			await setQuiesce(opts, true);
			break;
		case "unquiesce":
			await setQuiesce(opts, false);
			break;
		default:
			fail(
				`unknown action: ${action} (install / shortcut / uninstall / start / stop / restart / status / quiesce / unquiesce)`,
			);
	}
}

async function main() {
	checkNodeVersion();
	const argv = process.argv.slice(2);
	if (argv.length === 0) {
		await startForeground({});
		return;
	}
	const first = argv[0];
	if (first === "--version" || first === "-v") {
		console.log(pkg.version);
		return;
	}
	if (first === "--help" || first === "-h") {
		console.log(HELP);
		return;
	}
	if (first === "server") {
		await serverCmd(argv.slice(1));
		return;
	}
	if (first === "install") {
		await pluginInstallCmd(argv.slice(1));
		return;
	}
	if (first === "uninstall") {
		pluginUninstallCmd(argv.slice(1));
		return;
	}
	if (first === "plugins" || first === "plugin") {
		pluginListCmd(argv.slice(1));
		return;
	}
	// One-shot server with optional --port/--cwd/--data-dir overrides.
	const { opts, positionals } = parseFlags(argv);
	if (opts.help) {
		console.log(HELP);
		return;
	}
	if (positionals.length > 0)
		fail(`unknown command: ${positionals[0]} (--help for usage)`);
	await startForeground(opts);
}

main().catch((err) => {
	console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
