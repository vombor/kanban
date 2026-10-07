// Runs the shadow diff for the workspaces asked for (scripts/pipeline-shadow-diff.ts parses the command line).
import { readFile } from "node:fs/promises";

import { getWorkspacePipelineSettings, readPipelineConfig } from "../../config/pipeline-config";
import { loadKitCatalog } from "../../kits/resolve-kit";
import { getLegacyKitAutolandLogPath } from "../../state/kanban-home";
import { parseLegacyAutolandLog } from "./legacy-autoland-log";
import { loadShadowDiffInput } from "./load-shadow-diff-inputs";
import { computeShadowDiff, type ShadowDiffReport } from "./shadow-diff";
import { formatShadowDiffReport } from "./shadow-diff-report";

export interface RunShadowDiffOptions {
	/** Empty = every workspace in shadow on landing `qa`, else every workspace on landing `qa`. */
	workspaceIds: string[];
	since: number;
	until: number;
	windowMs: number;
	legacyLogPath?: string;
	json: boolean;
	verbose: boolean;
}

export interface RunShadowDiffResult {
	reports: Array<ShadowDiffReport & { issues: string[] }>;
	output: string;
	/** 0: no unexplained difference; 1: some. */
	exitCode: 0 | 1;
}

export async function runShadowDiff(options: RunShadowDiffOptions): Promise<RunShadowDiffResult> {
	const legacyLogPath = options.legacyLogPath ?? getLegacyKitAutolandLogPath();
	const [{ config, issues: configIssues }, catalog, legacyText] = await Promise.all([
		readPipelineConfig(),
		loadKitCatalog(),
		readFile(legacyLogPath, "utf8"),
	]);
	const legacy = parseLegacyAutolandLog(legacyText);
	const qaWorkspaces = Object.keys(config.workspaces).filter(
		(workspaceId) => getWorkspacePipelineSettings(config, workspaceId).landing.mode === "qa",
	);
	const shadowWorkspaces = qaWorkspaces.filter(
		(workspaceId) => getWorkspacePipelineSettings(config, workspaceId).pipeline.shadow,
	);
	const workspaceIds =
		options.workspaceIds.length > 0
			? options.workspaceIds
			: shadowWorkspaces.length > 0
				? shadowWorkspaces
				: qaWorkspaces;
	if (workspaceIds.length === 0) {
		throw new Error("No workspace on landing qa in config.json; name one with --workspace <id>.");
	}
	const reports: RunShadowDiffResult["reports"] = [];
	for (const workspaceId of workspaceIds) {
		const input = await loadShadowDiffInput({
			workspaceId,
			config,
			catalog,
			legacy,
			since: options.since,
			until: options.until,
			windowMs: options.windowMs,
		});
		reports.push({ ...computeShadowDiff(input), issues: [...configIssues, ...input.issues] });
	}
	const output = options.json
		? `${JSON.stringify({ legacyLog: legacyLogPath, reports }, null, 2)}\n`
		: [
				`Legacy autoland log: ${legacyLogPath}\n`,
				...reports.map((report) =>
					formatShadowDiffReport(report, { verbose: options.verbose, issues: report.issues }),
				),
			].join("\n");
	return { reports, output, exitCode: reports.some((report) => report.unexplained > 0) ? 1 : 0 };
}
