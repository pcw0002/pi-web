import { useState } from "react";
import { FiChevronDown, FiChevronRight, FiCpu } from "react-icons/fi";
import { useT } from "../i18n";

interface ThinkingBlockProps {
	thinking: string;
	/** True while the assistant is still streaming this thinking block. */
	streaming?: boolean;
	/** Settings-panel "show thinking in full" switch: true (on) → thinking is
	 *  always fully expanded and wraps (the streaming reasoning is visible in
	 *  real time); false (off) → collapsed to a one-line summary, with the
	 *  latest text shown live on that one line while streaming. */
	wrap?: boolean;
}

export function ThinkingBlock({ thinking, streaming, wrap = true }: ThinkingBlockProps) {
	const t = useT();
	// null = never clicked by the user → follow the switch: wrap=true (on) →
	// fully expanded; wrap=false (off) → collapsed. Streaming and settled
	// behavior match — no more "collapsed while streaming, then auto-expands
	// when it finishes" jump.
	const [open, setOpen] = useState<boolean | null>(null);
	const expanded = open ?? wrap;
	// Collapsed preview: while streaming, take the latest text (live tail);
	// once settled, take the first line.
	const preview = streaming
		? thinking.trimEnd().slice(-80)
		: thinking.split("\n")[0].slice(0, 80);

	return (
		<div
			className={`thinking ${expanded ? "open" : ""} ${streaming ? "live" : ""}`}
		>
			<button
				type="button"
				className="thinking-toggle"
				onClick={() => setOpen(!expanded)}
			>
				{expanded ? <FiChevronDown /> : <FiChevronRight />}
				<FiCpu className="thinking-icon" />
				<span className="thinking-label">
					{streaming && expanded ? (
						<span className="thinking-live-label">
							{t("thinkingNow")}
							<span className="dots" />
						</span>
					) : expanded ? (
						t("thinking")
					) : (
						t("thinkingPreview", { preview })
					)}
				</span>
			</button>
			{expanded && <div className="thinking-body">{thinking}</div>}
		</div>
	);
}
