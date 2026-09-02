/**
 * webmail client view — mail management UI.
 *
 * Layout: mail list on the left (toolbar + list), reader on the right; settings and compose are modals.
 * Plain DOM (no host React). ctx.send() sends plugin_message;
 * ctx.onData() subscribes to plugin_data; protocol is the onMessage switch in index.mjs.
 * Styles are inlined <style>; colors use host CSS variables (follow theme changes).
 */

function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
	));
}

function fmtDate(iso) {
	if (!iso) return "";
	const d = new Date(iso);
	const today = new Date();
	return d.toDateString() === today.toDateString()
		? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: d.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const EMPTY_READER = `<div class="empty-reader">👈 Select a message on the left to read it</div>`;

export default {
	mount(container, ctx) {
		container.innerHTML = `
<div class="wmx">
	<style>
		.wmx { max-width: 1100px; margin: 0 auto; font-size: 13px; display: grid; gap: 10px; }
		.wmx-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.wmx h2 { margin: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.wmx .chip {
			font-size: 11px; padding: 1px 8px; border-radius: 99px;
			border: 1px solid var(--border, #333); opacity: .85; font-weight: normal;
		}
		.wmx .chip.ok { color: var(--green, #4ade80); border-color: color-mix(in srgb, var(--green, #4ade80) 40%, transparent); }
		.wmx .chip.err { color: var(--red, #f87171); border-color: color-mix(in srgb, var(--red, #f87171) 40%, transparent); }
		.wmx .chip.badge { color: var(--amber, #fbbf24); }
		.wmx .head-actions { margin-left: auto; display: flex; gap: 6px; align-items: center; }
		.wmx button {
			background: var(--bg-elev1, #16161d); color: inherit;
			border: 1px solid var(--border, #333); border-radius: 6px;
			padding: 3px 10px; cursor: pointer; font: inherit; font-size: 12px;
		}
		.wmx .head-actions button { padding: 2px 9px; opacity: .85; }
		.wmx .head-actions button:hover { opacity: 1; border-color: var(--accent, #7c5cff); }
		.wmx .btn-compose { color: var(--accent, #7c5cff); border-color: color-mix(in srgb, var(--accent, #7c5cff) 45%, transparent); background: transparent; opacity: 1; }
		.wmx button.primary { background: var(--accent, #7c5cff); color: #fff; border-color: transparent; }
		.wmx button.danger:hover { color: var(--red, #f87171); border-color: var(--red, #f87171); }
		.wmx input, .wmx select, .wmx textarea {
			background: var(--bg-elev1, #16161d); color: inherit;
			border: 1px solid var(--border, #333); border-radius: 6px;
			padding: 5px 8px; font: inherit; font-size: 12px; resize: vertical;
		}
		.wmx .hint { opacity: .55; font-size: 11px; margin: -4px 0 0; }
		.wmx .hint button { padding: 1px 8px; }

		/* left/right layout */
		.wmx-body { display: grid; grid-template-columns: minmax(300px, 42%) 1fr; gap: 12px; align-items: start; }
		@media (max-width: 760px) { .wmx-body { grid-template-columns: 1fr; } }
		.pane-list { display: grid; gap: 8px; min-width: 0; }
		.wmx .toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
		.wmx .toolbar input[type="search"] { flex: 1; min-width: 120px; }
		.wmx ul.maillist {
			list-style: none; margin: 0; padding: 0; display: grid; gap: 5px;
			max-height: calc(100vh - 260px); overflow: auto;
		}
		.wmx ul.maillist li {
			border: 1px solid var(--border, #333); border-radius: 7px;
			padding: 6px 10px; cursor: pointer; display: grid;
			grid-template-columns: 1fr auto; gap: 2px 10px; align-items: baseline;
		}
		.wmx ul.maillist li:hover { border-color: var(--accent, #7c5cff); }
		.wmx ul.maillist li.active { border-color: var(--accent, #7c5cff); background: color-mix(in srgb, var(--accent, #7c5cff) 8%, transparent); }
		.wmx ul.maillist li.unread { border-left: 3px solid var(--amber, #fbbf24); }
		.wmx ul.maillist .from {
			font-size: 12px; opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.wmx ul.maillist .subj {
			grid-column: 1 / -1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.wmx ul.maillist .date { opacity: .5; font-size: 11px; white-space: nowrap; }
		.wmx .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--amber, #fbbf24); margin-right: 5px; }

		/* right reader pane */
		.wmx .reader {
			border: 1px solid var(--border, #333); border-radius: 8px;
			padding: 12px 14px; display: grid; gap: 8px; align-self: stretch;
			min-height: 320px; align-content: start;
		}
		.wmx .empty-reader { display: grid; place-content: center; height: 100%; min-height: 300px; opacity: .4; }
		.wmx .reader pre.body {
			margin: 0; white-space: pre-wrap; word-break: break-word;
			font: inherit; max-height: calc(100vh - 340px); overflow: auto;
			background: var(--bg-elev1, #16161d); border-radius: 6px; padding: 10px;
		}
		.wmx .reader .actions { display: flex; gap: 6px; flex-wrap: wrap; }

		/* modals (settings / compose) */
		.wmx .modal-backdrop {
			position: fixed; inset: 0; z-index: 1000;
			background: rgba(0, 0, 0, .5);
			display: flex; align-items: center; justify-content: center;
		}
		/* UA [hidden] is display:none, which the flex above would override — force it back */
		.wmx .modal-backdrop[hidden] { display: none; }
		.wmx .modal {
			width: min(600px, 94vw); max-height: 88vh;
			background: var(--bg-elev0, #101016); border: 1px solid var(--border, #333);
			border-radius: 12px; padding: 0; box-shadow: 0 18px 48px rgba(0,0,0,.45);
			display: flex; flex-direction: column; overflow: hidden;
		}
		.wmx .modal-head {
			flex-shrink: 0;
			padding: 12px 16px;
			border-bottom: 1px solid var(--border, #333);
			display: flex; align-items: center; justify-content: space-between; gap: 10px;
		}
		.wmx .modal-head b { font-size: 14px; }
		.wmx .modal-head .modal-close { flex-shrink: 0; width: 28px; height: 28px; padding: 0; line-height: 1; font-size: 13px; }
		.wmx .modal-body { overflow: auto; min-height: 0; padding: 12px 16px 16px; }
		.wmx .cfg fieldset {
			border: 1px solid var(--border, #333); border-radius: 8px;
			display: grid; grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr); gap: 6px 10px;
			padding: 8px 10px; align-items: center; margin: 8px 0 0;
		}
		.wmx .cfg fieldset legend { font-size: 11px; opacity: .6; padding: 0 6px; }
		.wmx .cfg label { font-size: 12px; opacity: .7; }
		.wmx .cfg .full { grid-column: 1 / -1; display: flex; gap: 6px; align-items: center; }
		.wmx form.compose input, .wmx form.compose textarea { width: 100%; box-sizing: border-box; }
		.wmx form.compose .row { display: flex; gap: 8px; justify-content: flex-end; }
	</style>

	<header class="wmx-head">
		<h2>📬 Web mail
			<span class="chip st">…</span>
			<span class="chip unseen badge" hidden></span>
		</h2>
		<div class="head-actions">
			<button class="btn-compose" title="Compose">✉ Compose</button>
			<button class="btn-gear" title="Mail settings">⚙ Settings</button>
			<button class="btn-refresh" title="Refresh list">Refresh</button>
		</div>
	</header>
	<p class="hint deps" hidden>Runtime deps missing (imapflow / mailparser / nodemailer); installing in the background. You can also
		<button class="btn-deps">Install now</button></p>

	<div class="wmx-body">
		<section class="pane-list">
			<div class="toolbar">
				<select class="folder"><option value="INBOX">INBOX</option></select>
				<input type="search" class="q" placeholder="Search subject / from…" />
				<button class="btn-search">Search</button>
				<label style="opacity:.7;font-size:12px"><input type="checkbox" class="unseen-only" /> Unread</label>
			</div>
			<ul class="maillist"></ul>
		</section>
		<section class="reader">${EMPTY_READER}</section>
	</div>

	<div class="modal-backdrop cfg-modal" hidden>
		<div class="modal" role="dialog" aria-label="Mail settings">
			<div class="modal-head"><b>⚙ Mail settings</b><button class="modal-close" title="Close">✕</button></div>
			<div class="modal-body">
			<form class="cfg">
				<fieldset>
					<legend>Incoming IMAP</legend>
					<label>Server</label><input name="imapHost" placeholder="imap.example.com" />
					<label>Port</label><input name="imapPort" type="number" placeholder="993" />
					<label>Username</label><input name="imapUser" autocomplete="off" />
					<label>Password / app password</label><input name="imapPass" type="password" autocomplete="new-password" />
					<label class="full"><input type="checkbox" name="imapTls" /> Use SSL/TLS (port is usually 993; 143 if off)</label>
				</fieldset>
				<fieldset>
					<legend>Outgoing SMTP</legend>
					<label>Server</label><input name="smtpHost" placeholder="smtp.example.com" />
					<label>Port</label><input name="smtpPort" type="number" placeholder="465" />
					<label>Username</label><input name="smtpUser" autocomplete="off" />
					<label>Password / app password</label><input name="smtpPass" type="password" autocomplete="new-password" />
					<label>From display name</label><input name="smtpFrom" placeholder="Me &lt;me@example.com&gt;" />
					<label class="full"><input type="checkbox" name="smtpTls" /> Use SSL/TLS (port is usually 465)</label>
				</fieldset>
				<fieldset>
					<legend>Behavior</legend>
					<label>Poll interval (seconds)</label><input name="pollSec" type="number" min="15" />
					<label></label><span></span>
					<label class="full"><input type="checkbox" name="notifyEnabled" /> Desktop notice for new mail</label>
					<label class="full"><input type="checkbox" name="aiEnabled" />
						Allow AI to manage the mailbox — registers mail_list / mail_read / mail_search / mail_send /
						mail_manage tools on the chat agent (AI will confirm with you before sending)</label>
				</fieldset>
				<fieldset>
					<legend>Plugin update</legend>
					<label class="full" style="justify-content:space-between">
						<span style="opacity:.75">Pull the latest from GitHub and overwrite (keeps config; deps reinstall automatically)</span>
						<button type="button" class="btn-update">Update to latest</button>
					</label>
					<p class="hint full">Update runs in a visible terminal; refresh the page afterwards to load the new version.</p>
				</fieldset>
				<p class="hint">Credentials are stored in plaintext on this machine at &lt;dataDir&gt;/plugins/webmail/config.json — not uploaded, survive reinstall. Save applies immediately.</p>
				<div class="row" style="display:flex;justify-content:flex-end"><button type="submit" class="primary">Save and apply</button></div>
			</form>
			</div>
		</div>
	</div>

	<div class="modal-backdrop compose-modal" hidden>
		<div class="modal" role="dialog" aria-label="Compose">
			<div class="modal-head"><b>✉ Compose</b><button class="modal-close" title="Close">✕</button></div>
			<div class="modal-body">
			<form class="compose">
				<input name="to" placeholder="To to@example.com" required />
				<input name="subject" placeholder="Subject" />
				<textarea name="body" rows="8" placeholder="Body…"></textarea>
				<div class="row">
					<button type="button" class="btn-cancel">Cancel</button>
					<button type="submit" class="primary">Send</button>
				</div>
			</form>
			</div>
		</div>
	</div>
</div>`;

		const root = container.querySelector(".wmx");
		const $ = (sel) => root.querySelector(sel);
		const st = { mails: [], activeUid: null };

		function openModal(sel) {
			$(sel).hidden = false;
			const first = $(sel).querySelector("input, textarea");
			if (first) first.focus();
		}
		function closeModal(sel) {
			$(sel).hidden = true;
		}

		function setStateChips(state) {
			const chip = $(".st");
			chip.textContent = state.status || "Unknown";
			chip.className = `chip st ${state.configured ? (state.status.startsWith("Connection failed") ? "err" : "ok") : ""}`;
			const badge = $(".unseen");
			badge.hidden = !state.unseen;
			badge.textContent = `${state.unseen} unread`;
			$(".deps").hidden = state.depsOk || state.depsInstalling;
			$(".btn-deps").disabled = Boolean(state.depsInstalling);
			$(".btn-deps").textContent = state.depsInstalling ? "Installing…" : "Install now";
		}

		function fillSettings(cfg) {
			// Server nests config in state (state.config) — top-level msg.config is always undefined
			cfg = cfg?.config ?? cfg;
			if (!cfg) return;
			const f = $(".cfg");
			f.imapHost.value = cfg.imap?.host ?? "";
			f.imapPort.value = cfg.imap?.port ?? 993;
			f.imapUser.value = cfg.imap?.user ?? "";
			f.imapPass.placeholder = cfg.imap?.hasPass ? "Saved (type to overwrite)" : "Password";
			f.imapTls.checked = cfg.imap?.tls !== false;
			f.smtpHost.value = cfg.smtp?.host ?? "";
			f.smtpPort.value = cfg.smtp?.port ?? 465;
			f.smtpUser.value = cfg.smtp?.user ?? "";
			f.smtpPass.placeholder = cfg.smtp?.hasPass ? "Saved (type to overwrite)" : "Password";
			f.smtpFrom.value = cfg.smtp?.from ?? "";
			f.smtpTls.checked = cfg.smtp?.tls !== false;
			f.pollSec.value = cfg.pollSec ?? 60;
			f.notifyEnabled.checked = cfg.notifyEnabled !== false;
			f.aiEnabled.checked = Boolean(cfg.aiEnabled);
		}

		function renderList() {
			const ul = $(".maillist");
			if (!st.mails.length) {
				ul.innerHTML = `<li class="empty" style="list-style:none;border:0;cursor:default;display:block;text-align:center;opacity:.45;padding:24px 0">No matching mail</li>`;
				return;
			}
			ul.innerHTML = st.mails
				.map(
					(m) => `
<li data-uid="${m.uid}" class="${m.seen ? "" : "unread"}${m.uid === st.activeUid ? " active" : ""}">
	<span class="from">${m.seen ? "" : '<span class="dot"></span>'}${esc(m.fromName || m.from)}</span>
	<span class="date">${esc(fmtDate(m.date))}</span>
	<span class="subj">${esc(m.subject)}</span>
</li>`,
				)
				.join("");
		}

		function renderReader(mail) {
			const r = $(".reader");
			r.innerHTML = `
<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
	<b style="font-size:14px">${esc(mail.subject)}</b>
	<span style="opacity:.55;font-size:11px">${esc(fmtDate(mail.date))}</span>
</div>
<div style="opacity:.7;font-size:12px">${esc(mail.fromName)} &lt;${esc(mail.from)}&gt; → ${esc(mail.to)}
	${mail.hasAttachments ? " · 📎 has attachments (not shown below the body)" : ""}</div>
<pre class="body">${esc(mail.text)}${mail.truncated ? "\n\n…(truncated (too long))" : ""}</pre>
<div class="actions">
	<button class="act-toggle-seen">${mail.seen ? "Mark unread" : "Mark read"}</button>
	<button class="act-reply">Reply</button>
	<button class="act-delete danger">Delete</button>
</div>`;
			$(".act-toggle-seen").onclick = () =>
				ctx.send({ action: "mark", uids: [mail.uid], seen: !mail.seen });
			$(".act-delete").onclick = () => ctx.send({ action: "delete", uids: [mail.uid] });
			$(".act-reply").onclick = () => openCompose({ to: mail.from, subject: `Re: ${mail.subject}` });
		}

		function clearReader() {
			st.activeUid = null;
			$(".reader").innerHTML = EMPTY_READER;
		}

		function openCompose(prefill = {}) {
			const f = $("form.compose");
			f.to.value = prefill.to ?? "";
			f.subject.value = prefill.subject ?? "";
			openModal(".compose-modal");
			(prefill.to ? f.body : f.to).focus();
		}

		async function refreshList() {
			ctx.send({
				action: "list",
				folder: $(".folder").value,
				unseenOnly: $(".unseen-only").checked,
			});
		}

		// ---- events ----
		root.addEventListener("click", async (e) => {
			const li = e.target.closest("ul.maillist li[data-uid]");
			if (li) {
				st.activeUid = Number(li.dataset.uid);
				renderList();
				ctx.send({ action: "read", folder: $(".folder").value, uid: st.activeUid });
				return;
			}
			if (e.target.closest(".btn-refresh")) refreshList();
			if (e.target.closest(".btn-compose")) openCompose();
			if (e.target.closest(".btn-gear")) {
				// Re-fetch state before opening: the first echo on mount may beat the server finishing local config
				ctx.send({ action: "get_state" });
				openModal(".cfg-modal");
			}
			if (e.target.closest(".btn-update")) {
				// Reuse the host app's visible terminal for the update (same path as SCM commit/pull)
				window.dispatchEvent(
					new CustomEvent("pi-web-ui:plugin-run-command", {
						detail: {
							title: "webmail update",
							command: "pi-web-ui install xing-shuyin/pi-web-ui/tree/main/dev/plugins/webmail --force",
						},
					}),
				);
				closeModal(".cfg-modal");
			}
			if (e.target.closest(".btn-deps")) ctx.send({ action: "install_deps" });
			if (e.target.closest(".btn-search")) {
				const q = $(".q").value.trim();
				if (q) ctx.send({ action: "search", query: q, folder: $(".folder").value });
				else refreshList();
			}
			// Modal: click backdrop or ✕ to close
			for (const sel of [".cfg-modal", ".compose-modal"]) {
				const backdrop = $(sel);
				if (e.target === backdrop || e.target.closest(".modal-close")) closeModal(sel);
			}
		});
		root.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				closeModal(".compose-modal");
				closeModal(".cfg-modal");
			}
			if (e.key === "Enter" && e.target.classList.contains("q")) $(".btn-search").click();
		});
		$(".unseen-only").addEventListener("change", refreshList);

		$(".cfg").addEventListener("submit", (e) => {
			e.preventDefault();
			const f = e.target;
			const cfg = {
				imap: {
					host: f.imapHost.value.trim(),
					port: Number(f.imapPort.value) || 993,
					tls: f.imapTls.checked,
					user: f.imapUser.value.trim(),
					pass: f.imapPass.value || undefined, // blank = keep stored value
				},
				smtp: {
					host: f.smtpHost.value.trim(),
					port: Number(f.smtpPort.value) || 465,
					tls: f.smtpTls.checked,
					user: f.smtpUser.value.trim(),
					pass: f.smtpPass.value || undefined,
					from: f.smtpFrom.value.trim(),
				},
				pollSec: Math.max(15, Number(f.pollSec.value) || 60),
				notifyEnabled: f.notifyEnabled.checked,
				aiEnabled: f.aiEnabled.checked,
			};
			// Drop undefined so server merge semantics apply (empty password keeps the old value)
			for (const box of ["imap", "smtp"]) {
				for (const k of Object.keys(cfg[box])) {
					if (cfg[box][k] === undefined) delete cfg[box][k];
				}
			}
			ctx.send({ action: "save_config", config: cfg });
			closeModal(".cfg-modal");
		});

		$("form.compose").addEventListener("submit", (e) => {
			e.preventDefault();
			const f = e.target;
			ctx.send({
				action: "send",
				to: f.to.value.trim(),
				subject: f.subject.value,
				body: f.body.value,
			});
			f.reset();
			closeModal(".compose-modal");
		});
		$("form.compose .btn-cancel").addEventListener("click", () => {
			$("form.compose").reset();
			closeModal(".compose-modal");
		});

		// ---- server → view ----
		const off = ctx.onData((payload) => {
			const msg = payload ?? {};
			switch (msg.kind) {
				case "state":
					setStateChips(msg.state);
					fillSettings(msg.state ?? msg.config); // config is nested in state
					break;
				case "mails":
					st.mails = msg.mails ?? [];
					renderList();
					break;
				case "mail":
					renderReader(msg.mail);
					break;
				case "new-mail":
					refreshList();
					break;
				case "result":
					if (msg.action === "mark") renderList();
					if (msg.action === "delete") {
						clearReader();
						refreshList();
					}
					break;
			}
		});

		ctx.send({ action: "get_state" });
		refreshList();

		return () => {
			off();
			root.remove();
		};
	},
};
