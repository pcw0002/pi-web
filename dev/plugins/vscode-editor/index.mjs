/**
 * vscode-editor server entry — filesystem backend for the VS Code-like editor plugin.
 *
 * Convention: ESM default export { activate(host) → deactivate? }.
 * Client sends plugin_message: { action, reqId, ... }; this plugin uses host.sendTo
 * to reply to the requesting socket (reqId matches concurrent calls); no broadcast.
 *
 * Safety:
 * - All paths must be relative to host.cwd (the workspace at service start);
 *   after resolve they must still fall inside root, otherwise reject;
 * - Directory walks skip noise dirs like node_modules/.git and symlinks (loop guard);
 * - Reads cap at 2MB; writes use tmp + rename for atomic persist.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

/** noise names skipped when listing a directory */
const IGNORED = new Set([
	"node_modules", ".git", ".pi-web", ".next", ".nuxt",
	"dist", "build", "out", "venv", ".venv", "__pycache__",
	"coverage", ".cache", ".DS_Store", "Thumbs.db",
]);

const MAX_LIST_ENTRIES = 8000; // flatlist entry cap
const MAX_DEPTH = 12; // flatlist max depth
const MAX_READ_BYTES = 2 * 1024 * 1024; // per-file read cap (shared by local and remote SFTP)
const MAX_SSH_HOSTS = 32;
const CONN_TIMEOUT_MS = 15000;
const MAX_EXEC_OUTPUT = 256 * 1024; // remote exec output truncation cap
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // size cap for downloading a local file to disk (base64 over WS)

function toWire(p) {
	return p.split(path.sep).join("/");
}

export default {
	activate(host) {
		// mutable: follows host app set_cwd in real time (host.onCwdChange, see end of activate)
		let root = path.resolve(host.cwd);

		/** relative path → validated absolute path; null if illegal */
		function safeResolve(rel) {
			if (typeof rel !== "string") return null;
			const abs = path.resolve(root, rel); // "" = workspace root itself, legal
			if (abs !== root && !abs.startsWith(root + path.sep)) return null;
			return abs;
		}

		function fail(reqId, error) {
			return { res: true, reqId, ok: false, error };
		}

		/** single-level directory list (for tree, lazy expand) */
		async function listDir(relDir) {
			const abs = safeResolve(relDir ?? "");
			if (!abs) throw new Error("Path escapes workspace");
			const dirents = await fs.readdir(abs === root ? root : abs, { withFileTypes: true });
			const entries = [];
			for (const d of dirents) {
				if (IGNORED.has(d.name)) continue;
				// do not follow symlinks/junctions (loop / escape guard); type from the name only
				if (d.isSymbolicLink()) continue;
				entries.push({
					name: d.name,
					type: d.isDirectory() ? "dir" : "file",
				});
			}
			entries.sort((a, b) =>
				a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
			);
			return entries;
		}

		/** workspace-flat file list (Ctrl+P); BFS with depth/count caps */
		async function flatList() {
			const files = [];
			let truncated = false;
			const queue = [root];
			while (queue.length && files.length < MAX_LIST_ENTRIES) {
				const dir = queue.shift();
				const depth = dir.slice(root.length).split(path.sep).filter(Boolean).length;
				if (depth >= MAX_DEPTH) continue;
				let dirents;
				try {
					dirents = await fs.readdir(dir, { withFileTypes: true });
				} catch {
					continue; // skip the directory on permission errors etc.
				}
				for (const d of dirents) {
					if (files.length >= MAX_LIST_ENTRIES) {
						truncated = true;
						break;
					}
					if (IGNORED.has(d.name)) continue;
					if (d.isSymbolicLink()) continue;
					const full = path.join(dir, d.name);
					if (d.isDirectory()) queue.push(full);
					else if (d.isFile()) files.push(toWire(path.relative(root, full)));
				}
			}
			return { files, truncated };
		}

		/** content sniff: no NUL and control chars <2% counts as text */
		function looksLikeText(buf) {
			const n = Math.min(buf.length, 8000);
			let ctrl = 0;
			for (let i = 0; i < n; i++) {
				const b = buf[i];
				if (b === 0) return false;
				if (b < 9 || (b > 13 && b < 32)) ctrl++;
			}
			return n === 0 || ctrl / n < 0.02;
		}

		/** decode: strict UTF-8 → GBK → latin1 (same as host decodeText) */
		function decodeBuf(buf) {
			try {
				return new TextDecoder("utf-8", { fatal: true }).decode(buf);
			} catch {}
			try {
				return new TextDecoder("gbk", { fatal: true }).decode(buf);
			} catch {}
			return new TextDecoder("latin1").decode(buf);
		}

		async function readFile(rel) {
			const abs = safeResolve(rel);
			if (!abs) throw new Error("Path escapes workspace");
			const stat = await fs.stat(abs);
			if (!stat.isFile()) throw new Error("Not a regular file");
			if (stat.size > MAX_READ_BYTES) throw new Error(`File exceeds ${MAX_READ_BYTES / 1024 / 1024}MB limit`);
			const buf = await fs.readFile(abs);
			if (!looksLikeText(buf)) return { binary: true, size: stat.size };
			return { text: decodeBuf(buf), encoding: "utf-8", size: stat.size };
		}

		async function writeFile(rel, text) {
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("Invalid path");
			await fs.mkdir(path.dirname(abs), { recursive: true });
			// atomic write: tmp + rename, no truncated files
			const tmp = abs + ".vsc-tmp-" + process.pid;
			await fs.writeFile(tmp, String(text ?? ""), "utf-8");
			await fs.rename(tmp, abs);
		}

		async function createEntry(rel, kind) {
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("Invalid path");
			try {
				if (kind === "dir") await fs.mkdir(abs);
				else {
					await fs.mkdir(path.dirname(abs), { recursive: true });
					await fs.writeFile(abs, "", { flag: "wx" }); // error if it already exists
				}
			} catch (err) {
				if (err.code === "EEXIST") throw new Error("A file or folder with that name already exists");
				throw err;
			}
		}

		async function renameEntry(rel, newName) {
			if (typeof newName !== "string" || !newName.trim()
				|| newName.includes("/") || newName.includes("\\") || newName.includes("..")) {
				throw new Error("Invalid new name");
			}
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("Invalid path");
			await fs.access(abs); // throw if missing
			await fs.rename(abs, path.join(path.dirname(abs), newName));
		}

		async function deleteEntry(rel) {
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("Refusing to delete the workspace root");
			await fs.rm(abs, { recursive: true, force: false });
		}

		// ------------------------------------------------------------------
		// SFTP sync: transfer between local workspace and remote directory
		//
		// config lives in the workspace <root>/.vscode/sftp.json（vscode-sftp compatible field names，
		// Edit that file and Ctrl+S to apply. On first use, migrate from the old plugin directory's
		// sync-configs.json (one-shot). ssh2 is not shipped; auto-install on first use
		// npm install into the plugin directory。direction：up Local→remote；down remote→Local。scope：file
		// single file / tree subtree / all whole repo。exclude rules：vscode-sftp style glob。
		// ------------------------------------------------------------------
		const sftpCfgDir = () => path.join(root, ".vscode");
		const sftpCfgFile = () => path.join(sftpCfgDir(), "sftp.json"); // vscode-sftp conventional path (follows workspace switches)
		const LEGACY_SYNC_STORE = path.join(host.dir, "sync-configs.json"); // legacy store (migration source)
		const syncConns = new Map(); // workspaceRoot → {client,sftp}
		let syncConnFp = ""; // fingerprint of the current connection (reconnect if the config file changes)
		const syncDeps = { mod: null, ok: false, installing: false, waiters: [] };

		function posixJoin(base, rel) {
			if (!rel) return base;
			return `${String(base).replace(/\/+$/, "")}/${String(rel).replace(/^\/+/g, "")}`;
		}

		/** Internal canonical shape; vscode-sftp field names (name/host/remotePath/privateKeyPath/
		 *  passphrase/ignore/agent and the old watcher.autoUpload). vscode-sftp's
		 *  privateKeyPath is often ~/.ssh/id_rsa, so resolve expands ~ (see resolveKeyFile). */
		function normalizeCfg(c) {
			c = c && typeof c === "object" ? c : {};
			const watcher = c.watcher && typeof c.watcher === "object" ? c.watcher : {};
			return {
				name: String(c.name ?? ""),
				host: String(c.host ?? "").trim(),
				port: Number(c.port) || 22,
				username: String(c.username ?? "root"),
				password: String(c.password ?? ""),
				passphrase: String(c.passphrase ?? ""),
				privateKey: String(c.privateKey ?? ""),
				privateKeyPath: String(c.privateKeyPath ?? ""),
				// vscode-sftp also accepts top-level uploadOnSave and the old watcher.autoUpload，both are accepted
				uploadOnSave: Boolean(c.uploadOnSave ?? watcher.autoUpload),
				// ssh-agent socket (vscode-sftp uses "$SSH_AUTH_SOCK"); keep as written in config,
				// expand env vars at connect time (see getSyncSftp)
				agent: String(c.agent ?? ""),
				protocol: String(c.protocol ?? "sftp").toLowerCase(),
				remoteRoot: String(c.remotePath ?? c.remoteRoot ?? "").trim() || "/",
				exclude: Array.isArray(c.ignore ?? c.exclude)
					? [...new Set((c.ignore ?? c.exclude).map(String))].filter(Boolean)
					: [],
			};
		}

		/** Resolve the private-key path: ~ expansion (vscode-sftp ~/.ssh/id_rsa), absolute paths as-is,
		 *  other relative paths fall back to workspace resolve（compatible with old behavior）。 */
		function resolveKeyFile(p) {
			if (!p) return p;
			if (p === "~") return os.homedir();
			if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
			if (path.isAbsolute(p)) return p;
			return path.resolve(root, p);
		}

		/** always re-read the small file——after the user edits .vscode/sftp.json saving applies immediately，no reload needed；
		 *  if missing, try a one-time migrate from the old plugin-dir store */
		async function readSyncCfg() {
			try {
				return normalizeCfg(JSON.parse(await fs.readFile(sftpCfgFile(), "utf8")));
			} catch {}
			try {
				const legacy = JSON.parse(await fs.readFile(LEGACY_SYNC_STORE, "utf8"));
				const old = normalizeCfg(legacy?.[root]);
				if (old.host) {
					await saveSyncCfg(old);
					return old; // migrate succeeded
				}
			} catch {}
			return {};
		}

		/** Write vscode-sftp-style JSON (atomic tmp+rename); the user can open and edit it */
		async function saveSyncCfg(cfg) {
			await fs.mkdir(sftpCfgDir(), { recursive: true });
			const file = {
				host: cfg.host,
				port: cfg.port || 22,
				username: cfg.username || "root",
				protocol: "sftp",
				password: cfg.password || "",
				passphrase: cfg.passphrase || "",
				remotePath: cfg.remoteRoot || "/",
				uploadOnSave: !!cfg.uploadOnSave,
				ignore: cfg.exclude ?? [],
			};
			if (cfg.name) file.name = cfg.name;
			if (cfg.privateKeyPath) file.privateKeyPath = cfg.privateKeyPath;
			if (cfg.privateKey) file.privateKey = cfg.privateKey;
			// Keep the original spelling (including $SSH_AUTH_SOCK placeholder) so it is reusable across environments
			if (cfg.agent) file.agent = cfg.agent;
			const tmp = `${sftpCfgFile()}.tmp-${process.pid}`;
			await fs.writeFile(tmp, JSON.stringify(file, null, 4) + "\n", "utf8");
			await fs.rename(tmp, sftpCfgFile());
		}

		/** Run a command remotely and collect raw stdout Buffer (for packed download; unlike sshExec, no UTF-8 decode) */
		function sshExecBuffer(c, cmd) {
			return new Promise((resolve, reject) => {
				c.client.exec(cmd, (err, stream) => {
					if (err) return void reject(err);
					const chunks = [];
					let size = 0;
					stream.on("data", (d) => {
						size += d.length;
						if (size > MAX_DOWNLOAD_BYTES) {
							try { stream.close(); } catch {}
							return void reject(new Error(`Archive exceeds ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB limit`));
						}
						chunks.push(d);
					});
					stream.stderr.on("data", () => {});
					stream.on("close", () => resolve(Buffer.concat(chunks)));
				});
			});
		}

		/** POSIX shell single-quote escape */
		const shQuote = (s) => `'${String(s ?? "").replace(/'/g, "'\\''")}'`;

		/** Remote path validation: must be absolute with no .. segments */
		function safeRemotePath(p) {
			p = String(p ?? "");
			if (!p.startsWith("/") || p.split("/").includes("..")) throw new Error("Invalid path");
			return p;
		}

		function publicSync(cfg) {
			if (!cfg?.host) return { configured: false };
			return {
				configured: true,
				name: cfg.name ?? "",
				host: cfg.host,	port: cfg.port ?? 22,
				username: cfg.username ?? "root",
				remoteRoot: cfg.remoteRoot ?? "/",
				exclude: cfg.exclude ?? [],
				uploadOnSave: Boolean(cfg.uploadOnSave),
				hasPass: Boolean(cfg.password),
				hasKey: Boolean(cfg.privateKey || cfg.privateKeyPath),
				hasAgent: Boolean(cfg.agent),
				privateKeyPath: cfg.privateKeyPath ?? "",
				agent: cfg.agent ?? "",
			};
		}

		/** lazy-load ssh2; auto npm-install if missing (same pattern as the ssh plugin). */
		function ensureSshMod() {
			if (syncDeps.ok) return Promise.resolve(syncDeps.mod);
			if (syncDeps.installing) return new Promise((res) => syncDeps.waiters.push(res));
			return new Promise(async (res) => {
				syncDeps.installing = true;
				try {
					const m = await import("ssh2");
					syncDeps.mod = m.default ?? m;
					syncDeps.ok = true;
				} catch {
					host.notify("info", "📝 Editor sync: installing dependency (ssh2)…");
					let cli = null;
					try { cli = createRequire(import.meta.url).resolve("npm/bin/npm-cli.js"); } catch {}
					const args = ["--prefix", host.dir, "install", "ssh2@latest", "--no-audit", "--no-fund"];
					const child = cli
						? spawn(process.execPath, [cli, ...args], { stdio: "ignore" })
						: spawn("npm", args, { stdio: "ignore", shell: process.platform === "win32" });
					child.on("error", () => finish(false));
					child.on("exit", (code) => finish(code === 0));
					return;
					async function finish(ok) {
						syncDeps.installing = false;
						if (ok) {
							try {
								const m = await import("ssh2");
								syncDeps.mod = m.default ?? m;
								syncDeps.ok = true;
							} catch {}
						}
						host.notify(syncDeps.ok ? "success" : "error",
							syncDeps.ok ? "📝 Editor sync dependency installed"
								: "📝 Editor sync dependency install failed — in the plugin dir run npm install ssh2");
						for (const w of syncDeps.waiters.splice(0)) w(syncDeps.ok ? syncDeps.mod : null);
						broadcastSshState(); // dep status changed → refresh the ⚠ssh2 button (fn is hoisted, safe)
						res(syncDeps.ok ? syncDeps.mod : null);
					}
				}
				syncDeps.installing = false;
				res(syncDeps.ok ? syncDeps.mod : null);
			});
		}

		function dropSyncConn(key) {
			const c = syncConns.get(key);
			if (!c) return;
			syncConns.delete(key);
			try { c.client.end(); } catch {}
		}

		async function getSyncSftp(cfg) {
			const mod = await ensureSshMod();
			if (!mod?.Client) throw new Error("ssh2 is not ready");
			if (!cfg?.host) throw new Error("Sync is not configured — open ☁ → Sync config or edit .vscode/sftp.json");
			// config fingerprint changed（the user changed .vscode/sftp.json）→ auto-disconnect the old connection and reconnect
			const fp = JSON.stringify([cfg.host, cfg.port, cfg.username, cfg.password, cfg.passphrase, cfg.privateKey, cfg.privateKeyPath, cfg.agent]);
			const entry = syncConns.get(root);
			if (entry && syncConnFp === fp) return entry.sftp;
			dropSyncConn(root);
			const opened = await new Promise((resolve, reject) => {
				const client = new mod.Client();
				const opts = {
					host: cfg.host, port: Number(cfg.port) || 22,
					username: cfg.username || "root",
					readyTimeout: 15000,
					keepaliveInterval: 10000,
				};
			if (cfg.password) opts.password = cfg.password;
			else if (cfg.agent) {
				// ssh-agent socket (vscode-sftp uses "$SSH_AUTH_SOCK" placeholder)
				opts.agent = cfg.agent.replace(/\$SSH_AUTH_SOCK\b/g, () => process.env.SSH_AUTH_SOCK || "");
				connect();
				return;
			}
			else {
				// private key：privateKeyPath takes priority over inline PEM；paths support ~ expand（vscode-sftp convention ~/.ssh/id_rsa）
				const keyPath = cfg.privateKeyPath ? resolveKeyFile(cfg.privateKeyPath) : null;
				Promise.resolve(keyPath ? fs.readFile(keyPath, "utf8") : cfg.privateKey)
					.then((key) => {
						if (!key) return reject(new Error("Provide a password, private key, or agent (edit .vscode/sftp.json or use ☁ Sync config)"));
						opts.privateKey = key;
						if (cfg.passphrase) opts.passphrase = cfg.passphrase;
					})
					.catch(() => reject(new Error(`Failed to read private key file：${cfg.privateKeyPath}`)))
					.then(connect);
				return;
			}
			connect();
				function connect() {
					client.on("ready", () => {
						client.sftp((err, sftp) => {
							if (err) { try { client.end(); } catch {} return reject(err); }
							syncConns.set(root, { client, sftp });
							resolve({ client, sftp });
						});
					});
					client.on("error", (e) => { try { client.end(); } catch {} reject(e); });
					client.connect(opts);
				}
			});
			syncConnFp = fp;
			return opened.sftp;
		}

		/** glob → RegExp (supports globstar, star, and question mark; vscode-sftp style).
		 *  For example, a globstar + slash + *.map matches files at any depth. */
		function globToRegExp(pattern) {
			let re = "";
			for (let i = 0; i < pattern.length; i++) {
				const c = pattern[i];
				if (c === "*") {
					if (pattern[i + 1] === "*") {
						i++;
						if (i >= pattern.length - 1) re += ".*"; // trailing **：match the rest across remaining levels（a/** match nested files）
						else if (pattern[i + 1] === "/") { i++; re += "(?:[^/]*/)*"; } // "**/" match zero or more directory levels
						else re += ".*";
					} else re += "[^/]*";
				} else if (c === "?") re += "[^/]";
				else if ("\\^$.|+()[]{}".includes(c)) re += "\\" + c;
				else re += c;
			}
			return new RegExp(`^${re}$`);
		}

		/** compile ignore rule set：whole-path match + slash-less patterns match at any depth + a directory rule covers everything under it */
		function makeIgnoreMatcher(patterns) {
			const rules = (patterns ?? []).map(String).filter(Boolean).map((raw) => {
				const pat = raw.replace(/^\/+|\/+$/g, "");
				if (pat === "**") return [/.*/]; // ignore everything
				const list = [globToRegExp(pat)];
				if (!pat.includes("/")) {
					list.push(globToRegExp(`**/${pat}`)); // "dist"、"*.log" match a segment at any depth
					list.push(globToRegExp(`${pat}/**`)); // a directory-name rule covers everything under that top-level name
					list.push(globToRegExp(`**/${pat}/**`)); // same-named directory contents at any depth
				}
				if (pat.endsWith("/**")) list.push(globToRegExp(pat.slice(0, -3))); // a/** also ignores a itself
				return list;
			});
			return (rel) => rules.some((list) => list.some((re) => re.test(rel)));
		}

		function isSyncExcluded(rel, cfg) {
			return makeIgnoreMatcher(cfg.exclude)(rel);
		}

		/** collect the relative file list to transfer（shared by both sides：only produce rel path array） */
		async function collectLocal(relBase, cfg) {
			const out = [];
			async function walk(absDir, relDir) {
				const dirents = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
				for (const d of dirents) {
					const rel = relDir ? `${relDir}/${d.name}` : d.name;
					if (isSyncExcluded(rel, cfg)) continue;
					if (d.isSymbolicLink()) continue;
					if (d.isDirectory()) await walk(path.join(absDir, d.name), rel);
					else if (d.isFile()) out.push(rel);
				}
			}
			await walk(path.resolve(root, relBase || ""), relBase || "");
			return out;
		}

		function sftpCall(sftp, method, ...args) {
			return new Promise((resolve, reject) => sftp[method](...args, (err, r) => (err ? reject(err) : resolve(r))));
		}

		async function collectRemote(sftp, remoteBase, relBase, cfg) {
			const out = [];
			async function walk(rdir, relDir) {
				let list;
				try { list = await sftpCall(sftp, "readdir", rdir); }
				catch { return; } // missing directory is treated as empty
				for (const f of list) {
					const rel = relDir ? `${relDir}/${f.filename}` : f.filename;
					if (isSyncExcluded(rel, cfg)) continue;
					if (f.attrs.isDirectory()) await walk(`${rdir}/${f.filename}`, rel);
					else if (f.attrs.isFile()) out.push(rel);
				}
			}
			await walk(remoteBase, relBase || "");
			return out;
		}

		async function mkdirpRemote(sftp, rpath) {
			const segs = rpath.split("/").filter(Boolean);
			let cur = rpath.startsWith("/") ? "" : ".";
			for (const s of segs) {
				cur = cur === "." ? s : `${cur}/${s}`;
				await sftpCall(sftp, "mkdir", cur).catch(() => {}); // already-exists errors，ignore
			}
		}

		/** run one sync job；return a summary。progress(onDone, name) report progress。 */
		async function runSyncTransfer(cfg, direction, scope, targetRel, onProgress) {
			const sftp = await getSyncSftp(cfg);
			let rels;
			if (scope === "file") {
				rels = [targetRel];
				if (isSyncExcluded(targetRel, cfg)) throw new Error(`「${targetRel}」is in the exclude list`);
			} else {
				const baseRel = scope === "tree" ? String(targetRel || "") : "";
				rels = direction === "up"
					? await collectLocal(baseRel, cfg)
					: await collectRemote(sftp, posixJoin(cfg.remoteRoot || "/", baseRel), baseRel, cfg);
			}
			const failed = [];
			let done = 0;
			for (const rel of rels) {
				try {
					if (direction === "up") {
						const rp = posixJoin(cfg.remoteRoot || "/", rel);
						await mkdirpRemote(sftp, rp.split("/").slice(0, -1).join("/"));
						await sftpCall(sftp, "writeFile", rp, await fs.readFile(path.resolve(root, rel)));
					} else {
						const lp = path.resolve(root, rel);
						await fs.mkdir(path.dirname(lp), { recursive: true });
						await fs.writeFile(lp, await sftpCall(sftp, "readFile", posixJoin(cfg.remoteRoot || "/", rel)));
					}
				} catch (err) {
					failed.push({ rel, error: err?.message ?? String(err) });
				}
				done++;
				onProgress(done, rels.length, rel);
			}
			return { total: rels.length, failed };
		}

		// ------------------------------------------------------------------
		// SSH remote hosts (Remote-SSH mode)
		//
		// host CRUD（<pluginDir>/ssh-hosts.json，plaintext on this machine、redacted echo；first run
		// auto from the old standalone ssh same-named config migrate from the plugin）+ connection pool（keepalive keepalive）+
		// PTY shell（base64 stream-forward）+ exec。
		// Remote file ops have no separate action — the client sends list/read/write/create/rename/
		// delete with connId to route to that connection's SFTP; same frontend path model as local files.
		// ssh2 deps reuse the helper above ensureSshMod（auto-install if missing）。
		// Events: shell_data / shell_exit / conn_closed are pushed only to the creator socket;
		// kind:"state" broadcast hosts/connection-list changes（credentials redacted）。
		// ------------------------------------------------------------------
		const SSH_STORE = path.join(host.dir, "ssh-hosts.json");
		const LEGACY_SSH_STORE = path.join(host.dir, "..", "ssh", "ssh-hosts.json");
		// secrets storage：host password/private key/passphrase per host id go through the host host.secrets
		//（AES-256-GCM）；ssh-hosts.json no longer persist plaintext credentials。fall back to the old behavior when the host lacks this facility。
		const sec = host.secrets;
		const SECRET_FIELDS = [
			["password", "pass"],
			["privateKey", "key"],
			["passphrase", "pp"],
		];

		function hostSecretName(hostId, fileField) {
			for (const [f, short] of SECRET_FIELDS) if (f === fileField) return `ssh:${hostId}:${short}`;
			return null;
		}

		let sshCfgs = null;
		const sshConns = new Map(); // connId → connection record
		let nextSshConn = 1;

		async function ensureSshCfgs() {
			if (sshCfgs) return sshCfgs;
			try {
				sshCfgs = JSON.parse(await fs.readFile(SSH_STORE, "utf8"));
			} catch {
				sshCfgs = {};
			}
			if (!Array.isArray(sshCfgs.hosts)) {
				try { // migrate the old standalone ssh the plugin's host list（same format, copy as-is）
					const legacy = JSON.parse(await fs.readFile(LEGACY_SSH_STORE, "utf8"));
					if (Array.isArray(legacy.hosts) && legacy.hosts.length) sshCfgs.hosts = legacy.hosts;
				} catch {}
			}
			if (!Array.isArray(sshCfgs.hosts)) sshCfgs.hosts = [];
			if (sec?.set) {
				// one-shot migrate：historical plaintext credentials → encrypted secrets + strip from file
				let migrated = false;
				for (const h of sshCfgs.hosts) {
					if (!h.id) continue;
					for (const [field] of SECRET_FIELDS) {
						const name = hostSecretName(h.id, field);
						if (h[field] && name) {
							try { sec.set(name, String(h[field])); } catch { continue; }
							delete h[field];
							migrated = true;
						}
					}
				}
				if (migrated) { try { await saveSshCfgs(); } catch {} host.log("Migrated SSH host credentials into encrypted storage"); }
			}
			if (sec?.get) {
				// refill the in-memory copy（connecting needs real credentials；redacted echo is done in publicSshHost layer）
				for (const h of sshCfgs.hosts) {
					if (!h.id) continue;
					for (const [field] of SECRET_FIELDS) {
						if (!h[field]) {
							const name = hostSecretName(h.id, field);
							const v = name ? sec.get(name) : undefined;
							if (v !== undefined) h[field] = v;
						}
					}
				}
			}
			return sshCfgs;
		}

		async function saveSshCfgs() {
			const hosts = sec
				? (sshCfgs?.hosts ?? []).map((h) => {
					const clean = { ...h };
					for (const [field] of SECRET_FIELDS) delete clean[field]; // credentials go only into the secrets store
					return clean;
				})
				: (sshCfgs?.hosts ?? []);
			await fs.writeFile(SSH_STORE, JSON.stringify({ ...sshCfgs, hosts }, null, "\t"), "utf8");
		}

		/** Save/clear one host credential field (truthy → write; explicit null → delete). */
		function storeHostSecret(hostId, field, value) {
			const name = hostSecretName(hostId, field);
			if (!sec || !name || !hostId) return;
			try {
				if (value === null) sec.delete(name);
				else if (value) sec.set(name, String(value));
			} catch {}
		}

		/** redacted echo：Password/private key is not echoed，only report whether it exists */
		function publicSshHost(h) {
			return {
				id: h.id, name: h.name, host: h.host, port: h.port ?? 22,
				username: h.username ?? "root",
				hasPass: Boolean(h.password), hasKey: Boolean(h.privateKey),
			};
		}

		function publicSshState() {
			return {
				depsReady: syncDeps.ok,
				depsInstalling: syncDeps.installing,
				hosts: (sshCfgs?.hosts ?? []).map(publicSshHost),
				conns: [...sshConns.values()].map((c) => ({
					connId: c.connId, hostId: c.hostId, label: c.label, status: c.status,
				})),
			};
		}

		function broadcastSshState() {
			host.broadcast({ kind: "state", state: publicSshState() });
		}

		function getSshConn(connId) {
			const c = sshConns.get(connId);
			if (!c) throw new Error("Connection does not exist or is closed");
			return c;
		}

		function dropSshConn(c, reason) {
			if (!sshConns.has(c.connId)) return;
			sshConns.delete(c.connId);
			for (const [, stream] of c.streams) { try { stream.end(); } catch {} }
			c.streams.clear();
			try { c.client.end(); } catch {}
			host.sendTo(c.ownerId, { event: "conn_closed", connId: c.connId, reason: reason ?? "" });
			broadcastSshState();
		}

		async function connectSshHost(cfg, clientId, reqId) {
			try {
				const mod = await ensureSshMod();
				if (!mod?.Client) throw new Error("ssh2 is not ready, try again shortly");
				const connId = `c${nextSshConn++}`;
				const c = {
					connId, client: new mod.Client(), ownerId: clientId, hostId: cfg.id,
					label: cfg.name || `${cfg.username}@${cfg.host}`,
					status: "connecting", streams: new Map(), nextShell: 1, sftp: null,
				};
				sshConns.set(connId, c);
				broadcastSshState();
				const opts = {
					host: cfg.host, port: Number(cfg.port) || 22,
					username: cfg.username || "root",
					readyTimeout: CONN_TIMEOUT_MS,
					keepaliveInterval: 10000, keepaliveCountMax: 3,
				};
				if (cfg.password) opts.password = cfg.password;
				else if (cfg.privateKey) opts.privateKey = cfg.privateKey;
				c.client
					.on("ready", () => {
						c.status = "connected";
						host.sendTo(clientId, { res: true, reqId, ok: true, action: "connect", connId, label: c.label });
						broadcastSshState();
					})
					.on("error", (err) => {
						const m = err?.level ? `[${err.level}] ${err.message}` : err?.message ?? String(err);
						if (c.status === "connecting") { // failed first connect must not leave a half-open connection
							sshConns.delete(connId);
							broadcastSshState();
							host.sendTo(clientId, { res: true, reqId, ok: false, action: "connect", error: m });
						} else dropSshConn(c, m);
					})
					.on("close", () => dropSshConn(c, "Connection closed"));
				c.client.connect(opts);
			} catch (err) {
				host.sendTo(clientId, { res: true, reqId, ok: false, action: "connect", error: err?.message ?? String(err) });
			}
		}

		function getSftp(c) {
			if (c.sftp) return Promise.resolve(c.sftp);
			return new Promise((resolve, reject) => {
				c.client.sftp((err, sftp) => {
					if (err) return reject(err);
					c.sftp = sftp;
					sftp.on("close", () => { if (c.sftp === sftp) c.sftp = null; });
					resolve(sftp);
				});
			});
		}

		// ---- remote file operations（via the connection's SFTP；errors are thrown up to the router catch） -----------------
		async function remoteList(c, dirPath) {
			const list = await sftpCall(await getSftp(c), "readdir", dirPath || "/");
			const entries = list.map((f) => ({
				name: f.filename,
				type: f.attrs.isDirectory() ? "dir" : f.attrs.isSymbolicLink() ? "link" : "file",
				size: Number(f.attrs.size ?? 0),
			}));
			entries.sort((a, b) =>
				(a.type === "file" ? 1 : 0) - (b.type === "file" ? 1 : 0) || a.name.localeCompare(b.name));
			return entries;
		}

		async function remoteRead(c, p) {
			const sftp = await getSftp(c);
			const stat = await sftpCall(sftp, "stat", p);
			if (stat.size > MAX_READ_BYTES) throw new Error(`File exceeds ${MAX_READ_BYTES / 1024 / 1024}MB limit`);
			const buf = await sftpCall(sftp, "readFile", p);
			if (buf.includes(0)) return { binary: true, size: buf.length };
			return { text: decodeBuf(buf), encoding: "utf-8", size: buf.length };
		}

		async function remoteWrite(c, p, text) {
			await sftpCall(await getSftp(c), "writeFile", p, Buffer.from(String(text ?? ""), "utf8"));
		}

		async function remoteCreate(c, p, kind) {
			const sftp = await getSftp(c);
			if (kind === "dir") await sftpCall(sftp, "mkdir", p);
			else await sftpCall(sftp, "writeFile", p, Buffer.alloc(0));
		}

		async function remoteRename(c, p, newName) {
			if (typeof newName !== "string" || !newName.trim()
				|| newName.includes("/") || newName.includes("\\") || newName.includes("..")) {
				throw new Error("Invalid new name");
			}
			const idx = p.lastIndexOf("/");
			const parent = idx >= 0 ? p.slice(0, idx) : "";
			await sftpCall(await getSftp(c), "rename", p, parent ? `${parent}/${newName}` : newName);
		}

		async function remoteDelete(c, p, isDir) {
			const sftp = await getSftp(c);
			if (isDir) await sftpCall(sftp, "rmdir", p);
			else await sftpCall(sftp, "unlink", p);
		}

		// ---- PTY shell and exec ---------------------------------------------------
		function sshOpenShell(c, msg, reqId, clientId) {
			c.ownerId = clientId; // reconnect/after extra tabs：the latest requester takes over this connection's terminal output stream
			c.client.shell(
				{ cols: msg.cols ?? 80, rows: msg.rows ?? 24, term: "xterm-256color" },
				(err, stream) => {
					if (err) return void host.sendTo(clientId, { res: true, reqId, ok: false, action: "shell_open", error: err.message });
					const shellId = `s${c.nextShell++}`;
					c.streams.set(shellId, stream);
					const onData = (d) => host.sendTo(c.ownerId, {
						event: "shell_data", connId: c.connId, shellId, b64: d.toString("base64"),
					});
					stream.on("data", onData);
					stream.stderr.on("data", onData);
					stream.on("close", () => {
						c.streams.delete(shellId);
						host.sendTo(c.ownerId, { event: "shell_exit", connId: c.connId, shellId });
					});
					host.sendTo(clientId, { res: true, reqId, ok: true, action: "shell_open", shellId });
				},
			);
		}

		function sshExec(c, cmd, reqId, clientId) {
			c.client.exec(cmd, (err, stream) => {
				if (err) return void host.sendTo(clientId, { res: true, reqId, ok: false, action: "exec", error: err.message });
				const chunks = [];
				stream.on("data", (d) => chunks.push(d.toString("utf8")));
				stream.stderr.on("data", (d) => chunks.push(d.toString("utf8")));
				stream.on("close", (code) => {
					let out = chunks.join("");
					if (out.length > MAX_EXEC_OUTPUT) out = out.slice(0, MAX_EXEC_OUTPUT) + "\n…[truncated]";
					host.sendTo(clientId, { res: true, reqId, ok: true, action: "exec", exitCode: code ?? 0, output: out });
				});
			});
		}

		const off = host.onMessage(async (payload, clientId) => {
			const msg = payload ?? {};
			const { action, reqId } = msg;
			try {
				switch (action) {
					case "list": // single-level directory (lazy tree); connId = remote directory
						if (msg.connId) {
							host.sendTo(clientId, { res: true, reqId, ok: true, action,
								dir: String(msg.dir ?? "/"), entries: await remoteList(getSshConn(msg.connId), msg.dir) });
							break;
						}
						host.sendTo(clientId, { res: true, reqId, ok: true, action,
							dir: toWire(msg.dir ?? ""), entries: await listDir(msg.dir) });
						break;
					case "flatlist":
						host.sendTo(clientId, { res: true, reqId, ok: true, action, ...(await flatList()) });
						break;
					case "download": { // download to the user's computer: local read; connId uses remote SFTP; folders pack as tar.gz
						if (!msg.connId) {
							const abs = safeResolve(String(msg.path ?? ""));
							if (!abs || abs === root) throw new Error("Invalid path");
							const st = await fs.stat(abs);
							if (!st.isFile()) throw new Error("Not a regular file");
							if (st.size > MAX_DOWNLOAD_BYTES) throw new Error(`File exceeds ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB limit`);
							const buf = await fs.readFile(abs);
							host.sendTo(clientId, { res: true, reqId, ok: true, action, b64: buf.toString("base64"), size: st.size });
							break;
						}
						// remote scope
						const c = getSshConn(msg.connId);
						const p = safeRemotePath(msg.path);
						const sftp = await getSftp(c);
						let st;
						try { st = await sftpCall(sftp, "stat", p); } catch { throw new Error("Path not found"); }
						if (st.isDirectory()) {
							// Folder：pack in place on the remote（tar.gz），avoid transferring file-by-file
							const clean = p.replace(/\/+$/, "");
							const name = clean.split("/").pop();
							const parent = clean.split("/").slice(0, -1).join("/") || "/";
							const buf = await sshExecBuffer(c, `cd ${shQuote(parent)} && tar -czf - ${shQuote(name)}`);
							if (!buf.length) throw new Error("Pack failed (no tar on remote, or directory unreadable)");
							host.sendTo(clientId, { res: true, reqId, ok: true, action,
								b64: buf.toString("base64"), size: buf.length, name: `${name}.tar.gz` });
						} else {
							if (Number(st.size) > MAX_DOWNLOAD_BYTES) throw new Error(`File exceeds ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB limit`);
							const buf = await sftpCall(sftp, "readFile", p);
							host.sendTo(clientId, { res: true, reqId, ok: true, action,
								b64: buf.toString("base64"), size: buf.length, name: p.split("/").pop() });
						}
						break;
					}
					case "read": {
						const r = msg.connId
							? await remoteRead(getSshConn(msg.connId), String(msg.path ?? ""))
							: await readFile(msg.path);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, path: msg.path, ...r });
						break;
					}
					case "write":
						if (msg.connId) await remoteWrite(getSshConn(msg.connId), String(msg.path ?? ""), msg.text);
						else await writeFile(msg.path, msg.text);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, path: msg.path });
						break;
					case "create":
						if (msg.connId) await remoteCreate(getSshConn(msg.connId), String(msg.path ?? ""), msg.kind);
						else await createEntry(msg.path, msg.kind);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "rename":
						if (msg.connId) await remoteRename(getSshConn(msg.connId), String(msg.path ?? ""), msg.newName);
						else await renameEntry(msg.path, msg.newName);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "delete":
						if (msg.connId) await remoteDelete(getSshConn(msg.connId), String(msg.path ?? ""), Boolean(msg.isDir));
						else await deleteEntry(msg.path);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "sync_get": { // Note：do not mix with remote SFTP operation mix（remote uses list/read + connId）
						const cfg = await readSyncCfg();
						return void host.sendTo(clientId, { res: true, reqId, ok: true, action,
							config: publicSync(cfg),
							configPath: ".vscode/sftp.json", // frontend "edit config file" entry
						});
					}
					case "sync_save": {
						const c = msg.config ?? {};
						if (!c.host || !String(c.host).trim()) throw new Error("Host cannot be empty");
						if (!String(c.remoteRoot ?? "").trim().startsWith("/")) throw new Error("Remote root must be an absolute path (start with /)");
						const old = await readSyncCfg();
					const next = normalizeCfg({
						...old,
						host: String(c.host).trim(), port: Number(c.port) || 22,
						username: c.username ?? old.username ?? "root",
						name: c.name !== undefined ? String(c.name || "") : (old.name ?? ""),
						// leave credentials blank = keep the old value；explicit null = clear
						password: c.password === null ? "" : (c.password || old.password),
						passphrase: c.passphrase === null ? "" : (c.passphrase || old.passphrase),
						privateKey: c.privateKey === null ? "" : (c.privateKey || old.privateKey),
						privateKeyPath: c.privateKeyPath !== undefined ? String(c.privateKeyPath || "").trim() : (old.privateKeyPath ?? ""),
						agent: c.agent !== undefined ? String(c.agent || "") : (old.agent ?? ""),
						remoteRoot: String(c.remoteRoot).trim(),
						exclude: Array.isArray(c.exclude) ? c.exclude.map(String) : [],
						uploadOnSave: Boolean(c.uploadOnSave),
					});
						await saveSyncCfg(next);
						dropSyncConn(root); // config changed，drop the old connection
						return void host.sendTo(clientId, { res: true, reqId, ok: true, action,
							config: publicSync(next), configPath: ".vscode/sftp.json",
						});
					}
					case "sync_ensure": { // "edit config file": ensure it exists (template/migrate if needed), return relative path
						let cfg = await readSyncCfg();
						if (!cfg.host) {
							cfg = normalizeCfg({ host: "", remoteRoot: "/", ignore: [".git", "node_modules"] });
							await saveSyncCfg(cfg);
						}
						return void host.sendTo(clientId, { res: true, reqId, ok: true, action, path: ".vscode/sftp.json", configPath: ".vscode/sftp.json" });
					}
					case "sync_test": {
						const cfg = await readSyncCfg();
						if (!cfg?.host) throw new Error("Sync is not configured — open ☁ → Sync config or edit .vscode/sftp.json");
						const sftp = await getSyncSftp(cfg);
						// probe that the remote root is reachable
						await sftpCall(sftp, "readdir", cfg.remoteRoot || "/");
						return void host.sendTo(clientId, { res: true, reqId, ok: true, action });
					}
					case "sync_run": {
						const cfg = await readSyncCfg();
						if (!cfg?.host) throw new Error("Sync is not configured — open ☁ → Sync config or edit .vscode/sftp.json");
						const direction = msg.dir === "down" ? "down" : "up";
						const scope = ["file", "tree", "all"].includes(msg.scope) ? msg.scope : "file";
						if (scope === "file") {
							const abs = safeResolve(msg.path);
							if (!abs || abs === root) throw new Error("Invalid path");
						}
						const summary = await runSyncTransfer(cfg, direction, scope, msg.path ?? "",
							(done, total, name) => host.sendTo(clientId, { event: "sync_progress", done, total, name }));
						return void host.sendTo(clientId, { res: true, reqId, ok: true, action, ...summary, dir: direction, scope });
					}
					// ----------------------------------------------------------------
					// SSH remote host management
					// ----------------------------------------------------------------
					case "state": // plugin state: host list / connection list / ssh2 dep status (redacted)
						await ensureSshCfgs();
						host.sendTo(clientId, { res: true, reqId, ok: true, action, state: publicSshState() });
						break;
					case "deps_install":
						ensureSshMod(); // internally idempotent，if already installing, wait，broadcast after install state
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "hosts_save": {
						await ensureSshCfgs();
						const h = msg.host ?? {};
						if (!h.host || !String(h.host).trim()) throw new Error("Host cannot be empty");
						if (h.id) {
							const i = sshCfgs.hosts.findIndex((x) => x.id === h.id);
							if (i < 0) throw new Error("Host not found");
							const old = sshCfgs.hosts[i];
							// credentials go into the secrets store：leave blank = keep the old value；explicit null = clear（also delete the secret）；
							// in-memory object still keeps real credentials; redaction is in publicSshHost
							storeHostSecret(h.id, "password", h.password === null ? null : (h.password || undefined));
							storeHostSecret(h.id, "privateKey", h.privateKey === null ? null : (h.privateKey || undefined));
							sshCfgs.hosts[i] = {
								...old,
								name: h.name ?? old.name,
								host: String(h.host).trim() || old.host,
								port: Number(h.port) || old.port,
								username: h.username ?? old.username,
								// leave credentials blank = keep the old value；explicit null = clear
								password: h.password === null ? undefined : (h.password || old.password),
								privateKey: h.privateKey === null ? undefined : (h.privateKey || old.privateKey),
							};
						} else {
							if (!h.password && !h.privateKey) throw new Error("Enter a password or private key (blank cannot authenticate)");
							if (sshCfgs.hosts.length >= MAX_SSH_HOSTS) throw new Error(`At most ${MAX_SSH_HOSTS} hosts`);
							const id = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
							storeHostSecret(id, "password", h.password || undefined);
							storeHostSecret(id, "privateKey", h.privateKey || undefined);
							sshCfgs.hosts.push({
								id,
								name: String(h.name || h.host),
								host: String(h.host).trim(),
								port: Number(h.port) || 22,
								username: String(h.username || "root"),
								password: h.password ? String(h.password) : undefined,
								privateKey: h.privateKey ? String(h.privateKey) : undefined,
							});
						}
						await saveSshCfgs();
						broadcastSshState();
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "hosts_delete": {
						await ensureSshCfgs();
						const before = sshCfgs.hosts.length;
						for (const x of sshCfgs.hosts) {
							if (x.id === msg.id) for (const [field] of SECRET_FIELDS) storeHostSecret(x.id, field, null);
						}
						sshCfgs.hosts = sshCfgs.hosts.filter((x) => x.id !== msg.id);
						if (sshCfgs.hosts.length === before) throw new Error("Host not found");
						await saveSshCfgs();
						for (const c of [...sshConns.values()]) if (c.hostId === msg.id) dropSshConn(c, "Host deleted");
						broadcastSshState();
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "connect": {
						await ensureSshCfgs();
						const cfg = sshCfgs.hosts.find((x) => x.id === msg.id);
						if (!cfg) throw new Error("Host not found");
						void connectSshHost(cfg, clientId, reqId); // ready/error async reply，errors are already handled internally
						return;
					}
					case "disconnect":
						dropSshConn(getSshConn(msg.connId), "Disconnected by user");
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "shell_open":
						return void sshOpenShell(getSshConn(msg.connId), msg, reqId, clientId);
					case "shell_close": {
						const c = getSshConn(msg.connId);
						c.streams.get(msg.shellId)?.end();
						c.streams.delete(msg.shellId);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "shell_input": // no-reqId streaming channel: fail silently, no response slot
						try { getSshConn(msg.connId).streams.get(msg.shellId)?.write(Buffer.from(String(msg.b64 ?? ""), "base64")); } catch {}
						return;
					case "shell_resize":
						try { getSshConn(msg.connId).streams.get(msg.shellId)?.setWindow(Number(msg.rows) || 24, Number(msg.cols) || 80, 0, 0); } catch {}
						return;
					case "exec":
						return void sshExec(getSshConn(msg.connId), String(msg.cmd ?? ""), reqId, clientId);
					default:
						host.log("unknown action:", action);
						host.sendTo(clientId, fail(reqId, `Unknown action ${action}`));
				}
			} catch (err) {
				host.sendTo(clientId, fail(reqId, err?.message ?? String(err)));
			}
		});

		host.log(`activated; workspace root: ${toWire(root)}`);
		// on new client attach, actively push the full state（server is the single source of truth，aligned with the host snapshot architecture）。
		// host.onAttach on older hosts（<0.35）does not exist——optional-chaining compatible，the client still has
		// reqId pull is still a fallback.
		const offAttach = host.onAttach?.((clientId) => {
			void ensureSshCfgs().then(() => {
				host.sendTo(clientId, { kind: "state", state: publicSshState() });
			});
		});
		// workspace follows the host app live set_cwd：root changed → the previous project's sync connection is dropped
		//（.vscode/sftp.json per-project）、broadcast so the frontend clears caches and rebuilds the tree。
		const offCwd = host.onCwdChange?.((next) => {
			root = path.resolve(next);
			for (const [, c] of syncConns) {
				try { c.client.end(); } catch {}
			}
			syncConns.clear();
			host.broadcast({ kind: "workspace", root: toWire(root) });
			host.log(`workspace root switched: ${toWire(root)}`);
		});
		void ensureSshCfgs().then(() => ensureSshMod()); // warmup：migrate old ssh plugin config + preload/auto-install ssh2（broadcast when done state）
		return () => {
			off();
			try { offAttach?.(); } catch {}
			try { offCwd?.(); } catch {}
			for (const [, c] of syncConns) {
				try { c.client.end(); } catch {}
			}
			syncConns.clear();
			for (const c of sshConns.values()) {
				try { c.client.end(); } catch {}
			}
			sshConns.clear();
			host.log("deactivated");
		};
	},
};

// Note: host.cwd is live (follows host set_cwd; older hosts still snapshot cwd at startup).
// Editoruse it as the workspace root —— onCwdChange on trigger, switch the root、drop the old sync connection and broadcast to the frontend。
