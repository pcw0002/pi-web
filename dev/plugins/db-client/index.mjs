/**
 * db-client plugin server — database connection manager / browser backend (vscode-database-client-like).
 *
 * driver packages are not shipped with the plugin：auto on first activate npm one-shot install
 * mysql2 / pg / better-sqlite3 / mssql / mongodb / ioredis into the plugin directory (same pattern as ssh/webmail).
 *
 * Responsibilities：
 * - connection config CRUD (conn.dir/db-connections.json, plaintext on this machine; echo only reports hasPass)
 * - connection pool：connId → adapter instance；events are sent only to the creator socket
 * - unified adapter interface（dispatch by database type）：
 *     listDatabases() / listTables(db) / describeTable(db,table)
 *     selectPage(db,table,{offset,limit,orderBy,dir,filter}) / query(db,sql)
 *   SQL engines (mysql/postgres/sqlserver/sqlite) use SQL; mongodb uses find + JSON filter;
 *   redis has its own actions (scan/key/del/raw command).
 *
 * Protocol: uplink { action, reqId?, ... }; two downlink kinds —
 *   response { res: true, reqId, ok, ... } (matched by reqId)
 *   event { event: "conn_closed", ... } (sendTo creator)
 *   broadcast { kind: "state", state } (connection list / live connections / dep status, credentials redacted)
 */

import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile as rf, writeFile as wf } from "node:fs/promises";

const CONFIG_FILE = "db-connections.json";
const DEPS = ["mysql2@^3", "pg@^8", "mssql@^12", "mongodb@^7", "ioredis@^6"];
const MAX_CONNS = 32; // connection-config cap
const MAX_RUNTIME = 8; // concurrent open connections
const OP_TIMEOUT_MS = 30_000; // per-query timeout
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_PAGE_ROWS = 500;
const MAX_QUERY_ROWS = 1000;
const MAX_CELL_LEN = 4000; // cell serialization truncation

export const DB_TYPES = {
	mysql: { label: "MySQL", port: 3306 },
	postgres: { label: "PostgreSQL", port: 5432 },
	sqlite: { label: "SQLite", port: 0 },
	sqlserver: { label: "SQL Server", port: 1433 },
	mongodb: { label: "MongoDB", port: 27017 },
	redis: { label: "Redis", port: 6379 },
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function withTimeout(promise, ms, label) {
	return Promise.race([
		promise,
		new Promise((_, rej) => setTimeout(() => rej(new Error(`${label ?? "operation"}timed out（${ms / 1000}s）`)), ms)),
	]);
}

/** dialect identifier quoting (injection-safe: always quote) */
function qMysql(s) { return "`" + String(s).replace(/`/g, "``") + "`"; }
function qPg(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }
function qMssql(s) { return "[" + String(s).replace(/\]/g, "]]") + "]"; }
function qSqlite(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

/** serialize values uniformly into displayable JSON compatible scalars */
function cellVal(v) {
	if (v === null || v === undefined) return null;
	if (typeof v === "number" || typeof v === "boolean") return v;
	if (typeof v === "bigint") return Number(v);
	if (v instanceof Date) return v.toISOString();
	if (Buffer.isBuffer(v)) return `<binary ${v.length} bytes>`;
	if (typeof v === "object") {
		let s;
		try {
			s = JSON.stringify(v, (k, x) => {
				if (x && typeof x === "object" && x._bsontype) {
					if (typeof x.toString === "function" && x.toString !== Object.prototype.toString) return x.toString();
				}
				if (typeof x === "bigint") return Number(x);
				return x;
			});
		} catch { s = String(v); }
		if (s.length > MAX_CELL_LEN) s = s.slice(0, MAX_CELL_LEN) + "…";
		return s;
	}
	const s = String(v);
	return s.length > MAX_CELL_LEN ? s.slice(0, MAX_CELL_LEN) + "…" : s;
}

function rowsToGrid(columns, rows) {
	return {
		columns,
		rows: rows.map((r) => (Array.isArray(r) ? r.map(cellVal) : columns.map((c) => cellVal(r?.[c])))),
	};
}

function parseJsonFilter(text) {
	const t = String(text ?? "").trim();
	if (!t) return {};
	try {
		const obj = JSON.parse(t);
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("Filter must be a JSON object");
		return obj;
	} catch (e) {
		throw new Error(`Failed to parse filter JSON：${e.message}`);
	}
}

// ---------------------------------------------------------------------------
// Adapter factory — one async factory per database, returns the unified interface + kind
// ---------------------------------------------------------------------------

async function mysqlAdapter(cfg) {
	const mod = await import("mysql2/promise");
	const mysql = mod.default ?? mod;
	const conn = await withTimeout(mysql.createConnection({
		host: cfg.host || "127.0.0.1",
		port: Number(cfg.port) || 3306,
		user: cfg.user || "root",
		password: cfg.password || undefined,
		connectTimeout: CONNECT_TIMEOUT_MS,
		dateStrings: true,
	}), CONNECT_TIMEOUT_MS + 3000, "connect");
	await conn.ping();
	let curDb = null;
	async function useDb(db) {
		if (db && db !== curDb) { await conn.query(`USE ${qMysql(db)}`); curDb = db; }
	}
	return {
		kind: "sql",
		dialect: "mysql",
		async listDatabases() {
			const [rows] = await conn.query("SHOW DATABASES");
			return rows.map((r) => Object.values(r)[0]).filter(Boolean);
		},
		async listTables(db) {
			const [rows] = await conn.query(
				`SELECT table_name AS name, table_type AS kind, IFNULL(table_rows,0) AS approx_rows
				 FROM information_schema.tables WHERE table_schema=? ORDER BY table_name`, [db]);
			return rows.map((r) => ({
				name: r.name, kind: r.kind === "VIEW" ? "view" : "table",
				approxRows: Number(r.approx_rows) || 0,
			}));
		},
		async describeTable(db, t) {
			const [cols] = await conn.query(
				`SELECT column_name AS name, column_type AS type, is_nullable AS nullable,
				        column_default AS def, column_key AS ckey, extra, column_comment AS comment
				 FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position`, [db, t]);
			const [idx] = await conn.query(
				`SELECT index_name AS name, NON_UNIQUE AS non_unique,
				        GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
				 FROM information_schema.statistics WHERE table_schema=? AND table_name=?
				 GROUP BY index_name, NON_UNIQUE`, [db, t]);
			let ddl = "";
			try {
				const [[row]] = await conn.query(`SHOW CREATE TABLE ${qMysql(db)}.${qMysql(t)}`);
				ddl = row["Create Table"] ?? row["Create View"] ?? "";
			} catch { /* failures in view-like cases can be ignored */ }
			return {
				columns: cols.map((c) => ({
					name: c.name, type: c.type, nullable: c.nullable === "YES",
					key: c.ckey || "", def: c.def ?? null, comment: c.comment || "",
				})),
				indexes: idx.map((i) => ({ name: i.name, unique: !Number(i.non_unique), columns: String(i.cols ?? "") })),
				ddl,
			};
		},
		async selectPage(db, t, opt) {
			// mysql Data tab has no JSON filter (that is a mongodb-only parameter)
			const totalRes = await conn.query(`SELECT COUNT(*) AS n FROM ${qMysql(db)}.${qMysql(t)}`);
			const total = Number(totalRes[0][0]?.n ?? 0);
			const orderSql = opt.orderBy ? ` ORDER BY ${qMysql(opt.orderBy)} ${opt.dir === "desc" ? "DESC" : "ASC"}` : "";
			const [rows] = await conn.query(
				`SELECT * FROM ${qMysql(db)}.${qMysql(t)}${orderSql} LIMIT ? OFFSET ?`,
				[Math.min(Number(opt.limit) || 50, MAX_PAGE_ROWS), Math.max(Number(opt.offset) || 0, 0)]);
			const fields = rows.length ? Object.keys(rows[0])
				: (await conn.query(`SELECT * FROM ${qMysql(db)}.${qMysql(t)} LIMIT 1`))[0]?.fields?.map((f) => f.name)
					?? (await conn.query(
						`SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position`, [db, t]))[0].map((r) => r.column_name);
			const [pkRows] = await conn.query(
				`SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_key='PRI' ORDER BY ordinal_position LIMIT 1`, [db, t]);
			return { total, ...rowsToGrid(fields.length ? fields : ["*"], rows), editable: Boolean(pkRows[0]?.column_name), pkCol: pkRows[0]?.column_name ?? null };
		},
		async query(db, sql) {
			await useDb(db);
			const started = Date.now();
			const [result] = await conn.query(sql);
			if (Array.isArray(result)) {
				// SELECT result set
				const fields = result.length ? Object.keys(result[0]) : [];
				return { total: result.length, affected: 0, elapsedMs: Date.now() - started, ...rowsToGrid(fields, result) };
			}
			return { total: 0, affected: result?.affectedRows ?? 0, elapsedMs: Date.now() - started, columns: [], rows: [] };
		},
		async updateRow(db, t, pkCol, pkVal, changes) {
			const cols = Object.keys(changes);
			if (!cols.length) throw new Error("No columns to update");
			const [r] = await conn.query(
				`UPDATE ${qMysql(db)}.${qMysql(t)} SET ${cols.map((c) => `${qMysql(c)}=?`).join(", ")} WHERE ${qMysql(pkCol)}=?`,
				[...Object.values(changes), pkVal]);
			return { affected: Number(r?.affectedRows ?? 0) };
		},
		async insertRow(db, t, values) {
			const cols = Object.keys(values);
			if (!cols.length) throw new Error("No columns to insert (all left blank)");
			const [r] = await conn.query(
				`INSERT INTO ${qMysql(db)}.${qMysql(t)} (${cols.map(qMysql).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
				Object.values(values));
			return { affected: 1, id: r?.insertId ?? null };
		},
		async deleteRow(db, t, pkCol, pkVal) {
			const [r] = await conn.query(`DELETE FROM ${qMysql(db)}.${qMysql(t)} WHERE ${qMysql(pkCol)}=?`, [pkVal]);
			return { affected: Number(r?.affectedRows ?? 0) };
		},
		async close() { try { await conn.end(); } catch { /* ignore */ } },
	};
}

async function postgresAdapter(cfg) {
	const mod = await import("pg");
	const Client = mod.default?.Client ?? mod.Client;
	const base = {
		host: cfg.host || "127.0.0.1",
		port: Number(cfg.port) || 5432,
		user: cfg.user || "postgres",
		password: cfg.password || undefined,
		connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
	};
	const curName = cfg.database || "postgres";
	const clients = new Map();
	async function getCli(name) {
		name = name || curName;
		let c = clients.get(name);
		if (c) return c;
		c = new Client({ ...base, database: name });
		await withTimeout(c.connect(), CONNECT_TIMEOUT_MS + 3000, "connect");
		clients.set(name, c);
		return c;
	}
	const main = await getCli(curName);
	return {
		kind: "sql",
		dialect: "postgres",
		async listDatabases() {
			const r = await main.query("SELECT datname FROM pg_database WHERE datistemplate=false AND datallowconn=true ORDER BY datname");
			return r.rows.map((x) => x.datname);
		},
		async listTables(db) {
			const c = await getCli(db);
			const r2 = await c.query(
				`SELECT c.relname AS name,
				        CASE WHEN c.relkind IN ('r','p') THEN 'table' ELSE 'view' END AS kind,
				        GREATEST(c.reltuples::bigint, 0)::text AS approx
				 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
				 WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')
				 ORDER BY c.relname`);
			return r2.rows.map((x) => ({ name: x.name, kind: x.kind, approxRows: Number(x.approx) || 0 }));
		},
		async describeTable(db, t) {
			const c = await getCli(db);
			const cols = await c.query(
				`SELECT column_name, data_type, is_nullable, column_default, character_maximum_length AS max_len
				 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t]);
			const pk = await c.query(
				`SELECT kcu.column_name FROM information_schema.table_constraints tc
				 JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name
				 WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY'`, [t]);
			const pkSet = new Set(pk.rows.map((x) => x.column_name));
			const idx = await c.query(
				`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=$1`, [t]);
			const ddlLines = cols.rows.map((c2) =>
				`  ${qPg(c2.column_name)} ${c2.data_type}${c2.max_len ? `(${c2.max_len})` : ""}${c2.is_nullable === "NO" ? " NOT NULL" : ""}${c2.column_default ? ` DEFAULT ${c2.column_default}` : ""}`);
			if (pkSet.size) ddlLines.push(`  PRIMARY KEY (${[...pkSet].map(qPg).join(", ")})`);
			return {
				columns: cols.rows.map((c2) => ({
					name: c2.column_name, type: c2.data_type + (c2.max_len ? `(${c2.max_len})` : ""),
					nullable: c2.is_nullable === "YES", key: pkSet.has(c2.column_name) ? "PRI" : "",
					def: c2.column_default ?? null, comment: "",
				})),
				indexes: idx.rows.map((i) => ({ name: i.indexname, unique: /CREATE UNIQUE/i.test(i.indexdef), columns: i.indexdef })),
				ddl: `CREATE TABLE ${qPg(t)} (\n${ddlLines.join(",\n")}\n);`,
			};
		},
		async selectPage(db, t, opt) {
			const c = await getCli(db);
			const cnt = await c.query(`SELECT COUNT(*)::bigint AS n FROM ${qPg("public")}.${qPg(t)}`);
			const total = Number(cnt.rows[0]?.n ?? 0);
			const orderSql = opt.orderBy ? ` ORDER BY ${qPg(opt.orderBy)} ${opt.dir === "desc" ? "DESC" : "ASC"} NULLS LAST` : " ORDER BY 1";
			const r = await c.query(
				`SELECT * FROM ${qPg("public")}.${qPg(t)}${orderSql} LIMIT $1 OFFSET $2`,
				[Math.min(Number(opt.limit) || 50, MAX_PAGE_ROWS), Math.max(Number(opt.offset) || 0, 0)]);
			const columns = r.fields.map((f) => f.name);
			const pkR = await c.query(
				`SELECT kcu.column_name FROM information_schema.table_constraints tc
				 JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name
				 WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY'
				 ORDER BY kcu.ordinal_position LIMIT 1`, [t]);
			return { total, ...rowsToGrid(columns, r.rows), editable: Boolean(pkR.rows[0]?.column_name), pkCol: pkR.rows[0]?.column_name ?? null };
		},
		async query(db, sql) {
			const c = await getCli(db || curName);
			const started = Date.now();
			const r = await c.query(sql);
			const columns = r.fields?.map((f) => f.name) ?? [];
			return {
				total: r.rows?.length ?? 0,
				affected: r.rowCount != null && !columns.length ? r.rowCount : 0,
				elapsedMs: Date.now() - started,
				...rowsToGrid(columns, r.rows ?? []),
			};
		},
		async updateRow(db, t, pkCol, pkVal, changes) {
			const cols = Object.keys(changes);
			if (!cols.length) throw new Error("No columns to update");
			const c = await getCli(db);
			const sets = cols.map((col, i) => `${qPg(col)}=$${i + 1}`).join(", ");
			const r = await c.query(
				`UPDATE ${qPg("public")}.${qPg(t)} SET ${sets} WHERE ${qPg(pkCol)}=$${cols.length + 1}`,
				[...Object.values(changes), pkVal]);
			return { affected: r.rowCount ?? 0 };
		},
		async insertRow(db, t, values) {
			const cols = Object.keys(values);
			if (!cols.length) throw new Error("No columns to insert (all left blank)");
			const c = await getCli(db);
			const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
			const r = await c.query(
				`INSERT INTO ${qPg("public")}.${qPg(t)} (${cols.map(qPg).join(", ")}) VALUES (${ph}) RETURNING 1 AS ok`,
				Object.values(values));
			return { affected: r.rowCount ?? 1, id: null };
		},
		async deleteRow(db, t, pkCol, pkVal) {
			const c = await getCli(db);
			const r = await c.query(`DELETE FROM ${qPg("public")}.${qPg(t)} WHERE ${qPg(pkCol)}=$1`, [pkVal]);
			return { affected: r.rowCount ?? 0 };
		},
		async close() { for (const c of clients.values()) { try { await c.end(); } catch { /* ignore */ } } },
	};
}

async function sqliteAdapter(cfg) {
	if (!cfg.file || !String(cfg.file).trim()) throw new Error("SQLite requires a database file path");
	if (!existsSync(String(cfg.file).trim())) throw new Error(`Database file does not exist：${cfg.file}`);
	// Use Node built-in node:sqlite (≥22.13, no flag); zero native deps; open writable (row edits)
	const mod = await import("node:sqlite");
	const DatabaseSync = mod.DatabaseSync ?? mod.default?.DatabaseSync;
	if (!DatabaseSync) throw new Error("This Node build has no node:sqlite (need ≥22.13)");
	const db = new DatabaseSync(String(cfg.file).trim());
	function all(sql, ...args) { return db.prepare(sql).all(...args); }
	// PK probe cache: INTEGER/composite PK if present; tables without a PK fall back to rowid (__rid__ column)
	const pkCache = new Map();
	function tablePk(t) {
		if (pkCache.has(t)) return pkCache.get(t);
		const info = all(`PRAGMA table_info(${qSqlite(t)})`);
		const pks = info.filter((c) => Number(c.pk) > 0);
		const col = pks.length === 1 ? pks[0].name : null; // composite PKs cannot locate a row
		pkCache.set(t, col);
		return col;
	}
	return {
		kind: "sql",
		dialect: "sqlite",
		async listDatabases() { return ["main"]; },
		async listTables() {
			return all(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`)
				.map((r) => ({ name: r.name, kind: r.type === "view" ? "view" : "table", approxRows: 0 }));
		},
		async describeTable(_db, t) {
			const info = all(`PRAGMA table_info(${qSqlite(t)})`);
			const idxList = all(`PRAGMA index_list(${qSqlite(t)})`);
			const indexes = idxList.map((i) => {
				const cols = all(`PRAGMA index_info(${qSqlite(i.name)})`).map((x) => x.name);
				return { name: i.name, unique: !Number(i.unique), columns: cols.join(", ") };
			});
			const master = all(`SELECT sql FROM sqlite_master WHERE name=?`, t)[0];
			return {
				columns: info.map((c) => ({
					name: c.name, type: c.type || "", nullable: !Number(c.pk) ? c.notnull === 0 : false,
					key: Number(c.pk) ? "PRI" : "", def: c.dflt_value ?? null, comment: "",
				})),
				indexes,
				ddl: master?.sql ?? "",
			};
		},
		async selectPage(_db, t, opt) {
			const total = Number(all(`SELECT COUNT(*) AS n FROM ${qSqlite(t)}`)[0]?.n ?? 0);
			const orderSql = opt.orderBy ? ` ORDER BY ${qSqlite(opt.orderBy)} ${opt.dir === "desc" ? "DESC" : "ASC"}` : "";
			const useRid = !tablePk(t);
			const sel = useRid ? `rowid AS "__rid__", *` : "*";
			const rows = all(`SELECT ${sel} FROM ${qSqlite(t)}${orderSql} LIMIT ? OFFSET ?`,
				Math.min(Number(opt.limit) || 50, MAX_PAGE_ROWS), Math.max(Number(opt.offset) || 0, 0));
			const colsRow = all(`PRAGMA table_info(${qSqlite(t)})`);
			const columns = [...(useRid ? ["__rid__"] : []), ...colsRow.map((c) => c.name)];
			return { total, ...rowsToGrid(columns, rows), editable: true, pkCol: tablePk(t) ?? "__rid__" };
		},
		async query(_db, sql) {
			const started = Date.now();
			if (/^\s*(select|with|pragma|explain|values)\b/i.test(sql)) {
				const stmt = db.prepare(sql);
				const rows = stmt.all().slice(0, MAX_QUERY_ROWS);
				const columns = stmt.columns().map((c) => c.name);
				return { total: rows.length, affected: 0, elapsedMs: Date.now() - started, ...rowsToGrid(columns, rows) };
			}
			const info = db.prepare(sql).run();
			return { total: 0, affected: Number(info?.changes ?? 0), elapsedMs: Date.now() - started, columns: [], rows: [] };
		},
		async updateRow(_db, t, pkCol, pkVal, changes) {
			const cols = Object.keys(changes);
			if (!cols.length) throw new Error("No columns to update");
			const info = db.prepare(
				`UPDATE ${qSqlite(t)} SET ${cols.map(qSqlite).map((c, i) => `${c}=?`).join(", ")} WHERE ${qSqlite(pkCol)}=?`
			).run(...Object.values(changes), pkVal);
			return { affected: Number(info.changes ?? 0) };
		},
		async insertRow(_db, t, values) {
			const cols = Object.keys(values);
			if (!cols.length) throw new Error("No columns to insert (all left blank)");
			const info = db.prepare(
				`INSERT INTO ${qSqlite(t)} (${cols.map(qSqlite).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
			).run(...Object.values(values));
			return { affected: 1, id: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
		},
		async deleteRow(_db, t, pkCol, pkVal) {
			const info = db.prepare(`DELETE FROM ${qSqlite(t)} WHERE ${qSqlite(pkCol)}=?`).run(pkVal);
			return { affected: Number(info.changes ?? 0) };
		},
		async close() { try { db.close(); } catch { /* ignore */ } },
	};
}

async function mssqlAdapter(cfg) {
	const ms = await import("mssql");
	const mssql = ms.default ?? ms;
	const baseCfg = {
		server: cfg.host || "127.0.0.1",
		port: Number(cfg.port) || 1433,
		user: cfg.user || "sa",
		password: cfg.password || "",
		database: cfg.database || "master",
		connectionTimeout: CONNECT_TIMEOUT_MS,
		requestTimeout: OP_TIMEOUT_MS,
		options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
	};
	const pools = new Map();
	async function getPool(name) {
		name = name || baseCfg.database;
		let p = pools.get(name);
		if (p) return p;
		p = new mssql.ConnectionPool({ ...baseCfg, database: name });
		await withTimeout(p.connect(), CONNECT_TIMEOUT_MS + 5000, "connect");
		pools.set(name, p);
		return p;
	}
	const main = await getPool(baseCfg.database);
	async function qual(db, t) {
		// look up the real schema，avoid hard-coding dbo
		const r = await (await getPool(db)).request()
			.input("t", mssql.VarChar(256), t)
			.query(`SELECT TOP 1 OBJECT_SCHEMA_NAME(object_id) AS s FROM ${qMssql(db)}.sys.objects WHERE name=@t AND type IN ('U','V')`);
		const schema = r.recordset[0]?.s || "dbo";
		return `${qMssql(db)}.${qMssql(schema)}.${qMssql(t)}`;
	}
	return {
		kind: "sql",
		dialect: "mssql",
		async listDatabases() {
			const r = await main.request().query("SELECT name FROM sys.databases WHERE state=0 ORDER BY name");
			return r.recordset.map((x) => x.name);
		},
		async listTables(db) {
			const r = await (await getPool(db)).request()
				.query(`SELECT name, CASE type WHEN 'U' THEN 'table' ELSE 'view' END AS kind FROM ${qMssql(db)}.sys.objects WHERE type IN ('U','V') ORDER BY name`);
			return r.recordset.map((x) => ({ name: x.name, kind: x.kind, approxRows: 0 }));
		},
		async describeTable(db, t) {
			const pool = await getPool(db);
			const fq = await qual(db, t);
			const cols = await pool.request().input("t", mssql.VarChar(256), t).query(
				`SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def,
				        CHARACTER_MAXIMUM_LENGTH AS max_len
				 FROM ${qMssql(db)}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=@t ORDER BY ORDINAL_POSITION`);
			const pk = await pool.request().input("t", mssql.VarChar(256), t).query(
				`SELECT ku.COLUMN_NAME AS name FROM ${qMssql(db)}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
				 JOIN ${qMssql(db)}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME=ku.CONSTRAINT_NAME
				 WHERE tc.TABLE_NAME=@t AND tc.CONSTRAINT_TYPE='PRIMARY KEY'`);
			const pkSet = new Set(pk.recordset.map((x) => x.name));
			return {
				columns: cols.recordset.map((c) => ({
					name: c.name, type: c.type + (c.max_len && c.max_len > 0 && c.max_len < 8000 ? `(${c.max_len})` : ""),
					nullable: c.nullable === "YES", key: pkSet.has(c.name) ? "PRI" : "", def: c.def ?? null, comment: "",
				})),
				indexes: [],
				ddl: `-- ${fq}\n` + cols.recordset.map((c) =>
					`  ${c.name} ${c.type} ${c.nullable === "YES" ? "NULL" : "NOT NULL"}`).join("\n"),
			};
		},
		async selectPage(db, t, opt) {
			const pool = await getPool(db);
			const fq = await qual(db, t);
			const totalR = await pool.request().query(`SELECT COUNT_BIG(*) AS n FROM ${fq}`);
			const total = Number(totalR.recordset[0]?.n ?? 0);
			const orderSql = opt.orderBy
				? ` ORDER BY ${qMssql(opt.orderBy)} ${opt.dir === "desc" ? "DESC" : "ASC"} OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`
				: ` ORDER BY (SELECT NULL) OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`;
			const r = await pool.request()
				.input("off", mssql.Int, Math.max(Number(opt.offset) || 0, 0))
				.input("lim", mssql.Int, Math.min(Number(opt.limit) || 50, MAX_PAGE_ROWS))
				.query(`SELECT * FROM ${fq}${orderSql}`);
			const columns = r.recordset.columns ? Object.keys(r.recordset.columns) : (r.recordset[0] ? Object.keys(r.recordset[0]) : []);
			const pkR = await pool.request().input("t", mssql.VarChar(256), t).query(
				`SELECT TOP 1 ku.COLUMN_NAME AS name FROM ${qMssql(db)}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
				 JOIN ${qMssql(db)}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME=ku.CONSTRAINT_NAME
				 WHERE tc.TABLE_NAME=@t AND tc.CONSTRAINT_TYPE='PRIMARY KEY'`);
			return { total, ...rowsToGrid(columns, r.recordset), editable: Boolean(pkR.recordset[0]?.name), pkCol: pkR.recordset[0]?.name ?? null };
		},
		async query(db, sql) {
			const pool = await getPool(db || baseCfg.database);
			const started = Date.now();
			const r = await pool.request().query(sql);
			const columns = r.recordset?.columns ? Object.keys(r.recordset.columns) : [];
			return {
				total: r.recordset?.length ?? 0,
				affected: r.rowsAffected?.reduce((a, b) => a + b, 0) ?? 0,
				elapsedMs: Date.now() - started,
				...rowsToGrid(columns, r.recordset ?? []),
			};
		},
		async updateRow(db, t, pkCol, pkVal, changes) {
			const cols = Object.keys(changes);
			if (!cols.length) throw new Error("No columns to update");
			const pool = await getPool(db);
			const fq = await qual(db, t);
			const req = pool.request().input("pk", pkVal);
			cols.forEach((c, i) => req.input(`v${i}`, changes[c]));
			const sets = cols.map((c, i) => `${qMssql(c)}=@v${i}`).join(", ");
			const r = await req.query(`UPDATE ${fq} SET ${sets} WHERE ${qMssql(pkCol)}=@pk`);
			return { affected: r.rowsAffected?.[0] ?? 0 };
		},
		async insertRow(db, t, values) {
			const cols = Object.keys(values);
			if (!cols.length) throw new Error("No columns to insert (all left blank)");
			const pool = await getPool(db);
			const fq = await qual(db, t);
			const req = pool.request();
			cols.forEach((c, i) => req.input(`v${i}`, values[c]));
			const r = await req.query(
				`INSERT INTO ${fq} (${cols.map(qMssql).join(", ")}) OUTPUT inserted.* VALUES (${cols.map((_, i) => `@v${i}`).join(", ")})`);
			return { affected: 1, id: r.recordset?.[0] ?? null };
		},
		async deleteRow(db, t, pkCol, pkVal) {
			const pool = await getPool(db);
			const fq = await qual(db, t);
			const r = await pool.request().input("pk", pkVal).query(`DELETE FROM ${fq} WHERE ${qMssql(pkCol)}=@pk`);
			return { affected: r.rowsAffected?.[0] ?? 0 };
		},
		async close() { for (const p of pools.values()) { try { await p.close(); } catch { /* ignore */ } } },
	};
}

async function mongoAdapter(cfg) {
	const mod = await import("mongodb");
	const MongoClient = mod.MongoClient ?? mod.default?.MongoClient;
	let url = cfg.uri;
	if (!url) {
		const auth = cfg.user ? `${encodeURIComponent(String(cfg.user))}:${encodeURIComponent(String(cfg.password || ""))}@` : "";
		url = `mongodb://${auth}${cfg.host || "127.0.0.1"}:${Number(cfg.port) || 27017}/${cfg.database ? encodeURIComponent(cfg.database) : ""}`;
	}
	const client = new MongoClient(url, { serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS });
	await withTimeout(client.connect(), CONNECT_TIMEOUT_MS + 3000, "connect");
	return {
		kind: "mongodb",
		dialect: "mongo",
		async listDatabases() {
			return (await client.db().admin().listDatabases()).databases.map((d) => d.name);
		},
		async listTables(db) {
			const colls = await client.db(db).listCollections().toArray();
			return colls.map((c) => ({ name: c.name, kind: c.type === "view" ? "view" : "collection", approxRows: 0 }));
		},
		async describeTable(db, t) {
			const coll = client.db(db).collection(t);
			let indexes = [];
			try { indexes = (await coll.listIndexes().toArray()).map((i) => ({ name: i.name, unique: Boolean(i.unique), columns: JSON.stringify(i.key) })); } catch { /* ignore */ }
			return { columns: [], indexes, ddl: `Collection ${db}.${t}（document store has no fixed schema，go to the「Data」tab to browse）` };
		},
		async selectPage(db, t, opt) {
			const coll = client.db(db).collection(t);
			const filter = parseJsonFilter(opt.filter);
			const total = await coll.countDocuments(filter);
			const docsRaw = await coll.find(filter)
				.skip(Math.max(Number(opt.offset) || 0, 0))
				.limit(Math.min(Number(opt.limit) || 50, MAX_PAGE_ROWS))
				.toArray();
			// BSON → plain JSON (_id/dates become strings), while keeping structured docs for write-back
			const replacer = (_k, v) => {
				if (v && typeof v === "object" && v._bsontype) {
					if (typeof v.toString === "function" && v.toString !== Object.prototype.toString) return v.toString();
				}
				if (typeof v === "bigint") return Number(v);
				return v;
			};
			const docs = JSON.parse(JSON.stringify(docsRaw, replacer));
			return { total, columns: ["doc"], rows: docs.map((d) => [JSON.stringify(d)]), docs, editable: true };
		},
		async docSave(db, t, id, docJson) {
			let body;
			try { body = JSON.parse(String(docJson ?? "")); }
			catch (e) { throw new Error(`Failed to parse document JSON：${e.message}`); }
			if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Document must be a JSON object");
			const toId = (v) => (typeof v === "string" && /^[0-9a-f]{24}$/i.test(v) ? new ObjectId(v) : v);
			const coll = client.db(db).collection(t);
			const r = await coll.replaceOne({ _id: toId(id) }, { ...body, _id: toId(id) });
			return { affected: r.modifiedCount ?? 0 };
		},
		async docInsert(db, t, docJson) {
			let body;
			try { body = JSON.parse(String(docJson ?? "")); }
			catch (e) { throw new Error(`Failed to parse document JSON：${e.message}`); }
			if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Document must be a JSON object");
			if (typeof body._id === "string" && /^[0-9a-f]{24}$/i.test(body._id)) body._id = new ObjectId(body._id);
			const r = await client.db(db).collection(t).insertOne(body);
			return { affected: 1, id: r.insertedId?.toString?.() ?? null };
		},
		async docDelete(db, t, id) {
			const toId = (v) => (typeof v === "string" && /^[0-9a-f]{24}$/i.test(v) ? new ObjectId(v) : v);
			const r = await client.db(db).collection(t).deleteOne({ _id: toId(id) });
			return { affected: r.deletedCount ?? 0 };
		},
		async query() { throw new Error("MongoDB does not support SQL — use a JSON filter on the Data tab"); },
		async close() { try { await client.close(); } catch { /* ignore */ } },
	};
}

async function redisAdapter(cfg) {
	const mod = await import("ioredis");
	const RedisCtor = mod.default ?? mod.Redis ?? mod;
	const cli = new RedisCtor({
		host: cfg.host || "127.0.0.1",
		port: Number(cfg.port) || 6379,
		password: cfg.password || undefined,
		db: Number(cfg.redisDb) > 0 ? Number(cfg.redisDb) : 0,
		maxRetriesPerRequest: 1,
		connectTimeout: CONNECT_TIMEOUT_MS,
		retryStrategy: () => null,
		lazyConnect: false,
	});
	cli.on("error", () => { /* silent，the operation layer reports errors */ });
	await withTimeout(cli.ping(), CONNECT_TIMEOUT_MS + 2000, "connect");

	async function scanKeys(pattern, cursorIn, want) {
		want = Math.min(Number(want) || 200, 1000);
		let cursor = String(cursorIn || "0");
		const keys = [];
		do {
			const [next, batch] = await cli.scan(cursor, "MATCH", pattern || "*", "COUNT", 200);
			cursor = next;
			for (const k of batch) if (keys.length < want) keys.push(k);
		} while (cursor !== "0" && keys.length < want);
		const capped = keys.slice(0, want);
		let types = [];
		if (capped.length) {
			const pipe = cli.pipeline();
			for (const k of capped) pipe.type(k);
			types = await pipe.exec();
		}
		return {
			cursor,
			keys: capped.map((k, i) => ({ key: k, type: types[i]?.[1] ?? "none" })),
		};
	}

	async function keyDetail(key) {
		const type = await cli.type(key);
		const ttl = await cli.ttl(key);
		let value = "";
		if (type === "string") value = (await cli.get(key)) ?? "(nil)";
		else if (type === "hash") {
			const h = await cli.hgetall(key);
			value = Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\n");
		} else if (type === "list") value = (await cli.lrange(key, 0, 199)).map((v, i) => `${i}: ${v}`).join("\n");
		else if (type === "set") value = [...(await cli.smembers(key))].slice(0, 200).join("\n");
		else if (type === "zset") {
			const z = await cli.zrange(key, 0, 199, "WITHSCORES");
			const lines = [];
			for (let i = 0; i < z.length; i += 2) lines.push(`${z[i]}  (score: ${z[i + 1]})`);
			value = lines.join("\n");
		} else if (type === "stream") {
			const r = await cli.xrange(key, "-", "+", "COUNT", 50);
			value = r.map(([id, fs]) => `${id} ${JSON.stringify(fs)}`).join("\n");
		} else value = `(Type ${type} preview not supported)`;
		let truncated = false;
		if (value.length > 64_000) { value = value.slice(0, 64_000) + "\n…[truncated]"; truncated = true; }
		const size = type === "string"
			? (await cli.strlen(key))
			: type === "hash" ? await cli.hlen(key)
				: type === "list" ? await cli.llen(key)
					: type === "set" ? await cli.scard(key)
						: type === "zset" ? await cli.zcard(key)
							: type === "stream" ? await cli.xlen(key) : 0;
		return { type, ttl, size, value, truncated };
	}

	/** simple command-line tokenize（supports single and double quotes） */
	function tokenize(line) {
		const out = [];
		let cur = "", quote = null;
		for (const ch of String(line)) {
			if (quote) { if (ch === quote) quote = null; else cur += ch; }
			else if (ch === '"' || ch === "'") quote = ch;
			else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ""; } }
			else cur += ch;
		}
		if (cur) out.push(cur);
		return out;
	}

	return {
		kind: "redis",
		dialect: "redis",
		listDatabases: async () => [`db${Number(cfg.redisDb) || 0}`],
		listTables: async () => [],
		describeTable: async () => ({ columns: [], indexes: [], ddl: "" }),
		selectPage: async () => ({ total: 0, columns: [], rows: [] }),
		query: async () => { throw new Error("For Redis use the raw command box on the Keys tab"); },
		scanKeys, keyDetail,
		delKey: async (key) => await cli.del(key),
		keySet: async (key, value) => {
			const type = await cli.type(key);
			if (type !== "string") throw new Error(`Only string keys can be edited (current type ${type}; use the raw command)`);
			await cli.set(key, String(value ?? ""));
			return { affected: 1 };
		},
		runCmd: async (line) => {
			const args = tokenize(line);
			if (!args.length) throw new Error("Empty command");
			return await cli.call(args[0], ...args.slice(1));
		},
		meta: async () => {
			const dbsize = await cli.dbsize();
			const mem = await cli.info("memory");
			const line = mem.split(/\r?\n/).find((l) => l.startsWith("used_memory_human"));
			return { dbsize, usedMemory: line ? line.split(":")[1]?.trim() : "?" };
		},
		async close() { try { cli.disconnect(); } catch { /* ignore */ } },
	};
}

const ADAPTER_FACTORIES = {
	mysql: mysqlAdapter,
	postgres: postgresAdapter,
	sqlite: sqliteAdapter,
	sqlserver: mssqlAdapter,
	mongodb: mongoAdapter,
	redis: redisAdapter,
};

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

const DRIVER_MODULE = {
	mysql: "mysql2", postgres: "pg", sqlite: "node:sqlite",
	sqlserver: "mssql", mongodb: "mongodb", redis: "ioredis",
};

export default {
	activate(host) {
		const st = {
			conns: [], // connection config [{id,name,type,host,port,user,password,database,file,uri,redisDb}]
			runtime: new Map(), // connId → {connId, ownerId, hostId, label, adapter}
			nextConnId: 1,
			depsOk: false,
			depsInstalling: false,
			depsAvail: null,
		};

		// ---- config persistence -------------------------------------------------------
		// secrets storage：connection passwords keyed by conn id go through the host host.secrets（AES-256-GCM），
		// db-connections.json no longer persist plaintext；fall back to the old behavior when the host lacks this facility。
		// uri embedded credentials in it cannot be split reliably——still in the file，called out in a comment。
		const sec = host.secrets;

		async function loadConfig() {
			try {
				const cfg = JSON.parse(await rf(join(host.dir, CONFIG_FILE), "utf8"));
				st.conns = Array.isArray(cfg.conns) ? cfg.conns : [];
			} catch { st.conns = []; }
			if (sec?.set) {
				// one-shot migrate：historical plaintext passwords → encrypted secrets + strip from file
				let migrated = false;
				for (const c of st.conns) {
					if (c.password && c.id) {
						try { sec.set(`conn:${c.id}`, String(c.password)); } catch {}
						delete c.password;
						migrated = true;
					}
				}
				if (migrated) { try { await saveConfig(); } catch {} host.log("Migrated connection passwords into encrypted storage"); }
			}
			if (sec?.get) {
				// refill the in-memory copy（the driver needs the real password to connect）
				for (const c of st.conns) if (!c.password && c.id) c.password = sec.get(`conn:${c.id}`);
			}
		}
		async function saveConfig() {
			const conns = sec ? st.conns.map((c) => ({ ...c, password: undefined })) : st.conns; // persist after stripping passwords
			await wf(join(host.dir, CONFIG_FILE), JSON.stringify({ conns }, null, "\t"), "utf8");
		}
		/** Save/clear a connection password secret (truthy → write; explicit null → delete). */
		function storeConnSecret(id, pwd) {
			if (!sec || !id) return;
			try {
				if (pwd === null) sec.delete(`conn:${id}`);
				else if (pwd) sec.set(`conn:${id}`, String(pwd));
			} catch {}
		}

		function publicConn(c) {
			return {
				id: c.id, name: c.name, type: c.type,
				host: c.host, port: c.port, user: c.user,
				database: c.database ?? "", file: c.file ?? "",
				hasPass: Boolean(c.password), hasUri: Boolean(c.uri),
				redisDb: c.redisDb ?? 0,
			};
		}

		function publicState() {
			return {
				depsOk: st.depsOk,
				depsInstalling: st.depsInstalling,
				depsAvail: st.depsAvail,
				types: DB_TYPES,
				conns: st.conns.map(publicConn),
				active: [...st.runtime.values()].map((r) => ({ connId: r.connId, hostId: r.hostId, label: r.label })),
			};
		}

		function broadcastAll() { host.broadcast({ kind: "state", state: publicState() }); }

		function respond(action, reqId, clientId, extra = {}) {
			host.sendTo(clientId, { res: true, reqId, ok: true, action, ...extra });
		}
		function fail(action, reqId, clientId, error) {
			host.sendTo(clientId, { res: true, reqId, ok: false, action, error: String(error?.message ?? error) });
		}

		// ---- auto-install deps -----------------------------------------------------
		async function loadDeps() {
			// probe availability per driver（partial installs still work for the matching types）
			const results = await Promise.all(Object.entries(DRIVER_MODULE).map(async ([_type, name]) => {
				try { await import(name); return [name, true]; }
				catch { return [name, false]; }
			}));
			st.depsAvail = Object.fromEntries(results);
			st.depsOk = Object.values(st.depsAvail).every(Boolean);
			if (!st.depsOk) host.log("driver availability:", JSON.stringify(st.depsAvail));
			return st.depsOk;
		}

		/** Lazy re-probe: after a manual npm install, drivers are recognized without restart (imports are cached). */
		async function refreshDeps() {
			if (!st.depsOk && !st.depsInstalling) await loadDeps();
		}

		function resolveNpmCli() {
			try { return createRequire(import.meta.url).resolve("npm/bin/npm-cli.js"); }
			catch { return null; }
		}

		function installDeps(auto = false) {
			if (st.depsInstalling || st.depsOk) return;
			if (auto && process.env.PI_DB_CLIENT_NO_AUTOINSTALL) {
				host.log("auto install disabled by PI_DB_CLIENT_NO_AUTOINSTALL");
				return;
			}
			st.depsInstalling = true;
			broadcastAll();
			host.log(`installing deps: ${DEPS.join(" ")}${auto ? " (auto)" : ""}`);
			host.notify("info", "🗄️ Database plugin: installing drivers (first time may take a few minutes)…");
			const npmCli = resolveNpmCli();
			const args = ["--prefix", host.dir, "install", ...DEPS, "--no-audit", "--no-fund"];
			const child = npmCli
				? spawn(process.execPath, [npmCli, ...args], { stdio: ["ignore", "ignore", "pipe"] })
				: spawn("npm", args, { stdio: ["ignore", "ignore", "pipe"], shell: process.platform === "win32" });
			let errTail = "";
			child.stderr?.on("data", (d) => { errTail = (errTail + d.toString()).slice(-1000); });
			let done = false;
			child.on("error", (err) => finish(false, err.message));
			child.on("exit", (code) => finish(code === 0, `npm exit ${code}`));
			async function finish(ok, why) {
				if (done) return;
				done = true;
				st.depsInstalling = false;
				if (ok) await loadDeps();
				// Take the last non-empty stderr line (usually the npm error summary), not a bare exit code
				const lastErr = errTail.split(/\r?\n/).filter(Boolean).pop() ?? "";
				host.notify(
					ok ? "success" : "error",
					ok
						? "🗄️ Database plugin drivers installed"
						: `🗄️ Database plugin driver install failed（${why}${lastErr ? `：${lastErr}` : ""}）——please run this in the plugin directory：npm install ${DEPS.join(" ")}`,
				);
				broadcastAll();
			}
		}

		// ---- connection management ---------------------------------------------------------
		function getRuntime(connId) {
			const r = st.runtime.get(connId);
			if (!r) throw new Error(`Connection does not exist or is closed：${connId}`);
			return r;
		}

		function dropRuntime(r, reason) {
			if (!st.runtime.has(r.connId)) return;
			st.runtime.delete(r.connId);
			void Promise.resolve(r.adapter?.close?.()).catch(() => {});
			host.sendTo(r.ownerId, { event: "conn_closed", connId: r.connId, reason: reason ?? "" });
			broadcastAll();
		}

		async function openAdapter(cfg) {
			const factory = ADAPTER_FACTORIES[cfg.type];
			if (!factory) throw new Error(`Unknown database type：${cfg.type}`);
			await refreshDeps();
			const driver = DRIVER_MODULE[cfg.type];
			if (st.depsAvail?.[driver] === false) {
				throw new Error(`driver ${driver} not installed——click Install drivers on the left, or run in the plugin directory npm install ${driver}`);
			}
			try {
				return await factory(cfg);
			} catch (err) {
				if (/Cannot find|ERR_MODULE_NOT_FOUND/.test(String(err?.message ?? err))) {
					throw new Error(`driver ${driver} not installed——click Install drivers on the left, or run in the plugin directory npm install ${driver}`);
				}
				throw err;
			}
		}

		/** Readiness gate: until config load + driver probe finish, all messages wait in queue (so a mount-time
		    state a request would read an empty list、or even overwrite config that has not loaded yet when saving） */
		let readyPromise = null;
		function ensureReady() {
			if (!readyPromise) {
				readyPromise = (async () => {
					await loadConfig();
					const ok = await loadDeps();
					broadcastAll();
					if (!ok) installDeps(true);
				})();
			}
			return readyPromise;
		}

		// ------------------------------------------------------------------
		// message routing
		// ------------------------------------------------------------------
		const off = host.onMessage(async (payload, clientId) => {
			await ensureReady();
			const msg = payload ?? {};
			const { action, reqId } = msg;

			const reply = (err, extra) =>
				err ? fail(action, reqId, clientId, err)
					: respond(action, reqId, clientId, extra ?? {});
			try {
				switch (action) {
					case "state": {
						// driver status may have changed（manual install），re-probe once before echoing
						await refreshDeps();
						return void respond(action, reqId, clientId, { state: publicState() });
					}
					case "deps_install":
						installDeps(false);
						return void respond(action, reqId, clientId, {});

					case "conns_save": {
						const c = msg.conn ?? {};
						if (!DB_TYPES[c.type]) throw new Error("Choose a database type");
						if (c.type !== "sqlite" && !String(c.host ?? "").trim()) throw new Error("Host cannot be empty");
						if (c.id) {
							const i = st.conns.findIndex((x) => x.id === c.id);
							if (i < 0) throw new Error("Connection not found");
							const old = st.conns[i];
							// Password semantics unchanged: blank = keep old; explicit null = clear (also delete secret)
							storeConnSecret(c.id, c.password === null ? null : (c.password || undefined));
							st.conns[i] = {
								...old,
								name: c.name ?? old.name,
								type: old.type, // type cannot be changed（driver semantics differ a lot）
								host: c.type !== "sqlite" ? String(c.host ?? "").trim() : old.host,
								port: Number(c.port) || old.port,
								user: c.user ?? old.user,
								// leave credentials blank = keep the old value；explicit null = clear
								password: c.password === null ? undefined : (c.password || old.password),
								database: c.database ?? old.database,
								file: c.file ?? old.file,
								uri: c.uri === null ? undefined : (c.uri || old.uri),
								redisDb: Number.isFinite(+c.redisDb) ? +c.redisDb : old.redisDb,
							};
						} else {
							if (st.conns.length >= MAX_CONNS) throw new Error(`At most ${MAX_CONNS} connections`);
							const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
							storeConnSecret(id, c.password || undefined);
							st.conns.push({
								id,
								name: String(c.name || `${DB_TYPES[c.type].label} ${c.host || c.file || ""}`).trim(),
								type: c.type,
								host: String(c.host ?? "").trim(),
								port: Number(c.port) || DB_TYPES[c.type].port,
								user: c.user ?? "",
								password: c.password ? String(c.password) : undefined,
								database: c.database ?? "",
								file: c.file ?? "",
								uri: c.uri ? String(c.uri).trim() : undefined,
								redisDb: Number(c.redisDb) || 0,
							});
						}
						await saveConfig();
						broadcastAll();
						return void respond(action, reqId, clientId, {});
					}

					case "conns_delete": {
						await loadConfig(); // migrate + refill first if not loaded, avoid leftover orphan secrets
						const before = st.conns.length;
						st.conns = st.conns.filter((x) => x.id !== msg.id);
						if (st.conns.length === before) throw new Error("Connection not found");
						storeConnSecret(msg.id, null); // delete the secret along with the connection
						await saveConfig();
						for (const r of [...st.runtime.values()]) if (r.hostId === msg.id) dropRuntime(r, "Connection config deleted");
						broadcastAll();
						return void respond(action, reqId, clientId, {});
					}

					case "test": {
						// Form test: full conn object (leave password blank when editing to keep stored value)
						let cfg = { ...msg.conn };
						if (cfg.id) {
							const saved = st.conns.find((x) => x.id === cfg.id);
							if (saved && !cfg.password) cfg.password = saved.password;
							if (saved) cfg.type = saved.type; // type cannot be changed
						}
						cfg.port = Number(cfg.port) || DB_TYPES[cfg.type]?.port || 0;
						const adapter = await openAdapter(cfg);
						await adapter.close();
						return void respond(action, reqId, clientId, {});
					}

					case "connect": {
						const cfg = st.conns.find((x) => x.id === msg.id);
						if (!cfg) throw new Error("Connection not found");
						for (const r of st.runtime.values()) {
							if (r.hostId === cfg.id) { // already open → reuse
								return void respond(action, reqId, clientId, { connId: r.connId, label: r.label, kind: r.adapter.kind, dialect: r.adapter.dialect });
							}
						}
						if (st.runtime.size >= MAX_RUNTIME) throw new Error(`At most ${MAX_RUNTIME} connections open at once; disconnect some first`);
						const adapter = await openAdapter(cfg);
						const connId = `c${st.nextConnId++}`;
						const r = { connId, ownerId: clientId, hostId: cfg.id, label: cfg.name || cfg.host || cfg.file || cfg.type, adapter };
						st.runtime.set(connId, r);
						broadcastAll();
						return void respond(action, reqId, clientId, { connId, label: r.label, kind: adapter.kind, dialect: adapter.dialect });
					}

					case "disconnect": {
						dropRuntime(getRuntime(msg.connId), "Disconnected by user");
						return void respond(action, reqId, clientId, {});
					}

					// ---- Shared SQL/NoSQL browse ----
					case "dbs_list": {
						const r = getRuntime(msg.connId);
						return void respond(action, reqId, clientId, { databases: await withTimeout(r.adapter.listDatabases(), OP_TIMEOUT_MS, "query") });
					}
					case "tables_list": {
						const r = getRuntime(msg.connId);
						const tables = await withTimeout(r.adapter.listTables(msg.db), OP_TIMEOUT_MS, "query");
						tables.sort((a, b) => a.name.localeCompare(b.name));
						return void respond(action, reqId, clientId, { tables });
					}
					case "describe": {
						const r = getRuntime(msg.connId);
						const d = await withTimeout(r.adapter.describeTable(msg.db, msg.table), OP_TIMEOUT_MS, "query");
						return void respond(action, reqId, clientId, { describe: d });
					}
					case "page": {
						const r = getRuntime(msg.connId);
						const grid = await withTimeout(r.adapter.selectPage(msg.db, msg.table, {
							offset: msg.offset, limit: msg.limit,
							orderBy: msg.orderBy, dir: msg.dir, filter: msg.filter,
						}), OP_TIMEOUT_MS, "query");
						return void respond(action, reqId, clientId, { grid });
					}
					case "query_exec": {
						const r = getRuntime(msg.connId);
						const sql = String(msg.sql ?? "");
						if (!sql.trim()) throw new Error("SQL is empty");
						const grid = await withTimeout(r.adapter.query(msg.db, sql), OP_TIMEOUT_MS, "query");
						return void respond(action, reqId, clientId, { grid });
					}

					// ---- Row edit (SQL) ----
					case "row_update": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.updateRow) throw new Error("This data source does not support row edits");
						const out = await withTimeout(
							r.adapter.updateRow(msg.db, msg.table, String(msg.pk?.col ?? ""), msg.pk?.val, msg.changes ?? {}),
							OP_TIMEOUT_MS, "write");
						return void respond(action, reqId, clientId, out);
					}
					case "row_insert": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.insertRow) throw new Error("This data source does not support inserting rows");
						const out = await withTimeout(r.adapter.insertRow(msg.db, msg.table, msg.values ?? {}), OP_TIMEOUT_MS, "write");
						return void respond(action, reqId, clientId, out);
					}
					case "row_delete": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.deleteRow) throw new Error("This data source does not support deleting rows");
						const out = await withTimeout(r.adapter.deleteRow(msg.db, msg.table, String(msg.pk?.col ?? ""), msg.pk?.val), OP_TIMEOUT_MS, "write");
						return void respond(action, reqId, clientId, out);
					}

					// ---- MongoDB document edit ----
					case "doc_save": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.docSave) throw new Error("This data source does not support document edits");
						const out = await withTimeout(r.adapter.docSave(msg.db, msg.table, msg.id, msg.docJson), OP_TIMEOUT_MS, "write");
						return void respond(action, reqId, clientId, out);
					}
					case "doc_insert": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.docInsert) throw new Error("This data source does not support inserting documents");
						const out = await withTimeout(r.adapter.docInsert(msg.db, msg.table, msg.docJson), OP_TIMEOUT_MS, "write");
						return void respond(action, reqId, clientId, out);
					}
					case "doc_delete": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.docDelete) throw new Error("This data source does not support deleting documents");
						const out = await withTimeout(r.adapter.docDelete(msg.db, msg.table, msg.id), OP_TIMEOUT_MS, "write");
						return void respond(action, reqId, clientId, out);
					}

					// ---- Redis-only ----
					case "redis_scan": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.scanKeys) throw new Error("This connection is not Redis");
						const out = await withTimeout(r.adapter.scanKeys(msg.pattern, msg.cursor, msg.count), OP_TIMEOUT_MS, "query");
						return void respond(action, reqId, clientId, out);
					}
					case "redis_key": {
						const r = getRuntime(msg.connId);
						const detail = await withTimeout(r.adapter.keyDetail(String(msg.key ?? "")), OP_TIMEOUT_MS, "query");
						return void respond(action, reqId, clientId, { detail });
					}
					case "redis_del": {
						const r = getRuntime(msg.connId);
						const n = await withTimeout(r.adapter.delKey(String(msg.key ?? "")), OP_TIMEOUT_MS, "Delete");
						return void respond(action, reqId, clientId, { deleted: Number(n) || 0 });
					}
					case "redis_key_set": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.keySet) throw new Error("This connection is not Redis or does not support key edits");
						const out = await withTimeout(r.adapter.keySet(String(msg.key ?? ""), String(msg.value ?? "")), OP_TIMEOUT_MS, "write");
						return void respond(action, reqId, clientId, out);
					}
					case "redis_cmd": {
						const r = getRuntime(msg.connId);
						const out = await withTimeout(r.adapter.runCmd(String(msg.cmd ?? "")), OP_TIMEOUT_MS, "command");
						return void respond(action, reqId, clientId, { output: cellVal(out) });
					}
					case "redis_meta": {
						const r = getRuntime(msg.connId);
						const meta = await withTimeout(r.adapter.meta(), OP_TIMEOUT_MS, "query");
						return void respond(action, reqId, clientId, { meta });
					}

					default:
						return void fail(action, reqId, clientId, `Unknown action ${action}`);
				}
			} catch (err) {
				fail(action, reqId, clientId, err);
			}
		});

		void ensureReady();

		// on new client attach, actively push the full state（server is the single source of truth）；
		// host.onAttach does not exist on older hosts——optional-chaining compatible，the client can still pull as a fallback
		const offAttach = host.onAttach?.((clientId) => {
			void ensureReady().then(() => {
				host.sendTo(clientId, { kind: "state", state: publicState() });
			});
		});

		host.log("activated");
		return () => {
			off();
			try { offAttach?.(); } catch {}
			for (const r of st.runtime.values()) {
				try { void r.adapter?.close?.(); } catch { /* ignore */ }
			}
			st.runtime.clear();
		};
	},
};
