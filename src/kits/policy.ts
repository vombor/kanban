// The routing questions the core asks a project's kit (plan §4.0), and the one evaluator that answers them from
// resolved kit data. Pure: no I/O, no clock. Nothing is a plugin: a kit is data, and the team kit's features
// (src/kits/team/, later) only add behaviour on events, they don't answer these questions.
//
// Callers so far: `kanban kit show`, and card creation for `devAssignment` (src/kits/dev-assignment.ts). The
// pipeline asks the other questions from P4-1 on.
import type { RuntimeAgentId, RuntimeBoardCard } from "../core/api-contract";
import type { EffectiveModel } from "../core/effective-agent";
import { getKitFallbackFlow, resolveKitRole } from "./kit-roles";
import type { CardRole, KitDocument, KitFallbackTrigger } from "./kit-schema";
import { checkRouting, getStrictRoutingVetting, type RoutingVetting } from "./routing-vetting";

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

/**
 * `refused`: the kit's dev role names a combination the vetted model registry doesn't allow for dev work
 * (src/kits/routing-vetting.ts); the proposal must not be applied.
 */
export type DevAssignmentAnswer = {
	agentId: RuntimeAgentId;
	model?: EffectiveModel;
	tier?: string;
	refused?: string;
} | null;

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
			/** The vetted model registry doesn't allow the plan role's combination (src/kits/routing-vetting.ts). */
			refused?: string;
	  };

export type QaPolicyAnswer =
	| { kind: "none"; reason: string }
	| {
			kind: "qa";
			agentId: RuntimeAgentId;
			model: EffectiveModel | null;
			/** `qa.routes[<i>]`, or null for `roles.qa`. */
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
export function answerPlanAssignment(
	kit: KitDocument,
	vetting: RoutingVetting = getStrictRoutingVetting(),
): PlanAssignmentAnswer {
	const plan = kit.plan;
	if (plan?.enabled !== true) {
		return { kind: "disabled", reason: `kit "${kit.name}" has plan.enabled off` };
	}
	const role = resolveKitRole(kit, "plan");
	const base = {
		kind: "plan" as const,
		agentId: role?.agentId ?? null,
		startInPlanMode: plan.startInPlanMode ?? false,
		rules: Object.values(plan.rules ?? {}),
	};
	const refused = role?.agentId ? refusalOf(vetting, "plan", role.agentId, role.model) : null;
	const vettingNote = refused ? { refused } : {};
	// No model, or (only a guard: the resolver refuses it) a tier without a usable model.
	if (!role?.model) {
		return { ...base, ...vettingNote };
	}
	return { ...base, model: role.model, ...(role.tier ? { tier: role.tier } : {}), ...vettingNote };
}

/** The vetted model registry's refusal of a routing answer, or null when it is allowed. */
function refusalOf(
	vetting: RoutingVetting,
	role: "dev" | "qa" | "plan",
	agentId: RuntimeAgentId,
	model: EffectiveModel | null | undefined,
): string | null {
	const check = checkRouting(vetting, role, {
		agentId,
		provider: model?.provider ?? null,
		model: model?.model ?? null,
	});
	return check.ok ? null : check.message;
}

/**
 * The evaluator for one resolved kit. `kit` must already be resolved (override > kit > default) and validated.
 * Every answer that names an agent and model is checked against the vetted model registry (`vetting`, the
 * workspace's: getWorkspaceRoutingVetting): a refused one becomes "no QA", "to the orchestrator" or a refused dev
 * assignment, with the reason.
 */
export function createRoutingPolicy(
	kit: KitDocument,
	vetting: RoutingVetting = getStrictRoutingVetting(),
): RoutingPolicy {
	const fallbackFlow = getKitFallbackFlow(kit);

	/**
	 * Where a card goes when `trigger` fires: the fallback role when the kit hands that trigger to it, else the
	 * orchestrator. The core still refuses a fallback onto the card's own model, by a fallback sibling or by a runoff
	 * racer (src/pipeline/rework.ts `refuseTakeover`).
	 */
	const escalate = (dev: EffectiveCard, reason: string, trigger: KitFallbackTrigger): OnFailAnswer => {
		const toOrchestrator = (why: string | null): OnFailAnswer => ({
			action: "escalate",
			to: "orchestrator",
			requireApproval: false,
			reason: why ? `${reason}; ${why}` : reason,
		});
		if (!fallbackFlow.triggers[trigger]) {
			return toOrchestrator(null);
		}
		const role = fallbackFlow.role;
		if (!role) {
			return toOrchestrator("the kit has no fallback role");
		}
		// Falling back onto a tier is the team kit's `tiers` feature (plan §3.2, P4-T3): without it in `features`, the
		// card goes to the orchestrator.
		if (role.tier && !(kit.features ?? []).includes("tiers")) {
			return toOrchestrator(`roles.fallback.tier needs the "tiers" feature in the kit's features`);
		}
		if (role.error) {
			return toOrchestrator(role.error);
		}
		if (!role.model) {
			return toOrchestrator("roles.fallback names no model");
		}
		// A fallback without its own agent runs on the dev role's agent, else on the agent the card ran on.
		const agentId = role.agentId ?? resolveKitRole(kit, "dev")?.agentId ?? dev.agentId;
		const refused = refusalOf(vetting, "dev", agentId, role.model);
		if (refused) {
			return toOrchestrator(`the fallback is refused: ${refused}`);
		}
		return {
			action: "escalate",
			to: { agentId, model: role.model },
			requireApproval: fallbackFlow.requireApproval,
			reason,
		};
	};

	const afterRounds = (dev: EffectiveCard, reason: string, trigger: KitFallbackTrigger): OnFailAnswer =>
		(kit.onFail?.then ?? "stop") === "escalate" ? escalate(dev, reason, trigger) : { action: "stop", reason };

	return {
		devAssignment() {
			const role = resolveKitRole(kit, "dev");
			if (!role?.agentId) {
				return null;
			}
			// No model, or (only a guard: the resolver refuses it) a tier without a usable model.
			const refused = refusalOf(vetting, "dev", role.agentId, role.model);
			const vettingNote = refused ? { refused } : {};
			if (!role.model) {
				return { agentId: role.agentId, ...vettingNote };
			}
			return {
				agentId: role.agentId,
				model: role.model,
				...(role.tier ? { tier: role.tier } : {}),
				...vettingNote,
			};
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
			const qaRole = resolveKitRole(kit, "qa");
			const target = route
				? {
						agent: route.agent,
						model: route.model ? { provider: route.provider ?? null, model: route.model } : null,
					}
				: qaRole?.agentId
					? { agent: qaRole.agentId, model: qaRole.model }
					: null;
			if (!target) {
				return {
					kind: "none",
					reason: `kit "${kit.name}" has no QA route for ${devModel ?? "this card"} and no roles.qa agent`,
				};
			}
			const qaModel: EffectiveModel | null = target.model;
			const routeName = route ? `qa.routes[${routeIndex}]` : null;
			if (kit.qa.requireDifferentVendor === true) {
				const devVendor = getModelVendor(devModel);
				const qaVendor = getModelVendor(qaModel?.model);
				if (devVendor && qaVendor && devVendor === qaVendor) {
					return {
						kind: "none",
						reason: `refused: ${routeName ?? "roles.qa"} QA model ${qaModel?.model} is from the dev card's vendor (${devVendor}) and the kit requires a different vendor`,
					};
				}
			}
			// Not landed either: the card waits in Review with the reason, as for a same-vendor refusal.
			const refused = refusalOf(vetting, "qa", target.agent, qaModel);
			if (refused) {
				return { kind: "none", reason: `refused: ${routeName ?? "roles.qa"}: ${refused}` };
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
				return cause === "stalled"
					? afterRounds(dev, "QA stalled", "qaStalled")
					: afterRounds(dev, "the rework came back unchanged", "unchanged");
			}
			if (cause === "conflict" && (kit.onFail?.conflict ?? "stop") === "stop") {
				return { action: "stop", reason: "merge conflict at land; the kit does not rework conflicts" };
			}
			const reworks = cause === "conflict" || (kit.onFail?.rework ?? "none") === "same-model";
			if (!reworks) {
				return afterRounds(dev, `FAIL in round ${fails}; the kit does not rework`, "qaFails");
			}
			if (fails >= cap) {
				return cause === "conflict"
					? afterRounds(dev, `merge conflict at land after ${fails} rounds (limit ${cap})`, "conflict")
					: afterRounds(dev, `${fails} failed QA rounds (limit ${cap})`, "qaFails");
			}
			const runoff = cause === "fail" ? kit.onFail?.runoff : null;
			if (runoff) {
				const refused = runoff.models.flatMap((model) => {
					const why = refusalOf(vetting, "dev", model.agent, {
						provider: model.provider ?? null,
						model: model.model,
					});
					return why ? [why] : [];
				});
				if (refused.length > 0) {
					return {
						action: "escalate",
						to: "orchestrator",
						requireApproval: false,
						reason: `${fails} failed QA round(s); the kit's runoff is refused: ${refused.join("; ")}`,
					};
				}
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
			if (!fallbackFlow.triggers.outage) {
				return { action: "hold", reason: "the kit waits out outages (fallback.on.outage off)" };
			}
			const afterMin = fallbackFlow.outageAfterMin ?? maxMin;
			if (heldMin < afterMin) {
				return { action: "hold", reason: `the kit hands the card over after ${afterMin} min of outage` };
			}
			const reason = `provider outage on ${dev.model?.model ?? "its model"} for ${Math.floor(heldMin)} min`;
			const answer = escalate(dev, reason, "outage");
			// Nothing to take it over: the hold runs to maxMin and goes to the orchestrator, as without the trigger.
			if (answer.action !== "escalate" || answer.to === "orchestrator") {
				return {
					action: "hold",
					reason: `fallback.on.outage is on, but there is no fallback model (${answer.action === "escalate" ? answer.reason : "no answer"})`,
				};
			}
			if (isSameEscalationModel(dev.model, answer.to.model)) {
				return {
					action: "hold",
					reason: `the fallback is ${answer.to.model.model}, the model the card already runs on`,
				};
			}
			return { action: "escalate", to: answer.to, requireApproval: answer.requireApproval, reason };
		},
	};
}
