/** Slash commands implemented natively by the web server (the pi CLI's built-in
 * interactive commands like /model and /new are NOT handled by the SDK's
 * prompt() — without this they'd be sent to the model as plain text). Keep in
 * sync with exec(). */
export const NATIVE_COMMANDS = [
    { name: "new", description: "New chat" },
    { name: "model", description: "Switch model", argumentHint: "[name]" },
    { name: "compact", description: "Compact context", argumentHint: "[instructions]" },
    { name: "cwd", description: "Switch workspace", argumentHint: "<path>" },
    {
        name: "thinking",
        description: "Set thinking level",
        argumentHint: "<off|minimal|low|medium|high|xhigh|max>",
    },
    { name: "resume", description: "Refresh session list" },
    { name: "name", description: "Name this session", argumentHint: "<name>" },
    { name: "tree", description: "Session tree: jump to an earlier question" },
    { name: "export", description: "Export this session as HTML" },
    { name: "reload", description: "Reload extensions, skills & templates" },
    { name: "help", description: "Show all commands" },
    { name: "copy", description: "Copy last assistant reply" },
    { name: "pi-web-ui:quit", description: "Quit server (supervisor will restart)" },
];
/** Parse a prompt into "/command args" — returns null when it isn't one. */
export function parseSlash(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/"))
        return null;
    const m = trimmed.match(/^\/([^\s]+)\s*([\s\S]*)$/);
    if (!m || !m[1])
        return null;
    return { name: m[1], args: m[2].trim() };
}
export class SlashCommandsService {
    host;
    constructor(host) {
        this.host = host;
    }
    /**
     * Catalog of slash commands for the chat input: web-native builtins first,
     * then the SDK's invokable commands for the ACTIVE conversation (extension
     * commands, prompt templates, skills) — the same set the SDK expands when a
     * prompt text starts with "/" (see AgentSession.prompt).
     */
    async push() {
        const commands = [];
        const seen = new Set();
        for (const c of NATIVE_COMMANDS) {
            commands.push({ ...c, source: "builtin" });
            seen.add(c.name);
        }
        try {
            const s = this.host.getSession();
            // Extension commands — the SDK already suffixes collisions with builtin
            // names ("new:2"), and those still reach the SDK since exec() only
            // intercepts the exact native names.
            for (const cmd of s.extensionRunner.getRegisteredCommands()) {
                if (seen.has(cmd.invocationName))
                    continue;
                commands.push({
                    name: cmd.invocationName,
                    description: cmd.description,
                    source: "extension",
                });
                seen.add(cmd.invocationName);
            }
            // Prompt templates: /templatename args
            for (const t of s.promptTemplates) {
                if (seen.has(t.name))
                    continue;
                commands.push({
                    name: t.name,
                    description: t.description,
                    source: "prompt",
                });
                seen.add(t.name);
            }
            // Skills: /skill:name args
            for (const skill of s.resourceLoader.getSkills().skills) {
                const name = `skill:${skill.name}`;
                if (seen.has(name))
                    continue;
                commands.push({
                    name,
                    description: skill.description,
                    source: "skill",
                });
                seen.add(name);
            }
        }
        catch {
            // Session not ready yet — native-only catalog still serves the picker.
        }
        // UI-plugin-registered commands (host.registerCommand) — global, do not require a ready session.
        for (const cmd of this.host.pluginCommands?.() ?? []) {
            if (seen.has(cmd.name))
                continue; // first-come on name clash with built-in/extension (built-in wins)
            commands.push({
                name: cmd.name,
                description: cmd.description,
                argumentHint: cmd.argumentHint,
                source: "plugin",
            });
            seen.add(cmd.name);
        }
        this.host.emit({ type: "slash_commands", commands });
    }
    /** Run a native slash command (see NATIVE_COMMANDS). Returns false when the
     *  name is not a native command (the prompt falls through to the SDK). */
    async exec(name, args) {
        switch (name) {
            case "new":
                await this.host.newChat();
                return true;
            case "model": {
                if (!args) {
                    const current = this.host.getSession().model;
                    this.host.emit({
                        type: "notice",
                        level: "info",
                        text: current
                            ? `Current model: ${current.name} (${current.provider}/${current.id}). Usage: /model <name>`
                            : `Usage: /model <name>`,
                    });
                    return true;
                }
                const query = args.toLowerCase();
                const available = await this.host.getSession().modelRuntime.getAvailable();
                // Prefer an exact "provider/id" match, else id/name substring.
                const exact = available.find((m) => m.provider + "/" + m.id === args.trim());
                const matches = exact
                    ? [exact]
                    : available.filter((m) => m.id.toLowerCase().includes(query) ||
                        m.name.toLowerCase().includes(query) ||
                        m.provider.toLowerCase().includes(query));
                if (matches.length === 0) {
                    this.host.emit({
                        type: "notice",
                        level: "error",
                        text: `No matching model: ${args} (see the model list in the top bar)`,
                    });
                    return true;
                }
                const pick = matches[0];
                if (matches.length > 1) {
                    this.host.emit({
                        type: "notice",
                        level: "warning",
                        text: `Found ${matches.length} matching models, using ${pick.name} (use provider/id for an exact match)`,
                    });
                }
                await this.host.setModel(`${pick.provider}/${pick.id}`);
                return true;
            }
            case "compact":
                try {
                    await this.host.getSession().compact(args || undefined);
                }
                catch (err) {
                    this.host.emit({
                        type: "notice",
                        level: "error",
                        text: `Failed to compact context: ${err.message}`,
                    });
                }
                return true;
            case "cwd":
                if (!args) {
                    this.host.emit({
                        type: "notice",
                        level: "info",
                        text: `Current workspace: ${this.host.cwd()}. Usage: /cwd <path>`,
                    });
                }
                else {
                    await this.host.setCwd(args);
                }
                return true;
            case "thinking": {
                const level = args.trim().toLowerCase();
                const allowed = new Set([
                    "off",
                    "minimal",
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "max",
                ]);
                if (!allowed.has(level)) {
                    this.host.emit({
                        type: "notice",
                        level: "error",
                        text: `Invalid thinking level: ${args || "(empty)"}. Use: off / minimal / low / medium / high / xhigh / max`,
                    });
                    return true;
                }
                this.host.setThinking(level);
                return true;
            }
            case "resume":
                await this.host.refreshSessions();
                this.host.emit({
                    type: "notice",
                    level: "info",
                    text: "Session list refreshed — pick one from History on the left",
                });
                return true;
            case "name": {
                const n = args.trim();
                if (!n) {
                    const current = this.host.getSession().sessionManager.getSessionName();
                    this.host.emit({
                        type: "notice",
                        level: "info",
                        text: current ? `Current session name: ${current}. Usage: /name <name>` : "Usage: /name <name>",
                    });
                    return true;
                }
                this.host.setSessionName?.(n);
                return true;
            }
            case "tree":
                this.host.emitSessionTree?.();
                return true;
            case "export":
                await this.host.exportSession?.();
                return true;
            case "reload":
                try {
                    // Re-discovers extensions / skills / prompt templates from disk and
                    // re-pushes the picker catalog (the CLI's /reload semantics).
                    await this.host.getSession().reload();
                    // reload() puts custom tools back into the active set — replay settings gates (terminal toggle, etc.).
                    this.host.afterReload?.();
                    await this.push();
                    this.host.emit({
                        type: "notice",
                        level: "info",
                        text: "Reloaded extensions, skills, and prompt templates",
                    });
                }
                catch (err) {
                    this.host.emit({
                        type: "notice",
                        level: "error",
                        text: `Reload failed: ${err.message}`,
                    });
                }
                return true;
            case "pi-web-ui:quit": {
                this.host.emit({
                    type: "notice",
                    level: "info",
                    text: "Exiting pi-web-ui… the supervisor will restart the server",
                });
                setTimeout(() => {
                    const didSchedule = this.host.onQuit?.() ?? false;
                    if (!didSchedule) {
                        setTimeout(() => process.exit(0), 100);
                    }
                }, 300);
                return true;
            }
            case "help":
            case "copy":
                // Client-side UI actions — the client handles them before sending;
                // swallow here so the SDK never sees them as plain prompt text.
                return true;
            default:
                // Plugin command: intercept and run (pure config action, same level as built-ins, never reaches the SDK).
                return (await this.host.execPluginCommand?.(name, args)) ?? false;
        }
    }
}
