import { describe, expect, it } from "vitest";
import { segmentStream } from "../../web/src/stream-markdown.js";

describe("segmentStream", () => {
	it("empty text → no frozen, no active", () => {
		const s = segmentStream("");
		expect(s.frozen).toEqual([]);
		expect(s.active).toBe("");
		expect(s.inFence).toBe(false);
	});

	it("single unfinished paragraph stays entirely in active", () => {
		const s = segmentStream("this is the first line\nstill writing the second");
		expect(s.frozen).toEqual([]);
		expect(s.active).toBe("this is the first line\nstill writing the second");
	});

	it("blank-line-separated complete paragraphs freeze; tail stays in active", () => {
		const text = "first paragraph.\n\nsecond paragraph is complete.\n\nthird paragraph is half done";
		const s = segmentStream(text);
		expect(s.frozen).toEqual(["first paragraph.", "second paragraph is complete."]);
		expect(s.active).toBe("third paragraph is half done");
	});

	it("frozen paragraphs stay unchanged after append (append-only stability)", () => {
		const before = segmentStream("para one.\n\npara two.");
		const after = segmentStream("para one.\n\npara two.\n\npara three.");
		expect(after.frozen.slice(0, before.frozen.length)).toEqual(before.frozen);
		expect(before.active).toBe("para two.");
		expect(after.frozen).toContain("para two.");
	});

	it("unclosed code fence: fence and following content stay in active with inFence=true", () => {
		const text = "look at this:\n\n```python\ndef foo():\n    return 1";
		const s = segmentStream(text);
		expect(s.frozen).toEqual(["look at this:"]);
		expect(s.active).toBe("```python\ndef foo():\n    return 1");
		expect(s.inFence).toBe(true);
	});

	it("closed code fence freezes normally (whole code block included)", () => {
		const text = "note.\n\n```js\nconsole.log(1);\n```\n\nnext paragraph";
		const s = segmentStream(text);
		expect(s.frozen).toEqual(["note.", "```js\nconsole.log(1);\n```"]);
		expect(s.active).toBe("next paragraph");
		expect(s.inFence).toBe(false);
	});

	it("tilde fences recognized the same way; short closer does not end a long opener", () => {
		let s = segmentStream("~~~js\nx = `~~`;\n~");
		expect(s.inFence).toBe(true);
		s = segmentStream("~~~js\nx = 1;\n~~~\n\nafter");
		expect(s.inFence).toBe(false);
		expect(s.frozen[0]).toContain("x = 1;");
	});

	it("blank line + list marker does not split (loose list keeps numbering continuous)", () => {
		const text = "1. first item\n\n2. second item\n\n3. third item";
		const s = segmentStream(text);
		expect(s.frozen).toEqual([]);
		expect(s.active).toBe(text);
	});

	it("unordered lists likewise do not split", () => {
		const text = "- a\n\n- b";
		const s = segmentStream(text);
		expect(s.frozen).toEqual([]);
		expect(s.active).toBe(text);
	});

	it("after a list, following ordinary paragraphs freeze normally", () => {
		const text = "1. a\n\n2. b\n\nsummary: done.\n\nnew start";
		const s = segmentStream(text);
		// The whole loose list is one frozen segment; later ordinary paragraphs freeze on their own
		expect(s.frozen).toEqual(["1. a\n\n2. b", "summary: done."]);
		expect(s.active).toBe("new start");
	});

	it("```-like content inside a fence is not mistaken for a boundary", () => {
		const text = '```bash\necho "```"\nmore\n```\n\nafter';
		const s = segmentStream(text);
		// ``` inside the fence is mid-line (not a fence-marker position), so structure is unaffected
		expect(s.frozen[0]).toContain('echo "```"');
		expect(s.inFence).toBe(false);
	});
});
