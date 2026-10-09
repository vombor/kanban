// Does the local model server keep a kit's models loaded side by side? A kit like team-local runs its dev, QA and
// fallback models at the same time; Lemonade keeps at most `max_models.llm` LLMs resident (its
// `max_loaded_models` setting, default 1) and evicts the least recently used one for the next request, so with fewer
// slots than models every dev ↔ QA switch reloads a model. Kanban's own limit, `models.providerCapacity.lemonade.
// maxLoadedModels`, serializes work by model and must not be above what Lemonade holds, or cards thrash; below it,
// QA cards wait for nothing. Pure: `kanban doctor` and `kanban kit show` fetch /api/v1/health and print these.
import type { EffectiveModel } from "../core/effective-agent";
import type { KitDocument } from "./kit-schema";
import { answerPlanAssignment, createRoutingPolicy, type EffectiveCard } from "./policy";

export const LEMONADE_PROVIDER = "lemonade";

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
 * The distinct Lemonade models a kit runs at the same time: its dev model, the QA model for it, the fallback a
 * FAIL escalates to, and the plan model. Tier candidates and routes for other dev models are left out: they only
 * run once someone picks them.
 */
export function listKitLocalWorkingSet(kit: KitDocument): string[] {
	const policy = createRoutingPolicy(kit);
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
	const planAnswer = answerPlanAssignment(kit);
	const plan = planAnswer.kind === "plan" ? (planAnswer.model ?? null) : null;
	const models: Array<{ provider?: string | null; model: string } | null> = [
		dev,
		qa.kind === "qa" ? qa.model : null,
		fallback.action === "escalate" && fallback.to !== "orchestrator" ? fallback.to.model : null,
		plan,
	];
	return [...new Set(models.flatMap((model) => (model && model.provider === LEMONADE_PROVIDER ? [model.model] : [])))];
}

/** Both ways to raise Lemonade's resident LLMs: the container's env var (a restart) or the CLI (live, persisted). */
export function formatLemonadeMaxLoadedModelsHint(count: number): string {
	return `run Lemonade with LEMONADE_MAX_LOADED_MODELS=${count} (container image: set the env var, then restart it), otherwise lemonade config set max_loaded_models=${count} (applies live and persists)`;
}

/**
 * `lemonadeMaxLlm`: /api/v1/health `max_models.llm` (-1 = unlimited). `kanbanCapacity`: Kanban's
 * `models.providerCapacity.lemonade.maxLoadedModels` (undefined = no limit).
 */
export function assessLocalResidency(input: {
	kitName: string;
	workingSet: readonly string[];
	lemonadeMaxLlm: number;
	kanbanCapacity: number | undefined;
}): LocalResidencyFinding[] {
	const needed = input.workingSet.length;
	if (needed < 2) {
		return [];
	}
	const models = input.workingSet.join(", ");
	const lemonade = input.lemonadeMaxLlm < 0 ? Number.POSITIVE_INFINITY : input.lemonadeMaxLlm;
	const kanban = input.kanbanCapacity ?? Number.POSITIVE_INFINITY;
	const lemonadeText = input.lemonadeMaxLlm < 0 ? "unlimited" : String(input.lemonadeMaxLlm);
	const findings: LocalResidencyFinding[] = [];
	if (lemonade < needed) {
		const serialized = Math.min(kanban, lemonade);
		findings.push({
			level: "warn",
			message: `kit ${input.kitName} runs ${needed} local models at once (${models}), but Lemonade keeps ${lemonadeText} LLM(s) loaded (max_models.llm): it evicts one for the other on every switch${
				kanban <= lemonade
					? `. Until it holds ${needed}, Kanban runs at most ${serialized} model(s) at a time (models.providerCapacity.lemonade.maxLoadedModels): a QA card waits until no dev card runs on another model, and each switch still reloads a model (seconds to minutes per load)`
					: ""
			}`,
			hint: formatLemonadeMaxLoadedModelsHint(needed),
		});
	}
	if (kanban > lemonade) {
		findings.push({
			level: "warn",
			message: `Kanban lets ${input.kanbanCapacity ?? "any number of"} Lemonade model(s) run at once (models.providerCapacity.lemonade.maxLoadedModels) but Lemonade keeps ${lemonadeText}: cards on different models make it reload on every request`,
			hint: `set models.providerCapacity.lemonade.maxLoadedModels to ${lemonadeText} in config.json, or raise Lemonade's limit`,
		});
	} else if (kanban < needed && lemonade >= needed) {
		findings.push({
			level: "warn",
			message: `Lemonade keeps ${lemonadeText} LLM(s) loaded, enough for kit ${input.kitName}'s ${needed} local models, but Kanban still runs at most ${kanban} at a time (models.providerCapacity.lemonade.maxLoadedModels): QA cards wait for dev cards for nothing`,
			hint: `set models.providerCapacity.lemonade.maxLoadedModels to ${needed} in config.json`,
		});
	}
	if (findings.length === 0) {
		findings.push({
			level: "pass",
			message: `Lemonade keeps ${lemonadeText} LLM(s) loaded and Kanban allows ${input.kanbanCapacity ?? "any number"}: kit ${input.kitName}'s ${needed} local models (${models}) stay resident side by side`,
		});
	}
	return findings;
}
