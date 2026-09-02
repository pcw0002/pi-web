import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "highlight.js/styles/github-dark.css";
import { applyTheme, loadTheme } from "./theme";
import { initAuthToken } from "./auth-token";

// Absorb ?token= from the address bar (PI_WEB_TOKEN auth entry) and persist it — must run before the first request.
initAuthToken();

// Apply the persisted theme before first render so there's no flash of the
// wrong palette. The full stylesheet swap happens via an injected <link>.
applyTheme(loadTheme());

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
