import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveRepoRoot } from "./git.js";
import type {
	ReviewAnnotation,
	ReviewComment,
	ReviewIndex,
	ReviewPayload,
	ReviewStatus,
} from "./types.js";

const REVIEW_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Git toplevel when `cwd` is inside a repo; otherwise the resolved path.
 *  Submit, chip, apply, and agent tools must share this so a subdirectory
 *  cwd still reads/writes `<repo>/.local-review/`. */
export async function resolveStoreRoot(cwd: string): Promise<string> {
	try {
		return await resolveRepoRoot(cwd);
	} catch {
		return path.resolve(cwd);
	}
}

export function assertSafeReviewId(id: string): string {
	if (!id || !REVIEW_ID_RE.test(id) || id.includes("..")) {
		throw new Error(`Invalid review id: ${id}`);
	}
	return id;
}

/** Resolve `entry.dir` and refuse anything outside `<repo>/.local-review/`. */
export function reviewFolderPath(repoRoot: string, entryDir: string): string {
	const storeRoot = path.resolve(repoRoot, ".local-review");
	const resolved = path.resolve(repoRoot, entryDir);
	if (!isPathInside(storeRoot, resolved)) {
		throw new Error(`Review dir is outside .local-review/: ${entryDir}`);
	}
	return resolved;
}

function isPathInside(parent: string, child: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

export function reviewIdFromCreatedAt(createdAt: string): string {
	return createdAt.replace(/[:.]/g, "-");
}

export function buildReviewMarkdown(payload: ReviewPayload): string {
	const lines: string[] = [
		"# Code review comments to apply",
		"",
		"A human reviewed a local diff and left the comments below. Apply every comment.",
		"",
		"## Snapshot",
		"",
		`- Review id: \`${payload.id}\``,
		`- Status: ${payload.status}`,
		`- Repo: \`${payload.repo}\``,
		`- Mode: ${payload.mode}`,
		`- Base: \`${payload.base.ref}\` @ \`${payload.base.sha.slice(0, 12)}\``,
		`- Head: \`${payload.head.ref}\` @ \`${payload.head.sha.slice(0, 12)}\`${payload.head.dirty ? " (working tree dirty)" : ""}`,
		`- Submitted: ${payload.createdAt}`,
		"",
		"## Rules",
		"",
		"1. Apply every comment. Do not skip any.",
		"2. Line and range comments: locate the code by file path and the quoted text, not by line number alone — numbers may have shifted.",
		"3. File comments apply to the **whole file** (move, merge into another module, delete, rename). Do not look for a specific line.",
		"4. Only change what the comments request. Do not drive-by refactor unrelated code.",
		"5. After editing, re-read each commented region (or the whole file, for file comments) and confirm the request is addressed.",
		"6. Then mark this review `applied`: call `local_review_mark_applied` with this review id, or use Mark applied in the UI. Do not hand-edit JSON.",
		"",
		"---",
		"",
	];

	payload.comments.forEach((comment, index) => {
		lines.push(...formatComment(comment, index + 1));
		lines.push("");
	});

	return lines.join("\n");
}

function commentScope(comment: ReviewComment): "line" | "range" | "file" {
	if (comment.scope === "file" || comment.scope === "range" || comment.scope === "line") {
		return comment.scope;
	}
	if (comment.endLine != null && comment.endLine !== comment.line) return "range";
	return "line";
}

function formatComment(comment: ReviewComment, index: number): string[] {
	const scope = commentScope(comment);
	if (scope === "file") {
		return [
			`## ${index}. \`${comment.path}\` (whole file)`,
			"",
			"This comment applies to the entire file, not a specific line. Typical uses: the file is in the wrong place, should be a function in another module, should be deleted, or should be renamed.",
			"",
			"Comment:",
			"",
			comment.body.trim(),
			"",
		];
	}

	const sideLabel = comment.side === "LEFT" ? "old file" : "new file";
	const start = Math.min(comment.line, comment.endLine ?? comment.line);
	const end = Math.max(comment.line, comment.endLine ?? comment.line);
	const where =
		scope === "range"
			? `${sideLabel}, lines ${start}–${end}`
			: `${sideLabel}, line ${comment.line}`;
	const quotedBlock =
		scope === "range" && comment.lineTexts && comment.lineTexts.length > 0
			? comment.lineTexts.join("\n")
			: comment.lineText;
	const quoted = fence(quotedBlock);
	const contextLines =
		scope === "range" && comment.lineTexts && comment.lineTexts.length > 0
			? [...comment.contextBefore, ...comment.lineTexts, ...comment.contextAfter]
			: [...comment.contextBefore, comment.lineText, ...comment.contextAfter];
	const contextFence = contextLines.length > 1 ? fence(contextLines.join("\n")) : null;

	const block = [
		`## ${index}. \`${comment.path}\` (${where})`,
		"",
		`Hunk: \`${comment.hunkHeader}\``,
		"",
		scope === "range" ? "Quoted block:" : "Quoted line:",
		quoted,
		"",
	];

	if (contextFence) {
		block.push("Nearby context:", contextFence, "");
	}

	block.push("Comment:", "", comment.body.trim(), "");
	return block;
}

function fence(body: string): string {
	// REVIEW.md is frequently read inside git diffs where tab width varies wildly.
	// Expanding tabs here keeps quoted code aligned and makes reviews easier to read.
	const normalized = body.replace(/\t/g, "  ");
	const ticks = normalized.includes("```") ? "````" : "```";
	return `${ticks}\n${normalized}\n${ticks}`;
}

export async function readReviewIndex(cwd: string): Promise<ReviewIndex> {
	return readIndexAt(await resolveStoreRoot(cwd));
}

async function readIndexAt(repoRoot: string): Promise<ReviewIndex> {
	const indexPath = path.join(repoRoot, ".local-review", "index.json");
	try {
		const raw = await readFile(indexPath, "utf8");
		const parsed = JSON.parse(raw) as ReviewIndex;
		if (parsed.version === 1 && Array.isArray(parsed.reviews)) {
			return parsed;
		}
	} catch {
		/* missing or invalid index */
	}
	return { version: 1, reviews: [] };
}

export async function writeReviewArtifacts(
	cwd: string,
	payload: Omit<ReviewPayload, "id" | "status"> & Partial<Pick<ReviewPayload, "id" | "status">>,
): Promise<{
	id: string;
	dir: string;
	jsonPath: string;
	markdownPath: string;
	indexPath: string;
	markdown: string;
}> {
	const repoRoot = await resolveStoreRoot(cwd);
	const id = assertSafeReviewId(payload.id ?? reviewIdFromCreatedAt(payload.createdAt));
	const stored: ReviewPayload = {
		...payload,
		id,
		status: payload.status ?? "pending",
	};
	const relativeDir = path.posix.join(".local-review", "reviews", id);
	const dir = reviewFolderPath(repoRoot, relativeDir);
	await mkdir(dir, { recursive: true });

	const markdown = buildReviewMarkdown(stored);
	const jsonPath = path.join(dir, "review.json");
	const markdownPath = path.join(dir, "REVIEW.md");
	const indexPath = path.join(repoRoot, ".local-review", "index.json");

	const index = await readIndexAt(repoRoot);
	const entry = {
		id,
		createdAt: stored.createdAt,
		dir: relativeDir,
		status: stored.status,
		commentCount: stored.comments.length,
	};
	const existing = index.reviews.findIndex((review) => review.id === id);
	if (existing >= 0) {
		index.reviews[existing] = entry;
	} else {
		index.reviews.push(entry);
	}

	await Promise.all([
		writeFile(jsonPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8"),
		writeFile(markdownPath, markdown, "utf8"),
		writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8"),
		ensureGitignored(repoRoot),
	]);

	return { id, dir, jsonPath, markdownPath, indexPath, markdown };
}

export async function pendingReviewsMarkdown(cwd: string): Promise<string> {
	const repoRoot = await resolveStoreRoot(cwd);
	const index = await readIndexAt(repoRoot);
	const pending = index.reviews.filter((review) => review.status === "pending");
	if (pending.length === 0) {
		return "No pending Local Review comments in this workspace.";
	}
	const parts: string[] = [];
	for (const entry of pending) {
		try {
			const folder = reviewFolderPath(repoRoot, entry.dir);
			parts.push(await readFile(path.join(folder, "REVIEW.md"), "utf8"));
		} catch {
			/* skip unreadable or escaped review folders */
		}
	}
	if (parts.length === 0) {
		return "No pending Local Review comments in this workspace.";
	}
	return parts.join("\n\n---\n\n");
}

export function applyPendingPrompt(markdown: string): string {
	return [
		"Apply the pending Local Review comments below.",
		"Follow the apply-local-review skill: match line/range comments by file path and quoted text, not line numbers. File comments apply to the whole file.",
		"Only change what the comments request. After each review is implemented, call local_review_mark_applied with that review id.",
		"Do not commit unless I ask.",
		"",
		markdown,
	].join("\n");
}

export async function pendingReviewSummary(cwd: string): Promise<{
	pending: ReviewIndex["reviews"];
	commentCount: number;
}> {
	const index = await readReviewIndex(cwd);
	const pending = index.reviews.filter((review) => review.status === "pending");
	return {
		pending,
		commentCount: pending.reduce((sum, review) => sum + review.commentCount, 0),
	};
}

export async function listReviewAnnotations(cwd: string): Promise<ReviewAnnotation[]> {
	const repoRoot = await resolveStoreRoot(cwd);
	const index = await readIndexAt(repoRoot);
	const out: ReviewAnnotation[] = [];
	for (const entry of index.reviews) {
		if (entry.status === "dismissed") continue;
		try {
			const folder = reviewFolderPath(repoRoot, entry.dir);
			const stored = JSON.parse(await readFile(path.join(folder, "review.json"), "utf8")) as ReviewPayload;
			for (const comment of stored.comments) {
				out.push({ ...comment, reviewId: entry.id, status: entry.status });
			}
		} catch {
			/* skip unreadable or escaped review folders */
		}
	}
	return out;
}

export async function setReviewStatus(
	cwd: string,
	id: string,
	status: ReviewStatus,
): Promise<void> {
	const repoRoot = await resolveStoreRoot(cwd);
	const index = await readIndexAt(repoRoot);
	const entry = index.reviews.find((review) => review.id === id);
	if (!entry) {
		throw new Error(`Unknown review id: ${id}`);
	}
	await writeReviewStatus(repoRoot, index, entry, status);
}

/** Mark every pending review applied or dismissed. Returns how many changed. */
export async function setPendingReviewsStatus(
	cwd: string,
	status: Exclude<ReviewStatus, "pending">,
): Promise<number> {
	const repoRoot = await resolveStoreRoot(cwd);
	const index = await readIndexAt(repoRoot);
	const pending = index.reviews.filter((review) => review.status === "pending");
	for (const entry of pending) {
		await writeReviewStatus(repoRoot, index, entry, status);
	}
	return pending.length;
}

async function writeReviewStatus(
	repoRoot: string,
	index: ReviewIndex,
	entry: ReviewIndex["reviews"][number],
	status: ReviewStatus,
): Promise<void> {
	const folder = reviewFolderPath(repoRoot, entry.dir);
	entry.status = status;
	const jsonPath = path.join(folder, "review.json");
	const payload = JSON.parse(await readFile(jsonPath, "utf8")) as ReviewPayload;
	payload.status = status;
	const markdown = buildReviewMarkdown(payload);
	await Promise.all([
		writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8"),
		writeFile(path.join(folder, "REVIEW.md"), markdown, "utf8"),
		writeFile(path.join(repoRoot, ".local-review", "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8"),
	]);
}

async function ensureGitignored(repoRoot: string): Promise<void> {
	const gitignorePath = path.join(repoRoot, ".gitignore");
	let existing = "";
	try {
		existing = await readFile(gitignorePath, "utf8");
	} catch {
		existing = "";
	}
	if (/(^|[\n\r])\.local-review\/?(\n|$)/.test(existing)) {
		return;
	}
	const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
	await writeFile(gitignorePath, `${existing}${prefix}.local-review/\n`, "utf8");
}