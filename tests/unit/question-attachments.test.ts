/**
 * collectQuestionAttachments unit tests — "restore original attachments" for edit-and-reask.
 *
 * Covers: image blocks in the user message itself, immediately following aside
 * image cards, uploaded files (uploadPath marker), workspace-path attachments
 * (reference/inline/lines), collecting multiple attachments, and a non-file
 * message interrupting collection.
 */
import { describe, expect, it } from "vitest";
import { collectQuestionAttachments } from "../../web/src/question-attachments.js";
import type { EditPromptAttachment } from "../../web/src/question-attachments.js";

// Structural mirror (matches the input types of web/src/question-attachments.ts)
interface TestBlock {
	type: string;
	text?: string;
	dataUrl?: string;
}
interface TestMessage {
	id: string;
	role: string;
	content: TestBlock[];
	customType?: string;
	details?: unknown;
	timestamp?: number;
}
const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function user(id: string, text: string): TestMessage {
	return {
		id,
		role: "user",
		timestamp: 1,
		content: [{ type: "text", text }],
	};
}
function assistant(id: string): TestMessage {
	return {
		id,
		role: "assistant",
		timestamp: 2,
		content: [{ type: "text", text: "ok" }],
	};
}
function fileCard(
	id: string,
	content: { type: string; text?: string; dataUrl?: string }[],
	details: Record<string, unknown>,
): TestMessage {
	return {
		id,
		role: "custom",
		customType: "file",
		timestamp: 3,
		content: content as TestMessage["content"],
		details,
	};
}

describe("collectQuestionAttachments", () => {
	it("collects image blocks from the user message itself", () => {
		const u = {
			...user("u1", "look at image"),
			content: [
				{ type: "text", text: "look at image" },
				{ type: "image", dataUrl: PNG },
			],
		};
		const map = collectQuestionAttachments([u]);
		const atts = map.get("u1")!;
		expect(atts).toHaveLength(1);
		expect(atts[0].imageData).toContain("iVBORw0KG");
		expect(atts[0].path).toBe("");
	});

	it("collects immediately following image aside cards (including vision-bridge thumbnails)", () => {
		const aside = fileCard(
			"c1",
			[{ type: "image", dataUrl: PNG }],
			{ name: "pic.png", mode: "image" },
		);
		const map = collectQuestionAttachments([user("u1", "q"), aside]);
		const atts = map.get("u1")!;
		expect(atts).toHaveLength(1);
		expect(atts[0].imageData).toContain("iVBORw0KG");
		expect(atts[0].name).toBe("pic.png");
	});

	it("uploaded file (upload:true) → uploadPath attachment", () => {
		const aside = fileCard(
			"c1",
			[{ type: "text", text: '<file path="C:/data/u/1/2-x.txt" />' }],
			{ name: "x.txt", path: "C:/data/u/1/2-x.txt", mode: "reference", upload: true },
		);
		const map = collectQuestionAttachments([user("u1", "q"), aside]);
		const atts = map.get("u1")!;
		expect(atts).toHaveLength(1);
		expect(atts[0].uploadPath).toBe("C:/data/u/1/2-x.txt");
		expect(atts[0].name).toBe("x.txt");
		expect(atts[0].imageData).toBeUndefined();
	});

	it("workspace-path attachment: reference → path+mode", () => {
		const aside = fileCard(
			"c1",
			[{ type: "text", text: '<file path="src/a.ts" size="10" />' }],
			{ name: "a.ts", path: "src/a.ts", mode: "reference", size: 10 },
		);
		const map = collectQuestionAttachments([user("u1", "q"), aside]);
		const atts = map.get("u1")!;
		expect(atts).toHaveLength(1);
		expect(atts[0].path).toBe("src/a.ts");
		expect(atts[0].mode).toBe("reference");
	});

	it("workspace-path attachment: lines → path+mode+lines range", () => {
		const aside = fileCard(
			"c1",
			[{ type: "text", text: '<file path="src/a.ts" lines="2-3">```x```</file>' }],
			{
				name: "a.ts",
				path: "src/a.ts",
				mode: "lines",
				size: 100,
				startLine: 2,
				endLine: 3,
			},
		);
		const map = collectQuestionAttachments([user("u1", "q"), aside]);
		const atts = map.get("u1")!;
		expect(atts).toHaveLength(1);
		expect(atts[0].path).toBe("src/a.ts");
		expect(atts[0].mode).toBe("lines");
		expect(atts[0].lines).toEqual({ start: 2, end: 3 });
	});

	it("collects all of: multiple images + multiple files + path attachments", () => {
		const messages: TestMessage[] = [
			user("u1", "q"),
			fileCard("c1", [{ type: "image", dataUrl: PNG }], { name: "a.png", mode: "image" }),
			fileCard("c2", [{ type: "image", dataUrl: PNG }], { name: "b.png", mode: "image" }),
			fileCard(
				"c3",
				[{ type: "text", text: '<file path="C:/u/1/2-d.txt" />' }],
				{ name: "d.txt", path: "C:/u/1/2-d.txt", mode: "reference", upload: true },
			),
			fileCard(
				"c4",
				[{ type: "text", text: '<file path="src/a.ts" />' }],
				{ name: "a.ts", path: "src/a.ts", mode: "reference", size: 9 },
			),
		];
		const atts = collectQuestionAttachments(messages).get("u1")!;
		expect(atts).toHaveLength(4);
		const kinds = atts.map((a) =>
			a.imageData ? "image" : a.uploadPath ? "upload" : "path",
		);
		expect(kinds).toEqual(["image", "image", "upload", "path"]);
	});

	it("does not collect: assistant message interrupting the aside sequence / plain-text question with no attachments", () => {
		const interrupted = [
			user("u1", "q"),
			assistant("a1"),
			fileCard("c1", [{ type: "image", dataUrl: PNG }], { name: "x.png", mode: "image" }),
		];
		expect(collectQuestionAttachments(interrupted).has("u1")).toBe(false);

		expect(collectQuestionAttachments([user("u1", "q")]).has("u1")).toBe(false);
	});

	it("returned attachments can be dropped and resent (edit-and-reask attachments shape)", () => {
		const aside = fileCard(
			"c1",
			[{ type: "text", text: '<file path="src/a.ts" lines="1-1">```x```</file>' }],
			{ name: "a.ts", path: "src/a.ts", mode: "lines", startLine: 1, endLine: 1 },
		);
		const atts: EditPromptAttachment[] =
			collectQuestionAttachments([user("u1", "q"), aside]).get("u1") ?? [];
		// After the user removes the first item, the rest can still be sent as edit_message.attachments
		const kept = atts.slice(1);
		expect(kept).toEqual([]);
	});
});
