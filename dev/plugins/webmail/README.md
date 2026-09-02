# 📬 webmail — pi-web-ui web mail plugin

Adds a full mailbox management view to the pi-web-ui UI (📬 tab in the top bar):
IMAP receive + SMTP send + new-mail notifications, with an option to let the AI
manage the mailbox directly.

## Features

- **Inbox**: browse / keyword search (subject, from, to) / read full body /
  mark read/unread / delete
- **Send**: SMTP plain-text mail, CC supported
- **New-mail notifications**: poll INBOX unread count; new mail fires `host.notify`
  (poll interval configurable, default 60s)
- **AI mailbox tools** (off by default): enable "Allow AI to manage mailbox" in
  settings to register six AI tools — `mail_list` / `mail_read` / `mail_search` /
  `mail_send` / `mail_manage` / `mail_folders`. In chat you can say "show recent
  mail"; turning the switch off unregisters the tools

## Config

The settings panel stores `<dataDir>/plugins/webmail/config.json` (plaintext on this
machine, same security model as pi `auth.json`):

| Field | Notes |
| --- | --- |
| IMAP host / port / TLS | Incoming server (e.g. imap.qq.com:993) |
| SMTP host / port / TLS | Outgoing server (e.g. smtp.qq.com:465) |
| Username / password | Mail account and password or app password |
| Poll interval pollSec | Unread check period, default 60s |
| Allow AI manage aiEnabled | Register/unregister AI mailbox tools |

Config echo is redacted: only `hasPass` is returned, passwords never go back to the browser.

## Install / uninstall / update

```bash
# ── Install ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/dev/plugins/webmail
pi-web-ui install dev/plugins/webmail        # or a local directory (dev)
# optional: --data-dir <dir> custom data directory (default ~/.pi-web)

# ── List ──
pi-web-ui plugins                            # list installed plugins and ids

# ── Update ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/dev/plugins/webmail --force
                                             # --force overwrites = update
                                             # ⚠ back up config.json in the plugin dir (account credentials)

cp -r dev/plugins/webmail ~/.pi-web/plugins/ # local dev: copy over
                                             # Windows: %USERPROFILE%\.pi-web\plugins\webmail

# ── Uninstall ──
pi-web-ui uninstall webmail                  # removes the plugin dir (including config.json)
# manual: rm -rf ~/.pi-web/plugins/webmail
```

Refresh the browser to apply. imapflow / mailparser / nodemailer are **not shipped**:
first activate runs npm install into the plugin directory; if that fails, click
"Install dependencies" in the view.

## Regression tests

- `tests/unit/plugin-tools.test.ts`: sync diff + register lifecycle (vitest)
- `tests/scratch/webmail-e2e-test.mjs`: protocol smoke (list/state echo/save_config
  on disk/password not echoed)
- `tests/scratch/webmail-crash-test.mjs`: missing deps must not crash the host +
  activate auto-installs
