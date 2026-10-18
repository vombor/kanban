// Maintainer/operator artifact only. Never included in the product's dist or npm/image payload.
import { execFile } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { build } from "esbuild";

await mkdir("tools/maintainer/dist", { recursive: true });
await build({
	entryPoints: ["tools/maintainer/src/cli.ts"],
	outfile: "tools/maintainer/dist/maintenance.mjs",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	define: { "process.env.NODE_ENV": '"production"' },
	banner: {
		js: 'import {createRequire as maintainerRequire} from "node:module";\nconst require=maintainerRequire(import.meta.url);',
	},
});
await copyFile("tools/maintainer/github-app-bridge.py", "tools/maintainer/dist/github-app-bridge.py");
await promisify(execFile)(process.execPath, ["--check", "tools/maintainer/dist/maintenance.mjs"]);
process.stdout.write("Built maintainer-only automation outside the product payload.\n");
