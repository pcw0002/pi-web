export type DiffMode = "working-tree" | "branch";

export type FileStatus = "added" | "deleted" | "modified" | "renamed";

export type LineType = "context" | "add" | "del";

export type CommentSide = "LEFT" | "RIGHT";

/** Where a comment is anchored. Omitted `scope` on old payloads means `"line"`. */
export type CommentScope = "line" | "range" | "file";

export interface DiffLine {
	type: LineType;
	oldLine: number | null;
	newLine: number | null;
	content: string;
}

export interface DiffHunk {
	header: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: DiffLine[];
}

export interface DiffFile {
	oldPath: string | null;
	newPath: string | null;
	path: string;
	status: FileStatus;
	binary: boolean;
	hunks: DiffHunk[];
}

export interface RepoInfo {
	root: string;
	branch: string;
	headSha: string;
	dirty: boolean;
	baseBranch: string;
	branches: string[];
}

export interface DiffResponse {
	repo: RepoInfo;
	mode: DiffMode;
	base: { ref: string; sha: string };
	head: { ref: string; sha: string; dirty: boolean };
	files: DiffFile[];
	uncommittedWarning: boolean;
}

export interface ReviewComment {
	id: string;
	path: string;
	/** Default `"line"` when missing (reviews written before file/range comments). */
	scope?: CommentScope;
	side: CommentSide;
	/** Start line (1-based on that side). Unused for `scope: "file"` (stored as 0). */
	line: number;
	/** Inclusive end line for `scope: "range"`. Omitted for single-line comments. */
	endLine?: number;
	/** First quoted line (or empty for a file comment). */
	lineText: string;
	/** Quoted block for a range; omitted for single-line and file comments. */
	lineTexts?: string[];
	contextBefore: string[];
	contextAfter: string[];
	hunkHeader: string;
	body: string;
}

/** A submitted comment overlaid on a later diff (pending or already applied). */
export interface ReviewAnnotation extends ReviewComment {
	reviewId: string;
	status: ReviewStatus;
}

export type ReviewStatus = "pending" | "applied" | "dismissed";

export interface ReviewIndexEntry {
	id: string;
	createdAt: string;
	dir: string;
	status: ReviewStatus;
	commentCount: number;
}

export interface ReviewIndex {
	version: 1;
	reviews: ReviewIndexEntry[];
}

export interface ReviewPayload {
	version: 1;
	id: string;
	status: ReviewStatus;
	repo: string;
	mode: DiffMode;
	base: { ref: string; sha: string };
	head: { ref: string; sha: string; dirty: boolean };
	createdAt: string;
	comments: ReviewComment[];
}

export interface SubmitReviewRequest {
	mode: DiffMode;
	baseBranch: string;
	comments: ReviewComment[];
}

export interface SubmitReviewResponse {
	id: string;
	dir: string;
	jsonPath: string;
	markdownPath: string;
	indexPath: string;
	markdown: string;
}