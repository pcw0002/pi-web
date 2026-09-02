/**
 * Plugin view loader: dynamically import <dataDir>/plugins/<id>/client/entry.mjs
 * into the page.
 *
 * Plugin client module contract (ESM, default export):
 *   export default {
 *     // Mount into the host-provided DOM container; return an optional cleanup
 *     // function, called when the view is switched away or unloaded.
 *     mount(container: HTMLElement, ctx: PluginViewContext): void | (() => void)
 *   }
 *
 * Communication with the host is two narrow channels (no shared React instance;
 * plugins may use any stack):
 *   ctx.send(payload)   → WS uplink {type:"plugin_message", pluginId, payload}
 *   ctx.onData(cb)      ← WS downlink plugin_data (filtered by pluginId)
 *
 * plugin_data is fanned out via a window CustomEvent (same pattern as theme
 * change); use-chat calls emitPluginData, and this module subscribes per plugin.
 */
import type { UiPluginInfo } from "./types";

export interface PluginViewContext {
	pluginId: string;
	/** Send one message to the plugin's server entry (index.mjs onMessage). */
	send: (payload: unknown) => void;
	/** Subscribe to server broadcasts; returns an unsubscribe function. */
	onData: (cb: (payload: unknown) => void) => () => void;
}

export interface PluginViewModule {
	mount(
		container: HTMLElement,
		ctx: PluginViewContext,
	): void | (() => void);
}

export interface LoadedPluginView {
	info: UiPluginInfo;
	module: PluginViewModule;
}

const PLUGIN_DATA_EVENT = "pi-web-ui:plugin-data";

/** Called by use-chat: turn a server plugin_data message into a fan-out event. */
export function emitPluginData(pluginId: string, payload: unknown): void {
	window.dispatchEvent(
		new CustomEvent(PLUGIN_DATA_EVENT, { detail: { pluginId, payload } }),
	);
}

function subscribeAll(
	cb: (pluginId: string, payload: unknown) => void,
): () => void {
	const handler = (e: Event) => {
		const d = (e as CustomEvent).detail as {
			pluginId: string;
			payload: unknown;
		};
		cb(d.pluginId, d.payload);
	};
	window.addEventListener(PLUGIN_DATA_EVENT, handler);
	return () => window.removeEventListener(PLUGIN_DATA_EVENT, handler);
}

// ---- Loaded-view registry (module singleton; React only reads via subscribe) -

const loaded = new Map<string, LoadedPluginView>();
const listeners = new Set<(views: LoadedPluginView[]) => void>();
/** Ids that failed to load — not retried within the same epoch (avoids
 *  infinite error spam from a bad bundle). Cleared when the catalog changes
 *  or the server reloads (epoch bump) so a fixed plugin can retry. */
const failed = new Set<string>();
/** Server-reload epoch used for the last load. When it changes, drop every
 *  loaded view (bundle URLs carry ?e= so the browser re-fetches). */
let lastEpoch = -1;

function snapshot(): LoadedPluginView[] {
	return [...loaded.values()];
}

function notify(): void {
	const snap = snapshot();
	for (const l of listeners) l(snap);
}

/** Subscribe to currently loaded plugin views (fires once immediately with the current snapshot). */
export function subscribeLoadedPluginViews(
	cb: (views: LoadedPluginView[]) => void,
): () => void {
	listeners.add(cb);
	cb(snapshot());
	return () => listeners.delete(cb);
}

/**
 * Sync catalog plugins that should be shown into the registry:
 * - epoch change (server plugins_reload) → drop all old bundles, re-fetch with ?e=
 * - gone / disabled in the catalog → remove the loaded view (React unmounts and calls cleanup)
 * - newly appeared and not previously failed → dynamic import
 */
export async function syncPluginViews(
	plugins: UiPluginInfo[],
	epoch: number,
): Promise<void> {
	if (epoch !== lastEpoch) {
		lastEpoch = epoch;
		loaded.clear();
		failed.clear();
	}
	// Drop entries no longer in the catalog (deleted dir / settings disable /
	// error) — including failed records, so a reinstalled plugin of the same
	// id can try again.
	const active = new Set(plugins.map((p) => p.id));
	for (const id of [...loaded.keys()]) {
		if (!active.has(id)) loaded.delete(id);
	}
	for (const id of [...failed]) {
		if (!active.has(id)) failed.delete(id);
	}
	await Promise.all(
		plugins
			.filter((p) => p.hasClient && !p.error && !loaded.has(p.id) && !failed.has(p.id))
			.map(async (p) => {
				try {
					// @vite-ignore: the URL is only known at runtime; Vite must
					// not try to bundle it. ?e=<epoch> busts the cache so a
					// server reload actually re-executes the changed bundle.
					const mod = (await import(
						/* @vite-ignore */ `/plugins/${encodeURIComponent(p.id)}/client/entry.mjs?e=${epoch}`
					)) as { default?: PluginViewModule };
					const m = mod.default;
					if (m && typeof m.mount === "function") {
						loaded.set(p.id, { info: p, module: m });
					} else {
						failed.add(p.id);
						console.error(`[plugin:${p.id}] entry.mjs is missing default.mount`);
					}
				} catch (err) {
					failed.add(p.id);
					console.error(`[plugin:${p.id}] failed to load client bundle:`, err);
				}
			}),
	);
	notify();
}

/** Build the context passed to plugin mount() (App injects the real ws send). */
export function makePluginContext(
	pluginId: string,
	send: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => void,
): PluginViewContext {
	return {
		pluginId,
		send: (payload) => send({ type: "plugin_message", pluginId, payload }),
		onData: (cb) => subscribeAll((pid, payload) => {
			if (pid === pluginId) cb(payload);
		}),
	};
}
