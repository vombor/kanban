// `planAssignment` at plan card creation: `kanban task create --role plan` asks the workspace's resolved kit which
// agent and model the planner runs on and whether it starts in plan mode (the kit's `plan` section). Planning is a
// role of its own (user 2026-10-07: an architect, not the orchestrator's scrum-master job), and a kit with
// `plan.enabled` off makes no plan cards: on the `default` kit the one agent still plans its own work, so a plan card
// is refused there rather than created on a board that has no planner.
//
// As for dev cards (dev-assignment.ts), an agent or model the creator set wins, and so does an explicit
// `--start-in-plan-mode`. Unlike devAssignment, `pipeline.shadow` doesn't hold it back: there is no legacy planner to
// compare against, and the answer only changes the plan card itself.
import { type PipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeAgentId, RuntimeTaskAgentSettings } from "../core/api-contract";
import { cloneRuntimeTaskAgentSettings } from "../core/task-agent-settings";
import { hasExplicitDevAssignment, resolveProposalProvider } from "./dev-assignment";
import { answerPlanAssignment } from "./policy";
import { loadKitCatalog, resolveWorkspaceKit, type WorkspaceKitResolution } from "./resolve-kit";

export interface PlanAssignmentRequest {
	workspaceId: string;
	/** The creator's agent: undefined = none set; null = explicitly the selected agent (`--agent-id default`). */
	agentId?: RuntimeAgentId | null;
	agentSettings?: RuntimeTaskAgentSettings;
	/** The creator's `--start-in-plan-mode`; undefined = the kit decides. */
	startInPlanMode?: boolean;
}

export type PlanAssignmentDecision =
	| { ok: false; kitName: string; error: string; issues: string[] }
	| {
			ok: true;
			kitName: string;
			/** `applied` = the kit's agent/model; `explicit` = the creator's (plan mode may still be the kit's). */
			outcome: "applied" | "explicit";
			agentId: RuntimeAgentId | undefined;
			agentSettings: RuntimeTaskAgentSettings | undefined;
			startInPlanMode: boolean;
			/** The kit's `plan.rules` texts for the plan prompt. */
			rules: string[];
			tier: string | null;
			issues: string[];
	  };

/** Decides what a new plan card gets. Pure. */
export function decidePlanAssignment(input: {
	request: PlanAssignmentRequest;
	config: PipelineConfig;
	resolved: Pick<WorkspaceKitResolution, "kit" | "kitName" | "issues">;
}): PlanAssignmentDecision {
	const { request, resolved } = input;
	const answer = answerPlanAssignment(resolved.kit);
	if (answer.kind === "disabled") {
		return {
			ok: false,
			kitName: resolved.kitName,
			error: `${answer.reason}, so this project makes no plan cards: its agent plans its own work. To use a planner, set the kit override plan.enabled (kanban kit apply ... --set plan.enabled=true) or use a kit with a plan section (team).`,
			issues: resolved.issues,
		};
	}
	const startInPlanMode = request.startInPlanMode ?? answer.startInPlanMode;
	const base = { ok: true as const, kitName: resolved.kitName, startInPlanMode, rules: answer.rules };
	if (hasExplicitDevAssignment(request)) {
		return {
			...base,
			outcome: "explicit",
			agentId: request.agentId ?? undefined,
			agentSettings: cloneRuntimeTaskAgentSettings(request.agentSettings),
			tier: null,
			issues: resolved.issues,
		};
	}
	const providerId =
		answer.model && answer.agentId
			? resolveProposalProvider(answer.agentId, answer.model, input.config.models)
			: null;
	const reasoningEffort = request.agentSettings?.reasoningEffort;
	const agentSettings: RuntimeTaskAgentSettings | undefined =
		answer.model || reasoningEffort
			? {
					...(providerId ? { providerId } : {}),
					...(answer.model ? { modelId: answer.model.model } : {}),
					...(reasoningEffort ? { reasoningEffort } : {}),
				}
			: undefined;
	return {
		...base,
		outcome: "applied",
		agentId: answer.agentId ?? undefined,
		agentSettings,
		tier: answer.tier ?? null,
		issues: resolved.issues,
	};
}

/** Reads the workspace's config and kit, then decides. */
export async function resolvePlanAssignment(
	request: PlanAssignmentRequest,
	options: { configPath?: string; kitsDir?: string } = {},
): Promise<PlanAssignmentDecision> {
	const [{ config, issues: configIssues }, catalog] = await Promise.all([
		readPipelineConfig(options.configPath),
		loadKitCatalog(options.kitsDir),
	]);
	const resolved = resolveWorkspaceKit(config, request.workspaceId, catalog);
	const decision = decidePlanAssignment({ request, config, resolved });
	return { ...decision, issues: [...configIssues, ...decision.issues] };
}
