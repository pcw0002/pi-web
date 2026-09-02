/**
 * webmail server entry — production-ready IMAP/SMTP mail management plugin.
 *
 * Capabilities:
 *  - Incoming: IMAP (imapflow) list/search/read/flag/delete mail
 *  - Outgoing: SMTP (nodemailer)
 *  - New-mail notify: periodic poll of INBOX Unseen; each new one is host.notify + push to the view
 *  - AI tools: when config.aiEnabled, register via host.registerAgentTool
 *    mail_list / mail_read / mail_search / mail_send / mail_manage / mail_folders.
 *    Turning it off unregisters them — "let AI manage mail" can be toggled at any time.
 *
 * Credentials live in <dataDir>/plugins/webmail/config.json (plaintext on this machine, same model as pi auth.json).
 * imapflow/mailparser/nodemailer are not shipped: on first activate, try auto npm install;
 * on failure the view shows an Install deps button to trigger it manually.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const CONFIG_FILE = "config.json";
/** read-body cap（chars），guard against huge HTML blow the context window。 */
const BODY_LIMIT = 16000;
/** max envelopes to fetch when searching。 */
const SEARCH_SCAN = 1000;

const DEFAULT_CONFIG = {
	imap: { host: "", port: 993, tls: true, user: "", pass: "" },
	smtp: {
		host: "",
		port: 465,
		tls: true,
		user: "",
		pass: "",
		from: "",
	},
	pollSec: 60,
	notifyEnabled: true,
	aiEnabled: false,
};

function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
	));
}

async function loadConfig(dir) {
	const raw = join(dir, CONFIG_FILE);
	if (!existsSync(raw)) return structuredClone(DEFAULT_CONFIG);
	try {
		const parsed = JSON.parse(await readFile(raw, "utf8"));
		return {
			...structuredClone(DEFAULT_CONFIG),
			...parsed,
			imap: { ...DEFAULT_CONFIG.imap, ...(parsed.imap ?? {}) },
			smtp: { ...DEFAULT_CONFIG.smtp, ...(parsed.smtp ?? {}) },
		};
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
}

async function saveConfig(dir, cfg) {
	await writeFile(join(dir, CONFIG_FILE), JSON.stringify(cfg, null, "\t"), "utf8");
}

/** Find a usable npm CLI: prefer require() of the npm package cli.js (no shell), else PATH. */
function resolveNpmCli() {
	try {
		return createRequire(import.meta.url).resolve("npm/bin/npm-cli.js");
	} catch {
		return null;
	}
}

export default {
	activate(host) {
		const st = {
			config: null,
			client: null,
			/** IMAP operation mutex chain（ImapFlow operations on a connection must be serial）。 */
			chain: Promise.resolve(),
			pollTimer: null,
			pollBusy: false,
			lastUnseenUids: new Set(),
			firstPollDone: false,
			deps: { imapflow: null, mailparser: null, nodemailer: null },
			depsOk: false,
			depsInstalling: false,
			status: "Not configured",
			lastCheckAt: 0,
			unseenTotal: 0,
			toolUnregister: null,
			/** registerBackgroundTask handle（mail polling in the background-task panel）。 */
			bgTask: null,
		};

		// ------------------------------------------------------------------
		// config and state
		// ------------------------------------------------------------------
		// Secrets storage: passwords go through host.secrets (AES-256-GCM); plaintext never hits disk;
		// fall back to old plaintext config.json when the host lacks this. On first start, take historical
		// migrate leftover plaintext passwords into secrets and strip them from the file。
		const sec = host.secrets;

		/** After reading non-sensitive fields from config.json: strip leftover plaintext passwords into secrets,
		 *  then refill the in-memory copy from secrets（memory needs the real password for IMAP/SMTP Connect）。 */
		async function loadConfigSecure() {
			const cfg = await loadConfig(host.dir);
			if (sec?.set) {
				let migrated = false;
				for (const [sect, secretName] of [
					["imap", "imap_pass"],
					["smtp", "smtp_pass"],
				]) {
					const legacy = cfg?.[sect]?.pass;
					if (legacy) {
						try { sec.set(secretName, String(legacy)); } catch {}
						cfg[sect].pass = "";
						migrated = true;
					}
				}
				if (migrated) {
					try { await saveConfig(host.dir, cfg); } catch {} // write back the stripped clean config
					host.log("Migrated plaintext passwords into encrypted storage");
				}
			}
			return rehydrate(cfg);
		}

		/** fill the in-memory copy from stored secrets（do not overwrite a value the user just typed）。 */
		function rehydrate(cfg) {
			if (!sec?.get || !cfg) return cfg;
			const ip = sec.get("imap_pass");
			const sp = sec.get("smtp_pass");
			if (ip !== undefined && !cfg.imap.pass) cfg.imap.pass = ip;
			if (sp !== undefined && !cfg.smtp.pass) cfg.smtp.pass = sp;
			return cfg;
		}

		function publicState() {
			const c = st.config;
			return {
				configured: Boolean(c?.imap?.host && c?.imap?.user),
				depsOk: st.depsOk,
				depsInstalling: st.depsInstalling,
				status: st.status,
				unseen: st.unseenTotal,
				lastCheckAt: st.lastCheckAt,
				aiEnabled: Boolean(c?.aiEnabled),
				notifyEnabled: c?.notifyEnabled !== false && Boolean(c?.imap?.host),
				// redacted config echo（password is not echoed，only report whether it exists）
				config: {
					imap: {
						host: c?.imap?.host ?? "",
						port: c?.imap?.port ?? 993,
						tls: c?.imap?.tls !== false,
						user: c?.imap?.user ?? "",
						hasPass: Boolean(c?.imap?.pass),
					},
					smtp: {
						host: c?.smtp?.host ?? "",
						port: c?.smtp?.port ?? 465,
						tls: c?.smtp?.tls !== false,
						user: c?.smtp?.user ?? "",
						from: c?.smtp?.from ?? "",
						hasPass: Boolean(c?.smtp?.pass),
					},
					pollSec: c?.pollSec ?? 60,
					notifyEnabled: c?.notifyEnabled !== false,
					aiEnabled: Boolean(c?.aiEnabled),
				},
			};
		}
		function broadcastState() {
			host.broadcast({ kind: "state", state: publicState() });
		}

		async function applyConfig(next) {
			if (sec?.set) {
				// Password semantics: blank (undefined/"") = keep stored; a value = update. Config file
				// and notices never persist plaintext — secrets only go into host.secrets.
				if (next.imap.pass) {
					try { sec.set("imap_pass", String(next.imap.pass)); } catch {}
					next.imap.pass = "";
				}
				if (next.smtp.pass) {
					try { sec.set("smtp_pass", String(next.smtp.pass)); } catch {}
					next.smtp.pass = "";
				}
			} else {
				// old-host fallback：keep the old plaintext behavior（blank keeps the stored value）
				next.imap.pass = next.imap.pass || st.config?.imap?.pass || "";
				next.smtp.pass = next.smtp.pass || st.config?.smtp?.pass || "";
			}
			st.config = await rehydrate(next);
			await saveConfig(host.dir, next);
			if (!st.depsOk && next.imap?.host) installDeps(true); // account just configured but deps are missing → auto-install
			restartPoller();
			await refreshAiTools();
			broadcastState();
		}

		// ------------------------------------------------------------------
		// dep loading / auto install
		// ------------------------------------------------------------------
		async function loadDeps() {
			for (const name of ["imapflow", "mailparser", "nodemailer"]) {
				try {
					st.deps[name] = await import(name);
				} catch (err) {
					host.log(`dep ${name} not ready:`, err?.message ?? err);
					st.deps[name] = null;
				}
			}
			st.depsOk = ["imapflow", "mailparser"].every((n) => st.deps[n]);
			if (!st.depsOk || !st.deps.nodemailer) host.log("Hint: click "Install dependencies" in settings to finish install");
			return st.depsOk;
		}

		function installDeps(auto = false) {
			if (st.depsInstalling) return;
			st.depsInstalling = true;
			host.log(`installing deps: imapflow / mailparser / nodemailer${auto ? " (auto)" : ""}`);
			if (!auto) host.notify("info", "📬 Mail plugin: installing dependencies…");
			host.notify("info", "📬 Mail plugin: installing dependencies (imapflow / mailparser / nodemailer)…");
			const pkgs = ["imapflow@latest", "mailparser@latest", "nodemailer@latest"];
			const npmCli = resolveNpmCli();
			const child = npmCli
				? spawn(process.execPath, [npmCli, "--prefix", host.dir, "install", ...pkgs, "--no-audit", "--no-fund"], {
						stdio: "ignore",
					})
				: spawn("npm", ["--prefix", host.dir, "install", ...pkgs, "--no-audit", "--no-fund"], {
						stdio: "ignore",
						shell: process.platform === "win32", // on Windows npm is .cmd, so shell is required
					});
			st.installChild = child;
			child.on("error", (err) => finish(false, err.message));
			child.on("exit", (code) => finish(code === 0, `npm exit ${code}`));
			let done = false;
			async function finish(ok, why) {
				if (done) return;
				done = true;
				st.depsInstalling = false;
				if (st.installChild === child) st.installChild = null;
				if (ok) {
					await loadDeps();
					restartPoller(); // start polling once deps are ready
					await refreshAiTools();
				}
				host.notify(
					ok ? "success" : "error",
					ok
						? "📬 Mail plugin dependencies installed"
						: `📬 Mail plugin dependency install failed（${why}）——please run this in the plugin directory npm install，or retry from Settings「Install deps」`,
				);
				broadcastState();
			}
		}

		// ------------------------------------------------------------------
		// IMAP infrastructure：mutex serial + lazy connect
		// ------------------------------------------------------------------
		function serialized(fn) {
			const run = st.chain.then(() => fn(), () => fn());
			st.chain = run.then(
				() => {},
				() => {},
			);
			return run;
		}

		function dropClient(why) {
			const c = st.client;
			st.client = null;
			if (c) {
				try {
					c.close();
				} catch {
					/* already dead */
				}
			}
			if (why) host.log("Disconnected:", why);
		}

		async function ensureClient() {
			const c = st.config?.imap;
			if (!st.deps.imapflow) throw new Error("Dependencies not installed: click "Install dependencies" in settings");
			if (!c?.host || !c?.user) throw new Error("IMAP account not configured yet");
			if (st.client?.usable) return st.client;
			dropClient();
			const { ImapFlow } = st.deps.imapflow;
			const client = new ImapFlow({
				host: c.host,
				port: Number(c.port) || 993,
				secure: c.tls !== false,
				auth: { user: c.user, pass: c.pass ?? "" },
				logger: false,
			});
			client.on("error", (err) => dropClient(err?.message));
			await client.connect();
			st.client = client;
			st.status = "Connected";
			return client;
		}

		/** Open folder and run fn (fn may use the client's mailbox APIs); release the lock afterwards. */
		async function withMailbox(folder, fn) {
			const client = await ensureClient();
			const lock = await client.getMailboxLock(folder || "INBOX");
			try {
				return await fn(client);
			} finally {
				lock.release();
			}
		}

		function envFrom(envelope) {
			const addr = envelope?.from?.[0];
			return addr ? addr.address : "";
		}
		function envName(envelope) {
			const addr = envelope?.from?.[0];
			return addr?.name || "";
		}
		function summarize(msg) {
			return {
				uid: msg.uid,
				from: envFrom(msg.envelope),
				fromName: envName(msg.envelope),
				to: (msg.envelope?.to ?? []).map((a) => a.address).join(", "),
				subject: msg.envelope?.subject || "(no subject)",
				date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : "",
				seen: Boolean(msg.flags?.has("\\Seen")),
				size: msg.size ?? 0,
			};
		}

		// ------------------------------------------------------------------
		// Mail operations (UI and AI tools share the same implementation)
		// ------------------------------------------------------------------
		async function listMails({ folder = "INBOX", limit = 30, unseenOnly = false } = {}) {
			return withMailbox(folder, async (client) => {
				const box = client.mailbox;
				const total = box?.exists ?? 0;
				if (total === 0) return [];
				const start = Math.max(1, total - Math.min(Number(limit) || 30, 200) + 1);
				const out = [];
				const range = `${start}:*`;
				for await (const msg of client.fetch(range, {
					envelope: true,
					flags: true,
					size: true,
				})) {
					if (unseenOnly && msg.flags?.has("\\Seen")) continue;
					out.push(summarize(msg));
				}
				out.sort((a, b) => new Date(b.date) - new Date(a.date));
				return out;
			});
		}

		async function searchMails({ query, folder = "INBOX", limit = 20 } = {}) {
			const q = String(query ?? "").trim().toLowerCase();
			if (!q) return [];
			// client-side envelope filter（subject/from/to），avoid vendor IMAP SEARCH dialect differences
			const pool = await listMails({ folder, limit: SEARCH_SCAN });
			return pool
				.filter((m) =>
					[m.subject, m.from, m.fromName, m.to].some((s) =>
						String(s).toLowerCase().includes(q),
					),
				)
				.slice(0, Math.min(Number(limit) || 20, 50));
		}

		async function readMail({ folder = "INBOX", uid } = {}) {
			if (!uid) throw new Error("Missing uid");
			return withMailbox(folder, async (client) => {
				// Note：the third argument {uid:true} means fetch by UID fetch the message——put it in the query params
				// would be treated as a sequence number — list works, open-then-not-found (when UID > mailbox size).
				const msg = await client.fetchOne(
					String(uid),
					{ envelope: true, flags: true, source: true },
					{ uid: true },
				);
				if (!msg || !msg.source) throw new Error(`No message for uid=${uid}`);
				const meta = summarize(msg);
				const raw = msg.source;
				const { simpleParser } = st.deps.mailparser;
				const parsed = await simpleParser(raw);
				const text =
					parsed.text ||
					String(parsed.html ?? "")
						.replace(/<style[\s\S]*?<\/style>/gi, "")
						.replace(/<script[\s\S]*?<\/script>/gi, "")
						.replace(/<[^>]+>/g, " ")
						.replace(/\s+/g, " ")
						.trim();
				return {
					...meta,
					text: text.slice(0, BODY_LIMIT),
					truncated: text.length > BODY_LIMIT,
					hasAttachments: (parsed.attachments ?? []).length > 0,
				};
			});
		}

		async function markMails({ folder = "INBOX", uids, seen = true } = {}) {
			const list = (Array.isArray(uids) ? uids : [uids]).map(String);
			if (list.length === 0) return { changed: 0 };
			return withMailbox(folder, async (client) => {
				let changed = 0;
				const flag = "\\Seen";
				for (const uid of list) {
					const ok = seen
						? await client.messageFlagsAdd(uid, [flag], { uid: true })
						: await client.messageFlagsRemove(uid, [flag], { uid: true });
					if (ok) changed++;
				}
				return { changed };
			});
		}

		async function deleteMails({ folder = "INBOX", uids } = {}) {
			const list = (Array.isArray(uids) ? uids : [uids]).map(String);
			if (list.length === 0) return { deleted: 0 };
			return withMailbox(folder, async (client) => {
				// if a trash folder exists, move there（recoverable），otherwise hard-delete
				let trash = null;
				for await (const f of client.list()) {
					if (f.specialUse === "\\Trash" || /^(trash|deleted|deleted messages|Deleted)/i.test(f.path)) {
						trash = f.path;
						break;
					}
				}
				let moved = 0;
				for (const uid of list) {
					const ok = trash
						? await client.messageMove(uid, trash, { uid: true })
						: await client.messageDelete(uid, { uid: true });
					if (ok) moved++;
				}
				return { deleted: moved, trash };
			});
		}

		async function sendMail({ to, cc, subject, body } = {}) {
			const nd = st.deps.nodemailer;
			if (!nd) throw new Error("Dependencies not installed: click "Install dependencies" in settings");
			const c = st.config?.smtp;
			if (!c?.host || !c?.user) throw new Error("SMTP account not configured yet");
			const transport = nd.createTransport({
				host: c.host,
				port: Number(c.port) || 465,
				secure: c.tls !== false,
				auth: { user: c.user, pass: c.pass ?? "" },
			});
			const info = await transport.sendMail({
				from: c.from || c.user,
				to: String(to ?? ""),
				cc: cc ? String(cc) : undefined,
				subject: String(subject ?? "(no subject)"),
				text: String(body ?? ""),
			});
			return { messageId: info.messageId, accepted: info.accepted };
		}

		async function countUnseen() {
			return withMailbox("INBOX", async (client) => ({
				uids: (await client.search({ seen: false }, { uid: true })) ?? [],
			}));
		}

		// ------------------------------------------------------------------
		// new-mail poll notify
		// ------------------------------------------------------------------
		async function pollOnce() {
			if (!st.config?.imap?.host || !st.depsOk || st.pollBusy) return;
			st.pollBusy = true;
			try {
				const { uids } = await countUnseen();
				st.lastCheckAt = Date.now();
				const fresh = uids.filter((u) => !st.lastUnseenUids.has(u));
				st.unseenTotal = uids.length;
				if (st.firstPollDone && fresh.length > 0) {
					let subjects = [];
					try {
						const summaries = await listMails({ folder: "INBOX", limit: 10 });
						subjects = summaries
							.filter((m) => fresh.includes(m.uid))
							.slice(0, 3)
							.map((m) => `${m.fromName || m.from}: ${m.subject}`);
					} catch {
						/* if subject is missing, report the count only */
					}
					if (st.config.notifyEnabled !== false) {
						host.notify(
							"info",
							`📬 ${fresh.length}  new message(s)${subjects.length ? ` — ${subjects.join(" · ")}` : ""}`,
						);
					}
					host.broadcast({
						kind: "new-mail",
						count: fresh.length,
						unseen: uids.length,
						subjects,
					});
				}
				st.firstPollDone = true;
				st.lastUnseenUids = new Set(uids);
				st.status = "Connected";
			} catch (err) {
				st.status = `Connection failed:${err?.message ?? err}`;
				dropClient();
			} finally {
				st.pollBusy = false;
				broadcastState();
			}
		}

		function restartPoller() {
			if (st.pollTimer) clearInterval(st.pollTimer);
			st.pollTimer = null;
			st.lastUnseenUids.clear();
			st.firstPollDone = false;
			const sec = Math.max(15, Math.floor(Number(st.config?.pollSec) || 60));
			if (st.config?.imap?.host && st.depsOk) {
				st.pollTimer = setInterval(() => void serialized(pollOnce), sec * 1000);
				void serialized(pollOnce); // run one round immediately
				// Standing task in the background-tasks panel: visible + one-click stop polling.
				if (st.bgTask) st.bgTask.update({ label: "📬 Mail poll", status: `every ${sec}s` });
				else {
					st.bgTask = host.registerBackgroundTask?.({
						id: "mail-poll",
						label: "📬 Mail poll",
						status: `every ${sec}s`,
						stop: () => {
							if (st.pollTimer) clearInterval(st.pollTimer);
							st.pollTimer = null;
							host.log("polling stopped from background panel");
						},
					});
				}
			} else {
				// Not configured/deps not ready：do not poll，remove the task from the panel（if any）。
				st.bgTask?.unregister?.();
				st.bgTask = null;
				broadcastState();
			}
		}

		// ------------------------------------------------------------------
		// AI tool registration（config.aiEnabled toggle-controlled）
		// ------------------------------------------------------------------
		const FOLDER_PARAM = {
			type: "string",
			description: "Mailbox folder path, default INBOX",
		};

		function aiTools() {
			return [
				{
					name: "mail_list",
					label: "List recent mail",
					description:
						"List recent mailbox summaries (from/subject/date/read). Use it when the user asks to check mail or the inbox.",
					parameters: {
						type: "object",
						properties: {
							folder: FOLDER_PARAM,
							limit: { type: "number", description: "How many to return, default 30, max 200" },
							unseen_only: { type: "boolean", description: "Unread only, default false" },
						},
					},
					execute: async (_id, args) => {
						const mails = await listMails(args);
						if (mails.length === 0) return "Mailbox is empty (or has no unread mail).";
						return mails
							.map(
								(m) =>
									`#${m.uid}${m.seen ? "" : " [Unread]"} ${m.date.slice(0, 16).replace("T", " ")} ${m.fromName || m.from} — ${m.subject}`,
							)
							.join("\n");
					},
				},
				{
					name: "mail_read",
					label: "Read a message",
					description: "Read one message body by uid (plain text, truncated if long).",
					parameters: {
						type: "object",
						properties: {
							uid: { type: "number", description: "# id from mail_list" },
							folder: FOLDER_PARAM,
						},
						required: ["uid"],
					},
					execute: async (_id, args) => {
						const m = await readMail(args);
						return [
							`Subject: ${m.subject}`,
							`From: ${m.fromName ? `${m.fromName} <${m.from}>` : m.from}`,
							`Date: ${m.date}`,
							m.hasAttachments ? "(has attachments)" : "",
							"",
							m.text + (m.truncated ? "\n…(truncated)" : ""),
						]
							.filter(Boolean)
							.join("\n");
					},
				},
				{
					name: "mail_search",
					label: "Search mail",
					description: "Search recent mail by keyword (subject / from / to).",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string", description: "Keyword" },
							folder: FOLDER_PARAM,
							limit: { type: "number", description: "How many to return, default 20" },
						},
						required: ["query"],
					},
					execute: async (_id, args) => {
						const mails = await searchMails(args);
						if (mails.length === 0) return `No mail matching "${args.query}".`;
						return mails
							.map(
								(m) =>
									`#${m.uid}${m.seen ? "" : " [Unread]"} ${m.date.slice(0, 16).replace("T", " ")} ${m.fromName || m.from} — ${m.subject}`,
							)
							.join("\n");
					},
				},
				{
					name: "mail_send",
					label: "Send mail",
					description: "Send a plain-text message via the configured SMTP.",
					promptGuidelines: [
						"Confirm recipient/subject/body with the user once before calling.",
					],
					parameters: {
						type: "object",
						properties: {
							to: { type: "string", description: "Recipient address" },
							cc: { type: "string", description: "CC (optional)" },
							subject: { type: "string", description: "Subject" },
							body: { type: "string", description: "Body (plain text)" },
						},
						required: ["to", "body"],
					},
					execute: async (_id, args) => {
						const r = await sendMail(args);
						return `Sent to ${(r.accepted ?? []).join(", ")}`;
					},
				},
				{
					name: "mail_manage",
					label: "Manage message state",
					description: 'Batch mark read/unread or delete. action is "seen" | "unseen" | "delete".',
					parameters: {
						type: "object",
						properties: {
							action: {
								type: "string",
								enum: ["seen", "unseen", "delete"],
								description: "Action type",
							},
							uids: { type: "array", items: { type: "number" }, description: "Message uid list" },
							folder: FOLDER_PARAM,
						},
						required: ["action", "uids"],
					},
					execute: async (_id, args) => {
						if (args.action === "delete") {
							const r = await deleteMails(args);
							return `Deleted ${r.deleted} message(s)${r.trash ? ` (moved to ${r.trash})` : ""}`;
						}
						const r = await markMails({ ...args, seen: args.action === "seen" });
						return `Updated ${r.changed} message(s) status`;
					},
				},
				{
					name: "mail_folders",
					label: "List folders",
					description: "List every mailbox folder path (inbox / archive / trash, etc.).",
					parameters: { type: "object", properties: {} },
					execute: async () => {
						return withMailbox("INBOX", async (client) => {
							const out = [];
							for await (const f of client.list()) {
								out.push(`${f.path}${f.specialUse ? ` (${f.specialUse})` : ""}`);
							}
							return out.join("\n");
						});
					},
				},
			];
		}

		async function refreshAiTools() {
			st.toolUnregister?.();
			st.toolUnregister = null;
			if (st.config?.aiEnabled && st.depsOk) {
				const offs = aiTools().map((t) => host.registerAgentTool(t));
				st.toolUnregister = () => offs.forEach((off) => off());
				host.log("AI mailbox tools enabled");
			}
		}

		// ------------------------------------------------------------------
		// view message protocol
		// ------------------------------------------------------------------
		const offMsg = host.onMessage((payload, from) => {
			const msg = payload ?? {};
			switch (msg.action) {
				case "get_state":
					if (from) host.sendTo(from, { kind: "state", state: publicState() });
					else broadcastState();
					break;
				case "save_config":
					void (async () => {
						try {
							await applyConfig({
								...structuredClone(DEFAULT_CONFIG),
								...msg.config,
								imap: { ...DEFAULT_CONFIG.imap, ...(msg.config?.imap ?? {}) },
								smtp: { ...DEFAULT_CONFIG.smtp, ...(msg.config?.smtp ?? {}) },
							});
							host.sendTo(from, { kind: "result", ok: true, action: "save_config" });
							host.notify("info", "📬 Mail config saved and applied");
						} catch (err) {
							host.sendTo(from, {
								kind: "result",
								ok: false,
								action: "save_config",
								error: err?.message ?? String(err),
							});
						}
					})();
					break;
				case "install_deps":
					installDeps();
					break;
				case "list":
					void serialized(() => listMails(msg))
						.then((mails) => host.broadcast({ kind: "mails", mails }))
						.catch((err) => {
							st.status = err?.message ?? String(err);
							broadcastState();
						});
					break;
				case "read":
					void serialized(() => readMail(msg))
						.then((mail) => host.broadcast({ kind: "mail", mail }))
						.catch((err) => host.notify("error", `📬 Read failed:${err?.message ?? err}`));
					break;
				case "search":
					void serialized(() => searchMails(msg))
						.then((mails) => host.broadcast({ kind: "mails", mails }))
						.catch((err) => host.notify("error", `📬 Search failed:${err?.message ?? err}`));
					break;
				case "mark":
					void serialized(() => markMails(msg))
						.then((r) => host.broadcast({ kind: "result", ok: true, action: "mark", ...r }))
						.catch((err) => host.notify("error", `📬 Mark failed:${err?.message ?? err}`));
					break;
				case "delete":
					void serialized(() => deleteMails(msg))
						.then((r) => host.broadcast({ kind: "result", ok: true, action: "delete", ...r }))
						.catch((err) => host.notify("error", `📬 Delete failed:${err?.message ?? err}`));
					break;
				case "send":
					void sendMail(msg)
						.then(() => {
							host.notify("info", `📬 Sent to ${msg.to}`);
							host.broadcast({ kind: "result", ok: true, action: "send" });
						})
						.catch((err) =>
							host.notify("error", `📬 Send failed:${err?.message ?? err}`),
						);
					break;
				default:
					host.log("unknown action:", msg.action);
			}
		});

		// ------------------------------------------------------------------
		// Startup
		// ------------------------------------------------------------------
		void (async () => {
			try {
				st.config = await loadConfigSecure();
				await loadDeps();
				if (!st.depsOk) installDeps(true); // auto-install if deps are missing，do not wait for config save
				await refreshAiTools();
				restartPoller();
				broadcastState();
				host.log("activated", st.depsOk ? "(deps ready)" : "(installing deps)");
			} catch (err) {
				host.log("activation failed:", err);
			}
		})();

		// on new client attach, actively push the full state（server is the single source of truth）；
		// host.onAttach does not exist on older hosts——optional-chaining compatible，the client can still pull as a fallback
		const offAttach = host.onAttach?.((clientId) => {
			host.sendTo(clientId, { kind: "state", state: publicState() });
		});

		return () => {
			offMsg();
			try { offAttach?.(); } catch {}
			st.toolUnregister?.();
			try { st.bgTask?.unregister?.(); } catch {}
			if (st.pollTimer) clearInterval(st.pollTimer);
			try {
				st.installChild?.kill(); // also kill an in-flight dependency install，leave no leftover writers
			} catch {
				/* already gone */
			}
			dropClient();
			host.log("deactivated");
		};
	},
};
