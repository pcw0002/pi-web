/**
 * db-client plugin client view — database connection manager / browser.
 *
 * Layout: connection list on the left (status dot / New / Edit / Test / Delete), workspace on the right:
 * - SQL (mysql/postgres/sqlite/sqlserver): database dropdown → table tree (filterable) →
 *   Data paginated grid (click column headers to sort) | Schema Columns/Indexes/DDL | SQL query editor (Ctrl+Enter)
 * - MongoDB: collection tree → Data document list (JSON filter) | Schema Indexes
 * - Redis: key-pattern scan list → value detail (TTL/size/content) + raw command line
 *
 * Protocol is in index.mjs: {action, reqId} uplink; responses match reqId;
 * event:"conn_closed" is sent to the creator; kind:"state" is broadcast (credentials redacted).
 */

function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
	));
}

let reqSeq = 0;

export default {
	mount(container, ctx) {
		container.innerHTML = `
<div class="dbx">
	<style>
		.dbx { display: flex; height: 100%; min-height: 480px; font-size: 13px; color: var(--text, #e6e6ef); }
		.dbx .hidden { display: none !important; }
		/* ---- Left connection rail ---- */
		.dbx-side { width: 230px; min-width: 170px; flex-shrink: 0; display: flex; flex-direction: column;
			border-right: 1px solid var(--border, #333); background: var(--bg-elev1, #16161d); overflow: hidden; }
		.dbx-side-head { display: flex; align-items: center; padding: 9px 10px 6px; font-size: 11px;
			letter-spacing: .08em; text-transform: uppercase; opacity: .85; }
		.dbx-side-head b { flex: 1; font-weight: 600; }
		.dbx-side-head button { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
		.dbx-side-head button:hover { background: var(--bg-elev2, #20202b); }
		.dbx-conns { flex: 1; overflow: auto; padding-bottom: 8px; user-select: none; }
		.dbx-crow { display: flex; align-items: center; gap: 7px; padding: 7px 10px; cursor: pointer; white-space: nowrap; }
		.dbx-crow:hover { background: var(--bg-elev2, #20202b); }
		.dbx-crow.active { background: color-mix(in srgb, var(--accent, #7c5cff) 20%, transparent); }
		.dbx-crow .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--text-dim, #666); }
		.dbx-crow .dot.on { background: var(--green, #4ade80); box-shadow: 0 0 6px var(--green, #4ade80); }
		.dbx-crow .info { flex: 1; min-width: 0; overflow: hidden; }
		.dbx-crow .nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
		.dbx-crow .addr { font-size: 11px; opacity: .55; overflow: hidden; text-overflow: ellipsis; }
		.dbx-crow .ops { display: none; gap: 2px; }
		.dbx-crow:hover .ops { display: flex; }
		.dbx-crow .ops button { all: unset; cursor: pointer; padding: 1px 4px; border-radius: 4px; font-size: 11px; opacity: .7; }
		.dbx-crow .ops button:hover { opacity: 1; background: var(--bg-elev3, #2a2a38); }
		.dbx-empty { padding: 18px 14px; opacity: .5; line-height: 1.9; text-align: center; }
		.dbx-deps button { all: unset; display: block; width: 100%; box-sizing: border-box; padding: 8px 12px; cursor: pointer;
			font-size: 12px; color: var(--amber, #fbbf24); }
		.dbx-deps button:disabled { cursor: wait; opacity: .6; }
		/* ---- right main pane ---- */
		.dbx-main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--bg-elev0, #101016); overflow: hidden; position: relative; }
		.dbx-placeholder { flex: 1; display: grid; place-items: center; opacity: .45; text-align: center; line-height: 2.1; }
		.dbx-work { display: flex; }
		.dbx-topbar { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--border, #333);
			background: var(--bg-elev1, #16161d); }
		.dbx-topbar .lbl { font-weight: 600; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.dbx-topbar select, .dbx-topbar button.act, .dbx button.btn { all: unset; cursor: pointer; padding: 3px 10px; border-radius: 6px;
			font-size: 12px; border: 1px solid var(--border, #444); color: inherit; }
		.dbx-topbar select { background: var(--bg-elev2, #20202b); padding-right: 4px; }
		.dbx-topbar button.act:hover, .dbx button.btn:hover { background: var(--bg-elev2, #20202b); }
		.dbx-topbar button.primary, .dbx button.primary { background: var(--accent, #7c5cff); border-color: transparent; color: #fff; }
		.dbx-tabs { display: flex; gap: 4px; margin-left: 8px; }
		.dbx-tab { all: unset; cursor: pointer; padding: 3px 12px; border-radius: 6px; font-size: 12.5px; opacity: .65; }
		.dbx-tab.active { background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent); opacity: 1; font-weight: 600; }
		.dbx-grow { flex: 1; }
		.dbx-body { flex: 1; min-height: 0; display: flex; }
		/* ---- Table tree ---- */
		.dbx-tree { width: 210px; min-width: 150px; flex-shrink: 0; display: flex; flex-direction: column;
			border-right: 1px solid var(--border, #333); }
		.dbx-tree input.filter { margin: 8px 8px 4px; box-sizing: border-box; background: var(--bg-elev2, #20202b); color: inherit;
			border: 1px solid var(--border, #333); border-radius: 6px; padding: 4px 8px; font: inherit; font-size: 12px; }
		.dbx-tables { flex: 1; overflow: auto; padding: 2px 4px 8px; user-select: none; }
		.dbx-trow { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 6px; cursor: pointer; white-space: nowrap; overflow: hidden; }
		.dbx-trow:hover { background: var(--bg-elev2, #20202b); }
		.dbx-trow.active { background: color-mix(in srgb, var(--accent, #7c5cff) 22%, transparent); }
		.dbx-trow .tn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
		.dbx-trow .cnt { font-size: 10.5px; opacity: .45; }
		.dbx-trow .badge { font-size: 9.5px; padding: 0 4px; border-radius: 3px; background: var(--bg-elev3, #2a2a38); opacity: .75; }
		.dbx-tree-empty { padding: 16px 12px; opacity: .45; text-align: center; line-height: 1.9; }
		/* ---- Content pane ---- */
		.dbx-content { flex: 1; min-width: 0; display: flex; flex-direction: column; }
		.pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
		.data-bar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--border, #333);
			font-size: 12px; flex-wrap: wrap; }
		.data-bar .tbl-lbl { font-family: ui-monospace, Consolas, monospace; font-weight: 600; }
		.data-bar .pginfo { opacity: .6; white-space: nowrap; }
		.data-bar input.docfilter { flex: 0 1 260px; min-width: 120px; background: var(--bg-elev2, #20202b); color: inherit;
			border: 1px solid var(--border, #333); border-radius: 6px; padding: 3px 8px; font: 12px ui-monospace, Consolas, monospace; }
		.grid-wrap { flex: 1; min-height: 0; overflow: auto; }
		table.dgrid { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 12.5px; }
		.dgrid th { position: sticky; top: 0; z-index: 2; background: var(--bg-elev1, #16161d); text-align: left;
			padding: 6px 10px; border-bottom: 1px solid var(--border, #444); white-space: nowrap;
			font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }
		th.sortable { cursor: pointer; user-select: none; }
		th.sortable:hover { background: var(--bg-elev2, #20202b); }
		.dgrid td { padding: 4px 10px; border-bottom: 1px solid color-mix(in srgb, var(--border, #333) 40%, transparent);
			max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
			font-family: ui-monospace, Consolas, monospace; }
		.dgrid tr:hover td { background: color-mix(in srgb, var(--accent, #7c5cff) 8%, transparent); }
		.dgrid td.isnull { color: var(--text-dim, #666); font-style: italic; }
		.grid-empty { padding: 26px; text-align: center; opacity: .45; }
		.status-line { padding: 5px 10px; font-size: 11.5px; opacity: .55; border-top: 1px solid var(--border, #333); }
		.err-text { color: var(--red, #f87171); }
		/* ---- Schema pane ---- */
		.pane-schema { overflow: auto; padding: 10px 12px; gap: 14px; }
		.pane-schema h4 { margin: 4px 0 6px; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; opacity: .6; }
		.pane-schema pre.ddl { margin: 0; padding: 10px 12px; background: var(--bg-elev2, #20202b); border: 1px solid var(--border, #333);
			border-radius: 8px; font: 12px/1.6 ui-monospace, Consolas, monospace; overflow: auto; white-space: pre; }
		/* ---- Query pane ---- */
		.query-bar { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-bottom: 1px solid var(--border, #333); }
		.query-bar .hint { font-size: 11px; opacity: .5; }
		textarea.sqlbox { height: 130px; flex-shrink: 0; resize: vertical; border: 0; outline: 0; background: transparent; color: inherit;
			font: 13px/1.55 ui-monospace, Consolas, "Cascadia Mono", monospace; padding: 10px 12px; tab-size: 2;
			border-bottom: 1px solid var(--border, #333); }
		.q-result { flex: 1; min-height: 0; overflow: auto; }
		/* ---- Schema tables ---- */
		table.mtable { width: 100%; border-collapse: collapse; font-size: 12.5px; }
		.mtable th { text-align: left; padding: 5px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
			opacity: .55; border-bottom: 1px solid var(--border, #444); }
		.mtable td { padding: 4px 10px; border-bottom: 1px solid color-mix(in srgb, var(--border, #333) 40%, transparent);
			font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
		.keytag { font-size: 10px; padding: 0 4px; border-radius: 3px; background: color-mix(in srgb, var(--amber, #fbbf24) 30%, transparent); }
		/* ---- Redis ---- */
		.redis-bar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--border, #333); flex-wrap: wrap; }
		.redis-bar input { background: var(--bg-elev2, #20202b); color: inherit; border: 1px solid var(--border, #333);
			border-radius: 6px; padding: 3px 8px; font: 12px ui-monospace, Consolas, monospace; }
		.redis-bar input.pattern { width: 200px; }
		.redis-bar input.cmdline { flex: 1; min-width: 160px; }
		.redis-meta { font-size: 11px; opacity: .55; white-space: nowrap; }
		.redis-split { flex: 1; min-height: 0; display: flex; }
		.keys-list { width: 280px; min-width: 180px; overflow: auto; border-right: 1px solid var(--border, #333); padding: 4px; user-select: none; }
		.krow { display: flex; gap: 6px; align-items: center; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
		.krow:hover { background: var(--bg-elev2, #20202b); }
		.krow.active { background: color-mix(in srgb, var(--accent, #7c5cff) 22%, transparent); }
		.krow .kn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
			font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
		.krow .kt { font-size: 9.5px; padding: 0 4px; border-radius: 3px; background: var(--bg-elev3, #2a2a38); opacity: .75; flex-shrink: 0; }
		.key-detail { flex: 1; min-width: 0; display: flex; flex-direction: column; }
		.key-detail .kd-head { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-bottom: 1px solid var(--border, #333);
			font-size: 12px; }
		.key-detail pre { flex: 1; margin: 0; overflow: auto; padding: 10px 12px;
			font: 12.5px/1.6 ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
		/* ---- Modal ---- */
		.dbx-modal-bg { position: absolute; inset: 0; z-index: 30; background: rgba(0,0,0,.45); display: grid; place-items: center; }
		.dbx-modal { width: min(460px, 92%); max-height: 92%; overflow: auto; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 12px; padding: 16px 18px; }
		.dbx-modal h3 { margin: 0 0 12px; }
		.dbx-modal label { display: block; font-size: 11.5px; opacity: .7; margin: 10px 0 4px; }
		.dbx-modal input, .dbx-modal select { width: 100%; box-sizing: border-box; background: var(--bg-elev0, #101016);
			color: inherit; border: 1px solid var(--border, #444); border-radius: 6px; padding: 6px 9px; font: inherit; }
		.dbx-modal .grid2 { display: grid; grid-template-columns: 1fr 110px; gap: 10px; }
		.dbx-modal .btns { display: flex; justify-content: space-between; gap: 8px; margin-top: 16px; }
		.dbx-modal .btns .right { display: flex; gap: 8px; }
		.dbx-modal .btns button { all: unset; cursor: pointer; padding: 6px 16px; border-radius: 7px; font-size: 13px;
			border: 1px solid var(--border, #444); color: inherit; }
		.dbx-modal .btns button.primary { background: var(--accent, #7c5cff); border-color: transparent; color: #fff; }
		.dbx-modal .btns button:hover { filter: brightness(1.15); }
		.dbx-modal .hint { font-size: 11px; opacity: .5; margin-top: 6px; line-height: 1.6; }
		.dbx-toast { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); z-index: 40;
			background: var(--bg-elev3, #2a2a38); border: 1px solid var(--border, #444); border-radius: 8px;
			padding: 6px 14px; font-size: 12.5px; max-width: 80%; transition: opacity .25s; }
		/* ---- Row edit ---- */
		.dgrid th.ops-th { width: 70px; }
		.dgrid td.ops-cell { white-space: nowrap; }
		.dgrid td.ops-cell button { all: unset; cursor: pointer; opacity: 0; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
		.dgrid tr:hover td.ops-cell button { opacity: .75; }
		.dgrid td.ops-cell button:hover { opacity: 1 !important; background: var(--bg-elev3, #2a2a38); }
		.dbx .inline-edit { width: 95%; box-sizing: border-box; background: var(--bg-elev0, #101016); color: inherit;
			border: 1px solid var(--accent, #7c5cff); border-radius: 4px; padding: 1px 5px;
			font: inherit; outline: 0; }
		.row-body textarea.jsonbox { width: 100%; box-sizing: border-box; min-height: 300px; resize: vertical;
			background: var(--bg-elev0, #101016); color: inherit; border: 1px solid var(--border, #444);
			border-radius: 6px; padding: 8px 10px; font: 12.5px/1.6 ui-monospace, Consolas, monospace; }
		.row-body .flds { display: grid; grid-template-columns: auto 1fr; gap: 8px 10px; align-items: center; max-height: 46vh; overflow: auto; }
		.row-body .flds label { margin: 0; font-family: ui-monospace, Consolas, monospace; }
		.row-body .flds label small { opacity: .5; display: block; font-size: 10px; }
		.kd-text { flex: 1; margin: 0; padding: 10px 12px; background: transparent; color: inherit; border: 0; outline: 0;
			resize: none; font: 12.5px/1.6 ui-monospace, Consolas, monospace; white-space: pre; }
	</style>
	<div class="dbx-side">
		<div class="dbx-side-head"><b>Database connections</b><button data-act="add" title="New connection">＋</button></div>
		<div class="dbx-deps"></div>
		<div class="dbx-conns"></div>
	</div>
	<div class="dbx-main">
		<div class="dbx-placeholder">👈 Select a connection on the left to open a database<br><small>schema browse · paginated data · structure · SQL</small></div>
		<div class="dbx-work hidden" style="flex-direction:column;flex:1;min-height:0">
			<div class="dbx-topbar">
				<span class="lbl"></span>
				<select class="db-sel" title="Select database"></select>
				<span class="dbx-tabs">
					<button class="dbx-tab" data-tab="data">Data</button>
					<button class="dbx-tab" data-tab="schema">Schema</button>
					<button class="dbx-tab" data-tab="query">SQL</button>
				</span>
				<span class="dbx-grow"></span>
				<button class="act btn-refresh" title="Refresh">⟳</button>
				<button class="act btn-disconnect">Disconnect</button>
			</div>
			<div class="dbx-body">
				<div class="dbx-tree">
					<input class="filter" placeholder="Filter names…" spellcheck="false" />
					<div class="dbx-tables"></div>
				</div>
				<div class="dbx-content">
					<div class="pane pane-data">
						<div class="data-bar">
							<span class="tbl-lbl"></span>
							<input class="docfilter hidden" placeholder='Filter JSON, e.g. {"age":{"$gt":18}}' spellcheck="false" />
							<button class="btn btn-filter hidden">Apply filter</button>
							<button class="btn btn-insert hidden">＋ Add</button>
							<span class="dbx-grow"></span>
							<button class="btn pg-first" title="First">⏮</button>
							<button class="btn pg-prev" title="Prev">◀</button>
							<span class="pginfo"></span>
							<button class="btn pg-next" title="Next">▶</button>
							<button class="btn pg-last" title="Last">⏭</button>
						</div>
						<div class="grid-wrap"><div class="grid-host"></div></div>
						<div class="status-line"></div>
					</div>
					<div class="pane pane-schema hidden">
						<h4>Columns</h4><div class="cols-host"></div>
						<h4>Indexes</h4><div class="idx-host"></div>
						<h4>DDL</h4><pre class="ddl"></pre>
					</div>
					<div class="pane pane-query hidden">
						<div class="query-bar">
							<button class="primary btn-run">▶ Run (Ctrl+Enter)</button>
							<span class="hint">Runs against the selected database; multiple statements return only the first result set</span>
							<span class="dbx-grow"></span>
							<span class="q-status"></span>
						</div>
						<textarea class="sqlbox" spellcheck="false" placeholder="SELECT * FROM mytable LIMIT 50"></textarea>
						<div class="q-result"><div class="q-grid-host"></div></div>
					</div>
					<div class="pane pane-redis hidden">
						<div class="redis-bar">
							<input class="pattern" value="*" spellcheck="false" />
							<button class="btn btn-scan">Scan</button>
							<span class="redis-meta"></span>
							<span class="dbx-grow"></span>
							<input class="cmdline" placeholder="Raw command, e.g. GET foo / KEYS *" spellcheck="false" />
							<button class="btn btn-cmd">Run</button>
						</div>
						<div class="redis-split">
							<div class="keys-list"></div>
							<div class="key-detail">
								<div class="kd-head"><span class="kd-name"></span><span class="kd-info"></span>
									<span class="dbx-grow"></span>
									<button class="btn btn-save-key hidden" title="Write back this string key">Save value</button>
									<button class="btn btn-del-key">Delete key</button></div>
								<pre class="kd-value">// Click a key on the left for details; the command line above runs any Redis command</pre>
								<textarea class="kd-text hidden" spellcheck="false"></textarea>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
		<div class="dbx-modal-bg rowmodal hidden">
			<div class="dbx-modal">
				<h3 class="row-title"></h3>
				<div class="row-body"></div>
				<div class="hint row-hint">Blank columns use the database default; type NULL (uppercase) to write SQL NULL.</div>
				<div class="btns"><span class="row-err err-text"></span>
					<span class="right"><button class="r-cancel">Cancel</button><button class="primary r-save">Save</button></span></div>
			</div>
		</div>
		<div class="dbx-modal-bg hidden">
			<div class="dbx-modal">
				<h3 class="m-title">New connection</h3>
				<label>Name (optional)</label><input name="name" placeholder="local-dev" />
				<label>Type *</label>
				<select name="type">
					<option value="mysql">MySQL / MariaDB</option>
					<option value="postgres">PostgreSQL</option>
					<option value="sqlite">SQLite (file)</option>
					<option value="sqlserver">SQL Server</option>
					<option value="mongodb">MongoDB</option>
					<option value="redis">Redis</option>
				</select>
				<div class="grp-net">
					<div class="grid2">
						<span><label>host *</label><input name="host" placeholder="127.0.0.1" /></span>
						<span><label>Port</label><input name="port" placeholder="auto" /></span>
					</div>
					<div class="grid2">
						<span><label>Username</label><input name="user" autocomplete="off" /></span>
						<span><label>Password</label><input name="password" type="password" autocomplete="new-password" /></span>
					</div>
					<label>Default database (optional)</label><input name="database" autocomplete="off" />
				</div>
				<div class="grp-file">
					<label>Database file path *</label><input name="file" placeholder="/path/to/data.db" spellcheck="false" />
				</div>
				<div class="grp-uri">
					<label>Connection URI (optional; if set, host/port above are ignored)</label><input name="uri" placeholder="mongodb://user:pass@host:27017" spellcheck="false" />
				</div>
				<div class="grp-redis">
					<label>Logical DB number db (0-15, optional)</label><input name="redisDb" placeholder="0" />
				</div>
				<div class="hint">Config stays in the plugin directory on this machine (db-connections.json) and is never uploaded. Leave password blank when editing to keep it.</div>
				<div class="btns">
					<button class="btn-test">Test connection</button>
					<span class="right"><button class="m-cancel">Cancel</button><button class="primary m-save">Save</button></span>
				</div>
			</div>
		</div>
	</div>
</div>`;

		const root = container.querySelector(".dbx");
		const $ = (sel) => root.querySelector(sel);
		const connsEl = $(".dbx-conns");
		const depsEl = $(".dbx-deps");
		const phEl = $(".dbx-placeholder");
		const workEl = $(".dbx-work");
		const lblEl = $(".dbx-topbar .lbl");
		const dbSel = $(".db-sel");
		const tabsEl = $(".dbx-tabs");
		const treeEl = $(".dbx-tree");
		const filterInput = $(".dbx-tree input.filter");
		const tablesEl = $(".dbx-tables");
		const tblLbl = $(".tbl-lbl");
		const docFilterInput = $(".docfilter");
		const btnFilter = $(".btn-filter");
		const gridHost = $(".grid-host");
		const statusLine = $(".status-line");
		const schemaPane = $(".pane-schema");
		const colsHost = $(".cols-host");
		const idxHost = $(".idx-host");
		const ddlPre = $(".ddl");
		const queryPane = $(".pane-query");
		const sqlBox = $(".sqlbox");
		const qStatus = $(".q-status");
		const qGridHost = $(".q-grid-host");
		const redisPane = $(".pane-redis");
		const keysList = $(".keys-list");
		const kdName = $(".kd-name");
		const kdInfo = $(".kd-info");
		const kdValue = $(".kd-value");
		const modalBg = $(".dbx-modal-bg:not(.rowmodal)");
		const rowModalBg = $(".dbx-modal-bg.rowmodal");
		const rowTitle = $(".row-title");
		const rowBody = $(".row-body");
		const rowHint = $(".row-hint");
		const rowErr = $(".row-err");
		const kdText = $(".kd-text");
		const pgInfo = $(".pginfo");

		// ---- Global state --------------------------------------------------------
		let state = { depsOk: true, depsInstalling: false, conns: [], active: [], types: {} };
		let work = null; // current workspace: {connId, label, kind, dialect, dbs[], curDb, tables[], curTable, page:{no,size,total}, orderBy, dir}
		let activeTab = "data";
		let modalEditId = null;

		function toast(text, isErr) {
			root.querySelector(".dbx-toast")?.remove();
			if (!text) return;
			const t = document.createElement("div");
			t.className = "dbx-toast";
			if (isErr) t.style.color = "var(--red,#f87171)";
			t.textContent = text;
			root.appendChild(t);
			setTimeout(() => {
				t.style.opacity = "0";
				setTimeout(() => t.remove(), 300);
			}, 3600);
		}

		// ---- Request channel --------------------------------------------------------
		const pending = new Map();
		function request(payload) {
			const reqId = `r${++reqSeq}`;
			return new Promise((resolve) => {
				pending.set(reqId, resolve);
				ctx.send({ ...payload, reqId });
				setTimeout(() => { if (pending.delete(reqId)) resolve({ ok: false, error: "Request timed out" }); }, 45000);
			});
		}
		const offData = ctx.onData((p) => {
			if (!p) return;
			if (p.res && pending.has(p.reqId)) {
				pending.get(p.reqId)(p);
				pending.delete(p.reqId);
				return;
			}
			// State sync accepts two shapes: broadcast {kind:"state", state} and
			// a directed response to a state request {res:true, action:"state", state}
			if (p.kind === "state" || (p.res && p.action === "state" && p.state)) {
				state = p.state;
				renderConns();
				renderDeps();
				syncActiveView();
				return;
			}
			if (p.event === "conn_closed") {
				toast(`Disconnected:${p.reason || p.connId}`, true);
				if (work && work.connId === p.connId) closeWork();
			}
		});

		// ---- Connection list --------------------------------------------------------
		function renderDeps() {
			depsEl.textContent = "";
			if (state.depsOk) return;
			const b = document.createElement("button");
			b.textContent = state.depsInstalling ? "Installing drivers…" : "⚠ Drivers not installed — click to install";
			b.disabled = Boolean(state.depsInstalling);
			b.addEventListener("click", () => void request({ action: "deps_install" }));
			depsEl.appendChild(b);
		}

		function renderConns() {
			connsEl.textContent = "";
			if (!state.conns.length) {
				connsEl.innerHTML = `<div class="dbx-empty">No connections yet<br>click ＋ at the top right</div>`;
				return;
			}
			for (const c of state.conns) {
				const isActive = Boolean(work) && state.active.some((a) => a.connId === work.connId && a.hostId === c.id);
				const row = document.createElement("div");
				row.className = "dbx-crow" + (isActive ? " active" : "");
				row.innerHTML = `<span class="dot ${isActive ? "on" : ""}"></span>`
					+ `<span class="info"><span class="nm">${esc(c.name)}</span>`
					+ `<span class="addr">${esc(connAddr(c))}</span></span>`
					+ `<span class="ops"><button data-op="edit" title="Edit">✎</button><button data-op="del" title="Delete">🗑</button></span>`;
				row.addEventListener("click", (ev) => {
					const btn = ev.target.closest("button[data-op]");
					if (!btn) return void openConn(c.id);
					ev.stopPropagation();
					if (btn.dataset.op === "edit") openModal(c);
					else if (confirm(`Delete connection "${c.name}"?`)) void request({ action: "conns_delete", id: c.id });
				});
				connsEl.appendChild(row);
			}
		}

		function connAddr(c) {
			if (c.type === "sqlite") return `${c.file}`;
			let a = `${c.host}:${c.port}`;
			if (c.database) a += `/${c.database}`;
			if (c.user) a = `${c.user}@${a}`;
			return a;
		}

		async function openConn(hostId) {
			// Missing drivers: the server reports a friendly error (by type); do not gate here
			const r = await request({ action: "connect", id: hostId });
			if (!r.ok) { toast(`Connection failed:${r.error}`, true); return; }
			setupWork(r.connId, r.label, r.kind, r.dialect);
		}

		function closeWork() {
			work = null;
			workEl.classList.add("hidden");
			phEl.classList.remove("hidden");
			renderConns();
		}

		// ---- Workspace ----------------------------------------------------------
		async function setupWork(connId, label, kind, dialect) {
			work = {
				connId, label, kind, dialect,
				dbs: [], curDb: null,
				tables: [], curTable: null, curTableKind: null,
				page: { no: 0, size: 50, total: 0 },
				orderBy: null, dir: "asc",
				schema: null, pkCol: null, editable: false, docs: null,
			};
			lblEl.textContent = label;
			activeTab = "data";
			workEl.classList.remove("hidden");
			phEl.classList.add("hidden");
			// Pane visibility by kind
			treeEl.classList.toggle("hidden", kind === "redis");
			$(".pane-data").classList.toggle("hidden", kind === "redis");
			schemaPane.classList.add("hidden");
			queryPane.classList.add("hidden");
			redisPane.classList.toggle("hidden", kind !== "redis");
			tabsEl.querySelectorAll(".dbx-tab").forEach((t) => {
				const tab = t.dataset.tab;
				const visible = kind === "redis" ? false : !(tab === "query" && kind === "mongodb");
				t.classList.toggle("hidden", !visible);
			});
			docFilterInput.classList.toggle("hidden", kind !== "mongodb");
			btnFilter.classList.toggle("hidden", kind !== "mongodb");
			dbSel.classList.toggle("hidden", kind === "redis" || dialect === "sqlite");
			renderConns();
			setTab(kind === "redis" ? "redis" : "data");

			try {
				const r = await request({ action: "dbs_list", connId });
				if (!r.ok) throw new Error(r.error);
				work.dbs = r.databases;
				work.curDb = pickDefaultDb(r.databases);
			} catch (e) {
				toast(`Failed to list databases: ${e.message ?? e}`, true);
				work.dbs = []; work.curDb = null;
			}
			dbSel.innerHTML = work.dbs.map((d) => `<option${d === work.curDb ? " selected" : ""}>${esc(d)}</option>`).join("");
			if (kind === "redis") { void redisScan("*"); void refreshRedisMeta(); return; }
			await refreshTables();
		}

		function pickDefaultDb(dbs) {
			const cfgConn = state.conns.find((c) => state.active.some((a) => a.hostId === c.id && a.connId === work.connId));
			const preferred = cfgConn?.database;
			if (preferred && dbs.includes(preferred)) return preferred;
			for (const cand of ["main", "public", "master", "admin", "local", "dbo"]) {
				if (dbs.includes(cand)) return dbs.find((d) => d === cand);
			}
			return dbs[0] ?? null;
		}

		async function refreshTables() {
			if (!work) return;
			const r = await request({ action: "tables_list", connId: work.connId, db: work.curDb });
			if (!r.ok) { toast(`Failed to list tables: ${r.error}`, true); work.tables = []; }
			else work.tables = r.tables;
			renderTables();
			// Auto-select the first table
			if (!work.curTable && work.tables.length && work.kind !== "redis") selectTable(work.tables[0].name, work.tables[0].kind);
		}

		function renderTables() {
			const kw = filterInput.value.trim().toLowerCase();
			tablesEl.textContent = "";
			if (!work.tables.length) {
				tablesEl.innerHTML = `<div class="dbx-tree-empty">${work.kind === "mongodb" ? "No collections" : "No tables"}<br><small>click ⟳ to refresh</small></div>`;
				return;
			}
			for (const t of work.tables) {
				if (kw && !t.name.toLowerCase().includes(kw)) continue;
				const row = document.createElement("div");
				row.className = "dbx-trow" + (t.name === work.curTable ? " active" : "");
				row.innerHTML = `<span>${t.kind === "view" ? "👁" : t.kind === "collection" ? "📄" : "▤"}</span>`
					+ `<span class="tn" title="${esc(t.name)}">${esc(t.name)}</span>`
					+ (t.approxRows > 0 ? `<span class="cnt">${fmtCount(t.approxRows)}</span>` : "")
					+ (t.kind === "collection" ? '<span class="badge">coll</span>' : t.kind === "view" ? '<span class="badge">view</span>' : "");
				row.addEventListener("click", () => selectTable(t.name, t.kind));
				tablesEl.appendChild(row);
			}
		}

		function fmtCount(n) {
			n = Number(n);
			if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
			if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
			if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
			return String(n);
		}

		async function selectDb(db) {
			if (!work) return;
			work.curDb = db;
			work.curTable = null;
			work.page.no = 0;
			await refreshTables();
		}

		function setTab(tab) {
			activeTab = tab;
			tabsEl.querySelectorAll(".dbx-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
			$(".pane-data").classList.toggle("hidden", tab !== "data");
			schemaPane.classList.toggle("hidden", tab !== "schema");
			queryPane.classList.toggle("hidden", tab !== "query");
			redisPane.classList.toggle("hidden", tab !== "redis");
			if (!work) return;
			if (tab === "data") void loadData();
			else if (tab === "schema" && work.curTable) void loadSchema();
			else if (tab === "query") sqlBox.focus();
		}

		async function selectTable(name, kind) {
			if (!work) return;
			work.curTable = name;
			work.curTableKind = kind ?? "table";
			work.page = { no: 0, size: work.page.size, total: 0 };
			work.orderBy = null;
			work.dir = "asc";
			work.schema = null;
			work.pkCol = null;
			work.editable = false;
			work.docs = null;
			renderTables();
			tblLbl.textContent = `${work.curDb}.${name}`;
			kdName.textContent = "";
			setTab(activeTab === "redis" ? "data" : activeTab);
			if (activeTab === "schema") void loadSchema();
			else void loadData();
		}

		// ---- Data pane ----------------------------------------------------------
		async function loadData() {
			if (!work || !work.curTable || work.kind === "redis") return;
			statusLine.textContent = "Loading…";
			gridHost.textContent = "";
			const p = work.page;
			const r = await request({
				action: "page", connId: work.connId, db: work.curDb, table: work.curTable,
				offset: p.no * p.size, limit: p.size,
				orderBy: work.orderBy, dir: work.dir,
				filter: work.kind === "mongodb" ? docFilterInput.value : undefined,
			});
			if (!r.ok) {
				statusLine.innerHTML = `<span class="err-text">${esc(r.error)}</span>`;
				gridHost.innerHTML = "";
				return;
			}
			p.total = r.grid.total ?? r.grid.rows.length;
			work.docs = Array.isArray(r.grid.docs) ? r.grid.docs : null;
			work.editable = Boolean(r.grid.editable);
			work.pkCol = r.grid.pkCol ?? null;
			const canInsert = work.editable || (work.kind === "mongodb" && work.docs);
			$(".btn-insert").classList.toggle("hidden", !canInsert);
			$(".btn-insert").textContent = work.kind === "mongodb" ? "＋ New document" : "＋ New row";
			renderGrid(gridHost, r.grid.columns, r.grid.rows, work.kind, r.grid);
			const pages = Math.max(1, Math.ceil(p.total / p.size));
			pgInfo.textContent = `Page ${p.no + 1}/${pages}`;
			statusLine.textContent = `${work.curTable} · ${fmtCount(p.total)} rows`
				+ (r.grid.rows.length ? ` · ${r.grid.rows.length} on this page` : "");
			$(".pg-first").disabled = $(".pg-prev").disabled = p.no <= 0;
			$(".pg-next").disabled = $(".pg-last").disabled = p.no >= pages - 1;
		}

		function renderGrid(host, columns, rows, kind, grid = {}) {
			host.textContent = "";
			if (!columns.length || !rows.length) {
				host.innerHTML = `<div class="grid-empty">${columns.length ? "No data" : "No results"}</div>`;
				return;
			}
			const docs = Array.isArray(grid.docs) ? grid.docs : null;
			const pkCol = grid.pkCol ?? null;
			const pkIdx = pkCol ? columns.indexOf(pkCol) : -1;
			const canDel = kind === "mongodb" ? !!docs : Boolean(pkCol);
			const canEditCell = kind === "sql" && Boolean(pkCol);
			const tbl = document.createElement("table");
			tbl.className = "dgrid";
			const canSort = kind !== "mongodb" && kind !== "redis";
			tbl.innerHTML = "<thead><tr>"
				+ columns.map((c) => `<th class="${canSort ? "sortable" : ""}" data-col="${esc(c)}">${esc(c)}${work?.orderBy === c ? (work.dir === "desc" ? " ↓" : " ↑") : ""}</th>`).join("")
				+ (canDel ? '<th class="ops-th"></th>' : "")
				+ "</tr></thead>";
			if (canSort) {
				tbl.querySelector("thead").addEventListener("click", (ev) => {
					const th = ev.target.closest("th[data-col]");
					if (!th || !work) return;
					const col = th.dataset.col;
					if (work.orderBy === col) work.dir = work.dir === "asc" ? "desc" : "asc";
					else { work.orderBy = col; work.dir = "asc"; }
					work.page.no = 0;
					void loadData();
				});
			}
			const tb = document.createElement("tbody");
			rows.forEach((row) => {
				const tr = document.createElement("tr");
				tr.innerHTML = row.map((v, ci) => {
					const base = v === null
						? '<td class="isnull">NULL</td>'
						: `<td title="${esc(v)}">${esc(v)}</td>`;
					return canEditCell && ci !== pkIdx
						? base.replace("<td", `<td data-edit="1" data-col="${esc(columns[ci])}" data-pk="${esc(String(row[pkIdx] ?? ""))}"`)
						: base;
				}).join("")
					+ (canDel ? '<td class="ops-cell">'
						+ (kind === "mongodb" ? '<button data-op="docedit" title="Edit document">✎</button>' : "")
						+ '<button data-op="del" title="Delete">🗑</button></td>' : "");
				tb.appendChild(tr);
			});
			tbl.appendChild(tb);

			if (canEditCell) {
				tbl.addEventListener("dblclick", (ev) => {
					const td = ev.target.closest("td[data-edit]");
					if (!td || !work) return;
					startCellEdit(td, td.dataset.col, td.dataset.pk, td.textContent);
				});
			}
			if (canDel) {
				tbl.addEventListener("click", (ev) => {
					const btn = ev.target.closest("button[data-op]");
					if (!btn) return;
					void confirmDeleteRow(btn.closest("tr"));
				});
			}
			host.appendChild(tbl);
		}

		/** Double-click a cell → inline input; Enter commits / Esc or blur cancels */
		function startCellEdit(td, col, pkVal, orig) {
			if (td.querySelector(".inline-edit")) return;
			const input = document.createElement("input");
			input.className = "inline-edit";
			input.value = orig === "NULL" ? "" : orig;
			td.textContent = "";
			td.appendChild(input);
			input.focus();
			input.select();
			let done = false;
			const finish = (commit) => {
				if (done) return;
				done = true;
				const val = input.value;
				if (!commit || val === orig) { void loadData(); return; }
				void commitCell(col, pkVal, val === "NULL" ? null : val);
			};
			input.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
				else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
			});
			input.addEventListener("blur", () => finish(false));
		}

		async function commitCell(col, pkVal, val) {
			const r = await request({
				action: "row_update", connId: work.connId, db: work.curDb, table: work.curTable,
				pk: { col: work.pkCol, val: pkVal }, changes: { [col]: val },
			});
			r.ok ? (toast("Saved"), void loadData()) : toast(`Save failed:${r.error}`, true);
		}

		async function confirmDeleteRow(tr) {
			if (!work) return;
			let r;
			if (work.kind === "mongodb") {
				const idx = [...tr.parentNode.children].indexOf(tr);
				if (!confirm("Delete this document? Writes the database immediately and cannot be undone")) return;
				r = await request({ action: "doc_delete", connId: work.connId, db: work.curDb, table: work.curTable, id: work.docs?.[idx]?._id });
			} else {
				const pkCell = tr.querySelector("td[data-pk]");
				if (!pkCell) { toast("This table has no primary key, so the row cannot be located", true); return; }
				if (!confirm("Delete this row? Writes the database immediately and cannot be undone")) return;
				r = await request({ action: "row_delete", connId: work.connId, db: work.curDb, table: work.curTable, pk: { col: work.pkCol, val: pkCell.dataset.pk } });
			}
			r.ok ? void loadData() : toast(`Delete failed:${r.error}`, true);
		}

		/** New row / New document modal (one shared popup) */
		async function openInsertModal() {
			if (!work) return;
			rowErr.textContent = "";
			if (work.kind === "mongodb") { openDocModal("insert"); return; }
			if (!work.schema) {
				const r = await request({ action: "describe", connId: work.connId, db: work.curDb, table: work.curTable });
				if (!r.ok) { toast(`Failed to read schema: ${r.error}`, true); return; }
				work.schema = r.describe;
			}
			rowTitle.textContent = `New row · ${work.curTable}`;
			rowHint.classList.remove("hidden");
			// Auto-increment PK / sequence default columns need not be filled in
			const cols = work.schema.columns.filter((c) =>
				!(c.key === "PRI" && /int|serial/i.test(c.type)) && !(c.def && /nextval/i.test(c.def)));
			rowBody.innerHTML = `<div class="flds">${cols.map((c) =>
				`<label>${esc(c.name)}<small>${esc(c.type)}${c.nullable ? "" : " · not null"}</small></label>`
				+ `<input data-col="${esc(c.name)}" spellcheck="false" placeholder="${c.nullable ? "blank = default" : "required"}" />`).join("")}</div>`;
			rowModalBg.classList.remove("hidden");
			rowBody.querySelector("input")?.focus();
		}

		function openDocModal(mode, idx) {
			if (!work) return;
			rowErr.textContent = "";
			rowHint.classList.add("hidden");
			const doc = mode === "edit" ? work.docs?.[idx] ?? {} : {};
			rowTitle.textContent = `${mode === "edit" ? "Edit document" : "New document"} · ${work.curTable}`;
			rowBody.innerHTML = `<textarea class="jsonbox" spellcheck="false">${esc(JSON.stringify(doc, null, 2))}</textarea>`;
			rowModalBg.dataset.mode = mode;
			rowModalBg.dataset.idx = String(idx ?? "");
			rowModalBg.classList.remove("hidden");
			rowBody.querySelector("textarea")?.focus();
		}

		async function saveRowModal() {
			if (!work) return;
			rowErr.textContent = "";
			try {
				let r;
				if (work.kind === "mongodb") {
					const json = rowBody.querySelector(".jsonbox").value;
					const mode = rowModalBg.dataset.mode || "insert";
					r = mode === "edit"
						? await request({ action: "doc_save", connId: work.connId, db: work.curDb, table: work.curTable, id: work.docs?.[Number(rowModalBg.dataset.idx)]?._id, docJson: json })
						: await request({ action: "doc_insert", connId: work.connId, db: work.curDb, table: work.curTable, docJson: json });
				} else {
					const values = {};
					for (const inp of rowBody.querySelectorAll("input[data-col]")) {
						const v = inp.value.trim();
						if (v !== "") values[inp.dataset.col] = v === "NULL" ? null : v;
					}
					r = await request({ action: "row_insert", connId: work.connId, db: work.curDb, table: work.curTable, values });
				}
				if (!r.ok) { rowErr.textContent = r.error ?? "Save failed"; return; }
				rowModalBg.classList.add("hidden");
				toast("Saved");
				void loadData();
			} catch (e) {
				rowErr.textContent = String(e?.message ?? e);
			}
		}

		// Pagination buttons
		$(".pg-first").addEventListener("click", () => { work.page.no = 0; void loadData(); });
		$(".pg-prev").addEventListener("click", () => { if (work.page.no > 0) { work.page.no--; void loadData(); } });
		$(".pg-next").addEventListener("click", () => { work.page.no++; void loadData(); });
		$(".pg-last").addEventListener("click", () => {
			work.page.no = Math.max(0, Math.ceil(work.page.total / work.page.size) - 1);
			void loadData();
		});
		btnFilter.addEventListener("click", () => { work.page.no = 0; void loadData(); });
		$(".btn-insert").addEventListener("click", () => void openInsertModal());
		rowModalBg.querySelector(".r-cancel").addEventListener("click", () => rowModalBg.classList.add("hidden"));
		rowModalBg.addEventListener("click", (ev) => { if (ev.target === rowModalBg) rowModalBg.classList.add("hidden"); });
		rowModalBg.querySelector(".r-save").addEventListener("click", () => void saveRowModal());
		$(".btn-save-key").addEventListener("click", () => void saveKeyValue());
		docFilterInput.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") { work.page.no = 0; void loadData(); }
		});

		// ---- Schema pane ----------------------------------------------------------
		async function loadSchema() {
			if (!work || !work.curTable) { ddlPre.textContent = "// Select a table on the left first"; return; }
			colsHost.innerHTML = "<div class='grid-empty'>Loading…</div>";
			idxHost.textContent = "";
			ddlPre.textContent = "";
			const r = await request({ action: "describe", connId: work.connId, db: work.curDb, table: work.curTable });
			if (!r.ok) { colsHost.innerHTML = `<div class="err-text">${esc(r.error)}</div>`; return; }
			const d = r.describe;
			colsHost.textContent = "";
			if (d.columns.length) {
				const t = document.createElement("table");
				t.className = "mtable";
				t.innerHTML = "<thead><tr><th>#</th><th>Column</th><th>Type</th><th>Null</th><th>Key</th><th>Default</th><th>Comment</th></tr></thead><tbody>"
					+ d.columns.map((c, i) => `<tr><td>${i + 1}</td><td>${esc(c.name)}</td><td>${esc(c.type)}</td>`
						+ `<td>${c.nullable ? "YES" : "NO"}</td><td>${c.key ? `<span class="keytag">${esc(c.key)}</span>` : ""}</td>`
						+ `<td>${esc(c.def ?? "")}</td><td>${esc(c.comment || "")}</td></tr>`).join("")
					+ "</tbody>";
				colsHost.appendChild(t);
			} else colsHost.innerHTML = "<div class='grid-empty'>No fixed column info</div>";
			idxHost.textContent = "";
			if (d.indexes?.length) {
				const t = document.createElement("table");
				t.className = "mtable";
				t.innerHTML = "<thead><tr><th>Index</th><th>Unique</th><th>Columns / definition</th></tr></thead><tbody>"
					+ d.indexes.map((i) => `<tr><td>${esc(i.name)}</td><td>${i.unique ? "✓" : ""}</td><td>${esc(i.columns)}</td></tr>`).join("")
					+ "</tbody>";
				idxHost.appendChild(t);
			} else idxHost.innerHTML = "<div class='grid-empty'>No indexes</div>";
			ddlPre.textContent = d.ddl || "-- No DDL";
		}

		// ---- SQL query pane -------------------------------------------------------
		async function runQuery() {
			if (!work) return;
			const sql = sqlBox.value.trim();
			if (!sql) { toast("SQL is empty", true); return; }
			qStatus.textContent = "Running…";
			qStatus.classList.remove("err-text");
			qGridHost.textContent = "";
			const r = await request({ action: "query_exec", connId: work.connId, db: work.curDb, sql });
			if (!r.ok) { qStatus.textContent = `✗ ${r.error}`; qStatus.classList.add("err-text"); return; }
			qStatus.textContent = `✓ ${r.grid.elapsedMs}ms`
				+ (r.grid.total ? ` · ${r.grid.total} rows` : "")
				+ (r.grid.affected ? ` · ${r.grid.affected} affected` : "");
			renderGrid(qGridHost, r.grid.columns, r.grid.rows, work.kind);
		}
		$(".btn-run").addEventListener("click", () => void runQuery());
		sqlBox.addEventListener("keydown", (ev) => {
			if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") { ev.preventDefault(); void runQuery(); }
			if (ev.key === "Tab") {
				ev.preventDefault();
				sqlBox.setRangeText("  ", sqlBox.selectionStart, sqlBox.selectionEnd, "end");
			}
		});

		// ---- Redis -----------------------------------------------------------
		let curKey = null;
		async function redisScan(pattern) {
			keysList.innerHTML = "<div class='grid-empty'>Scanning…</div>";
			const r = await request({ action: "redis_scan", connId: work.connId, pattern: pattern || "*", count: 300 });
			if (!r.ok) { keysList.innerHTML = `<div class="err-text">${esc(r.error)}</div>`; return; }
			curKey = null;
			setKeyEditor(false);
			kdName.textContent = "";
			kdInfo.textContent = "";
			kdValue.textContent = "// Click a key on the left for details";
			keysList.textContent = "";
			if (!r.keys.length) { keysList.innerHTML = "<div class='grid-empty'>No matching keys</div>"; return; }
			for (const k of r.keys) {
				const row = document.createElement("div");
				row.className = "krow";
				row.dataset.key = k.key;
				row.innerHTML = `<span class="kn" title="${esc(k.key)}">${esc(k.key)}</span><span class="kt">${esc(k.type)}</span>`;
				row.addEventListener("click", () => void redisKeyDetail(k.key));
				keysList.appendChild(row);
			}
			if (r.cursor !== "0") {
				const more = document.createElement("div");
				more.className = "krow";
				more.innerHTML = "<span class='kn' style='opacity:.5'>…more (narrow the pattern and scan again)</span>";
				keysList.appendChild(more);
			}
		}

		async function redisKeyDetail(key) {
			curKey = key;
			keysList.querySelectorAll(".krow").forEach((r) => r.classList.toggle("active", r.dataset.key === key));
			kdName.textContent = key;
			kdInfo.textContent = "Loading…";
			const r = await request({ action: "redis_key", connId: work.connId, key });
			if (!r.ok) { setKeyEditor(null); kdValue.textContent = `✗ ${r.error}`; kdInfo.textContent = ""; return; }
			const d = r.detail;
			kdInfo.textContent = `Type ${d.type} · size ${fmtCount(d.size)} · TTL ${d.ttl < 0 ? "∞" : `${d.ttl}s`}`;
			const editable = d.type === "string" && !d.truncated;
			setKeyEditor(editable);
			if (editable) kdText.value = d.value;
			else {
				kdValue.textContent = d.value;
				if (d.truncated) kdValue.textContent += "\n\n(Content truncated; use the raw command above to view/edit)";
			}
		}

		/** String keys → editable textarea; other types stay a read-only <pre> */
		function setKeyEditor(editable) {
			kdValue.classList.toggle("hidden", Boolean(editable));
			kdText.classList.toggle("hidden", !editable);
			$(".btn-save-key").classList.toggle("hidden", !editable);
			if (!editable) kdText.value = "";
		}

		async function saveKeyValue() {
			if (!curKey || !work) return;
			const r = await request({ action: "redis_key_set", connId: work.connId, key: curKey, value: kdText.value });
			r.ok ? toast("Key value saved") : toast(r.error, true);
		}

		async function refreshRedisMeta() {
			const r = await request({ action: "redis_meta", connId: work.connId });
			if (r.ok) $(".redis-meta").textContent = `${fmtCount(r.meta.dbsize)} keys · mem ${r.meta.usedMemory}`;
		}

		$(".btn-scan").addEventListener("click", () => void redisScan($(".pattern").value.trim()));
		$(".pattern").addEventListener("keydown", (ev) => { if (ev.key === "Enter") void redisScan($(".pattern").value.trim()); });
		$(".btn-del-key").addEventListener("click", async () => {
			if (!curKey || !confirm(`Delete key "${curKey}"?`)) return;
			const r = await request({ action: "redis_del", connId: work.connId, key: curKey });
			r.ok ? (toast("Deleted"), void redisScan($(".pattern").value.trim())) : toast(r.error, true);
		});
		async function runCmd() {
			const line = $(".cmdline").value.trim();
			if (!line) return;
			kdName.textContent = `$ ${line}`;
			kdInfo.textContent = "Running…";
			const r = await request({ action: "redis_cmd", connId: work.connId, cmd: line });
			kdInfo.textContent = r.ok ? "Done" : "";
			kdValue.textContent = r.ok ? String(r.output) : `✗ ${r.error}`;
			void refreshRedisMeta();
		}
		$(".btn-cmd").addEventListener("click", () => void runCmd());
		$(".cmdline").addEventListener("keydown", (ev) => { if (ev.key === "Enter") void runCmd(); });

		// ---- Toolbar actions ---------------------------------------------------------
		dbSel.addEventListener("change", () => void selectDb(dbSel.value));
		filterInput.addEventListener("input", () => renderTables());
		tabsEl.addEventListener("click", (ev) => {
			const t = ev.target.closest(".dbx-tab");
			if (t && !t.classList.contains("hidden")) setTab(t.dataset.tab);
		});
		$(".btn-disconnect").addEventListener("click", async () => {
			if (!work) return;
			await request({ action: "disconnect", connId: work.connId });
			closeWork();
		});
		$(".btn-refresh").addEventListener("click", async () => {
			if (!work) return;
			if (work.kind === "redis") { void redisScan($(".pattern").value.trim()); return; }
			await refreshTables();
			if (activeTab === "data") void loadData();
			else if (activeTab === "schema") void loadSchema();
		});
		$('[data-act="add"]').addEventListener("click", () => openModal(null));

		// ---- Connection form modal ------------------------------------------------------
		const TYPE_PORT = { mysql: 3306, postgres: 5432, sqlite: 0, sqlserver: 1433, mongodb: 27017, redis: 6379 };
		const qf = (n) => modalBg.querySelector(`[name="${n}"]`);

		function syncFormGroups(type) {
			modalBg.querySelector(".grp-file").classList.toggle("hidden", type !== "sqlite");
			modalBg.querySelector(".grp-net").classList.toggle("hidden", type === "sqlite");
			modalBg.querySelector(".grp-uri").classList.toggle("hidden", type !== "mongodb");
			modalBg.querySelector(".grp-redis").classList.toggle("hidden", type !== "redis");
		}
		qf("type").addEventListener("change", () => {
			const type = qf("type").value;
			syncFormGroups(type);
			qf("port").placeholder = TYPE_PORT[type] ? String(TYPE_PORT[type]) : "—";
		});

		function openModal(conn) {
			modalEditId = conn?.id ?? null;
			$(".m-title").textContent = conn ? "Edit connection" : "New connection";
			qf("name").value = conn?.name ?? "";
			const type = conn?.type ?? "mysql";
			qf("type").value = type;
			qf("type").disabled = Boolean(conn); // type cannot be changed
			qf("host").value = conn?.host ?? "127.0.0.1";
			qf("port").value = conn?.port ?? "";
			qf("port").placeholder = TYPE_PORT[type] ? String(TYPE_PORT[type]) : "—";
			qf("user").value = conn?.user ?? "";
			qf("password").value = "";
			qf("password").placeholder = conn?.hasPass ? "Saved (leave blank to keep)" : "";
			qf("database").value = conn?.database ?? "";
			qf("file").value = conn?.file ?? "";
			qf("uri").value = "";
			qf("uri").placeholder = conn?.hasUri ? "Saved (leave blank to keep)" : "mongodb://user:pass@host:27017";
			qf("redisDb").value = conn?.redisDb || "0";
			syncFormGroups(type);
			modalBg.classList.remove("hidden");
			qf("host").focus();
		}

		function collectForm(includePassword) {
			const type = qf("type").value;
			const body = {
				name: qf("name").value.trim(),
				type,
				port: Number(qf("port").value) || TYPE_PORT[type] || 0,
				user: qf("user").value.trim(),
				database: qf("database").value.trim(),
				file: qf("file").value.trim(),
				uri: qf("uri").value.trim(),
				redisDb: Number(qf("redisDb").value) || 0,
			};
			if (type !== "sqlite") body.host = qf("host").value.trim();
			if (includePassword) body.password = qf("password").value || undefined;
			if (modalEditId) body.id = modalEditId;
			return body;
		}

		modalBg.querySelector(".m-cancel").addEventListener("click", () => modalBg.classList.add("hidden"));
		modalBg.addEventListener("click", (ev) => { if (ev.target === modalBg) modalBg.classList.add("hidden"); });
		modalBg.querySelector(".btn-test").addEventListener("click", async () => {
			const body = collectForm(true);
			if (modalEditId && !body.password) delete body.password; // server keeps the old value
			const btn = modalBg.querySelector(".btn-test");
			btn.textContent = "Testing…";
			const r = await request({ action: "test", conn: body });
			btn.textContent = "Test connection";
			toast(r.ok ? "✓ Connected" : `✗ Connection failed:${r.error}`, !r.ok);
		});
		modalBg.querySelector(".m-save").addEventListener("click", async () => {
			const body = collectForm(true);
			const r = await request({ action: "conns_save", conn: body });
			if (!r.ok) { toast(`Save failed:${r.error}`, true); return; }
			modalBg.classList.add("hidden");
		});

		// ---- View sync (keep highlight consistent when tabs share state) ---------------------
		function syncActiveView() {
			if (work && !state.active.some((a) => a.connId === work.connId)) closeWork();
		}

		// ---- Startup ------------------------------------------------------------
		// Use request() with a reqId so the response is not swallowed by onData's res branch;
		// onData also accepts responses without reqId (belt and suspenders)
		void request({ action: "state" }).then((r) => {
			if (r.ok && r.state) {
				state = r.state;
				renderConns();
				renderDeps();
				syncActiveView();
			}
		});

		return () => {
			work = null;
			offData();
			root.remove();
		};
	},
};
