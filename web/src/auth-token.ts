/**
 * Client-side PI_WEB_TOKEN handling.
 *
 * Once the server sets PI_WEB_TOKEN, every HTTP/WS request must carry the
 * secret. Browser navigation cannot send custom headers, so the contract is:
 * first visit via `?token=xxx` → store in localStorage → strip it from the
 * address bar (so shared links / history don't leak it) → every later request
 * appends the query param. The server also sets an HttpOnly cookie as a
 * fallback for subsequent navigations.
 */
const KEY = "pi-web-ui:token";

/** Call once at app start: absorb ?token= from the URL and clean the address bar. */
export function initAuthToken(): void {
	try {
		const url = new URL(window.location.href);
		const t = url.searchParams.get("token");
		if (t) {
			localStorage.setItem(KEY, t.trim());
			url.searchParams.delete("token");
			window.history.replaceState(null, "", url.toString());
		}
	} catch {
		/* ignore */
	}
}

/** Currently persisted token (empty string when unset). */
export function authToken(): string {
	try {
		return localStorage.getItem(KEY) ?? "";
	} catch {
		return "";
	}
}

/** Append the token query param to a relative URL (`&` if a query is already present). */
export function withToken(url: string): string {
	const t = authToken();
	if (!t) return url;
	return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}`;
}
