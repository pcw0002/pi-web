import { describe, expect, it } from "vitest";
import {
	countLines,
	decodeText,
	hexDump,
	looksLikeText,
	previewKind,
	sniffImageMime,
} from "../../server/text-sniff.js";

describe("previewKind", () => {
	it("classifies image/video/text/unknown", () => {
		expect(previewKind("a.png")).toBe("image");
		expect(previewKind("b.MP4")).toBe("video");
		expect(previewKind("c.ts")).toBe("text");
		expect(previewKind("d.exe")).toBe("none");
	});

	it("extensionless and dotfile names are treated as text", () => {
		expect(previewKind("Makefile")).toBe("text");
		expect(previewKind(".gitignore")).toBe("text");
		expect(previewKind(".env")).toBe("text");
	});
});

describe("looksLikeText", () => {
	it("empty buffer is text", () => {
		expect(looksLikeText(Buffer.alloc(0))).toBe(true);
	});

	it("NUL byte is classified as binary", () => {
		expect(looksLikeText(Buffer.from([0x50, 0x4b, 0x00, 0x01]))).toBe(false);
	});

	it("normal UTF-8 is text", () => {
		expect(looksLikeText(Buffer.from("你好 world\nline2\n"))).toBe(true);
	});
});

describe("decodeText", () => {
	it("strict UTF-8 decodes directly", () => {
		const s = "中文内容";
		expect(decodeText(Buffer.from(s, "utf8"))).toBe(s);
	});

	it("GBK bytes fall back to GBK decode (legacy Windows Chinese files)", () => {
		const gbk = Buffer.from([
			0xd6, 0xd0, 0xce, 0xc4, // "中文" in GBK
		]);
		expect(decodeText(gbk)).toBe("中文");
	});
});

describe("sniffImageMime", () => {
	it("PNG magic", () => {
		const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(sniffImageMime(buf, ".png")).toBe("image/png");
	});

	it("JPEG magic", () => {
		expect(
			sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), ".jpg"),
		).toBe("image/jpeg");
	});

	it("GIF87a/GIF89a magic", () => {
		expect(sniffImageMime(Buffer.from("GIF89a...."), ".gif")).toBe("image/gif");
		expect(sniffImageMime(Buffer.from("GIF87a...."), ".gif")).toBe("image/gif");
	});

	it("RIFF+WEBP magic", () => {
		const buf = Buffer.concat([
			Buffer.from("RIFF"),
			Buffer.alloc(4),
			Buffer.from("WEBP"),
		]);
		expect(sniffImageMime(buf, "")).toBe("image/webp");
	});

	it("BMP magic", () => {
		expect(sniffImageMime(Buffer.from([0x42, 0x4d]), "")).toBe("image/bmp");
	});

	it("unknown magic but image extension → trust the extension", () => {
		expect(sniffImageMime(Buffer.from("junk"), ".png")).toBe("image/png");
	});

	it("nothing image-like → null", () => {
		expect(sniffImageMime(Buffer.from("junk"), "")).toBeNull();
		expect(sniffImageMime(Buffer.from("junk"), ".txt")).toBeNull();
	});
});

describe("hexDump", () => {
	it("line format: offset + hex + ASCII", () => {
		const out = hexDump(Buffer.from("AB"));
		// offset 8 hex digits + two spaces + hex (47 wide) + two spaces + ascii
		expect(out).toMatch(/^00000000  41 42\s+  AB$/);
	});

	it("truncates past maxBytes", () => {
		const out = hexDump(Buffer.alloc(100, 1), 16);
		expect(out.split("\n")).toHaveLength(1);
	});

	it("non-printable ASCII shown as dots", () => {
		const out = hexDump(Buffer.from([0x01]));
		expect(out.endsWith(".")).toBe(true);
	});
});

describe("countLines", () => {
	it("trailing newline does not produce an empty line", () => {
		expect(countLines(Buffer.from("a\nb\n"))).toBe(2);
	});

	it("no trailing newline still counts a line", () => {
		expect(countLines(Buffer.from("a\nb"))).toBe(2);
	});

	it("empty buffer is 0 lines", () => {
		expect(countLines(Buffer.alloc(0))).toBe(0);
	});

	it("newline-only = 1 line", () => {
		expect(countLines(Buffer.from("\n"))).toBe(1);
	});
});
