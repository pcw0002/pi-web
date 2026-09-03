const WIDGET_WIDTH = 80;
/** ANSI escape sequences (CSI + OSC): extension widget/status text often
 *  mixes in TUI color codes (e.g. pi-powerline-footer). The browser would
 *  render them as a literal `[38;5;244m` mojibake (issue #16). */
const ANSI_RE = /\[[0-9:;<=>?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** Strip all ANSI escape sequences (CSI/OSC) from a string. */
export function stripAnsi(s) {
    return s.replace(ANSI_RE, "");
}
/** Mock theme: TUI color functions degrade to identity so widget text survives. */
const mockTheme = new Proxy({
    fg: (_color, text) => text,
    bold: (text) => text,
    strikethrough: (text) => text,
    dim: (text) => text,
}, {
    get(target, prop) {
        if (prop in target)
            return target[prop];
        // Unknown theme methods → no-op passthrough.
        return (_arg, text) => text !== undefined ? text : "";
    },
});
/** Mock TUI: any method call is a safe no-op. */
const mockTui = new Proxy({
    requestRender: () => { },
    render: () => { },
}, {
    get(target, prop) {
        if (prop in target)
            return target[prop];
        return () => { };
    },
});
/**
 * Implements the subset of ExtensionUIContext that makes sense for a web UI.
 * TUI-only affordances (select/confirm/input dialogs, terminal input, custom
 * footer) are inert: dialogs resolve to cancellation instead of blocking.
 */
export class WebUIContext {
    theme = mockTheme;
    widgets = new Map();
    lastLines = new Map();
    emit;
    constructor(emit) {
        this.emit = emit;
    }
    // -- widgets -------------------------------------------------------------
    /** Matches ExtensionUIContext's overloaded setWidget exactly. */
    setWidget = (key, content, options) => {
        void options;
        if (content === undefined) {
            this.widgets.delete(key);
            this.lastLines.delete(key);
            this.push();
            return;
        }
        if (typeof content === "function") {
            let comp;
            try {
                // Mock TUI/theme: extensions only read a handful of theme helpers;
                // everything else is a no-op, so the widget renders to plain text.
                comp = content(mockTui, mockTheme);
            }
            catch {
                comp = undefined;
            }
            this.widgets.set(key, {
                render: (w) => comp?.render?.(w),
                dispose: comp?.dispose,
            });
        }
        else {
            this.widgets.set(key, { render: () => content });
        }
        this.push();
    };
    /** Re-render all widgets and push when content changed (polled + on demand). */
    refresh() {
        let changed = false;
        for (const [key, w] of this.widgets) {
            let lines;
            try {
                lines = w.render(WIDGET_WIDTH);
            }
            catch {
                lines = undefined;
            }
            const prev = this.lastLines.get(key);
            if (JSON.stringify(lines ?? null) !== JSON.stringify(prev ?? null)) {
                this.lastLines.set(key, lines ?? []);
                changed = true;
            }
        }
        if (changed)
            this.push();
    }
    push() {
        const widgets = this.snapshot();
        this.emit({ type: "widgets", widgets });
    }
    /** Render all widgets to their current text lines (without emitting). */
    snapshot() {
        return [...this.widgets.entries()].map(([key, w]) => {
            let lines;
            try {
                lines = w.render(WIDGET_WIDTH);
            }
            catch {
                lines = undefined;
            }
            // The browser is not a terminal: strip ANSI color codes before emit/compare (issue #16).
            const clean = lines?.map(stripAnsi) ?? undefined;
            this.lastLines.set(key, clean ?? []);
            return { key, lines: clean ?? [] };
        });
    }
    // -- notifications --------------------------------------------------------
    notify(message, type) {
        this.emit({ type: "notice", level: type ?? "info", text: message });
    }
    // -- footer status (pi-lens "LSP Inactive", pi-cache-optimizer cache stats) --
    statuses = new Map();
    setStatus(key, text) {
        if (text === undefined || text === "") {
            this.statuses.delete(key);
        }
        else {
            // Strip ANSI at the entry so both pushStatuses and statusSnapshot see clean text.
            const clean = stripAnsi(text);
            if (clean === "")
                this.statuses.delete(key);
            else
                this.statuses.set(key, clean);
        }
        this.pushStatuses();
    }
    pushStatuses() {
        this.emit({
            type: "statuses",
            statuses: [...this.statuses.entries()].map(([k, v]) => ({
                key: k,
                text: v,
            })),
        });
    }
    /** Current footer status entries (for replay on socket attach). */
    statusSnapshot() {
        return [...this.statuses.entries()].map(([k, v]) => ({ key: k, text: v }));
    }
    // -- dialogs (select/confirm/input bridged to the browser) ---------------
    dialogSeq = 0;
    pendingDialogs = new Map();
    select = (title, options) => this.openDialog("select", title, [options]);
    confirm = (title, message) => this.openDialog("confirm", title, [message]);
    input = (title, placeholder) => this.openDialog("input", title, [placeholder ?? ""]);
    openDialog(kind, title, args) {
        return new Promise((resolve) => {
            const id = ++this.dialogSeq;
            this.pendingDialogs.set(id, resolve);
            this.emit({ type: "dialog", id, kind, title, args });
        });
    }
    /** Resolve a pending dialog with the user's choice (called from the client). */
    resolveDialog(id, value) {
        const resolve = this.pendingDialogs.get(id);
        if (resolve) {
            this.pendingDialogs.delete(id);
            resolve(value);
            this.emit({ type: "dialog_closed", id });
        }
    }
    /** Close every pending dialog as cancelled (used when a goal wizard aborts —
     *  its unanswered browser dialogs must vanish, not linger). */
    cancelPendingDialogs() {
        for (const [id, resolve] of this.pendingDialogs) {
            this.pendingDialogs.delete(id);
            resolve(null);
            this.emit({ type: "dialog_closed", id });
        }
    }
    // -- inert TUI-only affordances ------------------------------------------
    onTerminalInput = () => () => { };
    setWorkingMessage = () => { };
    setWorkingVisible = () => { };
    setWorkingIndicator = () => { };
    setHiddenThinkingLabel = () => { };
    setFooter = () => { };
    setHeader = () => { };
    setTitle = () => { };
    custom = (_factory, _done) => new Promise(() => { });
    pasteToEditor = () => { };
    setEditorText = () => { };
    getEditorText = () => "";
    editor = async () => undefined;
    addAutocompleteProvider = () => { };
    setEditorComponent = () => { };
    getEditorComponent = () => undefined;
    getAllThemes = () => [];
    getTheme = () => undefined;
    setTheme = () => ({ success: false });
    getToolsExpanded = () => false;
    setToolsExpanded = () => { };
    /** Dispose all widgets (extension reload / session teardown). */
    dispose() {
        for (const w of this.widgets.values()) {
            try {
                w.dispose?.();
            }
            catch {
                // best effort
            }
        }
        this.widgets.clear();
        this.lastLines.clear();
        // Cancel any pending dialogs.
        for (const [id, resolve] of this.pendingDialogs) {
            resolve(null);
            this.emit({ type: "dialog_closed", id });
        }
        this.pendingDialogs.clear();
    }
}
