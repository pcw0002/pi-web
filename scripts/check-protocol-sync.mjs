#!/usr/bin/env node
/**
 * check-protocol-sync.mjs — verify the wire-protocol single-source setup still holds.
 *
 * web/src/types.ts is no longer a hand-maintained mirror of server/protocol.ts;
 * it re-exports everything with `export type * from "../../server/protocol"`
 * (the single source of truth). Protocol changes only touch protocol.ts, so
 * both ends stay in sync.
 *
 * This script guards two invariants:
 *   1. types.ts really is a shim (catches anyone reverting to a hand mirror);
 *   2. protocol.ts stays type-only (an `export const`/`function`/`class` etc.
 *      would break the "erase types, share no runtime" premise).
 *
 * Usage: node scripts/check-protocol-sync.mjs (runs from typecheck / CI)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const typesSrc = readFileSync(join(root, "web/src/types.ts"), "utf8");
const protocolSrc = readFileSync(join(root, "server/protocol.ts"), "utf8");

let failed = false;

// 1. shim exists
if (!/export\s+type\s+\*\s+from\s+"\.\.\/\.\.\/server\/protocol"/.test(typesSrc)) {
	console.error("✗ web/src/types.ts is no longer a re-export shim — protocol must have server/protocol.ts as the single source of truth; do not revert to a hand-maintained mirror.");
	failed = true;
} else {
	console.log("✓ types.ts is a type-only re-export shim of protocol.ts");
}

// 2. protocol.ts has no runtime exports
const runtimeExports = [
	...protocolSrc.matchAll(/^export\s+(?!type\b|interface\b)(?:declare\s+)?(const|let|var|function|class|enum)\b/gm),
].map((m) => m[1]);
if (runtimeExports.length > 0) {
	console.error(`✗ server/protocol.ts exports runtime code (${[...new Set(runtimeExports)].join(", ")}) — this file must stay type-only; the frontend must import it via a type-only re-export.`);
	failed = true;
} else {
	console.log("✓ protocol.ts stays type-only (no runtime exports)");
}

// 3. both PROTOCOL_VERSION constants match
const serverVerSrc = readFileSync(join(root, "server/protocol-version.ts"), "utf8");
const webVerSrc = readFileSync(join(root, "web/src/protocol-version.ts"), "utf8");
const mServer = serverVerSrc.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
const mWeb = webVerSrc.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
if (!mServer || !mWeb || mServer[1] !== mWeb[1]) {
	console.error(
		`✗ PROTOCOL_VERSION mismatch: server=${mServer?.[1] ?? "?"} web=${mWeb?.[1] ?? "?"} — bump both copies when changing the protocol.`,
	);
	failed = true;
} else {
	console.log(`✓ both PROTOCOL_VERSION constants match (v${mServer[1]})`);
}

if (failed) process.exit(1);
