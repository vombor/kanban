import * as esbuild from "esbuild";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";

/**
 * Runtime externals. `node-pty` is a native addon with a compiled binding
 * and a spawn-helper binary that must live on disk, so it can't be bundled.
 * Everything else esbuild can inline.
 */
const external = ["node-pty", "playwright-core", "pngjs"];

/**
 * Bake build-time env into the bundle. Sentry error reporting stays off unless
 * the build supplies a fork-owned KANBAN_SENTRY_DSN.
 */
const define = {
	"process.env.NODE_ENV": '"production"',
	"process.env.KANBAN_SENTRY_DSN": JSON.stringify(process.env.KANBAN_SENTRY_DSN ?? ""),
};

/**
 * Bundled CJS dependencies call require() on Node built-ins (process, fs, etc.).
 * ESM output needs a real require() function for those calls to work.
 */
const cjsShimBanner = [
	'import { createRequire as __kanban_createRequire } from "node:module";',
	"const require = __kanban_createRequire(import.meta.url);",
].join("\n");

/** Shared esbuild options for both entry points. */
const shared = {
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	external,
	define,
	sourcemap: true,
	packages: "bundle",
	banner: { js: cjsShimBanner },
};

await Promise.all([
	// CLI binary
	esbuild.build({
		...shared,
		entryPoints: ["src/cli.ts"],
		outfile: "dist/cli.js",
		banner: { js: `#!/usr/bin/env node\n${cjsShimBanner}` },
	}),
	// Library export
	esbuild.build({
		...shared,
		entryPoints: ["src/index.ts"],
		outfile: "dist/index.js",
	}),
	esbuild.build({
		...shared,
		entryPoints: ["src/maintenance/cli.ts"],
		outfile: "dist/maintenance.js",
		banner: { js: `#!/usr/bin/env node\n${cjsShimBanner}` },
	}),
]);

await mkdir("dist/maintenance", { recursive: true });
await copyFile("scripts/maintenance/github-app-bridge.py", "dist/maintenance/github-app-bridge.py");
await chmod("dist/maintenance.js", 0o755);
// Parse every actual artifact. A source shebang plus a banner shebang is otherwise only caught on first launch.
await Promise.all(["dist/cli.js", "dist/index.js", "dist/maintenance.js"].map((file) => promisify(execFile)(process.execPath, ["--check", file])));
console.log("esbuild: bundled CLI, library and host maintenance supervisor");
