/**
 * What the Review panel calls. The host owns transport (WS, vscode, HTTP).
 *
 * Today: `web/src/components/ReviewPanel.tsx` talks WebSocket.
 * After extraction: panel stays in the host; `ReviewDiffView` moves here
 * and takes `copy: ReviewCopy` instead of `useT()`.
 */

import type {
	DiffMode,
	DiffResponse,
	ReviewAnnotation,
	ReviewComment,
	SubmitReviewResponse,
} from "../../../../server/review/types.js";

export type { DiffMode, DiffResponse, ReviewAnnotation, ReviewComment, SubmitReviewResponse };

export interface DiffLoad {
	diff: DiffResponse;
	annotations: ReviewAnnotation[];
}

/**
 * Result of "apply" — hosts cannot all `prompt()` into a live chat.
 * Cursor should expect `files-only` / `clipboard` / `skill` more often than `prompted`.
 */
export type ApplyResult =
	| { kind: "prompted" }
	| { kind: "clipboard"; text: string }
	| { kind: "skill" }
	| { kind: "files-only" };

export interface ReviewSession {
	loadDiff(mode: DiffMode, base?: string): Promise<DiffLoad>;
	submit(
		mode: DiffMode,
		baseBranch: string,
		comments: ReviewComment[],
	): Promise<SubmitReviewResponse>;
	apply(): Promise<ApplyResult>;
}

/** Strings `ReviewDiffView` needs. Host maps i18n (or hardcodes English). */
export interface ReviewCopy {
	addComment: string;
	commentPlaceholder: string;
	cancel: string;
	binary: string;
	noHunks: string;
	lines: (n: number) => string;
	commentOnFile: string;
	fileComment: string;
	fileCommentPlaceholder: string;
	rangeLines: (start: number, end: number) => string;
	rangePlaceholder: (start: number, end: number) => string;
	annotationPending: string;
	annotationApplied: string;
}
