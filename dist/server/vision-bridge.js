/** Per-batch timeout; a slow vision provider shouldn't stall a prompt forever. */
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.PI_WEB_VISION_TIMEOUT_MS ?? 90_000);
/** Cap the transcript length so it doesn't blow up the main context. */
const MAX_TRANSCRIBE_TOKENS = 4000;
/**
 * Scan every configured provider for models that accept image input.
 * Providers the user already configured in pi (models.json + auth.json) are
 * reused as-is — zero new credentials to set up.
 */
export function findVisionModels(runtime) {
    const out = [];
    for (const p of runtime.getProviders()) {
        // Only providers that actually have credentials — SDK built-ins like
        // amazon-bedrock ship vision-capable models but are not configured
        // unless the user added auth, and calling them would just fail.
        if (!runtime.hasConfiguredAuth(p.id))
            continue;
        for (const m of runtime.getModels(p.id)) {
            if (m.input?.includes("image")) {
                out.push({
                    provider: p.id,
                    id: m.id,
                    label: `${m.name ?? m.id} (${p.id})`,
                });
            }
        }
    }
    return out;
}
/**
 * Evidence-first transcription prompt, modeled on modlens' output contract:
 * full verbatim text, reading-order layout blocks, entities/relations, chart
 * axes & data. Emphasizes honesty over hallucination.
 *
 * Exported so the settings panel can offer a custom prompt (append to this
 * default or replace it entirely).
 */
export const SYSTEM_PROMPT = `You are a vision bridge for a text-only language model. You receive one or more images and must transcribe them into precise, structured text evidence so another model that cannot see images can answer questions about them accurately.

Follow these rules:
1. Transcribe ALL visible text verbatim, preserving wording, spelling, punctuation and line breaks. This is the most important part — the reader relies on your transcription, not on the image.
2. Describe the layout in reading order: headers, paragraphs, lists, tables, buttons, panels — say what appears where.
3. For tables/charts/diagrams: read axes, scales (note log scale), legend entries, series names, highlighted points and their coordinates, and any data values you can discern.
4. Name entities: people, products, companies, colors, style, objects, actions.
5. If part of the image is too blurry/low-resolution to read, say "unclear" for that part — NEVER invent or guess content you cannot see.
6. If there are multiple images, address them in order (Image 1, Image 2, ...).
7. Output only the transcript. No preamble, no commentary about the image itself.`;
/**
 * Assemble the final vision-model system prompt from the settings-panel prefs.
 * mode "append": custom text appended after the default prompt (empty custom =
 * pure default). mode "replace": custom text REPLACES the default prompt, but
 * an empty custom text still falls back to the default (never send an empty
 * system prompt to the vision model).
 */
export function buildVisionBridgePrompt(mode, custom) {
    const text = custom?.trim() ?? "";
    if (mode === "replace" && text)
        return text;
    if (text)
        return `${SYSTEM_PROMPT}\n\n${text}`;
    return SYSTEM_PROMPT;
}
/** Per-batch user instruction appended after the images. */
function buildUserPrompt(count) {
    if (count <= 1) {
        return "Transcribe this image verbatim and output structured text evidence using the rules above.";
    }
    return `Transcribe each image in order (Image 1 to Image ${count}) and output structured text evidence using the rules above.`;
}
/**
 * Send one batch of images to a vision model and return its transcript.
 * Throws on timeout, abort, provider error or an empty response.
 */
export async function transcribeImages(runtime, images, options = {}) {
    const model = options.model ??
        (() => {
            const found = findVisionModels(runtime);
            if (found.length === 0) {
                throw new Error("No vision model available (no model in models.json with image input)");
            }
            return runtime.getModel(found[0].provider, found[0].id);
        })();
    if (!model)
        throw new Error("Vision model unavailable (ModelRuntime.getModel returned empty)");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TRANSCRIBE_TIMEOUT_MS);
    const onOuterAbort = () => ac.abort();
    options.signal?.addEventListener("abort", onOuterAbort);
    try {
        const imageBlocks = images.map((img) => ({
            type: "image",
            data: img.data.replace(/^data:[^;]*;base64,/, ""),
            mimeType: img.mimeType?.startsWith("image/")
                ? img.mimeType
                : "image/png",
        }));
        const context = {
            systemPrompt: options.systemPrompt ?? SYSTEM_PROMPT,
            messages: [
                {
                    role: "user",
                    timestamp: Date.now(),
                    content: [
                        ...imageBlocks,
                        { type: "text", text: buildUserPrompt(images.length) },
                    ],
                },
            ],
        };
        const msg = await runtime.completeSimple(model, context, {
            signal: ac.signal,
            maxTokens: MAX_TRANSCRIBE_TOKENS,
        });
        if (msg.stopReason === "error" || msg.stopReason === "aborted") {
            throw new Error(msg.errorMessage || `Vision model stopped (${msg.stopReason})`);
        }
        const text = msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("\n")
            .trim();
        if (!text) {
            throw new Error("Vision model returned an empty transcription");
        }
        return text;
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onOuterAbort);
    }
}
