import { useEffect, useRef } from "react";
import {
	makePluginContext,
	type LoadedPluginView,
} from "../plugin-loader";
import { useT } from "../i18n";

interface PluginViewProps {
	entry: LoadedPluginView;
	send: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => boolean;
}

/**
 * Plugin view host: a thin React shell that hands a DOM container + narrow
 * context to the plugin's mount(). Switching away sets display:none on the
 * whole container (no unmount, plugin state is kept); real cleanup only
 * happens when the plugin is removed or fails.
 */
export function PluginView({ entry, send }: PluginViewProps) {
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		let cleanup: void | (() => void);
		try {
			cleanup = entry.module.mount(
				el,
				makePluginContext(entry.info.id, (msg) => send(msg)),
			);
		} catch (err) {
			console.error(`[plugin:${entry.info.id}] mount failed:`, err);
			el.textContent = t("pluginMountFailed", { name: entry.info.name });
		}
		return () => {
			if (typeof cleanup === "function") {
				try {
					cleanup();
				} catch (err) {
					console.error(`[plugin:${entry.info.id}] cleanup failed:`, err);
				}
			}
			el.textContent = "";
		};
	}, [entry, send, t]);
	return <div className="plugin-view" ref={ref} />;
}
