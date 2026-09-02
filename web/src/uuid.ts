/**
 * UUID helper.
 *
 * Why not crypto.randomUUID():
 *   It is only available in a secure context (HTTPS or localhost) — undefined
 *   when pi-web-ui is reached over plain HTTP via a LAN IP / remote host;
 *   Safari < 15.4 lacks it entirely. Calling it in WebSocket onopen used to
 *   throw, so hello never went out and the whole session hung.
 *
 * Fallback is crypto.getRandomValues() (RFC 4122 v4) — available in insecure
 * contexts and every modern browser; Math.random only as a last resort in
 * extreme environments.
 */
export function randomUuid(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}
	const bytes = new Uint8Array(16);
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.getRandomValues === "function"
	) {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
