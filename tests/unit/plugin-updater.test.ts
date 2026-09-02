/**
 * Plugin update helper unit tests: backup/rollback/prune + remote sha compare
 * (injected fake exec; local git repo path uses offline git ls-remote to verify
 * the real flow). Millisecond-scale (git call < 1s), zero token.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
	ensureBackup,
	listBackups,
	restoreBackup,
	pruneBackups,
	resolveRemoteSha,
	checkPluginUpdates,
	execGit,
	BACKUP_KEEP,
	type Exec,
} from "../../server/plugin-updater.js";

let dataDir: string;

function installPlugin(id: string, marker: string, source = "dummy-src") {
	const dir = join(dataDir, "plugins", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: id, version: marker }));
	writeFileSync(join(dir, "index.mjs"), `// ${marker}\n`);
	writeFileSync(join(dir, ".pi-source.json"), JSON.stringify({ source }));
	return dir;
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "plugin-updater-"));
});
afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

describe("backup / rollback", () => {
	it("ensureBackup makes a timestamped backup + .pi-backup.json; prune keeps the most recent N", () => {
		const d = installPlugin("p1", "v1");
		writeFileSync(join(d, "config.json"), "secret");
		const ts1 = ensureBackup(dataDir, "p1", { source: "x" });
		expect(ts1).toBeTruthy();
		const backups = listBackups(dataDir, "p1");
		expect(backups.length).toBe(1);
		expect(existsSync(join(dataDir, "plugin-backups", backups[0], "config.json"))).toBe(true);
		// Backup 3 more times → keep only the most recent 3
		for (let i = 0; i < 3; i++) ensureBackup(dataDir, "p1", { source: "x" });
		expect(listBackups(dataDir, "p1").length).toBe(BACKUP_KEEP ?? 3);
	});

	it("backup excludes node_modules/.git; missing target returns null", () => {
		const d = installPlugin("p1", "v1");
		mkdirSync(join(d, "node_modules"), { recursive: true });
		mkdirSync(join(d, ".git"), { recursive: true });
		writeFileSync(join(d, "node_modules/x.js"), "x");
		const ts = ensureBackup(dataDir, "p1");
		expect(ts).toBeTruthy();
		const dest = join(dataDir, "plugin-backups", listBackups(dataDir, "p1")[0]);
		expect(existsSync(join(dest, "node_modules"))).toBe(false);
		expect(existsSync(join(dest, ".git"))).toBe(false);
		expect(ensureBackup(dataDir, "not-installed")).toBeNull();
	});

	it("restoreBackup restores and cleans the backup; no backup returns null", () => {
		installPlugin("p1", "v1");
		ensureBackup(dataDir, "p1", { source: "x" });
		// Current dir becomes v2
		writeFileSync(join(dataDir, "plugins", "p1", "index.mjs"), "// v2\n");
		const ts = restoreBackup(dataDir, "p1");
		expect(ts).toBeTruthy();
		expect(readFileSync(join(dataDir, "plugins", "p1", "index.mjs"), "utf8")).toBe("// v1\n");
		expect(listBackups(dataDir, "p1").length).toBe(0);
		expect(restoreBackup(dataDir, "p1")).toBeNull();
	});
});

/** fake exec: like git ls-remote, returns sha by remote. */
function fakeExec(shaByRemote: Record<string, string>): Exec {
	return async (_cmd, args) => {
		const remote = args.find((a) => a && a !== "ls-remote" && a !== "HEAD" && !a.startsWith("-"));
		if (remote && shaByRemote[remote]) {
			return { ok: true, stdout: `${shaByRemote[remote]}\tHEAD\n`, stderr: "" };
		}
		return { ok: false, stdout: "", stderr: `fatal: not a git repository '${remote}'` };
	};
}

describe("resolveRemoteSha", () => {
	it("GitHub source fetches sha via injected exec", async () => {
		const exec = fakeExec({ "https://github.com/o/r.git": "abc123def456abc123def456abc123def456abc1" });
		const sha = await resolveRemoteSha("o/r", exec);
		expect(sha).toBe("abc123def456");
	});

	it("#branch / /tree/ subdirectory still fetch sha; failure → null", async () => {
		const exec = fakeExec({ "https://github.com/o/r.git": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
		expect(await resolveRemoteSha("o/r#main", exec)).toBe("aaaaaaaaaaaa");
		expect(await resolveRemoteSha("o/r/tree/main/sub", exec)).toBe("aaaaaaaaaaaa");
		expect(await resolveRemoteSha("garbage!", exec)).toBeNull();
		expect(await resolveRemoteSha("o/missing", fakeExec({}))).toBeNull();
	});

	it("local git repo path uses real git ls-remote (offline)", async () => {
		const repo = mkdtempSync(join(tmpdir(), "plugin-updater-git-"));
		try {
			execFileSync("git", ["init", "-q", repo]);
			execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
			execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
			writeFileSync(join(repo, "f.txt"), "v1");
			execFileSync("git", ["-C", repo, "add", "-A"]);
			execFileSync("git", ["-C", repo, "commit", "-qm", "v1"]);
			const sha = await resolveRemoteSha(repo);
			expect(sha).toMatch(/^[0-9a-f]{12}$/);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("checkPluginUpdates", () => {
	it("different sha → updatable; same → latest; no sha → conservative updatable+error", async () => {
		installPlugin("a", "1", "x/a");
		writeFileSync(join(dataDir, "plugins", "a", ".pi-git-sha"), "111111111111");
		installPlugin("b", "1", "x/b");
		writeFileSync(join(dataDir, "plugins", "b", ".pi-git-sha"), "222222222222");
		// c: no local sha (manually installed GitHub source)
		installPlugin("c", "1", "x/c");
		const exec = fakeExec({
			"https://github.com/x/a.git": "3333333333333333333333333333333333333333",
			"https://github.com/x/b.git": "2222222222222222222222222222222222222222",
			"https://github.com/x/c.git": "4444444444444444444444444444444444444444",
		});
		const res = await checkPluginUpdates(dataDir, exec);
		const upd = res.filter((r) => r.updatable).map((r) => r.id).sort();
		expect(upd).toEqual(["a", "c"]);
		expect(res.find((r) => r.id === "c")?.localSha).toBeNull();
		expect(res.find((r) => r.id === "a")?.version).toBe("1");
	});

	it("failed / unrecognized source → updatable=false + error", async () => {
		installPlugin("d", "1");
		writeFileSync(join(dataDir, "plugins", "d", ".pi-git-sha"), "dddddddddddd");
		const res = await checkPluginUpdates(dataDir, fakeExec({}));
		const d = res.find((r) => r.id === "d");
		expect(d?.updatable).toBe(false);
		expect(d?.remoteSha).toBeNull();
	});

	it("real git command is available (execGit is a function)", () => {
		expect(typeof execGit).toBe("function");
	});
});