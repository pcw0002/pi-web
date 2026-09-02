import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type {
	ClientMessage,
	CommentSide,
	DiffFile,
	DiffLine,
	DiffResponse,
	ReviewAnnotation,
	ReviewComment,
} from "../types";
import type { ChatState } from "../use-chat";
import { useT } from "../i18n";
import { ReviewDiffFile } from "./ReviewDiffView";
import {
	commentFocusKey,
	draftForFile,
	draftFromRange,
	sameDraft,
} from "../review-range";

interface ReviewPanelProps {
	chat: ChatState;
	send: (msg: ClientMessage) => boolean;
	active: boolean;
	onSwitchToChat: () => void;
}

export function ReviewPanel({ chat, send, active, onSwitchToChat }: ReviewPanelProps) {
	const t = useT();
	const seqRef = useRef(0);
	const diffReqRef = useRef(-1);
	const submitReqRef = useRef(-1);
	const applyAfterSubmitRef = useRef(false);
	const lastCwdRef = useRef<string | undefined>(undefined);

	const [mode, setMode] = useState<"working-tree" | "branch">("working-tree");
	const [baseBranch, setBaseBranch] = useState("");
	const [diff, setDiff] = useState<DiffResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [comments, setComments] = useState<ReviewComment[]>([]);
	const [activeKey, setActiveKey] = useState<string | null>(null);
	const [selecting, setSelecting] = useState<{
		path: string;
		side: CommentSide;
		start: number;
		end: number;
	} | null>(null);
	const anchorRef = useRef<{ path: string; side: CommentSide; line: number } | null>(null);
	const [submitMessage, setSubmitMessage] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [annotations, setAnnotations] = useState<ReviewAnnotation[]>([]);

	const sendReview = useCallback(
		(
			msg: { type: "review_diff"; mode?: "working-tree" | "branch"; base?: string } | { type: "review_submit"; mode?: "working-tree" | "branch"; baseBranch?: string; comments: ReviewComment[] },
			slot: MutableRefObject<number>,
		): boolean => {
			if (!chat.ready || chat.status !== "open") return false;
			const id = ++seqRef.current;
			if (!send({ ...msg, reqId: id } as ClientMessage)) {
				seqRef.current -= 1;
				return false;
			}
			slot.current = id;
			return true;
		},
		[chat.ready, chat.status, send],
	);

	const load = useCallback(
		(nextMode = mode, nextBase = baseBranch) => {
			if (!chat.ready || chat.status !== "open" || !chat.state?.cwd) return;
			setLoading(true);
			setError(null);
			setSubmitMessage(null);
			sendReview(
				{ type: "review_diff", mode: nextMode, base: nextBase || undefined },
				diffReqRef,
			);
		},
		[baseBranch, chat.ready, chat.state?.cwd, chat.status, mode, sendReview],
	);

	useEffect(() => {
		const cwd = chat.state?.cwd;
		if (!cwd) return;
		if (lastCwdRef.current !== cwd) {
			lastCwdRef.current = cwd;
			setComments([]);
			setActiveKey(null);
			setSelecting(null);
			setDiff(null);
			setAnnotations([]);
			anchorRef.current = null;
		}
	}, [chat.state?.cwd]);

	useEffect(() => {
		if (active) load();
	}, [active, chat.state?.cwd]); // eslint-disable-line react-hooks/exhaustive-deps

	const pendingKey = chat.reviewStatus.pending.map((review) => review.id).join("\n");
	useEffect(() => {
		if (active) load();
	}, [pendingKey]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		if (chat.scmDirty > 0 && active) load();
	}, [chat.scmDirty]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		const msg = chat.reviewData;
		if (!msg || msg.type !== "review_data") return;
		if (msg.kind === "diff" && msg.reqId === diffReqRef.current) {
			setLoading(false);
			if (!msg.ok) {
				setDiff(null);
				setError(msg.error ?? t("scmQueryFailed", { error: "unknown" }));
				return;
			}
			if (msg.diff) {
				setDiff(msg.diff);
				setAnnotations(msg.annotations ?? []);
				const first = msg.diff.files.find((file) => !isBulkyPath(file.path)) ?? msg.diff.files[0];
				setExpanded(first ? { [first.path]: true } : {});
				if (!baseBranch) {
					setBaseBranch(msg.diff.repo.baseBranch);
				}
			}
		}
		if (msg.kind === "submit" && msg.reqId === submitReqRef.current) {
			setSubmitting(false);
			if (!msg.ok) {
				applyAfterSubmitRef.current = false;
				setError(msg.error ?? t("scmQueryFailed", { error: "unknown" }));
				return;
			}
			if (msg.submitted) {
				setComments([]);
				setActiveKey(null);
				setSelecting(null);
				setAnnotations(msg.annotations ?? []);
				anchorRef.current = null;
				if (applyAfterSubmitRef.current) {
					applyAfterSubmitRef.current = false;
					setSubmitMessage(null);
					send({ type: "review_apply" });
					onSwitchToChat();
					return;
				}
				setSubmitMessage(
					t("reviewSubmitted", { dir: msg.submitted.dir, id: msg.submitted.id }),
				);
			}
		}
	}, [baseBranch, chat.reviewData, onSwitchToChat, send, t]);

	const commentsByFile = useMemo(() => {
		const grouped = new Map<string, ReviewComment[]>();
		for (const comment of comments) {
			const list = grouped.get(comment.path) ?? [];
			list.push(comment);
			grouped.set(comment.path, list);
		}
		return grouped;
	}, [comments]);

	function openDraft(file: DiffFile, draft: Omit<ReviewComment, "id" | "body">): void {
		setExpanded((current) => ({ ...current, [file.path]: true }));
		const existing = comments.find((comment) => sameDraft(comment, draft));
		if (existing) {
			setActiveKey(commentFocusKey(existing));
			return;
		}
		const next: ReviewComment = { ...draft, id: crypto.randomUUID(), body: "" };
		setComments((current) => [...current, next]);
		setActiveKey(commentFocusKey(next));
		if (draft.scope !== "file") {
			anchorRef.current = {
				path: draft.path,
				side: draft.side,
				line: Math.max(draft.line, draft.endLine ?? draft.line),
			};
		}
	}

	function onCommentLine(file: DiffFile, _hunkHeader: string, _hunkLines: DiffLine[], line: DiffLine, shiftKey: boolean): void {
		const side: CommentSide = line.type === "del" ? "LEFT" : "RIGHT";
		const lineNumber = side === "LEFT" ? line.oldLine : line.newLine;
		if (lineNumber === null) return;
		const anchor = anchorRef.current;
		if (
			shiftKey &&
			anchor &&
			anchor.path === file.path &&
			anchor.side === side &&
			anchor.line !== lineNumber
		) {
			const draft = draftFromRange(file, side, anchor.line, lineNumber);
			if (draft) openDraft(file, draft);
			return;
		}
		const draft = draftFromRange(file, side, lineNumber, lineNumber);
		if (draft) openDraft(file, draft);
	}

	function onRangeDrag(file: DiffFile, side: CommentSide, start: number, end: number, done: boolean): void {
		if (!done) {
			setSelecting({ path: file.path, side, start, end });
			return;
		}
		setSelecting(null);
		const draft = draftFromRange(file, side, start, end);
		if (draft) openDraft(file, draft);
	}

	function onCommentFile(file: DiffFile): void {
		openDraft(file, draftForFile(file));
	}

	function onSubmit(apply: boolean): void {
		const ready = comments.filter((comment) => comment.body.trim().length > 0);
		if (ready.length === 0) {
			setError(t("reviewNeedComment"));
			return;
		}
		applyAfterSubmitRef.current = apply;
		setSubmitting(true);
		setError(null);
		setSubmitMessage(null);
		sendReview(
			{ type: "review_submit", mode, baseBranch, comments: ready },
			submitReqRef,
		);
	}

	function onApplyInChat(): void {
		send({ type: "review_apply" });
		onSwitchToChat();
	}

	function onSetStatus(status: "applied" | "dismissed", id?: string): void {
		send({ type: "review_set_status", status, id });
	}

	const files = diff?.files ?? [];
	const readyCount = comments.filter((comment) => comment.body.trim().length > 0).length;
	const pendingCount = chat.reviewStatus.pending.length;
	const annotationsByFile = useMemo(() => {
		const grouped = new Map<string, ReviewAnnotation[]>();
		for (const annotation of annotations) {
			const list = grouped.get(annotation.path) ?? [];
			list.push(annotation);
			grouped.set(annotation.path, list);
		}
		return grouped;
	}, [annotations]);

	return (
		<div className="review-view">
			<div className="review-toolbar">
				<div className="review-title">{t("reviewTitle")}</div>
				<div className="review-controls" role="group" aria-label={t("reviewTitle")}>
					<button
						type="button"
						className={mode === "working-tree" ? "active" : ""}
						onClick={() => {
							setMode("working-tree");
							load("working-tree", baseBranch);
						}}
					>
						{t("reviewWorkingTree")}
					</button>
					<button
						type="button"
						className={mode === "branch" ? "active" : ""}
						onClick={() => {
							setMode("branch");
							load("branch", baseBranch);
						}}
					>
						{t("reviewBranch")}
					</button>
					{mode === "branch" ? (
						<label className="review-base">
							{t("reviewBase")}
							<select
								value={baseBranch}
								onChange={(event) => {
									const next = event.target.value;
									setBaseBranch(next);
									load("branch", next);
								}}
							>
								{(diff?.repo.branches ?? [baseBranch]).filter(Boolean).map((branch) => (
									<option key={branch} value={branch}>
										{branch}
									</option>
								))}
							</select>
						</label>
					) : null}
					<button
						type="button"
						className="review-submit"
						disabled={submitting || readyCount === 0}
						onClick={() => onSubmit(true)}
					>
						{submitting
							? t("reviewSubmitting")
							: `${t("reviewSubmitAndApply")}${readyCount ? ` (${readyCount})` : ""}`}
					</button>
					<button
						type="button"
						className="review-save-only"
						disabled={submitting || readyCount === 0}
						title={t("reviewSaveOnlyHint")}
						onClick={() => onSubmit(false)}
					>
						{t("reviewSaveOnly")}
					</button>
					{pendingCount > 0 ? (
						<button type="button" className="review-apply" onClick={onApplyInChat}>
							{t("reviewApplyInChat")}
						</button>
					) : null}
				</div>
			</div>
			{pendingCount > 0 ? (
				<div className="review-pending-list" role="list">
					{chat.reviewStatus.pending.map((review) => (
						<div key={review.id} className="review-pending-row" role="listitem">
							<span className="review-pending-id">{review.id}</span>
							<span className="review-muted">{t("reviewCommentCount", { n: review.commentCount })}</span>
							<button
								type="button"
								className="review-link"
								title={t("reviewMarkAppliedTip")}
								onClick={() => onSetStatus("applied", review.id)}
							>
								{t("reviewMarkApplied")}
							</button>
							<button
								type="button"
								className="review-link"
								title={t("reviewDismissPendingTip")}
								onClick={() => onSetStatus("dismissed", review.id)}
							>
								{t("reviewDismissPending")}
							</button>
						</div>
					))}
				</div>
			) : null}
			{diff ? (
				<div className="review-meta">
					<span>
						{diff.repo.branch} @ {diff.head.sha.slice(0, 8)}
						{diff.head.dirty ? ` · ${t("reviewDirty")}` : ""}
					</span>
					<span>
						{diff.mode === "branch" ? t("reviewVsBase", { base: diff.base.ref }) : t("reviewVsHead")} ·{" "}
						{files.length} {t("reviewFiles").toLowerCase()}
					</span>
					{diff.uncommittedWarning ? <span className="review-warn">{t("reviewUncommitted")}</span> : null}
					<span className="review-hint">{t("reviewCommentHint")}</span>
				</div>
			) : null}
			{error ? (
				<div className="review-banner error" role="alert">
					{error}
				</div>
			) : null}
			{submitMessage ? (
				<div className="review-banner ok" role="status">
					<span>{submitMessage}</span>
					<button type="button" className="review-apply" onClick={onApplyInChat}>
						{t("reviewApplyInChat")}
					</button>
				</div>
			) : null}
			<div className="review-body">
				<aside className="review-files">
					<h2>{t("reviewFiles")}</h2>
					{files.length === 0 && !loading && !error ? <p className="review-muted">{t("reviewNoChanges")}</p> : null}
					<ul>
						{files.map((file) => (
							<li key={file.path}>
								<button
									type="button"
									onClick={() => setExpanded((current) => ({ ...current, [file.path]: true }))}
								>
									<span className={`review-status review-status-${file.status}`}>
										{statusLetter(file.status)}
									</span>
									<span>{file.path}</span>
									{commentsByFile.get(file.path)?.length || annotationsByFile.get(file.path)?.length ? (
										<span className="review-count">
											{(commentsByFile.get(file.path)?.length ?? 0) +
												(annotationsByFile.get(file.path)?.length ?? 0)}
										</span>
									) : null}
								</button>
							</li>
						))}
					</ul>
				</aside>
				<main className="review-diffs">
					{loading && files.length === 0 ? <p className="review-muted">{t("reviewLoading")}</p> : null}
					{files.map((file) => (
						<ReviewDiffFile
							key={file.path}
							file={file}
							expanded={Boolean(expanded[file.path])}
							onToggle={() =>
								setExpanded((current) => ({ ...current, [file.path]: !current[file.path] }))
							}
							comments={commentsByFile.get(file.path) ?? []}
							annotations={annotationsByFile.get(file.path) ?? []}
							activeKey={activeKey}
							selecting={
								selecting?.path === file.path
									? { side: selecting.side, start: selecting.start, end: selecting.end }
									: null
							}
							onCommentLine={(hunkHeader, hunkLines, line, shiftKey) =>
								onCommentLine(file, hunkHeader, hunkLines, line, shiftKey)
							}
							onCommentFile={() => onCommentFile(file)}
							onRangeDrag={(side, start, end, done) => onRangeDrag(file, side, start, end, done)}
							onChangeComment={(id, body) =>
								setComments((current) => current.map((c) => (c.id === id ? { ...c, body } : c)))
							}
							onRemoveComment={(id) => {
								setComments((current) => current.filter((c) => c.id !== id));
								setActiveKey(null);
							}}
							onFocusComment={(comment) => setActiveKey(commentFocusKey(comment))}
						/>
					))}
				</main>
			</div>
		</div>
	);
}

function isBulkyPath(filePath: string): boolean {
	return /(^|\/)(yarn\.lock|package-lock\.json|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum)$/.test(filePath);
}

function statusLetter(status: DiffFile["status"]): string {
	if (status === "added") return "A";
	if (status === "deleted") return "D";
	if (status === "renamed") return "R";
	return "M";
}
