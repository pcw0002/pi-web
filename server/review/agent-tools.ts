import type { PluginAgentTool } from "../plugins.js";
import { pendingReviewsMarkdown, setReviewStatus } from "./review.js";

/** Built-in agent tools for Local Review (not a plugin). */
export function createReviewAgentTools(
	getCwd: () => string,
	onStatusChanged?: () => void,
): PluginAgentTool[] {
	return [
		{
			name: "local_review_pending",
			label: "Pending Local Review comments",
			description:
				"List pending Local Review diff-review comments for the current workspace. Apply every comment. Line and range comments: match by file path and quoted text, not line numbers. File comments apply to the whole file. Then call local_review_mark_applied for each review id.",
			parameters: { type: "object", properties: {} },
			execute: async (_toolCallId, _params) => pendingReviewsMarkdown(getCwd()),
		},
		{
			name: "local_review_mark_applied",
			label: "Mark Local Review applied",
			description:
				"Mark a Local Review as applied after its comments have been implemented. Pass the review id from local_review_pending.",
			parameters: {
				type: "object",
				properties: {
					id: { type: "string", description: "Review id, e.g. 2026-08-28T02-29-03-182Z" },
				},
				required: ["id"],
			},
			execute: async (_toolCallId, params) => {
				const id = typeof params.id === "string" ? params.id.trim() : "";
				if (!id) {
					return "Missing review id.";
				}
				await setReviewStatus(getCwd(), id, "applied");
				onStatusChanged?.();
				return `Marked ${id} as applied.`;
			},
		},
	];
}
