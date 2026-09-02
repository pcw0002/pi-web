import { describe, expect, it } from "vitest";
import {
	applyPlan,
	estimateMessageHeight,
	pickAlways,
	planWindow,
	type WinRect,
} from "../../web/src/lazy-window.js";

function rect(id: string, top: number, bottom: number): WinRect {
	return { id, top, bottom };
}

const VIEW = { top: 0, bottom: 1000 };

describe("planWindow", () => {
	it("visible items in the viewport produce no changes", () => {
		const plan = planWindow(
			[rect("a", -50, 500), rect("b", 900, 1100)],
			VIEW,
			new Set(),
			new Set(),
		);
		expect(plan).toEqual({ show: [], hide: [], shrinkAbove: 0 });
	});

	it("items outside the buffer band enter hide; those above the viewport count toward shrinkAbove", () => {
		const plan = planWindow(
			[rect("above", -2000, -300), rect("below", 2600, 3000)],
			VIEW,
			new Set(),
			new Set(),
		);
		expect(plan.hide).toEqual(["above", "below"]);
		expect(plan.shrinkAbove).toBe(1700); // only the one above
	});

	it("straddling the viewport edge (partially visible) is not hidden", () => {
		const plan = planWindow(
			[rect("straddle-top", -10, 400), rect("straddle-bottom", 990, 1400)],
			VIEW,
			new Set(),
			new Set(),
		);
		expect(plan.hide).toEqual([]);
		expect(plan.shrinkAbove).toBe(0);
	});

	it("already-hidden invisible items are not emitted again (prevents per-frame shrink accumulation)", () => {
		const hidden = new Set(["above", "below"]);
		const plan = planWindow(
			[rect("above", -2000, -300), rect("below", 2600, 3000)],
			VIEW,
			new Set(),
			hidden,
		);
		expect(plan.hide).toEqual([]);
		expect(plan.shrinkAbove).toBe(0);
	});

	it("already-hidden items that scrolled back into view enter show", () => {
		const plan = planWindow(
			[rect("back", -200, 600)],
			VIEW,
			new Set(),
			new Set(["back"]),
		);
		expect(plan.show).toEqual(["back"]);
		expect(plan.hide).toEqual([]);
	});

	it("the always set is never hidden and never shown", () => {
		const always = new Set(["pin"]);
		const plan = planWindow(
			[rect("pin", -9999, -9000), rect("far", 5000, 5100)],
			VIEW,
			always,
			new Set(),
		);
		expect(plan.hide).toEqual(["far"]);
		expect(plan.shrinkAbove).toBe(0);
	});
});

describe("applyPlan", () => {
	it("empty plan returns the original reference (skip re-render)", () => {
		const prev = new Set(["a"]);
		expect(applyPlan(prev, { show: [], hide: [], shrinkAbove: 0 })).toBe(prev);
	});

	it("hide/show add/remove correctly without mutating the input", () => {
		const prev = new Set(["a", "b"]);
		const next = applyPlan(prev, { show: ["a"], hide: ["c"], shrinkAbove: 0 });
		expect(next).toEqual(new Set(["b", "c"]));
		expect(prev).toEqual(new Set(["a", "b"]));
	});
});

describe("pickAlways", () => {
	const msgs = (ids: string[]) => ids.map((id) => ({ id, role: "user" }));

	it("packs as many from the end as the budget allows", () => {
		const always = pickAlways(msgs(["a", "b", "c", "d"]), new Map(), 200);
		expect(always.has("d")).toBe(true);
		expect(always.has("c")).toBe(true);
		expect(always.has("b")).toBe(true); // adding b: cumulative 144 still under budget
		expect(always.has("a")).toBe(false); // before adding a, cumulative 216 already over budget
	});

	it("a single giant message (measured height over budget) is the only pinned one", () => {
		const heights = new Map([
			["big", 8000],
			["small1", 72],
			["small2", 72],
		]);
		const always = pickAlways(
			[
				{ id: "old1", role: "user" },
				{ id: "small1", role: "user" },
				{ id: "small2", role: "user" },
				{ id: "big", role: "assistant" },
			],
			heights,
			1600,
		);
		// big measured 8000 → already over budget, stop packing further; but big itself is always kept
		expect([...always]).toEqual(["big"]);
	});

	it("uses estimates when no measured height; always keeps at least the last message", () => {
		const always = pickAlways(msgs(["x", "y"]), new Map(), 0);
		expect([...always]).toEqual(["y"]);
	});

	it("empty message set returns an empty set", () => {
		expect(pickAlways([], new Map(), 1600).size).toBe(0);
	});
});

describe("estimateMessageHeight", () => {
	it("estimates are in the right ballpark by role", () => {
		expect(estimateMessageHeight("user")).toBeLessThan(
			estimateMessageHeight("assistant"),
		);
		expect(estimateMessageHeight("toolResult")).toBeLessThan(
			estimateMessageHeight("user"),
		);
		expect(estimateMessageHeight("custom", "file")).toBeGreaterThan(
			estimateMessageHeight("user"),
		);
		expect(estimateMessageHeight("system")).toBeGreaterThan(0);
	});
});
