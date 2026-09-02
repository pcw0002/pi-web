import { memo, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

interface LazyMountProps {
	/** Message id — placeholders keep data-msg-id so question-nav / search-jump queries still work. */
	id: string;
	/** false = render a fixed-height placeholder; true = render real content. */
	show: boolean;
	/** Placeholder height (last measured value or a role estimate). */
	height: number;
	/** Scroll container (.messages), used for scrollTop compensation at the moment of show. */
	containerRef: RefObject<HTMLDivElement | null>;
	/** Report measured height after real content mounts (parent writes the heights cache). */
	onMeasured?: (id: string, height: number) => void;
	/** Outer wrapper element ref (parent sweep needs to measure every managed element). */
	lazyRef?: (el: HTMLDivElement | null) => void;
	children: ReactNode;
}

/**
 * Lazy-mount wrapper: while hidden, render an equal-height placeholder div that
 * keeps data-msg-id; at the moment of show, a layout effect (after commit,
 * before paint) measures the real height and, if the element sits entirely
 * above the viewport, compensates scrollTop by (real − placeholder) to cancel
 * the visual jump when scrolling upward.
 */
export const LazyMount = memo(function LazyMount({
	id,
	show,
	height,
	containerRef,
	onMeasured,
	lazyRef,
	children,
}: LazyMountProps) {
	const innerRef = useRef<HTMLDivElement>(null);
	// Whether the previous frame was shown (null = just mounted, skip compensation)
	const wasShown = useRef<boolean | null>(null);

	useLayoutEffect(() => {
		const was = wasShown.current;
		wasShown.current = show;
		if (!show || was !== false) return;
		const inner = innerRef.current;
		const root = containerRef.current;
		if (!inner || !root) return;
		const h = inner.offsetHeight;
		onMeasured?.(id, h);
		const delta = h - height;
		if (delta !== 0) {
			const wrap = inner.parentElement;
			if (
				wrap &&
				wrap.getBoundingClientRect().bottom <= root.getBoundingClientRect().top
			) {
				// Content sits entirely above the viewport: swapping placeholder for real content shifts everything below — roll it back.
				root.scrollTop += delta;
			}
		}
		// Measure only on show/hide transitions; height/onMeasured changes must not re-run
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [show]);

	if (!show) {
		return (
			<div
				ref={lazyRef}
				className="msg-lazy-ph"
				data-msg-id={id}
			data-lazy-id={id}
				style={{ height }}
				aria-hidden="true"
			/>
		);
	}
	return (
		<div ref={lazyRef} data-lazy-id={id}>
			<div ref={innerRef}>{children}</div>
		</div>
	);
});
