/**
 * pi-web-ui pi extension — command-line integration.
 *
 * Capabilities:
 *   /webui                      Start the local pi-web-ui server and open a browser
 *   /webui --port 9000          Start on a given port
 *   /webui --no-browser         Start without opening a browser
 *   /webui stop                 Stop the running server
 *   /webui status               Show running status / URL
 *
 * Implementation notes:
 *   - Does not rely on a global bin (after `pi install`, pi-web-ui may not be
 *     on PATH). Invokes the package's dist/server/index.js with node, controlled
 *     via PORT / PI_WEB_CWD / PI_WEB_DATA_DIR.
 *   - Workspace defaults to the current pi session's ctx.cwd; override with
 *     --cwd / path.
 *   - The server runs as a background child process; /webui does not block pi.
 *   - Each pi session owns one child process; cleaned up on session_shutdown
 *     so it is not left orphaned.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// This file lives at <pkg>/extensions/webui.ts → package root is one level up
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = join(PKG_ROOT, "dist", "server", "index.js");
const NODE = process.execPath;

/** Per-session server child process + metadata */
interface RunningServer {
	proc: ReturnType<typeof spawn>;
	port: number;
	cwd: string;
	url: string;
}

// session → running instance (module-level Map; one session object per session, no global cleanup needed)
const running = new Map<string, RunningServer>();

/** Find a free port */
function findFreePort(from = 8787): Promise<number> {
	return new Promise((resolve_, reject) => {
		const srv = net.createServer();
		srv.listen(from, () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve_(port));
		});
		srv.on("error", () => {
			// Port in use — try the next one
			findFreePort(from + 1).then(resolve_, reject);
		});
	});
}

/** Parse --key value / --flag arguments */
function parseArgs(args: string): { port?: number; cwd?: string; noBrowser: boolean } {
	const out: { port?: number; cwd?: string; noBrowser: boolean } = { noBrowser: false };
	const toks = args.split(/\s+/).filter(Boolean);
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		if ((t === "--port" || t === "-p") && toks[i + 1]) {
			const n = Number(toks[++i]);
			if (Number.isInteger(n) && n > 0 && n < 65536) out.port = n;
		} else if ((t === "--cwd") && toks[i + 1]) {
			out.cwd = resolve(toks[++i]);
		} else if (t === "--no-browser") {
			out.noBrowser = true;
		}
	}
	return out;
}

/** Open a browser */
async function openBrowser(url: string): Promise<void> {
	const { platform } = process;
	const [cmd, ...rest] =
		platform === "darwin"
			? ["open", url]
			: platform === "win32"
				? ["cmd", "/c", "start", "", url]
				: ["xdg-open", url];
	// Headless environments missing xdg-open etc. fire ENOENT as an async 'error'
	// event; try/catch cannot catch it and it would crash the process — must attach an error listener.
	spawn(cmd, rest, { stdio: "ignore", detached: true })
		.on("error", (err) => {
			if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
				console.warn(
					`[webui] no browser opener found (${(err as NodeJS.ErrnoException).path || "command not found"}); use --no-browser to skip`
				);
			} else {
				console.warn("[webui] failed to open the browser:", err.message);
			}
		})
		.unref();
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("webui", {
		description: "Start the local pi-web-ui web UI (/webui [--port N] [--cwd PATH] [--no-browser] | stop | status)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sid = ctx.sessionManager.getSessionId();
			const opts = parseArgs(args);
			const action = (args.split(/\s+/)[0] || "start").toLowerCase();

			// stop
			if (action === "stop" || action === "kill") {
				const inst = running.get(sid);
				if (!inst) {
					ctx.ui.notify("No local pi-web-ui server is running", "info");
					return;
				}
				inst.proc.kill("SIGTERM");
				running.delete(sid);
				ctx.ui.notify(`Stopped pi-web-ui (${inst.url})`, "info");
				return;
			}

			// status
			if (action === "status") {
				const inst = running.get(sid);
				if (!inst) {
					ctx.ui.notify("Local pi-web-ui is not running", "info");
					return;
				}
				const alive = inst.proc.exitCode === null;
				ctx.ui.notify(
					alive ? `pi-web-ui is running → ${inst.url}\nport ${inst.port} · cwd ${inst.cwd}` : `exited (exit=${inst.proc.exitCode})`,
					alive ? "info" : "warning",
				);
				return;
			}

			// default start
			if (action !== "start" && action !== "run") {
				ctx.ui.notify(`Unknown action ${action} (use start|stop|status)`, "warning");
				return;
			}

			// Already running — notify
			const existing = running.get(sid);
			if (existing && existing.proc.exitCode === null) {
				ctx.ui.notify(`pi-web-ui is already running → ${existing.url}`, "info");
				return;
			}

			// Check that a build exists
			if (!existsSync(SERVER_ENTRY)) {
				ctx.ui.notify(
					"Missing dist/ build (this install has no built frontend). Run `npm run build` and retry, or use the official pi-web-ui npm package.",
					"warning",
				);
				return;
			}

			const port = opts.port ?? (await findFreePort());
			const cwd = opts.cwd ?? ctx.cwd;
			const url = `http://localhost:${port}`;

			const env = {
				...process.env,
				PORT: String(port),
				PI_WEB_CWD: cwd,
				...(process.env.PI_WEB_DATA_DIR ? {} : { PI_WEB_DATA_DIR: join(cwd, ".pi-web") }),
			};
			const proc = spawn(NODE, [SERVER_ENTRY], { cwd, env, stdio: "ignore", detached: true });
			proc.unref();
			running.set(sid, { proc, port, cwd, url });

			ctx.ui.notify(`Starting pi-web-ui → ${url}\nport ${port} · cwd ${cwd}\n(ready in a few seconds; /webui status to check)`);

			if (!opts.noBrowser) await openBrowser(url);

			// Clean up when the process exits
			proc.on("exit", () => {
				if (running.get(sid)?.proc === proc) running.delete(sid);
			});
		},
	});

	// Clean up the child on session end so it is not left orphaned
	pi.on("session_shutdown", async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		const inst = running.get(sid);
		if (inst && inst.proc.exitCode === null) {
			inst.proc.kill("SIGTERM");
			running.delete(sid);
		}
	});
}
