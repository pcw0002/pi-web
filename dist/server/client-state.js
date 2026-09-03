/**
 * client-state — per-browser-client persistent UI state
 * (<dataDir>/client-state.json): recent projects / working directory, goal-
 * review prefs, settings-panel state (prompt mode + skill/plugin toggles +
 * vision-bridge prefs), named presets. File I/O is always best-effort: a
 * persistence failure must never crash the server or block a session.
 *
 * Extracted from agent-service.ts with behavior unchanged.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
/** Stable identity of an extension for the enable/disable toggle: the npm
 *  spec for packages (survives version bumps), the resolved entry path
 *  otherwise. */
export function extensionKey(e) {
    const src = e.sourceInfo;
    if (src?.origin === "package" && src.source)
        return src.source;
    return src?.path ?? e.path;
}
/** All identities an extension may be disabled by. The SDK applies
 *  `sourceInfo` only AFTER extensionsOverride runs (resource-loader reload():
 *  override first, applyExtensionSourceInfo second), so inside the override a
 *  package extension still has no sourceInfo and extensionKey() falls back to
 *  the raw entry path — which never matches the "npm:<pkg>" id the settings
 *  panel stores. Derive the package name from the entry path
 *  (.../node_modules/<pkg>/... or .../node_modules/@scope/<pkg>/...) so both
 *  sides agree. */
export function extensionKeyCandidates(e) {
    const keys = new Set([extensionKey(e)]);
    const norm = e.path.replace(/\\/g, "/");
    const marker = "/node_modules/";
    const idx = norm.lastIndexOf(marker);
    if (idx !== -1) {
        const segs = norm.slice(idx + marker.length).split("/");
        // Scoped package @scope/name spans two segments.
        const name = segs[0]?.startsWith("@") && segs[1] ? `${segs[0]}/${segs[1]}` : segs[0];
        if (name)
            keys.add(`npm:${name}`);
    }
    return [...keys];
}
/** Whether an extension is covered by the disabled list (any identity match). */
export function isExtensionDisabled(e, disabled) {
    if (disabled.length === 0)
        return false;
    const keys = extensionKeyCandidates(e);
    return disabled.some((d) => keys.includes(d));
}
/**
 * Persists which workspace each browser client last used + which workspaces it
 * has opened, so a server restart / page reload restores the same project and
 * the UI can offer a one-click recent-project list. File I/O is best-effort:
 * persistence problems must never crash the server or block a session.
 */
export class ClientStateStore {
    filePath;
    cache = null;
    constructor(filePath) {
        this.filePath = filePath;
    }
    load() {
        if (this.cache)
            return this.cache;
        try {
            const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
            this.cache = parsed && typeof parsed === "object" ? parsed : {};
        }
        catch {
            this.cache = {};
        }
        return this.cache;
    }
    save() {
        try {
            mkdirSync(dirname(this.filePath), { recursive: true });
            // Atomic write (tmp + rename): a crash mid-write must never leave a
            // half-written JSON — that would wipe ALL persisted state (recent
            // projects / presets / settings / goal prefs) on next load.
            const tmp = `${this.filePath}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(this.cache, null, 2) + "\n");
            renameSync(tmp, this.filePath);
        }
        catch {
            // best effort
        }
    }
    get(clientId) {
        return this.load()[clientId] ?? { projects: [] };
    }
    /** Remember which workspace a client last used; bumps its project entry. */
    remember(clientId, cwd) {
        const all = this.load();
        const state = (all[clientId] ??= { projects: [] });
        state.lastCwd = cwd;
        const now = Date.now();
        state.projects = [
            { path: cwd, lastUsed: now },
            ...state.projects.filter((p) => p.path !== cwd),
        ].slice(0, 30);
        // Opening the workspace again clears its removal tombstone.
        if (state.removedProjects?.length) {
            state.removedProjects = state.removedProjects.filter((p) => p !== cwd);
        }
        this.save();
    }
    /** Drop one workspace from the recent-project list (user-requested removal).
     *  Records a tombstone too: pushProjects() re-discovers cwds from session
     *  files on every listing, so without it the entry would instantly reappear. */
    removeProject(clientId, cwd) {
        const all = this.load();
        const state = (all[clientId] ??= { projects: [] });
        state.projects = state.projects.filter((p) => p.path !== cwd);
        if (state.lastCwd === cwd)
            delete state.lastCwd;
        const removed = new Set(state.removedProjects ?? []);
        removed.add(cwd);
        state.removedProjects = [...removed];
        this.save();
    }
    /** Tombstoned projects (explicitly removed by the user) for filtering the
     *  merged recent-project list. */
    getRemovedProjects(clientId) {
        return this.load()[clientId]?.removedProjects ?? [];
    }
    /** Last-used goal/review prefs for a client, or undefined if never set. */
    getGoalPrefs(clientId) {
        const s = this.load()[clientId];
        if (!s?.goalPrefs)
            return undefined;
        return {
            reviewModel: s.goalPrefs.reviewModel ?? null,
            maxRounds: s.goalPrefs.maxRounds ?? 0,
            locked: s.goalPrefs.locked ?? true,
        };
    }
    /** Persist the client's goal/review preferences (model choice, rounds, lock). */
    saveGoalPrefs(clientId, prefs) {
        const all = this.load();
        const state = (all[clientId] ??= { projects: [] });
        state.goalPrefs = {
            reviewModel: prefs?.reviewModel ?? null,
            maxRounds: prefs?.maxRounds ?? 0,
            locked: prefs?.locked ?? true,
        };
        this.save();
    }
    /** Remember conversations that were still streaming at shutdown (best-
     *  effort; called during the graceful-shutdown path). */
    saveInterrupted(clientId, list) {
        if (list.length === 0)
            return;
        const all = this.load();
        const state = (all[clientId] ??= { projects: [] });
        state.interrupted = list.slice(0, 8);
        this.save();
    }
    /** Consume the interrupted-conversation record (returns and clears it) —
     *  called once on the client's first attach after a restart. */
    takeInterrupted(clientId) {
        const all = this.load();
        const state = all[clientId];
        const list = state?.interrupted;
        if (list?.length && state) {
            delete state.interrupted;
            this.save();
        }
        return list;
    }
    /** Last-used settings-panel state for a client, or defaults. */
    getSettings(clientId) {
        const s = this.load()[clientId];
        return {
            promptMode: s?.settings?.promptMode === "replace" ? "replace" : "append",
            customSystemPrompt: s?.settings?.customSystemPrompt ?? "",
            disabledSkills: s?.settings?.disabledSkills ?? [],
            disabledExtensions: s?.settings?.disabledExtensions ?? [],
            terminalToolsEnabled: s?.settings?.terminalToolsEnabled ?? true,
            terminalBash: s?.settings?.terminalBash ?? false,
            terminalBashIdleMs: s?.settings?.terminalBashIdleMs ?? 15_000,
            thinkingWrap: s?.settings?.thinkingWrap ?? false,
            visionBridgeEnabled: s?.settings?.visionBridgeEnabled ?? true,
            visionBridgeModel: s?.settings?.visionBridgeModel ?? null,
            visionBridgePromptMode: s?.settings?.visionBridgePromptMode === "replace" ? "replace" : "append",
            visionBridgePrompt: s?.settings?.visionBridgePrompt ?? "",
            reviewPrompt: s?.settings?.reviewPrompt ?? "",
            reviewDisabledSkills: s?.settings?.reviewDisabledSkills ?? [],
            additionalSkillPaths: s?.settings?.additionalSkillPaths ?? [],
            disabledPlugins: s?.settings?.disabledPlugins ?? [],
        };
    }
    /** Persist the client's settings-panel state (partial merge). */
    saveSettings(clientId, settings) {
        const all = this.load();
        const state = (all[clientId] ??= { projects: [] });
        const cur = state.settings ?? {};
        state.settings = {
            promptMode: settings.promptMode ?? cur.promptMode ?? "append",
            customSystemPrompt: settings.customSystemPrompt ?? cur.customSystemPrompt ?? "",
            disabledSkills: settings.disabledSkills ?? cur.disabledSkills ?? [],
            disabledExtensions: settings.disabledExtensions ?? cur.disabledExtensions ?? [],
            terminalToolsEnabled: settings.terminalToolsEnabled ?? cur.terminalToolsEnabled ?? true,
            terminalBash: settings.terminalBash ?? cur.terminalBash ?? false,
            terminalBashIdleMs: settings.terminalBashIdleMs ?? cur.terminalBashIdleMs ?? 15_000,
            thinkingWrap: settings.thinkingWrap ?? cur.thinkingWrap ?? false,
            visionBridgeEnabled: settings.visionBridgeEnabled ?? cur.visionBridgeEnabled ?? true,
            visionBridgeModel: settings.visionBridgeModel ?? cur.visionBridgeModel ?? null,
            visionBridgePromptMode: settings.visionBridgePromptMode ??
                cur.visionBridgePromptMode ??
                "append",
            visionBridgePrompt: settings.visionBridgePrompt ?? cur.visionBridgePrompt ?? "",
            reviewPrompt: settings.reviewPrompt ?? cur.reviewPrompt ?? "",
            reviewDisabledSkills: settings.reviewDisabledSkills ?? cur.reviewDisabledSkills ?? [],
            additionalSkillPaths: settings.additionalSkillPaths ?? cur.additionalSkillPaths ?? [],
            disabledPlugins: settings.disabledPlugins ?? cur.disabledPlugins ?? [],
        };
        this.save();
    }
    /** Named settings presets for a client (empty if never saved). */
    getPresets(clientId) {
        return (this.load()[clientId]?.presets ?? []).map((p) => ({
            ...p,
            // Older client-state files predate review settings.
            reviewPrompt: p.reviewPrompt ?? "",
            reviewDisabledSkills: p.reviewDisabledSkills ?? [],
        }));
    }
    /** Persist the client's named settings presets. */
    savePresets(clientId, presets) {
        const all = this.load();
        const state = (all[clientId] ??= { projects: [] });
        state.presets = presets;
        this.save();
    }
}
