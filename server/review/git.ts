import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DiffFile, DiffMode, DiffResponse, RepoInfo } from "./types.js";
import { parseGitDiff, syntheticAddedFileDiff } from "./parseDiff.js";

const execFileAsync = promisify(execFile);
const UNTRACKED_MAX_BYTES = 1_000_000;

export class GitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GitError";
	}
}

export async function runGit(args: string[], cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			maxBuffer: 20 * 1024 * 1024,
			encoding: "utf8",
		});
		return stdout;
	} catch (error) {
		const err = error as { stderr?: string; message?: string };
		const detail = (err.stderr ?? err.message ?? "git command failed").trim();
		throw new GitError(detail);
	}
}

export async function resolveRepoRoot(inputPath: string): Promise<string> {
	const resolved = path.resolve(inputPath);
	const root = (await runGit(["rev-parse", "--show-toplevel"], resolved)).trim();
	return root;
}

export async function isWorkingTreeDirty(root: string): Promise<boolean> {
	try {
		const status = await runGit(["status", "--porcelain"], root);
		return status.trim().length > 0;
	} catch {
		return false;
	}
}

export async function hasHead(root: string): Promise<boolean> {
	try {
		await runGit(["rev-parse", "--verify", "HEAD"], root);
		return true;
	} catch {
		return false;
	}
}

export async function getRepoInfo(root: string, baseBranch?: string): Promise<RepoInfo> {
	const [branch, status, branchesRaw, headPresent] = await Promise.all([
		runGit(["branch", "--show-current"], root),
		runGit(["status", "--porcelain"], root),
		runGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"], root),
		hasHead(root),
	]);
	const headSha = headPresent
		? (await runGit(["rev-parse", "HEAD"], root)).trim()
		: "0".repeat(40);

	const branches = branchesRaw
		.split("\n")
		.map((name) => name.trim())
		.filter(Boolean);
	const current = branch.trim() || "HEAD";
	const resolvedBase = resolveBaseBranch(current, branches, baseBranch);

	return {
		root,
		branch: current,
		headSha: headSha.trim(),
		dirty: status.length > 0,
		baseBranch: resolvedBase,
		branches,
	};
}

export async function getDiff(root: string, mode: DiffMode, baseBranch?: string): Promise<DiffResponse> {
	const repo = await getRepoInfo(root, baseBranch);
	if (mode === "branch" && repo.headSha === "0".repeat(40)) {
		throw new GitError("This repository has no commits yet. Use working tree mode.");
	}
	const baseRef = mode === "branch" ? repo.baseBranch : "HEAD";
	const baseSha =
		baseRef === "HEAD" && repo.headSha === "0".repeat(40)
			? repo.headSha
			: (await runGit(["rev-parse", baseRef], root)).trim();

	let diffText: string;
	if (mode === "working-tree") {
		diffText = await workingTreeDiff(root);
	} else {
		const mergeBase = (await runGit(["merge-base", "HEAD", repo.baseBranch], root)).trim();
		diffText = await runGit(
			["diff", "--no-ext-diff", "--no-color", "-M", `${mergeBase}...HEAD`],
			root,
		);
	}

	const files: DiffFile[] = parseGitDiff(diffText);

	return {
		repo,
		mode,
		base: { ref: baseRef, sha: baseSha },
		head: { ref: repo.branch, sha: repo.headSha, dirty: repo.dirty },
		files,
		uncommittedWarning: mode === "branch" && repo.dirty,
	};
}

async function workingTreeDiff(root: string): Promise<string> {
	const tracked = (await hasHead(root))
		? await runGit(["diff", "--no-ext-diff", "--no-color", "-M", "HEAD"], root)
		: await runGit(["diff", "--cached", "--no-ext-diff", "--no-color", "-M"], root);
	const untrackedList = await runGit(["ls-files", "--others", "--exclude-standard"], root);
	const untrackedPaths = untrackedList
		.split("\n")
		.map((filePath) => filePath.trim())
		.filter((filePath) => filePath && !isSkippedUntracked(filePath));

	const untrackedDiffs: string[] = [];
	for (const filePath of untrackedPaths) {
		const abs = path.join(root, filePath);
		const info = await stat(abs);
		if (!info.isFile() || info.size > UNTRACKED_MAX_BYTES) {
			continue;
		}
		const content = await readFile(abs, "utf8");
		if (content.includes("\0")) {
			continue;
		}
		untrackedDiffs.push(syntheticAddedFileDiff(filePath, content));
	}

	return [tracked, ...untrackedDiffs].filter((part) => part.trim()).join("\n");
}

function isSkippedUntracked(filePath: string): boolean {
	return filePath.split(/[/\\]/).some((segment) => segment === "node_modules" || segment === ".local-review");
}

function resolveBaseBranch(current: string, branches: string[], requested?: string): string {
	if (requested && requested.trim()) {
		return requested.trim();
	}

	for (const name of ["main", "master", "develop"]) {
		if (branches.includes(name) && name !== current) {
			return name;
		}
	}
	return branches.find((name) => name !== current) ?? current;
}