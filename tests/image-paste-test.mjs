/**
 * image-paste-test.mjs — pure WebSocket smoke: verify the "paste image" protocol path.
 *
 * Send a prompt with an imageData (raw base64) attachment and verify:
 *   1. the server turns it into a custom message with image content (details.mode === "image")
 *   2. that message's content in the snapshot has { type: "image", dataUrl: "data:image/..." }
 *   3. oversized images (>2MB) are refused with a notice
 *
 * Usage (needs a server already running):
 *   node image-paste-test.mjs   # connect ws://localhost:${PORT:-8787}
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const PORT = Number(process.env.PORT ?? 8787);
const WS_URL = `ws://localhost:${PORT}/ws`;

const clientId = randomUUID();
const ws = new WebSocket(WS_URL);

// 1x1 transparent PNG (base64)
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let step = 0;
let sawImageMsg = false;
let sawOversizeNotice = false;
const timer = setTimeout(() => {
	console.error("TIMEOUT — image message not observed");
	process.exit(1);
}, 15000);

function log(...a) {
	console.log(`[image-paste ${step}]`, ...a);
}

ws.on("open", () => {
	log("open, sending hello");
	ws.send(JSON.stringify({ type: "hello", clientId }));
});

ws.on("message", (d) => {
	const m = JSON.parse(d.toString());

	if (m.type === "ready") {
		log("ready, sending prompt with tiny pasted image");
		step = 1;
		ws.send(
			JSON.stringify({
				type: "prompt",
				text: "Describe this image",
				attachments: [
					{
						path: "",
						imageData: TINY_PNG,
						mimeType: "image/png",
						name: "paste-test.png",
						size: 0,
					},
					{
						// over limit: 1.5MB fake base64 (>2MB after decode) → should get a warning notice
						path: "",
						imageData: "A".repeat(3 * 1024 * 1024),
						mimeType: "image/png",
						name: "too-large.png",
						size: 0,
					},
				],
			}),
		);
	} else if (m.type === "snapshot") {
		for (const msg of m.state?.messages ?? []) {
			if (msg.customType !== "file") continue;
			if (msg.details?.mode !== "image") continue;
			const img = (msg.content ?? []).find((b) => b.type === "image");
			if (!img) continue;
			if (!String(img.dataUrl ?? "").startsWith("data:image/png;base64,")) {
				console.error("FAIL: image dataUrl prefix wrong:", img.dataUrl?.slice(0, 40));
				process.exit(1);
			}
			sawImageMsg = true;
			log("OK: image custom message in snapshot:", JSON.stringify(msg.details));
		}
	} else if (m.type === "notice") {
		if (m.level === "warning" && m.text.includes("too-large.png")) {
			sawOversizeNotice = true;
			log("OK: oversize notice:", m.text);
		} else {
			log("notice:", m.level, m.text);
		}
	} else if (m.type === "heartbeat") {
		// ignore
	}

	if (sawImageMsg && sawOversizeNotice) {
		clearTimeout(timer);
		log("PASS");
		ws.send(JSON.stringify({ type: "abort" }));
		ws.close();
		process.exit(0);
	}
});

ws.on("error", (e) => {
	console.error("ws error:", e.message);
	process.exit(1);
});
