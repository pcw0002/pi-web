import { describe, expect, it } from "vitest";
import { GitError } from "../../server/review/git.js";
import { parseMode } from "../../server/review/handlers.js";

describe("parseMode", () => {
	it("defaults to working-tree", () => {
		expect(parseMode(undefined)).toBe("working-tree");
		expect(parseMode("working-tree")).toBe("working-tree");
		expect(parseMode("branch")).toBe("branch");
	});

	it("rejects unknown modes", () => {
		expect(() => parseMode("staged")).toThrow(GitError);
	});
});