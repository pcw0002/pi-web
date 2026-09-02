import { describe, expect, it } from "vitest";
import { extensionKey, extensionKeyCandidates, isExtensionDisabled } from "../../server/client-state.js";

describe("extensionKey", () => {
	it("package extensions use the npm spec as a stable id", () => {
		expect(
			extensionKey({
				sourceInfo: { origin: "package", source: "npm:pi-powerline-footer", path: "C:\\agent\\npm\\node_modules\\pi-powerline-footer\\dist\\index.js" },
				path: "C:\\agent\\npm\\node_modules\\pi-powerline-footer\\dist\\index.js",
			}),
		).toBe("npm:pi-powerline-footer");
	});

	it("falls back to path when sourceInfo is missing", () => {
		const p = "C:\\agent\\extensions\\my-ext\\index.ts";
		expect(extensionKey({ path: p })).toBe(p);
	});
});

describe("extensionKeyCandidates", () => {
	it("when sourceInfo is missing (SDK override phase), derives npm:<pkg> from a node_modules path", () => {
		const e = { path: "C:\\Users\\c\\.pi\\agent\\npm\\node_modules\\pi-powerline-footer\\dist\\index.js" };
		expect(extensionKeyCandidates(e)).toContain("npm:pi-powerline-footer");
		// Also keep the original path key so old data (disabled by path) still applies
		expect(extensionKeyCandidates(e)).toContain(e.path);
	});

	it("scoped packages derive @scope/name", () => {
		const e = { path: "/home/u/.pi/agent/npm/node_modules/@scope/foo/dist/index.js" };
		expect(extensionKeyCandidates(e)).toContain("npm:@scope/foo");
	});

	it("paths without node_modules do not produce an npm key", () => {
		const e = { path: "C:\\proj\\.pi\\extensions\\local.ts" };
		expect(extensionKeyCandidates(e)).toEqual([e.path]);
	});

	it("nested deps take the innermost node_modules", () => {
		const e = { path: "C:\\proj\\node_modules\\a\\node_modules\\b\\index.js" };
		expect(extensionKeyCandidates(e)).toContain("npm:b");
	});
});

describe("isExtensionDisabled", () => {
	it("panel id (npm spec) matches a package extension with no sourceInfo — regression: disabling in settings had no effect", () => {
		const e = { path: "E:\\pi\\agent\\npm\\node_modules\\pi-powerline-footer\\dist\\index.js" };
		expect(isExtensionDisabled(e, ["npm:pi-powerline-footer"])).toBe(true);
	});

	it("non-disabled extensions return false; empty list returns quickly", () => {
		const e = { path: "C:\\x\\node_modules\\other\\index.js" };
		expect(isExtensionDisabled(e, ["npm:pi-powerline-footer"])).toBe(false);
		expect(isExtensionDisabled(e, [])).toBe(false);
	});

	it("with sourceInfo, matches the original key", () => {
		const e = {
			sourceInfo: { origin: "package", source: "npm:foo", path: "C:\\m\\foo\\i.js" },
			path: "C:\\m\\foo\\i.js",
		};
		expect(isExtensionDisabled(e, ["npm:foo"])).toBe(true);
		expect(isExtensionDisabled(e, ["npm:bar"])).toBe(false);
	});
});
