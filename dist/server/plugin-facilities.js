/**
 * Plugin host facilities: per-plugin KV storage + encrypted secrets,
 * extracted from plugins.ts as a pure facility module.
 *
 * storage — single-file JSON KV at <pluginDir>/storage.json:
 *   - in-memory cache, atomic write via tmp+rename (same pattern as client-state.ts);
 *   - for non-sensitive config (window layout, last selection, …), replacing
 *     each plugin's hand-rolled read/write config.json boilerplate;
 *   - lifetime is bound to the plugin directory (uninstall deletes it);
 *     survives upgrades.
 *
 * secrets — AES-256-GCM encrypted secret store (passwords / API keys / tokens):
 *   - key file <dataDir>/secrets.key (random 32 bytes, created on first use;
 *     chmod 0600 is meaningful on POSIX; on Windows NTFS inherits the user
 *     directory's default ACL);
 *   - ciphertext lives with the plugin at <pluginDir>/secrets.bin — copying
 *     it to another machine cannot decrypt it without the host key (fail closed);
 *     uninstalling the plugin deletes the ciphertext with it;
 *   - threat model: stop casual copy/view of files (obfuscation-grade) and
 *     ciphertext leakage; cannot stop a full process compromise under the same
 *     user account — a reasonable tradeoff for a local personal tool.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile as fspReadFile, readdir as fspReaddir, rm as fspRm, mkdir as fspMkdir, writeFile as fspWriteFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
/** Atomic tmp+rename write (errors isolated by the caller — plugin-facility I/O is always best-effort). */
function atomicWrite(file, data) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, data);
    renameSync(tmp, file);
}
// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------
/** Per-plugin JSON-file KV. All methods are sync (small data; avoids concurrent-write reordering). */
export class PluginStorage {
    file;
    cache;
    constructor(file) {
        this.file = file;
    }
    load() {
        if (this.cache)
            return this.cache;
        try {
            const parsed = JSON.parse(readFileSync(this.file, "utf8"));
            this.cache = parsed && typeof parsed === "object" ? parsed : {};
        }
        catch {
            this.cache = {}; // missing/corrupt = empty table (corruption is non-fatal; rebuild from scratch)
        }
        return this.cache;
    }
    get(key, fallback) {
        const v = this.load()[key];
        return v === undefined ? fallback : v;
    }
    all() {
        return { ...this.load() };
    }
    set(key, value) {
        if (!key)
            throw new Error("storage.set: key cannot be empty");
        const store = this.load();
        store[key] = value;
        try {
            atomicWrite(this.file, JSON.stringify(store));
        }
        catch (err) {
            console.error(`[plugin-storage] write failed (${this.file}):`, err);
        }
    }
    delete(key) {
        const store = this.load();
        if (!(key in store))
            return;
        delete store[key];
        try {
            atomicWrite(this.file, JSON.stringify(store));
        }
        catch (err) {
            console.error(`[plugin-storage] write failed (${this.file}):`, err);
        }
    }
}
function seal(key, plaintext) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ct: ct.toString("hex") };
}
function unseal(key, blob) {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
    decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(blob.ct, "hex")), decipher.final()]).toString("utf8");
}
/** Read or create the global key file (lazy, once). */
function loadOrCreateKey(dataDir) {
    const keyFile = join(dataDir, "secrets.key");
    try {
        if (existsSync(keyFile))
            return Buffer.from(readFileSync(keyFile).toString("hex").trim(), "hex");
    }
    catch {
        /* fallthrough → regenerate */
    }
    const key = randomBytes(32);
    atomicWrite(keyFile, `${key.toString("hex")}\n`);
    try {
        chmodSync(keyFile, 0o600); // best-effort (no-op on Windows, never throws)
    }
    catch { }
    return key;
}
/** Per-plugin encrypted KV. All methods are sync; any I/O failure silently falls back (losing a secret is better than crashing the process). */
export class PluginSecrets {
    store;
    file;
    constructor(dataDir, pluginDir) {
        this.file = join(pluginDir, "secrets.bin");
        this.key = PluginSecrets.keyFor(dataDir);
    }
    key;
    static keys = new Map();
    /** Lazily generate/reuse the key per dataDir (shared in-process to avoid repeated I/O). */
    static keyFor(dataDir) {
        let k = PluginSecrets.keys.get(dataDir);
        if (!k) {
            k = loadOrCreateKey(dataDir);
            PluginSecrets.keys.set(dataDir, k);
        }
        return k;
    }
    load() {
        if (this.store)
            return this.store;
        try {
            const parsed = JSON.parse(readFileSync(this.file, "utf8"));
            this.store =
                parsed && parsed.v === 1 && parsed.items && typeof parsed.items === "object"
                    ? parsed
                    : { v: 1, items: {} };
        }
        catch {
            this.store = { v: 1, items: {} };
        }
        return this.store;
    }
    set(name, value) {
        if (!name)
            throw new Error("secrets.set: name cannot be empty");
        const s = this.load();
        s.items[name] = seal(this.key, value);
        try {
            atomicWrite(this.file, JSON.stringify(s));
        }
        catch (err) {
            console.error("[plugin-secrets] write failed:", err);
        }
    }
    get(name) {
        const blob = this.load().items[name];
        if (!blob)
            return undefined;
        try {
            return unseal(this.key, blob);
        }
        catch {
            return undefined; // different machine / key rotation → cannot decrypt, return empty (fail closed)
        }
    }
    has(name) {
        return name in this.load().items;
    }
    delete(name) {
        const s = this.load();
        if (!(name in s.items))
            return;
        delete s.items[name];
        try {
            atomicWrite(this.file, JSON.stringify(s));
        }
        catch (err) {
            console.error("[plugin-secrets] write failed:", err);
        }
    }
    list() {
        return Object.keys(this.load().items);
    }
}
// ---------------------------------------------------------------------------
// deps (host auto-installs runtime dependencies into the plugin directory)
// ---------------------------------------------------------------------------
const DEP_TIMEOUT_MS = 180_000; // slow-network install fallback (includes first-time package metadata fetch)
/** Whether this module can be resolved from the plugin directory (mirrors the plugin's own import() lookup). */
export function isDepAvailable(pluginDir, spec) {
    try {
        createRequire(join(pluginDir, "index.mjs")).resolve(spec);
        return true;
    }
    catch {
        return false;
    }
}
const depInstallLocks = new Map();
/** Ensure dependencies are ready: resolve each one first; only then `npm install`
 *  the missing ones in a single shot, then re-check. Returns true = all available;
 *  false = install failed or timed out. Concurrent calls for the same directory
 *  are coalesced (single-flight).
 *
 *  This is the shared replacement for the hand-rolled ensureXxxMod helpers in
 *  webmail / db-client / vscode-editor — each used to assemble spawn args,
 *  handle win32 npm.cmd, and wait for install on its own. */
export function ensurePluginDeps(pluginDir, specs, onProgress) {
    if (specs.length === 0)
        return Promise.resolve(true);
    const missing = specs.filter((s) => !isDepAvailable(pluginDir, s));
    if (missing.length === 0)
        return Promise.resolve(true);
    const lockKey = join(pluginDir, missing.sort().join("|"));
    const inflight = depInstallLocks.get(lockKey);
    if (inflight)
        return inflight;
    const run = async () => {
        // Without a package.json, npm walks up the tree and may install into a parent
        // directory — drop a minimal package.json first to pin the install location.
        if (!existsSync(join(pluginDir, "package.json"))) {
            try {
                atomicWrite(join(pluginDir, "package.json"), JSON.stringify({ name: "plugin-runtime-deps", private: true }, null, 2));
            }
            catch { }
        }
        onProgress?.(`Installing dependencies: ${missing.join(", ")}… (first time may take a few minutes)`);
        // On win32 npm is a .cmd — spawnSync without a shell gets EINVAL; posix does
        // not use a shell (paths are assumed to contain no spaces, same as other host spawns).
        const res = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund", ...missing], { cwd: pluginDir, timeout: DEP_TIMEOUT_MS, shell: process.platform === "win32", encoding: "utf8" });
        if (res.error || res.status !== 0) {
            console.error(`[plugin-deps] ${join(pluginDir)} npm install failed:`, res.error ?? res.stderr?.slice(0, 500));
            return false;
        }
        const stillMissing = specs.filter((s) => !isDepAvailable(pluginDir, s));
        if (stillMissing.length) {
            console.error(`[plugin-deps] install finished but still missing: ${stillMissing.join(", ")}`);
            return false;
        }
        onProgress?.("Dependencies installed");
        return true;
    };
    const p = run().finally(() => depInstallLocks.delete(lockKey));
    depInstallLocks.set(lockKey, p);
    return p;
}
export class WorkspaceFS {
    root;
    /** root is a live getter (returns the current workspace absolute path) and follows set_cwd. */
    constructor(root) {
        this.root = root;
    }
    /** Relative path → absolute path under the live root; throws on traversal. Empty string = the root itself. */
    abs(rel) {
        const rootDir = resolve(this.root());
        const target = resolve(rootDir, typeof rel === "string" ? rel : "");
        if (target !== rootDir && !target.startsWith(rootDir + sepOf())) {
            throw new Error(`Path is outside the workspace: ${String(rel)}`);
        }
        return target;
    }
    /** Single-level directory listing (shallow; plugins recurse themselves for deep walks). */
    async list(relDir = "") {
        try {
            const dirents = await fspReaddir(this.abs(relDir), { withFileTypes: true });
            return dirents
                .slice(0, 2000)
                .map((d) => ({ name: d.name, type: d.isDirectory() ? "dir" : "file" }));
        }
        catch (err) {
            throw new Error(`Failed to read directory: ${err.message}`);
        }
    }
    /** Read a file (binary). Declared async so a path-check failure is a rejected
     *  promise (a non-async version would throw sync and break callers' .catch / .rejects). */
    async read(relPath) {
        return fspReadFile(this.abs(relPath));
    }
    /** Read text (default cap 512KB; truncated past that — same convention as preview). */
    async readText(relPath, maxBytes = 512 * 1024) {
        const buf = await this.read(relPath);
        return buf.subarray(0, maxBytes).toString("utf8");
    }
    /** Write a file (creates parent dirs). Relative paths are anchored at the current
     *  project — after a cwd switch, writes go into the new project. */
    async write(relPath, data) {
        const target = this.abs(relPath);
        await fspMkdir(dirname(target), { recursive: true });
        await fspWriteFile(target, data);
    }
    /** Delete a file or directory (recursive; only paths inside the workspace). */
    async remove(relPath) {
        await fspRm(this.abs(relPath), { recursive: true, force: false });
    }
}
function sepOf() {
    return process.platform === "win32" ? "\\" : "/";
}
