/**
 * Settings service — extracted from agent-service.ts (system prompt / skill & plugin
 * toggles / goal-review prompt / presets / vision-bridge prefs). Settings persist
 * in client-state.json, isolated per client.
 *
 * Decoupled from ClientSession via SettingsHost callbacks: this module owns
 * "settings state + panel push + preset CRUD + when a reload is needed".
 * The actual runtime session.reload() goes through the host callback
 * (reloadSession also refreshes the slash-command catalog).
 */
import { basename } from "node:path";
import { extensionKey } from "./client-state.js";
import { findVisionModels, SYSTEM_PROMPT } from "./vision-bridge.js";
export class SettingsService {
    host;
    settings;
    presets;
    knownSkills = new Map();
    knownExtensions = new Map();
    /** Settings that need a reload were changed mid-stream → apply after agent_end (do not tear down a running run). */
    pendingReload = false;
    constructor(host) {
        this.host = host;
        this.settings = host.stateStore.getSettings(host.clientId);
        this.presets = host.stateStore.getPresets(host.clientId);
    }
    get current() {
        return this.settings;
    }
    get reviewPrefs() {
        return {
            reviewPrompt: this.settings.reviewPrompt,
            reviewDisabledSkills: this.settings.reviewDisabledSkills,
        };
    }
    hasPendingReload() {
        return this.pendingReload;
    }
    consumePendingReload() {
        const v = this.pendingReload;
        this.pendingReload = false;
        return v;
    }
    push() {
        const disabledSkills = new Set(this.settings.disabledSkills);
        const reviewDisabledSkills = new Set(this.settings.reviewDisabledSkills);
        const disabledExts = new Set(this.settings.disabledExtensions);
        try {
            // Refresh the cache with the CURRENTLY loaded set (post-filter).
            for (const s of this.host.getSession().resourceLoader.getSkills().skills) {
                this.knownSkills.set(s.name, {
                    name: s.name,
                    description: s.description,
                    enabled: true,
                });
            }
            for (const e of this.host.getSession().resourceLoader.getExtensions().extensions) {
                const id = extensionKey(e);
                const p = e.sourceInfo?.path ?? e.path;
                this.knownExtensions.set(id, {
                    id,
                    name: e.sourceInfo?.origin === "package" && e.sourceInfo.source
                        ? e.sourceInfo.source
                        : basename(p),
                    path: p,
                    enabled: true,
                });
            }
        }
        catch {
            // Session not ready yet — keep whatever we already know.
        }
        // Disabled entries are filtered out of the loader — keep them in the
        // panel (with the last-known description) so they can be re-enabled.
        for (const name of this.settings.disabledSkills) {
            if (!this.knownSkills.has(name)) {
                this.knownSkills.set(name, { name, description: "", enabled: false });
            }
        }
        for (const id of this.settings.disabledExtensions) {
            if (!this.knownExtensions.has(id)) {
                this.knownExtensions.set(id, {
                    id,
                    name: id.startsWith("npm:") ? id : basename(id),
                    path: "",
                    enabled: false,
                });
            }
        }
        const skills = [...this.knownSkills.values()]
            .map((s) => ({ ...s, enabled: !disabledSkills.has(s.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
        const reviewSkills = [...this.knownSkills.values()]
            .map((s) => ({ ...s, enabled: !reviewDisabledSkills.has(s.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
        const extensions = [...this.knownExtensions.values()]
            .map((e) => ({ ...e, enabled: !disabledExts.has(e.id) }))
            .sort((a, b) => a.name.localeCompare(b.name));
        this.host.emit({
            type: "settings_state",
            settings: {
                promptMode: this.settings.promptMode,
                customSystemPrompt: this.settings.customSystemPrompt,
                terminalToolsEnabled: this.settings.terminalToolsEnabled,
                terminalBash: this.settings.terminalBash,
                terminalBashIdleMs: this.settings.terminalBashIdleMs,
                thinkingWrap: this.settings.thinkingWrap,
                visionBridgeEnabled: this.settings.visionBridgeEnabled,
                visionBridgeModel: this.settings.visionBridgeModel,
                visionBridgePromptMode: this.settings.visionBridgePromptMode,
                visionBridgePrompt: this.settings.visionBridgePrompt,
                reviewPrompt: this.settings.reviewPrompt,
                reviewDisabledSkills: [...this.settings.reviewDisabledSkills],
                additionalSkillPaths: [...(this.settings.additionalSkillPaths ?? [])],
                disabledPlugins: [...(this.settings.disabledPlugins ?? [])],
                // The built-in prompts, so the replace-mode editors can prefill the
                // text they would otherwise replace (empty until the resource-loader
                // has run once for the system prompt).
                defaultSystemPrompt: this.host.effectiveDefaultSystemPrompt(),
                effectiveSystemPrompt: this.host.effectiveSystemPrompt(),
                visionBridgeDefaultPrompt: SYSTEM_PROMPT,
                visionModels: this.collectVisionModels(),
                disabledSkills: [...this.settings.disabledSkills],
                disabledExtensions: [...this.settings.disabledExtensions],
                skills,
                reviewSkills,
                extensions,
                presets: this.presets.map((p) => ({ ...p })),
            },
        });
    }
    /** Vision-capable configured models, for the settings-panel picker. */
    collectVisionModels() {
        try {
            return findVisionModels(this.host.getSession().modelRuntime).map((m) => ({
                provider: m.provider,
                id: m.id,
                label: m.label,
            }));
        }
        catch {
            // Session not ready yet — the picker stays empty until next push.
            return [];
        }
    }
    /** Persist + apply a partial settings update (prompt text/mode, toggles). */
    async set(partial) {
        const needsReload = partial.promptMode !== undefined ||
            partial.customSystemPrompt !== undefined ||
            partial.disabledSkills !== undefined ||
            partial.disabledExtensions !== undefined ||
            partial.terminalToolsEnabled !== undefined ||
            partial.additionalSkillPaths !== undefined;
        if (partial.promptMode !== undefined)
            this.settings.promptMode = partial.promptMode;
        if (partial.customSystemPrompt !== undefined) {
            this.settings.customSystemPrompt = partial.customSystemPrompt;
        }
        if (partial.disabledSkills !== undefined) {
            this.settings.disabledSkills = partial.disabledSkills;
        }
        if (partial.disabledExtensions !== undefined) {
            this.settings.disabledExtensions = partial.disabledExtensions;
        }
        // Plugin toggles are UI-only hide (not in needsReload — no runtime reload).
        if (partial.disabledPlugins !== undefined) {
            this.settings.disabledPlugins = partial.disabledPlugins;
        }
        if (partial.terminalToolsEnabled !== undefined) {
            this.settings.terminalToolsEnabled = partial.terminalToolsEnabled;
        }
        if (partial.terminalBash !== undefined) {
            this.settings.terminalBash = partial.terminalBash;
        }
        if (partial.terminalBashIdleMs !== undefined) {
            this.settings.terminalBashIdleMs = Math.max(0, Math.floor(partial.terminalBashIdleMs) || 0);
        }
        if (partial.thinkingWrap !== undefined) {
            this.settings.thinkingWrap = partial.thinkingWrap;
        }
        if (partial.visionBridgeEnabled !== undefined) {
            this.settings.visionBridgeEnabled = partial.visionBridgeEnabled;
        }
        if (partial.visionBridgeModel !== undefined) {
            this.settings.visionBridgeModel = partial.visionBridgeModel ?? null;
        }
        if (partial.visionBridgePromptMode !== undefined) {
            this.settings.visionBridgePromptMode = partial.visionBridgePromptMode;
        }
        if (partial.visionBridgePrompt !== undefined) {
            this.settings.visionBridgePrompt = partial.visionBridgePrompt;
        }
        if (partial.reviewPrompt !== undefined) {
            this.settings.reviewPrompt = partial.reviewPrompt;
        }
        if (partial.reviewDisabledSkills !== undefined) {
            this.settings.reviewDisabledSkills = partial.reviewDisabledSkills;
        }
        if (partial.additionalSkillPaths !== undefined) {
            this.settings.additionalSkillPaths = partial.additionalSkillPaths
                .map((p) => p.trim())
                .filter(Boolean);
        }
        this.host.stateStore.saveSettings(this.host.clientId, this.settings);
        this.push();
        if (needsReload)
            await this.applyRuntime();
    }
    /** Save the CURRENT settings as a named preset (overwrites if exists). */
    async savePreset(name) {
        const n = name.trim();
        if (!n) {
            this.host.emit({ type: "notice", level: "error", text: "Preset name cannot be empty" });
            return;
        }
        const preset = {
            name: n,
            promptMode: this.settings.promptMode,
            customSystemPrompt: this.settings.customSystemPrompt,
            disabledSkills: [...this.settings.disabledSkills],
            disabledExtensions: [...this.settings.disabledExtensions],
            terminalToolsEnabled: this.settings.terminalToolsEnabled,
            terminalBash: this.settings.terminalBash,
            terminalBashIdleMs: this.settings.terminalBashIdleMs,
            reviewPrompt: this.settings.reviewPrompt,
            reviewDisabledSkills: [...this.settings.reviewDisabledSkills],
        };
        const existing = this.presets.findIndex((p) => p.name === n);
        if (existing >= 0)
            this.presets[existing] = preset;
        else
            this.presets.push(preset);
        this.host.stateStore.savePresets(this.host.clientId, this.presets);
        this.push();
    }
    /** Replace the current settings with the named preset and apply it. */
    async applyPreset(name) {
        const p = this.presets.find((x) => x.name === name);
        if (!p) {
            this.host.emit({ type: "notice", level: "error", text: `Preset not found: ${name}` });
            return;
        }
        this.settings = {
            promptMode: p.promptMode,
            customSystemPrompt: p.customSystemPrompt,
            disabledSkills: [...p.disabledSkills],
            disabledExtensions: [...p.disabledExtensions],
            // Older persisted presets may lack this field — keep the current value.
            terminalToolsEnabled: p.terminalToolsEnabled ?? this.settings.terminalToolsEnabled,
            // Terminal-backed-bash prefs travel with the preset; keep current value if an old preset lacks the field.
            terminalBash: p.terminalBash ?? this.settings.terminalBash,
            terminalBashIdleMs: p.terminalBashIdleMs ?? this.settings.terminalBashIdleMs,
            reviewPrompt: p.reviewPrompt ?? this.settings.reviewPrompt,
            reviewDisabledSkills: [
                ...(p.reviewDisabledSkills ?? this.settings.reviewDisabledSkills),
            ],
            additionalSkillPaths: this.settings.additionalSkillPaths ?? [],
            disabledPlugins: this.settings.disabledPlugins,
            // Presets don't capture vision-bridge prefs — keep the current ones.
            visionBridgeEnabled: this.settings.visionBridgeEnabled,
            // Pure UI prefs are not captured by presets — keep the current value.
            thinkingWrap: this.settings.thinkingWrap,
            visionBridgeModel: this.settings.visionBridgeModel,
            visionBridgePromptMode: this.settings.visionBridgePromptMode,
            visionBridgePrompt: this.settings.visionBridgePrompt,
        };
        this.host.stateStore.saveSettings(this.host.clientId, this.settings);
        this.push();
        await this.applyRuntime();
    }
    /** Remove a named preset. */
    async deletePreset(name) {
        this.presets = this.presets.filter((p) => p.name !== name);
        this.host.stateStore.savePresets(this.host.clientId, this.presets);
        this.push();
    }
    /**
     * Make settings changes effective in the running runtime. The resource-loader
     * overrides read this.settings at call time, so a reload re-applies them.
     * Reloading mid-stream would tear down the in-flight run — defer instead.
     */
    async applyRuntime() {
        if (this.host.isDisposed())
            return;
        if (this.host.isStreaming()) {
            this.pendingReload = true;
            this.host.emit({
                type: "notice",
                level: "info",
                text: "A reply is in progress; settings will apply when it finishes",
            });
            return;
        }
        await this.applyReload();
    }
    /** session.reload() + refresh the slash-command catalog + push state. */
    async applyReload() {
        try {
            await this.host.reloadSession();
            this.push();
            this.host.flushSnapshot();
            this.host.emit({ type: "notice", level: "info", text: "Settings applied" });
        }
        catch (err) {
            this.host.emit({
                type: "notice",
                level: "error",
                text: `Failed to apply settings: ${err.message}`,
            });
        }
    }
}
