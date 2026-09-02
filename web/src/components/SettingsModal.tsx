import { useEffect, useRef, useState } from "react";
import {
	FiCpu,
	FiEye,
	FiPackage,
	FiPlus,
	FiRefreshCw,
	FiSettings,
	FiTerminal,
	FiTrash2,
	FiBox,
	FiX,
	FiZap,
	FiMessageSquare,
} from "react-icons/fi";
import { CopyButton } from "./copy-button";
import { PluginSettingsForm } from "./PluginSettingsForm";
import type {
	ClientMessage,
	CommandDef,
	UiExtensionInfo,
	UiPluginInfo,
	UiSettingsState,
	UiSkillInfo,
} from "../types";
import { randomUuid } from "../uuid";
import { useT } from "../i18n";

/** Minimal terminal-tab bridge (same shape SCMPanel uses). */
interface SettingsTerminalBridge {
	create: (meta: {
		id: string;
		conversationId: string;
		title: string;
		cwd: string;
		cols: number;
		rows: number;
		running: boolean;
		exitCode: number | null;
		command?: CommandDef;
	}) => void;
	restart: (id: string) => void;
}

interface SettingsModalProps {
	chat: {
		settings: UiSettingsState | null;
		plugins: UiPluginInfo[];
		terminals: {
			id: string;
			title: string;
			conversationId: string;
			running: boolean;
			exitCode: number | null;
			command?: CommandDef;
		}[];
		state?: { cwd: string; conversationId: string } | null;
		activeConversationId?: string | null;
	};
	send: (msg: ClientMessage) => boolean;
	terminal: SettingsTerminalBridge;
	/** Switch the top-level view to the terminal (uninstall runs there). */
	onSwitchToTerminal: () => void;
	onClose: () => void;
}

/** A row with an enable/disable switch (skill / extension). */
/**
 * "?" hover tip: long explanations stay off the layout by default and float
 * out on hover / keyboard focus. Near the right edge of the viewport the
 * bubble auto-flips (`.flip` → expand left) so it isn't clipped by the
 * modal / window.
 */
function HintTip({ text }: { text: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	const [flip, setFlip] = useState(false);
	// Bubble is max 320px; expand left if there isn't enough room on the right.
	const updateFlip = () => {
		const rect = ref.current?.getBoundingClientRect();
		if (rect) setFlip(window.innerWidth - rect.right < 340);
	};
	return (
		<span
			ref={ref}
			className={`set-tip${flip ? " flip" : ""}`}
			tabIndex={0}
			aria-label={text}
			onMouseEnter={updateFlip}
			onFocus={updateFlip}
		>
			?
			<span className="set-tip-bubble" role="tooltip">
				{text}
			</span>
		</span>
	);
}

function ToggleRow({
	title,
	subtitle,
	tip,
	enabled,
	onToggle,
	action,
}: {
	title: string;
	subtitle?: string;
	/** Long explanations go through the "?" hover tip instead of being laid out (subtitle XOR tip). */
	tip?: string;
	enabled: boolean;
	onToggle: () => void;
	/** Optional extra control rendered left of the switch (e.g. uninstall). */
	action?: React.ReactNode;
}) {
	const t = useT();
	return (
		<div className="set-row">
			<div className="set-row-info">
				<div className="set-row-name">
					{title}
					{tip && <HintTip text={tip} />}
				</div>
				{subtitle && <div className="set-row-desc">{subtitle}</div>}
			</div>
			{action}
			<button
				type="button"
				className={`set-switch ${enabled ? "on" : ""}`}
				role="switch"
				aria-checked={enabled}
				title={enabled ? t("settingsEnabled") : t("settingsDisabled")}
				onClick={onToggle}
			>
				<span className="set-switch-knob" />
			</button>
		</div>
	);
}

export function SettingsModal({
	chat,
	send,
	terminal,
	onSwitchToTerminal,
	onClose,
}: SettingsModalProps) {
	const t = useT();
	const settings = chat.settings;

	// Prompt draft — local while typing; re-synced from the server on each push
	// UNLESS the textarea is focused (an echo must not clobber mid-edit text).
	const [promptDraft, setPromptDraft] = useState("");
	const [promptMode, setPromptMode] = useState<"append" | "replace">("append");
	const promptFocus = useRef(false);
	// Vision-bridge prompt draft — same local-edit/re-sync pattern as above.
	const [vbPromptDraft, setVbPromptDraft] = useState("");
	const [vbPromptMode, setVbPromptMode] = useState<"append" | "replace">("append");
	const vbPromptFocus = useRef(false);
	// Goal-review prompt is an independent draft: it does not change the main
	// agent system prompt and is only used by the isolated reviewer.
	const [reviewPromptDraft, setReviewPromptDraft] = useState("");
	const reviewPromptFocus = useRef(false);
	const [presetName, setPresetName] = useState("");
	// Read-only viewer for the FULL system prompt actually in effect.
	const [showFullPrompt, setShowFullPrompt] = useState(false);
	// Two-step uninstall confirm: which extension id is awaiting confirmation.
	const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
	// Two-step uninstall confirm for UI plugins (<dataDir>/plugins).
	const [confirmUiUninstall, setConfirmUiUninstall] = useState<string | null>(null);

	useEffect(() => {
		if (!settings) return;
		setPromptMode(settings.promptMode);
		if (promptFocus.current) return;
		// append: show the user's own text; replace: prefill the built-in
		// default prompt so the user sees exactly what they would replace.
		setPromptDraft(
			promptMode === "append" || settings.customSystemPrompt
				? settings.customSystemPrompt
				: settings.defaultSystemPrompt || "",
		);
		setVbPromptMode(settings.visionBridgePromptMode);
		if (vbPromptFocus.current) return;
		setVbPromptDraft(
			vbPromptMode === "append" || settings.visionBridgePrompt
				? settings.visionBridgePrompt
				: settings.visionBridgeDefaultPrompt || "",
		);
		if (!reviewPromptFocus.current) setReviewPromptDraft(settings.reviewPrompt);
	}, [settings, promptMode, vbPromptMode]);

	const [idleMsDraft, setIdleMsDraft] = useState<string>(
		String(settings?.terminalBashIdleMs ?? 15000),
	);
	useEffect(() => {
		setIdleMsDraft(String(settings?.terminalBashIdleMs ?? 15000));
	}, [settings?.terminalBashIdleMs]);

	const [skillPathsDraft, setSkillPathsDraft] = useState(
		(settings?.additionalSkillPaths ?? []).join("\n"),
	);
	const skillPathsFocus = useRef(false);
	useEffect(() => {
		if (skillPathsFocus.current) return;
		setSkillPathsDraft((settings?.additionalSkillPaths ?? []).join("\n"));
	}, [settings?.additionalSkillPaths]);

	if (!settings) return null;

	const disabledSkills = new Set(settings.disabledSkills);
	const disabledExts = new Set(settings.disabledExtensions);

	const setPartial = (patch: {
		promptMode?: "append" | "replace";
		customSystemPrompt?: string;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		disabledPlugins?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		thinkingWrap?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: "append" | "replace";
		visionBridgePrompt?: string;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
		additionalSkillPaths?: string[];
	}) => send({ type: "set_settings", ...patch });

	const toggleSkill = (s: UiSkillInfo) => {
		const next = new Set(disabledSkills);
		if (next.has(s.name)) next.delete(s.name);
		else next.add(s.name);
		setPartial({ disabledSkills: [...next] });
	};

	const disabledPlugins = new Set(settings.disabledPlugins ?? []);
	const togglePlugin = (p: UiPluginInfo) => {
		const next = new Set(disabledPlugins);
		if (next.has(p.id)) next.delete(p.id);
		else next.add(p.id);
		setPartial({ disabledPlugins: [...next] });
	};

	const toggleExtension = (e: UiExtensionInfo) => {
		const next = new Set(disabledExts);
		if (next.has(e.id)) next.delete(e.id);
		else next.add(e.id);
		setPartial({ disabledExtensions: [...next] });
	};

	/** Run a maintenance command (extension uninstall / UI-plugin install or
	 *  uninstall) in a VISIBLE terminal tab (same reuse pattern as SCM write
	 *  ops) so the user sees exactly what happened. On exit the App watcher
	 *  sends extensions_reload / plugins_reload to re-discover the lists. */
	const runTerminalCommand = (title: string, command: string) => {
		const cmd: CommandDef = {
			name: title,
			command,
			cwd: "${pwd}",
		};
		const existing = chat.terminals.find((tm) => tm.title === title);
		if (existing) {
			terminal.restart(existing.id);
			send({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
		} else {
			terminal.create({
				id: randomUuid(),
				conversationId: chat.activeConversationId || chat.state?.conversationId || "",
				title,
				cwd: chat.state?.cwd ?? "",
				cols: 80,
				rows: 24,
				running: true,
				exitCode: null,
				command: cmd,
			});
		}
		onSwitchToTerminal();
		onClose();
	};

	/** Uninstall a `pi install`-ed package: run `pi remove npm:<pkg>` in a
	 *  visible terminal tab (see runTerminalCommand). */
	const runUninstall = (pkgName: string) => {
		setConfirmUninstall(null);
		runTerminalCommand(
			`${t("uninstallTitle")} ${pkgName}`,
			`pi remove npm:${pkgName}`,
		);
	};

	/** Uninstall a UI plugin: delete <dataDir>/plugins/<id>/ via the CLI.
	 *  plugins_reload after the tab exits re-scans the dir. */
	const runUiPluginUninstall = (id: string) => {
		setConfirmUiUninstall(null);
		runTerminalCommand(
			`${t("uninstallTitle")} ${id}`,
			`pi-web-ui uninstall ${id}`,
		);
	};

	/** Update a UI plugin from its recorded install source (.pi-source.json):
	 *  re-run the same install command with --force (config.json survives). */
	const runUiPluginUpdate = (id: string, source: string) => {
		runTerminalCommand(
			`${t("pluginUpdate")} ${id}`,
			`pi-web-ui install ${source} --name ${id} --force`,
		);
	};

	const toggleReviewSkill = (s: UiSkillInfo) => {
		const disabled = new Set(
			settings.reviewSkills.filter((x) => !x.enabled).map((x) => x.name),
		);
		if (disabled.has(s.name)) disabled.delete(s.name);
		else disabled.add(s.name);
		setPartial({ reviewDisabledSkills: [...disabled] });
	};

	const savePrompt = () => {
		// In replace mode, a draft identical to the built-in default means the
		// user didn't actually modify it — store empty so the server falls back
		// to the default (and switching to append later never duplicates it).
		const text =
			promptMode === "replace" &&
			settings.defaultSystemPrompt &&
			promptDraft === settings.defaultSystemPrompt
				? ""
				: promptDraft;
		setPartial({ promptMode, customSystemPrompt: text });
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
				<button
					type="button"
					className="modal-close"
					aria-label={t("close")}
					onClick={onClose}
				>
					<FiX />
				</button>
				<div className="modal-head">
					<FiSettings className="modal-head-icon" />
					<h2>{t("settingsTitle")}</h2>
				</div>
				<p className="modal-desc">{t("settingsDesc")}</p>

				{/* Scrollable body — head/desc above and the actions bar below stay
				    fixed; only these sections scroll. */}
				<div className="modal-body">

				{/* ---- system prompt -------------------------------------------- */}
				<div className="set-section">
					<div className="set-section-title">
						<FiZap className="set-section-icon" />
						{t("settingsSystemPrompt")}
					</div>
					<div className="set-mode-row">
						<label className="set-field-label">{t("settingsPromptMode")}</label>
						<select
							className="set-select"
							value={promptMode}
							onChange={(e) => {
								const mode = e.target.value as "append" | "replace";
								setPromptMode(mode);
								setPartial({ promptMode: mode });
							}}
						>
							<option value="append">{t("promptModeAppend")}</option>
							<option value="replace">{t("promptModeReplace")}</option>
						</select>
						<HintTip
							text={
								promptMode === "append"
									? t("promptAppendHint")
									: t("promptReplaceHint")
							}
						/>
					</div>
					<textarea
						className="set-prompt-input"
						rows={6}
						placeholder={t("promptPlaceholder")}
						value={promptDraft}
						onFocus={() => (promptFocus.current = true)}
						onBlur={() => {
							promptFocus.current = false;
							savePrompt();
						}}
						onChange={(e) => setPromptDraft(e.target.value)}
					/>
					<button
						type="button"
						className="set-view-prompt-btn"
						aria-expanded={showFullPrompt}
						onClick={() => setShowFullPrompt((v) => !v)}
					>
						{t("settingsViewPrompt")} {showFullPrompt ? "▴" : "▾"}
					</button>
					{showFullPrompt && (
						<div className="set-prompt-view">
							<div className="set-prompt-view-head">
								<span>{t("settingsViewPromptHint")}</span>
								<CopyButton text={settings.effectiveSystemPrompt} />
							</div>
							{settings.effectiveSystemPrompt ? (
								<pre className="set-prompt-view-text">
									{settings.effectiveSystemPrompt}
								</pre>
							) : (
								<p className="set-empty">{t("settingsViewPromptEmpty")}</p>
							)}
						</div>
					)}
				</div>

				{/* ---- terminal tools ------------------------------------------ */}
				<div className="set-section">
					<div className="set-section-title">
						<FiTerminal className="set-section-icon" />
						{t("settingsTerminalTools")}
					</div>
					<ToggleRow
						title={t("terminalToolsEnabled")}
						tip={t("settingsTerminalToolsDesc")}
						enabled={settings.terminalToolsEnabled}
						onToggle={() =>
							setPartial({ terminalToolsEnabled: !settings.terminalToolsEnabled })
						}
					/>
					{!settings.terminalToolsEnabled && (
						<p className="set-hint">{t("terminalToolsOffHint")}</p>
					)}
					<ToggleRow
						title={t("terminalBashTakeover")}
						tip={t("terminalBashTakeoverDesc")}
						enabled={settings.terminalBash}
						onToggle={() =>
							setPartial({ terminalBash: !settings.terminalBash })
						}
					/>
					{settings.terminalBash && (
						<div className="set-field">
							<label className="set-field-label" htmlFor="tb-idle-ms">
								{t("terminalBashIdleMs")}
							</label>
							<input
								id="tb-idle-ms"
								className="set-input"
								type="number"
								min={0}
								step={1000}
								value={idleMsDraft}
								onChange={(e) => setIdleMsDraft(e.target.value)}
								onBlur={() => {
									const n = Math.max(0, Math.floor(Number(idleMsDraft) || 0));
									setIdleMsDraft(String(n));
									if (n !== settings.terminalBashIdleMs) {
										setPartial({ terminalBashIdleMs: n });
									}
								}}
							/>
						</div>
					)}
				</div>

				{/* ---- message display ----------------------------------------- */}
				<div className="set-section">
					<div className="set-section-title">
						<FiMessageSquare className="set-section-icon" />
						{t("settingsMessageDisplay")}
					</div>
					<ToggleRow
						title={t("thinkingWrap")}
						tip={t("thinkingWrapDesc")}
						enabled={settings.thinkingWrap ?? true}
						onToggle={() =>
							setPartial({ thinkingWrap: !(settings.thinkingWrap ?? true) })
						}
					/>
				</div>
				{/* ---- skills --------------------------------------------------- */}
				<div className="set-section">
					<div className="set-section-title">
						<FiCpu className="set-section-icon" />
						{t("settingsSkills")}
						<span className="set-count">{settings.skills.length}</span>
					</div>
					{settings.skills.length === 0 ? (
						<p className="set-empty">{t("noSkills")}</p>
					) : (
						<div className="set-list">
							{settings.skills.map((s) => (
								<ToggleRow
									key={s.name}
									title={s.name}
									subtitle={s.description}
									enabled={s.enabled}
									onToggle={() => toggleSkill(s)}
								/>
							))}
						</div>
					)}
					<div className="set-field">
						<label className="set-field-label">
							{t("additionalSkillPaths")}
							<HintTip text={t("additionalSkillPathsHint")} />
						</label>
						<textarea
							className="set-prompt-input"
							rows={3}
							placeholder={t("additionalSkillPathsPlaceholder")}
							value={skillPathsDraft}
							onFocus={() => {
								skillPathsFocus.current = true;
							}}
							onBlur={() => {
								skillPathsFocus.current = false;
								const paths = skillPathsDraft
									.split("\n")
									.map((line) => line.trim())
									.filter(Boolean);
								setSkillPathsDraft(paths.join("\n"));
								setPartial({ additionalSkillPaths: paths });
							}}
							onChange={(e) => setSkillPathsDraft(e.target.value)}
						/>
					</div>
				</div>

				{/* ---- extensions ------------------------------------------------ */}
				<div className="set-section">
					<div className="set-section-title">
						<FiPackage className="set-section-icon" />
						{t("settingsExtensions")}
						<span className="set-count">{settings.extensions.length}</span>
					</div>
					{settings.extensions.length === 0 ? (
						<p className="set-empty">{t("noExtensions")}</p>
					) : (
						<div className="set-list">
							{settings.extensions.map((e) => {
								const pkgName = e.id.startsWith("npm:") ? e.id.slice(4) : null;
								return (
									<ToggleRow
										key={e.id}
										title={e.name}
										subtitle={e.path}
										enabled={e.enabled}
										onToggle={() => toggleExtension(e)}
										action={
											pkgName ? (
												confirmUninstall === e.id ? (
													<button
														type="button"
														className="set-uninstall confirm"
														title={t("uninstallConfirmHint")}
														onClick={() => runUninstall(pkgName)}
													>
														{t("uninstallConfirm")}
													</button>
												) : (
													<button
														type="button"
														className="set-uninstall"
														title={t("uninstallHint")}
														onClick={() => setConfirmUninstall(e.id)}
													>
														<FiTrash2 />
														{t("uninstallExt")}
													</button>
												)
											) : undefined
										}
									/>
								);
							})}
						</div>
					)}
				</div>

				{/* ---- UI plugins (<dataDir>/plugins, hide in UI only) ----------------- */}
				<div className="set-section">
					<div className="set-section-title">
						<FiBox className="set-section-icon" />
						{t("settingsUiPlugins")}
						<span className="set-count">{chat.plugins.length}</span>
					</div>
					{chat.plugins.length === 0 ? (
						<p className="set-empty">{t("noUiPlugins")}</p>
					) : (
						<div className="set-list">
							{chat.plugins.map((p) => (
								<>
									<ToggleRow
										key={p.id}
									title={`${p.icon ? `${p.icon} ` : ""}${p.name}`}
									subtitle={
										(p.error
											? `${p.id} · ${p.error}`
											: p.source
												? `${p.id} · ${p.source}`
												: `${p.id} · ${t("uiPluginNoSource")}`) + (p.permissions?.length ? ` · ${t("uiPluginPerms")}: ${p.permissions.join(", ")}` : "")
									}
									enabled={!disabledPlugins.has(p.id) && !p.error}
									onToggle={() => !p.error && togglePlugin(p)}
									action={
										<div className="set-row-actions">
											{p.source && (
												<button
													type="button"
													className="set-uninstall"
													title={t("pluginUpdateHint")}
													onClick={() => runUiPluginUpdate(p.id, p.source!)}
												>
													<FiRefreshCw />
													{t("pluginUpdate")}
												</button>
											)}
											{confirmUiUninstall === p.id ? (
												<button
													type="button"
													className="set-uninstall confirm"
													title={t("pluginUninstallHint")}
													onClick={() => runUiPluginUninstall(p.id)}
												>
													{t("uninstallConfirm")}
												</button>
											) : (
												<button
													type="button"
													className="set-uninstall"
													title={t("pluginUninstallHint")}
													onClick={() => setConfirmUiUninstall(p.id)}
												>
													<FiTrash2 />
													{t("uninstallExt")}
												</button>
											)}
										</div>
									}
								/>
								{/* Declarative settings: manifest settings schema → auto-rendered form */}
								{p.settingsSchema && p.settingsSchema.length > 0 && (
									<PluginSettingsForm plugin={p} send={send} />
								)}
								</>
							))}
						</div>
					)}
				</div>

				{/* ---- goal review ----------------------------------------------- */}
				<div className="set-section">
					<div className="set-section-title">
						<FiZap className="set-section-icon" />
						{t("settingsReview")}
						<HintTip text={t("settingsReviewDesc")} />
						<span className="set-count">{settings.reviewSkills.length}</span>
					</div>
					<textarea
						className="set-prompt-input"
						rows={5}
						placeholder={t("reviewPromptPlaceholder")}
						value={reviewPromptDraft}
						onFocus={() => (reviewPromptFocus.current = true)}
						onBlur={() => {
							reviewPromptFocus.current = false;
							setPartial({ reviewPrompt: reviewPromptDraft });
						}}
						onChange={(e) => setReviewPromptDraft(e.target.value)}
					/>
					<div className="set-field-label">{t("settingsReviewSkills")}</div>
					{settings.reviewSkills.length === 0 ? (
						<p className="set-empty">{t("noSkills")}</p>
					) : (
						<div className="set-list">
							{settings.reviewSkills.map((s) => (
								<ToggleRow
									key={`review-${s.name}`}
									title={s.name}
									subtitle={s.description}
									enabled={s.enabled}
									onToggle={() => toggleReviewSkill(s)}
								/>
							))}
						</div>
					)}
				</div>

				{/* ---- presets --------------------------------------------------- */}
				{/* ---- vision bridge ---------------------------------------------- */}
				<div className="set-section">
					<div className="set-section-title">
						<FiEye className="set-section-icon" />
						{t("settingsVisionBridge")}
					</div>
					<ToggleRow
						title={t("visionBridgeEnabled")}
						tip={t("settingsVisionBridgeDesc")}
						enabled={settings.visionBridgeEnabled}
						onToggle={() =>
							setPartial({ visionBridgeEnabled: !settings.visionBridgeEnabled })
						}
					/>
					{!settings.visionBridgeEnabled && (
						<p className="set-hint">{t("visionBridgeOffHint")}</p>
					)}
					{settings.visionBridgeEnabled && (
						<div className="set-mode-row">
							<label className="set-field-label">
								{t("visionBridgeModel")}
							</label>
							<select
								className="set-select"
								value={settings.visionBridgeModel ?? ""}
								onChange={(e) =>
									setPartial({ visionBridgeModel: e.target.value || null })
								}
							>
								<option value="">{t("visionBridgeAuto")}</option>
								{settings.visionModels.map((m) => (
									<option
										key={`${m.provider}/${m.id}`}
										value={`${m.provider}/${m.id}`}
									>
										{m.label}
									</option>
								))}
							</select>
						</div>
					)}
					{settings.visionBridgeEnabled && (
						<div className="set-mode-row">
							<label className="set-field-label">
								{t("visionBridgePromptMode")}
							</label>
							<select
								className="set-select"
								value={vbPromptMode}
								onChange={(e) => {
									const mode = e.target.value as "append" | "replace";
									setVbPromptMode(mode);
									setPartial({ visionBridgePromptMode: mode });
								}}
							>
								<option value="append">{t("promptModeAppend")}</option>
								<option value="replace">{t("promptModeReplace")}</option>
							</select>
						</div>
					)}
					{settings.visionBridgeEnabled && (
						<textarea
							className="set-prompt-input"
							rows={4}
							placeholder={t("visionBridgePromptPlaceholder")}
							value={vbPromptDraft}
							onFocus={() => (vbPromptFocus.current = true)}
							onBlur={() => {
								vbPromptFocus.current = false;
								// Same contract as the system prompt: an unmodified copy of
								// the built-in default is stored as empty (use default).
								const text =
									vbPromptMode === "replace" &&
									settings.visionBridgeDefaultPrompt &&
									vbPromptDraft === settings.visionBridgeDefaultPrompt
										? ""
										: vbPromptDraft;
								setPartial({
									visionBridgePromptMode: vbPromptMode,
									visionBridgePrompt: text,
								});
							}}
							onChange={(e) => setVbPromptDraft(e.target.value)}
						/>
					)}
					{settings.visionBridgeEnabled &&
						(settings.visionModels.length === 0 ? (
							<p className="set-hint">{t("visionBridgeNoModels")}</p>
						) : (
							<p className="set-hint">
								{t("visionBridgeCurrent", {
									model:
										settings.visionBridgeModel ??
										t("visionBridgeAuto"),
								})}
							</p>
						))}
				</div>
				<div className="set-section">
					<div className="set-section-title">
						<FiSettings className="set-section-icon" />
						{t("settingsPresets")}
						<span className="set-count">{settings.presets.length}</span>
					</div>
					<div className="set-preset-save">
						<input
							className="set-input"
							placeholder={t("presetNamePlaceholder")}
							value={presetName}
							onChange={(e) => setPresetName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && presetName.trim()) {
									send({ type: "save_preset", name: presetName.trim() });
									setPresetName("");
								}
							}}
						/>
						<button
							type="button"
							className="set-save-btn"
							disabled={!presetName.trim()}
							onClick={() => {
								send({ type: "save_preset", name: presetName.trim() });
								setPresetName("");
							}}
						>
							<FiPlus /> {t("saveAsPreset")}
						</button>
					</div>
					{settings.presets.length === 0 ? (
						<p className="set-empty">{t("noPresets")}</p>
					) : (
						<div className="set-list">
							{settings.presets.map((p) => (
								<div className="set-row" key={p.name}>
									<div className="set-row-info">
										<div className="set-row-name">{p.name}</div>
										<div className="set-row-desc">
											{p.promptMode === "replace"
												? t("promptModeReplace")
												: t("promptModeAppend")}
											{p.disabledSkills.length > 0 &&
												` · ${t("settingsSkills")} ${p.disabledSkills.length}`}
											{p.disabledExtensions.length > 0 &&
												` · ${t("settingsExtensions")} ${p.disabledExtensions.length}`}
										</div>
									</div>
									<div className="set-row-actions">
										<button
											type="button"
											className="dd-refresh"
											onClick={() => send({ type: "apply_preset", name: p.name })}
										>
											{t("applyPreset")}
										</button>
										<button
											type="button"
											className="set-icon-btn danger"
											title={t("deletePreset")}
											onClick={() => send({ type: "delete_preset", name: p.name })}
										>
											<FiTrash2 />
										</button>
									</div>
								</div>
							))}
						</div>
					)}
				</div>
				</div>

				<div className="modal-actions">
					<button type="button" className="dd-refresh" onClick={onClose}>
						{t("close")}
					</button>
				</div>
			</div>
		</div>
	);
}
