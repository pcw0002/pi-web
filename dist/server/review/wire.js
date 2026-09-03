import { GitError } from "./git.js";
import { loadDiff, submitReview } from "./handlers.js";
import { listReviewAnnotations, pendingReviewSummary, setPendingReviewsStatus, setReviewStatus, } from "./review.js";
function errorText(error) {
    if (error instanceof GitError || error instanceof Error) {
        return error.message;
    }
    return String(error);
}
export async function emitReviewDiff(cwd, reqId, mode, base, emit) {
    try {
        const diff = await loadDiff(cwd, mode, base);
        const annotations = await listReviewAnnotations(cwd);
        emit({ type: "review_data", reqId, kind: "diff", ok: true, diff, annotations });
    }
    catch (error) {
        emit({ type: "review_data", reqId, kind: "diff", ok: false, error: errorText(error) });
    }
}
export async function emitReviewSubmit(cwd, reqId, mode, baseBranch, comments, emit) {
    try {
        const submitted = await submitReview(cwd, {
            mode: mode === "branch" ? "branch" : "working-tree",
            baseBranch: baseBranch ?? "",
            comments,
        });
        const annotations = await listReviewAnnotations(cwd);
        emit({ type: "review_data", reqId, kind: "submit", ok: true, submitted, annotations });
        const summary = await pendingReviewSummary(cwd);
        emit({ type: "review_status", pending: summary.pending, commentCount: summary.commentCount });
    }
    catch (error) {
        emit({ type: "review_data", reqId, kind: "submit", ok: false, error: errorText(error) });
    }
}
export async function emitReviewSetStatus(cwd, status, id, emit) {
    try {
        if (id) {
            await setReviewStatus(cwd, id, status);
        }
        else {
            const n = await setPendingReviewsStatus(cwd, status);
            if (n === 0) {
                emit({ type: "notice", level: "info", text: "No pending Local Review comments." });
            }
        }
        const summary = await pendingReviewSummary(cwd);
        emit({ type: "review_status", pending: summary.pending, commentCount: summary.commentCount });
    }
    catch (error) {
        emit({
            type: "notice",
            level: "error",
            text: `Failed to update Local Review: ${errorText(error)}`,
        });
    }
}
