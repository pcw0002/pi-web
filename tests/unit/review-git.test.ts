import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDiff, resolveRepoRoot, runGit } from "../../server/review/git.js";

const repos: string[] = [];

async function createRepo(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "local-review-"));
	repos.push(dir);
	await runGit(["init", "-b", "main"], dir);
	await runGit(["config", "user.email", "local-review@test"], dir);
	await runGit(["config", "user.name", "Local Review Test"], dir);
	await writeFile(path.join(dir, "readme.md"), "hello\n", "utf8");
	await runGit(["add", "."], dir);
	await runGit(["commit", "-m", "initial"], dir);
	return dir;
}

afterEach(async () => {
	// Leave temp dirs for OS cleanup; nothing to close.
	repos.length = 0;
});

describe("getDiff", () => {
	it("resolves the repository root", async () => {
		const dir = await createRepo();
		await mkdir(path.join(dir, "src"));
		const root = await resolveRepoRoot(path.join(dir, "src"));
		expect(await realpath(root)).toBe(await realpath(dir));
	});

	it("shows untracked files when the repo has no commits yet", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "local-review-empty-"));
		await runGit(["init", "-b", "main"], dir);
		await writeFile(path.join(dir, "notes.txt"), "hello\n", "utf8");

		const diff = await getDiff(dir, "working-tree");
		expect(diff.files.map((file) => file.path)).toEqual(["notes.txt"]);
		expect(diff.files[0]?.status).toBe("added");
	});

	it("loads a working tree even when a base branch name is passed but has no commits", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "local-review-empty-base-"));
		await runGit(["init", "-b", "main"], dir);
		await writeFile(path.join(dir, "notes.txt"), "hello\n", "utf8");

		const diff = await getDiff(dir, "working-tree", "main");
		expect(diff.files.map((file) => file.path)).toEqual(["notes.txt"]);
	});

	it("includes uncommitted edits and untracked files in working-tree mode", async () => {
		const dir = await createRepo();
		await writeFile(path.join(dir, "readme.md"), "hello world\n", "utf8");
		await writeFile(path.join(dir, "extra.txt"), "new file\n", "utf8");

		const diff = await getDiff(dir, "working-tree");
		expect(diff.mode).toBe("working-tree");
		expect(diff.files.map((file) => file.path).sort()).toEqual(["extra.txt", "readme.md"]);
		expect(diff.files.find((file) => file.path === "extra.txt")?.status).toBe("added");
		expect(diff.head.dirty).toBe(true);
	});

	it("shows committed branch changes against main and warns about a dirty tree", async () => {
		const dir = await createRepo();
		await runGit(["checkout", "-b", "feature"], dir);
		await writeFile(path.join(dir, "feature.ts"), "export const n = 1;\n", "utf8");
		await runGit(["add", "."], dir);
		await runGit(["commit", "-m", "add feature"], dir);
		await writeFile(path.join(dir, "dirty.txt"), "not committed\n", "utf8");

		const diff = await getDiff(dir, "branch", "main");
		expect(diff.files.map((file) => file.path)).toEqual(["feature.ts"]);
		expect(diff.uncommittedWarning).toBe(true);
		expect(diff.base.ref).toBe("main");
		expect(diff.repo.branch).toBe("feature");
	});

	it("skips untracked files under node_modules", async () => {
		const dir = await createRepo();
		await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
		await writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");
		await writeFile(path.join(dir, "app.js"), "ok\n", "utf8");

		const diff = await getDiff(dir, "working-tree");
		expect(diff.files.map((file) => file.path)).toEqual(["app.js"]);
	});
});