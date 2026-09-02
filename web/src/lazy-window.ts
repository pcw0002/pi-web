/**
 * Pure-function half of message-list lazy windowing (zero React, unit-testable).
 *
 * Strategy: the DOM cost of fully rendering the recent segment grows with
 * message size (one large tool output / long code block is thousands of
 * nodes). Instead of absolutely-positioned virtual scroll, this uses
 * "lazy mount + height placeholders": heavy messages outside the viewport
 * (plus a rootMargin band above and below) are replaced with a fixed-height
 * placeholder div. Scrolling nearby swaps the real content back in, with
 * same-frame scrollTop compensation so the view doesn't jump. Placeholders
 * keep data-msg-id so question-nav / jump / flash DOM queries still work.
 */

/** Bounding box of one message relative to the viewport (any consistent coordinate system, typically the container's). */
export interface WinRect {
	id: string;
	top: number;
	bottom: number;
}

export interface WindowPlan {
	/** Message ids that should return from placeholder to real render. */
	show: string[];
	/** Message ids that should be replaced with a placeholder. */
	hide: string[];
	/**
	 * Total content-height shrinkage from newly hidden items that sit
	 * entirely above the viewport: after commit, scrollTop -= shrinkAbove
	 * to keep the visible content still.
	 */
	shrinkAbove: number;
}

/**
 * Compute this frame's window plan. Only emits **deltas**: items already in
 * the hidden set are not listed again (avoids double-counting shrinkAbove
 * across consecutive rAF frames). Items in the always set are left alone.
 *
 * @param items    Rects of every managed message (usually from getBoundingClientRect)
 * @param viewport Viewport interval including the buffer band {top, bottom} (same coords as items)
 * @param always   Message ids that must never be placeholder'd (always real-rendered)
 * @param hidden   Message ids currently in the placeholder state
 */
export function planWindow(
	items: readonly WinRect[],
	viewport: { top: number; bottom: number },
	always: ReadonlySet<string>,
	hidden: ReadonlySet<string>,
): WindowPlan {
	const show: string[] = [];
	const hide: string[] = [];
	let shrinkAbove = 0;
	for (const it of items) {
		if (always.has(it.id)) continue;
		const visible = it.top < viewport.bottom && it.bottom > viewport.top;
		if (visible) {
			if (hidden.has(it.id)) show.push(it.id);
		} else if (!hidden.has(it.id)) {
			hide.push(it.id);
			// Collapsing an item entirely above the viewport shifts everything
			// below it up — roll scrollTop back by that height.
			if (it.bottom <= viewport.top) shrinkAbove += it.bottom - it.top;
		}
	}
	return { show, hide, shrinkAbove };
}

/** Apply a window plan to the hidden set (pure: returns the previous reference when unchanged, so renders can be skipped). */
export function applyPlan(
	prev: ReadonlySet<string>,
	plan: WindowPlan,
): Set<string> {
	if (plan.show.length === 0 && plan.hide.length === 0)
		return prev as Set<string>;
	const next = new Set(prev);
	for (const id of plan.show) next.delete(id);
	for (const id of plan.hide) next.add(id);
	return next;
}

/**
 * Pick the always-on bottom region: accumulate height from the tail
 * (measured first, estimate as fallback) and stop once the budget is
 * exceeded. A count-based always-on set would be blown out by one giant
 * message (large tool output / long code block) — exactly what this module
 * exists to optimize. A height budget keeps the always-on region bounded.
 */
export function pickAlways(
	msgs: readonly { id: string; role: string; customType?: string }[],
	heights: ReadonlyMap<string, number>,
	budget: number,
): Set<string> {
	const out = new Set<string>();
	let acc = 0;
	for (let i = msgs.length - 1; i >= 0; i--) {
		if (i < msgs.length - 1 && acc >= budget) break;
		const m = msgs[i];
		out.add(m.id);
		acc += heights.get(m.id) ?? estimateMessageHeight(m.role, m.customType);
	}
	return out;
}

/**
 * Unrendered messages have no measured height; give a rough placeholder
 * height by role. Only the order of magnitude matters (first scroll-up
 * shouldn't jump much); once really rendered, the measured value replaces
 * the estimate.
 */
export function estimateMessageHeight(
	role: string,
	customType?: string,
): number {
	switch (role) {
		case "user":
			return 72;
		case "assistant":
			return 280;
		case "toolResult":
			return 8; // Content is folded into the toolCall card; the row itself is nearly zero height.
		case "custom":
			return customType === "file" ? 96 : 72;
		default:
			return 60;
	}
}
