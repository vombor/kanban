import type { PipelineConfig } from "../config/pipeline-config";
import type { KitCatalog } from "../kits/resolve-kit";
import { resolveWorkspaceKit } from "../kits/resolve-kit";
import { readSnapshotCheckScripts } from "../pipeline/checks";
import { QA_BROWSER_SCRIPTS, resolveQaChromiumLibs } from "../pipeline/qa-browser-tooling";
import type { RuntimeWorkspaceIndexEntry } from "../state/workspace-state";
import type { DoctorFinding } from "./doctor-report";

export async function checkQaBrowserTooling(input: {
	config: PipelineConfig;
	catalog: KitCatalog;
	entries: readonly RuntimeWorkspaceIndexEntry[];
}): Promise<DoctorFinding[]> {
	const findings: DoctorFinding[] = [];
	const libs = resolveQaChromiumLibs(process.env.QA_CHROMIUM_LIBS || input.config.pipeline.qa.chromiumLibs);
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
			message: `${entry.workspaceId}: QA needs visual evidence for UI work, but the root package.json has no ${missing.join("/")} script; QA receives kanban qa shot fallback instructions${libs ? ` using Chromium libraries at ${libs}` : " (no vendored Chromium library bundle found)"}`,
			hint: `provide project browse/screenshot tooling or QA server setup in qa.serversScript/qa.promptNotes.screenshotFallback; the fallback needs Playwright in its scratch copy and a runnable or cached browser. This check does not launch a browser; verify the setup before UI work.`,
		});
	}
	return findings;
}
