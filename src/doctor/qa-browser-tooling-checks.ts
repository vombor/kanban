import type { PipelineConfig } from "../config/pipeline-config";
import type { KitCatalog } from "../kits/resolve-kit";
import { resolveWorkspaceKit } from "../kits/resolve-kit";
import { readSnapshotCheckScripts } from "../pipeline/checks";
import { QA_BROWSER_SCRIPTS, resolveQaChromiumLibs } from "../pipeline/qa-browser-tooling";
import { inspectQaFontconfig } from "../pipeline/qa-fontconfig";
import { getQaToolchainInfo } from "../pipeline/qa-toolchain";
import type { RuntimeWorkspaceIndexEntry } from "../state/workspace-state";
import type { DoctorFinding } from "./doctor-report";

export async function checkQaBrowserTooling(input: {
	config: PipelineConfig;
	catalog: KitCatalog;
	entries: readonly RuntimeWorkspaceIndexEntry[];
}): Promise<DoctorFinding[]> {
	const findings: DoctorFinding[] = [];
	const toolchain = getQaToolchainInfo();
	const vendor = resolveQaChromiumLibs(input.config.pipeline.qa.chromiumLibs);
	if (vendor) {
		try {
			const fonts = inspectQaFontconfig(vendor);
			findings.push({
				level: fonts.issues.length ? "warn" : "pass",
				area: "home",
				message: fonts.issues.length
					? `Retained browser fonts: ${fonts.issues.join("; ")}`
					: "Retained browser font paths are readable and cache is writable",
				hint: "The user can run kanban qa fonts --repair --json to back up/regenerate owned paths. Native QA uses shared Chrome; kanban qa tools --verify --json checks actual glyph ink and multiline input. Font defects are tooling, never application FAIL evidence.",
			});
		} catch {
			findings.push({
				level: "warn",
				area: "home",
				message: "Retained Fontconfig could not be inspected; it was not overwritten",
				hint: "Run kanban qa fonts --json as the user and inspect the reported syntax/access problem. Shared Chrome glyph readiness is kanban qa tools --verify --json.",
			});
		}
	}
	for (const entry of input.entries) {
		const resolution = resolveWorkspaceKit(input.config, entry.workspaceId, input.catalog);
		if (!resolution.kit.qa?.enabled) {
			continue;
		}
		const scripts = await readSnapshotCheckScripts(entry.repoPath, "HEAD", QA_BROWSER_SCRIPTS);
		const missing = QA_BROWSER_SCRIPTS.filter((script) => !scripts.includes(script));
		if (missing.length === 0) {
			continue;
		}
		findings.push({
			level: "warn",
			area: "project",
			message: `${entry.workspaceId}: QA needs visual evidence for UI work, but the root package.json has no ${missing.join("/")} script; QA receives kanban qa shot instructions using pinned Playwright ${toolchain.playwrightVersion} and the shared Chrome sidecar`,
			hint: `provide project QA server setup in qa.serversScript/qa.promptNotes.screenshotFallback. Run kanban qa tools --verify --json to verify shared CDP, actual mobile/desktop PNG decoding, glyph ink and multiline input. This check does not launch a browser or install tooling.`,
		});
	}
	return findings;
}
