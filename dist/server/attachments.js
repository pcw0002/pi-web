import { countLines, decodeText, looksLikeText, sniffImageMime, } from "./text-sniff.js";
import { saveUpload, uploadsRoot } from "./uploads.js";
import { buildVisionBridgePrompt, findVisionModels, transcribeImages, } from "./vision-bridge.js";
/** Cross-snapshot vision-transcription cache: batch hash (name + base64 head + prompt) → transcribed text.
 *  Re-asking with the same image does not spend vision tokens again. Process-level sharing is enough. */
const visionBridgeCache = new Map();
/** Parse "provider/id"; returns null on an illegal format. */
export function parseModelSpec(spec) {
    if (!spec)
        return null;
    const slash = spec.indexOf("/");
    if (slash <= 0 || slash === spec.length - 1)
        return null;
    return { provider: spec.slice(0, slash), id: spec.slice(slash + 1), spec };
}
export async function buildAttachmentMessages(ctx, attachments) {
    if (!attachments || attachments.length === 0)
        return [];
    const fs = await import("node:fs/promises");
    const { resolve, sep, relative, extname, join, basename } = await import("node:path");
    const root = resolve(ctx.cwd);
    const MAX_ATTACHMENT_BYTES = 200 * 1024;
    // Files at or below this size are inlined; larger files are referenced by
    // path only (the model reads them on demand — saves tokens for small edits).
    const MAX_INLINE_BYTES = Number(process.env.PI_WEB_INLINE_FILE_MAX ?? 12 * 1024);
    const IMAGE_EXT = new Set([
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".bmp",
        ".svg",
    ]);
    const MIME = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".svg": "image/svg+xml",
    };
    const out = [];
    /** Push the aside for a raw uploaded file (fresh fileData or a restored
     *  uploadPath re-read from disk). Small text files are inlined so the
     *  model sees them immediately; everything else becomes a path reference.
     *  `upload: true` marks the card as a restorable upload — the browser
     *  re-sends it by path when editing & re-asking a question. */
    const pushUploadAside = (name, wirePath, buf) => {
        if (buf.length <= MAX_INLINE_BYTES && looksLikeText(buf)) {
            const lines = countLines(buf);
            out.push({
                message: {
                    customType: "file",
                    content: [
                        {
                            type: "text",
                            text: `\n<file path="${wirePath}">\n\`\`\`\n${decodeText(buf)}\n\`\`\`\n</file>`,
                        },
                    ],
                    display: true,
                    details: {
                        name,
                        path: wirePath,
                        mode: "inline",
                        size: buf.length,
                        lines,
                        upload: true,
                    },
                },
            });
        }
        else {
            out.push({
                message: {
                    customType: "file",
                    content: [
                        {
                            type: "text",
                            text: `<file path="${wirePath}" size="${buf.length}" />`,
                        },
                    ],
                    display: true,
                    details: {
                        name,
                        path: wirePath,
                        mode: "reference",
                        size: buf.length,
                        upload: true,
                    },
                },
            });
        }
    };
    // -- Vision bridge ------------------------------------------------------
    // When the active model can't accept images (DeepSeek, GLM, …), pasted
    // images are transcribed by a configured vision model first and the
    // transcript is fed to the text-only model as text evidence (see
    // vision-bridge.ts — any model in models.json whose input includes
    // "image" works, zero extra config). Vision-capable main models keep
    // the raw image-content path untouched.
    const mainModel = ctx.session.model;
    const mainSupportsVision = mainModel?.input?.includes("image") ?? false;
    const bridgedImages = [];
    /** Raw image bytes for path-referenced image files (idx → info), pre-read
     *  so the loop below doesn't re-read them. SVG stays a plain text file —
     *  the model reads its source, far more useful than a rasterized blob. */
    const pathImageData = new Map();
    /** Cap for path images (fully read + base64'd); larger ones fall back to
     *  a plain path reference (the model can still attempt to read them). */
    const MAX_PATH_IMAGE_BYTES = 5 * 1024 * 1024;
    for (const [idx, att] of attachments.entries()) {
        if (att.imageData) {
            const raw = att.imageData.replace(/^data:[^;]*;base64,/, "");
            const mimeType = att.mimeType?.startsWith("image/")
                ? att.mimeType
                : "image/png";
            const bytes = Buffer.byteLength(raw, "base64");
            // Only images that would actually be sent (non-empty, under the cap).
            if (bytes > 0 && bytes <= 2 * 1024 * 1024) {
                if (!mainSupportsVision) {
                    bridgedImages.push({ idx, att, raw, mimeType, bytes });
                }
            }
            continue;
        }
        if (att.fileData || !att.path)
            continue;
        const ext = extname(att.path).toLowerCase();
        if (!IMAGE_EXT.has(ext) || ext === ".svg")
            continue;
        const abs = resolve(root, att.path);
        const rawRel = relative(root, abs);
        if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`))
            continue;
        let st;
        try {
            st = await fs.stat(abs);
        }
        catch {
            continue;
        }
        if (!st.isFile() || st.size === 0 || st.size > MAX_PATH_IMAGE_BYTES) {
            continue;
        }
        const buf = await fs.readFile(abs);
        const mime = sniffImageMime(buf, ext);
        if (!mime)
            continue;
        const raw = buf.toString("base64");
        pathImageData.set(idx, { raw, mimeType: mime, bytes: st.size });
        if (!mainSupportsVision) {
            bridgedImages.push({ idx, att, raw, mimeType: mime, bytes: st.size });
        }
    }
    /** Transcript per attachment index (filled below, keyed by bridgedImages idx). */
    const bridgeTranscripts = new Map();
    if (bridgedImages.length > 0) {
        if (!ctx.settings.visionBridgeEnabled) {
            ctx.emit({
                type: "notice",
                level: "warning",
                text: `Current model (${mainModel?.name ?? mainModel?.id ?? "unknown"}) has no vision, and the vision bridge is disabled in settings. Images will be sent as-is and may be ignored.`,
            });
        }
        else {
            const visionModels = findVisionModels(ctx.session.modelRuntime);
            // Preferred model from settings ("provider/id") — validated to exist
            // and actually accept images; falls back to the first auto-detected.
            let chosen = visionModels[0] ?? null;
            const pref = ctx.settings.visionBridgeModel;
            if (pref) {
                const spec = parseModelSpec(pref);
                if (spec) {
                    const pm = ctx.session.modelRuntime.getModel(spec.provider, spec.id);
                    if (pm?.input?.includes("image")) {
                        chosen = {
                            provider: spec.provider,
                            id: spec.id,
                            label: `${pm.name ?? pm.id} (${spec.provider})`,
                        };
                    }
                }
            }
            if (!chosen) {
                ctx.emit({
                    type: "notice",
                    level: "warning",
                    text: `Current model (${mainModel?.name ?? mainModel?.id ?? "unknown"}) has no vision, and no vision model is configured. Images will be sent as-is and may be ignored. Add any image-capable model (qwen-vl, GLM-4V, Gemini, …) in Model config to enable the vision bridge.`,
                });
            }
            else {
                // Batch hash so re-sending identical images (edit & re-ask) reuses
                // the transcript instead of re-burning tokens on the vision API.
                // The active transcription prompt is part of the key: changing
                // the custom prompt must invalidate cached transcripts made with
                // the old prompt.
                const batchHash = bridgedImages
                    .map((b) => `${b.att.name ?? "img"}:${b.raw.slice(0, 48)}`)
                    .join("|") +
                    "::" +
                    buildVisionBridgePrompt(ctx.settings.visionBridgePromptMode, ctx.settings.visionBridgePrompt);
                let transcript = visionBridgeCache.get(batchHash);
                if (transcript === undefined) {
                    ctx.emit({
                        type: "notice",
                        level: "info",
                        text: `Current model has no vision; transcribing ${bridgedImages.length} image(s) with the vision bridge (${chosen.label})…`,
                    });
                    try {
                        const chosenModel = ctx.session.modelRuntime.getModel(chosen.provider, chosen.id);
                        transcript = await transcribeImages(ctx.session.modelRuntime, bridgedImages.map((b) => ({
                            data: b.raw,
                            mimeType: b.mimeType,
                            name: b.att.name,
                        })), {
                            model: chosenModel ?? undefined,
                            systemPrompt: buildVisionBridgePrompt(ctx.settings.visionBridgePromptMode, ctx.settings.visionBridgePrompt),
                        });
                        visionBridgeCache.set(batchHash, transcript);
                        ctx.emit({
                            type: "notice",
                            level: "info",
                            text: `Vision bridge finished transcribing (${chosen.label})`,
                        });
                    }
                    catch (err) {
                        transcript = "";
                        ctx.emit({
                            type: "notice",
                            level: "error",
                            text: `Vision bridge failed (${chosen.label}): ${err.message}. Images will be sent as-is and may be ignored.`,
                        });
                    }
                }
                for (const b of bridgedImages)
                    bridgeTranscripts.set(b.idx, transcript ?? "");
            }
        }
    }
    /** Cap for reading a file in "lines" mode (selected slice is inlined). */
    const MAX_LINES_READ_BYTES = 2 * 1024 * 1024;
    for (const [idx, att] of attachments.entries()) {
        // Raw pasted/dropped/uploaded image — no workspace path involved (the
        // browser downscales client-side; this guard only prevents abuse).
        if (att.imageData) {
            const raw = att.imageData.replace(/^data:[^;]*;base64,/, "");
            const mimeType = att.mimeType?.startsWith("image/") ? att.mimeType : "image/png";
            const bytes = Buffer.byteLength(raw, "base64");
            const MAX_PASTED_IMAGE_BYTES = 2 * 1024 * 1024;
            if (bytes === 0) {
                ctx.emit({
                    type: "notice",
                    level: "error",
                    text: `Empty image data, skipped`,
                });
                continue;
            }
            if (bytes > MAX_PASTED_IMAGE_BYTES) {
                ctx.emit({
                    type: "notice",
                    level: "warning",
                    text: `Image skipped (over 2MB): ${att.name ?? "pasted image"}`,
                });
                continue;
            }
            const transcript = bridgeTranscripts.get(idx);
            if (transcript) {
                // Bridged: the text-only main model can't see images, so it gets the
                // vision model's transcript as text evidence; the image block is
                // kept so the card still shows the original thumbnail.
                out.push({
                    message: {
                        customType: "file",
                        content: [
                            {
                                type: "text",
                                text: `\n<vision-bridge>\n${transcript}\n</vision-bridge>`,
                            },
                            { type: "image", data: raw, mimeType },
                        ],
                        display: true,
                        details: {
                            name: att.name ?? "image.png",
                            path: undefined,
                            mode: "bridged",
                            size: bytes,
                        },
                    },
                });
                continue;
            }
            out.push({
                message: {
                    customType: "file",
                    content: [{ type: "image", data: raw, mimeType }],
                    display: true,
                    details: {
                        name: att.name ?? "image.png",
                        // No workspace path — the card renders without the path line.
                        path: undefined,
                        mode: "image",
                        size: bytes,
                    },
                },
            });
            continue;
        }
        // Raw uploaded file (base64) — no workspace path involved. The bytes are
        // persisted under <dataDir>/uploads/<clientId>/ so the model can read
        // them on demand with its read tool (absolute path, no traversal guard
        // needed — the path is server-generated). Small text uploads are inlined
        // so the model sees them immediately; everything else becomes a path
        // reference.
        if (att.fileData) {
            const buf = Buffer.from(att.fileData, "base64");
            const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
            if (buf.length === 0) {
                ctx.emit({
                    type: "notice",
                    level: "error",
                    text: `Empty file data, skipped`,
                });
                continue;
            }
            if (buf.length > MAX_UPLOAD_BYTES) {
                ctx.emit({
                    type: "notice",
                    level: "warning",
                    text: `File skipped (over 20MB): ${att.name ?? "uploaded file"}`,
                });
                continue;
            }
            // Uploaded files live in a GLOBAL per-user dir (not inside the project
            // or the per-client session store) so browsing a repo never picks up
            // uploaded junk: <dataDir>/uploads/<clientId>/ (auto-cleaned after retention; see uploads.ts).
            const { abs, displayName: safeName } = saveUpload(ctx.clientId, att.name ?? "file", buf);
            // Wire format: forward-slash absolute path (the read tool accepts
            // absolute paths; Windows uses "C:/..." — safe inside the XML-ish tag).
            const wirePath = abs.split(sep).join("/");
            pushUploadAside(safeName, wirePath, buf);
            continue;
        }
        // Restored upload from edit-and-re-ask: the browser re-sends the
        // server-generated absolute path of a previously uploaded (fileData)
        // file instead of the original base64 (the fork drops the original
        // aside card, so the bytes must be re-read from the uploads dir).
        // Validate the path stays inside THIS client's uploads/ folder, then
        // re-read the persisted bytes and attach by the same path — no
        // re-save (the file already exists; retention sweeping governs its
        // lifetime, same as the original card).
        if (att.uploadPath) {
            const rootDir = uploadsRoot();
            const abs = resolve(rootDir, att.uploadPath);
            const relToRoot = relative(rootDir, abs);
            const inClientDir = !relToRoot.startsWith("..") &&
                !relToRoot.includes(`${sep}..`) &&
                (relToRoot === ctx.clientId ||
                    relToRoot.startsWith(`${ctx.clientId}${sep}`));
            if (!inClientDir) {
                ctx.emit({
                    type: "notice",
                    level: "warning",
                    text: `Cannot restore upload (path is not in this client's upload directory): ${att.name ?? att.uploadPath}`,
                });
                continue;
            }
            let buf;
            try {
                buf = await fs.readFile(abs);
            }
            catch {
                ctx.emit({
                    type: "notice",
                    level: "warning",
                    text: `Cannot restore upload (cleaned up or unreadable): ${att.name ?? att.uploadPath}`,
                });
                continue;
            }
            if (buf.length === 0)
                continue;
            pushUploadAside(att.name ?? basename(abs), abs.split(sep).join("/"), buf);
            continue;
        }
        const abs = resolve(root, att.path);
        const rawRel = relative(root, abs);
        if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`)) {
            ctx.emit({
                type: "notice",
                level: "warning",
                text: `Attachment path is outside the workspace: ${att.path}`,
            });
            continue;
        }
        // Normalize to forward slashes (relative() returns "\\" on Windows);
        // <file path> and details.path must use the wire format.
        const rel = rawRel.split(sep).join("/");
        let stat;
        try {
            stat = await fs.stat(abs);
        }
        catch {
            ctx.emit({
                type: "notice",
                level: "error",
                text: `Attachment not found: ${att.path}`,
            });
            continue;
        }
        const name = att.path.split(/[\\/]/).pop() ?? att.path;
        // Folders can't be inlined — always a path reference the model browses
        // on demand with its own tools (ls/read).
        if (stat.isDirectory()) {
            out.push({
                message: {
                    customType: "file",
                    content: [{ type: "text", text: `<folder path="${rel}" />` }],
                    display: true,
                    details: {
                        name,
                        path: rel,
                        mode: "reference",
                        type: "folder",
                    },
                },
            });
            continue;
        }
        if (!stat.isFile()) {
            ctx.emit({
                type: "notice",
                level: "warning",
                text: `Skipping non-file attachment: ${att.path}`,
            });
            continue;
        }
        const ext = extname(att.path).toLowerCase();
        if (IMAGE_EXT.has(ext) && ext !== ".svg") {
            const pathImg = pathImageData.get(idx);
            const transcript = bridgeTranscripts.get(idx);
            if (transcript) {
                // Text-only main model: the vision bridge transcribed this image —
                // the model gets the transcript as text evidence (+ thumbnail).
                out.push({
                    message: {
                        customType: "file",
                        content: [
                            {
                                type: "text",
                                text: `
<vision-bridge>
${transcript}
</vision-bridge>`,
                            },
                            ...(pathImg
                                ? ([{
                                        type: "image",
                                        data: pathImg.raw,
                                        mimeType: pathImg.mimeType,
                                    }])
                                : []),
                        ],
                        display: true,
                        details: {
                            name,
                            path: rel,
                            mode: "bridged",
                            size: stat.size,
                        },
                    },
                });
                continue;
            }
            if (pathImg) {
                // Vision-capable main model (or bridge failed): send the raw image
                // content straight from the pre-read bytes.
                out.push({
                    message: {
                        customType: "file",
                        content: [
                            {
                                type: "image",
                                data: pathImg.raw,
                                mimeType: pathImg.mimeType,
                            },
                        ],
                        display: true,
                        details: { name, path: rel, mode: "image", size: stat.size },
                    },
                });
                continue;
            }
            // Pre-read failed (unsupported sniff / too large): fall back to the
            // legacy inline-cap behavior.
            if (stat.size > MAX_ATTACHMENT_BYTES) {
                ctx.emit({
                    type: "notice",
                    level: "warning",
                    text: `Image attachment skipped (over 200KB): ${att.path}`,
                });
                continue;
            }
            const data = await fs.readFile(abs, "base64");
            out.push({
                message: {
                    customType: "file",
                    content: [
                        { type: "image", data, mimeType: MIME[ext] ?? "image/png" },
                    ],
                    display: true,
                    details: { name, path: rel, mode: "image", size: stat.size },
                },
            });
            continue;
        }
        const makeReference = () => ({
            message: {
                customType: "file",
                content: [
                    {
                        type: "text",
                        text: `<file path="${rel}" size="${stat.size}" />`,
                    },
                ],
                display: true,
                details: { name, path: rel, mode: "reference", size: stat.size },
            },
        });
        const makeInline = (buf) => {
            const lines = countLines(buf);
            return {
                message: {
                    customType: "file",
                    content: [
                        {
                            type: "text",
                            text: `\n<file path="${rel}">\n\`\`\`\n${decodeText(buf)}\n\`\`\`\n</file>`,
                        },
                    ],
                    display: true,
                    details: {
                        name,
                        path: rel,
                        mode: "inline",
                        size: stat.size,
                        lines,
                    },
                },
            };
        };
        // Reference mode is always honored and never reads the file.
        if (att.mode === "reference") {
            out.push(makeReference());
            continue;
        }
        // Line-range mode: inline only the selected 1-based inclusive range.
        // Reading is capped so a huge file can't exhaust memory even though
        // the selected slice is small.
        if (att.mode === "lines") {
            const range = att.lines;
            if (!range || range.start < 1 || range.end < range.start) {
                ctx.emit({
                    type: "notice",
                    level: "warning",
                    text: `Invalid line range, falling back to path reference: ${att.path}`,
                });
                out.push(makeReference());
                continue;
            }
            if (stat.size > MAX_LINES_READ_BYTES) {
                ctx.emit({
                    type: "notice",
                    level: "warning",
                    text: `File too large, falling back to path reference: ${att.path}`,
                });
                out.push(makeReference());
                continue;
            }
            const buf = await fs.readFile(abs);
            if (buf.includes(0)) {
                ctx.emit({
                    type: "notice",
                    level: "warning",
                    text: `Binary file, falling back to path reference: ${att.path}`,
                });
                out.push(makeReference());
                continue;
            }
            const parts = decodeText(buf).split("\n");
            // A trailing newline yields an empty phantom line — drop it so line
            // numbers match the preview panel.
            if (parts.length > 0 && parts[parts.length - 1] === "")
                parts.pop();
            const start = Math.min(range.start, parts.length);
            const end = Math.min(range.end, parts.length);
            if (start < 1 || end < start) {
                ctx.emit({
                    type: "notice",
                    level: "warning",
                    text: `Selected lines are out of range, falling back to path reference: ${att.path}`,
                });
                out.push(makeReference());
                continue;
            }
            const selected = parts.slice(start - 1, end).join("\n");
            out.push({
                message: {
                    customType: "file",
                    content: [
                        {
                            type: "text",
                            text: `\n<file path="${rel}" lines="${start}-${end}">\n\`\`\`\n${selected}\n\`\`\`\n</file>`,
                        },
                    ],
                    display: true,
                    details: {
                        name,
                        path: rel,
                        mode: "lines",
                        size: stat.size,
                        lines: end - start + 1,
                        startLine: start,
                        endLine: end,
                    },
                },
            });
            continue;
        }
        // Forced inline has a hard cap to protect the model context.
        if (att.mode === "inline") {
            if (stat.size > MAX_INLINE_BYTES) {
                ctx.emit({
                    type: "notice",
                    level: "warning",
                    text: `File too large, falling back to path reference: ${att.path}`,
                });
                out.push(makeReference());
                continue;
            }
            const buf = await fs.readFile(abs);
            if (buf.includes(0)) {
                ctx.emit({
                    type: "notice",
                    level: "warning",
                    text: `Binary file, falling back to path reference: ${att.path}`,
                });
                out.push(makeReference());
                continue;
            }
            out.push(makeInline(buf));
            continue;
        }
        // Auto: small files inline, large files reference by path.
        if (stat.size > MAX_INLINE_BYTES) {
            out.push(makeReference());
            continue;
        }
        const buf = await fs.readFile(abs);
        if (buf.includes(0)) {
            ctx.emit({
                type: "notice",
                level: "warning",
                text: `Skipped binary file (path reference only): ${att.path}`,
            });
            out.push(makeReference());
            continue;
        }
        out.push(makeInline(buf));
    }
    return out;
}
