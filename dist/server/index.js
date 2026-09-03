/**
 * pi-web-ui server entry.
 *
 * - Serves the built frontend (web/dist) in production; in dev, Vite serves it
 *   on :5173 and proxies /ws to this server.
 * - Exposes /api/health and a WebSocket endpoint at /ws carrying the chat
 *   protocol defined in protocol.ts.
 *
 * Env:
 *   PORT            HTTP port (default 8787)
 *   PI_WEB_CWD      workspace the agent operates in (default: process.cwd())
 *   PI_WEB_DATA_DIR where per-client UI state is stored (client-state.json,
 *   default: <home>/.pi-web). Chat sessions are NOT stored here — they live
 *   in the pi agent's global TUI session dir (~/.pi/agent/sessions/--<cwd>--/)
 *   via the SDK default, so this web UI, the dev instance, and the pi CLI/TUI
 *   all share one conversation list per project.
 *   PI_CODING_AGENT_DIR  pi config dir (auth/models/skills) — passed to the SDK
 */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import express from "express";
import compression from "compression";
import { WebSocket, WebSocketServer } from "ws";
import { VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "./protocol-version.js";
import { AgentService, workspacePath, QuiesceRejectedError, } from "./agent-service.js";
import { previewKind } from "./text-sniff.js";
import { startControlServer } from "./control-socket.js";
import { scheduleUploadCleanup } from "./uploads.js";
import { ensureWindowsBash, windowsBashDir } from "./ensure-bash.js";
import { listThemes, resolveThemeFile } from "./themes.js";
import { PluginManager, resolvePluginClientFile } from "./plugins.js";
import { createReviewAgentTools } from "./review/agent-tools.js";
import { McpBridge } from "./mcp-bridge.js";
const PORT = Number(process.env.PORT ?? 8787);
const CWD = resolve(process.env.PI_WEB_CWD ?? process.cwd());
const DATA_DIR = resolve(process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));
/** Bind address. Default is loopback ONLY — the service is a local personal
 *  tool and should not be reachable from the network unless explicitly asked
 *  (e.g. PI_WEB_HOST=0.0.0.0 for LAN access / Docker port mapping). */
const HOST = process.env.PI_WEB_HOST ?? "127.0.0.1";
/** Optional strict hostname allowlist (comma-separated) — only used when set.
 *  Origin / Host same-authority matching happens regardless. */
const ALLOW_HOSTS = (process.env.PI_WEB_ALLOW_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
/** Optional extra Origins allowed through the same-authority check (comma-
 *  separated, e.g. reverse-proxy setups where the browser origin differs
 *  from the Host the backend sees). */
const ALLOW_ORIGINS = (process.env.PI_WEB_ALLOW_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
/** Optional shared token (PI_WEB_TOKEN): when set, every HTTP/WS request must carry it —
 *  Authorization: Bearer / X-PI-Token header, ?token= query param, or pi_web_token cookie
 *  (any one match). Fallback auth for 0.0.0.0 / reverse-proxy exposure; unset = unchanged behavior. */
const AUTH_TOKEN = process.env.PI_WEB_TOKEN?.trim() ?? "";
// Root of the SDK default per-project session dirs — chat transcripts live in
// <SESSION_DIR_ROOT>/--<cwd>--/, shared with the pi CLI/TUI (getAgentDir
// honors PI_CODING_AGENT_DIR).
const SESSION_DIR_ROOT = join(getAgentDir(), "sessions");
// Windows lightweight bash fallback: prepend <home>/.pi-web/bin to PATH (the SDK bash
// tool finds bash.exe there via findBashOnPath) and, if Git Bash is missing, download
// busybox-w32 in the background. The terminal panel's shell probe chain also includes
// this directory (see terminals.ts resolveShell).
if (process.platform === "win32") {
    process.env.PATH = `${windowsBashDir()}${delimiter}${process.env.PATH ?? ""}`;
    void ensureWindowsBash();
}
const app = express();
app.use(express.json({ limit: "10mb" }));
/** Extract a candidate token from the request: header / query / cookie (browser navigations rely on the cookie). */
function requestTokens(req) {
    const out = [];
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer "))
        out.push(auth.slice(7).trim());
    const header = req.headers["x-pi-token"];
    if (typeof header === "string")
        out.push(header.trim());
    try {
        const q = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        if (q)
            out.push(q.trim());
    }
    catch {
        /* ignore malformed url */
    }
    const cookie = req.headers.cookie;
    if (typeof cookie === "string") {
        for (const part of cookie.split(";")) {
            const [k, ...rest] = part.trim().split("=");
            if (k === "pi_web_token")
                out.push(rest.join("=").trim());
        }
    }
    return out.filter(Boolean);
}
function tokenOk(req) {
    return requestTokens(req).includes(AUTH_TOKEN);
}
if (AUTH_TOKEN) {
    // /api/health stays open: no sensitive data; container / monitor probes need it
    app.use((req, res, next) => {
        if (req.path === "/api/health" || tokenOk(req)) {
            // After the browser first enters via ?token=, set an HttpOnly cookie so later navigations/resource requests need no param
            if (!req.headers.cookie?.includes("pi_web_token=")) {
                res.setHeader("Set-Cookie", `pi_web_token=${encodeURIComponent(AUTH_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
            }
            next();
            return;
        }
        res.status(401).send("unauthorized: PI_WEB_TOKEN required (?token=…)");
    });
}
app.get("/api/health", (_req, res) => {
    res.json({ ok: true, piVersion: VERSION, cwd: CWD, pid: process.pid });
});
/**
 * Stream a workspace file over HTTP.
 *
 * Media preview (no download param): only image/video kinds are served —
 * text goes over the WebSocket, and exe/jar/etc. are never exposed here.
 * express's sendFile handles Range requests, so video seeking works.
 *
 * Download (?download=1): any file kind is served with
 * Content-Disposition: attachment so the browser saves it instead of
 * rendering. Path is validated against the workspace root either way.
 */
app.get("/api/file", async (req, res) => {
    try {
        const raw = typeof req.query.path === "string" ? req.query.path : "";
        // Resolve against the requesting client's workspace (the opened
        // project), not the server's startup cwd — they can differ when the
        // client switched projects or restored a previous workspace. Fall
        // back to the server cwd for requests without a known client.
        const cid = typeof req.query.clientId === "string" ? req.query.clientId : "";
        const cs = cid ? service.get(cid) : undefined;
        const wp = workspacePath(cs?.cwd ?? CWD, raw);
        if (!wp) {
            res.status(400).end("path outside workspace");
            return;
        }
        const abs = wp.abs;
        const name = basename(abs);
        const kind = previewKind(name);
        const isDownload = req.query.download === "1";
        if (!isDownload && kind !== "image" && kind !== "video") {
            res.status(400).end("not a previewable media file");
            return;
        }
        const st = await stat(abs);
        if (!st.isFile()) {
            res.status(400).end("not a file");
            return;
        }
        if (isDownload) {
            // res.download sets Content-Disposition: attachment and RFC 5987
            // filename* encoding for non-ASCII names.
            res.download(abs, name);
        }
        else {
            res.sendFile(abs);
        }
    }
    catch {
        res.status(404).end("not found");
    }
});
// Production: serve the built frontend from web/dist. Resolve relative to this
// module so it works when installed as a package (global/npx/Docker), not just
// from the repo root. In dev, Vite serves the UI on :5173 and proxies /ws.
const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/dist/server or <pkg>/server
// Resolve the package root robustly: dev runs from <repo>/server (tsx), prod
// from <pkg>/dist/server — the ancestor that actually has package.json wins.
function resolvePkgRoot() {
    // PI_WEB_PKG_ROOT: optional override when the process cwd is not the package root.
    if (process.env.PI_WEB_PKG_ROOT)
        return process.env.PI_WEB_PKG_ROOT;
    const candidates = [
        resolve(here, ".."),
        resolve(here, "..", ".."),
        resolve(here, "..", "..", ".."),
    ];
    for (const c of candidates) {
        if (existsSync(join(c, "package.json")))
            return c;
    }
    return candidates[0];
}
const pkgRoot = resolvePkgRoot();
// Theme CSS files: complete standalone stylesheets. Builtin themes ship in
// <pkg>/themes (npm files whitelist); user themes can be dropped into
// <dataDir>/themes and are served alongside (user wins on id collision).
const BUILTIN_THEMES_DIR = join(pkgRoot, "themes");
const USER_THEMES_DIR = join(DATA_DIR, "themes");
app.get("/api/themes", (_req, res) => {
    res.json({ themes: listThemes(BUILTIN_THEMES_DIR, USER_THEMES_DIR) });
});
// Serve a theme's full CSS file so the frontend can swap the whole stylesheet.
// Registered before the SPA catch-all below (otherwise it'd return index.html).
app.get("/themes/:id.css", (req, res) => {
    const file = resolveThemeFile(BUILTIN_THEMES_DIR, USER_THEMES_DIR, req.params.id);
    if (!file) {
        res.status(404).end("theme not found");
        return;
    }
    res.setHeader("Content-Type", "text/css; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(file);
});
// Plugin client bundles: <dataDir>/plugins/<id>/client/* served at
// /plugins/<id>/client/* so the frontend can import() plugin views. Only the
// client/ subtree is exposed — manifest.json and the server-side index.mjs
// (which may hold credentials) never leave the machine. Registered BEFORE the
// SPA catch-all below.
const PLUGINS_DIR = join(DATA_DIR, "plugins");
// Plugin HTTP route mount: host.route("GET", "/inbox") is actually exposed as
// /plugins-api/<id>/inbox. PI_WEB_TOKEN auth (the app.use above) covers these
// automatically; the body has already been through express.json. Do not consume
// the body in this catch-all.
app.all(["/plugins-api/:id/*", "/plugins-api/:id"], (req, res) => {
    const rest = String(req.params[0] ?? "");
    pluginMgr.handleHttp(String(req.params.id ?? ""), req.method, rest, req, res);
});
app.get("/plugins/:id/client/*", (req, res) => {
    // Express 4 wildcard params land in params[0] at runtime but are missing from the types — take explicitly
    const rest = String(req.params[0] ?? "");
    const abs = resolvePluginClientFile(PLUGINS_DIR, req.params.id, rest);
    if (!abs) {
        res.status(404).end("plugin not found");
        return;
    }
    // .mjs is often missing from older mime tables; set Content-Type by hand so import() works
    if (/\.(mjs|js)$/.test(abs)) {
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    }
    res.setHeader("Cache-Control", "no-cache"); // file edits take effect immediately during development
    res.sendFile(abs, (err) => {
        if (err && !res.headersSent)
            res.status(err.statusCode === 404 ? 404 : 500).end("not found");
    });
});
/** Set in the env of the replacement child spawned by a self-update restart. */
const RESTART_CHILD_ENV = "PI_WEB_RESTART_CHILD";
const webDist = join(pkgRoot, "web", "dist");
if (existsSync(webDist)) {
    // gzip/deflate response compression: the frontend bundle is ~1MB; on LAN / reverse-proxy
    // transfer drops to ~1/4. Also applies to API JSON; WS upgrade is unaffected
    app.use(compression());
    app.use(express.static(webDist, {
        // Vite output filenames include a content hash, so they can be cached forever —
        // a release changes the hash and naturally invalidates. index.html is handled by
        // the catch-all below (sendFile does not go through here)
        setHeaders(res, filePath) {
            if (filePath.includes(`${sep}assets${sep}`)) {
                res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            }
        },
    }));
    app.get(/^\/(?!api\/|ws).*/, (_req, res) => {
        // Callback form: a failed stat here (npm i -g is mid-replacement of the
        // package dir) responds 503 instead of crashing the request pipeline
        // with an unhandled ENOENT stack trace.
        res.sendFile(join(webDist, "index.html"), (err) => {
            if (err && !res.headersSent) {
                res.status(503).send("Updating pi-web-ui, refresh in a moment…");
            }
        });
    });
}
else if (process.env[RESTART_CHILD_ENV]) {
    // Auto-restart replacement of a self-update whose npm install did not
    // complete (Windows: locked files / rollback can leave the global package
    // without web/dist). Fail loudly with a repair hint instead of serving a
    // UI-less 404 with no explanation.
    console.error("✖ Install after update is incomplete (missing web/dist/index.html).\n" +
        "  Run npm i -g pi-web-ui@latest and restart.");
    process.exit(1);
}
const httpServer = createServer(app);
const wss = new WebSocketServer({
    noServer: true,
    // Per-message deflate: big-session snapshots serialize to multi-MB JSON
    // strings; wire-level compression cuts that several-fold. threshold keeps
    // tiny messages (notices/heartbeats) uncompressed to save CPU.
    perMessageDeflate: { threshold: 16 * 1024 },
});
// ---------------------------------------------------------------------------
// Origin / Host admission for WebSocket upgrades.
//
// Browsers attach an Origin header; non-browser clients (curl, ws scripts)
// usually don't — they're admitted by the network layer / reverse proxy.
// Rules (checked in order):
//   4. No Origin header → admit (non-browser client).
//   5. Anything else → 403 + close.
//
// Dev-mode note: the Vite dev server (:5173) proxies /ws to the backend on
// :8788, so their authorities differ — the dev:server script sets
// PI_WEB_ALLOW_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 for that.
// LAN / reverse-proxy setups add their own origin the same way.
// ---------------------------------------------------------------------------
/** "host" or "host:port" → { hostname, port }. */
function parseAuthority(a) {
    try {
        const u = new URL(`http://${a}`);
        return { hostname: u.hostname.toLowerCase(), port: u.port || "80" };
    }
    catch {
        return { hostname: "", port: "" };
    }
}
function originAllowed(req) {
    const hostHeader = (req.headers.host ?? "").toLowerCase();
    const host = parseAuthority(hostHeader);
    if (ALLOW_HOSTS.length > 0 && !ALLOW_HOSTS.includes(host.hostname)) {
        return false;
    }
    const origin = req.headers.origin;
    if (!origin)
        return true; // non-browser client
    const o = origin.toLowerCase();
    if (ALLOW_ORIGINS.includes(o))
        return true;
    if (o === "null")
        return false; // file:// pages etc. are not trusted
    const ori = parseAuthority(o.replace(/^[a-z]+:\/\//, ""));
    if (ori.hostname === host.hostname && ori.port === host.port)
        return true;
    // Browsers treat host:port pairs on the SAME host as different origins —
    // do not accept them. (Dev-mode proxying is handled by PI_WEB_ALLOW_ORIGINS
    // set in the dev:server script; LAN/reverse-proxy setups add their origin.)
    return false;
}
httpServer.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
        pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    }
    catch {
        /* fall through to the path check below */
    }
    if (pathname !== "/ws") {
        socket.destroy();
        return;
    }
    if (!originAllowed(req)) {
        // Reject cross-origin browser pages outright. The browser sees a failed
        // WS connect; the page's own reconnect loop then backs off and retries.
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
    }
    if (AUTH_TOKEN && !tokenOk(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
    });
});
// Heartbeat: lets clients detect half-open connections (server killed without
// closing sockets, sleep/wake, network partitions). Idle connections otherwise
// carry no traffic and TCP keepalive defaults are far too slow (~2h).
const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "heartbeat" }));
        }
    }
}, 10_000);
const service = new AgentService(CWD, 
// Per-client persisted UI state: last-used workspace + recent projects.
join(DATA_DIR, "client-state.json"));
// Optional UI plugins (<dataDir>/plugins/<id>/): scanned on every client
// attach so freshly dropped plugins appear without a server restart.
const pluginMgr = new PluginManager(DATA_DIR, CWD);
// MCP tool bridge: read <dataDir>/mcp.json, start external MCP servers (stdio),
// and fold their tools into the same customTools pipeline as plugin tools.
// A single server failure must not crash the process.
const mcpBridge = new McpBridge(DATA_DIR, (...a) => console.log("[mcp]", ...a));
void mcpBridge.load().then(() => {
    if (mcpBridge.getTools().length)
        service.applyPluginAgentTools();
});
// Plugin extension point: forward SDK tool-execution events (bash/read-file start+end) to registered plugins.
service.onToolEvent = (ev) => pluginMgr.emitToolEvent(ev);
const reviewTools = createReviewAgentTools(() => pluginMgr.getCwd(), () => service.broadcastReviewStatus());
// Built-in Local Review tools + plugin tools + MCP tools.
service.pluginToolsProvider = () => [...reviewTools, ...pluginMgr.getAgentTools(), ...mcpBridge.getTools()];
pluginMgr.onAgentToolsChanged = () => service.applyPluginAgentTools();
// Plugin extension point: plugin slash commands (registerCommand) → picker catalog + prompt intercept.
pluginMgr.onCommandsChanged = () => service.applyPluginCommandCatalog();
service.pluginCommandsProvider = () => pluginMgr.listCommands();
// Plugin extension point: plugin resident background tasks (registerBackgroundTask) → fold into the background-tasks panel.
pluginMgr.onBgTasksChanged = () => service.refreshBackgroundServers();
service.pluginBgTasksProvider = () => pluginMgr.bgTasks();
service.pluginStopBgTask = (taskId) => pluginMgr.stopPluginBgTask(taskId);
// Plugin-host workspace follows the current project live: after any client set_cwd
// succeeds, sync it to PluginManager so workspace-following plugins (editor, etc.)
// switch roots immediately (see plugins.ts notifyCwd).
service.onClientCwdChanged = (cwd) => pluginMgr.notifyCwd(cwd);
// ---------------------------------------------------------------------------
// Self-update
// ---------------------------------------------------------------------------
// In-app updates now run `npm i -g pi-web-ui@latest` in a visible terminal
// tab (frontend-initiated); after it finishes the user restarts via
// `pi-web-ui server restart`. The PI_WEB_RESTART_CHILD port-wait handshake
// below stays: an externally orchestrated replacement child still needs it.
function scheduleQuit() {
    const isLaunchd = process.platform === "darwin" && process.ppid === 1;
    const isSystemd = process.platform === "linux" && !!process.env.INVOCATION_ID;
    const inDocker = existsSync("/.dockerenv");
    if (isLaunchd || isSystemd || inDocker) {
        setTimeout(() => {
            console.log("pi-web-ui:quit — shutting down (supervisor will restart)…");
            if (isSystemd)
                process.exit(3);
            void shutdown();
        }, 300);
        return true;
    }
    setTimeout(() => {
        console.log("pi-web-ui:quit — shutting down (restart to reload)…");
        void shutdown();
    }, 300);
    return true;
}
service.onQuit = scheduleQuit;
/** Backpressure relative multiplier: drop when unsent socket backlog exceeds
 *  "size of the latest snapshot × this multiplier" (issue #11 and the adaptive
 *  suggestion in its comments). A fixed 1MB threshold drops mid-frame on long
 *  sessions (a single snapshot can be ~10MB) and is too sluggish on short ones.
 *  A relative threshold stays at "about N snapshots queued" regardless of session length. */
const SNAPSHOT_BACKPRESSURE_FACTOR = 3;
/** Backpressure absolute floor: never drop a snapshot below this backlog (a small
 *  session's relative threshold is only a few KB and would be tripped by a normal
 *  message burst — see the comment inside send()). */
const SNAPSHOT_BACKPRESSURE_MIN_BYTES = 262_144;
/** Delay before re-sending a snapshot dropped by backpressure. */
const SNAPSHOT_RETRY_MS = 250;
/**
 * Multi-tab serialization sharing: emit() hands the SAME message object to
 * every socket of a client, but each send() used to JSON.stringify it
 * separately — N open tabs serialized the same multi-MB snapshot N times per
 * push. Keyed by object identity (WeakMap): a new snapshot is a new object,
 * so the cache self-invalidates and never grows.
 */
const serializedCache = new WeakMap();
function serializeShared(msg) {
    let s = serializedCache.get(msg);
    if (s === undefined) {
        s = JSON.stringify(msg);
        serializedCache.set(msg, s);
    }
    return s;
}
wss.on("connection", (ws) => {
    // Count attached sockets (the control socket reports REAL sockets, not
    // cached client-session objects).
    service.noteSocketOpen();
    let clientId = null;
    let closed = false;
    /** Estimated byte size of the latest full snapshot (UTF-16 ×2), used for the relative backpressure threshold (issue #11). */
    let lastSnapshotBytes = 0;
    /** Commands received while the session is still being created — replayed after attach. */
    let pending = [];
    /** Delayed re-send timer after a backpressure drop (deduped: only one queued at a time). */
    let snapshotRetryTimer = null;
    // Protocol-layer errors (illegal / unmasked frames, etc.): without a handler they
    // become an uncaught exception and crash the process (found alongside issue #11).
    // Log and close as a bad connection.
    ws.on("error", (err) => {
        console.error(`[ws] socket error${clientId ? ` (${clientId})` : ""}:`, err.message);
        try {
            ws.close();
        }
        catch {
            /* already closing */
        }
    });
    const send = (msg) => {
        if (closed || ws.readyState !== WebSocket.OPEN)
            return;
        // Send backpressure (issue #11): when the socket cannot keep up (slow frontend /
        // poor network), the heap piles up full snapshot strings of up to ~10MB each and
        // a low-memory host OOMs. A snapshot is fully idempotent and a newer one will
        // always follow, so it is safe to drop — drop before serialize so we skip the
        // stringify allocation too. ready / notice / error / tool_delta must be delivered.
        // Relative threshold (from the issue comments): use "latest snapshot bytes ×
        // multiplier" as the baseline; the first snapshot has no baseline so it is never
        // dropped (first must arrive). wire.length is UTF-16 code units; ×2 estimates bytes.
        // Floor (small-session false-drop fix): a small session's snapshot is ~1KB, so the
        // relative threshold is only a few KB — a normal burst of settings_state /
        // slash_commands can push bufferedAmount over it and silently drop the following
        // snapshot_delta; if no later event arrives, the client is stuck on the old state
        // forever (the frontend self-heals via a rev gap + get_state; protocol tests just
        // hang). The absolute floor guarantees small sessions never trip backpressure.
        if ((msg.type === "snapshot" || msg.type === "snapshot_delta") &&
            lastSnapshotBytes > 0 &&
            ws.bufferedAmount > Math.max(SNAPSHOT_BACKPRESSURE_MIN_BYTES, SNAPSHOT_BACKPRESSURE_FACTOR * lastSnapshotBytes)) {
            // A genuinely slow client: dropping is safe, but we cannot "drop and it's gone"
            // — schedule a delayed re-send so the snapshot eventually arrives after the
            // buffer drains (otherwise, if no later event fires, the client stays on the
            // old snapshot forever). Re-send still goes through flushSnapshot: if the
            // buffer is still full it defers again.
            if (!snapshotRetryTimer) {
                snapshotRetryTimer = setTimeout(() => {
                    snapshotRetryTimer = null;
                    service.get(clientId ?? "")?.flushSnapshot();
                }, SNAPSHOT_RETRY_MS);
            }
            return;
        }
        const wire = serializeShared(msg);
        if (msg.type === "snapshot")
            lastSnapshotBytes = wire.length * 2;
        ws.send(wire);
    };
    // Plugins broadcast to every open socket; unregister on close below.
    // Plugins broadcast to every open socket; unregister on close below. The
    // cid getter lets plugins target THIS socket via host.sendTo(clientId).
    const removePluginSender = pluginMgr.addSender(send, () => clientId);
    const dispatch = (msg) => {
        if (!clientId) {
            pending.push(msg);
            return;
        }
        const cs = service.get(clientId);
        if (!cs) {
            // Session not ready yet (hello processing) — hold the command.
            pending.push(msg);
            return;
        }
        switch (msg.type) {
            case "prompt":
                void cs.prompt(msg.text, msg.attachments, msg.queue);
                break;
            case "abort":
                void cs.abort();
                break;
            case "abort_bash":
                void cs.abortBash();
                break;
            case "kill_background_server":
                void cs.killBackgroundServer(msg.port, msg.taskId);
                break;
            case "kill_background_servers":
                void cs.killAllBackgroundServers();
                break;
            case "list_bg_servers":
                void cs.listBgServers();
                break;
            case "new_chat":
                void cs.newChat();
                break;
            case "edit_message":
                void cs.editMessage(msg.messageId, msg.text, msg.attachments);
                break;
            case "cycle_model":
                void cs.cycleModel();
                break;
            case "cycle_thinking":
                cs.cycleThinking();
                break;
            case "get_state":
                // Always a FULL snapshot: the client is (re)connecting or detected
                // a rev/seq gap — it needs an authoritative state to rebuild from.
                cs.flushSnapshot(true);
                break;
            case "get_commands":
                void cs.pushSlashCommands();
                break;
            case "list_sessions":
                void cs.refreshSessions();
                break;
            case "list_projects":
                void cs.pushProjects();
                break;
            case "remove_project":
                void cs.removeProject(msg.path);
                break;
            case "delete_session":
                void cs.deleteSession(msg.path);
                break;
            case "switch_session":
                void cs.switchSession(msg.path);
                break;
            case "switch_conversation":
                void cs.switchConversation(msg.id);
                break;
            case "list_files":
                void cs.listFiles(msg.path);
                break;
            case "search_files":
                void cs.searchFiles(msg.query, msg.reqId);
                break;
            case "scm_status":
                void cs.scmQuery("status", msg.reqId);
                break;
            case "scm_history":
                void cs.scmQuery("history", msg.reqId);
                break;
            case "scm_filediff":
                void cs.scmQuery("filediff", msg.reqId, { path: msg.path });
                break;
            case "scm_commit":
                void cs.scmQuery("commit", msg.reqId, { hash: msg.hash });
                break;
            case "review_diff":
                void cs.reviewDiff(msg.reqId, msg.mode, msg.base);
                break;
            case "review_submit":
                void cs.reviewSubmit(msg.reqId, msg.mode, msg.baseBranch, msg.comments);
                break;
            case "review_apply":
                void cs.reviewApply();
                break;
            case "review_set_status":
                void cs.reviewSetStatus(msg.status, msg.id);
                break;
            case "review_pending":
                void cs.pushReviewStatus();
                break;
            case "review_nudge_ack":
                break;
            case "set_session_name":
                cs.setSessionName(msg.name);
                break;
            case "session_tree":
                cs.emitSessionTree();
                break;
            case "navigate_tree":
                void cs.navigateTree(msg.entryId);
                break;
            case "read_file":
                void cs.readFile(msg.path);
                break;
            case "write_file":
                void cs.writeFile(msg.path, msg.text);
                break;
            case "list_models":
                void cs.listModels();
                break;
            case "set_model":
                void cs.setModel(msg.modelId);
                break;
            case "set_thinking":
                cs.setThinking(msg.level);
                break;
            case "set_cwd":
                void cs.setCwd(msg.path);
                break;
            case "complete_path":
                void cs.completePath(msg.path);
                break;
            case "check_update":
                void cs.checkUpdate();
                break;
            case "dialog_response":
                cs.resolveDialog(msg.id, msg.value);
                break;
            case "install_pi_agent":
                void cs.installPiAgent();
                break;
            case "set_provider_api_key":
                void cs.setProviderApiKey(msg.provider, msg.apiKey);
                break;
            case "clear_provider_api_key":
                void cs.clearProviderApiKey(msg.provider);
                break;
            case "list_models_config":
                void cs.listModelsConfig();
                break;
            case "save_model_config":
                void cs.saveModelConfig(msg.providerId, msg.config);
                break;
            case "delete_model_config":
                void cs.deleteModelConfig(msg.providerId);
                break;
            case "list_providers":
                void cs.listProviders();
                break;
            case "fetch_models":
                void cs.fetchModelsList(msg.reqId, msg.baseUrl, msg.apiKey, msg.authHeader, msg.api);
                break;
            case "refresh_provider_models":
                void cs.refreshProviderModels(msg.providerId, msg.reqId);
                break;
            case "clone_provider":
                void cs.cloneProvider(msg.provider, msg.reqId);
                break;
            case "terminal_create": {
                const tm = cs.getTerminalManager(msg.conversationId);
                if (tm)
                    tm.create(msg.terminalId, msg.cwd, msg.cols, msg.rows, cs.getTerminalCwd(msg.conversationId));
                break;
            }
            case "terminal_input":
                cs.getTerminalManager(msg.conversationId)?.input(msg.terminalId, msg.data);
                break;
            case "terminal_resize":
                cs.getTerminalManager(msg.conversationId)?.resize(msg.terminalId, msg.cols, msg.rows);
                break;
            case "terminal_kill":
                cs.getTerminalManager(msg.conversationId)?.kill(msg.terminalId);
                break;
            case "run_command":
                cs.getTerminalManager(msg.conversationId)?.runCommand(msg.terminalId, msg.command, msg.cols, msg.rows, cs.getTerminalCwd(msg.conversationId));
                break;
            case "list_commands":
                void cs.listCommands();
                break;
            case "save_commands":
                void cs.saveCommands(msg.commands);
                break;
            case "set_goal":
                void cs.setGoal(msg.goal, {
                    reviewModel: msg.reviewModel,
                    maxRounds: msg.maxRounds,
                    locked: msg.locked,
                });
                break;
            case "clear_goal":
                void cs.clearGoal();
                break;
            case "start_goal_wizard":
                void cs.startGoalWizard(msg.text, {
                    wizardModel: msg.wizardModel,
                    maxRounds: msg.maxRounds,
                    locked: msg.locked,
                });
                break;
            case "set_goal_prefs":
                void cs.setGoalPrefs({
                    reviewModel: msg.reviewModel,
                    maxRounds: msg.maxRounds,
                    locked: msg.locked,
                });
                break;
            case "get_settings":
                cs.pushSettings();
                break;
            case "set_settings":
                void cs.setSettings({
                    promptMode: msg.promptMode,
                    customSystemPrompt: msg.customSystemPrompt,
                    disabledSkills: msg.disabledSkills,
                    disabledExtensions: msg.disabledExtensions,
                    disabledPlugins: msg.disabledPlugins,
                    terminalToolsEnabled: msg.terminalToolsEnabled,
                    terminalBash: msg.terminalBash,
                    terminalBashIdleMs: msg.terminalBashIdleMs,
                    thinkingWrap: msg.thinkingWrap,
                    visionBridgeEnabled: msg.visionBridgeEnabled,
                    visionBridgeModel: msg.visionBridgeModel,
                    visionBridgePromptMode: msg.visionBridgePromptMode,
                    visionBridgePrompt: msg.visionBridgePrompt,
                    reviewPrompt: msg.reviewPrompt,
                    reviewDisabledSkills: msg.reviewDisabledSkills,
                    additionalSkillPaths: msg.additionalSkillPaths,
                });
                break;
            case "extensions_reload":
                void cs.reloadExtensions();
                break;
            case "plugin_message":
                pluginMgr.handleMessage(msg.pluginId, msg.payload, clientId ?? undefined);
                break;
            case "plugin_settings": {
                const r = pluginMgr.savePluginSettings(msg.pluginId, msg.values ?? {});
                if (r.error) {
                    cs?.emitNotice("error", `Failed to save plugin settings: ${r.error}`);
                }
                else {
                    cs?.emitNotice("info", "Plugin settings saved");
                }
                break;
            }
            case "plugins_reload":
                void pluginMgr.reload().then(() => pluginMgr.pushToAll());
                break;
            case "save_preset":
                void cs.savePreset(msg.name);
                break;
            case "apply_preset":
                void cs.applyPreset(msg.name);
                break;
            case "delete_preset":
                void cs.deletePreset(msg.name);
                break;
            default:
                break;
        }
    };
    ws.on("message", (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        }
        catch {
            return;
        }
        if (msg.type === "hello") {
            const cid = msg.clientId || randomUUID();
            clientId = cid;
            service
                .attach(cid, send)
                .then((cs) => {
                if (closed)
                    return;
                send({
                    type: "ready",
                    clientId: cid,
                    serverVersion: VERSION,
                    protocolVersion: PROTOCOL_VERSION,
                });
                cs.flushSnapshot();
                // Plugin catalog: re-scan + activate new dirs on every attach so
                // freshly dropped plugins show up without a server restart.
                pluginMgr
                    .ensureLoaded()
                    .then((plugins) => {
                    send({ type: "plugins", plugins, epoch: pluginMgr.epoch });
                    // Let each plugin push its own initial state to the newly attached client
                    // (onAttach hook) — plugins must not rely on the client pulling after mount
                    // (see the onAttach comment in plugins.ts).
                    pluginMgr.notifyAttach(cid);
                    // Plugin commands may only register during this client's attach (first-load race) —
                    // push the catalog once more so the picker is complete.
                    service.applyPluginCommandCatalog();
                })
                    .catch(() => { });
                // Replay anything that arrived while the session was starting.
                const queued = pending;
                pending = [];
                for (const m of queued)
                    dispatch(m);
            })
                .catch((err) => {
                // Admission refused (quiesce): close the socket so the browser
                // reconnect loop keeps retrying until admission reopens. Do NOT
                // leave a half-alive connection that can only show an error.
                if (err instanceof QuiesceRejectedError) {
                    closed = true;
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.close(4403, "quiesced");
                    }
                    ws.terminate?.();
                    return;
                }
                // Real init failure (bad agent dir etc.) — keep the connection
                // open so the user can see the error and fix it.
                send({
                    type: "notice",
                    level: "error",
                    text: `Session init failed: ${err.message}`,
                });
            });
            return;
        }
        dispatch(msg);
    });
    ws.on("close", () => {
        service.noteSocketClose();
        closed = true;
        pending = [];
        removePluginSender();
        if (snapshotRetryTimer) {
            clearTimeout(snapshotRetryTimer);
            snapshotRetryTimer = null;
        }
        if (clientId)
            service.detach(clientId, send);
    });
});
// When spawned by the old process as an auto-restart replacement, wait for
// the old instance to release the port before binding (it exits right after
// spawning us). Probe by attempting a connection: refused = free.
if (process.env[RESTART_CHILD_ENV] === "1") {
    const deadline = Date.now() + 20_000;
    const portFree = () => new Promise((resolve) => {
        const sock = createConnection({ port: PORT, host: "127.0.0.1" });
        sock.once("connect", () => {
            sock.destroy();
            resolve(false); // busy — old instance still up
        });
        sock.once("error", () => resolve(true)); // refused → free
        sock.setTimeout(500, () => {
            sock.destroy();
            resolve(false);
        });
    });
    while (Date.now() < deadline) {
        if (await portFree())
            break;
        await new Promise((r) => setTimeout(r, 300));
    }
}
httpServer.listen(PORT, HOST, () => {
    console.log("");
    console.log("  ⚡ pi-web-ui — web chat for the pi coding agent");
    console.log(`    http://localhost:${PORT}`);
    console.log(`    workspace   : ${CWD}`);
    console.log(`    session dir : ${SESSION_DIR_ROOT}`);
    console.log(`    pi SDK      : v${VERSION}`);
    console.log(`    bind        : ${HOST}:${PORT}`);
    console.log("");
});
// Upload retention cleanup: scan once at startup + every 6 hours (best-effort; see uploads.ts)
scheduleUploadCleanup();
// Local control socket (status / quiesce / unquiesce) — same data dir the
// CLI uses, so `pi-web-ui server status|quiesce|unquiesce` just works.
const stopControl = startControlServer({ service, dataDir: DATA_DIR, port: PORT });
let shuttingDown = false;
async function shutdown() {
    if (shuttingDown)
        return;
    shuttingDown = true;
    console.log("\nshutting down…");
    clearInterval(heartbeatTimer);
    stopControl();
    pluginMgr.dispose();
    mcpBridge.dispose();
    await service.disposeAll();
    wss.close();
    httpServer.close();
    process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
