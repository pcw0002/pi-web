import type { CommentSide } from "./types";

export function lineKey(path: string, side: CommentSide, line: number): string {
	return `${path}:${side}:${line}`;
}
