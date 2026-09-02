// Settings feature — protocol smoke test (no model calls).
//
// Verifies the full wire path for the settings panel: settings_state pushed on
// attach / get_settings / set_settings (prompt append+replace, skill and
// extension toggles) / save_preset / apply_preset / delete_preset, plus
// per-client persistence across a reconnect.
//
// Runs against the compiled server on a dedicated port (8931). With an
// isolated fake agent dir (PI_CODING_AGENT_DIR → temp) it exercises the
// protocol only; point it at a real agent dir to also exercise the
// skill/extension toggle round-trip (see settings-live flow in git history).
// Usage: npm run build && node settings-test.mjs [port]
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.argv[2] || 8931);
const DATA_DIR = mkdtempSync(join(tmpdir(), "pi-web-set-test-"));
console.log("data-dir:", DATA_DIR);

const server = spawn(process.execPath, ["dist/server/index.js"], {
	env: {
		...process.env,
		PORT: String(PORT),
		PI_WEB_DATA_DIR: DATA_DIR,
		PI_WEB_CWD: process.cwd(),
		PI_CODING_AGENT_DIR: join(DATA_DIR, "agent"),
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[srv-err] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		ws.on("message", (d) => this.received.push(JSON.parse(d.toString())));
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	/** Wait for a message; optional predicate. `type` may be an array of
	 *  acceptable types (snapshot OR snapshot_delta — incremental snapshots
	 *  mean post-action checkpoints often arrive as deltas). A set_settings
	 *  pushes settings_state twice (immediately + after the reload), so stale
	 *  duplicates are consumed while scanning. */
	async waitFor(type, timeout = 8000, pred) {
		const start = Date.now();
		const types = Array.isArray(type) ? type : [type];
		while (Date.now() - start < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const m = this.received[i];
				if (!types.includes(m.type)) continue;
				this.received.splice(i, 1);
				if (!pred || pred(m)) return m;
				i--;
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
}

async function connect() {
	for (let i = 0; i < 60; i++) {
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
			await new Promise((res, rej) => {
				ws.on("open", res);
				ws.on("error", rej);
			});
			return new Client(ws);
		} catch {
			await sleep(500);
		}
	}
	throw new Error("server not ready");
}

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name} ${extra}`);
	}
}

let c;
try {
	c = await connect();
	c.send({ type: "hello", clientId: "settings-test-client" });
	await c.waitFor("ready");
	await c.waitFor(["snapshot", "snapshot_delta"]);
	const st0 = await c.waitFor("settings_state");
	check("settings_state pushed on attach", !!st0.settings);
	check("has skills array", Array.isArray(st0.settings.skills));
	check("has extensions array", Array.isArray(st0.settings.extensions));
	check("has presets array", Array.isArray(st0.settings.presets));
	check("default promptMode=append", st0.settings.promptMode === "append");
	check(
		"settings_state carries built-in default prompts",
		typeof st0.settings.defaultSystemPrompt === "string" &&
			typeof st0.settings.visionBridgeDefaultPrompt === "string" &&
			st0.settings.visionBridgeDefaultPrompt.length > 0,
	);
	console.log(`  skills=${st0.settings.skills.length} extensions=${st0.settings.extensions.length}`);

	c.send({ type: "get_settings" });
	const st1 = await c.waitFor("settings_state");
	check("get_settings echoes state", st1.settings.promptMode === "append");

	// append prompt, then save it as a preset
	c.send({ type: "set_settings", promptMode: "append", customSystemPrompt: "You are a test assistant." });
	const st2 = await c.waitFor("settings_state", 8000, (m) => m.settings.customSystemPrompt === "You are a test assistant.");
	check("append prompt persisted", st2.settings.customSystemPrompt === "You are a test assistant.");

	c.send({ type: "save_preset", name: "test-preset" });
	const st6 = await c.waitFor("settings_state", 8000, (m) => m.settings.presets.some((p) => p.name === "test-preset"));
	check("preset saved", st6.settings.presets.some((p) => p.name === "test-preset"));

	// replace prompt
	c.send({ type: "set_settings", promptMode: "replace", customSystemPrompt: "You are a replacement prompt." });
	const st2b = await c.waitFor("settings_state", 8000, (m) => m.settings.promptMode === "replace");
	check("promptMode replace persisted", st2b.settings.promptMode === "replace");
	c.send({ type: "set_settings", promptMode: "append" });
	await c.waitFor("settings_state", 8000, (m) => m.settings.promptMode === "append");

	// terminal tools toggle: default on → off → still remembered after reconnect; presets capture this switch
	check("terminalToolsEnabled defaults on", st0.settings.terminalToolsEnabled === true);
	c.send({ type: "set_settings", terminalToolsEnabled: false });
	const stT = await c.waitFor("settings_state", 8000, (m) => m.settings.terminalToolsEnabled === false);
	check("terminalToolsEnabled off persisted", stT.settings.terminalToolsEnabled === false);
	// terminal-backed bash: switch + threshold round-trip (regression: dispatch used to drop the forward so clicks did nothing)
	check("terminalBash defaults off", st0.settings.terminalBash === false);
	check("terminalBashIdleMs defaults 15000", st0.settings.terminalBashIdleMs === 15000);
	c.send({ type: "set_settings", terminalBash: true, terminalBashIdleMs: 5000 });
	const stTB = await c.waitFor("settings_state", 8000, (m) => m.settings.terminalBash === true);
	check("terminalBash on round-trips", stTB.settings.terminalBash === true);
	check("terminalBashIdleMs round-trips", stTB.settings.terminalBashIdleMs === 5000);
	c.send({ type: "set_settings", terminalBash: false });
	await c.waitFor("settings_state", 8000, (m) => m.settings.promptMode === "append");
	// thinking-wrap toggle: default off (folded) → on → off again (pure UI pref, persist is enough)
	check("thinkingWrap defaults off", st0.settings.thinkingWrap === false);
	c.send({ type: "set_settings", thinkingWrap: false });
	const stTW = await c.waitFor(
		"settings_state",
		8000,
		(m) => m.settings.thinkingWrap === false,
	);
	check("thinkingWrap off round-trips", stTW.settings.thinkingWrap === false);
	c.send({ type: "set_settings", thinkingWrap: true });
	await c.waitFor("settings_state", 8000, (m) => m.settings.thinkingWrap === true);

	// skill toggle
	const skillName = st0.settings.skills[0]?.name;
	if (skillName) {
		c.send({ type: "set_settings", disabledSkills: [skillName] });
		const st3 = await c.waitFor("settings_state", 8000, (m) => m.settings.disabledSkills.includes(skillName));
		check("skill disabled", st3.settings.disabledSkills.includes(skillName));
		const s = st3.settings.skills.find((x) => x.name === skillName);
		check("disabled skill still listed (re-enableable)", s && !s.enabled);
		c.send({ type: "set_settings", disabledSkills: [] });
		const st4 = await c.waitFor("settings_state", 8000, (m) => m.settings.disabledSkills.length === 0);
		check("skill re-enabled", st4.settings.skills.find((x) => x.name === skillName)?.enabled === true);
	} else {
		console.log("  (no skills loaded — skipping)");
	}

	// extension toggle
	const extId = st0.settings.extensions[0]?.id;
	if (extId) {
		c.send({ type: "set_settings", disabledExtensions: [extId] });
		const st5 = await c.waitFor("settings_state", 8000, (m) => m.settings.disabledExtensions.includes(extId));
		check("extension disabled", st5.settings.disabledExtensions.includes(extId));
		const e = st5.settings.extensions.find((x) => x.id === extId);
		check("disabled extension still listed", e && !e.enabled);
		c.send({ type: "set_settings", disabledExtensions: [] });
		await c.waitFor("settings_state", 8000, (m) => m.settings.disabledExtensions.length === 0);
		check("extension re-enabled", true);
	} else {
		console.log("  (no extensions loaded — skipping)");
	}

	// apply preset → restores append/the saved prompt
	c.send({ type: "set_settings", customSystemPrompt: "temporary content" });
	await c.waitFor("settings_state", 8000, (m) => m.settings.customSystemPrompt === "temporary content");
	c.send({ type: "apply_preset", name: "test-preset" });
	const st7 = await c.waitFor("settings_state", 8000, (m) => m.settings.customSystemPrompt === "You are a test assistant.");
	check("preset applied (prompt restored)", st7.settings.customSystemPrompt === "You are a test assistant.");
	check("preset applied (mode restored)", st7.settings.promptMode === "append");
	// when the preset was saved the switch was on → applying the preset restores it to true (preset captures the switch)
	check("preset applied (terminal toggle restored to captured value)", st7.settings.terminalToolsEnabled === true);

	c.send({ type: "delete_preset", name: "test-preset" });
	const st8 = await c.waitFor("settings_state", 8000, (m) => !m.settings.presets.some((p) => p.name === "test-preset"));
	check("preset deleted", !st8.settings.presets.some((p) => p.name === "test-preset"));

	// persistence across reconnect: turn terminal tools off again, disconnect, should still be remembered
	c.send({ type: "set_settings", terminalToolsEnabled: false });
	await c.waitFor("settings_state", 8000, (m) => m.settings.terminalToolsEnabled === false);
	c.ws.close();
	await sleep(300);
	c = await connect();
	c.send({ type: "hello", clientId: "settings-test-client" });
	await c.waitFor("ready");
	await c.waitFor(["snapshot", "snapshot_delta"]);
	const st9 = await c.waitFor("settings_state");
	check("prompt survives reconnect", st9.settings.customSystemPrompt === "You are a test assistant.");
	check("terminalToolsEnabled survives reconnect (off)", st9.settings.terminalToolsEnabled === false);
	// restore the default-on so later assertions are not affected
	c.send({ type: "set_settings", terminalToolsEnabled: true });
	await c.waitFor("settings_state", 8000, (m) => m.settings.terminalToolsEnabled === true);

	// extensions_reload: rediscover extensions after an external change (e.g. pi remove finished in a terminal)
	c.send({ type: "extensions_reload" });
	await c.waitFor("settings_state", 15000);
	check("extensions_reload re-pushes settings", true);
	c.ws.close();

	console.log(`\n${pass} passed, ${fail} failed`);
} catch (err) {
	console.error("TEST ERROR:", err.message);
	fail++;
} finally {
	server.kill("SIGTERM");
	await sleep(300);
}
process.exit(fail > 0 ? 1 : 0);
