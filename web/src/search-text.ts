/**
 * In-conversation search — pure-function index and hit counts (no React,
 * unit-testable).
 *
 * Each message is flattened into searchable text (text / thinking /
 * toolCall name+args / bash command+output). Hits expand to a flat list of
 * "message × occurrence" entries for the search bar's count and prev/next
 * navigation. toolResult messages are not indexed: they render as null in
 * the UI (content lives on the matching toolCall card), so there is no
 * jumpable DOM node.
 */

/**
 * Structural type mirror (same pattern as message-delta.ts / skill-block.ts):
 * this file is unit-tested under tsconfig.tests.json (NodeNext resolution)
 * and also bundled by Vite, so it must be zero-dependency — cannot import
 * ./types (that shim references protocol.ts without an extension).
 */
interface SearchTextBlock {
	type: string;
	text?: unknown;
	thinking?: unknown;
	name?: unknown;
	argumentsText?: unknown;
	command?: unknown;
	output?: unknown;
}

export interface SearchMessage {
	id: string;
	role: string;
	content: SearchTextBlock[];
	errorMessage?: string;
}

/** Extract the searchable text of one message. */
export function messageSearchText(m: SearchMessage): string {
	// toolResult renders as empty on its own (content lives on the toolCall card) — no jump target.
	if (m.role === "toolResult") return "";
	const parts: string[] = [];
	for (const b of m.content) {
		collectBlock(b, parts);
	}
	if (m.errorMessage) parts.push(m.errorMessage);
	return parts.join("\n");
}

function collectBlock(b: SearchTextBlock, out: string[]) {
	if (typeof b.text === "string") {
		out.push(b.text);
		return;
	}
	switch (b.type) {
		case "thinking":
			if (typeof b.thinking === "string") out.push(b.thinking);
			break;
		case "toolCall": {
			if (typeof b.name === "string") out.push(b.name);
			if (typeof b.argumentsText === "string") out.push(b.argumentsText);
			break;
		}
		case "bash":
			if (typeof b.command === "string") out.push(b.command);
			if (typeof b.output === "string") out.push(b.output);
			break;
	}
}

/** Case-insensitive occurrence count of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
	const n = needle.trim().toLowerCase();
	if (!n) return 0;
	const h = haystack.toLowerCase();
	let count = 0;
	let i = h.indexOf(n);
	while (i !== -1) {
		count++;
		i = h.indexOf(n, i + n.length);
	}
	return count;
}

export interface SearchHit {
	/** Owning message id — jump target ([data-msg-id]). */
	messageId: string;
	/** Occurrence ordinal within that message (0-based). */
	occurrence: number;
}

/**
 * Flatten all hits across messages into a navigation list:
 * one entry per occurrence, in conversation order.
 */
export function buildSearchHits(
	messages: readonly SearchMessage[],
	query: string,
): SearchHit[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const hits: SearchHit[] = [];
	for (const m of messages) {
		const text = messageSearchText(m);
		if (!text) continue;
		const c = countOccurrences(text, q);
		for (let i = 0; i < c; i++) hits.push({ messageId: m.id, occurrence: i });
	}
	return hits;
}
