/**
 * Plugin update helpers (backup / rollback + remote sha compare) — pure
 * logic shared by the CLI (bin/pi-web-ui.mjs) and unit tests. Zero network
 * dependency: the remote sha is obtained via an injected exec (production =
 * git ls-remote; tests = fake exec or a local git repo path — git ls-remote
 * works against a local repo, fully offline).
 *
 * Layout:
 *   <dataDir>/plugins/<id>/             installed copy (includes .pi-source.json + .pi-git-sha)
 *   <dataDir>/plugin-backups/<id>-<ts>/ snapshot of the previous version taken before overwrite (keep last N)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";

const PLUGIN_ID_RE = /^[A-Za-z0-9_-]+$/;
/** Number of backups to keep (older ones are deleted). */
export const BACKUP_KEEP = 3;

export type Exec = (
	cmd: string,
	args: string[],
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** Default executor: run git via execFile (no shell), 15s timeout. */
export const execGit: Exec = (cmd, args) =>
	new Promise((resolve) => {
		execFile(cmd, args, { timeout: 15_000, encoding: "utf8" }, (err, stdout, stderr) => {
			if (err) resolve({ ok: false, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
			else resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});

/**
 * Back up the old plugin directory before overwrite → <dataDir>/plugin-backups/<id>-<ts>/.
 * Returns null if the target is missing or the backup fails (the caller may continue —
 * backup is a best-effort safety net).
 */
export function ensureBackup(dataDir: string, id: string, opts?: { source?: string }): string | null {
	if (!PLUGIN_ID_RE.test(id)) return null;
	const target = join(dataDir, "plugins", id);
	if (!existsSync(target)) return null;
	const ts = stamp();
	const dest = join(dataDir, "plugin-backups", `${id}-${ts}`);
	try {
		mkdirSync(dirnameOf(dest)!, { recursive: true });		cpSync(target, dest, {
			recursive: true,
			// Same as install: skip .git/node_modules (runtime-only tree); keep config.json etc.
			filter: (s) => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(s),
		});
		writeFileSync(
			join(dest, ".pi-backup.json"),
			JSON.stringify({ id, ts, source: opts?.source }, null, 2) + "\n",
		);
		pruneBackups(dataDir, id);
		return ts;
	} catch (err) {
		try {
			rmSync(dest, { recursive: true, force: true });
		} catch {
			/* ignore cleanup failure */
		}
		console.warn(`[plugin-updater] backup of ${id} failed:`, err instanceof Error ? err.message : err);
		return null;
	}
}

/** Backup directories for this plugin, newest first. */
export function listBackups(dataDir: string, id: string): string[] {
	if (!PLUGIN_ID_RE.test(id)) return [];
	const dir = join(dataDir, "plugin-backups");
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const re = new RegExp(`^${id.replace(/[^A-Za-z0-9_-]/g, "")}-(\\d{8}-\\d{9})$`);
	return names
		.filter((n) => re.test(n) && existsSync(join(dir, n, ".pi-backup.json")))
		.sort()
		.reverse();
}

/**
 * Roll back to the newest backup: delete current plugins/<id> → copy the backup back → delete the backup.
 * Returns the backup ts; null if there is no backup.
 */
export function restoreBackup(dataDir: string, id: string): string | null {
	const backups = listBackups(dataDir, id);
	if (backups.length === 0) return null;
	const src = join(dataDir, "plugin-backups", backups[0]);
	const target = join(dataDir, "plugins", id);
	try {
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
		mkdirSync(join(dataDir, "plugins"), { recursive: true });
		cpSync(src, target, { recursive: true });
		rmSync(src, { recursive: true, force: true });
		return backups[0];
	} catch (err) {
		console.warn(`[plugin-updater] rollback of ${id} failed:`, err instanceof Error ? err.message : err);
		return null;
	}
}

/** Keep the newest BACKUP_KEEP copies; delete older ones. */
export function pruneBackups(dataDir: string, id: string, keep = BACKUP_KEEP): void {
	const backups = listBackups(dataDir, id);
	for (const b of backups.slice(keep)) {
		try {
			rmSync(join(dataDir, "plugin-backups", b), { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

/**
 * Parse an install source and fetch the remote HEAD sha (first 12 chars).
 *  - local git repo path / file:// → git ls-remote <path> HEAD (offline)
 *  - GitHub owner/repo or URL → git ls-remote https://github.com/o/r.git HEAD
 *  - unrecognized / git missing / network failure → null (caller marks "cannot check")
 */
export async function resolveRemoteSha(spec: string, exec: Exec = execGit): Promise<string | null> {
	const clean = String(spec ?? "").trim();
	if (!clean) return null;
	let remote: string | null = null;
	if (existsSync(clean)) {
		remote = clean; // local git repo path
	} else if (/^file:\/\//i.test(clean)) {
		remote = clean.slice("file://".length);
	} else {
		// GitHub shape (owner/repo, URL, git@)
		let s = clean.replace(/^git@([^:]+):/, "");
		const m = s.match(/^https?:\/\/(?:www\.)?github\.com\/(.+?)(?:\.git)?\/?$/i);
		if (m) [, s] = m;
		s = s.split("#")[0]; // strip #branch
		const segs = s.split("/").filter(Boolean);
		if (segs.length < 2) return null;
		// Keep only owner/repo (/tree/<ref>/<subpath> suffixes do not affect the remote sha)
		const repo = segs[0] + "/" + segs[1].replace(/\.git$/, "");
		remote = `https://github.com/${repo}.git`;
	}
	if (!remote) return null;
	const res = await exec("git", ["ls-remote", remote, "HEAD"]);
	if (!res.ok) return null;
	// Line format: <sha>\tHEAD (may be multiple lines — take the first)
	const sha = (res.stdout.match(/^([0-9a-f]{40,64})\s+HEAD/m)?.[1]) ?? null;
	return sha ? sha.slice(0, 12) : null;
}

export interface PluginUpdateInfo {
	id: string;
	name?: string;
	version?: string;
	source: string;
	/** Sha recorded at install time (.pi-git-sha). */
	localSha: string | null;
	/** Remote HEAD sha (null = cannot check: not a git source / git unavailable / network failure). */
	remoteSha: string | null;
	/** Both localSha and remoteSha are present and differ. */
	updatable: boolean;
	error?: string;
}

/** Scan every installed plugin, compare local sha vs remote sha, report update status. */
export async function checkPluginUpdates(
	dataDir: string,
	exec: Exec = execGit,
): Promise<PluginUpdateInfo[]> {
	const pluginsDir = join(dataDir, "plugins");
	let names: string[] = [];
	try {
		names = readdirSync(pluginsDir).sort();
	} catch {
		return [];
	}
	const out: PluginUpdateInfo[] = [];
	for (const n of names) {
		if (!PLUGIN_ID_RE.test(n)) continue;
		const dir = join(pluginsDir, n);
		try {
			const sourceJson = readFileSync(join(dir, ".pi-source.json"), "utf8");
			const { source } = JSON.parse(sourceJson) as { source?: string };
			if (!source) continue; // no source record (copied in by hand) → skip
			let localSha: string | null = null;
			try {
				localSha = readFileSync(join(dir, ".pi-git-sha"), "utf8").trim() || null;
			} catch {
				localSha = null; // no sha record → conservatively treat as updatable (unknown installed version)
			}
			let remoteSha: string | null = null;
			let error: string | undefined;
			try {
				remoteSha = await resolveRemoteSha(source, exec);
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
				remoteSha = null;
			}
			if (!remoteSha && !error) error = "Cannot check (not a git source or git unavailable)";
			let name: string | undefined;
			let version: string | undefined;
			try {
				const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
					name?: string;
					version?: string;
				};
				name = m.name;
				version = m.version;
			} catch {
				/* bad manifest: still report */
			}
			const updatable = !!remoteSha && (!localSha || localSha !== remoteSha);
			out.push({
				id: n,
				name,
				version,
				source,
				localSha,
				remoteSha,
				updatable,
				error,
			});
		} catch {
			continue; // skip a bad directory
		}
	}
	return out;
}

function stamp(): string {
	const d = new Date();
	const p = (x: number, n = 2) => String(x).padStart(n, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

function dirnameOf(p: string): string | null {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i >= 0 ? p.slice(0, i) : null;
}
