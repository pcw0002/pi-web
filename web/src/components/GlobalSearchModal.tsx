import {
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import {
	FiFileText,
	FiFolder,
	FiMessageSquare,
	FiSearch,
	FiX,
} from "react-icons/fi";
import type { ClientMessage, FileSearchResult, ProjectSummary, SessionSummary } from "../types";
import { useT } from "../i18n";

interface GlobalSearchModalProps {
	send: (msg: ClientMessage) => boolean;
	/** Persisted session history (lazy — requested on open). */
	sessions: SessionSummary[];
	/** Recent projects (lazy — requested on open). */
	projects: ProjectSummary[];
	cwd: string;
	fileSearch: {
		reqId: number;
		ok: boolean;
		results: FileSearchResult[];
		truncated?: boolean;
	} | null;
	onClose: () => void;
	/** Restore a history session (switch_session). */
	onSwitchSession: (path: string) => void;
	/** Open a recent project (set_cwd). */
	onSwitchProject: (path: string) => void;
	/** Preview a matched file (opens the file preview panel). */
	onPreviewFile: (path: string, name: string) => void;
}

/** Case-insensitive substring test (empty needle matches nothing here —
 *  callers hide sections until there is a query). */
function matches(text: string, q: string): boolean {
	return text.toLowerCase().includes(q);
}

/**
 * Global search modal — one input searches three kinds of target:
 * ① Conversations: history list (firstMessage + filename, client-side filter, click to restore);
 * ② Projects: recent project paths (client-side filter, click set_cwd to switch workspace);
 * ③ Files: recursive filename match in the current workspace (server search_files, matched by reqId,
 *    click to open the file preview). ↑↓/Enter keyboard nav, Esc to close.
 */
export function GlobalSearchModal({
	send,
	sessions,
	projects,
	cwd,
	fileSearch,
	onClose,
	onSwitchSession,
	onSwitchProject,
	onPreviewFile,
}: GlobalSearchModalProps) {
	const t = useT();
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(query);
	const [active, setActive] = useState(0);
	// Local reqId counter for search_files requests; only accept results
	// carrying the latest one (stale responses from earlier keystrokes drop).
	const reqIdRef = useRef(1);
	const lastReqRef = useRef(0);
	// Debounce timer so typing doesn't fire a workspace walk per keystroke.
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Lazy-load sessions + projects once on open (same probes as LeftPanel).
	useEffect(() => {
		send({ type: "list_sessions" });
		send({ type: "list_projects" });
		requestAnimationFrame(() => inputRef.current?.focus());
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only probes
	}, []);

	/** True while a server-side file walk is in flight for the latest query. */
	const [filesPending, setFilesPending] = useState(false);

	// Fire a server-side file search on each settled query change.
	useEffect(() => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		const q = deferredQuery.trim();
		if (!q) return;
		debounceRef.current = setTimeout(() => {
			const reqId = ++reqIdRef.current;
			lastReqRef.current = reqId;
			setFilesPending(true);
			send({ type: "search_files", reqId, query: q });
		}, 300);
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- send is stable
	}, [deferredQuery]);

	const q = deferredQuery.trim().toLowerCase();

	const sessionHits = useMemo(
		() =>
			q
				? sessions.filter(
						(s) =>
							matches(s.firstMessage ?? "", q) ||
							matches(s.name ?? "", q) ||
							matches(s.path.split(/[\\/]/).pop() ?? "", q),
					).slice(0, 20)
				: [],
		[sessions, q],
	);
	const projectHits = useMemo(
		() =>
			q
				? projects.filter((p) => matches(p.path, q)).slice(0, 10)
				: [],
		[projects, q],
	);
	const fileHits = useMemo(() => {
		if (!q || !fileSearch || fileSearch.reqId !== lastReqRef.current || !fileSearch.ok)
			return [];
		return fileSearch.results;
	}, [fileSearch, q]);

	// Clear the "searching" hint once the latest query's results land.
	useEffect(() => {
		if (
			fileSearch &&
			fileSearch.reqId === lastReqRef.current &&
			lastReqRef.current !== 0
		) {
			setFilesPending(false);
		}
	}, [fileSearch]);
	const fileTruncated = !!fileSearch && fileSearch.ok && fileSearch.truncated;

	/** Flat navigation order: conversations → projects → files. */
	type NavItem =
		| { kind: "session"; path: string }
		| { kind: "project"; path: string }
		| { kind: "file"; path: string; name: string };
	const navItems = useMemo<NavItem[]>(
		() => [
			...sessionHits.map((s) => ({ kind: "session" as const, path: s.path })),
			...projectHits.map((p) => ({ kind: "project" as const, path: p.path })),
			...fileHits
				.filter((f) => f.type === "file")
				.map((f) => ({ kind: "file" as const, path: f.path, name: f.name })),
		],
		[sessionHits, projectHits, fileHits],
	);

	useEffect(() => {
		setActive(0);
	}, [deferredQuery]);

	const activate = useCallback(
		(item: NavItem | undefined) => {
			if (!item) return;
			if (item.kind === "session") onSwitchSession(item.path);
			else if (item.kind === "project") onSwitchProject(item.path);
			else onPreviewFile(item.path, item.name);
			onClose();
		},
		[onSwitchSession, onSwitchProject, onPreviewFile, onClose],
	);

	// Esc closes; ↑/↓ + Enter navigate.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				setActive((a) => Math.min(a + 1, navItems.length - 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setActive((a) => Math.max(a - 1, 0));
			} else if (e.key === "Enter") {
				e.preventDefault();
				activate(navItems[active]);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [navItems, active, activate, onClose]);

	const total = sessionHits.length + projectHits.length + fileHits.length;

	/** Section header with match count. */
	const sectionHead = (label: string, count: number, icon: ReactNode) => (
		<div className="gs-section-head">
			{icon}
			<span>{label}</span>
			<em>{count}</em>
		</div>
	);

	let navIdx = -1;

	return (
		<div className="modal-backdrop gs-backdrop" onClick={onClose}>
			<div className="gs-modal" onClick={(e) => e.stopPropagation()}>
				<div className="gs-input-row">
					<FiSearch />
					<input
						ref={inputRef}
						type="text"
						value={query}
						placeholder={t("gsPlaceholder")}
						onChange={(e) => setQuery(e.target.value)}
					/>
					<button type="button" className="gs-close" title={t("close")} onClick={onClose}>
						<FiX />
					</button>
				</div>

				<div className="gs-results">
					{!q && <div className="gs-empty">{t("gsHint")}</div>}
					{q && total === 0 && !fileTruncated && (
						<div className="gs-empty">
						{filesPending ? t("gsSearching") : t("gsNoResults")}
						</div>
					)}

					{sessionHits.length > 0 && (
						<div className="gs-section">
							{sectionHead(t("gsSessions"), sessionHits.length, <FiMessageSquare />)}
							{sessionHits.map((s) => {
								navIdx++;
								const idx = navIdx;
								return (
									<button
										key={s.path}
										type="button"
										className={idx === active ? "gs-item active" : "gs-item"}
										onMouseEnter={() => setActive(idx)}
										onClick={() =>
											activate({ kind: "session", path: s.path })
										}
									>
										<span className="gs-item-title">
											{s.name || s.path.split(/[\\/]/).pop()}
											<em className="gs-item-meta">{s.messageCount}</em>
										</span>
										<span className="gs-item-sub">{s.firstMessage}</span>
									</button>
								);
							})}
						</div>
					)}

					{projectHits.length > 0 && (
						<div className="gs-section">
							{sectionHead(t("gsProjects"), projectHits.length, <FiFolder />)}
							{projectHits.map((p) => {
								navIdx++;
								const idx = navIdx;
								const isCurrent =
									cwd && p.path === cwd;
								return (
									<button
										key={p.path}
										type="button"
										className={idx === active ? "gs-item active" : "gs-item"}
										onMouseEnter={() => setActive(idx)}
										onClick={() =>
											activate({ kind: "project", path: p.path })
										}
									>
										<span className="gs-item-title">
											{p.path.split(/[\\/]/).pop()}
											{isCurrent && (
												<em className="gs-item-meta">{t("gsCurrentProject")}</em>
											)}
										</span>
										<span className="gs-item-sub">{p.path}</span>
									</button>
								);
							})}
						</div>
					)}

					{(fileHits.length > 0 || (q && fileTruncated)) && (
						<div className="gs-section">
							{sectionHead(t("gsFiles"), fileHits.length, <FiFileText />)}
							{fileHits.map((f) => {
								navIdx++;
								const idx = navIdx;
								return (
									<button
										key={`${f.type}:${f.path}`}
										type="button"
										className={idx === active ? "gs-item active" : "gs-item"}
										disabled={f.type === "dir"}
										title={
											f.type === "dir" ? undefined : t("gsOpenPreview")
										}
										onMouseEnter={() => setActive(idx)}
										onClick={() => {
											if (f.type === "file")
												activate({
													kind: "file",
													path: f.path,
													name: f.name,
												});
										}}
									>
										<span className="gs-item-title">{f.name}</span>
										<span className="gs-item-sub">{f.path}</span>
									</button>
								);
							})}
							{fileTruncated && (
								<div className="gs-truncated">{t("gsTruncated")}</div>
							)}
						</div>
					)}
				</div>

				<div className="gs-foot">
					<span>↑↓ {t("gsNavigate")}</span>
					<span>Enter {t("gsOpen")}</span>
					<span>Esc {t("gsCloseHint")}</span>
				</div>
			</div>
		</div>
	);
}
