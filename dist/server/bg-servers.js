import { killPidTree, lookupProcessName, lookupProcessCommandLine, snapshotListeningPorts, } from "./process-utils.js";
const BG_REFRESH_INTERVAL_MS = 30_000;
/** How long to wait after bash finishes before the "after" snapshot — time for a background service to bind its port. */
const BG_BIND_WAIT_MS = 1500;
export class BgServerTracker {
    opts;
    servers = new Map();
    /** Listening-port snapshot taken before the bash tool starts (set at tool_execution_start). */
    listenBefore = null;
    refreshTimer = null;
    constructor(opts) {
        this.opts = opts;
    }
    /** Start the periodic liveness check (dead entries are dropped silently). */
    start() {
        this.refreshTimer = setInterval(() => void this.refresh(), BG_REFRESH_INTERVAL_MS);
        this.refreshTimer.unref?.();
    }
    stop() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }
    /** tool_execution_start(bash): record the "before" snapshot. */
    snapshotBefore() {
        void snapshotListeningPorts().then((m) => {
            this.listenBefore = m;
        });
    }
    /** After a bash tool run, wait briefly for background servers to bind,
     *  then diff the listening-port snapshot against the pre-run one and
     *  remember anything new — those are servers the agent left running. */
    async trackAfterBash() {
        const before = this.listenBefore;
        this.listenBefore = null;
        if (!before)
            return;
        await new Promise((r) => setTimeout(r, BG_BIND_WAIT_MS));
        const after = await snapshotListeningPorts();
        let added = false;
        for (const [port, pid] of after) {
            if (!before.has(port) && !this.servers.has(port)) {
                this.servers.set(port, { pid, since: Date.now() });
                added = true;
                // Best-effort process name + full command line so the panel shows
                // something readable (name) AND what is actually running (command).
                void lookupProcessName(pid).then((name) => {
                    const cur = this.servers.get(port);
                    if (cur && cur.pid === pid && name) {
                        cur.name = name;
                        this.push();
                    }
                });
                void lookupProcessCommandLine(pid).then((command) => {
                    const cur = this.servers.get(port);
                    if (cur && cur.pid === pid && command) {
                        cur.command = command;
                        this.push();
                    }
                });
                this.opts.emit({
                    type: "notice",
                    level: "info",
                    text: `Detected an AI-started background server on port ${port} (pid ${pid}) — stop it from the top-bar Background tasks panel`,
                });
            }
        }
        if (added)
            this.push();
    }
    /** The current background-server list, oldest first. Merges in plugin tasks. */
    list() {
        const out = [...this.servers.entries()]
            .map(([port, v]) => ({
            port,
            pid: v.pid,
            since: v.since,
            ...(v.name ? { name: v.name } : {}),
            ...(v.command ? { command: v.command } : {}),
        }))
            .sort((a, b) => a.since - b.since);
        for (const t of this.opts.pluginTasks?.() ?? [])
            out.push(t);
        return out;
    }
    /** Push the current background-task list to every connected socket. */
    push() {
        this.opts.emit({ type: "bg_servers", servers: this.list() });
    }
    /** Re-snapshot listening ports and drop tracked entries that are no longer
     *  listening — the process exited on its own, so it must leave the panel.
     *  Port AND pid must both match: a port reused by an unrelated process is
     *  not our server anymore. Silent (the list just updates). */
    async refresh() {
        if (this.opts.isDisposed() || this.servers.size === 0)
            return;
        const now = await snapshotListeningPorts();
        let changed = false;
        for (const [port, v] of [...this.servers]) {
            if (now.get(port) !== v.pid) {
                this.servers.delete(port);
                changed = true;
            }
        }
        if (changed)
            this.push();
    }
    /** Re-push the current list on request (panel opened); prunes dead entries first. */
    async listAndPush() {
        await this.refresh();
        this.push();
    }
    /** Kill ONE background server (by port); returns whether anything was killed. */
    async killOne(port) {
        const entry = this.servers.get(port);
        if (!entry) {
            this.opts.emit({
                type: "notice",
                level: "info",
                text: `Port ${port} is not in the background-task list`,
            });
            this.opts.flushSnapshot();
            return false;
        }
        killPidTree(entry.pid);
        this.servers.delete(port);
        this.push();
        this.opts.emit({
            type: "notice",
            level: "info",
            text: `Stopped background task: port ${port} (pid ${entry.pid})`,
        });
        this.opts.flushSnapshot();
        return true;
    }
    /** Kill every background server the agent started; returns the freed ports. */
    async killAll() {
        if (this.servers.size === 0)
            return [];
        const killed = [];
        for (const [port, { pid }] of [...this.servers]) {
            killPidTree(pid);
            killed.push(String(port));
        }
        this.servers.clear();
        this.push();
        return killed;
    }
}
