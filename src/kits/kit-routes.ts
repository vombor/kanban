// Every agent + provider + model combination a resolved kit routes work to: its roles, QA routes, the fallback and
// the runoff models. Kanban refuses none of them (any model may be on any role, docs/team/MODELS.md); doctor reads
// this list to warn about a Cline model its provider's models.json record doesn't have
// (src/doctor/cline-models-allow-list-checks.ts).
import type { RuntimeAgentId } from "../core/api-contract";
import type { ModelCombination } from "../models/model-combination";
import { resolveKitRole } from "./kit-roles";
import type { KitDocument } from "./kit-schema";

/** One combination a kit routes work to. */
export interface KitRoute {
	/** Where in the kit: `roles.dev`, `qa.routes[0]`, `onFail.runoff.models[1]`, ... */
	label: string;
	combination: ModelCombination;
}

function toCombination(
	agentId: RuntimeAgentId,
	model: { provider: string | null; model: string } | null,
): ModelCombination {
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
		routes.push({ label: "roles.dev", combination: toCombination(dev.agentId, dev.model) });
	}
	if (kit.qa?.enabled === true) {
		const qa = resolveKitRole(kit, "qa");
		if (qa?.agentId) {
			routes.push({ label: "roles.qa", combination: toCombination(qa.agentId, qa.model) });
		}
		(kit.qa.routes ?? []).forEach((route, index) => {
			routes.push({
				label: `qa.routes[${index}]`,
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
			routes.push({ label: "roles.plan", combination: toCombination(plan.agentId, plan.model) });
		}
	}
	const fallback = resolveKitRole(kit, "fallback");
	const fallbackAgent = fallback?.agentId ?? dev?.agentId ?? null;
	if (fallback?.model && fallbackAgent) {
		routes.push({ label: "roles.fallback", combination: toCombination(fallbackAgent, fallback.model) });
	}
	(kit.onFail?.runoff?.models ?? []).forEach((model, index) => {
		routes.push({
			label: `onFail.runoff.models[${index}]`,
			combination: { agentId: model.agent, provider: model.provider ?? null, model: model.model },
		});
	});
	return routes;
}
