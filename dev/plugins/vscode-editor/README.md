# 📝 vscode-editor — pi-web-ui editor + SSH plugin (Remote-SSH)

Adds a VS Code-like workbench view to the pi-web-ui UI:

- **Multi-root file tree**: local workspace + saved SSH hosts (one tree, one set of tabs)
- **Workspace follow**: when the host app switches project (`set_cwd`), the local tree root
  switches to the new project in real time — directory cache/expanded state is cleared,
  local tabs are closed (dirty tabs prompt), remote SSH tabs and connections are untouched;
  `.vscode/sftp.json` is per-project and re-read after the switch
- **CodeMirror 6 multi-tab editor**: local and remote files open together, syntax
  highlighting, Ctrl+S save (remote files written back over SFTP), CRLF line endings
  preserved, Ctrl+P quick-open (local)
- **Resizable bottom terminal panel**: each connected host can open multiple shells
  (xterm.js), with window-size sync and keepalive; right-click a remote file/folder to
  open a terminal in that directory
- **SFTP sync** (☁ menu): upload/download the whole workspace, upload the current file,
  auto-upload on save (`uploadOnSave`); config lives in the workspace `.vscode/sftp.json`,
  compatible with **vscode-sftp / Natizyskunk.sftp** — you can copy `sftp.json` from
  VS Code and Ctrl+S to apply. Supported fields: `name` / `host` / `port` / `username` /
  `password` / `passphrase` / `privateKey` / `privateKeyPath` (`~` expansion, e.g.
  `~/.ssh/id_rsa`) / `remotePath` (remote root) / `ignore` (glob excludes) /
  `uploadOnSave` / legacy `watcher.autoUpload` / `agent` (e.g. `$SSH_AUTH_SOCK` for
  ssh-agent). Use any one of password, private key, or agent.
- **Download to disk** (context menu): local files download directly; remote files/folders
  skip the workspace mapping; folders are tar.gz-packed on the remote, save location is
  user-chosen

The old standalone ssh plugin is merged in: a legacy `<pluginDir>/ssh-hosts.json` host
list is migrated automatically on first activate.

## File tree interactions

- **In-place expand/collapse**: clicking a folder loads only that directory's children
  (with a "⏳ Loading" placeholder), without redrawing the whole tree; collapse is instant
- **Selection highlight**: click or right-click any row to select it; toolbar ＋📄/＋📁
  targets the selected directory (or the parent folder if a file is selected); after
  create, the new entry becomes the selection
- **Context menu**: new / rename / delete / two-way sync / open terminal (scope-aware)

## Unified scope model

scope = `"local" | connId`. Every front-end file operation (list/read/write/create/rename/
delete) carries scope; remote calls automatically attach `connId` — the server routes to
local fs or that connection's SFTP. Front and back share one code path.

## Layout

```
vscode-editor/
├── manifest.json        # plugin manifest (id/icon/name)
├── index.mjs            # server entry: local file CRUD / SFTP sync (.vscode/sftp.json) /
│                        #   SSH host manager + connection pool + PTY shell + exec + remote SFTP
├── src/client.js        # client source (CodeMirror 6 + xterm.js)
├── build.mjs            # esbuild bundle script (xterm CSS inlined as text)
├── package.json         # build/deps list (ssh2 is a devDep; the server installs it at runtime)
└── client/entry.mjs     # build output (self-contained bundle, loaded by the browser)
```

## Install / uninstall / update

```bash
# ── Install ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/dev/plugins/vscode-editor
pi-web-ui install dev/plugins/vscode-editor  # or a local directory (dev)
# optional: --data-dir <dir> custom data directory (default ~/.pi-web)

# ── List ──
pi-web-ui plugins                            # list installed plugins and ids

# ── Update ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/dev/plugins/vscode-editor --force
                                             # --force overwrites = update
                                             # ⚠ back up ssh-hosts.json in the plugin dir and
                                             #   workspace .vscode/sftp.json (host creds / sync config)

cp -r dev/plugins/vscode-editor ~/.pi-web/plugins/  # local dev: npm run build after src changes, then copy
                                             # Windows: %USERPROFILE%\.pi-web\plugins\vscode-editor
                                             # only manifest.json + index.mjs + client/ are needed;
                                             # node_modules / src / build.mjs do not need to be copied

# ── Uninstall ──
pi-web-ui uninstall vscode-editor            # removes the plugin dir (including ssh-hosts.json)
# manual: rm -rf ~/.pi-web/plugins/vscode-editor
```

Refresh the page; a 📝 tab in the top bar means it worked. ssh2 is not shipped with the
package; first activate runs npm install into the plugin directory (if that fails, click
the sidebar "⚠ssh2" button).
