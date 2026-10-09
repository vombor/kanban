// Managed sections in a project's files (today: the `agents-qa` section of AGENTS.md). `kanban project sync` keeps
// existing ones current, `kanban project add --agents-md` adds one, and `kanban doctor` reports stale ones. A
// section only appears where someone added it: sync never adds one to a file that has none.
import { basename, join } from "node:path";

import { getWorkspacePipelineSettings, type PipelineConfig } from "../config/pipeline-config";
import { type ManagedSectionStatus, readManagedSectionStatus, writeManagedSection } from "../setup/managed-section";
import { detectProjectBaseBranch } from "../workspace/git-utils";
import {
	AGENTS_FILE_NAME,
	AGENTS_QA_SECTION,
	type AgentsQaSectionVars,
	renderAgentsQaSection,
} from "./agents-qa-section";

export async function resolveAgentsQaSectionVars(
	config: PipelineConfig,
	workspaceId: string,
	repoPath: string,
): Promise<AgentsQaSectionVars> {
	const settings = getWorkspacePipelineSettings(config, workspaceId);
	return {
		name: settings.name ?? basename(repoPath),
		baseBranch: settings.defaultBaseRef ?? (await detectProjectBaseBranch(repoPath)) ?? "the base branch",
	};
}

export async function readAgentsQaSectionStatus(
	config: PipelineConfig,
	workspaceId: string,
	repoPath: string,
): Promise<ManagedSectionStatus> {
	const vars = await resolveAgentsQaSectionVars(config, workspaceId, repoPath);
	return await readManagedSectionStatus(
		AGENTS_QA_SECTION,
		join(repoPath, AGENTS_FILE_NAME),
		renderAgentsQaSection(vars),
	);
}

export type ProjectSectionAction = "up-to-date" | "updated" | "would-update" | "added" | "would-add" | "left-alone";

export interface ProjectSectionResult {
	section: string;
	filePath: string;
	state: ManagedSectionStatus["state"];
	action: ProjectSectionAction;
	detail: string;
}

function describe(status: ManagedSectionStatus, action: ProjectSectionAction): ProjectSectionResult {
	const details: Record<ProjectSectionAction, string> = {
		"up-to-date": "up to date",
		updated: status.state === "legacy" ? "updated (legacy kit markers replaced)" : "updated",
		"would-update": status.state === "legacy" ? "would update (and replace the legacy kit markers)" : "would update",
		added: "appended the managed section (an uncommitted change in the project)",
		"would-add": "would append the managed section",
		"left-alone":
			status.state === "missing-file"
				? "no file; left alone (kanban project add --agents-md adds the section)"
				: "no managed section; left alone (kanban project add --agents-md adds it)",
	};
	return {
		section: AGENTS_QA_SECTION.id,
		filePath: status.filePath,
		state: status.state,
		action,
		detail: details[action],
	};
}

/** `kanban project sync`: rewrite existing managed sections (new or legacy markers); never add one. */
export async function syncProjectSections(input: {
	config: PipelineConfig;
	workspaceId: string;
	repoPath: string;
	dryRun: boolean;
}): Promise<ProjectSectionResult[]> {
	const status = await readAgentsQaSectionStatus(input.config, input.workspaceId, input.repoPath);
	if (status.state === "current") {
		return [describe(status, "up-to-date")];
	}
	if (status.state === "missing-file" || status.state === "no-markers") {
		return [describe(status, "left-alone")];
	}
	if (input.dryRun) {
		return [describe(status, "would-update")];
	}
	await writeManagedSection(AGENTS_QA_SECTION, status);
	return [describe(status, "updated")];
}

/** `kanban project add --agents-md`: add the section to a file that has none; an existing one is left to sync. */
export async function addAgentsQaSection(input: {
	config: PipelineConfig;
	workspaceId: string;
	repoPath: string;
	dryRun: boolean;
}): Promise<ProjectSectionResult> {
	const status = await readAgentsQaSectionStatus(input.config, input.workspaceId, input.repoPath);
	if (status.state !== "missing-file" && status.state !== "no-markers") {
		return {
			...describe(status, "up-to-date"),
			detail:
				status.state === "current"
					? "managed section already there"
					: "managed section already there (kanban project sync updates it)",
		};
	}
	if (input.dryRun) {
		return describe(status, "would-add");
	}
	await writeManagedSection(AGENTS_QA_SECTION, status);
	return describe(status, "added");
}
