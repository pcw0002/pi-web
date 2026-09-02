/**
 * question-attachments — pure collector that restores original attachments
 * for edit-and-re-ask.
 *
 * The web UI persists attachments as standalone custom "file" aside cards
 * immediately after the user message. Forking for edit-and-re-ask drops
 * those asides (they sit after the fork point), so the editor needs this
 * list to restore them. Three kinds:
 *   · Pasted/uploaded images (imageData) — base64 from the aside's image
 *     blocks (including vision-bridge thumbnail cards);
 *   · Uploaded files (uploadPath) — bytes already on disk under uploads;
 *     re-send details.path so the server re-reads them (not in the snapshot,
 *     no duplicate base64);
 *   · Workspace-path attachments (inline/reference/lines/folder) — relative
 *     paths stay valid after fork; re-send path+mode through the same
 *     attachment pipeline.
 *
 * Pure, zero-dependency. Input is a wide type (content: readonly unknown[])
 * narrowed internally so we neither import ./types (unit tests under NodeNext
 * would hit TS2835 from the extension-less shim) nor reject arbitrary
 * UiMessage values.
 */
/** Structural mirror of PromptAttachment (matches server/protocol.ts). */
export interface EditPromptAttachment {
	path: string;
	mode?: "inline" | "reference" | "lines";
	lines?: { start: number; end: number };
	imageData?: string;
	fileData?: string;
	uploadPath?: string;
	mimeType?: string;
	name?: string;
	size?: number;
}

/** Image block (runtime narrowing). */
interface ImageBlock {
	type: "image";
	dataUrl?: string;
}

/** Restore imageData attachments from image blocks (dataUrl → raw base64); returns true if any image block was found. */
function pushImageAttachments(
	atts: EditPromptAttachment[],
	content: readonly unknown[],
	fallbackName?: string,
): boolean {
	let hasImage = false;
	for (const b of content) {
		const img = b as ImageBlock;
		if (img.type !== "image" || typeof img.dataUrl !== "string") continue;
		if (!img.dataUrl.startsWith("data:")) continue;
		const mm = img.dataUrl.match(/^data:([^;]*);base64,(.+)$/);
		if (!mm) continue;
		hasImage = true;
		atts.push({
			path: "",
			imageData: mm[2],
			mimeType: mm[1] || "image/png",
			name:
				fallbackName ??
				`image.${(mm[1] || "image/png").split("/")[1] ?? "png"}`,
		});
	}
	return hasImage;
}

export function collectQuestionAttachments(
	messages: readonly {
		id?: string;
		role: string;
		content: readonly unknown[];
		details?: unknown;
		customType?: string;
	}[],
): Map<string, EditPromptAttachment[]> {
	const m = new Map<string, EditPromptAttachment[]>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "user" || !msg.id) continue;
		// Own image blocks first (sessions where prompt(images) put them into
		// the user content itself).
		const atts: EditPromptAttachment[] = [];
		pushImageAttachments(atts, msg.content);
		// Then the attachment-card run that follows this question (stops at
		// any other message kind — assistant/toolResult/next user/etc.).
		for (
			let j = i + 1;
			j < messages.length &&
			messages[j].role === "custom" &&
			messages[j].customType === "file";
			j++
		) {
			const details = (messages[j].details ?? {}) as {
				mode?: string;
				name?: string;
				size?: number;
				path?: string;
				startLine?: number;
				endLine?: number;
				upload?: boolean;
			};
			// 1) Image card (pasted/uploaded images incl. bridged thumbnails) —
			//    the raw base64 lives in the image blocks.
			if (pushImageAttachments(atts, messages[j].content, details.name))
				continue;
			// 2) Uploaded file (fileData) — re-send the server-generated upload
			//    path; the server re-reads the persisted bytes from disk.
			if (details.upload && details.path) {
				atts.push({
					path: "",
					uploadPath: details.path,
					name: details.name ?? details.path,
					size: details.size,
				});
				continue;
			}
			// 3) Workspace-path attachment (inline / reference / lines / folder)
			//    — the relative path stays valid on the new branch, so a path +
			//    mode spec is enough to re-attach it.
			if (details.path && details.mode) {
				const mode =
					details.mode === "inline" || details.mode === "lines"
						? details.mode
						: "reference";
				const att: EditPromptAttachment = { path: details.path, mode };
				if (
					details.mode === "lines" &&
					typeof details.startLine === "number" &&
					typeof details.endLine === "number"
				) {
					att.lines = { start: details.startLine, end: details.endLine };
				}
				atts.push(att);
			}
		}
		if (atts.length > 0) m.set(msg.id, atts);
	}
	return m;
}
