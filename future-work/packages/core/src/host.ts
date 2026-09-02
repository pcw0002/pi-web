/**
 * Host-agnostic Local Review store + apply sink.
 *
 * Today these methods are scattered across `server/review/handlers.ts`,
 * `server/review/review.ts`, and `ClientSession.reviewApply()`. After
 * extraction, `packages/core` implements `ReviewStore`; each host
 * implements `ApplySink`.
 */

import type {
	DiffMode,
	DiffResponse,
	ReviewAnnotation,
	ReviewIndex,
	ReviewStatus,
	SubmitReviewRequest,
	SubmitReviewResponse,
} from "../../../../server/review/types.js";

export type {
	DiffMode,
	DiffResponse,
	ReviewAnnotation,
	ReviewIndex,
	ReviewStatus,
	SubmitReviewRequest,
	SubmitReviewResponse,
};

/** Filesystem + git. No UI, no model, no WebSocket. */
export interface ReviewStore {
	loadDiff(root: string, mode: DiffMode, baseBranch?: string): Promise<DiffResponse>;
	submit(root: string, body: SubmitReviewRequest): Promise<SubmitReviewResponse>;
	pendingMarkdown(root: string): Promise<string>;
	pendingSummary(root: string): Promise<{
		pending: ReviewIndex["reviews"];
		commentCount: number;
	}>;
	annotations(root: string): Promise<ReviewAnnotation[]>;
	setStatus(root: string, id: string, status: ReviewStatus): Promise<void>;
	/** Wrap pending markdown as the user prompt a host feeds its agent. */
	applyPrompt(markdown: string): string;
}

/**
 * How a host injects "fix these comments" into *its* agent.
 *
 * - pi-web: `session.prompt(prompt)`
 * - VS Code / Cursor: clipboard, new composer, or "run the apply skill"
 * - CLI: print to stdout
 * - MCP: the client model calls `local_review_pending` itself — often no sink
 */
export interface ApplySink {
	apply(prompt: string): Promise<void>;
}

/** Shared apply-tool names so MCP and the pi SDK stay aligned. */
export const REVIEW_TOOL_PENDING = "local_review_pending";
export const REVIEW_TOOL_MARK_APPLIED = "local_review_mark_applied";
