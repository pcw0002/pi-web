/**
 * On-disk layout. Every host reads and writes this; do not invent a second format.
 *
 * Implemented today in `server/review/review.ts`.
 */

export const LOCAL_REVIEW_DIR = ".local-review";
export const INDEX_BASENAME = "index.json";
export const REVIEWS_DIR = "reviews";
export const REVIEW_JSON = "review.json";
export const REVIEW_MARKDOWN = "REVIEW.md";
