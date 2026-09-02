/**
 * PluginManager pure unit tests (zero deps, millisecond-scale): no server, no real model.
 *
 * Covers:
 * - activate/deactivate lifecycle (dispose calls deactivate after the dir is deleted)
 * - handleMessage routes by pluginId; onMessage callback gets the source clientId; can unregister
 * - emitToolEvent fan-out + a throwing handler is isolated
 * - notifyAll / sendTo targeted delivery (fake sender)
 * - scan skips a bad manifest; epoch increments after reload and reactivates
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PluginManager, type PluginToolEvent } from "../../server/plugins.js";
import type { ServerMessage } from "../../server/protocol.js";

let dir: string;
let mgr: PluginManager;

function makePlugin(
	id: string,
	code: string,
	opts?: { client?: boolean; manifest?: Record<string, unknown> },
): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(
		join(pdir, "manifest.json"),
		JSON.stringify({ name: id, ...(opts?.manifest ?? {}) }),
	);
	writeFileSync(join(pdir, "index.mjs"), code);
	if (opts?.client) {
		mkdirSync(join(pdir, "client"), { recursive: true });
		writeFileSync(join(pdir, "client", "entry.mjs"), "export default {};");
	}
}

const ECHO_PLUGIN = `
export default {
	activate(host) {
		host.seen = [];
		return host.onMessage((payload, from) => {
			host.seen.push([payload, from]);
			if (payload?.action === "ping") host.broadcast({ pong: payload.value });
			if (payload?.action === "to") host.sendTo(payload.clientId, { private: true });
			if (payload?.action === "notify") host.notify("warning", "plugin says hi");
		});
	},
};`;
const THROW_PLUGIN = `export default { activate() { throw new Error("boom"); } };`;
const DEACT_PLUGIN = `
globalThis.__deact = globalThis.__deact || [];
export default {
	activate() { return () => { globalThis.__deact.push(1); }; },
};`;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-mgr-test-"));
	mgr = new PluginManager(dir, dir);
});

afterEach(() => {
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("PluginManager", () => {
	it("activate + onMessage routing with sender clientId", async () => {
		makePlugin("echo", ECHO_PLUGIN);
		const list = await mgr.ensureLoaded();
		expect(list.find((p) => p.id === "echo")?.error).toBeUndefined();

		const sent: ServerMessage[] = [];
		mgr.addSender((m) => sent.push(m), () => "client-1");
		mgr.handleMessage("echo", { action: "ping", value: 7 }, "client-1");
		expect(sent).toEqual([
			{ type: "plugin_data", pluginId: "echo", payload: { pong: 7 } },
		]);
	});

	it("handler exceptions are isolated and do not break other handlers", async () => {
		makePlugin(
			"thrower",
			`export default { activate(h) { h.onMessage(() => { throw new Error("nope"); }); } };`,
		);
		makePlugin("echo2", ECHO_PLUGIN);
		await mgr.ensureLoaded();
		const sent: ServerMessage[] = [];
		mgr.addSender((m) => sent.push(m), () => null);
		mgr.handleMessage("thrower", {}, undefined);
		mgr.handleMessage("echo2", { action: "ping", value: 1 }, undefined);
		expect(sent).toHaveLength(1);
	});

	it("emitToolEvent fans out; throwing handler is isolated", async () => {
		makePlugin("tools", `
			globalThis.__toolSeen = [];
			export default {
				activate(h) {
					const offBad = h.onToolEvent(() => { throw new Error("bad"); });
					const off = h.onToolEvent((ev) => { globalThis.__toolSeen.push(ev.phase); });
					return () => { off(); offBad(); };
				},
			};`);
		await mgr.ensureLoaded();
		const ev: PluginToolEvent = { phase: "start", toolName: "bash" };
		mgr.emitToolEvent(ev);
		mgr.emitToolEvent(ev);
		const g = globalThis as { __toolSeen?: string[] };
		expect(g.__toolSeen).toEqual(["start", "start"]);
	});

	it("notifyAll broadcasts a notice; sendTo targets one socket only", async () => {
		makePlugin("echo3", ECHO_PLUGIN);
		await mgr.ensureLoaded();
		const a: ServerMessage[] = [];
		const b: ServerMessage[] = [];
		mgr.addSender((m) => a.push(m), () => "a");
		mgr.addSender((m) => b.push(m), () => "b");
		mgr.handleMessage("echo3", { action: "notify" }, "a");
		mgr.handleMessage("echo3", { action: "to", clientId: "b" }, "b");
		expect(a).toContainEqual({
			type: "notice",
			level: "warning",
			text: "plugin says hi",
		});
		// Targeted message only goes to b
		expect(a.filter((m) => m.type === "plugin_data")).toHaveLength(0);
		expect(b.filter((m) => m.type === "plugin_data")).toHaveLength(1);
	});

	it("scan skips bad manifests; epoch increments on reload; dispose deactivates", async () => {
		makePlugin("good", DEACT_PLUGIN);
		mkdirSync(join(dir, "plugins", "bad"), { recursive: true });
		writeFileSync(join(dir, "plugins", "bad", "manifest.json"), "{oops");
		const first = await mgr.ensureLoaded();
		expect(first.map((p) => p.id)).toEqual(["good"]);
		expect(mgr.epoch).toBe(0);

		const second = await mgr.reload();
		expect(second.map((p) => p.id)).toEqual(["good"]);
		expect(mgr.epoch).toBe(1);

		mgr.dispose();
		expect((globalThis as { __deact?: number[] }).__deact?.length).toBe(2);

		// Activation failure → error field, does not crash the process
		makePlugin("broken", THROW_PLUGIN);
		const third = await mgr.ensureLoaded();
		expect(third.find((p) => p.id === "broken")?.error).toContain("boom");
	});

	it("manifest icon/description surface in the catalog", async () => {
		makePlugin("pretty", "export default {};", {
			client: true,
			manifest: { name: "Pretty", icon: "✨", description: "desc" },
		});
		const list = await mgr.list();
		const p = list.find((x) => x.id === "pretty");
		expect(p?.icon).toBe("✨");
		expect(p?.description).toBe("desc");
		expect(p?.hasClient).toBe(true);
	});
});

// ---- cwd follow (live host.cwd + onCwdChange fan-out) ----------------------------------
type Probe = { activatedCwd?: string; seen?: string[]; liveCwdInHandler?: string };
const probe = (): Probe => (globalThis as unknown as { __cwdProbe: Probe }).__cwdProbe;

const CWD_PLUGIN = `
globalThis.__cwdProbe = globalThis.__cwdProbe || {};
export default {
	activate(host) {
		const p = globalThis.__cwdProbe;
		p.activatedCwd = host.cwd;
		p.seen = [];
		host.onCwdChange(() => { throw new Error("boom"); }); // throwing hook: verify fan-out isolation
		return host.onCwdChange((cwd) => {
			p.seen.push(cwd);
			p.liveCwdInHandler = host.cwd; // getter must return the live value (new root)
			if (String(cwd).endsWith("proj-b")) host.broadcast({ kind: "workspace", root: cwd });
		});
	},
};`;

describe("PluginManager cwd follow", () => {
	it("notifyCwd updates host.cwd, fires hooks, and broadcasts workspace", async () => {
		makePlugin("ed", CWD_PLUGIN);
		await mgr.ensureLoaded();
		// Initial value = the server start dir passed to the constructor
		expect(probe().activatedCwd).toBe(resolve(dir));

		const sent: ServerMessage[] = [];
		mgr.addSender((m) => sent.push(m), () => null);
		const next = resolve(join(dir, "proj-b"));
		mgr.notifyCwd(join(dir, "proj-b")); // internally resolves; no need to pre-normalize
		expect(probe().seen).toEqual([next]);
		expect(probe().liveCwdInHandler).toBe(next);
		expect(sent).toEqual([
			{ type: "plugin_data", pluginId: "ed", payload: { kind: "workspace", root: next } },
		]);

		mgr.notifyCwd(join(dir, "proj-b")); // idempotent: same path is a no-op, no extra hook/broadcast
		expect(probe().seen).toHaveLength(1);
		expect(sent).toHaveLength(1);
	});

	it("throwing cwd hooks are isolated; remaining hooks still run", async () => {
		makePlugin("ed", CWD_PLUGIN); // contains one always-throwing hook + one normal hook
		await mgr.ensureLoaded();
		expect(() => mgr.notifyCwd(join(dir, "x"))).not.toThrow();
		expect(probe().seen).toHaveLength(1); // the normal hook still received the event
	});

	it("old hooks are not fired after dispose deactivates", async () => {
		makePlugin("ed", CWD_PLUGIN);
		await mgr.ensureLoaded();
		mgr.dispose();
		mgr.notifyCwd(join(dir, "y"));
		expect(probe().seen).toHaveLength(0);
	});
});
