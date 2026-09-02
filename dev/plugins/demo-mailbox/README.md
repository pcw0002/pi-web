# 📬 demo-mailbox — plugin development sample

A **minimal runnable sample** of a pi-web-ui optional UI component: demonstrates the
full path of "server entry `index.mjs` + client view `client/entry.mjs` + two-way
messages". Also used as the protocol fixture for `tests/plugin-test.mjs`.

## What it does

- Two sample messages in memory plus an echo form
- The client view renders the mail list and send form; sent messages go over
  WebSocket to the server, which broadcasts them to every open page (multi-tab live)
- Demonstrates `host.onMessage` / `host.broadcast` / `host.notify`

## Layout

```
demo-mailbox/
├── manifest.json      # plugin manifest (id/icon/name/version/description)
├── index.mjs          # server entry: export default { activate(host) → deactivate? }
└── client/entry.mjs   # view entry: export default { mount(el, ctx) → cleanup? }
```

## Try it locally

```bash
# ── Install ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/dev/plugins/demo-mailbox
pi-web-ui install dev/plugins/demo-mailbox   # or a local directory

# ── List / uninstall ──
pi-web-ui plugins                            # list installed plugins and ids
pi-web-ui uninstall demo-mailbox             # or rm -rf ~/.pi-web/plugins/demo-mailbox

# ── Update ──
pi-web-ui install ...same as above... --force  # overwrite reinstall
cp -r dev/plugins/demo-mailbox ~/.pi-web/plugins/
```

Refresh the page; a 📬 tab in the top bar means it worked. Delete the directory and
refresh to uninstall — plugins "do not exist until installed", no registration step.

## Notes for plugin authors

- The server can use all of Node (a real plugin such as webmail talks IMAP/SMTP here);
  keep credentials in `<pluginDir>/`, not in the source tree
- The client has only two narrow channels with the host app: `ctx.send()` up,
  `ctx.onData()` down; they do not share a React instance
- Request-shaped upstream messages must carry a `reqId` so responses can match
  concurrent calls; responses without a reqId are silently dropped by the client
- Protocol details: pi-web-ui main README "Plugins" section and AGENTS.md
