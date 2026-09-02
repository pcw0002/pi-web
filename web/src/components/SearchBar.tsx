import {
	useCallback,
	useDeferredValue,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type RefObject,
} from "react";
import { FiChevronDown, FiChevronUp, FiX } from "react-icons/fi";
import type { UiMessage } from "../types";
import { buildSearchHits } from "../search-text";
import { useT } from "../i18n";

/**
 * In-conversation search bar (Ctrl+F / Cmd+F, browser-find style).
 *
 * - Hit index comes from the search-text.ts pure functions (per-message text join);
 * - Inline highlight uses the **CSS Custom Highlight API** (CSS.highlights + ::highlight()):
 *   Ranges are built directly on DOM text nodes, without touching the react-markdown tree;
 *   unsupported browsers fall back to jump-only (no inline highlight; the message still flashes);
 * - Before jumping, onEnsureExpanded synchronously expands collapsed old messages so the hit is in the DOM.
 */

interface SearchBarProps {
	/** Message scroll container (.messages) — Range collection and scrolling both happen in its subtree. */
	containerRef: RefObject<HTMLDivElement | null>;
	messages: readonly UiMessage[];
	open: boolean;
	onClose: () => void;
	/** If the jump target is a collapsed old message, expand it first (parent flushSync). */
	onEnsureExpanded: (messageId: string) => void;
}

/** Collect every text range in the container subtree that contains query (case-insensitive, in-node match). */
function collectRanges(
	root: HTMLElement,
	query: string,
): { byMsg: Map<string, Range[]>; all: Range[] } {
	const byMsg = new Map<string, Range[]>();
	const all: Range[] = [];
	const needle = query.toLowerCase();
	if (!needle) return { byMsg, all };
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const el = node.parentElement;
			// Skip the search bar itself so the query text in the input is not highlighted.
			if (!el || el.closest(".search-bar")) return NodeFilter.FILTER_REJECT;
			return (node.textContent ?? "").toLowerCase().includes(needle)
				? NodeFilter.FILTER_ACCEPT
				: NodeFilter.FILTER_SKIP;
		},
	});
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const lower = (node.textContent ?? "").toLowerCase();
		const owner = node.parentElement?.closest("[data-msg-id]");
		if (!owner) continue;
		const id = owner.getAttribute("data-msg-id") ?? "";
		let idx = lower.indexOf(needle);
		while (idx !== -1) {
			const r = document.createRange();
			r.setStart(node, idx);
			r.setEnd(node, idx + needle.length);
			all.push(r);
			const list = byMsg.get(id);
			if (list) list.push(r);
			else byMsg.set(id, [r]);
			idx = lower.indexOf(needle, idx + needle.length);
		}
	}
	return { byMsg, all };
}

function setHighlight(name: string, ranges: Range[]) {
	const css = CSS as unknown as { highlights?: Map<string, unknown> };
	if (!css.highlights) return;
	if (ranges.length === 0) {
		css.highlights.delete(name);
		return;
	}
	// Highlight constructor is untyped in older lib.dom; feature-detect at runtime.
	const Ctor = (
		window as unknown as { Highlight?: new (...r: Range[]) => unknown }
	).Highlight;
	if (Ctor) css.highlights.set(name, new Ctor(...ranges));
}

export function SearchBar({
	containerRef,
	messages,
	open,
	onClose,
	onEnsureExpanded,
}: SearchBarProps) {
	const t = useT();
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const deferredQuery = useDeferredValue(query);

	// Hit list: recompute when the message set or query changes (useMemo keeps the reference stable)
	const q = open ? deferredQuery.trim() : "";
	const hits = useMemo(
		() => (open ? buildSearchHits(messages, q) : []),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- messages array ref is stable (server cache); q/open are primitives
		[messages, q, open],
	);
	// refs mirror the latest values so rAF callbacks can read them without rebuilding the effect
	const hitsRef = useRef(hits);
	hitsRef.current = hits;
	const activeRef = useRef(active);
	activeRef.current = active;

	// Focus the input on open; if the message pane has a selection, prefill from it
	useEffect(() => {
		if (!open) return;
		setActive(0);
		requestAnimationFrame(() => inputRef.current?.select());
	}, [open]);

	// While open, intercept Esc to close
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, onClose]);

	// Clear highlights on close / unmount
	useEffect(() => {
		if (!open) {
			setHighlight("msg-search", []);
			setHighlight("msg-search-active", []);
		}
		return () => {
			setHighlight("msg-search", []);
			setHighlight("msg-search-active", []);
		};
	}, [open]);

	const flashMsg = useCallback(
		(messageId: string) => {
			const wrap = containerRef.current;
			if (!wrap) return;
			const el = wrap.querySelector<HTMLElement>(
				`[data-msg-id="${messageId}"]`,
			);
			if (!el) return;
			el.classList.remove("msg-flash");
			void el.offsetWidth; // restart the animation
			el.classList.add("msg-flash");
		},
		[containerRef],
	);

	// Highlight + scroll to the current hit. The DOM may have just updated from an expand — collect after rAF.
	useLayoutEffect(() => {
		if (!open || !q) return;
		const wrap = containerRef.current;
		if (!wrap) return;
		let cancelled = false;
		let raf = 0;
		raf = requestAnimationFrame(() => {
			if (cancelled) return;
			const { byMsg, all } = collectRanges(wrap, q);
			setHighlight("msg-search", all);
			const list = hitsRef.current;
			const hit = list[Math.min(activeRef.current, list.length - 1)];
			if (!hit) return;
			const range = byMsg.get(hit.messageId)?.[hit.occurrence];
			if (range) {
				setHighlight("msg-search-active", [range]);
				const startEl =
					range.startContainer.parentElement ??
					wrap.querySelector(`[data-msg-id="${hit.messageId}"]`);
				startEl?.scrollIntoView({ block: "center" });
			} else {
				// Hit exists in the index but not in the DOM (e.g. streaming rebuilt the node) — fall back to message-level jump
				flashMsg(hit.messageId);
			}
		});
		return () => {
			cancelled = true;
			cancelAnimationFrame(raf);
		};
	}, [open, q, hits, containerRef, flashMsg]);

	const step = useCallback(
		(dir: 1 | -1) => {
			const list = hitsRef.current;
			if (list.length === 0) return;
			const next = (activeRef.current + dir + list.length) % list.length;
			setActive(next);
			// Expand collapsed old messages first so the next layout effect can find them in the DOM
			onEnsureExpanded(list[next].messageId);
		},
		[onEnsureExpanded],
	);

	if (!open) return null;
	const total = hits.length;
	return (
		<div className="search-bar" role="search">
			<input
				ref={inputRef}
				className="search-input"
				type="text"
				value={query}
				placeholder={t("searchPlaceholder")}
				onChange={(e) => {
					setQuery(e.target.value);
					setActive(0);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						step(e.shiftKey ? -1 : 1);
					}
				}}
			/>
			<span className={`search-count ${total === 0 ? "empty" : ""}`}>
				{total === 0
					? t("searchNoResults")
					: `${Math.min(active + 1, total)}/${total}`}
			</span>
			<button
				type="button"
				className="search-btn"
				title={t("searchPrev")}
				disabled={total === 0}
				onClick={() => step(-1)}
			>
				<FiChevronUp />
			</button>
			<button
				type="button"
				className="search-btn"
				title={t("searchNext")}
				disabled={total === 0}
				onClick={() => step(1)}
			>
				<FiChevronDown />
			</button>
			<button
				type="button"
				className="search-btn"
				title={t("searchClose")}
				onClick={onClose}
			>
				<FiX />
			</button>
		</div>
	);
}
