import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupUploads,
	saveUpload,
	uploadRetentionDays,
	uploadsRoot,
} from "../../server/uploads.js";

const dirs: string[] = [];
function tempDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "piweb-uploads-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("uploadRetentionDays", () => {
	it("defaults to 14 days", () => {
		delete process.env.PI_WEB_UPLOAD_RETENTION_DAYS;
		expect(uploadRetentionDays()).toBe(14);
	});
	it("env var overrides; 0 = disable cleanup", () => {
		process.env.PI_WEB_UPLOAD_RETENTION_DAYS = "3";
		expect(uploadRetentionDays()).toBe(3);
		process.env.PI_WEB_UPLOAD_RETENTION_DAYS = "0";
		expect(uploadRetentionDays()).toBe(0);
		process.env.PI_WEB_UPLOAD_RETENTION_DAYS = "abc";
		expect(uploadRetentionDays()).toBe(14);
		delete process.env.PI_WEB_UPLOAD_RETENTION_DAYS;
	});
});

describe("saveUpload", () => {
	it("lands in <dataDir>/uploads/<clientId>/ and sanitizes the filename", () => {
		const dataDir = tempDataDir();
		const { abs, displayName } = saveUpload(
			"client-1",
			'坏/名字:"x".txt',
			Buffer.from("hi"),
			dataDir,
		);
		// Windows join produces backslashes; normalize before comparing
		const norm = (p: string) => p.replace(/\\/g, "/");
		expect(norm(abs).startsWith(norm(uploadsRoot(dataDir)) + "/client-1/")).toBe(true);
		expect(displayName).not.toMatch(/[\\/:*?"<>|]/);
		expect(displayName.endsWith(".txt")).toBe(true);
	});
});

describe("cleanupUploads", () => {
	it("deletes expired files, keeps fresh ones, prunes empty dirs; 0 days disables", async () => {
		const dataDir = tempDataDir();
		const { abs: old } = saveUpload("c-old", "old.txt", Buffer.from("x"), dataDir);
		const { abs: fresh } = saveUpload("c-new", "fresh.txt", Buffer.from("y"), dataDir);
		// Wind old's mtime back 30 days
		const past = new Date(Date.now() - 30 * 24 * 3600 * 1000);
		utimesSync(old, past, past);

		let r = await cleanupUploads(dataDir, 14);
		expect(r.files).toBe(1);
		expect(r.bytes).toBe(1); // "x"
		expect(r.dirs).toBe(1); // c-old emptied and pruned
		expect(() => statSyncStrict(old)).toThrow();
		expect(statSyncStrict(fresh).isFile()).toBe(true);

		r = await cleanupUploads(dataDir, 0); // disabled
		expect(r.files).toBe(0);
	});
});

import { statSync } from "node:fs";
function statSyncStrict(p: string) {
	return statSync(p);
}
