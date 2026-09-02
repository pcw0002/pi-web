import { describe, expect, it } from "vitest";
import { parseGitDiff, syntheticAddedFileDiff } from "../../server/review/parseDiff.js";

const MODIFY = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 context
-deleted
+added
 still here
`;

const ADDED = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+hello
+world
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

const RENAMED = `diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
index 1111111..2222222 100644
--- a/old.ts
+++ b/new.ts
@@ -1,2 +1,2 @@
 keep
-old name
+new name
`;

const BINARY = `diff --git a/pic.png b/pic.png
new file mode 100644
index 0000000..1111111
Binary files /dev/null and b/pic.png differ
`;

describe("parseGitDiff", () => {
	it("parses a modified file with context, deletions, and additions", () => {
		const [file] = parseGitDiff(MODIFY);
		expect(file).toMatchObject({
			path: "src/foo.ts",
			status: "modified",
			binary: false,
		});
		expect(file?.hunks[0]?.lines).toEqual([
			{ type: "context", oldLine: 1, newLine: 1, content: "context" },
			{ type: "del", oldLine: 2, newLine: null, content: "deleted" },
			{ type: "add", oldLine: null, newLine: 2, content: "added" },
			{ type: "context", oldLine: 3, newLine: 3, content: "still here" },
		]);
	});

	it("parses added files against /dev/null", () => {
		const [file] = parseGitDiff(ADDED);
		expect(file).toMatchObject({
			path: "src/new.ts",
			status: "added",
			oldPath: null,
			newPath: "src/new.ts",
		});
		expect(file?.hunks[0]?.lines.map((line) => [line.type, line.newLine, line.content])).toEqual([
			["add", 1, "hello"],
			["add", 2, "world"],
		]);
	});

	it("parses deleted files", () => {
		const [file] = parseGitDiff(DELETED);
		expect(file).toMatchObject({
			path: "src/gone.ts",
			status: "deleted",
			newPath: null,
		});
		expect(file?.hunks[0]?.lines.map((line) => [line.type, line.oldLine, line.content])).toEqual([
			["del", 1, "bye"],
			["del", 2, "now"],
		]);
	});

	it("parses renames", () => {
		const [file] = parseGitDiff(RENAMED);
		expect(file).toMatchObject({
			path: "new.ts",
			status: "renamed",
			oldPath: "old.ts",
			newPath: "new.ts",
		});
	});

	it("marks binary files and skips hunks", () => {
		const [file] = parseGitDiff(BINARY);
		expect(file).toMatchObject({ path: "pic.png", status: "added", binary: true, hunks: [] });
	});

	it("returns no files for empty input", () => {
		expect(parseGitDiff("")).toEqual([]);
		expect(parseGitDiff("   \n")).toEqual([]);
	});

	it("parses multiple files in one diff", () => {
		const files = parseGitDiff(`${MODIFY}${ADDED}`);
		expect(files.map((file) => file.path)).toEqual(["src/foo.ts", "src/new.ts"]);
	});
});

describe("syntheticAddedFileDiff", () => {
	it("builds a parseable added-file diff for untracked files", () => {
		const [file] = parseGitDiff(syntheticAddedFileDiff("notes.txt", "alpha\nbeta\n"));
		expect(file?.status).toBe("added");
		expect(file?.path).toBe("notes.txt");
		expect(file?.hunks[0]?.lines.map((line) => line.content)).toEqual(["alpha", "beta"]);
	});
});