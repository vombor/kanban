// Supplemental browser instructions for snapshots without the project's usual screenshot/browse scripts. The
// legacy QA skeleton stays unchanged; neither missing scripts nor a tooling fallback waive visual evidence.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { quoteShellArg } from "../core/shell";
import { getKanbanHomePath } from "../state/kanban-home";

export const QA_BROWSER_SCRIPTS = ["browse", "screenshot"] as const;

/** Explicit settings win; otherwise use Kanban's vendored Chromium libraries when installed. */
export function resolveQaChromiumLibs(configured: string | null, homePath = getKanbanHomePath()): string | null {
	if (configured) {
		return configured;
	}
	const vendor = join(homePath, "vendor/chromium-libs");
	return existsSync(join(vendor, "root/usr/lib/x86_64-linux-gnu")) ? vendor : null;
}

export function buildQaBrowserToolingNote(input: {
	scripts: readonly string[];
	scratchDir: string;
	outboxDir: string;
	chromiumLibs: string | null;
}): string | null {
	const missing = QA_BROWSER_SCRIPTS.filter((script) => !input.scripts.includes(script));
	if (missing.length === 0) {
		return null;
	}
	const scratch = quoteShellArg(input.scratchDir);
	const out = quoteShellArg(input.outboxDir);
	const env = input.chromiumLibs ? `QA_CHROMIUM_LIBS=${quoteShellArg(input.chromiumLibs)} ` : "";
	return [
		"BROWSER TOOLING FALLBACK (supplement to step 3):",
		`This snapshot has no ${missing.map((script) => `npm run ${script}`).join(" or ")} script. Missing project scripts alone do not establish that visual QA is unavailable.`,
		"Start and test only the scratch copy's application, on a free port: use the configured QA servers script when given, otherwise read its package.json and use its production start script (build first if needed) or the framework's server directly in the scratch copy. The prohibition on project preview/dev scripts still applies. Never stop or use the shared main-checkout preview as evidence for this snapshot.",
		`Use ${env}kanban qa shot --base <scratch-app-url> --out ${out} --scratch ${scratch} --routes <route,...> --viewports mobile,desktop --script ${out}/flow.json. This is the one permitted Kanban QA command; it writes screenshots plus report.txt/report.json. The JSON flow is an array of goto, fill, click, press, select, waitFor, wait, expectText and screenshot steps; script an interaction and check its result, as steps 3a/3f require.`,
		`Playwright is loaded from ${scratch}/node_modules or its tools/preview directory. If absent, install it in the scratch copy only (npm install --no-save --package-lock=false playwright), never in the project checkout or Kanban home.`,
		"kanban qa shot tries Playwright's own browser, then the cached chromium_headless_shell under the running user's .cache/ms-playwright directory. A mismatched Playwright browser build does not require giving up before trying this cached browser.",
		...(input.chromiumLibs
			? [
					`The Chromium library bundle is ${input.chromiumLibs}. The command adds its root/usr/lib/x86_64-linux-gnu to LD_LIBRARY_PATH and uses its fonts.conf as FONTCONFIG_FILE. For custom Playwright tooling, pass the same settings to the browser process; set executablePath to the cached chrome-headless-shell-linux64/chrome-headless-shell if the bundled build is absent.`,
				]
			: []),
		"Save evidence under OUT and inspect the screenshots. UI work still requires real visual evidence; an HTTP/code trace alone is insufficient. If this fallback cannot run for reasons also present on the base, record the exact command and error as STALLED (tooling), not a defect in the dev card.",
	].join("\n");
}
