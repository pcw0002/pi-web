/**
 * Plugin update/rollback E2E (zero network, self-contained, isolated temp dir):
 * simulate a "remote" with a local git repo and run the real CLI (node bin/pi-web-ui.mjs) end to end:
 *   install (records .pi-git-sha) → remote adds a commit → check-updates reports an update →
 *   install --force updates (auto backup) → check-updates reports latest → --rollback restores the old version
 *  + fallback when git is missing (win32 CI without git auto-skips).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../bin/pi-web-ui.mjs");
const GIT = "git";

function git(...args) {
	return execFileSync(GIT, args, { encoding: "utf8" });
}
function cli(args) {
	const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`CLI failed (${args[0]}): ${r.stderr || r.stdout}`);
	return r.stdout;
}

function main() {
	// git unavailable (e.g. win32 CI without Git for Windows) → skip
	try {
		execFileSync(GIT, ["--version"], { stdio: "ignore" });
	} catch {
		console.log("skip: git unavailable");
		return;
	}
	const root = mkdtempSync(join(tmpdir(), "plugin-update-e2e-"));
	const upstream = join(root, "upstream");
	const dataDir = join(root, "data");
	try {
		// —— 1. build a "remote" git repo v1 ——
		git("init", "-q", upstream);
		git("-C", upstream, "config", "user.email", "t@t");
		git("-C", upstream, "config", "user.name", "t");
		writeFileSync(join(upstream, "manifest.json"), JSON.stringify({ id: "upd", name: "update-demo", version: "v1" }));
		writeFileSync(join(upstream, "index.mjs"), "// v1\n");
		git("-C", upstream, "add", "-A");
		git("-C", upstream, "commit", "-qm", "v1");

		// —— 2. install: local dir source (offline) → .pi-git-sha recorded ——
		const inst = cli(["install", upstream, "--data-dir", dataDir]);
		if (!/Installed plugin upd/.test(inst)) throw new Error("install failed: " + inst);
		const sha1 = readFileSync(join(dataDir, "plugins", "upd", ".pi-git-sha"), "utf8").trim();
		if (!/^[0-9a-f]{12}$/.test(sha1)) throw new Error(`.pi-git-sha missing: ${sha1}`);
		console.log(`✓ install recorded sha=${sha1}`);

		// —— 3. remote adds v2 → check-updates reports an update ——
		writeFileSync(join(upstream, "manifest.json"), JSON.stringify({ id: "upd", name: "update-demo", version: "v2" }));
		writeFileSync(join(upstream, "index.mjs"), "// v2\n");
		git("-C", upstream, "add", "-A");
		git("-C", upstream, "commit", "-qm", "v2");
		const chk1 = cli(["plugins", "--check-updates", "--data-dir", dataDir]);
		if (!/🔄 upd.*update available/.test(chk1)) throw new Error("check-updates did not report an update:\n" + chk1);
		console.log("✓ check-updates reports an update");

		// —— 4. install --force update → backup created + sha refreshed → reports latest ——
		const upd = cli(["install", upstream, "--name", "upd", "--force", "--data-dir", dataDir]);
		if (!/v2/.test(upd)) throw new Error("update failed: " + upd);
		const backups = readdirSync(join(dataDir, "plugin-backups"));
		if (backups.length !== 1 || !backups[0].startsWith("upd-")) throw new Error("backup missing: " + backups.join(","));
		if (readFileSync(join(dataDir, "plugins", "upd", "index.mjs"), "utf8") !== "// v2\n") throw new Error("did not update to v2");
		const chk2 = cli(["plugins", "--check-updates", "--data-dir", dataDir]);
		if (!/up to date/.test(chk2)) throw new Error("did not report up to date after update:\n" + chk2);
		console.log("✓ install --force update + auto backup + sha refresh → up to date");

		// —— 5. --rollback restores v1, backup cleaned ——
		const rb = cli(["plugins", "--rollback", "upd", "--data-dir", dataDir]);
		if (!/Rolled back/.test(rb)) throw new Error("rollback failed: " + rb);
		if (readFileSync(join(dataDir, "plugins", "upd", "index.mjs"), "utf8") !== "// v1\n") throw new Error("not v1 after rollback");
		if (existsSync(join(dataDir, "plugin-backups"))) {
			const left = readdirSync(join(dataDir, "plugin-backups"));
			if (left.length !== 0) throw new Error("backup not cleaned: " + left.join(","));
		}
		console.log("✓ --rollback restored v1 + backup cleaned");

		// —— 6. after rollback, check-updates reports an update again ——
		const chk3 = cli(["plugins", "--check-updates", "--data-dir", dataDir]);
		if (!/🔄 upd.*update available/.test(chk3)) throw new Error("check-updates did not report an update after rollback:\n" + chk3);
		console.log("✓ after rollback, check-updates reports an update again");

		console.log("all ok");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

main();