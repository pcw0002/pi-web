/**
 * Intended UI package surface (not extracted yet).
 *
 *   ReviewDiffView  → web/src/components/ReviewDiffView.tsx
 *   review-range    → web/src/review-range.ts
 *   review-line-key → web/src/review-line-key.ts
 *
 * ReviewPanel, ReviewChip, and styles stay in the host.
 */

export type { ApplyResult, DiffLoad, ReviewCopy, ReviewSession } from "./host.js";
