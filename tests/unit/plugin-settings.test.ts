/**
 * Plugin declarative settings (manifest "settings" schema) unit tests:
 * schema parse/validate, default merge, savePluginSettings persist + notify,
 * host.getSettings read.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, type PluginHost } from "../../server/plugins.js";

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, manifest: Record<string, unknown>): Promise<PluginHost> {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...manifest }));
	writeFileSync(join(pdir, "index.mjs"), `export default { activate(h) { (globalThis.__hosts ??= {})["${id}"] = h; } };`);
	return mgr.ensureLoaded().then(() => (globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts[id]!);
}

const SCHEMA_PLUGIN = {
	settings: [
		{ key: "pollSec", type: "number", label: "Interval", default: 60, min: 10, max: 600 },
		{ key: "notify", type: "boolean", label: "Notify", default: true },
		{ key: "theme", type: "select", label: "Theme", default: "dark", options: ["dark", "light"] },
		{ key: "name", type: "text", label: "Name", default: "demo" },
		{ key: "pass", type: "password", label: "Password", default: "" },
	],
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-settings-test-"));
	mgr = new PluginManager(dir, dir);
});

afterEach(() => {
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("schema parse + defaults", () => {
	it("catalog includes schema and values merged with defaults", async () => {
		await makePlugin("cfg", SCHEMA_PLUGIN);
		const list = await mgr.list();
		const p = list.find((x) => x.id === "cfg")!;
		expect(p.settingsSchema?.length).toBe(5);
		expect(p.settingsValues).toEqual({ pollSec: 60, notify: true, theme: "dark", name: "demo", pass: "" });
		// never saved → storage.json does not exist
		expect(existsSync(join(dir, "plugins", "cfg", "storage.json"))).toBe(false);
	});

	it("bad fields are skipped (illegal type / duplicate key / missing key)", async () => {
		await makePlugin("bad", {
			settings: [
				{ key: "ok", type: "boolean", label: "OK" },
				{ key: "x", type: "unknown", label: "bad type" },
				{ key: "ok", type: "text", label: "duplicate" },
				{ type: "text", label: "missing key" },
			],
		});
		const list = await mgr.list();
		const p = list.find((x) => x.id === "bad")!;
		expect(p.settingsSchema?.map((f) => f.key)).toEqual(["ok"]);
	});
});

describe("savePluginSettings", () => {
	it("validate + atomic persist + keep other storage.json keys", async () => {
		const h = await makePlugin("cfg", SCHEMA_PLUGIN);
		h.storage.set("custom", 42); // plugin's own key
		const r = mgr.savePluginSettings("cfg", { pollSec: 120, notify: false, theme: "light", name: "prod", pass: "s3cret" });
		expect(r.error).toBeUndefined();
		const raw = JSON.parse(readFileSync(join(dir, "plugins", "cfg", "storage.json"), "utf8"));
		expect(raw.settings).toEqual({ pollSec: 120, notify: false, theme: "light", name: "prod", pass: "s3cret" });
		expect(raw.custom).toBe(42); // plugin data is not overwritten
		// After rescan, stored values override defaults
		const list = await mgr.list();
		expect(list.find((x) => x.id === "cfg")?.settingsValues).toEqual({ pollSec: 120, notify: false, theme: "light", name: "prod", pass: "s3cret" });
	});

	it("number out of range / illegal select value rejected", async () => {
		await makePlugin("cfg", SCHEMA_PLUGIN);
		expect(mgr.savePluginSettings("cfg", { pollSec: 5 }).error).toContain("out of range");
		expect(mgr.savePluginSettings("cfg", { pollSec: 9999 }).error).toContain("out of range");
		expect(mgr.savePluginSettings("cfg", { theme: "neon" }).error).toContain("invalid value");
		// valid save is unaffected
		expect(mgr.savePluginSettings("cfg", { pollSec: 30 }).error).toBeUndefined();
	});

	it("save refused for plugins with no declared schema", async () => {
		await makePlugin("noschema", { permissions: ["tools"] });
		expect(mgr.savePluginSettings("noschema", { a: 1 }).error).toContain("no declarative settings");
	});
});

describe("host.getSettings + onSettingsChanged", () => {
	it("getSettings reflects stored values live; onSettingsChanged fires after save", async () => {
		const h = await makePlugin("cfg", SCHEMA_PLUGIN);
		expect(h.getSettings().pollSec).toBe(60); // default
		const received: unknown[] = [];
		const off = h.onSettingsChanged((v) => received.push(v));
		mgr.savePluginSettings("cfg", { pollSec: 90 });
		expect(received).toEqual([{ pollSec: 90, notify: true, theme: "dark", name: "demo", pass: "" }]);
		expect(h.getSettings().pollSec).toBe(90);
		off();
		mgr.savePluginSettings("cfg", { pollSec: 100 });
		expect(received).toHaveLength(1); // no longer fires after unregister
	});
});
