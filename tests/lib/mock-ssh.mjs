/**
 * In-process SSH mock remote — uses ssh2's built-in Server to start a fake SSH service.
 *
 * For vscode-editor (including Remote-SSH) protocol/UI tests (zero extra deps, runs offline):
 * - auth: user tester / password secret123; everything else is refused
 * - shell: welcome banner welcome-to-mock + line echo (input foo\r → echo:foo)
 * - exec:
 *     echo xxx   → prints xxx, exit 0
 *     fail*      → stderr "boom", exit 7
 *     pwd        → /home/test
 * - sftp: in-memory FS (see dirs/files exports), supports REALPATH/STAT/OPENDIR/
 *   READDIR/OPEN/READ/WRITE/CLOSE/MKDIR/REMOVE/RMDIR/RENAME
 */
import { join } from "node:path";
import { cpSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const SFTP = { READ: 1, WRITE: 2, APPEND: 4, CREAT: 8, TRUNC: 16, EXCL: 32 };

/** ssh2 runtime dependency subset (for offline copy; cpu-features/nan optional, falls back to pure JS) */
const SSH2_PKGS = ["ssh2", "asn1", "bcrypt-pbkdf", "safer-buffer", "tweetnacl"];

/**
 * Prepare ssh2 deps in a temp plugin dir:
 * 1. Offline first — copy from the local build dir (dev/plugins/vscode-editor/node_modules);
 * 2. If missing locally (e.g. CI) → fall back to npm install (needs network).
 */
export function ensurePluginSsh2Dep(plugDst, devPlugDir) {
	for (const pkg of SSH2_PKGS) {
		const src = join(devPlugDir, "node_modules", pkg);
		if (existsSync(src)) {
			cpSync(src, join(plugDst, "node_modules", pkg), { recursive: true });
		}
	}
	if (!existsSync(join(plugDst, "node_modules", "ssh2", "package.json"))) {
		console.log("[mock-ssh] no local ssh2 dep, falling back to npm install…");
		execFileSync(
			"npm",
			["install", "--prefix", plugDst, "ssh2@latest", "--no-audit", "--no-fund"],
			{ stdio: "inherit", timeout: 180_000, shell: process.platform === "win32" },
		);
	}
	if (!existsSync(join(plugDst, "node_modules", "ssh2", "package.json"))) {
		throw new Error("failed to prepare ssh2 deps (copy and npm install both failed)");
	}
}

export const dirs = {
	"/": ["home"], "/home": ["test"],
	"/home/test": ["a.txt", "sub", "big.bin"], "/home/test/sub": [],
};
export const files = {
	"/home/test/a.txt": Buffer.from("hello ssh\n第二行\n", "utf8"),
	"/home/test/big.bin": Buffer.from([0x00, 0x01, 0x02, 0x00]),
};

/** Build a ustar directory entry (512B header + trailer), for simulating tar -czf - */
function tarDirEntry(name) {
	const h = Buffer.alloc(512);
	h.write(name.slice(0, 99), 0, "utf8");
	h.write("0000755\0", 100);
	h.write("0000000\0", 108);
	h.write("0000000\0", 116);
	h.write("00000000000\0", 124); // directory size = 0
	h.write(Date.now().toString(8).padStart(11, "0") + "\0", 136);
	h.write("        ", 148); // checksum first filled with spaces
	h[156] = 0x35; // '5' directory
	h.write("ustar\0", 257);
	h.write("00", 263);
	let sum = 0;
	for (const b of h) sum += b;
	h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
	return Buffer.concat([h, Buffer.alloc(1024)]); // data region + two end blocks
}

/** Build a ustar file entry (header + content padded to 512 + trailing end blocks) */
function tarFileEntry(name, content) {
	const h = Buffer.alloc(512);
	h.write(name.slice(0, 99), 0, "utf8");
	h.write("0000644\0", 100);
	h.write("0000000\0", 108);
	h.write("0000000\0", 116);
	h.write(content.length.toString(8).padStart(11, "0") + "\0", 124);
	h.write(Date.now().toString(8).padStart(11, "0") + "\0", 136);
	h.write("        ", 148);
	h[156] = 0x30; // '0' regular file
	h.write("ustar\0", 257);
	h.write("00", 263);
	let sum = 0;
	for (const b of h) sum += b;
	h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
	return Buffer.concat([h, content, Buffer.alloc((512 - (content.length % 512)) % 512), Buffer.alloc(1024)]);
}

/**
 * Start the mock SSH server.
 * @param {string} pluginDir plugin dir that contains node_modules/ssh2 (reuse the same deps)
 * @param {number} port listen port
 * @returns {Promise<{close(): void}>}
 */
export async function startMockSsh(pluginDir, port) {
	const { createRequire } = await import("node:module");
	const { generateKeyPairSync } = await import("node:crypto");
	const req = createRequire(join(pluginDir, "package.json"));
	const { Server } = req("ssh2");
	// RSA PKCS#1 PEM (ed25519 can only export PKCS#8, which ssh2's parseKey rejects)
	const HOST_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
		.privateKey.export({ type: "pkcs1", format: "pem" });

	let handleSeq = 0;
	const handles = new Map(); // handleStr → handle record

	function bindSftp(sftp) {
		sftp.on("REALPATH", (id, path) => {
			sftp.name(id, [{ filename: path || "/" }]);
		});
		sftp.on("STAT", (id, path) => {
			if (dirs[path]) return sftp.attrs(id, { mode: 0o040755, size: 4096 });
			if (files[path]) return sftp.attrs(id, { mode: 0o100644, size: files[path].length });
			sftp.status(id, 2);
		});
		sftp.on("OPENDIR", (id, path) => {
			if (!dirs[path]) return sftp.status(id, 2);
			const h = Buffer.from(`d${handleSeq++}`);
			handles.set(h.toString(), { kind: "dir", path, readAll: false });
			sftp.handle(id, h);
		});
		sftp.on("READDIR", (id, handleBuf) => {
			const key = handleBuf.toString();
			const h = handles.get(key);
			if (!h) return sftp.status(id, 4);
			if (h.readAll) {
				handles.delete(key);
				return sftp.status(id, 1); // EOF
			}
			h.readAll = true;
			sftp.name(id, dirs[h.path].map((n) => ({
				filename: n,
				longname: `-rw-r--r-- 1 u u 0 ${n}`,
				attrs: {
					mode: dirs[`${h.path}/${n}`] ? 0o040755 : 0o100644,
					size: files[`${h.path}/${n}`]?.length ?? 0,
				},
			})));
		});
		sftp.on("OPEN", (id, path, flags) => {
			if (flags & SFTP.READ && !(flags & (SFTP.WRITE | SFTP.CREAT | SFTP.TRUNC))) {
				if (!files[path]) return sftp.status(id, 2);
				const h = Buffer.from(`f${handleSeq++}`);
				handles.set(h.toString(), { kind: "file", path });
				return sftp.handle(id, h);
			}
			// write path: TRUNC or a new file starts empty, otherwise append to existing content
			const h = Buffer.from(`f${handleSeq++}`);
			handles.set(h.toString(), {
				kind: "file", write: true, path,
				buf: !files[path] || flags & SFTP.TRUNC ? Buffer.alloc(0) : Buffer.from(files[path]),
			});
			sftp.handle(id, h);
		});
		sftp.on("READ", (id, handleBuf, offset, len) => {
			const h = handles.get(handleBuf.toString());
			if (!h?.path) return sftp.status(id, 4);
			const buf = files[h.path];
			if (!buf) return sftp.status(id, 2);
			const slice = buf.subarray(offset, offset + len);
			if (!slice.length) return sftp.status(id, 1); // EOF
			sftp.data(id, slice);
		});
		sftp.on("WRITE", (id, handleBuf, offset, data) => {
			const h = handles.get(handleBuf.toString());
			if (!h?.write) return sftp.status(id, 4);
			if (offset + data.length > h.buf.length) {
				const nb = Buffer.alloc(offset + data.length);
				h.buf.copy(nb, 0);
				h.buf = nb;
			}
			data.copy(h.buf, offset);
			sftp.status(id, 0);
		});
		sftp.on("CLOSE", (id, handleBuf) => {
			const h = handles.get(handleBuf.toString());
			if (h?.write) files[h.path] = Buffer.from(h.buf);
			handles.delete(handleBuf.toString());
			sftp.status(id, 0);
		});
		sftp.on("MKDIR", (id, path) => {
			if (dirs[path]) return sftp.status(id, 4);
			dirs[path] = [];
			const idx = path.lastIndexOf("/");
			dirs[idx <= 0 ? "/" : path.slice(0, idx)].push(path.slice(idx + 1));
			sftp.status(id, 0);
		});
		sftp.on("REMOVE", (id, path) => {
			if (!files[path]) return sftp.status(id, 2);
			delete files[path];
			const idx = path.lastIndexOf("/");
			const parent = dirs[idx <= 0 ? "/" : path.slice(0, idx)];
			if (parent) parent.splice(parent.indexOf(path.slice(idx + 1)), 1);
			sftp.status(id, 0);
		});
		sftp.on("RMDIR", (id, path) => {
			if (!dirs[path]?.length) {
				delete dirs[path];
				const idx = path.lastIndexOf("/");
				const parent = dirs[idx <= 0 ? "/" : path.slice(0, idx)];
				if (parent) parent.splice(parent.indexOf(path.slice(idx + 1)), 1);
				return sftp.status(id, 0);
			}
			sftp.status(id, 4); // directory not empty or missing
		});
		sftp.on("RENAME", (id, src, dst) => {
			if (files[src]) {
				files[dst] = files[src];
				delete files[src];
			} else if (dirs[src]) {
				dirs[dst] = dirs[src];
				delete dirs[src];
			} else return sftp.status(id, 2);
			const i = src.lastIndexOf("/");
			const p1 = dirs[i <= 0 ? "/" : src.slice(0, i)];
			if (p1) p1.splice(p1.indexOf(src.slice(i + 1)), 1);
			const j = dst.lastIndexOf("/");
			const p2 = dirs[j <= 0 ? "/" : dst.slice(0, j)];
			if (p2) p2.push(dst.slice(j + 1));
			sftp.status(id, 0);
		});
	}

	return new Promise((resolve, reject) => {
		let srv;
		try {
			srv = new Server({ hostKeys: [HOST_KEY] }, (client) => {
				client.on("error", () => {}); // client disconnect / socket errors must not crash the test process
				client.on("authentication", (ctx) => {
					if (ctx.username === "tester" && ctx.password === "secret123") return ctx.accept();
					ctx.reject();
				});
				client.on("ready", () => {
					client.on("session", (accept) => {
						const session = accept();
						session.once("pty", (accept2) => accept2?.());
						session.once("shell", (accept2) => {
							const stream = accept2();
							stream.write("welcome-to-mock\r\n");
							let buf = "";
							stream.on("data", (d) => {
								buf += d.toString();
								while (buf.includes("\r")) {
									const line = buf.slice(0, buf.indexOf("\r")).trim();
									buf = buf.slice(buf.indexOf("\r") + 1);
									if (line) stream.write(`echo:${line}\r\n`);
								}
							});
						});
						session.once("exec", (accept2, reject2, info) => {
							const stream = accept2();
							const cmd = info.command ?? "";
							// Simulate remote tar -czf - (editor plugin "download folder to computer"): in-memory FS → ustar → gzip
							const tarM = cmd.match(/^cd '(.*)' && tar -czf - '(.*)'$/);
							if (tarM) {
								const base = (tarM[1] === "/" ? "" : tarM[1]) + "/" + tarM[2];
								const parts = [tarDirEntry(tarM[2])];
								for (const d of Object.keys(dirs)) {
									if (d.startsWith(base + "/")) parts.push(tarFileEntry(d.slice(base.length + 1), Buffer.alloc(0)));
								}
								for (const [p, content] of Object.entries(files)) {
									if (p.startsWith(base + "/")) parts.push(tarFileEntry(p.slice(base.length + 1), content));
								}
								stream.write(gzipSync(Buffer.concat(parts)));
								stream.exit(0);
								stream.end();
								return;
							}
							if (cmd.startsWith("echo ")) {
								stream.write(cmd.slice(5).replace(/^["']|["']$/g, "") + "\n");
								stream.exit(0);
							} else if (cmd.startsWith("fail")) {
								stream.stderr.write("boom\n");
								stream.exit(7);
							} else if (cmd === "pwd") {
								stream.write("/home/test\n");
								stream.exit(0);
							} else {
								stream.exit(127);
							}
							stream.end();
						});
						session.once("sftp", (accept2) => bindSftp(accept2()));
					});
				});
			});
			srv.on("error", reject);
			srv.listen(port, "127.0.0.1", () => resolve({
				close() {
					try { srv.close(); } catch {}
				},
			}));
		} catch (err) {
			reject(err);
		}
	});
}
