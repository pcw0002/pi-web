/**
 * demo-mailbox server entry — plugin protocol sample.
 *
 * Convention: ESM default export { activate(host) → deactivate? }.
		// Declarative settings (manifest "settings"): read defaults + subscribe to panel changes.
		// Demonstrates the full loop: the host already validated and persisted by schema; the plugin only consumes.
		let cfg = host.getSettings?.() ?? {};
		const offSettings = host.onSettingsChanged?.((v) => {
			cfg = v;
			host.log("settings changed:", JSON.stringify(v));
			host.broadcast({ settings: cfg });
		});
 * host provides broadcast / onMessage / dir / dataDir / cwd / log.
 * A real mail plugin would talk IMAP/SMTP here (credentials in host.dir, not in the repo);
 * this sample only does in-memory send/receive + echo to prove the wire works.
 */

const mails = [
	{
		id: 1,
		from: "alice@example.com",
		subject: "Welcome to the pi-web-ui plugin",
		date: new Date().toISOString(),
		body:
			"This is a UI component provided by a plugin: the directory lives at <dataDir>/plugins/demo-mailbox/," +
			" deleting the directory uninstalls it. The server entry (this file) can use all of Node.",
	},
	{
		id: 2,
		from: "bob@example.com",
		subject: "Try sending a message",
		date: new Date(Date.now() - 3600_000).toISOString(),
		body: "Fill in the recipient and body in the form below and click Send — the message reaches this file over WebSocket, then broadcasts back to every open page.",
	},
];
let nextId = 3;

export default {
	activate(host) {
		const off = host.onMessage((payload) => {
			const msg = payload ?? {};
			switch (msg.action) {
				case "list":
					host.broadcast({ mails });
					break;
				case "notify":
					host.notify("info", String(msg.text ?? "Plugin notify test"));
					break;
				case "send": {
					const mail = {
						id: nextId++,
						from: "me@local",
						to: String(msg.to ?? ""),
						subject: String(msg.subject ?? "(no subject)"),
						date: new Date().toISOString(),
						body: String(msg.body ?? ""),
						outgoing: true,
					};
					mails.unshift(mail);
					host.log("sent:", mail.to, mail.subject);
					host.broadcast({ mails });
					break;
				}
				default:
					host.log("unknown action:", msg.action);
			}
		});
		host.log("activated; mails in memory:", mails.length);

		// Return a cleanup function: called when the plugin directory is deleted / the server shuts down
		return () => {
			off();
			host.log("deactivated");
		};
	},
};
