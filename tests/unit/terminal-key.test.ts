import { describe, expect, it } from "vitest";
import { encodeTerminalKey } from "../../server/terminals.js";

/** Byte-level assertions — named keys route by name; Ctrl/Alt combos never fall back to "Ctrl+first letter". */
describe("encodeTerminalKey", () => {
	it("plain characters sent as-is", () => {
		expect(encodeTerminalKey("a")).toEqual({ data: "a" });
	});

	it("Enter / Tab / Escape", () => {
		expect(encodeTerminalKey("Enter")).toEqual({ data: "\r" });
		expect(encodeTerminalKey("Tab")).toEqual({ data: "\t" });
		expect(encodeTerminalKey("Escape")).toEqual({ data: "\x1b" });
	});

	it("arrow keys with no modifiers", () => {
		expect(encodeTerminalKey("ArrowUp")).toEqual({ data: "\x1b[A" });
		expect(encodeTerminalKey("ArrowDown")).toEqual({ data: "\x1b[B" });
	});

	it("Ctrl+ArrowUp = ESC[1;5A (not Ctrl+A)", () => {
		expect(encodeTerminalKey("ArrowUp", { ctrl: true })).toEqual({
			data: "\x1b[1;5A",
		});
	});

	it("Ctrl+Enter = CSI-u 13;5 (not Ctrl+E)", () => {
		expect(encodeTerminalKey("Enter", { ctrl: true })).toEqual({
			data: "\x1b[13;5u",
		});
	});

	it("plain-character Ctrl maps A–Z → 0x01–0x1A", () => {
		expect(encodeTerminalKey("c", { ctrl: true })).toEqual({ data: "\x03" });
		expect(encodeTerminalKey("u", { ctrl: true })).toEqual({ data: "\x15" });
	});

	it("Alt prefixes ESC; Shift uppercases", () => {
		expect(encodeTerminalKey("x", { alt: true })).toEqual({ data: "\x1bx" });
		expect(encodeTerminalKey("x", { shift: true })).toEqual({ data: "X" });
	});

	it("stacked modifiers: xterm modifier sequence ESC[1;<m>H (unmodified stays ESC[H)", () => {
		const home = (m: object) =>
			(encodeTerminalKey("Home", m as never) as { data?: string }).data;
		expect(home({})).toBe("\x1b[H");
		expect(home({ shift: true })).toBe("\x1b[1;2H");
		expect(home({ alt: true })).toBe("\x1b[1;3H");
		expect(home({ ctrl: true })).toBe("\x1b[1;5H");
		expect(home({ ctrl: true, shift: true })).toBe("\x1b[1;6H");
		expect(home({ ctrl: true, alt: true })).toBe("\x1b[1;7H");
		expect(home({ ctrl: true, alt: true, shift: true })).toBe("\x1b[1;8H");
	});

	it("unsupported keys return error", () => {
		const a = encodeTerminalKey("F13");
		const b = encodeTerminalKey("");
		expect("error" in a && a.error).toBeTruthy();
		expect("error" in b && b.error).toBeTruthy();
	});
});
