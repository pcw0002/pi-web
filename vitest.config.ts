import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Pure-function unit tests: millisecond, zero token, zero port — required in CI.
		// End-to-end scripts (tests/*-test.mjs) are not here: they boot their own
		// server via `npm run test:smoke` / a standalone node run.
		include: ["tests/unit/**/*.test.ts"],
		environment: "node",
	},
});
