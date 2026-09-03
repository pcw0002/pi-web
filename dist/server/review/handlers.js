import { getDiff, GitError, resolveRepoRoot } from "./git.js";
import { writeReviewArtifacts } from "./review.js";
export function parseMode(value) {
    if (value === undefined || value === "working-tree" || value === "branch") {
        return value === "branch" ? "branch" : "working-tree";
    }
    throw new GitError(`Unknown diff mode: ${value}`);
}
export async function loadDiff(root, modeValue, baseBranch) {
    const resolved = await resolveRepoRoot(root);
    return getDiff(resolved, parseMode(modeValue), baseBranch);
}
export async function submitReview(root, body) {
    if (!Array.isArray(body.comments) || body.comments.length === 0) {
        throw new GitError("Add at least one comment before submitting.");
    }
    const resolved = await resolveRepoRoot(root);
    const mode = parseMode(body.mode);
    const snapshot = await getDiff(resolved, mode, body.baseBranch);
    const createdAt = new Date().toISOString();
    const result = await writeReviewArtifacts(resolved, {
        version: 1,
        repo: resolved,
        mode,
        base: snapshot.base,
        head: snapshot.head,
        createdAt,
        comments: body.comments,
    });
    return {
        id: result.id,
        dir: result.dir,
        jsonPath: result.jsonPath,
        markdownPath: result.markdownPath,
        indexPath: result.indexPath,
        markdown: result.markdown,
    };
}
