/**
 * Plugin host facilities unit tests (zero deps, millisecond-scale):
 * storage / secrets / deps probing / apiVersion gating / slash-command
 * registry. Does not start a server or touch the network.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginSecrets, isDepAvailable } from "../../server/plugin-facilities.js";
import { PLUGIN_API_VERSION, PluginManager, type PluginHost } from "../../server/plugins.js";

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, code: string, manifest?: Record<string, unknown>): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...(manifest ?? {}) }));
	writeFileSync(join(pdir, "index.mjs"), code);
}

/** Capture the host object so tests can assert host-facility behavior. */
async function activate(id: string): Promise<PluginHost> {
	let host!: PluginHost;
	makePlugin(
		id,
		`export default { activate(h) { globalThis.__hosts["${id}"] = h; } };`,
	);
(globalThis as unknown as { __hosts?: Record<string, PluginHost> }).__hosts ??= {};
	await mgr.ensureLoaded();
	host = (globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts[id];
	expect(host).toBeTruthy();
	return host;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-facilities-test-"));
	mgr = new PluginManager(dir, dir);
});

afterEach(() => {
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("host.storage", () => {
	it("get/set/all/delete round-trip + persist to <pluginDir>/storage.json", async () => {
		const h = await activate("a");
		h.storage.set("layout", { split: 0.3 });
		expect(h.storage.get("layout")).toEqual({ split: 0.3 });
		expect(h.storage.get("missing", "fallback")).toBe("fallback");
		expect(Object.keys(h.storage.all())).toContain("layout");
		// Plaintext on disk in the plugin dir; readable across instances (reload)
		expect(existsSync(join(dir, "plugins", "a", "storage.json"))).toBe(true);

		h.storage.set("k", 1);
		h.storage.delete("k");
		expect(h.storage.get("k")).toBeUndefined();
	});
});

describe("host.secrets", () => {
	it("set/get round-trip; plaintext never written to disk; has/list/delete work", async () => {
		const h = await activate("b");
		const secret = "hunter2-super-secret-密码";
		h.secrets.set("mail_pass", secret);
		expect(h.secrets.get("mail_pass")).toBe(secret);
		expect(h.secrets.has("mail_pass")).toBe(true);
		expect(h.secrets.list()).toEqual(["mail_pass"]);

		const raw = readFileSync(join(dir, "plugins", "b", "secrets.bin"), "utf8");
		expect(raw).not.toContain(secret); // ciphertext is present
		expect(raw.length).toBeGreaterThan(50);

		h.secrets.delete("mail_pass");
		expect(h.secrets.get("mail_pass")).toBeUndefined();
		expect(h.secrets.has("mail_pass")).toBe(false);
	});

	it("wrong host key (copied to another machine) cannot decrypt → fail closed returns undefined", async () => {
		const h = await activate("c");
		h.secrets.set("token", "t0psecret");
		// Same plugin dir, different dataDir (= different key)
		const otherDataDir = mkdtempSync(join(tmpdir(), "other-data-"));
		try {
			const stolen = new PluginSecrets(otherDataDir, join(dir, "plugins", "c"));
			expect(stolen.get("token")).toBeUndefined();
		} finally {
			rmSync(otherDataDir, { recursive: true, force: true });
		}
	});
});

describe("deps probing", () => {
	it("isDepAvailable hits built-in modules / returns false for uninstalled packages", () => {
		const pdir = mkdirSync(join(dir, "plugins", "empty"), { recursive: true });
		expect(isDepAvailable(pdir ?? dir, "node:path")).toBe(true);
		expect(isDepAvailable(pdir ?? dir, "definitely-not-a-module-xyz")).toBe(false);
	});
});

describe("apiVersion gating", () => {
	it("manifest apiVersion above host → activation fails with upgrade hint; at or below → activates", async () => {
		makePlugin("futuristic", "export default {};", { apiVersion: PLUGIN_API_VERSION + 1 });
		makePlugin("classic", "export default {};", { apiVersion: 1 });
		const list = await mgr.ensureLoaded();
		expect(list.find((p) => p.id === "futuristic")?.error).toContain("upgrade pi-web-ui");
		expect(list.find((p) => p.id === "classic")?.error).toBeUndefined();
	});
});

describe("host.registerCommand", () => {
	it("register → visible in catalog / findCommand hits → gone after unregister", async () => {
		let ran = "";
		const h = await activate("cmdly");
		const off = h.registerCommand({
			name: "deploy",
			description: "Deploy the current project",
			run(args) {
				ran = args;
				return `deployed ${args}`;
			},
		});
		expect(mgr.listCommands().map((c) => c.name)).toEqual(["deploy"]);
		expect(mgr.findCommand("deploy")?.def.run("prod", { clientId: "x" })).toBe("deployed prod");

		off();
		expect(mgr.listCommands()).toHaveLength(0);
		expect(mgr.findCommand("deploy")).toBeNull();
	});

	it("cross-plugin name clash rejected (first registrant wins); dispose clears all commands", async () => {
		await activate("first");
		(globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts.first.registerCommand({
			name: "shared",
			run: () => "first",
		});
		const h2 = await activate("second");
		const off2 = h2.registerCommand({ name: "shared", run: () => "second" }); // should be rejected
		expect(mgr.listCommands()).toHaveLength(1);
		expect(mgr.findCommand("shared")?.def.run("", { clientId: "" })).toBe("first");

		off2(); // rejected unregister fn should be a no-op
		expect(mgr.listCommands()).toHaveLength(1);

		mgr.dispose();
		expect(mgr.listCommands()).toHaveLength(0);
	});

	it("illegal names (leading digit / spaces) are ignored", async () => {
		const h = await activate("naughty");
		h.registerCommand({ name: "1bad", run: () => 1 });
		h.registerCommand({ name: "has space", run: () => 2 });
		expect(mgr.listCommands()).toHaveLength(0);
	});
});
