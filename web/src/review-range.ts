/**
 * Local Review range/file comment helpers.
 *
 * Pure functions, zero imports — unit-tested from tsconfig.tests.json
 * (NodeNext) while also bundled by Vite. Structural types mirror
 * server/review/types.ts.
 */

export type CommentScope = "line" | "range" | "file";
export type CommentSide = "LEFT" | "RIGHT";

interface DiffLine {
	type: "context" | "add" | "del";
	oldLine: number | null;
	newLine: number | null;
	content: string;
}

interface DiffHunk {
	header: string;
	lines: DiffLine[];
}

interface DiffFile {
	path: string;
	hunks: DiffHunk[];
}

interface CommentAnchor {
	path: string;
	scope?: CommentScope;
	side: CommentSide;
	line: number;
	endLine?: number;
}

interface ReviewComment extends CommentAnchor {
	id: string;
	lineText: string;
	lineTexts?: string[];
	contextBefore: string[];
	contextAfter: string[];
	hunkHeader: string;
	body: string;
}

const CONTEXT_RADIUS = 3;

export function commentScope(comment: CommentAnchor): CommentScope {
	if (comment.scope === "file" || comment.scope === "range" || comment.scope === "line") {
		return comment.scope;
	}
	if (comment.endLine != null && comment.endLine !== comment.line) return "range";
	return "line";
}

export function rangeStart(comment: Pick<CommentAnchor, "line" | "endLine">): number {
	return Math.min(comment.line, comment.endLine ?? comment.line);
}

export function rangeEnd(comment: Pick<CommentAnchor, "line" | "endLine">): number {
	return Math.max(comment.line, comment.endLine ?? comment.line);
}

/** Key used to highlight the composer: file banner, or the last line of a line/range comment. */
export function commentFocusKey(comment: CommentAnchor): string {
	if (commentScope(comment) === "file") return `${comment.path}:file`;
	return `${comment.path}:${comment.side}:${rangeEnd(comment)}`;
}

export interface LinedDiff {
	line: DiffLine;
	hunkHeader: string;
	hunkLines: DiffLine[];
	side: CommentSide;
	lineNumber: number;
}

export function linedDiff(file: DiffFile): LinedDiff[] {
	const out: LinedDiff[] = [];
	for (const hunk of file.hunks) {
		for (const line of hunk.lines) {
			const side: CommentSide = line.type === "del" ? "LEFT" : "RIGHT";
			const lineNumber = side === "LEFT" ? line.oldLine : line.newLine;
			if (lineNumber === null) continue;
			out.push({ line, hunkHeader: hunk.header, hunkLines: hunk.lines, side, lineNumber });
		}
	}
	return out;
}

export function collectRange(
	file: DiffFile,
	side: CommentSide,
	startLine: number,
	endLine: number,
): LinedDiff[] {
	const lo = Math.min(startLine, endLine);
	const hi = Math.max(startLine, endLine);
	return linedDiff(file).filter(
		(entry) => entry.side === side && entry.lineNumber >= lo && entry.lineNumber <= hi,
	);
}

export function prefixLine(line: DiffLine): string {
	const prefix = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
	return `${prefix}${line.content}`;
}

/** Draft fields for a new comment (caller fills `id` + `body`). */
export function draftFromRange(
	file: DiffFile,
	side: CommentSide,
	startLine: number,
	endLine: number,
): Omit<ReviewComment, "id" | "body"> | null {
	const rows = collectRange(file, side, startLine, endLine);
	if (rows.length === 0) return null;
	const start = rows[0]!;
	const last = rows[rows.length - 1]!;
	const lo = start.lineNumber;
	const hi = last.lineNumber;
	const startIndex = start.hunkLines.indexOf(start.line);
	const endIndex = last.hunkLines.indexOf(last.line);
	const contextBefore = start.hunkLines
		.slice(Math.max(0, startIndex - CONTEXT_RADIUS), startIndex)
		.map((entry) => prefixLine(entry));
	const contextAfter = last.hunkLines
		.slice(endIndex + 1, endIndex + 1 + CONTEXT_RADIUS)
		.map((entry) => prefixLine(entry));
	const lineTexts = rows.map((row) => row.line.content);
	const isRange = lo !== hi;
	return {
		path: file.path,
		scope: isRange ? "range" : "line",
		side,
		line: lo,
		endLine: isRange ? hi : undefined,
		lineText: lineTexts[0] ?? "",
		lineTexts: isRange ? lineTexts : undefined,
		contextBefore,
		contextAfter,
		hunkHeader: start.hunkHeader,
	};
}

export function draftForFile(file: Pick<DiffFile, "path">): Omit<ReviewComment, "id" | "body"> {
	return {
		path: file.path,
		scope: "file",
		side: "RIGHT",
		line: 0,
		lineText: "",
		contextBefore: [],
		contextAfter: [],
		hunkHeader: "",
	};
}

export function sameDraft(
	existing: CommentAnchor,
	draft: CommentAnchor,
): boolean {
	if (existing.path !== draft.path) return false;
	if (commentScope(existing) !== commentScope(draft)) return false;
	if (commentScope(draft) === "file") return true;
	return (
		existing.side === draft.side &&
		rangeStart(existing) === rangeStart(draft) &&
		rangeEnd(existing) === rangeEnd(draft)
	);
}
