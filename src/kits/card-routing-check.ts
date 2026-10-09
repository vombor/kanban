// A card's own agent and model against the vetted model registry (src/kits/routing-vetting.ts). On a project whose
// kit routes work (any kit but `default`), an explicit per-card agent/model is a routing choice too:
//   - from an agent session (an orchestrator or a card running `kanban task create|update`): refused unless the
//     registry allows the combination for the card's role;
//   - from the user (their shell, the browser's create dialog): allowed with a clear warning. It's the user's call.
// Calibration, triage and QA cards are created by Kanban's own runners (QA gate, `bench calibrate`, `models vet`),
// which check their models themselves, so only dev and plan cards are checked here.
import { getWorkspacePipelineSettings, type PipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeAgentId, RuntimeTaskAgentSettings, RuntimeTaskRole } from "../core/api-contract";
import { getEntryRoleStatus, type VettingRole } from "../models/vetted-registry";
import { DEFAULT_KIT_NAME, loadKitCatalog, resolveWorkspaceKit } from "./resolve-kit";
import { checkRouting, getWorkspaceRoutingVetting, toVettingRole } from "./routing-vetting";

export type CardRoutingCheck =
	/** Nothing to check: no explicit choice, a kit that routes nothing, or a role that does no project work. */
	| { kind: "none" }
	| { kind: "ok" }
	/** The user's own choice outside the registry: allowed, with this warning. */
	| { kind: "warn"; message: string }
	/** An agent session's choice outside the registry. */
	| { kind: "refuse"; message: string };

export interface CardRoutingCheckInput {
	workspaceId: string;
	role: RuntimeTaskRole | undefined;
	/** The card's agent; null/undefined = the agent selected in Kanban settings. */
	agentId: RuntimeAgentId | null | undefined;
	agentSettings: RuntimeTaskAgentSettings | undefined;
	selectedAgentId: RuntimeAgentId;
	/** The command runs in an agent session (it has a session credential), not the user's shell or browser. */
	fromAgentSession: boolean;
}

/** Decides on an explicit agent/model. Pure: `config` and `kitName` are the workspace's. */
export function decideCardRouting(
	input: CardRoutingCheckInput & { config: PipelineConfig; kitName: string },
): CardRoutingCheck {
	const role = toVettingRole(input.role ?? "dev");
	if (!role || input.kitName === DEFAULT_KIT_NAME) {
		return { kind: "none" };
	}
	const combination = {
		agentId: input.agentId ?? input.selectedAgentId,
		provider: input.agentSettings?.providerId?.trim() || null,
		model: input.agentSettings?.modelId?.trim() || null,
	};
	const check = checkRouting(getWorkspaceRoutingVetting(input.config, input.workspaceId), role, combination);
	if (check.ok) {
		return { kind: "ok" };
	}
	return input.fromAgentSession
		? {
				kind: "refuse",
				message: `${input.workspaceId} routes only to combinations the vetted model registry allows: ${check.message}. Pick a vetted one (kanban models list --project ${input.workspaceId}), or ask the user.`,
			}
		: {
				kind: "warn",
				message: `${check.message}. The card is created as you asked (your call), but it may waste the project's time erroring out.`,
			};
}

export async function checkCardRouting(
	input: CardRoutingCheckInput,
	options: { configPath?: string; kitsDir?: string } = {},
): Promise<CardRoutingCheck> {
	const [{ config }, catalog] = await Promise.all([
		readPipelineConfig(options.configPath),
		loadKitCatalog(options.kitsDir),
	]);
	const { kitName } = resolveWorkspaceKit(config, input.workspaceId, catalog);
	return decideCardRouting({ ...input, config, kitName });
}

export interface VettedCombination {
	agentId: RuntimeAgentId;
	providerId: string | null;
	modelId: string | null;
	status: "vetted" | "provisional";
}

/** The registry's combinations a workspace may route `role` work to; null when its kit routes nothing. Pure. */
export function listAllowedCombinations(
	config: PipelineConfig,
	workspaceId: string,
	kitName: string,
	role: VettingRole,
): VettedCombination[] | null {
	if (kitName === DEFAULT_KIT_NAME) {
		return null;
	}
	const vetting = getWorkspaceRoutingVetting(config, workspaceId);
	return vetting.registry.entries.flatMap((entry): VettedCombination[] => {
		const status = getEntryRoleStatus(entry, role);
		const allowed = status === "vetted" || (status === "provisional" && vetting.allowProvisional);
		return allowed ? [{ agentId: entry.agent, providerId: entry.provider, modelId: entry.model, status }] : [];
	});
}

export async function listWorkspaceVettedCombinations(
	workspaceId: string,
	role: VettingRole,
	options: { configPath?: string; kitsDir?: string } = {},
): Promise<VettedCombination[] | null> {
	const [{ config }, catalog] = await Promise.all([
		readPipelineConfig(options.configPath),
		loadKitCatalog(options.kitsDir),
	]);
	const { kitName } = resolveWorkspaceKit(config, workspaceId, catalog);
	return listAllowedCombinations(config, workspaceId, kitName, role);
}

/** Whether the allowance applies to a workspace (`workspaces.<id>.models.allowProvisional`), for listings. */
export function isProvisionalAllowed(config: PipelineConfig, workspaceId: string): boolean {
	return getWorkspacePipelineSettings(config, workspaceId).models.allowProvisional;
}
