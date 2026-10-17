// Supplemental browser instructions for snapshots without the project's usual screenshot/browse scripts. The
// legacy QA skeleton stays unchanged; neither missing scripts nor a tooling fallback waive visual evidence.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { quoteShellArg } from "../core/shell";
import { getKanbanHomePath } from "../state/kanban-home";
import { getQaToolchainInfo } from "./qa-toolchain";

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
	const tools = getQaToolchainInfo();
	return [
		"BROWSER TOOLING FALLBACK (supplement to step 3):",
		`This snapshot has no ${missing.map((script) => `npm run ${script}`).join(" or ")} script. Missing project scripts alone do not establish that visual QA is unavailable.`,
		"Start and test only the scratch copy's application, on a free port: use the configured QA servers script when given, otherwise read its package.json and use its production start script (build first if needed) or the framework's server directly in the scratch copy. The prohibition on project preview/dev scripts still applies. Never stop or use the shared main-checkout preview as evidence for this snapshot.",
		`Use kanban qa shot --base <scratch-app-url> --out ${out} --scratch ${scratch} --routes <route,...> --viewports mobile,desktop --script ${out}/flow.json. It writes screenshots plus report.txt/report.json. Use kanban qa tools --verify --json for readiness: this is also permitted, is read-only and exercises owned browser contexts. The JSON flow is an array of goto, fill, click, press, select, waitFor, wait, expectText and screenshot steps; script an interaction and check its result, as steps 3a/3f require.`,
		'Every flow step needs an explicit "type" key, for example [{"type":"goto","url":"/"},{"type":"fill","selector":"#title","value":"QA title"},{"type":"click","selector":"button[type=submit]"},{"type":"expectText","selector":"main","text":"QA title"},{"type":"screenshot","path":"result.png"}]. expectText with a selector checks only that region; screenshot uses path, not name. Arrays run separately at every --viewports size, with distinct screenshot paths. An envelope {"viewport":"375x667","steps":[...]} pins one size. Inspect report.json viewportSize and the PNG dimensions; never label a desktop capture as mobile evidence.',
		`Kanban packages pinned Playwright and a raster decoder. For custom tools use explicit modules: Playwright ${tools.playwrightModule}; PNG decoder ${tools.pngModule}. Connect with chromium.connectOverCDP(${JSON.stringify(tools.cdpUrl)}), create a NEW context per review and close only that context; never touch agents' default contexts/tabs. browser.close() disconnects the CDP client. Do not npm-install Playwright per worktree, download/install/launch another browser, or change shared Chrome flags. App npm ci belongs only in isolated app copies.`,
		"Readiness must include rendered glyph ink and multiline input, not just process launch/DOM text/background paint. kanban qa tools --verify --json checks those at both sizes. If a retained Fontconfig still names an old inaccessible home, ask the user to inspect/repair it with kanban qa fonts --repair --json as the runtime/QA OS user; do not rewrite shared vendor assets yourself or treat missing glyphs as application FAIL evidence.",
		"Save evidence under OUT and inspect the screenshots. UI work still requires real visual evidence; an HTTP/code trace alone is insufficient. If this fallback cannot run for reasons also present on the base, record the exact command and error as STALLED (tooling), not a defect in the dev card.",
	].join("\n");
}
