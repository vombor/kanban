// The one rule for which agent + provider + model combinations a project may route work to (docs/team/MODELS.md):
// only combinations the vetted model registry (src/models/vetted-registry.ts) has vetted for the role, or provisional
// ones where the user allowed provisional combinations for that workspace (`workspaces.<id>.models.allowProvisional`).
// Rejected and unknown combinations are refused with the reason and the `kanban models vet` command to run.
//
// Every routing answer goes through here: the routing policy (devAssignment, the QA gate's qaPolicy, the fallback
// escalation and outage takeover, runoffs; src/kits/policy.ts) and answerPlanAssignment, `kanban kit apply` and
// `kanban kit set` (a kit default or a project's role model must be allowed), `kanban bench calibrate` and
// `kanban bench runoff create`, and a card's explicit agent/model (refused from an agent session, a warning for the
// user: src/kits/card-routing-check.ts). Doctor lists every workspace's routing against it.
import { getWorkspacePipelineSettings, type PipelineConfig } from "../config/pipeline-config";
import type { RuntimeAgentId } from "../core/api-contract";
import {
	describeCombination,
	getVettedRegistry,
	lookupVetting,
	type ModelCombination,
	type RegistryVerdict,
	type VettedRegistry,
	type VettingRole,
} from "../models/vetted-registry";
import { resolveKitRole } from "./kit-roles";
import type { CardRole, KitDocument, KitRoleName } from "./kit-schema";

export interface RoutingVetting {
	registry: VettedRegistry;
	/** The user allowed provisional combinations for this workspace. */
	allowProvisional: boolean;
}

/** The workspace's vetting rule: the bundled registry, and the user's provisional switch for the workspace. */
export function getWorkspaceRoutingVetting(
	config: PipelineConfig,
	workspaceId: string,
	registry: VettedRegistry = getVettedRegistry(),
): RoutingVetting {
	return { registry, allowProvisional: getWorkspacePipelineSettings(config, workspaceId).models.allowProvisional };
}

/** Without a workspace: the bundled registry, provisional combinations refused. */
export function getStrictRoutingVetting(registry: VettedRegistry = getVettedRegistry()): RoutingVetting {
	return { registry, allowProvisional: false };
}

/** The registry role a kit role or card role is vetted as; null for cards that do no project work (calibration...). */
export function toVettingRole(role: KitRoleName | CardRole): VettingRole | null {
	switch (role) {
		case "dev":
		case "fallback":
			return "dev";
		case "qa":
			return "qa";
		case "plan":
			return "plan";
		default:
			return null;
	}
}

export function formatVetCommand(combination: ModelCombination, role: VettingRole): string {
	return [
		"kanban models vet",
		`--agent ${combination.agentId}`,
		combination.provider ? `--provider ${combination.provider}` : null,
		combination.model ? `--model ${combination.model}` : null,
		`--role ${role}`,
	]
		.filter((part): part is string => part !== null)
		.join(" ");
}

export type RoutingCheck =
	| { ok: true; verdict: RegistryVerdict }
	| { ok: false; verdict: RegistryVerdict; message: string; vetCommand: string };

/** Whether `combination` may do `role` work under `vetting`. */
export function checkRouting(vetting: RoutingVetting, role: VettingRole, combination: ModelCombination): RoutingCheck {
	const verdict = lookupVetting(vetting.registry, combination, role);
	const vetCommand = formatVetCommand(combination, role);
	const what = describeCombination(combination);
	switch (verdict.status) {
		case "vetted":
			return { ok: true, verdict };
		case "provisional":
			return vetting.allowProvisional
				? { ok: true, verdict }
				: {
						ok: false,
						verdict,
						vetCommand,
						message: `${what} is only provisional for ${role} work in the vetted model registry (${verdict.vetting?.evidence.summary ?? "not vetted yet"}); vet it (${vetCommand}) or have the user allow provisional combinations for the project (kanban models allow-provisional --project <project>)`,
					};
		case "rejected":
			return {
				ok: false,
				verdict,
				vetCommand,
				message: `${what} is rejected for ${role} work in the vetted model registry: ${verdict.reason ?? "no reason recorded"}`,
			};
		default:
			return {
				ok: false,
				verdict,
				vetCommand,
				message: `${what} is not vetted for ${role} work (the vetted model registry has no entry for it); run ${vetCommand}, then commit its proposed entry to models/vetted.json in the Kanban repo`,
			};
	}
}

/** One combination a kit routes work to. */
export interface KitRoute {
	/** Where in the kit: `roles.dev`, `qa.routes[0]`, `onFail.runoff.models[1]`, ... */
	label: string;
	role: VettingRole;
	combination: ModelCombination;
}

function toCombination(agentId: RuntimeAgentId, model: { provider: string | null; model: string } | null) {
	return { agentId, provider: model?.provider ?? null, model: model?.model ?? null };
}

/**
 * Every combination a resolved kit routes work to. A role without an agent runs on the agent selected in Kanban
 * settings (dev, plan) or the card's own (fallback): Kanban routes nothing there, so it isn't listed.
 */
export function listKitRoutes(kit: KitDocument): KitRoute[] {
	const routes: KitRoute[] = [];
	const dev = resolveKitRole(kit, "dev");
	if (dev?.agentId) {
		routes.push({ label: "roles.dev", role: "dev", combination: toCombination(dev.agentId, dev.model) });
	}
	if (kit.qa?.enabled === true) {
		const qa = resolveKitRole(kit, "qa");
		if (qa?.agentId) {
			routes.push({ label: "roles.qa", role: "qa", combination: toCombination(qa.agentId, qa.model) });
		}
		(kit.qa.routes ?? []).forEach((route, index) => {
			routes.push({
				label: `qa.routes[${index}]`,
				role: "qa",
				combination: toCombination(
					route.agent,
					route.model ? { provider: route.provider ?? null, model: route.model } : null,
				),
			});
		});
	}
	if (kit.plan?.enabled === true) {
		const plan = resolveKitRole(kit, "plan");
		if (plan?.agentId) {
			routes.push({ label: "roles.plan", role: "plan", combination: toCombination(plan.agentId, plan.model) });
		}
	}
	const fallback = resolveKitRole(kit, "fallback");
	const fallbackAgent = fallback?.agentId ?? dev?.agentId ?? null;
	if (fallback?.model && fallbackAgent) {
		routes.push({ label: "roles.fallback", role: "dev", combination: toCombination(fallbackAgent, fallback.model) });
	}
	(kit.onFail?.runoff?.models ?? []).forEach((model, index) => {
		routes.push({
			label: `onFail.runoff.models[${index}]`,
			role: "dev",
			combination: { agentId: model.agent, provider: model.provider ?? null, model: model.model },
		});
	});
	return routes;
}

export interface KitRouteCheck extends KitRoute {
	check: RoutingCheck;
}

export function checkKitRoutes(kit: KitDocument, vetting: RoutingVetting): KitRouteCheck[] {
	return listKitRoutes(kit).map((route) => ({
		...route,
		check: checkRouting(vetting, route.role, route.combination),
	}));
}

/** The refused routes of a kit, as one message per route (empty when every route is allowed). */
export function describeRefusedKitRoutes(kit: KitDocument, vetting: RoutingVetting, labels?: string[]): string[] {
	return checkKitRoutes(kit, vetting).flatMap((route) =>
		route.check.ok || (labels && !labels.includes(route.label)) ? [] : [`${route.label}: ${route.check.message}`],
	);
}
