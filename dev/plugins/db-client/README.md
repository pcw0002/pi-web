# db-client — database connection plugin

A pi-web-ui UI plugin, a slim web version of
[vscode-database-client](https://github.com/cweijan/vscode-database-client):
connection management + schema tree + table structure + paginated data browse + SQL
query editor.

## Supported databases

| Type | Driver | Default port | Notes |
| --- | --- | --- | --- |
| MySQL / MariaDB | mysql2 | 3306 | DBs/tables/views, columns+indexes+DDL (`SHOW CREATE TABLE`), paginated sort, SQL |
| PostgreSQL | pg | 5432 | public-schema tables/materialized/ordinary views, PK/indexes, cross-db browse, SQL |
| SQLite | node:sqlite (built-in) | — (file path) | Open a local .db file, no extra deps; PRAGMA schema, paging, SQL, row edit (≥ Node 22.13) |
| SQL Server | mssql | 1433 | Auto-detect schema, OFFSET/FETCH paging, SQL |
| MongoDB | mongodb | 27017 | DB/collection tree, document paging (JSON filter e.g. `{"age":{"$gt":18}}`), indexes; no SQL |
| Redis | ioredis | 6379 | Key-pattern scan, key detail (type/TTL/size/value preview), raw command line |

Drivers are **not shipped** with the package: first activate runs `npm install` into the
plugin directory (or click "Install drivers" in the left pane). Partially installed
drivers still work for those types; missing types get a friendly error on connect.

## Install / uninstall / update

```bash
# ── Install ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/dev/plugins/db-client
pi-web-ui install dev/plugins/db-client      # or a local directory (dev)
# optional: --data-dir <dir> custom data directory (default ~/.pi-web)

# ── List ──
pi-web-ui plugins                            # list installed plugins and ids

# ── Update ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/dev/plugins/db-client --force
                                             # --force overwrites = update
                                             # ⚠ back up db-connections.json in the plugin dir (connection creds)

cp -r dev/plugins/db-client ~/.pi-web/plugins/  # local dev: npm run build after src changes, then copy
                                             # Windows: %USERPROFILE%\.pi-web\plugins\db-client

# ── Uninstall ──
pi-web-ui uninstall db-client                # removes the plugin dir (including db-connections.json)
# manual: rm -rf ~/.pi-web/plugins/db-client
```

Refresh the browser to apply (a 🗄️ tab appears in the top bar).

## Features

- **Connection management**: new / edit / delete / test; credentials stored locally in
  `<dataDir>/plugins/db-client/db-connections.json`, echoed back redacted
- **Multiple connections**: up to 8 open at once, isolated; disconnects are notified
- **Data browse**: paging (first/prev/next/last), click column headers to sort, NULL
  shown muted, row counts (large tables use estimated counts)
- **Structure**: column list (type/nullable/PK/default/comment), indexes, DDL text
- **SQL editor**: Ctrl/Cmd+Enter to run, shows elapsed time and affected rows, tabular results
- **MongoDB**: collection browse + JSON-filter paginated documents
- **Row edit**: double-click a cell to change it (Enter commits / Esc cancels), hover to
  delete a row, "＋ New row" form; SQLite tables without a PK use rowid; type NULL
  (uppercase) to write SQL NULL
- **MongoDB edit**: visual JSON document edit (✎) / delete / insert; hex `_id` strings
  are restored as ObjectId
- **Redis edit**: online edit/save of string key values
- **Redis**: pattern-scan key list, TTL/type badges, values rendered by type
  (string/hash/list/set/zset/stream), arbitrary raw commands

## Protocol

Upstream `{ action, reqId, ... }`, downstream `{ res: true, reqId, ok, ... }` (matched by
reqId); events `{ event: "conn_closed", ... }` are sent to the creator; state broadcast
`{ kind: "state", state }`. See the header comment in `index.mjs`.

## Regression tests

```bash
npm run build:server
node tests/db-client-test.mjs   # port 8968, SQLite end-to-end protocol test (zero token, zero extra deps; in the smoke list)
```
