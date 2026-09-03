import { useEffect, useMemo, useRef, useState } from "react";
import { FiChevronUp, FiFolder, FiFolderPlus, FiX } from "react-icons/fi";
import type { ClientMessage } from "../types";
import { useT } from "../i18n";

interface ProjectPickerModalProps {
	cwd: string;
	completions: { name: string; path: string; type: "dir" | "file" }[];
	send: (msg: ClientMessage) => boolean;
	onClose: () => void;
}

function trimTrailingSeparators(path: string): string {
	if (path === "/" || /^[A-Za-z]:[\\/]?$/.test(path)) return path;
	return path.replace(/[\\/]+$/, "");
}

function parentPath(path: string): string {
	const normalized = trimTrailingSeparators(path).replace(/\\/g, "/");
	if (normalized === "/" || /^[A-Za-z]:\/?$/.test(normalized)) return normalized;
	const slash = normalized.lastIndexOf("/");
	if (slash <= 0) return slash === 0 ? "/" : normalized;
	if (slash === 2 && /^[A-Za-z]:/.test(normalized)) return normalized.slice(0, 3);
	return normalized.slice(0, slash);
}

function directoryQuery(path: string): string {
	const trimmed = trimTrailingSeparators(path.trim());
	if (trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) return trimmed;
	return `${trimmed}/`;
}

/** Server-backed directory browser. A browser file input cannot reveal an
 * absolute local path, so this picker asks the local pi-web-ui server to list
 * directories and opens the selected path in place (it does not upload files). */
export function ProjectPickerModal({
	cwd,
	completions,
	send,
	onClose,
}: ProjectPickerModalProps) {
	const t = useT();
	const inputRef = useRef<HTMLInputElement>(null);
	const [path, setPath] = useState(cwd);
	const directories = useMemo(
		() => completions.filter((entry) => entry.type === "dir"),
		[completions],
	);

	const browse = (nextPath: string) => {
		const next = trimTrailingSeparators(nextPath.trim());
		if (!next) return;
		setPath(next);
		send({ type: "complete_path", path: directoryQuery(next) });
	};

	useEffect(() => {
		send({ type: "complete_path", path: directoryQuery(cwd) });
		requestAnimationFrame(() => inputRef.current?.focus());
		return () => {
			send({ type: "complete_path", path: "" });
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- initialize once when opened
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
		event.stopPropagation();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	const openProject = () => {
		const selected = path.trim();
		if (!selected) return;
		send({ type: "set_cwd", path: selected });
		onClose();
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal project-picker-modal" onClick={(event) => event.stopPropagation()}>
				<button type="button" className="modal-close" aria-label={t("close")} onClick={onClose}>
					<FiX />
				</button>
				<div className="modal-head">
					<FiFolderPlus className="modal-head-icon" />
					<h2>{t("openProject")}</h2>
				</div>
				<p className="modal-desc">{t("openProjectDesc")}</p>

				<div className="project-picker-path">
					<button
						type="button"
						className="btn icon-only"
						title={t("parentDirectory")}
						onClick={() => browse(parentPath(path))}
					>
						<FiChevronUp />
					</button>
					<input
						ref={inputRef}
						value={path}
						aria-label={t("projectPath")}
						onChange={(event) => setPath(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") browse(path);
						}}
					/>
					<button type="button" className="btn" onClick={() => browse(path)}>
						{t("browse")}
					</button>
				</div>

				<div className="project-picker-list">
					{directories.length === 0 ? (
						<div className="project-picker-empty">{t("noSubdirectories")}</div>
					) : (
						directories.map((directory) => (
							<button
								type="button"
								key={directory.path}
								className="project-picker-item"
								title={directory.path}
								onClick={() => browse(directory.path)}
							>
								<FiFolder />
								<span>{directory.name}</span>
							</button>
						))
					)}
				</div>

				<div className="modal-actions">
					<button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
					<button type="button" className="btn primary" disabled={!path.trim()} onClick={openProject}>
						{t("openProject")}
					</button>
				</div>
			</div>
		</div>
	);
}
