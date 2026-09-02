import { describe, expect, it } from "vitest";
import {
	buildSearchHits,
	countOccurrences,
	messageSearchText,
	type SearchMessage,
} from "../../web/src/search-text.js";

function msg(
	partial: Partial<SearchMessage> & Pick<SearchMessage, "id" | "role">,
): SearchMessage {
	return { content: [], ...partial };
}

describe("messageSearchText", () => {
	it("concatenates text / thinking / toolCall / bash blocks", () => {
		const m = msg({
			id: "a1",
			role: "assistant",
			content: [
				{ type: "text", text: "hello world" },
				{ type: "thinking", thinking: "internal reasoning" },
				{
					type: "toolCall",
					id: "t1",
					name: "read",
					argumentsText: '{"path":"src/app.ts"}',
				},
				{ type: "bash", command: "ls -la", output: "total 0" },
			] as SearchMessage["content"],
		});
		const text = messageSearchText(m);
		expect(text).toContain("hello world");
		expect(text).toContain("internal reasoning");
		expect(text).toContain("read");
		expect(text).toContain("src/app.ts");
		expect(text).toContain("ls -la");
		expect(text).toContain("total 0");
	});

	it("toolResult messages are not indexed (no DOM jump target)", () => {
		const m = msg({
			id: "t-1",
			role: "toolResult",
			content: [{ type: "text", text: "tool output content" }],
		});
		expect(messageSearchText(m)).toBe("");
	});

	it("errorMessage is also searchable", () => {
		const m = msg({
			id: "a2",
			role: "assistant",
			errorMessage: "boom explosion",
		});
		expect(messageSearchText(m)).toContain("explosion");
	});
});

describe("countOccurrences", () => {
	it("case-insensitive and counts all non-overlapping occurrences", () => {
		expect(countOccurrences("Ab ab AB", "ab")).toBe(3);
		expect(countOccurrences("aaaa", "aa")).toBe(2);
	});
	it("empty needle returns 0", () => {
		expect(countOccurrences("abc", "")).toBe(0);
	});
});

describe("buildSearchHits", () => {
	it("expands in conversation order to one entry per hit", () => {
		const messages = [
			msg({ id: "u1", role: "user", content: [{ type: "text", text: "foo bar foo" }] }),
			msg({ id: "a1", role: "assistant", content: [{ type: "text", text: "no match" }] }),
			msg({ id: "u2", role: "user", content: [{ type: "text", text: "FOO here" }] }),
		];
		const hits = buildSearchHits(messages, "foo");
		expect(hits).toEqual([
			{ messageId: "u1", occurrence: 0 },
			{ messageId: "u1", occurrence: 1 },
			{ messageId: "u2", occurrence: 0 },
		]);
	});

	it("empty query returns empty list; surrounding whitespace ignored", () => {
		const messages = [
			msg({ id: "u1", role: "user", content: [{ type: "text", text: "abc" }] }),
		];
		expect(buildSearchHits(messages, "")).toEqual([]);
		expect(buildSearchHits(messages, "  ")).toEqual([]);
		expect(buildSearchHits(messages, " abc ")).toHaveLength(1);
	});

	it("skips toolResult and empty-content messages", () => {
		const messages = [
			msg({ id: "t1", role: "toolResult", content: [{ type: "text", text: "abc abc" }] }),
			msg({ id: "a1", role: "assistant", content: [] }),
			msg({ id: "u1", role: "user", content: [{ type: "text", text: "ABC" }] }),
		];
		expect(buildSearchHits(messages, "abc")).toEqual([
			{ messageId: "u1", occurrence: 0 },
		]);
	});
});
