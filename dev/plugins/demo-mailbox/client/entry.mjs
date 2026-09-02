/**
 * demo-mailbox client view — plugin protocol sample.
 *
 * Convention: ESM default export { mount(container, ctx) → cleanup? }.
 * ctx.send(payload) sends plugin_message; ctx.onData(cb) subscribes to plugin_data.
 * No React — plain DOM is enough; you can also bundle any framework (own instance, isolated from the host).
 */

let uid = 0;

function esc(s) {
	return String(s).replace(/[&<>"']/g, (c) => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
	));
}

export default {
	mount(container, ctx) {
		container.innerHTML = `
<div class="mbx">
	<style>
		.mbx { max-width: 760px; margin: 0 auto; font-size: 13px; }
		.mbx h2 { margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
		.mbx .hint { opacity: .6; margin: 0 0 12px; }
		.mbx ul { list-style: none; padding: 0; display: grid; gap: 8px; }
		.mbx li { border: 1px solid var(--border, #333); border-radius: 8px; padding: 10px 12px; }
		.mbx .meta { display: flex; gap: 10px; opacity: .65; font-size: 12px; margin-bottom: 4px; }
		.mbx form { display: grid; grid-template-columns: 1fr 2fr auto; gap: 8px; margin: 14px 0; }
		.mbx input, .mbx textarea {
			background: var(--bg-elev1, #16161d); color: inherit;
			border: 1px solid var(--border, #333); border-radius: 6px; padding: 6px 8px;
			font: inherit; resize: vertical;
		}
		.mbx button {
			background: var(--accent, #7c5cff); color: #fff; border: 0;
			border-radius: 6px; padding: 6px 14px; cursor: pointer; font: inherit;
		}
	</style>
	<h2>📬 Mailbox <small style="opacity:.5;font-weight:normal">plugin view sample</small></h2>
	<p class="hint">From &lt;dataDir&gt;/plugins/demo-mailbox/ — delete that directory and refresh to uninstall.</p>
	<ul></ul>
	<form>
		<input name="to" placeholder="To" required />
		<input name="subject" placeholder="Subject" />
		<button type="submit">Send</button>
		<textarea name="body" rows="3" placeholder="Body…" style="grid-column:1/-1"></textarea>
	</form>
</div>`;

		const root = container.querySelector(".mbx");
		const listEl = root.querySelector("ul");
		const form = root.querySelector("form");

		function render(mails) {
			listEl.innerHTML = (mails ?? [])
				.map(
					(m) => `
<li>
	<div class="meta">
		<b>${esc(m.outgoing ? `To ${m.to}` : m.from)}</b>
		<span>${esc(new Date(m.date).toLocaleString())}</span>
	</div>
	<div><b>${esc(m.subject)}</b></div>
	<div style="white-space:pre-wrap;margin-top:4px">${esc(m.body)}</div>
</li>`,
				)
				.join("");
		}

		form.addEventListener("submit", (e) => {
			e.preventDefault();
			const fd = new FormData(form);
			ctx.send({
				action: "send",
				to: fd.get("to"),
				subject: fd.get("subject"),
				body: fd.get("body"),
			});
			form.reset();
		});

		const off = ctx.onData((payload) => {
			if (payload && Array.isArray(payload.mails)) render(payload.mails);
		});
		ctx.send({ action: "list" }); // fetch initial list

		return () => {
			off();
			root.remove();
		};
	},
};
