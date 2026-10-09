// The routing questions the core asks a project's kit (plan §4.0), and the one evaluator that answers them from
// resolved kit data. Pure: no I/O, no clock. Nothing is a plugin: a kit is data, and the team kit's features
// (src/kits/team/, later) only add behaviour on events, they don't answer these questions.
//
// Callers so far: `kanban kit show`, and card creation for `devAssignment` (src/kits/dev-assignment.ts). The
// pipeline asks the other questions from P4-1 on.
import type { RuntimeAgentId, RuntimeBoardCard } from "../core/api-contract";
import type { EffectiveModel } from "../core/effective-agent";
import type { CardRole, KitDocument } from "./kit-schema";
import { lookupTierModel, resolveKitModelRef } from "./tier-lookup";

export interface EffectiveCard {
	card: RuntimeBoardCard;
	workspaceId: string;
	role: CardRole;
	/** resolveEffectiveAgent(): never the literal card.agentId. */
	agentId: RuntimeAgentId;
	/** resolveEffectiveModel(). */
	model: EffectiveModel | null;
}

export interface CardHistory {
	/** Rounds that ended in FAIL (or a land conflict), including the one being handled. */
	failRounds: number[];
	reworks: number;
	nudges: number;
	escalations: number;
	handbacks: number;
	/** Extra FAIL rounds granted by handbacks. */
	extraRounds: number;
}

export interface KitVerdict {
	verdict: "PASS" | "FAIL" | "STALLED";
	round: number;
	blocking?: string[];
	notes?: string;
}

export interface QaPromptNotes {
	screenshotFallback: string;
	knownBaseIssues: string;
	dbSetup: string;
}

export interface QaPromptParts {
	/** Rule texts from `qa.rules`, in route order. `{outbox}` is filled in by the QA prompt skeleton. */
	rules: string[];
	blurb: string;
	notes: QaPromptNotes;
	serversScript: string | null;
}

export type DevAssignmentAnswer = { agentId: RuntimeAgentId; model?: EffectiveModel; tier?: string } | null;

/**
 * A plan card's routing (`plan` section). `disabled` = the kit makes no plan cards: its dev agent does its own
 * planning. `agentId` null = the agent selected in Kanban settings; no `model` = that agent's own default.
 */
export type PlanAssignmentAnswer =
	| { kind: "disabled"; reason: string }
	| {
			kind: "plan";
			agentId: RuntimeAgentId | null;
			model?: EffectiveModel;
			tier?: string;
			startInPlanMode: boolean;
			/** `plan.rules` texts, in key order, added to the plan prompt. */
			rules: string[];
	  };

export type QaPolicyAnswer =
	| { kind: "none"; reason: string }
	| {
			kind: "qa";
			agentId: RuntimeAgentId;
			model: EffectiveModel | null;
			/** `qa.routes[<i>]`, or null for `qa.default`. */
			route: string | null;
			promptParts: QaPromptParts;
	  };

export type FailCause = "fail" | "conflict" | "stalled" | "unchanged";

export type EscalationTarget = "orchestrator" | { agentId: RuntimeAgentId; model: EffectiveModel };

export type OnFailAnswer =
	| { action: "rework"; clearContext: "auto" | "always" | "never" }
	| { action: "escalate"; to: EscalationTarget; requireApproval: boolean; reason: string }
	| { action: "runoff"; models: Array<{ agentId: RuntimeAgentId; provider: string | null; model: string }> }
	| { action: "stop"; reason: string };

export type OnPassAnswer = { action: "land" } | { action: "hold"; group: string };

/** While recovery holds a dev card for a provider outage: keep holding, or hand the task to another model now. */
export type OnOutageAnswer =
	| { action: "hold"; reason: string }
	| {
			action: "escalate";
			to: Exclude<EscalationTarget, "orchestrator">;
			requireApproval: boolean;
			reason: string;
	  };

export interface RoutingPolicy {
	/** At card creation, only when the creator set no agent/model. null = leave it (the card runs on the selected agent). */
	devAssignment(input: { workspaceId: string; title: string; prompt: string; role: "dev" }): DevAssignmentAnswer;
	/** When a dev card is submitted (Review with work, landing mode qa). */
	qaPolicy(input: { dev: EffectiveCard; round: number; history: CardHistory }): QaPolicyAnswer;
	/** After a FAIL verdict, a merge conflict at land, STALLED/DNF, or a rework that came back unchanged. */
	onFail(input: {
		dev: EffectiveCard;
		cause: FailCause;
		verdict: KitVerdict | null;
		history: CardHistory;
		limits: { maxFailRounds: number };
	}): OnFailAnswer;
	/** After a PASS, before land. Only the team `runoffs` feature answers "hold". */
	onPass(input: { dev: EffectiveCard; verdict: KitVerdict }): OnPassAnswer;
	/**
	 * While recovery holds a dev card for a provider outage (`heldMin` so far; recovery gives up at `maxMin`).
	 * "escalate": the rework loop hands the task to that model now.
	 */
	onOutage(input: { dev: EffectiveCard; heldMin: number; maxMin: number }): OnOutageAnswer;
}

/**
 * Whether an escalation target is the model the card already runs on, where a takeover changes nothing (the same
 * outage, the same FAILs). Providers count only when both sides name one: a model id on another provider is another
 * model, and a model without a provider matches either.
 */
export function isSameEscalationModel(current: EffectiveModel | null, target: EffectiveModel): boolean {
	if (!current || current.model.trim() !== target.model.trim()) {
		return false;
	}
	return !current.provider || !target.provider || current.provider === target.provider;
}

const BEDROCK_REGION_PREFIX = /^(?:us|eu|apac|ap|jp|au|ca|us-gov|global)\./u;

/**
 * Bare model family names → vendor, named like the Bedrock vendor prefixes (`qwen.`, `deepseek.`, `mistral.`,
 * `google.`, `zai.`) so a local and a Bedrock model of one family count as one vendor. `lmx-omni` is Lemonade's
 * collection whose LLM is Qwen3.6-35B-A3B (its `components` in Lemonade's /models).
 */
const LOCAL_MODEL_FAMILIES: ReadonlyArray<{ pattern: RegExp; vendor: string }> = [
	{ pattern: /^(?:qwen|qwq|lmx-omni)/u, vendor: "qwen" },
	{ pattern: /^deepseek/u, vendor: "deepseek" },
	{ pattern: /^(?:devstral|mistral|codestral|magistral|ministral|mixtral)/u, vendor: "mistral" },
	{ pattern: /^(?:gemma|codegemma)/u, vendor: "google" },
	{ pattern: /^glm/u, vendor: "zai" },
	{ pattern: /^(?:llama|meta-llama)/u, vendor: "meta" },
	{ pattern: /^(?:phi-|phi\d)/u, vendor: "microsoft" },
	{ pattern: /^(?:gpt-oss)/u, vendor: "openai" },
];

/**
 * The vendor of a model id, for the "QA vendor differs from dev vendor" rule (user 2026-10-06): a few
 * well-known bare prefixes (`gpt-`, `claude`, …), else the Bedrock-style `<vendor>.<model>` prefix after an optional
 * region prefix (`us.openai.gpt-6.1-sol` → `openai`). Null when it can't tell.
 */
export function getModelVendor(model: string | null | undefined): string | null {
	const id = model?.trim().toLowerCase().replace(BEDROCK_REGION_PREFIX, "");
	if (!id) {
		return null;
	}
	// Bare names first: "gpt-6.1-sol" has a dot too.
	if (/^(?:gpt-|o\d|codex)/u.test(id)) {
		return "openai";
	}
	if (id.startsWith("claude")) {
		return "anthropic";
	}
	if (id.startsWith("gemini")) {
		return "google";
	}
	// Local (Lemonade/GGUF) ids are bare family names with dots in their version ("GLM-4.7-Flash-GGUF",
	// "Qwen3.6-35B-A3B-MTP-GGUF"), so the Bedrock-style prefix rule below would read "glm-4" or "qwen3".
	const family = LOCAL_MODEL_FAMILIES.find(({ pattern }) => pattern.test(id));
	if (family) {
		return family.vendor;
	}
	return /^([a-z0-9-]+)\./u.exec(id)?.[1] ?? null;
}

function failRoundCap(kit: KitDocument, history: CardHistory, limits: { maxFailRounds: number }): number {
	const kitRounds = kit.onFail?.reworkRounds ?? 0;
	return Math.min(kitRounds, limits.maxFailRounds) + history.extraRounds;
}

/** The QA prompt parts of a kit: its project blurb, notes and servers script, plus the named `qa.rules` texts. */
export function getPromptParts(kit: KitDocument, ruleNames: string[]): QaPromptParts {
	const rules = kit.qa?.rules ?? {};
	return {
		rules: ruleNames.flatMap((name) => (Object.hasOwn(rules, name) ? [rules[name] as string] : [])),
		blurb: kit.qa?.blurb ?? "",
		notes: {
			screenshotFallback: kit.qa?.promptNotes?.screenshotFallback ?? "",
			knownBaseIssues: kit.qa?.promptNotes?.knownBaseIssues ?? "",
			dbSetup: kit.qa?.promptNotes?.dbSetup ?? "",
		},
		serversScript: kit.qa?.serversScript ?? null,
	};
}

/**
 * The plan question, asked only at plan card creation (`kanban task create --role plan`, src/kits/plan-assignment.ts),
 * never by the pipeline: plan cards are never QA'd, reworked or landed on a PASS.
 */
export function answerPlanAssignment(kit: KitDocument): PlanAssignmentAnswer {
	const plan = kit.plan;
	if (plan?.enabled !== true) {
		return { kind: "disabled", reason: `kit "${kit.name}" has plan.enabled off` };
	}
	const base = {
		kind: "plan" as const,
		agentId: plan.agent ?? null,
		startInPlanMode: plan.startInPlanMode ?? false,
		rules: Object.values(plan.rules ?? {}),
	};
	if (!plan.model) {
		return base;
	}
	const resolved = resolveKitModelRef(kit, plan.model);
	// The resolver refuses a kit whose tier has no usable model, so this is only a guard.
	if (!resolved.ok) {
		return base;
	}
	return { ...base, model: resolved.choice, ...(resolved.tier ? { tier: resolved.tier } : {}) };
}

/** The evaluator for one resolved kit. `kit` must already be resolved (override > kit > default) and validated. */
export function createRoutingPolicy(kit: KitDocument): RoutingPolicy {
	const escalate = (dev: EffectiveCard, reason: string): OnFailAnswer => {
		const requireApproval = kit.escalate?.requireApproval ?? false;
		const to = kit.escalate?.to ?? "orchestrator";
		if (to === "orchestrator") {
			return { action: "escalate", to, requireApproval, reason };
		}
		if ("tier" in to) {
			// Escalating to a senior tier is the team kit's `tiers` feature (plan §3.2, P4-T3): without it in
			// `features`, the card goes to the orchestrator as for `"orchestrator"`.
			if (!(kit.features ?? []).includes("tiers")) {
				return {
					action: "escalate",
					to: "orchestrator",
					requireApproval,
					reason: `${reason}; escalate.to.tier needs the "tiers" feature in the kit's features`,
				};
			}
			const lookup = lookupTierModel(kit, to.tier);
			if (!lookup.ok) {
				return { action: "escalate", to: "orchestrator", requireApproval, reason: `${reason}; ${lookup.error}` };
			}
			// A senior tier runs on the kit's dev agent, else on the agent the card ran on.
			return {
				action: "escalate",
				to: { agentId: kit.dev?.agent ?? dev.agentId, model: lookup.choice },
				requireApproval,
				reason,
			};
		}
		return {
			action: "escalate",
			to: { agentId: to.agent, model: { provider: to.provider ?? null, model: to.model } },
			requireApproval,
			reason,
		};
	};

	const afterRounds = (dev: EffectiveCard, reason: string): OnFailAnswer =>
		(kit.onFail?.then ?? "stop") === "escalate" ? escalate(dev, reason) : { action: "stop", reason };

	return {
		devAssignment() {
			const agentId = kit.dev?.agent;
			if (!agentId) {
				return null;
			}
			if (!kit.dev?.model) {
				return { agentId };
			}
			const resolved = resolveKitModelRef(kit, kit.dev.model);
			// The resolver refuses a kit whose tier has no usable model, so this is only a guard.
			if (!resolved.ok) {
				return { agentId };
			}
			return { agentId, model: resolved.choice, ...(resolved.tier ? { tier: resolved.tier } : {}) };
		},

		qaPolicy({ dev }) {
			if (dev.role !== "dev") {
				return { kind: "none", reason: `${dev.role} cards are never QA'd` };
			}
			if (kit.qa?.enabled !== true) {
				return { kind: "none", reason: `kit "${kit.name}" has qa.enabled off` };
			}
			if (kit.qa.skip?.roles?.includes(dev.role)) {
				return { kind: "none", reason: `kit "${kit.name}" skips QA for role ${dev.role}` };
			}
			if (kit.qa.skip?.effectiveAgents?.includes(dev.agentId)) {
				return { kind: "none", reason: `kit "${kit.name}" skips QA for cards on ${dev.agentId}` };
			}
			// Ported from archive/devteam-kit:lib/qa-route.cjs@ef523b20: the first route whose devModel regex matches
			// the dev card's model wins; no model or no match = the default QA agent with its own model config.
			const devModel = dev.model?.model ?? null;
			const routes = kit.qa.routes ?? [];
			const routeIndex = devModel ? routes.findIndex((route) => new RegExp(route.devModel).test(devModel)) : -1;
			const route = routeIndex >= 0 ? routes[routeIndex] : undefined;
			const target = route ?? kit.qa.default;
			if (!target) {
				return {
					kind: "none",
					reason: `kit "${kit.name}" has no QA route for ${devModel ?? "this card"} and no qa.default`,
				};
			}
			const qaModel: EffectiveModel | null = target.model
				? { provider: target.provider ?? null, model: target.model }
				: null;
			const routeName = route ? `qa.routes[${routeIndex}]` : null;
			if (kit.qa.requireDifferentVendor === true) {
				const devVendor = getModelVendor(devModel);
				const qaVendor = getModelVendor(qaModel?.model);
				if (devVendor && qaVendor && devVendor === qaVendor) {
					return {
						kind: "none",
						reason: `refused: ${routeName ?? "qa.default"} QA model ${qaModel?.model} is from the dev card's vendor (${devVendor}) and the kit requires a different vendor`,
					};
				}
			}
			return {
				kind: "qa",
				agentId: target.agent,
				model: qaModel,
				route: routeName,
				promptParts: getPromptParts(kit, route?.rules ?? []),
			};
		},

		onFail({ dev, cause, history, limits }) {
			const fails = history.failRounds.length;
			const cap = failRoundCap(kit, history, limits);
			if (cause === "stalled" || cause === "unchanged") {
				return afterRounds(dev, cause === "stalled" ? "QA stalled" : "the rework came back unchanged");
			}
			if (cause === "conflict" && (kit.onFail?.conflict ?? "stop") === "stop") {
				return { action: "stop", reason: "merge conflict at land; the kit does not rework conflicts" };
			}
			const reworks = cause === "conflict" || (kit.onFail?.rework ?? "none") === "same-model";
			if (!reworks) {
				return afterRounds(dev, `FAIL in round ${fails}; the kit does not rework`);
			}
			if (fails >= cap) {
				return afterRounds(dev, `${fails} failed QA rounds (limit ${cap})`);
			}
			const runoff = cause === "fail" ? kit.onFail?.runoff : null;
			if (runoff) {
				return {
					action: "runoff",
					models: runoff.models.map((model) => ({
						agentId: model.agent,
						provider: model.provider ?? null,
						model: model.model,
					})),
				};
			}
			return { action: "rework", clearContext: "auto" };
		},

		onPass() {
			return { action: "land" };
		},

		onOutage({ dev, heldMin, maxMin }) {
			if ((kit.onOutage?.then ?? "orchestrator") !== "escalate") {
				return { action: "hold", reason: "the kit waits out outages (onOutage.then: orchestrator)" };
			}
			const afterMin = kit.onOutage?.afterMin ?? maxMin;
			if (heldMin < afterMin) {
				return { action: "hold", reason: `the kit hands the card over after ${afterMin} min of outage` };
			}
			const reason = `provider outage on ${dev.model?.model ?? "its model"} for ${Math.floor(heldMin)} min`;
			const answer = escalate(dev, reason);
			// Nothing to take it over: the hold runs to maxMin and goes to the orchestrator, as without the key.
			if (answer.action !== "escalate" || answer.to === "orchestrator") {
				return {
					action: "hold",
					reason: "onOutage.then is escalate, but escalate.to resolves to the orchestrator",
				};
			}
			if (isSameEscalationModel(dev.model, answer.to.model)) {
				return {
					action: "hold",
					reason: `escalate.to is ${answer.to.model.model}, the model the card already runs on`,
				};
			}
			return { action: "escalate", to: answer.to, requireApproval: answer.requireApproval, reason };
		},
	};
}
