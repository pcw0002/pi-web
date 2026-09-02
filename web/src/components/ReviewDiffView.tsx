import { useEffect, useRef } from "react";
import type { CommentSide, DiffFile, DiffHunk, DiffLine, ReviewAnnotation, ReviewComment } from "../types";
import { useT } from "../i18n";
import { lineKey } from "../review-line-key";
import {
	commentFocusKey,
	commentScope,
	rangeEnd,
	rangeStart,
} from "../review-range";

interface DiffFileViewProps {
	file: DiffFile;
	expanded: boolean;
	onToggle: () => void;
	comments: ReviewComment[];
	annotations: ReviewAnnotation[];
	activeKey: string | null;
	selecting: { side: CommentSide; start: number; end: number } | null;
	onCommentLine: (hunkHeader: string, hunkLines: DiffLine[], line: DiffLine, shiftKey: boolean) => void;
	onCommentFile: () => void;
	onRangeDrag: (side: CommentSide, start: number, end: number, done: boolean) => void;
	onChangeComment: (id: string, body: string) => void;
	onRemoveComment: (id: string) => void;
	onFocusComment: (comment: ReviewComment) => void;
}

export function ReviewDiffFile({
	file,
	expanded,
	onToggle,
	comments,
	annotations,
	activeKey,
	selecting,
	onCommentLine,
	onCommentFile,
	onRangeDrag,
	onChangeComment,
	onRemoveComment,
	onFocusComment,
}: DiffFileViewProps) {
	const t = useT();
	const lineCount = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
	const byLine = assignAnnotations(file, annotations);
	const fileComments = comments.filter((c) => commentScope(c) === "file");
	const fileAnnotations = annotations.filter((a) => commentScope(a) === "file");
	const lineComments = comments.filter((c) => commentScope(c) !== "file");
	const drag = useRef<{ side: CommentSide; start: number; end: number } | null>(null);
	const onRangeDragRef = useRef(onRangeDrag);
	onRangeDragRef.current = onRangeDrag;

	useEffect(() => {
		const onUp = () => {
			const current = drag.current;
			if (!current) return;
			drag.current = null;
			onRangeDragRef.current(current.side, current.start, current.end, true);
		};
		window.addEventListener("mouseup", onUp);
		return () => window.removeEventListener("mouseup", onUp);
	}, []);

	function lineDown(side: CommentSide, lineNumber: number, shiftKey: boolean, hunkHeader: string, hunkLines: DiffLine[], line: DiffLine): void {
		if (shiftKey) {
			onCommentLine(hunkHeader, hunkLines, line, true);
			return;
		}
		drag.current = { side, start: lineNumber, end: lineNumber };
		onRangeDrag(side, lineNumber, lineNumber, false);
	}

	function lineEnter(side: CommentSide, lineNumber: number): void {
		const current = drag.current;
		if (!current || current.side !== side) return;
		current.end = lineNumber;
		onRangeDrag(current.side, current.start, lineNumber, false);
	}
	return (
		<section className="review-file" id={`review-file-${file.path.replace(/[^\w.-]+/g, "-")}`}>
			<header className="review-file-header">
				<button type="button" className="review-file-toggle" onClick={onToggle}>
					{expanded ? "▾" : "▸"} {file.path}
				</button>
				<span className={`review-status review-status-${file.status}`}>{file.status}</span>
				<span className="review-muted">
					{file.binary ? t("reviewBinary") : t("reviewLines", { n: lineCount })}
				</span>
				{file.status === "renamed" && file.oldPath ? (
					<span className="review-muted">from {file.oldPath}</span>
				) : null}
				<button type="button" className="review-file-comment-btn" onClick={onCommentFile}>
					{t("reviewCommentOnFile")}
				</button>
			</header>
			{expanded ? (
				<>
					{(fileAnnotations.length > 0 || fileComments.length > 0) ? (
					<div className="review-file-notes">
						{fileAnnotations.map((annotation) => (
							<AnnotationCard key={`ann-${annotation.reviewId}-${annotation.id}`} annotation={annotation} />
						))}
						{fileComments.map((comment) => (
							<CommentEditor
								key={comment.id}
								comment={comment}
								active={activeKey === commentFocusKey(comment)}
								onChangeComment={onChangeComment}
								onRemoveComment={onRemoveComment}
								onFocusComment={onFocusComment}
							/>
						))}
					</div>
					) : null}
					{file.binary ? <p className="review-muted review-pad">{t("reviewBinary")}</p> : null}
					{file.hunks.length === 0 && !file.binary ? (
						<p className="review-muted review-pad">{t("reviewNoHunks")}</p>
					) : null}
					{file.hunks.map((hunk) => (
						<HunkView
							key={hunk.header}
							filePath={file.path}
							hunk={hunk}
							comments={lineComments}
							annotationsByLine={byLine}
							annotations={annotations}
							activeKey={activeKey}
							selecting={selecting}
							onLineDown={lineDown}
							onLineEnter={lineEnter}
							onChangeComment={onChangeComment}
							onRemoveComment={onRemoveComment}
							onFocusComment={onFocusComment}
						/>
					))}
				</>
			) : null}
		</section>
	);
}

function HunkView({
	filePath,
	hunk,
	comments,
	annotationsByLine,
	annotations,
	activeKey,
	selecting,
	onLineDown,
	onLineEnter,
	onChangeComment,
	onRemoveComment,
	onFocusComment,
}: {
	filePath: string;
	hunk: DiffHunk;
	comments: ReviewComment[];
	annotationsByLine: Map<string, ReviewAnnotation[]>;
	annotations: ReviewAnnotation[];
	activeKey: string | null;
	selecting: { side: CommentSide; start: number; end: number } | null;
	onLineDown: (
		side: CommentSide,
		lineNumber: number,
		shiftKey: boolean,
		hunkHeader: string,
		hunkLines: DiffLine[],
		line: DiffLine,
	) => void;
	onLineEnter: (side: CommentSide, lineNumber: number) => void;
	onChangeComment: (id: string, body: string) => void;
	onRemoveComment: (id: string) => void;
	onFocusComment: (comment: ReviewComment) => void;
}) {
	return (
		<div className="review-hunk">
			<div className="review-hunk-header">{hunk.header}</div>
			<table className="review-diff-table">
				<tbody>
					{hunk.lines.map((line, index) => {
						const side: CommentSide = line.type === "del" ? "LEFT" : "RIGHT";
						const lineNumber = side === "LEFT" ? line.oldLine : line.newLine;
						const key = lineNumber === null ? `${index}` : lineKey(filePath, side, lineNumber);
						const lineComments = comments.filter((comment) => commentBelongsOnLine(comment, side, lineNumber));
						const lineAnnotations = lineNumber === null ? [] : (annotationsByLine.get(key) ?? []);
						const inSelect =
							lineNumber !== null &&
							selecting &&
							selecting.side === side &&
							lineNumber >= Math.min(selecting.start, selecting.end) &&
							lineNumber <= Math.max(selecting.start, selecting.end);
						const inAnnRange =
							lineNumber !== null &&
							annotations.some(
								(a) =>
									commentScope(a) !== "file" &&
									a.side === side &&
									lineNumber >= rangeStart(a) &&
									lineNumber <= rangeEnd(a),
							);
						const inDraftRange =
							lineNumber !== null &&
							comments.some(
								(c) =>
									c.side === side &&
									lineNumber >= rangeStart(c) &&
									lineNumber <= rangeEnd(c),
							);
						return (
							<LineBlock
								key={`${key}-${index}`}
								line={line}
								comments={lineComments}
								annotations={lineAnnotations}
								active={activeKey === key || lineComments.some((c) => commentFocusKey(c) === activeKey)}
								highlighted={Boolean(inSelect) || inAnnRange || inDraftRange}
								onPointerDown={(shiftKey) => {
									if (lineNumber === null) return;
									onLineDown(side, lineNumber, shiftKey, hunk.header, hunk.lines, line);
								}}
								onPointerEnter={() => {
									if (lineNumber === null) return;
									onLineEnter(side, lineNumber);
								}}
								onChangeComment={onChangeComment}
								onRemoveComment={onRemoveComment}
								onFocusComment={onFocusComment}
							/>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function LineBlock({
	line,
	comments,
	annotations,
	active,
	highlighted,
	onPointerDown,
	onPointerEnter,
	onChangeComment,
	onRemoveComment,
	onFocusComment,
}: {
	line: DiffLine;
	comments: ReviewComment[];
	annotations: ReviewAnnotation[];
	active: boolean;
	highlighted: boolean;
	onPointerDown: (shiftKey: boolean) => void;
	onPointerEnter: () => void;
	onChangeComment: (id: string, body: string) => void;
	onRemoveComment: (id: string) => void;
	onFocusComment: (comment: ReviewComment) => void;
}) {
	const t = useT();
	const pending = annotations.some((a) => a.status === "pending");
	const applied = annotations.some((a) => a.status === "applied");
	const lineClass = [
		"review-diff-line",
		line.type,
		pending ? "has-pending" : "",
		applied && !pending ? "has-applied" : "",
		highlighted ? "in-range" : "",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<>
			<tr
				className={lineClass}
				onMouseDown={(event) => {
					if (event.button !== 0) return;
					event.preventDefault();
					onPointerDown(event.shiftKey);
				}}
				onMouseEnter={onPointerEnter}
			>
				<td className="review-gutter">
					<button
						type="button"
						className="review-add-comment"
						aria-label={t("reviewAddComment")}
						onMouseDown={(event) => {
							event.preventDefault();
							event.stopPropagation();
							onPointerDown(event.shiftKey);
						}}
					>
						+
					</button>
				</td>
				<td className="review-line-no">{line.oldLine ?? ""}</td>
				<td className="review-line-no">{line.newLine ?? ""}</td>
				<td className="review-code">
					<span className="review-prefix">{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span>
					<span>{line.content}</span>
				</td>
			</tr>
			{annotations.map((annotation) => (
				<tr key={`ann-${annotation.reviewId}-${annotation.id}`} className="review-annotation-row">
					<td colSpan={4}>
						<AnnotationCard annotation={annotation} />
					</td>
				</tr>
			))}
			{comments.map((comment) => (
				<tr key={comment.id} className={active ? "review-comment-row active" : "review-comment-row"}>
					<td colSpan={4}>
						<CommentEditor
							comment={comment}
							active={active}
							onChangeComment={onChangeComment}
							onRemoveComment={onRemoveComment}
							onFocusComment={onFocusComment}
						/>
					</td>
				</tr>
			))}
		</>
	);
}

function AnnotationCard({ annotation }: { annotation: ReviewAnnotation }) {
	const t = useT();
	const scope = commentScope(annotation);
	const rangeLabel =
		scope === "range"
			? t("reviewRangeLines", { start: rangeStart(annotation), end: rangeEnd(annotation) })
			: null;
	return (
		<div className={`review-annotation ${annotation.status} ${scope}`}>
			<span className="review-annotation-badge">
				{annotation.status === "applied" ? t("reviewAnnotationApplied") : t("reviewAnnotationPending")}
				{scope === "file" ? ` · ${t("reviewFileComment")}` : ""}
				{rangeLabel ? ` · ${rangeLabel}` : ""}
			</span>
			<p>{annotation.body}</p>
		</div>
	);
}

function CommentEditor({
	comment,
	active,
	onChangeComment,
	onRemoveComment,
	onFocusComment,
}: {
	comment: ReviewComment;
	active: boolean;
	onChangeComment: (id: string, body: string) => void;
	onRemoveComment: (id: string) => void;
	onFocusComment: (comment: ReviewComment) => void;
}) {
	const t = useT();
	const scope = commentScope(comment);
	const placeholder =
		scope === "file"
			? t("reviewFileCommentPlaceholder")
			: scope === "range"
				? t("reviewRangePlaceholder", { start: rangeStart(comment), end: rangeEnd(comment) })
				: t("reviewCommentPlaceholder");
	return (
		<div className={`review-comment ${scope}`}>
			{scope !== "line" ? (
				<div className="review-comment-scope">
					{scope === "file"
						? t("reviewFileComment")
						: t("reviewRangeLines", { start: rangeStart(comment), end: rangeEnd(comment) })}
				</div>
			) : null}
			<textarea
				autoFocus={active && comment.body.length === 0}
				value={comment.body}
				placeholder={placeholder}
				onChange={(event) => onChangeComment(comment.id, event.target.value)}
				onFocus={() => onFocusComment(comment)}
			/>
			<div className="review-comment-actions">
				<button type="button" className="review-link" onClick={() => onRemoveComment(comment.id)}>
					{t("reviewCancel")}
				</button>
			</div>
		</div>
	);
}

function commentBelongsOnLine(comment: ReviewComment, side: CommentSide, lineNumber: number | null): boolean {
	if (lineNumber === null || commentScope(comment) === "file") return false;
	if (comment.side !== side) return false;
	return rangeEnd(comment) === lineNumber;
}


/** Pin each submitted comment to the best matching diff line (number, then quoted text). */
export function assignAnnotations(
	file: DiffFile,
	annotations: ReviewAnnotation[],
): Map<string, ReviewAnnotation[]> {
	const leftover = annotations.filter((a) => a.path === file.path && commentScope(a) !== "file");
	const used = new Set<string>();
	const map = new Map<string, ReviewAnnotation[]>();
	const push = (key: string, annotation: ReviewAnnotation) => {
		const list = map.get(key) ?? [];
		list.push(annotation);
		map.set(key, list);
		used.add(annotation.id);
	};
	for (const hunk of file.hunks) {
		for (const line of hunk.lines) {
			const side: CommentSide = line.type === "del" ? "LEFT" : "RIGHT";
			const lineNumber = side === "LEFT" ? line.oldLine : line.newLine;
			if (lineNumber === null) continue;
			const key = lineKey(file.path, side, lineNumber);
			for (const annotation of leftover) {
				if (used.has(annotation.id)) continue;
				if (annotation.side === side && rangeEnd(annotation) === lineNumber) {
					push(key, annotation);
				}
			}
		}
	}
	for (const hunk of file.hunks) {
		for (const line of hunk.lines) {
			const side: CommentSide = line.type === "del" ? "LEFT" : "RIGHT";
			const lineNumber = side === "LEFT" ? line.oldLine : line.newLine;
			if (lineNumber === null) continue;
			const key = lineKey(file.path, side, lineNumber);
			for (const annotation of leftover) {
				if (used.has(annotation.id)) continue;
				const quoted =
					commentScope(annotation) === "range" && annotation.lineTexts?.length
						? annotation.lineTexts[annotation.lineTexts.length - 1]
						: annotation.lineText;
				if (quoted && quoted === line.content) {
					push(key, annotation);
				}
			}
		}
	}
	return map;
}
