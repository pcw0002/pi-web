import type { DiffFile, DiffHunk, DiffLine, FileStatus } from "./types.js";

const GIT_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER =
	/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const OLD_PATH = /^--- (?:a\/(.+)|\/dev\/null)$/;
const NEW_PATH = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/;

export function parseGitDiff(diffText: string): DiffFile[] {
	if (!diffText.trim()) {
		return [];
	}

	const chunks = diffText.split(/(?=^diff --git )/m).filter((chunk) => chunk.trim());
	return chunks.map(parseFileChunk);
}

function parseFileChunk(chunk: string): DiffFile {
	const lines = chunk.split("\n");
	const header = lines[0] ?? "";
	const gitMatch = header.match(GIT_HEADER);
	const aPath = gitMatch?.[1] ?? "";
	const bPath = gitMatch?.[2] ?? "";

	let oldPath: string | null = aPath || null;
	let newPath: string | null = bPath || null;
	let binary = false;
	let renamed = false;
	let newFile = false;
	let deletedFile = false;

	const hunkStartIndexes: number[] = [];

	for (let i = 1; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (line.startsWith("@@ ")) {
			hunkStartIndexes.push(i);
		} else if (line.startsWith("new file mode")) {
			newFile = true;
		} else if (line.startsWith("deleted file mode")) {
			deletedFile = true;
		} else if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
			renamed = true;
		} else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
			binary = true;
		} else {
			const oldMatch = line.match(OLD_PATH);
			if (oldMatch) {
				oldPath = oldMatch[1] ?? null;
			}
			const newMatch = line.match(NEW_PATH);
			if (newMatch) {
				newPath = newMatch[1] ?? null;
			}
		}
	}

	const hunks: DiffHunk[] = [];
	if (!binary) {
		for (let h = 0; h < hunkStartIndexes.length; h += 1) {
			const start = hunkStartIndexes[h] ?? 0;
			const end = hunkStartIndexes[h + 1] ?? lines.length;
			const hunk = parseHunk(lines.slice(start, end));
			if (hunk) {
				hunks.push(hunk);
			}
		}
	}

	const status = fileStatus({ newFile, deletedFile, renamed, oldPath, newPath });
	const path = displayPath({ status, oldPath, newPath, aPath, bPath });

	return {
		oldPath,
		newPath,
		path,
		status,
		binary,
		hunks,
	};
}

function fileStatus(args: {
	newFile: boolean;
	deletedFile: boolean;
	renamed: boolean;
	oldPath: string | null;
	newPath: string | null;
}): FileStatus {
	if (args.renamed || (args.oldPath && args.newPath && args.oldPath !== args.newPath)) {
		return "renamed";
	}
	if (args.newFile || args.oldPath === null) {
		return "added";
	}
	if (args.deletedFile || args.newPath === null) {
		return "deleted";
	}
	return "modified";
}

function displayPath(args: {
	status: FileStatus;
	oldPath: string | null;
	newPath: string | null;
	aPath: string;
	bPath: string;
}): string {
	if (args.status === "deleted") {
		return args.oldPath ?? args.aPath;
	}
	return args.newPath ?? (args.bPath || args.oldPath || args.aPath);
}

function parseHunk(lines: string[]): DiffHunk | null {
	const headerLine = lines[0] ?? "";
	const match = headerLine.match(HUNK_HEADER);
	if (!match) {
		return null;
	}

	const oldStart = Number(match[1]);
	const oldCount = match[2] === undefined ? 1 : Number(match[2]);
	const newStart = Number(match[3]);
	const newCount = match[4] === undefined ? 1 : Number(match[4]);
	const suffix = (match[5] ?? "").trimEnd();
	const header = suffix.length > 0 ? `@@ -${match[1]}${formatCount(match[2])} +${match[3]}${formatCount(match[4])} @@${suffix}` : headerLine;

	let oldLine = oldStart;
	let newLine = newStart;
	const hunkLines: DiffLine[] = [];

	for (let i = 1; i < lines.length; i += 1) {
		const raw = lines[i];
		if (raw === undefined) {
			continue;
		}
		if (raw.startsWith("\\")) {
			continue;
		}
		if (raw.length === 0 && i === lines.length - 1) {
			continue;
		}

		const prefix = raw[0];
		const content = raw.slice(1);

		if (prefix === " ") {
			hunkLines.push({ type: "context", oldLine, newLine, content });
			oldLine += 1;
			newLine += 1;
		} else if (prefix === "-") {
			hunkLines.push({ type: "del", oldLine, newLine: null, content });
			oldLine += 1;
		} else if (prefix === "+") {
			hunkLines.push({ type: "add", oldLine: null, newLine, content });
			newLine += 1;
		}
	}

	return {
		header,
		oldStart,
		oldCount,
		newStart,
		newCount,
		lines: hunkLines,
	};
}

function formatCount(count: string | undefined): string {
	return count === undefined ? "" : `,${count}`;
}

export function syntheticAddedFileDiff(filePath: string, content: string): string {
	const normalized = content.replace(/\r\n/g, "\n");
	const lines = normalized.length === 0 ? [] : normalized.split("\n");
	const endsWithNewline = normalized.endsWith("\n");
	const bodyLines = endsWithNewline && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
	const count = bodyLines.length;
	const header =
		count === 0
			? "@@ -0,0 +0,0 @@"
			: `@@ -0,0 +1,${count} @@`;
	const body = bodyLines.map((line) => `+${line}`).join("\n");
	const noNewline = count > 0 && !endsWithNewline ? "\n\\ No newline at end of file" : "";

	return [
		`diff --git a/${filePath} b/${filePath}`,
		"new file mode 100644",
		"index 0000000..1111111",
		"--- /dev/null",
		`+++ b/${filePath}`,
		header,
		body + noNewline,
		"",
	].join("\n");
}