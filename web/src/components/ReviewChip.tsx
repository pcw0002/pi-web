import { memo } from "react";
import { FiCheck, FiEdit3, FiX } from "react-icons/fi";
import { useT } from "../i18n";

interface Props {
	pendingCount: number;
	commentCount: number;
	nudge: boolean;
	onApply: () => void;
	onOpen: () => void;
	onResolve: () => void;
	onDismiss: () => void;
	onDismissNudge: () => void;
}

export const ReviewChip = memo(function ReviewChip({
	pendingCount,
	commentCount,
	nudge,
	onApply,
	onOpen,
	onResolve,
	onDismiss,
	onDismissNudge,
}: Props) {
	const t = useT();
	if (pendingCount === 0 && !nudge) return null;
	return (
		<div className="review-chip" role="status">
			<FiEdit3 className="review-chip-icon" />
			{pendingCount > 0 ? (
				<>
					<span>
						{t("reviewChipPending", { n: pendingCount, c: commentCount })}
					</span>
					<button type="button" className="review-chip-apply" onClick={onApply}>
						<FiCheck /> {t("reviewApplyInChat")}
					</button>
					<button
						type="button"
						className="review-link"
						title={t("reviewMarkAppliedTip")}
						onClick={() => {
							if (
								pendingCount > 1 &&
								!window.confirm(t("reviewConfirmMarkAllApplied", { n: pendingCount }))
							) {
								return;
							}
							onResolve();
						}}
					>
						{t("reviewMarkApplied")}
					</button>
					<button
						type="button"
						className="review-link"
						title={t("reviewDismissPendingTip")}
						onClick={() => {
							if (
								pendingCount > 1 &&
								!window.confirm(t("reviewConfirmDismissAll", { n: pendingCount }))
							) {
								return;
							}
							onDismiss();
						}}
					>
						{t("reviewDismissPending")}
					</button>
					<button type="button" className="review-link" onClick={onOpen}>
						{t("reviewOpenTab")}
					</button>
				</>
			) : (
				<>
					<span>{t("reviewNudge")}</span>
					<button type="button" className="review-chip-apply" onClick={onOpen}>
						{t("reviewTab")}
					</button>
					<button type="button" className="review-link" onClick={onDismissNudge} aria-label={t("reviewCancel")}>
						<FiX />
					</button>
				</>
			)}
		</div>
	);
});
