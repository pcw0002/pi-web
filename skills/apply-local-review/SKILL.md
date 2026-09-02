---
name: apply-local-review
description: Applies a Local Review (line comments on a git diff) to the working tree. Use when the user asks to apply a Local Review, implement review comments from .local-review/, or fix comments from a local diff review.
---

# Apply Local Review

A human left comments on a local diff using Local Review. The payload is harness-agnostic: any coding agent can apply it.

Comments have a `scope`:

- `"line"` (or missing): one line. Match by **file path + quoted line text**, not line numbers.
- `"range"`: several lines. Match the **quoted block** (`lineTexts` / Quoted block), not the line numbers.
- `"file"`: the whole file. Do not look for a line. Typical asks: this file should not exist, should be a function in another module, should be renamed or deleted.

Reviews are append-only. Each submit is its own folder plus an entry in `.local-review/index.json`. Do not look for `LATEST.md`.

## Locate pending reviews

1. Read `.local-review/index.json`.
2. Take every entry with `"status": "pending"`, oldest `createdAt` first.
3. For each, read `<entry.dir>/review.json` (and `REVIEW.md` if useful).

If `index.json` is missing, scan `.local-review/reviews/*/review.json` and treat missing `status` as pending. Ignore leftover `LATEST.md` / `latest.json`.

If nothing pending exists, say so. Do not re-apply `applied` reviews unless the user asks.

## Apply them

For each pending review, in order:

1. Read every comment. Do not skip any.
2. **File comments:** act on the whole file as the body requests (move/merge/delete/rename). Match by path only.
3. **Line / range comments:** find the code by **file path + quoted text**, not line numbers. Numbers may have shifted since the review was written. For a range, match the quoted block as a whole.
4. Use `contextBefore` / `contextAfter` (or the Nearby context block in the markdown) when the quoted text appears more than once.
5. `side: LEFT` is a line on the old side of the diff (usually a deletion). `side: RIGHT` is a line on the new side. Unused for file comments.
6. Only change what the comments request. No drive-by refactors.
7. After editing, re-read each commented region (or the whole file) and confirm the request is addressed.
8. Set `"status": "applied"` on that review in both `.local-review/index.json` and `<entry.dir>/review.json`. Prefer calling the `local_review_mark_applied` tool when it is available. Humans can also **Mark applied** or **Dismiss** from the chat chip / Review tab without the tool.

## When done

Summarize each comment as addressed or blocked (and why). List which review ids you applied. Do not commit unless the user asks.
