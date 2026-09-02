import { describe, expect, it } from "vitest";
import { parseGitDiff } from "../../server/review/parseDiff.js";
import {
	collectRange,
	commentFocusKey,
	commentScope,
	draftForFile,
	draftFromRange,
	sameDraft,
} from "../../web/src/review-range.js";

const ADDED = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+hello
+world
+again
`;

const DELETED = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 1111111..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-now
`;

describe("draftFromRange", () => {
	it("builds a single-line draft", () => {
		const [file] = parseGitDiff(ADDED);
		const draft = draftFromRange(file!, "RIGHT", 2, 2);
		expect(draft).toMatchObject({
			path: "src/new.ts",
			scope: "line",
			side: "RIGHT",
			line: 2,
			lineText: "world",
		});
		expect(draft?.endLine).toBeUndefined();
		expect(draft?.lineTexts).toBeUndefined();
	});

	it("builds a range draft with quoted block and inclusive end", () => {
		const [file] = parseGitDiff(ADDED);
		const draft = draftFromRange(file!, "RIGHT", 3, 1);
		expect(draft).toMatchObject({
			scope: "range",
			line: 1,
			endLine: 3,
			lineText: "hello",
			lineTexts: ["hello", "world", "again"],
		});
	});

	it("collects only the requested side", () => {
		const [file] = parseGitDiff(DELETED);
		expect(collectRange(file!, "LEFT", 1, 2).map((row) => row.line.content)).toEqual(["bye", "now"]);
		expect(collectRange(file!, "RIGHT", 1, 2)).toEqual([]);
	});
});

describe("draftForFile", () => {
	it("anchors a whole-file comment without a line", () => {
		const [file] = parseGitDiff(ADDED);
		const draft = draftForFile(file!);
		expect(draft).toMatchObject({
			path: "src/new.ts",
			scope: "file",
			line: 0,
			lineText: "",
			hunkHeader: "",
		});
		expect(commentScope(draft)).toBe("file");
		expect(commentFocusKey(draft)).toBe("src/new.ts:file");
	});

	it("treats one file draft per path as the same composer", () => {
		const [file] = parseGitDiff(ADDED);
		const draft = draftForFile(file!);
		expect(sameDraft(draft, draft)).toBe(true);
		expect(sameDraft(draftFromRange(file!, "RIGHT", 1, 1)!, draft)).toBe(false);
	});
});
