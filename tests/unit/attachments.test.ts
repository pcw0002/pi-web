/**
 * buildAttachmentMessages unit tests (zero token, no server).
 *
 * Covers the edit-and-reask attachment restore pipeline:
 *   1. Newly uploaded fileData → aside card details.upload === true (browser restores by path);
 *   2. Restored uploadPath → server re-reads bytes from the uploads dir and re-attaches at the same path;
 *   3. uploadPath outside this client's uploads dir → reject + notice;
 *   4. uploadPath points at a cleaned-up / missing file → notice + skip;
 *   5. Workspace-path attachments (reference/inline/lines) re-attached as-is.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAttachmentMessages, type AttachmentContext } from "../../server/attachments.js";
import { saveUpload, uploadsRoot } from "../../server/uploads.js";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "piweb-attach-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Aside {
	message: {
		customType: string;
		details: {
			name?: string;
			path?: string;
			mode?: string;
			size?: number;
			upload?: boolean;
			startLine?: number;
			endLine?: number;
		};
		content: { type: string; text?: string; data?: string }[];
	};
}

function makeCtx(opts: {
	dataDir: string;
	cwd: string;
	clientId?: string;
	notices: { level: string; text: string }[];
}): AttachmentContext {
	const { notices } = opts;
	return {
		cwd: opts.cwd,
		clientId: opts.clientId ?? "test-client",
		emit: (m: { level?: string; text?: string; [k: string]: unknown }) =>
			notices.push({ level: m.level ?? "", text: m.text ?? "" }),
		settings: {
			promptMode: "append" as const,
			customSystemPrompt: "",
			disabledSkills: [],
			disabledExtensions: [],
			terminalToolsEnabled: true,
			terminalBash: false,
			terminalBashIdleMs: 15000,
			visionBridgeEnabled: true,
			visionBridgeModel: null,
			visionBridgePromptMode: "append" as const,
			visionBridgePrompt: "",
			reviewPrompt: "",
			reviewDisabledSkills: [],
			additionalSkillPaths: [],
			thinkingWrap: true,
		},
		// Non-vision path only needs session.model / modelRuntime placeholders (no SDK).
		session: { model: null, modelRuntime: null } as unknown as AttachmentContext["session"],
	};
}

describe("buildAttachmentMessages — edit-and-reask attachment restore", () => {
	it("new fileData upload aside card has upload:true (restore by path)", async () => {
		const dataDir = tempDir();
		const oldDataDir = process.env.PI_WEB_DATA_DIR;
		process.env.PI_WEB_DATA_DIR = dataDir;
		try {
			const notices: { level: string; text: string }[] = [];
			const ctx = makeCtx({ dataDir, cwd: tempDir(), notices });
			const out = (await buildAttachmentMessages(ctx, [
				{
					path: "",
					fileData: Buffer.from("hello world\nfoo").toString("base64"),
					mimeType: "text/plain",
					name: "note.txt",
					size: 15,
				},
			])) as Aside[];
			expect(out.length).toBe(1);
			expect(out[0].message.customType).toBe("file");
			expect(out[0].message.details.upload).toBe(true);
			// Small text file → inline; path is absolute under the uploads dir
			expect(out[0].message.details.mode).toBe("inline");
			const abs = out[0].message.details.path!;
			expect(abs.startsWith(uploadsRoot(dataDir).replace(/\\/g, "/"))).toBe(
				true,
			);
			expect(out[0].message.content[0].text).toContain("hello world");
		} finally {
			if (oldDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
			else process.env.PI_WEB_DATA_DIR = oldDataDir;
		}
	});

	it("restored uploadPath re-reads bytes from uploads dir and re-attaches at the same path", async () => {
		const dataDir = tempDir();
		const oldDataDir = process.env.PI_WEB_DATA_DIR;
		process.env.PI_WEB_DATA_DIR = dataDir;
		try {
			const clientId = "edit-client";
			// Persist a real upload first, simulating "uploaded on a previous prompt"
			const { abs, displayName } = saveUpload(
				clientId,
				"data.bin",
				Buffer.from([0, 1, 2, 3, 4]),
				dataDir,
			);
			const notices: { level: string; text: string }[] = [];
			const ctx = makeCtx({ dataDir, cwd: tempDir(), clientId, notices });
			const out = (await buildAttachmentMessages(ctx, [
				{
					path: "",
					uploadPath: abs.replace(/\\/g, "/"),
					name: displayName,
					size: 5,
				},
			])) as Aside[];
			expect(out.length).toBe(1);
			// Binary → reference
			expect(out[0].message.details.mode).toBe("reference");
			expect(out[0].message.details.upload).toBe(true);
			expect(out[0].message.details.name).toBe(displayName);
			expect(out[0].message.details.path).toBe(abs.replace(/\\/g, "/"));
			expect(out[0].message.content[0].text).toContain('size="5"');
		} finally {
			if (oldDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
			else process.env.PI_WEB_DATA_DIR = oldDataDir;
		}
	});

	it("restored uploadPath outside this client's uploads dir → reject + notice", async () => {
		const dataDir = tempDir();
		const oldDataDir = process.env.PI_WEB_DATA_DIR;
		process.env.PI_WEB_DATA_DIR = dataDir;
		try {
			// File in another client's directory
			const other = saveUpload("other-client", "x.txt", Buffer.from("x"), dataDir);
			const notices: { level: string; text: string }[] = [];
			const ctx = makeCtx({ dataDir, cwd: tempDir(), clientId: "edit-client", notices });
			const out = (await buildAttachmentMessages(ctx, [
				{
					path: "",
					uploadPath: other.abs.replace(/\\/g, "/"),
					name: "x.txt",
				},
			])) as Aside[];
			expect(out.length).toBe(0);
			expect(notices.some((n) => /not in this client's upload directory/.test(n.text))).toBe(
				true,
			);
		} finally {
			if (oldDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
			else process.env.PI_WEB_DATA_DIR = oldDataDir;
		}
	});

	it("restored uploadPath file already cleaned up → notice + skip", async () => {
		const dataDir = tempDir();
		const oldDataDir = process.env.PI_WEB_DATA_DIR;
		process.env.PI_WEB_DATA_DIR = dataDir;
		try {
			const notices: { level: string; text: string }[] = [];
			const ctx = makeCtx({ dataDir, cwd: tempDir(), clientId: "edit-client", notices });
			const out = (await buildAttachmentMessages(ctx, [
				{
					path: "",
					uploadPath: uploadsRoot(dataDir)
						.replace(/\\/g, "/")
						.concat("/edit-client/12345-gone.txt"),
					name: "gone.txt",
				},
			])) as Aside[];
			expect(out.length).toBe(0);
			expect(notices.some((n) => /cleaned up or unreadable/.test(n.text))).toBe(true);
		} finally {
			if (oldDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
			else process.env.PI_WEB_DATA_DIR = oldDataDir;
		}
	});

	it("workspace-path attachments (reference / inline / lines) re-attached as-is", async () => {
		const cwd = tempDir();
		const src = join(cwd, "src");
		mkdirSync(src, { recursive: true });
		const fileA = join(src, "a.ts");
		writeFileSync(fileA, "export const a = 1;\nexport const b = 2;\n");
		const big = join(src, "big.md");
		writeFileSync(big, "x".repeat(20 * 1024));

		const notices: { level: string; text: string }[] = [];
		const ctx = makeCtx({ dataDir: tempDir(), cwd, clientId: "c", notices });
		const out = (await buildAttachmentMessages(ctx, [
			{ path: "src/a.ts", mode: "reference" },
			{ path: "src/a.ts", mode: "inline" },
			{ path: "src/a.ts", mode: "lines", lines: { start: 1, end: 1 } },
			{ path: "src/big.md", mode: "reference" },
		])) as Aside[];
		expect(out.length).toBe(4);
		expect(out[0].message.details.mode).toBe("reference");
		expect(out[0].message.details.path).toBe("src/a.ts");
		expect(out[1].message.details.mode).toBe("inline");
		expect(out[1].message.content[0].text).toContain("export const a = 1");
		expect(out[2].message.details.mode).toBe("lines");
		expect(out[2].message.details.startLine).toBe(1);
		expect(out[2].message.details.endLine).toBe(1);
		expect(out[3].message.details.mode).toBe("reference");
		expect(out[3].message.details.path).toBe("src/big.md");
	});
});
