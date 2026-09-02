import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewPayload } from "../../server/review/types.js";
import { runGit } from "../../server/review/git.js";
import {
	assertSafeReviewId,
	buildReviewMarkdown,
	pendingReviewsMarkdown,
	setReviewStatus,
	setPendingReviewsStatus,
	writeReviewArtifacts,
	applyPendingPrompt,
	pendingReviewSummary,
	listReviewAnnotations,
	reviewFolderPath,
} from "../../server/review/review.js";

const payload: ReviewPayload = {
	version: 1,
	id: "2026-08-27T12-00-00-000Z",
	status: "pending",
	repo: "/tmp/demo",
	mode: "working-tree",
	base: { ref: "HEAD", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
	head: { ref: "feature", sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", dirty: true },
	createdAt: "2026-08-27T12:00:00.000Z",
	comments: [
		{
			id: "c1",
			path: "src/foo.ts",
			side: "RIGHT",
			line: 12,
			lineText: "const x = 1;",
			contextBefore: ["export function run() {"],
			contextAfter: ["  return x;", "}"],
			hunkHeader: "@@ -8,6 +10,8 @@ export function run() {",
			body: "Use makeX() instead of a raw literal.",
		},
		{
			id: "c2",
			path: "src/gone.ts",
			side: "LEFT",
			line: 4,
			lineText: "legacy();",
			contextBefore: [],
			contextAfter: [],
			hunkHeader: "@@ -1,4 +0,0 @@",
			body: "Don't delete this until the caller is gone.",
		},
	],
};

describe("buildReviewMarkdown", () => {
	it("produces a prompt an agent can apply without a specific harness", () => {
		const markdown = buildReviewMarkdown(payload);

		expect(markdown).toContain("# Code review comments to apply");
		expect(markdown).toContain("Mode: working-tree");
		expect(markdown).toContain("`src/foo.ts` (new file, line 12)");
		expect(markdown).toContain("const x = 1;");
		expect(markdown).toContain("Use makeX() instead of a raw literal.");
		expect(markdown).toContain("`src/gone.ts` (old file, line 4)");
		expect(markdown).toContain("locate the code by file path and the quoted text");
	});

	it("formats whole-file comments without a quoted line", () => {
		const markdown = buildReviewMarkdown({
			...payload,
			comments: [
				{
					id: "c-file",
					path: "src/new-helper.ts",
					scope: "file",
					side: "RIGHT",
					line: 0,
					lineText: "",
					contextBefore: [],
					contextAfter: [],
					hunkHeader: "",
					body: "This new file should be a util in another module.",
				},
			],
		});
		expect(markdown).toContain("`src/new-helper.ts` (whole file)");
		expect(markdown).toContain("This comment applies to the entire file");
		expect(markdown).toContain("This new file should be a util in another module.");
		expect(markdown).not.toContain("Quoted line:");
	});

	it("formats range comments with a quoted block", () => {
		const markdown = buildReviewMarkdown({
			...payload,
			comments: [
				{
					id: "c-range",
					path: "src/foo.ts",
					scope: "range",
					side: "RIGHT",
					line: 10,
					endLine: 12,
					lineText: "const a = 1;",
					lineTexts: ["const a = 1;", "const b = 2;", "return a + b;"],
					contextBefore: ["export function sum() {"],
					contextAfter: ["}"],
					hunkHeader: "@@ -8,6 +10,8 @@ export function sum() {",
					body: "Extract these three lines into add().",
				},
			],
		});
		expect(markdown).toContain("`src/foo.ts` (new file, lines 10–12)");
		expect(markdown).toContain("Quoted block:");
		expect(markdown).toContain("const b = 2;");
		expect(markdown).toContain("Extract these three lines into add().");
	});

	it("includes nearby context when it exists", () => {
		const markdown = buildReviewMarkdown(payload);
		expect(markdown).toContain("export function run() {");
		expect(markdown).toContain("return x;");
	});
});

describe("writeReviewArtifacts", () => {
	it("appends each review to the index instead of overwriting a LATEST file", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "local-review-review-"));
		const first = await writeReviewArtifacts(dir, payload);
		const secondPayload: ReviewPayload = {
			...payload,
			id: "2026-08-27T13-00-00-000Z",
			createdAt: "2026-08-27T13:00:00.000Z",
			comments: [payload.comments[0]!],
		};
		const second = await writeReviewArtifacts(dir, secondPayload);

		const index = JSON.parse(await readFile(first.indexPath, "utf8")) as {
			reviews: Array<{ id: string; status: string; commentCount: number }>;
		};
		const gitignore = await readFile(path.join(dir, ".gitignore"), "utf8");
		const firstJson = JSON.parse(await readFile(first.jsonPath, "utf8")) as ReviewPayload;
		const secondJson = JSON.parse(await readFile(second.jsonPath, "utf8")) as ReviewPayload;

		expect(gitignore).toContain(".local-review/");
		expect(index.reviews).toEqual([
			expect.objectContaining({ id: payload.id, status: "pending", commentCount: 2 }),
			expect.objectContaining({ id: secondPayload.id, status: "pending", commentCount: 1 }),
		]);
		expect(firstJson.comments).toHaveLength(2);
		expect(secondJson.comments).toHaveLength(1);
		await expect(readFile(path.join(dir, ".local-review", "LATEST.md"), "utf8")).rejects.toThrow();
	});

	it("marks a review applied in both the index and the review folder", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "local-review-review-"));
		await writeReviewArtifacts(dir, payload);
		await setReviewStatus(dir, payload.id, "applied");

		const index = JSON.parse(await readFile(path.join(dir, ".local-review", "index.json"), "utf8")) as {
			reviews: Array<{ status: string }>;
		};
		const stored = JSON.parse(
			await readFile(path.join(dir, ".local-review", "reviews", payload.id, "review.json"), "utf8"),
		) as ReviewPayload;

		expect(index.reviews[0]?.status).toBe("applied");
		expect(stored.status).toBe("applied");
		const markdown = await readFile(
			path.join(dir, ".local-review", "reviews", payload.id, "REVIEW.md"),
			"utf8",
		);
		expect(markdown).toContain("Status: applied");
	});

	it("marks pending reviews dismissed and hides them from the chip summary", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "local-review-review-"));
		await writeReviewArtifacts(dir, payload);
		const n = await setPendingReviewsStatus(dir, "dismissed");
		expect(n).toBe(1);

		const summary = await pendingReviewSummary(dir);
		expect(summary.pending).toHaveLength(0);
		const annotations = await listReviewAnnotations(dir);
		expect(annotations).toHaveLength(0);
		const stored = JSON.parse(
			await readFile(path.join(dir, ".local-review", "reviews", payload.id, "review.json"), "utf8"),
		) as ReviewPayload;
		expect(stored.status).toBe("dismissed");
	});
});

describe("pendingReviewsMarkdown", () => {
	it("joins pending reviews and skips applied ones", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "local-review-review-"));
		await writeReviewArtifacts(dir, payload);
		const later: ReviewPayload = {
			...payload,
			id: "2026-08-27T14-00-00-000Z",
			createdAt: "2026-08-27T14:00:00.000Z",
		};
		await writeReviewArtifacts(dir, later);
		await setReviewStatus(dir, payload.id, "applied");

		const markdown = await pendingReviewsMarkdown(dir);
		expect(markdown).toContain(later.id);
		expect(markdown).not.toContain(`Review id: \`${payload.id}\``);
	});
});

describe("applyPendingPrompt", () => {
	it("wraps pending markdown with apply instructions", () => {
		const prompt = applyPendingPrompt("# Code review comments to apply\nUse makeX().");
		expect(prompt).toContain("apply-local-review");
		expect(prompt).toContain("local_review_mark_applied");
		expect(prompt).toContain("Use makeX().");
		expect(prompt).toContain("Do not commit unless I ask.");
	});
});

describe("pendingReviewSummary", () => {
	it("counts only pending reviews", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "local-review-review-"));
		await writeReviewArtifacts(dir, payload);
		const later: ReviewPayload = {
			...payload,
			id: "2026-08-27T14-00-00-000Z",
			createdAt: "2026-08-27T14:00:00.000Z",
			comments: [payload.comments[0]!],
		};
		await writeReviewArtifacts(dir, later);
		await setReviewStatus(dir, payload.id, "applied");

		const summary = await pendingReviewSummary(dir);
		expect(summary.pending).toHaveLength(1);
		expect(summary.pending[0]?.id).toBe(later.id);
		expect(summary.commentCount).toBe(1);
	});
});

describe("listReviewAnnotations", () => {
	it("overlays pending and applied comments with review status", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "local-review-review-"));
		await writeReviewArtifacts(dir, payload);
		await setReviewStatus(dir, payload.id, "applied");

		const annotations = await listReviewAnnotations(dir);
		expect(annotations).toHaveLength(2);
		expect(annotations.every((a) => a.reviewId === payload.id)).toBe(true);
		expect(annotations.every((a) => a.status === "applied")).toBe(true);
		expect(annotations.map((a) => a.path)).toEqual(["src/foo.ts", "src/gone.ts"]);
	});

	it("uses the index status even if review.json is stale", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "local-review-review-"));
		await writeReviewArtifacts(dir, payload);
		const jsonPath = path.join(dir, ".local-review", "reviews", payload.id, "review.json");
		const stored = JSON.parse(await readFile(jsonPath, "utf8")) as ReviewPayload;
		stored.status = "applied";
		await writeFile(jsonPath, `${JSON.stringify(stored, null, 2)}\n`);
		const indexPath = path.join(dir, ".local-review", "index.json");
		const index = JSON.parse(await readFile(indexPath, "utf8")) as {
			reviews: Array<{ status: string }>;
		};
		expect(index.reviews[0]?.status).toBe("pending");
		const annotations = await listReviewAnnotations(dir);
		expect(annotations.every((a) => a.status === "pending")).toBe(true);
	});
});

describe("resolveStoreRoot / subdirectory cwd", () => {
	it("writes and reads reviews at the git toplevel when cwd is a subdirectory", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "local-review-subdir-"));
		await runGit(["init", "-b", "main"], dir);
		await mkdir(path.join(dir, "src"), { recursive: true });
		const nested = path.join(dir, "src");

		await writeReviewArtifacts(nested, payload);

		const indexPath = path.join(dir, ".local-review", "index.json");
		const index = JSON.parse(await readFile(indexPath, "utf8")) as {
			reviews: Array<{ id: string }>;
		};
		expect(index.reviews[0]?.id).toBe(payload.id);
		await expect(
			readFile(path.join(nested, ".local-review", "index.json"), "utf8"),
		).rejects.toThrow();

		const summary = await pendingReviewSummary(nested);
		expect(summary.pending).toHaveLength(1);
		expect(summary.commentCount).toBe(2);
	});
});

describe("review path containment", () => {
	it("rejects review ids that would escape the store", () => {
		expect(() => assertSafeReviewId("../escape")).toThrow(/Invalid review id/);
		expect(() => assertSafeReviewId("foo/bar")).toThrow(/Invalid review id/);
		expect(() => assertSafeReviewId("foo\\bar")).toThrow(/Invalid review id/);
		expect(assertSafeReviewId("2026-08-27T12-00-00-000Z")).toBe("2026-08-27T12-00-00-000Z");
	});

	it("rejects entry.dir values outside .local-review/", () => {
		const root = "/tmp/workspace";
		expect(() => reviewFolderPath(root, "..")).toThrow(/outside/);
		expect(() => reviewFolderPath(root, "/etc")).toThrow(/outside/);
		expect(() => reviewFolderPath(root, ".local-review/reviews/../../../etc")).toThrow(/outside/);
		expect(reviewFolderPath(root, ".local-review/reviews/2026-08-27T12-00-00-000Z")).toBe(
			path.resolve(root, ".local-review", "reviews", "2026-08-27T12-00-00-000Z"),
		);
	});

	it("does not follow a tampered index dir outside the store", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "local-review-escape-"));
		await writeReviewArtifacts(dir, payload);
		const secret = path.join(dir, "secret.txt");
		await writeFile(secret, "do not touch\n", "utf8");
		const indexPath = path.join(dir, ".local-review", "index.json");
		const index = JSON.parse(await readFile(indexPath, "utf8")) as {
			reviews: Array<{ dir: string }>;
		};
		index.reviews[0]!.dir = "secret.txt";
		await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

		expect(await listReviewAnnotations(dir)).toEqual([]);
		expect(await pendingReviewsMarkdown(dir)).toBe(
			"No pending Local Review comments in this workspace.",
		);
		await expect(setReviewStatus(dir, payload.id, "applied")).rejects.toThrow(/outside/);
		expect(await readFile(secret, "utf8")).toBe("do not touch\n");
	});

	it("refuses to write a review with an escaping id", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "local-review-badid-"));
		await expect(
			writeReviewArtifacts(dir, { ...payload, id: "../escape" }),
		).rejects.toThrow(/Invalid review id/);
	});
});