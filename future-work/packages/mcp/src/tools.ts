/**
 * MCP tool descriptors. Same names and semantics as
 * `server/review/agent-tools.ts` so Cursor/Claude and pi-web stay aligned.
 *
 * A future MCP server would call `ReviewStore.pendingMarkdown` /
 * `ReviewStore.setStatus`. Submit can be added later for headless comment JSON.
 */

import {
	REVIEW_TOOL_MARK_APPLIED,
	REVIEW_TOOL_PENDING,
} from "../../core/src/host.js";

export interface McpToolSketch {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, { type: string; description?: string }>;
		required?: string[];
	};
}

export const LOCAL_REVIEW_MCP_TOOLS: McpToolSketch[] = [
	{
		name: REVIEW_TOOL_PENDING,
		description:
			"List pending Local Review diff-review comments for the current workspace. Apply every comment. Line and range comments: match by file path and quoted text, not line numbers. File comments apply to the whole file. Then call local_review_mark_applied for each review id.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: REVIEW_TOOL_MARK_APPLIED,
		description:
			"Mark a Local Review as applied after its comments have been implemented. Pass the review id from local_review_pending.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Review id, e.g. 2026-08-28T02-29-03-182Z" },
			},
			required: ["id"],
		},
	},
];
