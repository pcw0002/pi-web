/**
 * model-admin — model / provider config management, extracted from agent-service.ts.
 *
 * Owns: auth.json provider api-key get/set/clear, models.json CRUD
 * (listModelsConfig / saveModelConfig / deleteModelConfig), "fetch model list"
 * for custom providers (fetch_models: the server probes the OpenAI-compatible
 * /models endpoint, bypassing CORS; anthropic/google auth headers differ;
 * a bare /models 404 falls back to /v1/models) and one-click refresh of a
 * saved provider (refresh_provider_models, credentials never leave the
 * server). After a change, hot-refresh the runtime (refresh / setRuntimeApiKey)
 * and push models / models_config.
 *
 * Decoupled from ClientSession via ModelAdminHost (same pattern as settings/goal/slash).
 * Server notices are English. apiKey/headers are never sent to the browser.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
/** Strip // and /* *\/ comments without touching string literals (URLs contain //). */
function stripJsonComments(src) {
    let out = "";
    let inString = false;
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (inString) {
            out += c;
            if (c === "\\") {
                out += next ?? "";
                i += 2;
                continue;
            }
            if (c === '"')
                inString = false;
            i++;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            i++;
            continue;
        }
        if (c === "/" && next === "/") {
            while (i < src.length && src[i] !== "\n")
                i++;
            continue;
        }
        if (c === "/" && next === "*") {
            i += 2;
            while (i < src.length && !(src[i] === "*" && src[i + 1] === "/"))
                i++;
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}
/** Numeric metadata value (NaN/string "unknown" → undefined). */
function numMeta(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function boolMeta(v) {
    return typeof v === "boolean" ? v : undefined;
}
function strArrMeta(v) {
    return Array.isArray(v)
        ? v.filter((x) => typeof x === "string")
        : undefined;
}
/** Best-effort extraction of model metadata from an OpenAI-compatible
 *  /models `data[]` item. Most endpoints only return `{ id }` — the extra
 *  fields (context_window / max_model_len / modalities / supports_vision /
 *  reasoning / display_name) come from vLLM and other extended
 *  implementations, and are filled into the form when present. */
function parseOpenAiModel(m) {
    const r = (m ?? {});
    const id = typeof r.id === "string" ? r.id : "";
    const name = (typeof r.name === "string" && r.name.trim() ? r.name : undefined) ??
        (typeof r.display_name === "string" && r.display_name.trim()
            ? r.display_name
            : undefined);
    const modalities = strArrMeta(r.modalities) ??
        strArrMeta(r.input_modalities);
    const vision = modalities?.includes("image") === true ||
        boolMeta(r.supports_vision) === true ||
        boolMeta(r.vision) === true ||
        strArrMeta(r.input)?.includes("image") === true;
    const reasoning = boolMeta(r.reasoning) === true ||
        boolMeta(r.supports_reasoning) === true ||
        modalities?.includes("reasoning") === true;
    const contextWindow = numMeta(r.context_window) ??
        numMeta(r.context_length) ??
        numMeta(r.max_model_len) ??
        numMeta(r.max_context_length);
    const maxTokens = numMeta(r.max_tokens) ??
        numMeta(r.max_output_tokens) ??
        numMeta(r.max_completion_tokens);
    return {
        id,
        ...(name ? { name } : {}),
        ...(reasoning ? { reasoning: true } : {}),
        ...(vision ? { input: ["text", "image"] } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
    };
}
/** google-generative-ai /models shape:
 *  { models: [{ name: "models/gemini-flash", displayName, inputTokenLimit,
 *               outputTokenLimit, supportedGenerationMethods }] } */
function parseGoogleModel(m) {
    const r = (m ?? {});
    const rawName = typeof r.name === "string" ? r.name : "";
    const id = rawName.replace(/^models\//, "");
    const displayName = typeof r.displayName === "string" ? r.displayName : undefined;
    return {
        id,
        ...(displayName && displayName !== id ? { name: displayName } : {}),
        ...(numMeta(r.inputTokenLimit)
            ? { contextWindow: numMeta(r.inputTokenLimit) }
            : {}),
        ...(numMeta(r.outputTokenLimit)
            ? { maxTokens: numMeta(r.outputTokenLimit) }
            : {}),
    };
}
export class ModelAdminService {
    host;
    constructor(host) {
        this.host = host;
    }
    /** Persist an api-key credential for a provider (auth.json) and apply it now. */
    async setProviderApiKey(provider, apiKey) {
        const key = apiKey.trim();
        if (!provider.trim()) {
            this.host.emit({ type: "notice", level: "error", text: "Enter a provider ID" });
            return;
        }
        if (!key) {
            this.host.emit({ type: "notice", level: "error", text: "Enter an API key" });
            return;
        }
        try {
            // Persist to auth.json (auth.json shape: { <provider>: { type: "api_key", key } }).
            const authPath = join(this.host.agentDir, "auth.json");
            mkdirSync(this.host.agentDir, { recursive: true });
            let data = {};
            try {
                data = JSON.parse(readFileSync(authPath, "utf8"));
            }
            catch {
                // no file yet / unparsable — start fresh
            }
            data[provider.trim()] = { type: "api_key", key };
            writeFileSync(authPath, JSON.stringify(data, null, 2) + "\n");
            // Apply immediately for this session (runtime credentials are cached), then
            // refresh models. allowNetwork downloads the provider's official model
            // catalog (openai/anthropic/… are dynamic providers with no built-in list).
            const mr = this.host.modelRuntime();
            await mr.setRuntimeApiKey(provider.trim(), key);
            await mr.refresh({ allowNetwork: true });
            this.host.invalidatePiConfig();
            this.host.emit({
                type: "notice",
                level: "info",
                text: `Saved API key for ${provider.trim()} and refreshed the model list`,
            });
            await this.host.pushModels();
            await this.listProviders();
        }
        catch (err) {
            this.host.emit({
                type: "notice",
                level: "error",
                text: `Failed to save API key: ${err.message}`,
            });
        }
        this.host.flushSnapshot();
    }
    /**
     * Clear a built-in provider's stored API key (auth.json entry + runtime
     * override) so it returns to the unconfigured state — its models disappear
     * from the picker until a key is set again. Only meaningful for keys that
     * were stored via set_provider_api_key (source "stored"); env-var sourced
     * credentials can't be cleared from here.
     */
    async clearProviderApiKey(provider) {
        const pid = provider.trim();
        if (!pid) {
            this.host.emit({ type: "notice", level: "error", text: "Enter a provider ID" });
            return;
        }
        try {
            // Remove from auth.json ({ <provider>: { type: "api_key", key } }).
            const authPath = join(this.host.agentDir, "auth.json");
            let data = {};
            try {
                data = JSON.parse(readFileSync(authPath, "utf8"));
            }
            catch {
                // no file yet / unparsable — nothing stored to clear
            }
            if (!(pid in data)) {
                this.host.emit({
                    type: "notice",
                    level: "info",
                    text: `${pid} has no saved API key`,
                });
                return;
            }
            delete data[pid];
            writeFileSync(authPath, JSON.stringify(data, null, 2) + "\n");
            // Drop the runtime override too, then re-read credentials so the
            // provider goes back to unconfigured and its models leave the list.
            const mr = this.host.modelRuntime();
            await mr.removeRuntimeApiKey(pid);
            await mr.refresh();
            this.host.invalidatePiConfig();
            this.host.emit({
                type: "notice",
                level: "info",
                text: `Cleared the saved key for ${pid}; provider is unconfigured`,
            });
            await this.host.pushModels();
            await this.listProviders();
        }
        catch (err) {
            this.host.emit({
                type: "notice",
                level: "error",
                text: `Failed to clear API key: ${err.message}`,
            });
        }
        this.host.flushSnapshot();
    }
    /**
     * Copy a BUILT-IN provider (baseUrl + current model catalog) into an
     * editable custom-provider draft and return it via clone_provider_result.
     * Nothing is persisted — the user renames the draft, pastes a DIFFERENT
     * API key in the form, then saves via save_model_config. Credentials are
     * never copied: the whole point is running a second key alongside the
     * built-in one without touching it.
     */
    async cloneProvider(providerId, reqId) {
        const pid = providerId.trim();
        const fail = (error) => this.host.emit({ type: "clone_provider_result", reqId, ok: false, error });
        try {
            if (!pid) {
                fail("Enter a provider ID");
                return;
            }
            const mr = this.host.modelRuntime();
            const p = mr.getProvider(pid);
            if (!p) {
                fail(`Provider ${pid} does not exist`);
                return;
            }
            if (!p.baseUrl) {
                fail(`${pid} has no baseUrl (OAuth/env provider) and cannot be cloned as custom`);
                return;
            }
            // Map runtime models → models.json rows; dynamic providers ship an
            // empty catalog until refreshed over the network.
            const readModels = () => {
                try {
                    return mr.getModels(pid).map((m) => ({
                        api: m.api,
                        entry: {
                            id: m.id,
                            ...(m.name && m.name !== m.id ? { name: m.name } : {}),
                            ...(m.reasoning ? { reasoning: true } : {}),
                            ...(m.input?.includes("image")
                                ? { input: ["text", "image"] }
                                : {}),
                            ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
                            ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
                        },
                    }));
                }
                catch {
                    return [];
                }
            };
            let models = readModels();
            if (models.length === 0) {
                await mr.refresh({ allowNetwork: true });
                models = readModels();
            }
            if (models.length === 0) {
                fail(`${pid} has an empty model list, cannot clone (try again later)`);
                return;
            }
            // models.json api is provider-level: take the most common api and copy only that api's models.
            const counts = new Map();
            for (const m of models)
                counts.set(m.api, (counts.get(m.api) ?? 0) + 1);
            let api = models[0].api;
            for (const [k, v] of counts)
                if (v > (counts.get(api) ?? 0))
                    api = k;
            const kept = models.filter((m) => m.api === api).map((m) => m.entry);
            // Suggest a free id (<pid>-2, -3, …) — save_model_config would silently
            // overwrite an existing custom entry with the same id.
            const taken = new Set([
                ...Object.keys(this.readModelsConfig().providers),
                ...mr.getRegisteredProviderIds(),
            ]);
            let newId = `${pid}-2`;
            for (let n = 2; taken.has(newId); n++)
                newId = `${pid}-${n}`;
            const config = {
                providerId: newId,
                name: p.name,
                api,
                baseUrl: p.baseUrl,
                models: kept,
            };
            this.host.emit({
                type: "notice",
                level: "info",
                text: `Copied ${pid} → ${newId} (${kept.length} models). Enter a new API key and save.`,
            });
            this.host.emit({ type: "clone_provider_result", reqId, ok: true, config });
        }
        catch (err) {
            fail(`Failed to clone provider: ${err.message}`);
        }
        this.host.flushSnapshot();
    }
    /** Enumerate pi's built-in providers with auth status (key-only config). */
    async listProviders() {
        const mr = this.host.modelRuntime();
        let providers;
        try {
            providers = mr.getProviders().map((p) => {
                try {
                    const st = mr.getProviderAuthStatus(p.id);
                    return {
                        id: p.id,
                        name: p.name,
                        configured: st?.configured ?? false,
                        source: st?.source,
                    };
                }
                catch {
                    // One odd provider must not blank the whole list.
                    return { id: p.id, name: p.name, configured: false };
                }
            });
        }
        catch (err) {
            this.host.emit({
                type: "notice",
                level: "error",
                text: `Failed to list providers: ${err.message}`,
            });
            return;
        }
        if (providers.length === 0) {
            this.host.emit({
                type: "notice",
                level: "warning",
                text: "Provider list is empty — pi runtime has no providers registered",
            });
        }
        this.host.emit({ type: "providers_status", providers });
    }
    // ---------------------------------------------------------------------------
    // Custom model config (agentDir/models.json)
    // ---------------------------------------------------------------------------
    modelsConfigPath() {
        return join(this.host.agentDir, "models.json");
    }
    /** Strip // and /* *\/ comments without touching string literals (URLs contain //). */
    static stripJsonComments(src) {
        let out = "";
        let inString = false;
        let i = 0;
        while (i < src.length) {
            const c = src[i];
            const next = src[i + 1];
            if (inString) {
                out += c;
                if (c === "\\") {
                    out += next ?? "";
                    i += 2;
                    continue;
                }
                if (c === '"')
                    inString = false;
                i++;
                continue;
            }
            if (c === '"') {
                inString = true;
                out += c;
                i++;
                continue;
            }
            if (c === "/" && next === "/") {
                while (i < src.length && src[i] !== "\n")
                    i++;
                continue;
            }
            if (c === "/" && next === "*") {
                i += 2;
                while (i < src.length && !(src[i] === "*" && src[i + 1] === "/"))
                    i++;
                i += 2;
                continue;
            }
            out += c;
            i++;
        }
        return out;
    }
    /** Read + parse models.json (tolerating // and /* *\/ comments like the SDK). */
    readModelsConfig() {
        const path = this.modelsConfigPath();
        try {
            const raw = readFileSync(path, "utf8");
            const parsed = JSON.parse(stripJsonComments(raw));
            return { providers: parsed?.providers ?? {} };
        }
        catch {
            return { providers: {} };
        }
    }
    /** Send the current models.json custom providers to the client. */
    async listModelsConfig() {
        const { providers } = this.readModelsConfig();
        const list = Object.entries(providers).map(([providerId, p]) => {
            const models = Array.isArray(p.models)
                ? p.models.map((m) => ({
                    id: String(m.id ?? ""),
                    name: m.name,
                    reasoning: m.reasoning,
                    input: Array.isArray(m.input) ? m.input : undefined,
                    contextWindow: m.contextWindow,
                    maxTokens: m.maxTokens,
                }))
                : [];
            return {
                providerId,
                name: p.name,
                api: p.api,
                baseUrl: p.baseUrl,
                apiKey: p.apiKey,
                authHeader: p.authHeader,
                // headers are intentionally NOT sent to the browser — they may
                // contain Authorization / API-key values; kept server-side only.
                models,
            };
        });
        this.host.emit({ type: "models_config", providers: list });
    }
    /** Numeric metadata value (NaN/string "unknown" → undefined). */
    static numMeta(v) {
        return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    }
    static boolMeta(v) {
        return typeof v === "boolean" ? v : undefined;
    }
    static strArrMeta(v) {
        return Array.isArray(v)
            ? v.filter((x) => typeof x === "string")
            : undefined;
    }
    /** Best-effort extraction of model metadata from an OpenAI-compatible
     *  /models `data[]` item. Most endpoints only return `{ id }` — the extra
     *  fields (context_window / max_model_len / modalities / supports_vision /
     *  reasoning / display_name) come from vLLM and other extended
     *  implementations, and are filled into the form when present. */
    static parseOpenAiModel(m) {
        const r = (m ?? {});
        const id = typeof r.id === "string" ? r.id : "";
        const name = (typeof r.name === "string" && r.name.trim() ? r.name : undefined) ??
            (typeof r.display_name === "string" && r.display_name.trim()
                ? r.display_name
                : undefined);
        const modalities = strArrMeta(r.modalities) ??
            strArrMeta(r.input_modalities);
        const vision = modalities?.includes("image") === true ||
            boolMeta(r.supports_vision) === true ||
            boolMeta(r.vision) === true ||
            strArrMeta(r.input)?.includes("image") === true;
        const reasoning = boolMeta(r.reasoning) === true ||
            boolMeta(r.supports_reasoning) === true ||
            modalities?.includes("reasoning") === true;
        const contextWindow = numMeta(r.context_window) ??
            numMeta(r.context_length) ??
            numMeta(r.max_model_len) ??
            numMeta(r.max_context_length);
        const maxTokens = numMeta(r.max_tokens) ??
            numMeta(r.max_output_tokens) ??
            numMeta(r.max_completion_tokens);
        return {
            id,
            ...(name ? { name } : {}),
            ...(reasoning ? { reasoning: true } : {}),
            ...(vision ? { input: ["text", "image"] } : {}),
            ...(contextWindow ? { contextWindow } : {}),
            ...(maxTokens ? { maxTokens } : {}),
        };
    }
    /** google-generative-ai /models shape:
     *  { models: [{ name: "models/gemini-flash", displayName, inputTokenLimit,
     *               outputTokenLimit, supportedGenerationMethods }] } */
    static parseGoogleModel(m) {
        const r = (m ?? {});
        const rawName = typeof r.name === "string" ? r.name : "";
        const id = rawName.replace(/^models\//, "");
        const displayName = typeof r.displayName === "string" ? r.displayName : undefined;
        return {
            id,
            ...(displayName && displayName !== id ? { name: displayName } : {}),
            ...(numMeta(r.inputTokenLimit)
                ? { contextWindow: numMeta(r.inputTokenLimit) }
                : {}),
            ...(numMeta(r.outputTokenLimit)
                ? { maxTokens: numMeta(r.outputTokenLimit) }
                : {}),
        };
    }
    /** Probe a custom provider's OpenAI-compatible /models endpoint (server-side
     *  because the baseUrl is often a LAN/loopback host the browser can't reach
     *  cross-origin) and return the advertised models. reqId is echoed back
     *  in fetch_models_result so the UI can match concurrent requests. */
    async fetchModelsList(reqId, baseUrl, apiKey, authHeader, api) {
        const emitError = (error) => this.host.emit({ type: "fetch_models_result", reqId, ok: false, error });
        try {
            const models = await ModelAdminService.probeModelsEndpoint(baseUrl, apiKey, authHeader, api);
            this.host.emit({ type: "fetch_models_result", reqId, ok: true, models });
        }
        catch (err) {
            emitError(err.message);
        }
    }
    /**
     * Probe a custom provider's model-list endpoint (OpenAI-compatible /models
     * with a /v1 retry; Google {models:[…]} shape supported). Throws Error with
     * a user-facing message on any failure; returns deduped+sorted entries.
     * Shared by the edit-form "auto fetch" and the saved-provider refresh.
     */
    static async probeModelsEndpoint(baseUrl, apiKey, authHeader, api, extraHeaders) {
        const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
        if (!base)
            throw new Error("Enter a baseUrl first");
        let url;
        try {
            url = new URL(base);
        }
        catch {
            throw new Error(`Invalid baseUrl: ${base}`);
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("baseUrl must be http or https");
        }
        const headers = {
            ...(extraHeaders ?? {}),
        };
        // Per-api auth conventions (mirror pi's built-in provider configs):
        //   openai-*:      Authorization: Bearer <key>
        //   anthropic:     x-api-key + anthropic-version
        //   google:        x-goog-api-key
        // authHeader=false → no auth header at all (custom gateways).
        if (apiKey?.trim() && authHeader !== false) {
            const key = apiKey.trim();
            if (api === "anthropic-messages") {
                headers["x-api-key"] = key;
                headers["anthropic-version"] = "2023-06-01";
            }
            else if (api === "google-generative-ai") {
                headers["x-goog-api-key"] = key;
            }
            else {
                headers["Authorization"] = `Bearer ${key}`;
            }
        }
        const tryFetch = async (u) => {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 15000);
            try {
                return await fetch(u, { headers, signal: ac.signal });
            }
            catch (err) {
                if (err.name === "AbortError") {
                    throw new Error("Request timed out (15s)");
                }
                throw new Error(`Request failed: ${err.message}`);
            }
            finally {
                clearTimeout(timer);
            }
        };
        let res = await tryFetch(`${base}/models`);
        // BaseUrls that omit the /v1 prefix (e.g. https://api.openai.com) 404 on
        // the bare path — retry under /v1.
        if (res && res.status === 404 && !/\/v\d+[a-z-]*$/.test(base)) {
            res = await tryFetch(`${base}/v1/models`);
        }
        if (!res)
            throw new Error("Request failed");
        if (!res.ok) {
            let detail = "";
            try {
                detail = (await res.text()).slice(0, 200);
            }
            catch {
                // response body already consumed / not text — ignore
            }
            throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
        }
        let models = [];
        try {
            const json = (await res.json());
            const data = Array.isArray(json.data) ? json.data : null;
            if (data) {
                // OpenAI-compatible: { data: [{ id, context_window, modalities, … }] }
                models = data
                    .map((m) => parseOpenAiModel(m))
                    .filter((m) => m.id);
            }
            else if (Array.isArray(json.models)) {
                // Google: { models: [{ name: "models/…", displayName, … }] }
                models = json.models
                    .map((m) => parseGoogleModel(m))
                    .filter((m) => m.id);
            }
        }
        catch {
            throw new Error("Response is not valid JSON");
        }
        // Dedupe by id (keep the first, most complete entry) and sort by id.
        const seen = new Set();
        models = models
            .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
            .sort((a, b) => a.id.localeCompare(b.id));
        if (models.length === 0)
            throw new Error("No models returned");
        return models;
    }
    /**
     * Re-probe a SAVED custom provider's model list and merge it into its
     * models.json entry — credentials never leave the server (unlike the
     * edit-form fetch, which sends whatever the browser typed). Merge rules:
     * existing ids keep all manually-entered fields and only gain metadata
     * they were missing; brand-new ids are appended. Hot-reloads the runtime.
     */
    async refreshProviderModels(providerId, reqId) {
        const done = (ok, extra = {}) => this.host.emit({ type: "refresh_provider_result", reqId, ok, ...extra });
        try {
            const pid = providerId.trim();
            const { providers } = this.readModelsConfig();
            // models.json's raw shape is Record<string, unknown> — assert the saved-entry structure
            const saved = providers[pid];
            if (!saved?.baseUrl?.trim()) {
                this.host.emit({
                    type: "notice",
                    level: "warning",
                    text: `Provider ${pid} is missing or has no baseUrl, cannot refresh`,
                });
                return done(false, { error: "provider missing or no baseUrl" });
            }
            const fetched = await ModelAdminService.probeModelsEndpoint(saved.baseUrl, saved.apiKey, saved.authHeader === true ? true : undefined, saved.api, saved.headers);
            // Merge: manual values win; fetched fills blanks and appends new ids.
            const prev = new Map((saved.models ?? []).map((m) => [m.id, m]));
            let added = 0;
            for (const f of fetched) {
                const cur = prev.get(f.id);
                if (!cur) {
                    prev.set(f.id, f);
                    added += 1;
                    continue;
                }
                prev.set(f.id, {
                    ...f,
                    ...cur, // hand-filled fields win: cur overwrites same-named fields from f
                });
            }
            const merged = [...prev.values()].sort((a, b) => a.id.localeCompare(b.id));
            await this.saveModelConfig(pid, {
                providerId: pid,
                name: saved.name,
                api: saved.api,
                baseUrl: saved.baseUrl,
                // apiKey/headers are not sent back to the browser — saveModelConfig keeps the old values
                authHeader: saved.authHeader === true ? true : undefined,
                models: merged,
            });
            this.host.emit({
                type: "notice",
                level: "info",
                text: added > 0
                    ? `Refreshed ${pid}: added ${added} model(s), ${merged.length} total`
                    : `Refreshed ${pid}: no new models (${merged.length} total)`,
            });
            return done(true, { added, total: merged.length });
        }
        catch (err) {
            this.host.emit({
                type: "notice",
                level: "error",
                text: `Failed to refresh models: ${err.message}`,
            });
            return done(false, { error: err.message });
        }
    }
    /** Upsert one provider into models.json and hot-reload the model runtime. */
    async saveModelConfig(providerId, config) {
        const pid = providerId.trim();
        if (!pid || !/^[\w.-]+$/.test(pid)) {
            this.host.emit({
                type: "notice",
                level: "error",
                text: "Invalid provider ID (letters, digits, ._- only)",
            });
            return;
        }
        const models = (config.models ?? [])
            .filter((m) => m.id && m.id.trim())
            .map((m) => ({
            id: m.id.trim(),
            ...(m.name?.trim() ? { name: m.name.trim() } : {}),
            ...(m.reasoning ? { reasoning: true } : {}),
            ...(m.input?.length ? { input: m.input } : {}),
            ...(m.contextWindow ? { contextWindow: Number(m.contextWindow) } : {}),
            ...(m.maxTokens ? { maxTokens: Number(m.maxTokens) } : {}),
        }));
        if (models.length === 0) {
            this.host.emit({ type: "notice", level: "error", text: "At least one model is required" });
            return;
        }
        try {
            const { providers } = this.readModelsConfig();
            // headers never reach the browser, so the incoming config can't carry
            // them — preserve the previously stored values when they are absent.
            const prevHeaders = providers[pid]?.headers;
            providers[pid] = {
                ...(config.name?.trim() ? { name: config.name.trim() } : {}),
                ...(config.api?.trim() ? { api: config.api.trim() } : {}),
                ...(config.baseUrl?.trim() ? { baseUrl: config.baseUrl.trim() } : {}),
                ...(config.apiKey?.trim() ? { apiKey: config.apiKey.trim() } : {}),
                ...(config.authHeader ? { authHeader: true } : {}),
                ...(prevHeaders && Object.keys(prevHeaders).length > 0
                    ? { headers: prevHeaders }
                    : {}),
                models,
            };
            mkdirSync(this.host.agentDir, { recursive: true });
            writeFileSync(this.modelsConfigPath(), JSON.stringify({ providers }, null, 2) + "\n");
            // Allow a custom models.json entry to reuse the provider credential
            // already stored in auth.json.  Seed the shared runtime too, because
            // older pi-ai versions did not always fall back to stored credentials
            // for a newly-created custom provider.  Never copy the secret into
            // models.json.
            try {
                const auth = JSON.parse(readFileSync(join(this.host.agentDir, "auth.json"), "utf8"));
                const credential = auth[pid];
                if (credential &&
                    typeof credential === "object" &&
                    "key" in credential &&
                    typeof credential.key === "string" &&
                    credential.key.trim()) {
                    await this.host.modelRuntime().setRuntimeApiKey(pid, credential.key);
                }
            }
            catch {
                // auth.json is optional; models.json can still use its own apiKey.
            }
            await this.host.modelRuntime().refresh();
            await this.listModelsConfig();
            await this.host.pushModels();
            this.host.emit({
                type: "notice",
                level: "info",
                text: `Saved provider ${pid} (${models.length} models) and refreshed the list`,
            });
        }
        catch (err) {
            this.host.emit({
                type: "notice",
                level: "error",
                text: `Failed to save model config: ${err.message}`,
            });
        }
        this.host.flushSnapshot();
    }
    /** Remove a provider from models.json and hot-reload. */
    async deleteModelConfig(providerId) {
        try {
            const { providers } = this.readModelsConfig();
            if (!(providerId in providers)) {
                this.host.emit({
                    type: "notice",
                    level: "info",
                    text: `Provider ${providerId} does not exist`,
                });
                return;
            }
            delete providers[providerId];
            writeFileSync(this.modelsConfigPath(), JSON.stringify({ providers }, null, 2) + "\n");
            await this.host.modelRuntime().refresh();
            await this.listModelsConfig();
            await this.host.pushModels();
            this.host.emit({
                type: "notice",
                level: "info",
                text: `Deleted provider ${providerId}`,
            });
        }
        catch (err) {
            this.host.emit({
                type: "notice",
                level: "error",
                text: `Failed to delete model config: ${err.message}`,
            });
        }
        this.host.flushSnapshot();
    }
}
