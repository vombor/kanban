// `devAssignment` at card creation (plan §4.0, P3-5): when the creator set no agent and no model, the workspace's
// resolved kit may name the agent and model a new dev card runs on, and the answer is stored on the card. Every
// creator goes through this module: `kanban task create` calls it in-process (the CLI writes the board itself), and
// the browser's create dialog asks `workspace.getDevAssignment` over tRPC to preselect the proposal.
//
// Guarantees:
//   - An explicit agent or model always wins (`--agent-id default` counts: it explicitly asks for the selected agent).
//   - The `default` kit answers null, so a board without a kit creates cards exactly as upstream does.
//   - With `workspaces.<id>.pipeline.shadow` on, the proposal is only logged; the card is created as today.
//   - Never decides on an agent id literal: the agent comes from the kit, and whether a provider is stored comes from
//     the agent catalog's capabilities.
//
// Proposals are logged to `data/<workspace>/dev-assignment.jsonl` whenever the kit has one (applied, shadow or
// overridden by the creator), so a shadow day can compare them with the orchestrator's own choices (P5-1). The CLI
// logs its cards itself; browser-created cards are logged by the server on board save
// (`browser-dev-assignment-log.ts`), with the same entry shape and `source: "browser"`.
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { getWorkspacePipelineSettings, type PipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import { getRuntimeAgentCatalogEntry } from "../core/agent-catalog";
import type { RuntimeAgentId, RuntimeTaskAgentSettings } from "../core/api-contract";
import { cloneRuntimeTaskAgentSettings } from "../core/task-agent-settings";
import { providerForModel } from "../models/cline-providers";
import { getKanbanWorkspaceDataPath } from "../state/kanban-home";
import { createRoutingPolicy } from "./policy";
import { DEFAULT_KIT_NAME, loadKitCatalog, resolveWorkspaceKit, type WorkspaceKitResolution } from "./resolve-kit";

export const DEV_ASSIGNMENT_LOG_FILENAME = "dev-assignment.jsonl";

export interface DevAssignmentRequest {
	workspaceId: string;
	title: string;
	prompt: string;
	/** The creator's agent: undefined = none set; null = explicitly the selected agent (`--agent-id default`). */
	agentId?: RuntimeAgentId | null;
	agentSettings?: RuntimeTaskAgentSettings;
}

/** What the kit proposes, as card fields. */
export interface DevAssignmentProposal {
	agentId: RuntimeAgentId;
	agentSettings?: RuntimeTaskAgentSettings;
	/** The kit tier the model came from (`dev.model: { tier }`), for display. */
	tier: string | null;
}

export type DevAssignmentOutcome =
	/** The kit has no answer (the `default` kit): the card is created as the creator set it. */
	| "none"
	/** The creator set an agent or model: theirs wins. */
	| "explicit"
	/** `pipeline.shadow` is on: logged, not applied. */
	| "shadow"
	/** Stored on the card. */
	| "applied";

export interface DevAssignmentDecision {
	workspaceId: string;
	kitName: string;
	outcome: DevAssignmentOutcome;
	proposal: DevAssignmentProposal | null;
	/** The agent and settings to store on the card. Equal to the request's unless the outcome is `applied`. */
	agentId: RuntimeAgentId | undefined;
	agentSettings: RuntimeTaskAgentSettings | undefined;
	/** Kit resolution problems (the workspace then runs on `default`). */
	issues: string[];
}

/** True when the creator chose an agent or a model (a reasoning effort alone doesn't count). */
export function hasExplicitDevAssignment(request: Pick<DevAssignmentRequest, "agentId" | "agentSettings">): boolean {
	return (
		request.agentId !== undefined ||
		Boolean(request.agentSettings?.providerId?.trim()) ||
		Boolean(request.agentSettings?.modelId?.trim())
	);
}

/**
 * The provider stored with a proposed model: the kit's own, else the machine's `models.providers` policy
 * (`providerForModel`: `fallback[model]`, else `default`). Null for an agent that reads no provider.
 */
export function resolveProposalProvider(
	agentId: RuntimeAgentId,
	model: { provider: string | null; model: string },
	models: PipelineConfig["models"],
): string | null {
	if (getRuntimeAgentCatalogEntry(agentId)?.capabilities.providerOverride === "none") {
		return null;
	}
	return model.provider ?? providerForModel(model.model, models.providers);
}

/** Asks the resolved kit and turns its answer into card fields. Pure. */
export function proposeDevAssignment(input: {
	request: Pick<DevAssignmentRequest, "workspaceId" | "title" | "prompt">;
	resolved: Pick<WorkspaceKitResolution, "kit">;
	models: PipelineConfig["models"];
}): DevAssignmentProposal | null {
	const answer = createRoutingPolicy(input.resolved.kit).devAssignment({
		workspaceId: input.request.workspaceId,
		title: input.request.title,
		prompt: input.request.prompt,
		role: "dev",
	});
	if (!answer) {
		return null;
	}
	if (!answer.model) {
		return { agentId: answer.agentId, tier: answer.tier ?? null };
	}
	const providerId = resolveProposalProvider(answer.agentId, answer.model, input.models);
	return {
		agentId: answer.agentId,
		agentSettings: { ...(providerId ? { providerId } : {}), modelId: answer.model.model },
		tier: answer.tier ?? null,
	};
}

/** Decides what a new card gets. Pure: `config` and `resolved` are the workspace's current settings and kit. */
export function decideDevAssignment(input: {
	request: DevAssignmentRequest;
	config: PipelineConfig;
	resolved: WorkspaceKitResolution;
}): DevAssignmentDecision {
	const { request, config, resolved } = input;
	const requested = {
		agentId: request.agentId ?? undefined,
		agentSettings: cloneRuntimeTaskAgentSettings(request.agentSettings),
	};
	const proposal = proposeDevAssignment({ request, resolved, models: config.models });
	const base = { workspaceId: request.workspaceId, kitName: resolved.kitName, proposal, issues: resolved.issues };
	if (!proposal) {
		return { ...base, outcome: "none", ...requested };
	}
	if (hasExplicitDevAssignment(request)) {
		return { ...base, outcome: "explicit", ...requested };
	}
	if (getWorkspacePipelineSettings(config, request.workspaceId).pipeline.shadow) {
		return { ...base, outcome: "shadow", ...requested };
	}
	// A reasoning effort the creator set alone is kept with the kit's model.
	const reasoningEffort = requested.agentSettings?.reasoningEffort;
	const agentSettings =
		proposal.agentSettings || reasoningEffort
			? { ...proposal.agentSettings, ...(reasoningEffort ? { reasoningEffort } : {}) }
			: undefined;
	return { ...base, outcome: "applied", agentId: proposal.agentId, agentSettings };
}

/**
 * Reads the workspace's config and kit, then decides. A config.json that can't be read decides nothing (`none`,
 * with an issue): routing must never stop a card from being created.
 */
export async function resolveDevAssignment(
	request: DevAssignmentRequest,
	options: { configPath?: string; kitsDir?: string } = {},
): Promise<DevAssignmentDecision> {
	try {
		const [{ config, issues: configIssues }, catalog] = await Promise.all([
			readPipelineConfig(options.configPath),
			loadKitCatalog(options.kitsDir),
		]);
		const resolved = resolveWorkspaceKit(config, request.workspaceId, catalog);
		const decision = decideDevAssignment({ request, config, resolved });
		return { ...decision, issues: [...configIssues, ...decision.issues] };
	} catch (error) {
		return {
			workspaceId: request.workspaceId,
			kitName: DEFAULT_KIT_NAME,
			outcome: "none",
			proposal: null,
			agentId: request.agentId ?? undefined,
			agentSettings: cloneRuntimeTaskAgentSettings(request.agentSettings),
			issues: [`could not read the kit config: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
}

/** Who created the card: `kanban task create`, or the browser's create dialog (logged by the server on save). */
export type DevAssignmentLogSource = "cli" | "browser";

export interface DevAssignmentLogEntry {
	at: string;
	workspaceId: string;
	taskId: string;
	title: string;
	kit: string;
	outcome: Exclude<DevAssignmentOutcome, "none">;
	proposal: DevAssignmentProposal;
	/** What the card was created with. */
	created: { agentId: RuntimeAgentId | null; agentSettings: RuntimeTaskAgentSettings | null };
	/** Missing on entries written before browser cards were logged (all of those came from the CLI). */
	source?: DevAssignmentLogSource;
}

export function getDevAssignmentLogPath(workspaceId: string): string {
	return join(getKanbanWorkspaceDataPath(workspaceId), DEV_ASSIGNMENT_LOG_FILENAME);
}

/**
 * Appends the decision for a created card to `data/<workspace>/dev-assignment.jsonl`. Nothing is written when the
 * kit had no proposal, so boards on the `default` kit never get the file.
 */
export async function recordDevAssignment(
	decision: DevAssignmentDecision,
	task: { id: string; title: string },
	options: { now?: Date; dataDir?: string; source?: DevAssignmentLogSource } = {},
): Promise<DevAssignmentLogEntry | null> {
	if (!decision.proposal || decision.outcome === "none") {
		return null;
	}
	const entry: DevAssignmentLogEntry = {
		at: (options.now ?? new Date()).toISOString(),
		workspaceId: decision.workspaceId,
		taskId: task.id,
		title: task.title,
		kit: decision.kitName,
		outcome: decision.outcome,
		proposal: decision.proposal,
		created: { agentId: decision.agentId ?? null, agentSettings: decision.agentSettings ?? null },
		source: options.source ?? "cli",
	};
	const dataDir = options.dataDir ?? getKanbanWorkspaceDataPath(decision.workspaceId);
	await mkdir(dataDir, { recursive: true });
	await appendFile(join(dataDir, DEV_ASSIGNMENT_LOG_FILENAME), `${JSON.stringify(entry)}\n`, "utf8");
	return entry;
}
