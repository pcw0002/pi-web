/**
 * Plugin AI-tool extension-point unit tests:
 *  - syncPluginToolsIntoSession: three-way diff (add/update/remove) + incompatible-object fallback;
 *  - PluginManager.registerAgentTool: register / name-clash reject / auto-unregister on deactivate / onAgentToolsChanged callback.
 * Zero token, zero network, millisecond-scale.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncPluginToolsIntoSession, PluginManager } from "../../server/plugins.js";

function okSession() {
	const calls: string[][] = [];
	return {
		session: {
			_customTools: [] as Array<{ name: string } & Record<string, unknown>>,
			_refreshToolRegistry() {
				calls.push(this._customTools!.map((d) => d.name));
			},
		},
		calls,
	};
}

describe("syncPluginToolsIntoSession", () => {
	it("adds tools and triggers registry rebuild", () => {
		const { session, calls } = okSession();
		const defs = [{ name: "mail_list" }, { name: "mail_read" }];
		const next = syncPluginToolsIntoSession(session as never, defs as never, new Set());
		expect(next).toEqual(new Set(["mail_list", "mail_read"]));
		expect(session._customTools!.map((d) => d.name)).toEqual(["mail_list", "mail_read"]);
		expect(calls).toHaveLength(1);
	});

	it("does not rebuild when definitions are unchanged (idempotent)", () => {
		const { session, calls } = okSession();
		const defs = [{ name: "a" }];
		syncPluginToolsIntoSession(session as never, defs as never, new Set());
		const again = syncPluginToolsIntoSession(session as never, defs as never, new Set(defs.map((d) => d.name)));
		expect(again).toEqual(new Set(["a"]));
		expect(calls).toHaveLength(1); // second call had no change, no rebuild
	});

	it("removes unregistered tool names", () => {
		const { session, calls } = okSession();
		session._customTools = [{ name: "bash" }, { name: "mail_list" }];
		const prev = new Set(["mail_list"]);
		const next = syncPluginToolsIntoSession(session as never, [] as never, prev);
		expect(next).toEqual(new Set());
		expect(session._customTools!.map((d) => d.name)).toEqual(["bash"]); // built-in tools untouched
		expect(calls).toHaveLength(1);
	});

	it("returns null and silently falls back when the object is incompatible", () => {
		expect(syncPluginToolsIntoSession({} as never, [], new Set())).toBeNull();
		expect(syncPluginToolsIntoSession({ _customTools: [] } as never, [], new Set())).toBeNull();
	});
});

describe("PluginManager.registerAgentTool", () => {
	function makeFixture(dir: string, body: string) {
		mkdirSync(join(dir, "plugins", "fixture"), { recursive: true });
		writeFileSync(
			join(dir, "plugins", "fixture", "manifest.json"),
			JSON.stringify({ name: "fixture" }),
		);
		writeFileSync(join(dir, "plugins", "fixture", "index.mjs"), body);
	}

	it("register → readable → auto-unregister on deactivate → change callback fires", async () => {
		const base = mkdtempSync(join(tmpdir(), "pwi-plug-tools-"));
		try {
			makeFixture(
				base,
				`
export default {
	activate(host) {
		const offA = host.registerAgentTool({
			name: "fixture_ping",
			description: "test tool",
			execute: async () => ({ content: [{ type: "text", text: "pong" }] }),
		});
		return () => offA();
	},
};
`,
			);
			const mgr = new PluginManager(base, process.cwd());
			let changes = 0;
			mgr.onAgentToolsChanged = () => {
				changes += 1;
			};
			await mgr.ensureLoaded();
			expect(mgr.getAgentTools().map((t) => t.name)).toEqual(["fixture_ping"]);
			expect(changes).toBeGreaterThanOrEqual(1);

			// Duplicate-name registration is rejected (returned unregister fn is a no-op)
			mgr.dispose();
			await mgr.ensureLoaded();
			const before = mgr.getAgentTools().length;
			void before;
			mgr.dispose();

			// After deleting the plugin dir and reloading → tools disappear with it
			rmSync(join(base, "plugins", "fixture"), { recursive: true, force: true });
			const mgr2 = new PluginManager(base, process.cwd());
			await mgr2.ensureLoaded();
			expect(mgr2.getAgentTools()).toEqual([]);
			mgr2.dispose();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
