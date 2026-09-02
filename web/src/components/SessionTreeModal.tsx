import { FiGitBranch, FiX } from "react-icons/fi";
import type { SessionTreeItem } from "../types";
import { useT } from "../i18n";

interface Props {
	items: SessionTreeItem[];
	onJump: (entryId: string) => void;
	onClose: () => void;
}

export function SessionTreeModal({ items, onJump, onClose }: Props) {
	const t = useT();
	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div
				className="modal session-tree-modal"
				role="dialog"
				aria-labelledby="session-tree-title"
				onClick={(event) => event.stopPropagation()}
			>
				<button
					type="button"
					className="modal-close"
					aria-label={t("close")}
					onClick={onClose}
				>
					<FiX />
				</button>
				<div className="modal-head">
					<FiGitBranch className="modal-head-icon" />
					<h2 id="session-tree-title">{t("sessionTreeTitle")}</h2>
				</div>
				<div className="modal-body">
					{items.length === 0 ? (
						<p className="review-muted">{t("sessionTreeEmpty")}</p>
					) : (
						<ul className="session-tree-list">
							{items.map((item, index) => (
								<li key={item.entryId}>
									<button
										type="button"
										className={item.current ? "current" : ""}
										onClick={() => onJump(item.entryId)}
									>
										<span className="session-tree-n">{index + 1}</span>
										<span className="session-tree-text">{item.text}</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</div>
	);
}
