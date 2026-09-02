/**
 * Wire protocol types for the web frontend.
 *
 * ⚠️ Protocol types are no longer maintained by hand here: `export type *`
 * re-exports the single source of truth server/protocol.ts (types only,
 * erased at build time, no shared runtime). Protocol changes only need to
 * touch server/protocol.ts and both ends stay in sync. The old hand-copied
 * mirror is gone — the "new message silently dropped on the frontend" pit
 * no longer exists.
 *
 * Only **frontend-local** types (UI data that is not part of the wire
 * protocol) live below.
 */
export type * from "../../server/protocol";

// Protocol types referenced by local types (`export type *` does not bring
// names into this file's local scope).
import type { FileEntry } from "../../server/protocol";
export type { FileEntry };

// ---------------------------------------------------------------------------
// Frontend-local types (the server does not send/receive these structures
// themselves, or they appear only as a field of a message)
// ---------------------------------------------------------------------------

export interface FileListing {
	path: string;
	parent: string | null;
	entries: FileEntry[];
	/**
	 * The directory had more entries than the platform cap (win32: 2000,
	 * posix: 500) — the list was cut short. UI shows a hint when true.
	 */
	truncated: boolean;
}

/** Content of a workspace file fetched for the preview panel. */
export interface FileContent {
	path: string;
	name: string;
	/**
	 * Preview category: media kinds render via the /api/file HTTP endpoint
	 * (text stays empty); "none" means not previewable.
	 */
	kind: "image" | "video" | "text" | "none";
	text: string;
	truncated: boolean;
	binary: boolean;
	lines: number;
	size: number;
}

/** A tool FINISHED executing (payload of the tool_status ServerMessage). */
export interface ToolStatus {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	/** Exit code when the tool result carries one (bash: parsed from error text). */
	exitCode?: number;
	/** tool_execution_start → tool_execution_end, in ms. */
	durationMs?: number;
}
