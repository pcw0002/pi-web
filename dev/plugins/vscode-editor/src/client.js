/**
 * vscode-editor client view — a lightweight VS Code-like editor + Remote-SSH.
 *
 * Stack: CodeMirror 6 (editor) + xterm.js (remote terminal), bundled into this file by esbuild,
 * no runtime external deps. Layout: left multi-root file tree (local workspace + SSH hosts) + right multi-tab
 * editor + resizable bottom terminal panel; Ctrl+P quick-open (local), Ctrl+S save (local/remote).
 *
 * Scope model: scope = "local" | connId. File-tree nodes and tabs all carry scope;
 * every file op (list/read/write/create/rename/delete) is auto-tagged by req()
 * with connId — the server routes to local fs or that connection's SFTP. Front and back share one code path.
 *
 * Protocol with the server (index.mjs): { action, reqId, ... } upstream,
 * { res:true, reqId, ok, ... } responses (reqId matches concurrent calls); event stream shell_data /
 * shell_exit / conn_closed / sync_progress pushed to the requester; kind:"state" broadcasts host state,
 * kind:"workspace" broadcasts workspace switches (host app set_cwd).
 */
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, dropCursor, highlightSpecialChars } from "@codemirror/view";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import xtermCss from "@xterm/xterm/css/xterm.css";

function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
	));
}

let reqSeq = 0;

const b64 = {
	enc: (s) => btoa(unescape(encodeURIComponent(s))),
	bytes: (b64s) => Uint8Array.from(atob(b64s), (c) => c.charCodeAt(0)),
};

/** POSIX shell single-quote escape (for cd into paths with spaces/quotes) */
const shQuote = (s) => `'${String(s ?? "").replace(/'/g, "'\\''")}'`;

// ---- language detection -----------------------------------------------------------

const LANGS = [
	[/\.(jsx?|mjs|cjs)$/, () => javascript()],
	[/\.tsx?$/, () => javascript({ typescript: true })],
	[/\.json5?$/, () => json()],
	[/\.css$/, () => css()],
	[/\.(html?|vue|svelte)$/, () => html()],
	[/\.(md|markdown)$/, () => markdown()],
	[/\.py$/, () => python()],
];

function langFor(path) {
	const p = path.toLowerCase();
	for (const [re, make] of LANGS) if (re.test(p)) return make();
	return null;
}

function langName(path) {
	if (/\.tsx?$/.test(path)) return "TypeScript";
	if (/\.(jsx?|mjs|cjs)$/.test(path)) return "JavaScript";
	if (/\.json5?$/.test(path)) return "JSON";
	if (/\.css$/.test(path)) return "CSS";
	if (/\.(html?|vue|svelte)$/.test(path)) return "HTML";
	if (/\.(md|markdown)$/.test(path)) return "Markdown";
	if (/\.py$/.test(path)) return "Python";
	return "Plain Text";
}

// ---- file icons ------------------------------------------------------------

function iconFor(name, type) {
	if (type === "dir") return "📁";
	const ext = (name.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
	const map = {
		js: "🟨", mjs: "🟨", cjs: "🟨", jsx: "⚛️", ts: "🟦", tsx: "⚛️",
		json: "🔧", md: "📝", css: "🎨", html: "🌐", py: "🐍",
		png: "🖼", jpg: "🖼", jpeg: "🖼", gif: "🖼", webp: "🖼", svg: "🖼",
		lock: "🔒", yml: "⚙️", yaml: "⚙️", toml: "⚙️", sh: "💻", bat: "💻",
	};
	return map[ext] || "📄";
}

// ---- fuzzy match (Ctrl+P quick-open): score or -1 -----------------------

export function fuzzyScore(query, target) {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	let qi = 0, score = 0, streak = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			streak++;
			score += 1 + streak; // bonus for consecutive hits
			qi++;
		} else streak = 0;
	}
	if (qi < q.length) return -1;
	// bonus for short names / early hits
	score += Math.max(0, 40 - t.length) / 10;
	return score;
}

export default {
	mount(container, ctx) {
		container.innerHTML = `
<div class="vsc">
	<style>${xtermCss}</style>
	<style>
		.vsc { position: relative; display: flex; height: 100%; min-height: 480px;
			overflow: hidden;
			background: var(--bg-elev0, #101016); color: var(--text, #e6e6ef); font-size: 13px; }
		/* ---- left multi-root file tree ---- */
		.vsc-side { width: 240px; min-width: 160px; flex-shrink: 0; display: flex; flex-direction: column;
			border-right: 1px solid var(--border, #333); background: var(--bg-elev1, #16161d); }
		.vsc-side-head { display: flex; align-items: center; gap: 4px; padding: 8px 10px 6px;
			font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .85; }
		.vsc-side-head b { flex: 1; font-weight: 600; }
		.vsc-side-head button { all: unset; cursor: pointer; padding: 2px 5px; border-radius: 4px; font-size: 12px; }
		.vsc-side-head button:hover { background: var(--bg-elev2, #20202b); }
		/* ---- sidebar dual tabs: Files / SSH ---- */
		.vsc-stabs { display: flex; gap: 4px; padding: 6px 8px;
			border-bottom: 1px solid var(--border, #333); background: var(--bg-elev1, #16161d); }
		.vsc-stabs .stab { all: unset; cursor: pointer; padding: 3px 12px; border-radius: 6px; font-size: 12.5px; opacity: .65; }
		.vsc-stabs .stab.active { background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent);
			opacity: 1; font-weight: 600; }
		.vsc-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
		.vsc-hosts { flex-shrink: 0; max-height: 32%; overflow: auto; padding: 2px 0 6px; user-select: none; }
		.vsc-sshtree { flex: 1; min-height: 0; overflow: auto; padding: 4px 0 12px; user-select: none;
			border-top: 1px solid var(--border, #333); }
		.vsc-sect .cwd { opacity: .45; font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; margin-left: 6px; direction: rtl; }
		.vsc-tree { flex: 1; overflow: auto; padding: 2px 0 12px; user-select: none; }
		.vsc-row { display: flex; align-items: center; gap: 5px; padding: 2px 8px; cursor: pointer;
			white-space: nowrap; line-height: 1.7; }
		.vsc-row:hover { background: var(--bg-elev2, #20202b); }
		.vsc-row.active { background: color-mix(in srgb, var(--accent, #7c5cff) 22%, transparent); }
		/* selection (distinct from the open-file active): shows where toolbar New will land */
		.vsc-row.sel { background: color-mix(in srgb, var(--accent, #7c5cff) 12%, transparent);
			box-shadow: inset 2px 0 0 var(--accent, #7c5cff); }
		.vsc-row.loading { opacity: .45; }
		.vsc-row .caret { width: 12px; text-align: center; opacity: .55; font-size: 9px; flex-shrink: 0; }
		.vsc-row .nm { overflow: hidden; text-overflow: ellipsis; }
		.vsc-sect { display: flex; align-items: center; gap: 4px; padding: 8px 8px 3px;
			font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase; opacity: .75; }
		.vsc-sect b { flex: 1; font-weight: 600; }
		.vsc-sect button { all: unset; cursor: pointer; padding: 1px 5px; border-radius: 4px; font-size: 11px; }
		.vsc-sect button:hover { background: var(--bg-elev2, #20202b); }
		.vsc-hrow .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
			background: var(--text-dim, #666); }
		.vsc-hrow .dot.on { background: var(--green, #4ade80); box-shadow: 0 0 6px var(--green, #4ade80); }
		.vsc-hrow .dot.busy { background: var(--amber, #fbbf24); animation: vscpulse 1s infinite alternate; }
		@keyframes vscpulse { from { opacity: .4 } to { opacity: 1 } }
		.vsc-hrow .ops { display: none; gap: 2px; margin-left: auto; }
		.vsc-hrow:hover .ops { display: flex; }
		.vsc-hrow .ops button { all: unset; cursor: pointer; padding: 0 4px; border-radius: 4px; font-size: 11px; opacity: .7; }
		.vsc-hrow .ops button:hover { opacity: 1; background: var(--bg-elev3, #2a2a38); }
		.vsc-deps { padding: 4px 10px; }
		.vsc-deps button { all: unset; display: block; width: 100%; box-sizing: border-box; cursor: pointer;
			padding: 4px 8px; border-radius: 5px; font-size: 11.5px; color: var(--amber, #fbbf24); }
		.vsc-deps button:hover { background: var(--bg-elev2, #20202b); }
		/* ---- right main pane ---- */
		.vsc-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
		.vsc-tabs { display: flex; overflow-x: auto; border-bottom: 1px solid var(--border, #333);
			background: var(--bg-elev1, #16161d); scrollbar-width: thin; }
		.vsc-tab { display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px 6px 12px;
			cursor: pointer; border-right: 1px solid var(--border, #333); white-space: nowrap;
			color: var(--text-dim, #9a9ab0); max-width: 200px; }
		.vsc-tab.active { background: var(--bg-elev0, #101016); color: var(--text, #e6e6ef);
			box-shadow: inset 0 2px 0 var(--accent, #7c5cff); }
		.vsc-tab .tn { overflow: hidden; text-overflow: ellipsis; }
		.vsc-tab .dot { color: var(--amber, #fbbf24); }
		.vsc-tab .x { all: unset; cursor: pointer; padding: 0 3px; border-radius: 4px; opacity: .55; }
		.vsc-tab .x:hover { opacity: 1; background: var(--bg-elev2, #20202b); }
		.vsc-edwrap { flex: 1; min-height: 0; position: relative; }
		.vsc-empty { position: absolute; inset: 0; display: grid; place-items: center;
			opacity: .45; text-align: center; line-height: 2; }
		.vsc-editor { height: 100%; }
		.vsc-editor .cm-editor { height: 100%; }
		.vsc-editor .cm-scroller { font-family: ui-monospace, Consolas, "Cascadia Mono", monospace; }
		/* ---- bottom terminal panel ---- */
		.vsc-termdrag { height: 4px; cursor: row-resize; flex-shrink: 0;
			background: var(--bg-elev1, #16161d); border-top: 1px solid var(--border, #333); }
		.vsc-termdrag:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 35%, transparent); }
		.vsc-termpanel { height: 240px; min-height: 80px; display: flex; flex-direction: column;
			flex-shrink: 0; background: var(--term-bg, #101016); }
		.vsc-termbar { display: flex; align-items: center; gap: 4px; padding: 3px 8px;
			border-bottom: 1px solid var(--border, #333); background: var(--bg-elev1, #16161d);
			font-size: 11.5px; user-select: none; }
		.vsc-termbar .tt { opacity: .6; text-transform: uppercase; letter-spacing: .06em; font-size: 10.5px; margin-right: 4px; }
		.vsc-termbar .grow { flex: 1; }
		.vsc-termbar button { all: unset; cursor: pointer; padding: 1px 7px; border-radius: 5px; font-size: 12px; }
		.vsc-termbar button:hover { background: var(--bg-elev2, #20202b); }
		.vsc-ttab { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; cursor: pointer;
			border-radius: 5px; color: var(--text-dim, #9a9ab0); white-space: nowrap; max-width: 180px; }
		.vsc-ttab.active { background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent); color: var(--text, #e6e6ef); }
		.vsc-ttab .tn { overflow: hidden; text-overflow: ellipsis; }
		.vsc-ttab .x { all: unset; cursor: pointer; opacity: .5; font-size: 10px; padding: 0 2px; }
		.vsc-ttab .x:hover { opacity: 1; }
		.vsc-termarea { flex: 1; min-height: 0; position: relative; padding: 4px 6px; }
		.vsc-term { position: absolute; inset: 4px 6px; }
		.vsc-term .xterm { height: 100%; }
		/* ---- status bar ---- */
		.vsc-status { display: flex; align-items: center; gap: 14px; padding: 4px 12px;
			border-top: 1px solid var(--border, #333); background: var(--bg-elev1, #16161d);
			font-size: 11.5px; color: var(--text-dim, #9a9ab0); }
		.vsc-status .grow { flex: 1; }
		.vsc-status .dirty { color: var(--amber, #fbbf24); }
		.vsc-status .remote { color: var(--green, #4ade80); }
		.vsc-err { color: var(--red, #f87171); }
		/* quick-open overlay */
		.vsc-quickopen { position: absolute; left: 50%; top: 40px; transform: translateX(-50%);
			width: min(520px, 80%); z-index: 30; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 10px;
			box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden; }
		.vsc-quickopen input { width: 100%; box-sizing: border-box; background: transparent; color: inherit;
			border: 0; outline: 0; padding: 10px 14px; font: inherit; border-bottom: 1px solid var(--border, #333); }
		.vsc-quickopen ul { list-style: none; margin: 0; padding: 4px 0; max-height: 300px; overflow: auto; }
		.vsc-quickopen li { padding: 5px 14px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
		.vsc-quickopen li.sel, .vsc-quickopen li:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent); }
		.vsc-quickopen li small { opacity: .5; margin-left: auto; direction: rtl; }
		.vsc-hidden { display: none !important; }
		/* tree context menu / sync menu */
		.vsc-menu { position: absolute; z-index: 40; min-width: 150px; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 8px; padding: 4px;
			box-shadow: 0 10px 30px rgba(0,0,0,.4); }
		.vsc-menu button { all: unset; display: block; width: 100%; box-sizing: border-box; cursor: pointer;
			padding: 5px 10px; border-radius: 5px; font: inherit; }
		.vsc-menu button:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 30%, transparent); }
		.vsc-menu button.dim { opacity: .55; }
		/* sync progress toast */
		.vsc-sync-status { position: absolute; right: 14px; bottom: 44px; z-index: 25; max-width: 70%;
			background: var(--bg-elev2, #20202b); border: 1px solid var(--accent, #7c5cff); border-radius: 8px;
			padding: 6px 12px; font-size: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
		/* modal (shared by host form / sync config) */
		.vsc-modal-bg { position: absolute; inset: 0; z-index: 50; background: rgba(0,0,0,.45);
			display: grid; place-items: center; }
		.vsc-modal { width: min(430px, 90%); max-height: 94%; overflow: auto; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 12px; padding: 16px 18px; }
		.vsc-modal h3 { margin: 0 0 10px; }
		.vsc-modal label { display: block; font-size: 11.5px; opacity: .7; margin: 9px 0 3px; }
		.vsc-modal input, .vsc-modal textarea { width: 100%; box-sizing: border-box; background: var(--bg-elev0, #101016);
			color: inherit; border: 1px solid var(--border, #444); border-radius: 6px; padding: 6px 9px; font: inherit; }
		.vsc-modal textarea { font: 12px ui-monospace, monospace; resize: vertical; }
		.vsc-modal .grid2 { display: grid; grid-template-columns: 1fr 100px; gap: 8px; }
		.vsc-modal .hint { font-size: 11px; opacity: .5; margin-top: 8px; line-height: 1.6; }
		.vsc-modal .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
		.vsc-modal .btns button { all: unset; cursor: pointer; padding: 6px 14px; border-radius: 7px; font-size: 13px;
			border: 1px solid var(--border, #444); }
		.vsc-modal .btns button.primary { background: var(--accent, #7c5cff); border-color: transparent; color: #fff; }
		.vsc-modal .btns button:hover { filter: brightness(1.15); }
	</style>
	<div class="vsc-side">
		<div class="vsc-stabs">
			<button class="stab active" data-pane="files">📁 Files</button>
			<button class="stab" data-pane="ssh">🖥 SSH</button>
		</div>
		<div class="vsc-pane" data-pane="files">
			<div class="vsc-side-head">
				<b>Explorer</b>
				<button data-act="new-file" title="New file (in the selected directory)">＋📄</button>
				<button data-act="new-dir" title="New folder (in the selected directory)">＋📁</button>
				<button data-act="sync-menu" title="Sync to server (SFTP)">☁</button>
				<button data-act="refresh" title="Refresh">⟳</button>
			</div>
			<div class="vsc-tree"></div>
		</div>
		<div class="vsc-pane vsc-hidden" data-pane="ssh">
			<div class="vsc-side-head">
				<b>SSH host</b>
				<button data-act="add-host" title="Add host">＋</button>
				<button data-act="deps" class="vsc-hidden" title="Install ssh2">⚠ssh2</button>
				<button data-act="new-term" title="New remote terminal">🖥</button>
				<button data-act="r-new-file" title="New file (in the selected directory)">＋📄</button>
				<button data-act="r-new-dir" title="New folder (in the selected directory)">＋📁</button>
				<button data-act="r-refresh" title="Refresh remote directory">⟳</button>
			</div>
			<div class="vsc-hosts"></div>
			<div class="vsc-sshtree"></div>
		</div>
	</div>
	<div class="vsc-main">
		<div class="vsc-tabs"></div>
		<div class="vsc-edwrap">
			<div class="vsc-empty">Open a file from the left to start editing<br><small>Ctrl+P quick open · Ctrl+S save · ＋ on the left to add an SSH host</small></div>
			<div class="vsc-editor vsc-hidden"></div>
		</div>
		<div class="vsc-termdrag vsc-hidden"></div>
		<div class="vsc-termpanel vsc-hidden">
			<div class="vsc-termbar">
				<span class="tt">Terminal</span>
				<span class="tts"></span>
				<button class="t-add" title="New terminal">＋</button>
				<span class="grow"></span>
				<button class="t-hide" title="Collapse panel">▾</button>
			</div>
			<div class="vsc-termarea"></div>
		</div>
		<div class="vsc-status">
			<span class="vsc-scope"></span>
			<span class="vsc-path">—</span>
			<span class="grow"></span>
			<span class="vsc-lang"></span>
			<span class="vsc-pos"></span>
			<span class="vsc-state"></span>
		</div>
	</div>
	<div class="vsc-quickopen vsc-hidden">
		<input placeholder="Filter by file name… (Esc to close)" />
		<ul></ul>
	</div>
	<div class="vsc-menu vsc-hidden"></div>
	<div class="vsc-sync-status vsc-hidden"></div>
	<div class="vsc-modal-bg vsc-hidden">
		<div class="vsc-modal">
			<h3>Sync config (SFTP)</h3>
			<label>Name (optional, label only)</label><input name="s-name" placeholder="my-server" />
			<label>Host *</label><input name="s-host" placeholder="192.168.1.10" />
			<div class="grid2">
				<span><label>Username</label><input name="s-user" value="root" /></span>
				<span><label>Port</label><input name="s-port" value="22" /></span>
			</div>
			<label>Password (leave blank = keep current)</label><input name="s-pass" type="password" autocomplete="off" />
			<label>Private key (PEM, optional)</label><textarea name="s-key" rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
			<label>Private key path (optional; ~ expands e.g. ~/.ssh/id_rsa; used first if set)</label><input name="s-keypath" placeholder="~/.ssh/id_rsa" />
			<label>SSH agent socket (optional, e.g. $SSH_AUTH_SOCK; alternative to password/key)</label><input name="s-agent" placeholder="$SSH_AUTH_SOCK" />
			<label>Remote root * (directory on the server to sync into)</label><input name="s-root" placeholder="/var/www/app" />
			<label>Excludes (vscode-sftp-style glob, comma-separated)</label><input name="s-exclude" placeholder="node_modules/**, dist, *.log" />
			<label style="display:flex;align-items:center;gap:6px"><input type="checkbox" name="s-autosave" style="width:auto" /> Auto-upload the current file on save (vscode-sftp uploadOnSave)</label>
			<div class="hint">Saved in the workspace <b>.vscode/sftp.json</b> (vscode-sftp / Natizyskunk.sftp compatible). Edit that file and Ctrl+S to apply. Supports name / passphrase / privateKeyPath (~ expansion) / agent (\$SSH_AUTH_SOCK) / ignore glob / watcher.autoUpload.</div>
			<div class="btns"><button class="cancel">Cancel</button><button class="test">Test connection</button><button class="primary save-cfg">Save</button></div>
		</div>
	</div>
	<div class="vsc-modal-bg vsc-host-bg vsc-hidden">
		<div class="vsc-modal">
			<h3 class="h-title">New host</h3>
			<label>Name (optional)</label><input name="h-name" placeholder="my-server" />
			<div class="grid2">
				<span><label>Host *</label><input name="h-host" placeholder="192.168.1.10" /></span>
				<span><label>Port</label><input name="h-port" value="22" /></span>
			</div>
			<label>Username</label><input name="h-user" value="root" />
			<label>Password (leave blank when editing = keep current)</label><input name="h-pass" type="password" autocomplete="off" />
			<label>Private key (PEM, optional)</label><textarea name="h-key" rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
			<div class="hint">Credentials stay on this machine (ssh-hosts.json) and are never uploaded. Use either a password or a private key.</div>
			<div class="btns"><button class="cancel">Cancel</button><button class="primary save-host">Save</button></div>
		</div>
	</div>
</div>`;

		const root = container.querySelector(".vsc");
		const treeEl = root.querySelector(".vsc-tree");
		const hostsEl = root.querySelector(".vsc-hosts");
		const sshTreeEl = root.querySelector(".vsc-sshtree");
		const tabsEl = root.querySelector(".vsc-tabs");
		const edHost = root.querySelector(".vsc-editor");
		const emptyEl = root.querySelector(".vsc-empty");
		const stScope = root.querySelector(".vsc-scope");
		const stPath = root.querySelector(".vsc-path");
		const stLang = root.querySelector(".vsc-lang");
		const stPos = root.querySelector(".vsc-pos");
		const stState = root.querySelector(".vsc-state");
		const quick = root.querySelector(".vsc-quickopen");
		const quickInput = quick.querySelector("input");
		const quickList = quick.querySelector("ul");
		const menuEl = root.querySelector(".vsc-menu");
		const syncStatusEl = root.querySelector(".vsc-sync-status");
		const syncBg = root.querySelector(".vsc-modal-bg:not(.vsc-host-bg)");
		const hostBg = root.querySelector(".vsc-host-bg");
		const dragEl = root.querySelector(".vsc-termdrag");
		const panelEl = root.querySelector(".vsc-termpanel");
		const termTabsEl = root.querySelector(".vsc-termbar .tts");
		const termAreaEl = root.querySelector(".vsc-termarea");

		// ---- request/response -------------------------------------------------------
		const pending = new Map(); // reqId → {resolve}
		function request(payload) {
			const reqId = `r${++reqSeq}`;
			return new Promise((resolve) => {
				pending.set(reqId, resolve);
				ctx.send({ ...payload, reqId });
				setTimeout(() => {
					if (pending.delete(reqId)) resolve({ ok: false, error: "Request timed out" });
				}, 60000);
			});
		}
		/** scope routing: remote (connId) auto-attaches connId, otherwise send as-is */
		function req(scope, payload) {
			return scope === "local" ? request(payload) : request({ connId: scope, ...payload });
		}

		function toast(text) {
			root.dispatchEvent(new CustomEvent("vsc-toast", { detail: text, bubbles: true }));
			stState.textContent = text;
			stState.classList.add("vsc-err");
			setTimeout(() => { stState.textContent = ""; stState.classList.remove("vsc-err"); }, 4000);
		}

		// ---- State ------------------------------------------------------------
		let S = { depsReady: true, depsInstalling: false, hosts: [], conns: [] }; // server broadcast
		const conns = new Map(); // connId → { label, cwd }
		const connecting = new Set(); // hostId currently connecting
		const expanded = new Set(["local:"]); // expanded directories (scope:path)
		const dirCache = new Map(); // `${scope}:${dir}` → entries
		const flatFiles = new Set(); // local file paths (Ctrl+P data source)
		const tabs = new Map(); // tabKey → {scope, path, name, savedText, binary, dirty, crlf}
		let activeTk = null;
		let selNode = null; // last clicked node {scope, path, type} — highlight + New file/folder target

		const tkey = (scope, p) => `${scope}:${p}`;
		function parseTk(k) {
			const i = k.indexOf(":");
			return { scope: k.slice(0, i), path: k.slice(i + 1) };
		}
		function connMeta(connId) {
			return S.conns.find((x) => x.connId === connId);
		}
		function connOfHost(hostId) {
			for (const id of conns.keys()) {
				if (connMeta(id)?.hostId === hostId) return id;
			}
			return null;
		}
		function connLabel(connId) {
			return conns.get(connId)?.label ?? connMeta(connId)?.label ?? connId;
		}

		/** Apply host state (initial fetch or broadcast); also adopt connections the server still holds —
		 *  so the remote tree is visible after a refresh without reconnecting */
		function applyState(next) {
			S = next ?? S;
			for (const c of S.conns) {
				if (c.status === "connected" && !conns.has(c.connId)) {
					conns.set(c.connId, { label: c.label, cwd: "/" });
				}
			}
			void renderTree();
			renderHosts();
		}

		// ---- Editor ----------------------------------------------------------
		const langComp = new Compartment();

		function makeExtensions() {
			return [
				lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(),
				history(), foldGutter(), drawSelection(), dropCursor(),
				EditorState.allowMultipleSelections.of(true),
				indentOnInput(), indentUnit.of("    "), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
				bracketMatching(), closeBrackets(), autocompletion(), rectangularSelection(),
				crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
				keymap.of([
					...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap,
					...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap,
					indentWithTab,
					// highest priority: Ctrl+S / Ctrl+P inside the editor are not eaten by the default keymap
					Prec.highest(keymap.of([
						{ key: "Mod-s", run: () => { void saveActive(); return true; } },
						{ key: "Mod-p", run: () => { openQuickOpen(); return true; } },
					])),
				]),
				langComp.of(langFor(parseTk(activeTk ?? "local:")?.path ?? "") ?? []),
				oneDark,
				EditorView.updateListener.of((u) => {
					if (u.docChanged || u.selectionSet) updateStatus(u.state);
					if (u.docChanged) {
						// Event-driven dirty flag: only real edits mark dirty. Do not use "doc !== savedText" —
						// CodeMirror normalizes \r\n to \n internally, so a CRLF file just opened
						// would be falsely marked unsaved.
						const t = tabs.get(activeTk);
						if (t && !t.binary && !t.dirty) {
							t.dirty = true;
							renderTabs();
						}
					}
				}),
			];
		}

		const view = new EditorView({ state: EditorState.create({ extensions: makeExtensions() }), parent: edHost });

		function currentDoc() { return view.state.doc.toString(); }

		function updateStatus(state) {
			const head = state.selection.main.head;
			const line = state.doc.lineAt(head);
			stPos.textContent = `Ln ${line.number} · Col ${head - line.from + 1}`;
			if (activeTk) {
				const t = tabs.get(activeTk);
				stState.textContent = t?.binary ? "Binary (read-only)" : t?.dirty ? "Unsaved ●" : "Saved";
				stState.classList.toggle("dirty", !!t?.dirty);
			}
		}

		// ---- file tree render (local + remote multi-root) --------------------------------------
		async function ensureDir(scope, dirWire) {
			const key = tkey(scope, dirWire ?? "");
			if (!dirCache.has(key)) {
				const r = await req(scope, { action: "list", dir: dirWire ?? "" });
				if (!r.ok) { toast(`Failed to list directory:${r.error}`); return []; }
				dirCache.set(key, r.entries);
				if (scope === "local") { // Ctrl+P indexes local only
					for (const e of r.entries) {
						if (e.type === "file") flatFiles.add(dirWire ? `${dirWire}/${e.name}` : e.name);
					}
				}
			}
			return dirCache.get(key);
		}

		/** sidebar dual-tab switch: Files / SSH */
		function switchPane(name) {
			root.querySelectorAll(".vsc-stabs .stab").forEach((b) => b.classList.toggle("active", b.dataset.pane === name));
			root.querySelectorAll(".vsc-pane").forEach((p) => p.classList.toggle("vsc-hidden", p.dataset.pane !== name));
		}
		root.querySelector(".vsc-stabs").addEventListener("click", (ev) => {
			const b = ev.target.closest(".stab");
			if (b) switchPane(b.dataset.pane);
		});

		async function renderTree() {
			// Keep scroll position across re-renders — otherwise opening a file / a state broadcast jumps the tree to the top
			// and the user has to scroll back
			const st = treeEl.scrollTop;
			treeEl.innerHTML = "";
			// Files tab is local workspace only; remote trees live on the SSH tab (renderRemoteTrees)
			const lh = document.createElement("div");
			lh.className = "vsc-sect";
			lh.innerHTML = `<b>📁 Local workspace</b>`;
			treeEl.appendChild(lh);
			await renderDir("local", "", treeEl, 0);
			renderTreeHighlight();
			applySelHighlight();
			treeEl.scrollTop = st;
		}

		/** SSH tab: host list (status / connect·disconnect / terminal / edit / delete) */
		function renderHosts() {
			const st = hostsEl.scrollTop;
			hostsEl.innerHTML = "";
			const depsBtn = root.querySelector('.vsc-pane[data-pane="ssh"] button[data-act="deps"]');
			depsBtn.classList.toggle("vsc-hidden", Boolean(S.depsReady));
			depsBtn.title = S.depsInstalling ? "Installing deps…" : "Install ssh2";
			if (!S.depsReady && S.depsInstalling) {
				const d = document.createElement("div");
				d.className = "vsc-deps";
				d.textContent = "Installing deps…";
				hostsEl.appendChild(d);
			}
			if (!S.hosts.length) {
				const d = document.createElement("div");
				d.className = "vsc-deps";
				d.textContent = "No hosts yet — click ＋ above to add";
				hostsEl.appendChild(d);
			}
			for (const h of S.hosts) renderHostRow(h);
			hostsEl.scrollTop = st;
			void renderRemoteTrees(); // SSH tab lower half: remote trees of connected hosts
		}

		/** SSH tab lower half: remote tree per connected host (fully independent of the Files tab) */
		async function renderRemoteTrees() {
			const st = sshTreeEl.scrollTop;
			sshTreeEl.innerHTML = "";
			for (const [connId, c] of conns) {
				const sec = document.createElement("div");
				sec.className = "vsc-sect";
				sec.innerHTML = `<b>🖥 ${esc(c.label)}</b><span class="cwd" title="${esc(c.cwd)}">${esc(c.cwd)}</span>`;
				sshTreeEl.appendChild(sec);
				const sub = document.createElement("div");
				sshTreeEl.appendChild(sub);
				await renderConnTree(connId, sub);
			}
			if (!conns.size) {
				const d = document.createElement("div");
				d.className = "vsc-deps";
				d.textContent = "Remote files appear here after you connect a host";
				sshTreeEl.appendChild(d);
			}
			sshTreeEl.scrollTop = st;
			applySelHighlight();
		}

		function renderHostRow(h) {
			const connId = connOfHost(h.id);
			const row = document.createElement("div");
			row.className = "vsc-row vsc-hrow";
			row.dataset.host = h.id;
			const busy = connecting.has(h.id) || connMeta(connId)?.status === "connecting";
			const dotCls = busy ? "busy" : connId ? "on" : "";
			row.innerHTML = `<span class="dot ${dotCls}"></span>`
				+ `<span class="nm" title="${esc(h.username)}@${esc(h.host)}:${h.port}">${esc(h.name || h.host)}</span>`
				+ `<span class="ops">`
				+ (connId
					? '<button data-hop="term" title="New terminal">🖥</button><button data-hop="dis" title="Disconnect">⏏</button>'
					: '<button data-hop="conn" title="Connect">⇄</button>')
				+ '<button data-hop="edit" title="Edit">✎</button>'
				+ '<button data-hop="del" title="Delete">🗑</button></span>';
			row.addEventListener("click", async (ev) => {
				const btn = ev.target.closest("button[data-hop]");
				if (btn) {
					ev.stopPropagation();
					if (btn.dataset.hop === "edit") openHostModal(h);
					else if (btn.dataset.hop === "del") {
						if (confirm(`Delete host "${h.name || h.host}"?`)) {
							const r = await request({ action: "hosts_delete", id: h.id });
							if (!r.ok) toast(`Delete failed:${r.error}`);
							else renderHosts();
						}
					} else if (btn.dataset.hop === "term" && connId) {
						showTermPanel();
						void newTerm(connId);
					} else if (btn.dataset.hop === "dis" && connId) {
						void request({ action: "disconnect", connId }); // conn_closed event does the cleanup
					} else if (btn.dataset.hop === "conn") void connectHost(h);
					return;
				}
				// click host row: connect if disconnected (remote tree appears below); open a terminal if already connected
				if (!connId) { await connectHost(h); return; }
				showTermPanel();
				void newTerm(connId);
			});
			hostsEl.appendChild(row);
		}

		/** connection subtree: root = probed home (cwd); if cwd ≠ / add a ".." row to go up */
		async function renderConnTree(connId, parentEl) {
			const c = conns.get(connId);
			if (!c) return;
			if (c.cwd && c.cwd !== "/") {
				const up = document.createElement("div");
				up.className = "vsc-row";
				up.style.paddingLeft = "22px";
				up.innerHTML = `<span class="caret"></span><span>⬆</span><span class="nm">..</span>`;
				up.addEventListener("click", async () => {
					c.cwd = parentOf(c.cwd);
					// only drop this connection's dir cache, not other hosts / local
					for (const key of [...dirCache.keys()]) {
						if (key.startsWith(`${connId}:`)) dirCache.delete(key);
					}
					renderHosts(); // redraw the SSH tab remote tree
				});
				parentEl.appendChild(up);
			}
			await renderDir(connId, c.cwd, parentEl, 1);
		}

		async function renderDir(scope, dirWire, parentEl, depth) {
			const entries = await ensureDir(scope, dirWire);
			await renderEntries(scope, entries, dirWire, parentEl, depth);
		}

		/** render one directory level as rows (shared by full redraw and in-place expand) */
		async function renderEntries(scope, entries, dirWire, parentEl, depth) {
			for (const e of entries) {
				const p = dirWire ? `${dirWire.replace(/\/$/, "")}/${e.name}` : e.name;
				const row = document.createElement("div");
				row.className = "vsc-row";
				row.style.paddingLeft = `${8 + depth * 14}px`;
				row.dataset.scope = scope;
				row.dataset.path = p;
				row.dataset.type = e.type;
				row.dataset.depth = depth;
				const ek = tkey(scope, p);
				const isOpen = expanded.has(ek);
				row.innerHTML = `<span class="caret">${e.type === "dir" ? (isOpen ? "▾" : "▸") : ""}</span>`
					+ `<span>${iconFor(e.name, e.type)}</span><span class="nm">${esc(e.name)}</span>`;
				row.addEventListener("click", async () => {
					selectNode(scope, p, e.type);
					if (e.type !== "dir") { void openFile(scope, p); return; }
					// in-place expand/collapse: only touch the sub-container under this row, do not redraw the whole tree —
					// clearing the whole tree innerHTML + a network round-trip makes other dirs flash away
					const caret = row.querySelector(".caret");
					if (expanded.has(ek)) {
						expanded.delete(ek);
						if (caret) caret.textContent = "▸";
						const sub = row.nextElementSibling;
						if (sub instanceof Element && sub.classList.contains("vsc-sub")) sub.remove();
					} else {
						expanded.add(ek);
						if (caret) caret.textContent = "▾";
						await expandDirInPlace(scope, p, row);
					}
				});
				row.addEventListener("contextmenu", (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					selectNode(scope, p, e.type); // right-click also selects: New in the menu uses this as the target
					showMenu(ev.clientX, ev.clientY, scope, p, e.type);
				});
				parentEl.appendChild(row);
				if (e.type === "dir" && isOpen) {
					const sub = document.createElement("div");
					sub.className = "vsc-sub";
					sub.dataset.loaded = "1";
					parentEl.appendChild(sub);
					await renderDir(scope, p, sub, depth + 1);
				}
			}
		}

		/** expand one directory in place: insert a .vsc-sub after this row and fill it, leave the rest of the tree alone */
		async function expandDirInPlace(scope, p, row) {
			const ek = tkey(scope, p);
			const depth = Number(row.dataset.depth ?? 0);
			let sub = row.nextElementSibling;
			if (!(sub instanceof Element && sub.classList.contains("vsc-sub"))) {
				sub = document.createElement("div");
				sub.className = "vsc-sub";
				sub.dataset.loaded = "0";
				row.insertAdjacentElement("afterend", sub);
			}
			sub.innerHTML = `<div class="vsc-row loading" style="padding-left:${8 + (depth + 1) * 14}px">`
				+ `<span class="caret"></span><span>⏳</span><span class="nm">Loading…</span></div>`;
			const entries = await ensureDir(scope, p);
			if (!expanded.has(ek)) { sub.remove(); return; } // user collapsed it while we were waiting
			sub.innerHTML = "";
			sub.dataset.loaded = "1";
			await renderEntries(scope, entries, p, sub, depth + 1);
			applySelHighlight(); // new rows pick up the selection highlight
		}

		/** select a node: highlight + decide where toolbar New file/folder lands */
		function selectNode(scope, pathW, type) {
			selNode = { scope, path: pathW, type };
			applySelHighlight();
		}

		/** Download to the user's computer (local or remote; base64 over WS → Blob save;
		 *  Chromium secure contexts prefer showSaveFilePicker for a chosen save location).
		 *  Remote folders are tar.gz-packed on the remote by the server, then sent back */
		async function downloadToPC(scope, pathW, isDir = false) {
			const name = pathW.split("/").filter(Boolean).pop() || pathW;
			toast(`Downloading ${name}${isDir ? " (packing)" : ""}…`);
			const payload = scope === "local"
				? { action: "download", path: pathW }
				: { action: "download", connId: scope, path: pathW };
			const r = await request(payload);
			if (!r.ok) { toast(`Download failed:${r.error}`); return; }
			const bin = atob(r.b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			saveBlob(new Blob([bytes]), r.name || (isDir ? `${name}.tar.gz` : name));
		}

		function saveBlob(blob, suggestedName) {
			if (window.showSaveFilePicker) {
				window.showSaveFilePicker({ suggestedName }).then(async (fh) => {
					const w = await fh.createWritable();
					await w.write(blob);
					await w.close();
					stState.textContent = `${suggestedName} saved`;
					setTimeout(() => { stState.textContent = ""; }, 3000);
				}).catch((e) => {
					if (e?.name === "AbortError") return; // user cancelling the save dialog is not an error
					fallbackAnchor();
				});
				return;
			}
			fallbackAnchor();
			function fallbackAnchor() {
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = suggestedName;
				a.click();
				setTimeout(() => URL.revokeObjectURL(url), 30_000);
			}
		}

		function applySelHighlight() {
			root.querySelectorAll(".vsc-row[data-scope]").forEach((el) =>
				el.classList.toggle("sel", !!selNode
					&& el.dataset.scope === selNode.scope && el.dataset.path === selNode.path));
		}

		function renderTreeHighlight() {
			treeEl.querySelectorAll(".vsc-row[data-path]").forEach((el) =>
				el.classList.toggle("active",
					activeTk === tkey(el.dataset.scope, el.dataset.path) && el.dataset.type === "file"));
		}

		// ---- Tabs ----------------------------------------------------------
		function renderTabs() {
			tabsEl.innerHTML = "";
			for (const [k, t] of tabs.entries()) {
				const el = document.createElement("div");
				el.className = "vsc-tab" + (k === activeTk ? " active" : "");
				el.innerHTML = `<span>${t.scope !== "local" ? "🖥" : iconFor(t.name, "file")}</span>`
					+ `<span class="tn">${esc(t.name)}</span>`
					+ (t.dirty ? '<span class="dot">●</span>' : "")
					+ `<button class="x" title="Close">✕</button>`;
				el.addEventListener("click", (ev) => {
					if (ev.target.closest(".x")) return;
					void activateTab(k);
				});
				el.querySelector(".x").addEventListener("click", () => void closeTab(k));
				tabsEl.appendChild(el);
			}
		}

		async function openFile(scope, p) {
			const k = tkey(scope, p);
			if (!tabs.has(k)) {
				const r = await req(scope, { action: "read", path: p });
				if (!r.ok) { toast(`Failed to open:${r.error}`); return; }
				tabs.set(k, {
					scope, path: p, name: p.split("/").pop(),
					savedText: r.text ?? "",
					binary: !!r.binary,
					dirty: false,
					crlf: (r.text ?? "").includes("\r\n"), // preserve original line endings and write them back on save
				});
				if (r.binary) toast("Binary files cannot be edited yet");
			}
			await activateTab(k);
		}

		async function activateTab(k) {
			const t = tabs.get(k);
			if (!t) return;
			activeTk = k;
			emptyEl.classList.add("vsc-hidden");
			edHost.classList.remove("vsc-hidden");
			view.setState(EditorState.create({
				doc: t.binary ? "" : t.savedText,
				extensions: makeExtensions(),
			}));
			t.dirty = false; // a freshly loaded document is always clean
			view.dispatch({ effects: langComp.reconfigure(langFor(t.path) ?? []) });
			stScope.textContent = t.scope !== "local" ? `🖥 ${connLabel(t.scope)}` : "Local";
			stScope.classList.toggle("remote", t.scope !== "local");
			stPath.textContent = t.path;
			stLang.textContent = langName(t.path);
			renderTabs();
			renderTreeHighlight();
			updateStatus(view.state);
			view.focus();
		}

		async function saveActive() {
			const t = tabs.get(activeTk);
			if (!activeTk || !t || t.binary) return false;
			const text = currentDoc();
			// write CRLF files back with original endings so the whole file is not rewritten as LF
			const wire = t.crlf ? text.replace(/\n/g, "\r\n") : text;
			const r = await req(t.scope, { action: "write", path: t.path, text: wire });
			if (!r.ok) { toast(`Save failed:${r.error}`); return true; }
			t.savedText = text;
			t.dirty = false;
			renderTabs();
			updateStatus(view.state);
			// refresh cache after saving the sync config file (server always reads the file; no dedicated reload)
			if (t.path === syncCfgPath) void refreshSyncCfg();
			// upload-on-save: if enabled and this is a local file → auto-sync to remote (vscode-sftp uploadOnSave)
			else if (syncCfgPub?.configured && syncCfgPub.uploadOnSave && t.scope === "local") {
				void runSync("up", "file", t.path);
			}
			return true;
		}

		async function closeTab(k) {
			const t = tabs.get(k);
			if (t && t.dirty && !confirm(`"${t.name}" has unsaved changes. Close anyway?`)) return;
			tabs.delete(k);
			if (activeTk === k) {
				activeTk = null;
				if (tabs.size) await activateTab([...tabs.keys()].pop());
				else {
					emptyEl.classList.remove("vsc-hidden");
					edHost.classList.add("vsc-hidden");
					stScope.textContent = "";
					stPath.textContent = "—"; stLang.textContent = ""; stPos.textContent = ""; stState.textContent = "";
					renderTabs();
				}
			} else renderTabs();
		}

		/** close every tab in a scope (used on disconnect; no confirm) */
		function closeTabsOfScope(scope) {
			for (const k of [...tabs.keys()]) {
				if (parseTk(k).scope === scope) tabs.delete(k);
			}
			if (activeTk && parseTk(activeTk).scope === scope) {
				activeTk = null;
				if (tabs.size) void activateTab([...tabs.keys()].pop());
				else {
					emptyEl.classList.remove("vsc-hidden");
					edHost.classList.add("vsc-hidden");
					stScope.textContent = "";
					stPath.textContent = "—"; stLang.textContent = ""; stPos.textContent = ""; stState.textContent = "";
				}
			}
			renderTabs();
		}

		/** Workspace switched (host app set_cwd → server broadcast): all local relative paths are stale —
		 *  clear dir cache / Ctrl+P index, close all local tabs (count dirty tabs so old-project
		 *  content is not saved into same-named paths in the new project); remote SSH tabs and connections are untouched. */
		async function applyWorkspace(newRoot) {
			dirCache.clear();
			flatFiles.clear();
			flatLoaded = false;
			for (const k of [...expanded]) {
				if (parseTk(k).scope === "local") expanded.delete(k); // old project's expanded state is all stale
			}
			if (selNode?.scope === "local") selNode = null; // New-file target from the old project is also stale
			let dirtyLost = 0;
			for (const [k, t] of tabs.entries()) {
				if (parseTk(k).scope === "local" && t.dirty) dirtyLost++;
			}
			closeTabsOfScope("local");
			await renderTree();
			toast(dirtyLost ? `Workspace switched${newRoot ? `: ${newRoot}` : ""} (closed ${dirtyLost} unsaved local tab(s))` : `Workspace switched${newRoot ? `: ${newRoot}` : ""}`);
			void refreshSyncCfg(); // .vscode/sftp.json is per-project; re-read sync config
		}

		// ---- quick-open (Ctrl+P, local only) ----------------------------------------
		let flatLoaded = false;
		async function loadFlat() {
			if (flatLoaded) return;
			const r = await request({ action: "flatlist" });
			if (r.ok) {
				flatLoaded = true;
				for (const f of r.files) flatFiles.add(f);
				if (r.truncated) toast("Many files; list was truncated");
			}
		}

		let quickSel = 0;
		function quickMatches() {
			const q = quickInput.value.trim();
			const all = [...flatFiles];
			if (!q) return all.slice(0, 100);
			return all
				.map((f) => ({ f, s: fuzzyScore(q, f.split("/").pop()) + fuzzyScore(q, f) * 0.3 }))
				.filter((x) => x.s >= 0)
				.sort((a, b) => b.s - a.s)
				.slice(0, 100)
				.map((x) => x.f);
		}

		function renderQuick() {
			const ms = quickMatches();
			quickSel = Math.min(quickSel, Math.max(0, ms.length - 1));
			quickList.innerHTML = ms.map((f, i) =>
				`<li data-p="${esc(f)}" class="${i === quickSel ? "sel" : ""}">`
				+ `${iconFor(f.split("/").pop(), "file")} ${f.split("/").pop()}<small>${esc(f)}</small></li>`).join("")
				|| `<li style="opacity:.5;cursor:default">No matching files</li>`;
		}

		function openQuickOpen() {
			void loadFlat().then(() => { quickSel = 0; renderQuick(); quick.classList.remove("vsc-hidden"); quickInput.focus(); quickInput.select(); });
		}

		function closeQuickOpen() { quick.classList.add("vsc-hidden"); }

		quickInput.addEventListener("input", () => { quickSel = 0; renderQuick(); });
		quickInput.addEventListener("keydown", (ev) => {
			const ms = quickMatches();
			if (ev.key === "Escape") { closeQuickOpen(); view.focus(); }
			else if (ev.key === "ArrowDown") { quickSel = Math.min(quickSel + 1, ms.length - 1); renderQuick(); ev.preventDefault(); }
			else if (ev.key === "ArrowUp") { quickSel = Math.max(quickSel - 1, 0); renderQuick(); ev.preventDefault(); }
			else if (ev.key === "Enter" && ms[quickSel]) { closeQuickOpen(); void openFile("local", ms[quickSel]); }
		});
		quickList.addEventListener("click", (ev) => {
			const li = ev.target.closest("li[data-p]");
			if (li) { closeQuickOpen(); void openFile("local", li.dataset.p); }
		});

		// ---- context menu (scope-aware) --------------------------------------------
		function parentOf(dir) {
			if (!dir || dir === "/" || dir === ".") return "/";
			const s = dir.replace(/\/$/, "");
			const idx = s.lastIndexOf("/");
			return idx <= 0 ? "/" : s.slice(0, idx);
		}

		function showMenu(x, y, scope, pathW, type) {
			menuEl.innerHTML = "";
			const items = [];
			if (type === "dir") {
				items.push(
					["New file", async () => { await promptCreate(scope, pathW, "file"); }],
					["New folder", async () => { await promptCreate(scope, pathW, "dir"); }],
				);
			}
			// sync items in the context menu (vscode-sftp style): local rows sync directly; remote rows resolve a relative path on click
			if (scope === "local") {
				if (type === "dir") items.push(
					["Upload this folder → remote", () => void runSync("up", "tree", pathW)],
					["Download remote → this folder", () => void runSync("down", "tree", pathW)],
				);
				else items.push(
					["Upload this file → remote", () => void runSync("up", "file", pathW)],
					["Download to disk", () => void downloadToPC(pathW)],
				);
			} else {
				// Remote is independent of the local workspace: only "Download to disk" (folders packed as tar.gz)
				items.push([type === "dir" ? "Download to disk (archive)" : "Download to disk",
					() => void downloadToPC(scope, pathW, type === "dir")]);
			}
			items.push(
				["Rename", async () => {
					const nn = prompt("New name:", pathW.split("/").pop());
					if (!nn || nn === pathW.split("/").pop()) return;
					const r = await req(scope, { action: "rename", path: pathW, newName: nn });
					if (!r.ok) { toast(`Rename failed:${r.error}`); return; }
					await invalidateScope(scope);
				}],
				["Delete", async () => {
					if (!confirm(`Delete "${pathW}"?${scope !== "local" && type === "dir" ? " (directory must be empty)" : " (cannot be undone)"}`)) return;
					const r = await req(scope, { action: "delete", path: pathW, isDir: type === "dir" });
					if (!r.ok) { toast(`Delete failed:${r.error}`); return; }
					// close tabs for the deleted file (or anything under it)
					for (const k of [...tabs.keys()]) {
						const { scope: s, path } = parseTk(k);
						if (s === scope && (path === pathW || path.startsWith(pathW + "/"))) void closeTab(k);
					}
					await invalidateScope(scope);
				}],
			);
			if (scope !== "local") {
				// open a remote terminal in the file's parent dir, or in the folder itself
				items.push([type === "dir" ? "Open terminal here" : "Open terminal in containing folder", async () => {
					const dir = type === "dir" ? pathW : parentOf(pathW);
					conns.get(scope).cwd = dir;
					showTermPanel();
					await newTerm(scope, dir);
				}]);
			}
			for (const [label, fn] of items) {
				const b = document.createElement("button");
				b.textContent = label;
				if (!fn) b.className = "dim";
				else b.addEventListener("click", () => { hideMenu(); void fn(); });
				menuEl.appendChild(b);
			}
			menuEl.classList.remove("vsc-hidden");
			// keep inside the container
			const rect = root.getBoundingClientRect();
			menuEl.style.left = `${Math.min(x - rect.left, rect.width - 170)}px`;
			menuEl.style.top = `${Math.min(y - rect.top, rect.height - items.length * 32 - 20)}px`;
		}
		function hideMenu() { menuEl.classList.add("vsc-hidden"); }
		document.addEventListener("click", hideMenu);

		/** after a structural change, drop cache and re-fetch; keepTabs content is left alone */
		async function invalidateScope(scope) {
			for (const key of [...dirCache.keys()]) {
				if (key.startsWith(`${scope}:`)) dirCache.delete(key);
			}
			if (scope === "local") { flatFiles.clear(); flatLoaded = false; }
			await renderTree();
			renderHosts(); // also refresh the remote tree (invalidateScope may be triggered by a remote op)
		}

		async function promptCreate(scope, dirWire, kind) {
			const name = prompt(kind === "dir" ? "New folder name:" : "New file name (subpaths like a/b.js ok):");
			if (!name) return;
			const p = dirWire ? `${dirWire.replace(/\/$/, "")}/${name.trim()}` : name.trim();
			const r = await req(scope, { action: "create", path: p, kind });
			if (!r.ok) { toast(`Create failed:${r.error}`); return; }
			expanded.add(tkey(scope, dirWire));
			selNode = { scope, path: p, type: kind }; // the new entry becomes the selection so later New lands next to / inside it
			if (kind === "file") void openFile(scope, p);
			await invalidateScope(scope);
		}

		/** full refresh: drop cache and re-fetch; reload open tabs from disk */
		async function refreshAll() {
			dirCache.clear();
			flatFiles.clear();
			flatLoaded = false;
			for (const [k, t] of tabs.entries()) {
				if (t.binary) continue;
				const r = await req(t.scope, { action: "read", path: t.path });
				if (r.ok && r.text != null) {
					t.savedText = r.text;
					t.crlf = r.text.includes("\r\n");
					t.dirty = false; // disk wins; discard unsaved edits
				}
			}
			if (activeTk && tabs.has(activeTk)) await activateTab(activeTk);
			await renderTree();
			renderTabs();
			renderHosts();
		}

		// ---- toolbar -----------------------------------------------------------
		root.querySelector(".vsc-side-head").addEventListener("click", (ev) => {
			const btn = ev.target.closest("button[data-act]");
			if (!btn) return;
			ev.stopPropagation(); // stop bubbling: otherwise the document "click anywhere to close menu" handler immediately hides the ☁ menu we just opened
			const act = btn.dataset.act;
			if (act === "refresh") { void refreshAll(); }
			else if (act === "new-file") { void promptCreate("local", pickLocalDir(), "file"); }
			else if (act === "new-dir") { void promptCreate("local", pickLocalDir(), "dir"); }
			else if (act === "sync-menu") {
				const rect = btn.getBoundingClientRect();
				showSyncMenu(rect.left, rect.bottom + 4);
			}
		});

		// ---- SSH host form -------------------------------------------------------
		let modalEditId = null;
		function openHostModal(h) {
			modalEditId = h?.id ?? null;
			hostBg.querySelector(".h-title").textContent = h ? "Edit host" : "New host";
			const q = (n) => hostBg.querySelector(`[name="${n}"]`);
			q("h-name").value = h?.name ?? "";
			q("h-host").value = h?.host ?? "";
			q("h-port").value = h?.port ?? 22;
			q("h-user").value = h?.username ?? "root";
			q("h-pass").value = "";
			q("h-key").value = "";
			q("h-pass").placeholder = h?.hasPass ? "Saved (leave blank to keep)" : "";
			q("h-key").placeholder = h?.hasKey ? "Saved (leave blank to keep)" : "-----BEGIN OPENSSH PRIVATE KEY-----";
			hostBg.classList.remove("vsc-hidden");
			q("h-host").focus();
		}
		hostBg.querySelector(".cancel").addEventListener("click", () => hostBg.classList.add("vsc-hidden"));
		hostBg.addEventListener("click", (ev) => { if (ev.target === hostBg) hostBg.classList.add("vsc-hidden"); });
		hostBg.querySelector(".save-host").addEventListener("click", async () => {
			const q = (n) => hostBg.querySelector(`[name="${n}"]`);
			const body = {
				name: q("h-name").value.trim(),
				host: q("h-host").value.trim(),
				port: Number(q("h-port").value) || 22,
				username: q("h-user").value.trim() || "root",
				password: q("h-pass").value || undefined,
				privateKey: q("h-key").value.trim() || undefined,
			};
			if (modalEditId) body.id = modalEditId;
			const r = await request({ action: "hosts_save", host: body });
			if (!r.ok) { toast(`Save failed:${r.error}`); return; }
			hostBg.classList.add("vsc-hidden");
		});

		/** connect a host and expand its tree (probe home as the start path) */
		async function connectHost(h) {
			if (connecting.has(h.id) || connOfHost(h.id)) return;
			connecting.add(h.id);
			renderTree();
			const r = await request({ action: "connect", id: h.id });
			connecting.delete(h.id);
			if (!r.ok) { toast(`Connection failed:${r.error}`); renderTree(); return; }
			let cwd = "/";
			const pwd = await request({ action: "exec", connId: r.connId, cmd: "pwd" });
			if (pwd.ok && pwd.exitCode === 0) {
				const home = pwd.output.trim().split(/\r?\n/).pop()?.trim();
				if (home?.startsWith("/")) cwd = home;
			}
			conns.set(r.connId, { label: r.label, cwd });
			lastConnId = r.connId;
			selNode = { scope: r.connId, path: cwd, type: "dir" }; // default target for toolbar ＋📄/＋📁
			renderHosts();
			await renderTree();
		}

		/** connection closed: drop connection state + tabs/terminals/cache for that scope */
		function handleConnClosed(connId, reason) {
			for (const [, t] of terms.entries()) {
				if (t.connId === connId) disposeTerm(t);
			}
			conns.delete(connId);
			closeTabsOfScope(connId);
			for (const key of [...dirCache.keys()]) {
				if (key.startsWith(`${connId}:`)) dirCache.delete(key);
			}
			if (lastConnId === connId) lastConnId = [...conns.keys()].pop() ?? null;
			if (selNode && selNode.scope === connId) selNode = null;
			renderTermTabs();
			syncPanelVisibility();
			void renderTree();
			renderHosts();
			if (reason) toast(`Disconnected:${connLabel(connId)} ${reason}`);
		}

		// ---- bottom terminal panel (multiple shells per host) ---------------------------------
		const terms = new Map(); // termId → {id, connId, shellId, label, n, term, fit, el, opened, dead}
		let syncCfgPub = null; // last redacted sync_get config (for uploadOnSave / remoteRoot checks)
		let syncCfgPath = ".vscode/sftp.json";

		/** refresh sync-config cache (server always reads .vscode/sftp.json; save applies immediately) */
		async function refreshSyncCfg() {
			const r = await request({ action: "sync_get" });
			if (r.ok) {
				syncCfgPub = r.config;
				syncCfgPath = r.configPath ?? syncCfgPath;
			}
			return r;
		}
		let termSeq = 0;
		let activeTermId = null;
		let lastConnId = null;
		let termH = 240;
		const inputQueue = new Map(); // buffer input until shellId is ready

		function pickConnId() {
			const t = tabs.get(activeTk);
			if (t && t.scope !== "local" && conns.has(t.scope)) return t.scope;
			if (lastConnId && conns.has(lastConnId)) return lastConnId;
			return [...conns.keys()][0] ?? null;
		}

		function showTermPanel() {
			panelEl.classList.remove("vsc-hidden");
			dragEl.classList.remove("vsc-hidden");
			panelEl.style.height = `${termH}px`;
		}
		function hideTermPanel() {
			panelEl.classList.add("vsc-hidden");
			dragEl.classList.add("vsc-hidden");
		}
		function syncPanelVisibility() {
			if (terms.size) showTermPanel(); else hideTermPanel();
		}

		async function newTerm(connId, startCwd) {
			connId = connId ?? pickConnId();
			if (!connId || !conns.has(connId)) { toast("Connect an SSH host first (click a host name on the left)"); return; }
			const sameConn = [...terms.values()].filter((t) => t.connId === connId).length;
			const t = {
				id: `t${++termSeq}`, connId, shellId: null,
				label: connLabel(connId), n: sameConn + 1, dead: false,
				term: null, fit: null, el: null, opened: false,
			};
			terms.set(t.id, t);
			showTermPanel();
			t.el = document.createElement("div");
			t.el.className = "vsc-term";
			termAreaEl.appendChild(t.el);
			const term = new Terminal({
				fontFamily: 'ui-monospace, Consolas, "Cascadia Mono", monospace',
				fontSize: 13,
				cursorBlink: true,
				theme: {
					background: "#101016", foreground: "#e6e6ef",
					cursor: "#7c5cff", selectionBackground: "#7c5cff44",
				},
			});
			const fit = new FitAddon();
			term.loadAddon(fit);
			t.term = term;
			t.fit = fit;
			term.open(t.el);
			try { fit.fit(); } catch {}
			term.onData((d) => {
				if (t.dead) return;
				if (t.shellId) ctx.send({ action: "shell_input", connId: t.connId, shellId: t.shellId, b64: b64.enc(d) });
				else {
					if (!inputQueue.has(t.id)) inputQueue.set(t.id, []);
					inputQueue.get(t.id).push(d);
				}
			});
			setActiveTerm(t.id);
			const r = await request({
				action: "shell_open", connId: t.connId,
				cols: term.cols, rows: term.rows,
			});
			if (!r.ok) {
				toast(`Failed to open terminal:${r.error}`);
				disposeTerm(t);
				renderTermTabs();
				syncPanelVisibility();
				return;
			}
			t.shellId = r.shellId;
			// replay keystrokes typed before the shell was ready
			const queued = inputQueue.get(t.id);
			if (queued?.length && !t.dead) {
				ctx.send({ action: "shell_input", connId: t.connId, shellId: t.shellId, b64: b64.enc(queued.join("")) });
			}
			inputQueue.delete(t.id);
			// start directory: after the shell is ready, send a cd (same as typing it)
			if (startCwd && !t.dead) {
				ctx.send({ action: "shell_input", connId: t.connId, shellId: t.shellId, b64: b64.enc(`cd ${shQuote(startCwd)}\n`) });
			}
			term.focus();
		}

		function setActiveTerm(id) {
			activeTermId = id;
			for (const [tid, t] of terms.entries()) {
				t.el.classList.toggle("vsc-hidden", tid !== id);
				if (tid === id) requestAnimationFrame(() => { try { t.fit.fit(); } catch {} t.term?.focus(); });
			}
			renderTermTabs();
		}

		function renderTermTabs() {
			termTabsEl.innerHTML = "";
			for (const [tid, t] of terms.entries()) {
				const el = document.createElement("span");
				el.className = "vsc-ttab" + (tid === activeTermId ? " active" : "");
				el.innerHTML = `<span class="tn">🖥 ${esc(t.label)}${t.n > 1 ? ` ${t.n}` : ""}</span><button class="x" title="Close">✕</button>`;
				el.addEventListener("click", (ev) => {
					if (ev.target.closest(".x")) { killTerm(t); return; }
					setActiveTerm(tid);
				});
				termTabsEl.appendChild(el);
			}
		}

		function killTerm(t) {
			if (t.shellId) void request({ action: "shell_close", connId: t.connId, shellId: t.shellId });
			disposeTerm(t);
			if (activeTermId === t.id) {
				activeTermId = null;
				const rest = [...terms.keys()];
				if (rest.length) setActiveTerm(rest[rest.length - 1]);
			}
			renderTermTabs();
			syncPanelVisibility();
		}

		function disposeTerm(t) {
			t.dead = true;
			try { t.ro?.disconnect(); } catch {}
			try { t.term?.dispose(); } catch {}
			try { t.el?.remove(); } catch {}
			terms.delete(t.id);
		}

		root.querySelector(".vsc-termbar .t-add").addEventListener("click", () => void newTerm());
		root.querySelector(".vsc-termbar .t-hide").addEventListener("click", hideTermPanel);

		// panel height drag
		dragEl.addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			const startY = ev.clientY;
			const startH = panelEl.getBoundingClientRect().height;
			const maxH = Math.max(120, root.getBoundingClientRect().height * 0.7);
			const onMove = (e) => {
				termH = Math.round(Math.min(Math.max(startH + (startY - e.clientY), 80), maxH));
				panelEl.style.height = `${termH}px`;
				for (const [, t] of terms.entries()) { try { t.fit.fit(); } catch {} }
			};
			const onUp = () => {
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
			};
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		});

		// ---- SFTP sync (local workspace ↔ remote directory, directional overwrite) ------------------------
		function showSyncMenu(x, y) {
			menuEl.innerHTML = "";
			const at = tabs.get(activeTk);
			const items = [
				["Sync config…", () => void openSyncModal()],
				["Edit config file (.vscode/sftp.json)", () => void openConfigFile()],
				["Upload all (local → remote)", () => void runSync("up", "all", "")],
				["Download all (remote → local)", () => void runSync("down", "all", "")],
				[at && at.scope === "local" && !at.binary ? `Upload current file (${at.name})` : "Upload current file (open a local file first)",
					at && at.scope === "local" && !at.binary ? () => void runSync("up", "file", at.path) : null],
			];
			for (const [label, fn] of items) {
				const b = document.createElement("button");
				b.textContent = label;
				if (!fn) b.className = "dim";
				else b.addEventListener("click", () => { hideMenu(); fn(); });
				menuEl.appendChild(b);
			}
			menuEl.classList.remove("vsc-hidden");
			const rect = root.getBoundingClientRect();
			menuEl.style.left = `${Math.min(x - rect.left, rect.width - 200)}px`;
			menuEl.style.top = `${Math.min(y - rect.top, rect.height - items.length * 32 - 20)}px`;
		}

		function showSyncProgress(text) {
			syncStatusEl.textContent = text;
			syncStatusEl.classList.remove("vsc-hidden");
		}
		function hideSyncProgressSoon() {
			setTimeout(() => syncStatusEl.classList.add("vsc-hidden"), 2500);
		}

		/** Open .vscode/sftp.json: write a template/migrate if missing, then edit in the editor; Ctrl+S applies */
		async function openConfigFile() {
			const r = await request({ action: "sync_ensure" });
			if (!r.ok) { toast(`Failed to open config:${r.error}`); return; }
			void refreshSyncCfg();
			void openFile("local", r.path);
		}

		async function runSync(dir, scope, path) {
			showSyncProgress(dir === "up" ? "Uploading…" : "Downloading…");
			const r = await request({ action: "sync_run", dir, scope, path });
			if (!r.ok) { showSyncProgress(`Sync failed:${r.error}`); hideSyncProgressSoon(); return; }
			const bad = r.failed?.length ?? 0;
			showSyncProgress(`${dir === "up" ? "Upload" : "Download"} done: ${r.total - bad}/${r.total}${bad ? ` (${bad} failed)` : ""}`);
			hideSyncProgressSoon();
			if (dir === "down") void refreshAll();
		}

		async function openSyncModal() {
			const q = (n) => syncBg.querySelector(`[name="${n}"]`);
			const r = await request({ action: "sync_get" });
			const cfg = r.ok ? r.config : {};
			q("s-name").value = cfg.name ?? "";
			q("s-host").value = cfg.host ?? "";
			q("s-user").value = cfg.username ?? "root";
			q("s-port").value = cfg.port ?? 22;
			q("s-pass").value = "";
			q("s-key").value = "";
			q("s-keypath").value = cfg.privateKeyPath ?? "";
			q("s-agent").value = cfg.agent ?? "";
			q("s-root").value = cfg.remoteRoot ?? "";
			q("s-exclude").value = (cfg.exclude ?? []).join(", ");
			q("s-autosave").checked = Boolean(cfg.uploadOnSave);
			q("s-pass").placeholder = cfg.hasPass ? "Saved (leave blank to keep)" : "";
			q("s-keypath").placeholder = cfg.hasKey ? "Saved (leave blank to keep)" : "~/.ssh/id_rsa";
			syncBg.classList.remove("vsc-hidden");
		}
		syncBg.querySelector(".cancel").addEventListener("click", () => syncBg.classList.add("vsc-hidden"));
		syncBg.querySelector(".test").addEventListener("click", async () => {
			const r = await request({ action: "sync_test" });
			toast(r.ok ? "Connected ✓" : `Connection failed:${r.error}`);
		});
		syncBg.querySelector(".save-cfg").addEventListener("click", async () => {
			const q = (n) => syncBg.querySelector(`[name="${n}"]`);
			const body = {
				name: q("s-name").value.trim(),
				host: q("s-host").value.trim(),
				port: Number(q("s-port").value) || 22,
				username: q("s-user").value.trim() || "root",
				password: q("s-pass").value || undefined,
				privateKey: q("s-key").value.trim() || undefined,
				privateKeyPath: q("s-keypath").value.trim(),
				agent: q("s-agent").value.trim(),
				remoteRoot: q("s-root").value.trim(),
				exclude: q("s-exclude").value.split(",").map((s) => s.trim()).filter(Boolean),
				uploadOnSave: q("s-autosave").checked,
			};
			const r = await request({ action: "sync_save", config: body });
			if (!r.ok) { toast(`Save failed:${r.error}`); return; }
			void refreshSyncCfg(); // refresh cache (uploadOnSave etc. take effect immediately)
			syncBg.classList.add("vsc-hidden");
			toast("Saved to .vscode/sftp.json");
		});

		// ---- server event dispatch -------------------------------------------------------
		const offData = ctx.onData((payload) => {
			if (!payload) return;
			if (payload.res && pending.has(payload.reqId)) {
				const p = pending.get(payload.reqId);
				pending.delete(payload.reqId);
				p(payload);
				return;
			}
			// guard: responses without reqId are silently dropped by the matcher above — requests must go through request()
			if (payload.res && !payload.reqId) {
				console.warn("[vscode-editor] got a response with no reqId (ignored); send requests via request():", payload.action);
			}
			if (payload.kind === "workspace") { // server workspace switch (host app set_cwd): rebuild tree + close local tabs
				void applyWorkspace(payload.root);
				return;
			}
			if (payload.kind === "state") { // host/connection list broadcast (credentials redacted)
				applyState(payload.state);
				return;
			}
			switch (payload.event) {
				case "shell_data": {
					for (const [, t] of terms.entries()) {
						if (t.connId === payload.connId && t.shellId === payload.shellId) {
							t.term?.write(b64.bytes(payload.b64));
							break;
						}
					}
					break;
				}
				case "shell_exit": {
					for (const [, t] of terms.entries()) {
						if (t.connId === payload.connId && t.shellId === payload.shellId) {
							t.term?.write("\r\n\x1b[90m[shell exited]\x1b[0m\r\n");
							break;
						}
					}
					break;
				}
				case "conn_closed":
					handleConnClosed(payload.connId, payload.reason);
					break;
				case "sync_progress":
					showSyncProgress(`Syncing ${payload.done}/${payload.total}: ${payload.name ?? ""}`);
					break;
			}
		});

		// ---- global shortcuts ---------------------------------------------------------
		function onGlobalKey(ev) {
			if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "p") {
				ev.preventDefault();
				openQuickOpen();
			} else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
				ev.preventDefault();
				void saveActive();
			} else if (ev.key === "Escape") {
				if (!quick.classList.contains("vsc-hidden")) closeQuickOpen();
				if (!menuEl.classList.contains("vsc-hidden")) hideMenu();
			}
		}
		container.ownerDocument.addEventListener("keydown", onGlobalKey, true);

		// ---- Startup ----------------------------------------------------------------
		root.querySelector('.vsc-pane[data-pane="ssh"] .vsc-side-head').addEventListener("click", (ev) => {
			const btn = ev.target.closest("button[data-act]");
			if (!btn) return;
			ev.stopPropagation(); // same as above
			if (btn.dataset.act === "add-host") openHostModal(null);
			else if (btn.dataset.act === "deps") void request({ action: "deps_install" });
			else if (btn.dataset.act === "new-term") { showTermPanel(); void newTerm(); }
			else if (btn.dataset.act === "r-new-file" || btn.dataset.act === "r-new-dir") {
				const t = pickRemoteDir();
				if (t) void promptCreate(t.connId, t.dir, btn.dataset.act === "r-new-dir" ? "dir" : "file");
			}
			else if (btn.dataset.act === "r-refresh") { void refreshAll(); }
		});
		/** local toolbar (＋📄/＋📁) target: last selected local node (files use their parent dir), else workspace root */
		function pickLocalDir() {
			if (selNode?.scope === "local") return selNode.type === "dir" ? selNode.path : parentOf(selNode.path);
			return "";
		}

		/** SSH toolbar (＋📄/＋📁) target: last selected remote node (files use their parent dir), else first connected host's root */
		function pickRemoteDir() {
			if (selNode && selNode.scope !== "local" && conns.has(selNode.scope)) {
				return { connId: selNode.scope, dir: selNode.type === "dir" ? selNode.path : parentOf(selNode.path) };
			}
			const first = [...conns.keys()][0];
			if (!first) { toast("Connect an SSH host first"); return null; }
			return { connId: first, dir: conns.get(first).cwd };
		}

		switchPane("files");
		// initial fetch: must carry reqId on the response channel — responses without reqId are
		// dropped as "pending match failed", and they are not a kind:"state" broadcast, so nobody handles them
		void request({ action: "state" }).then((r) => {
			if (r.ok && r.state) applyState(r.state);
		});
		void refreshSyncCfg(); // sync-config cache (for uploadOnSave / remote-root mapping)
		void renderTree();
		renderHosts();

		return () => {
			container.ownerDocument.removeEventListener("keydown", onGlobalKey, true);
			document.removeEventListener("click", hideMenu);
			for (const [, t] of terms.entries()) {
				try { t.ro?.disconnect(); } catch {}
				try { t.term?.dispose(); } catch {}
			}
			terms.clear();
			offData();
			view.destroy();
			root.remove();
		};
	},
};
