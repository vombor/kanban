// Does a local model server keep a kit's models loaded side by side? A kit like team-local runs its dev, QA and
// fallback models at the same time; each local provider keeps only so many resident and evicts the least recently
// used one for the next request, so with fewer slots than models every dev ↔ QA switch reloads a model:
//   - Lemonade: `max_models.llm` of /api/v1/health (its `max_loaded_models` setting, default 1);
//   - LocalAI: `max_active_backends` of /api/settings (0 = unlimited, its default; `single_backend` = 1).
// Kanban's own limit, `models.providerCapacity.<provider>.maxLoadedModels`, serializes work by model and must not be
// above what the server holds, or cards thrash; below it, QA cards wait for nothing. Pure: `kanban doctor` and
// `kanban kit show` ask the server (src/models/local-provider-limits.ts) and print these.
import type { EffectiveModel } from "../core/effective-agent";
import { getVettedRegistry } from "../models/vetted-registry";
import type { KitDocument } from "./kit-schema";
import { answerPlanAssignment, createRoutingPolicy, type EffectiveCard } from "./policy";

export const LEMONADE_PROVIDER = "lemonade";
export const LOCALAI_PROVIDER = "localai";

/** What each local provider calls its limit, and how the user raises it. */
const PROVIDER_FACTS: Record<string, { name: string; field: string; hint: (count: number) => string }> = {
	[LEMONADE_PROVIDER]: {
		name: "Lemonade",
		field: "max_models.llm",
		hint: (count) => formatLemonadeMaxLoadedModelsHint(count),
	},
	[LOCALAI_PROVIDER]: {
		name: "LocalAI",
		field: "max_active_backends",
		hint: (count) =>
			`run LocalAI with LOCALAI_MAX_ACTIVE_BACKENDS=${count} (or --max-active-backends ${count}; and without LOCALAI_SINGLE_ACTIVE_BACKEND), then restart it`,
	},
};

function providerFacts(provider: string): { name: string; field: string; hint: (count: number) => string } {
	return (
		PROVIDER_FACTS[provider] ?? {
			name: provider,
			field: "its loaded-model limit",
			hint: (count) => `let ${provider} keep ${count} models loaded`,
		}
	);
}

export interface LocalResidencyFinding {
	level: "pass" | "warn";
	message: string;
	hint?: string;
}

function sampleCard(model: EffectiveModel | null): EffectiveCard {
	return {
		card: { id: "sample", title: "", prompt: "", startInPlanMode: false, baseRef: "", createdAt: 0, updatedAt: 0 },
		workspaceId: "sample",
		role: "dev",
		agentId: "cline",
		model,
	};
}

/**
 * The distinct models on `provider` (default Lemonade) a kit runs at the same time: its dev model, the QA model for it, the fallback a
 * FAIL escalates to, and the plan model. Tier candidates and routes for other dev models are left out: they only
 * run once someone picks them.
 */
export function listKitLocalWorkingSet(kit: KitDocument, provider: string = LEMONADE_PROVIDER): string[] {
	// The kit as written, provisional models included (local kits are provisional until calibrated); whether a project
	// may use them is the vetting rows' question (src/kits/routing-vetting.ts).
	const vetting = { registry: getVettedRegistry(), allowProvisional: true };
	const policy = createRoutingPolicy(kit, vetting);
	const dev = policy.devAssignment({ workspaceId: "sample", title: "", prompt: "", role: "dev" })?.model ?? null;
	const card = sampleCard(dev);
	const history = { failRounds: [1, 2, 3], reworks: 2, nudges: 0, escalations: 0, handbacks: 0, extraRounds: 0 };
	const qa = policy.qaPolicy({ dev: card, round: 1, history });
	const fallback = policy.onFail({
		dev: card,
		cause: "stalled",
		verdict: null,
		history,
		limits: { maxFailRounds: 3 },
	});
	const planAnswer = answerPlanAssignment(kit, vetting);
	const plan = planAnswer.kind === "plan" ? (planAnswer.model ?? null) : null;
	const models: Array<{ provider?: string | null; model: string } | null> = [
		dev,
		qa.kind === "qa" ? qa.model : null,
		fallback.action === "escalate" && fallback.to !== "orchestrator" ? fallback.to.model : null,
		plan,
	];
	return [...new Set(models.flatMap((model) => (model && model.provider === provider ? [model.model] : [])))];
}

/** Both ways to raise Lemonade's resident LLMs: the container's env var (a restart) or the CLI (live, persisted). */
export function formatLemonadeMaxLoadedModelsHint(count: number): string {
	return `run Lemonade with LEMONADE_MAX_LOADED_MODELS=${count} (container image: set the env var, then restart it), otherwise lemonade config set max_loaded_models=${count} (applies live and persists)`;
}

/**
 * `providerMaxLoaded`: what the server keeps loaded (Lemonade's `max_models.llm`, LocalAI's `max_active_backends`;
 * -1 = unlimited). `kanbanCapacity`: Kanban's `models.providerCapacity.<provider>.maxLoadedModels` (undefined = no
 * limit). `provider` defaults to Lemonade.
 */
export function assessLocalResidency(input: {
	kitName: string;
	provider?: string;
	workingSet: readonly string[];
	providerMaxLoaded: number;
	kanbanCapacity: number | undefined;
}): LocalResidencyFinding[] {
	const needed = input.workingSet.length;
	if (needed < 2) {
		return [];
	}
	const provider = input.provider ?? LEMONADE_PROVIDER;
	const facts = providerFacts(provider);
	const capacityKey = `models.providerCapacity.${provider}.maxLoadedModels`;
	const models = input.workingSet.join(", ");
	const server = input.providerMaxLoaded < 0 ? Number.POSITIVE_INFINITY : input.providerMaxLoaded;
	const kanban = input.kanbanCapacity ?? Number.POSITIVE_INFINITY;
	const serverText = input.providerMaxLoaded < 0 ? "unlimited" : String(input.providerMaxLoaded);
	const findings: LocalResidencyFinding[] = [];
	if (server < needed) {
		const serialized = Math.min(kanban, server);
		findings.push({
			level: "warn",
			message: `kit ${input.kitName} runs ${needed} local models at once (${models}), but ${facts.name} keeps ${serverText} model(s) loaded (${facts.field}): it evicts one for the other on every switch${
				kanban <= server
					? `. Until it holds ${needed}, Kanban runs at most ${serialized} model(s) at a time (${capacityKey}): a QA card waits until no dev card runs on another model, and each switch still reloads a model (seconds to minutes per load)`
					: ""
			}`,
			hint: facts.hint(needed),
		});
	}
	if (kanban > server) {
		findings.push({
			level: "warn",
			message: `Kanban lets ${input.kanbanCapacity ?? "any number of"} ${facts.name} model(s) run at once (${capacityKey}) but ${facts.name} keeps ${serverText}: cards on different models make it reload on every request`,
			hint: `set ${capacityKey} to ${serverText} in config.json, or raise ${facts.name}'s limit`,
		});
	} else if (kanban < needed && server >= needed) {
		findings.push({
			level: "warn",
			message: `${facts.name} keeps ${serverText} model(s) loaded, enough for kit ${input.kitName}'s ${needed} local models, but Kanban still runs at most ${kanban} at a time (${capacityKey}): QA cards wait for dev cards for nothing`,
			hint: `set ${capacityKey} to ${needed} in config.json`,
		});
	}
	if (findings.length === 0) {
		findings.push({
			level: "pass",
			message: `${facts.name} keeps ${serverText} model(s) loaded and Kanban allows ${input.kanbanCapacity ?? "any number"}: kit ${input.kitName}'s ${needed} local models (${models}) stay resident side by side`,
		});
	}
	return findings;
}
