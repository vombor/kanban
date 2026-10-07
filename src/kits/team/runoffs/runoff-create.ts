// `kanban bench runoff create` (pure part): one dev card per model on the same task and base, plus the runoff group
// for runoffs.json. The runoffs feature then holds each card's PASS and decides (runoffs-feature.ts).
//
// Before the port the orchestrator did this by hand: N cards with the same prompt and base (a `bench/pre-runoff-…`
// tag), each pinned to a model, and a hand-written runoffs.json entry (data/foo/runoffs.json, 10/06 tier-3 and
// tier-2 runoffs).
import type { RuntimeAgentId, RuntimeTaskAgentSettings } from "../../../core/api-contract";
import { runtimeAgentIdSchema } from "../../../core/api-contract";
import type { PipelineRunoffGroup } from "../../../pipeline/features";
import { modelSlug } from "../../../pipeline/rework-text";
import type { KitDocument } from "../../kit-schema";
import { getUsableTierEntries } from "../../kit-schema";
import type { RunoffEntry } from "./runoffs-store";

export interface RunoffContender {
	agentId: RuntimeAgentId;
	provider: string | null;
	model: string;
}

export const RUNOFF_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * `[agent:][provider/]model`, e.g. `cline:bedrock/us.openai.gpt-6.1-sol`, `codex:gpt-6.1`, `us.anthropic.claude-opus-5-5`.
 * A model id may contain `/` itself only after a provider (`lemonade/Qwen/Qwen3`).
 */
export function parseRunoffModelSpec(spec: string, defaultAgentId: RuntimeAgentId): RunoffContender {
	const trimmed = spec.trim();
	let rest = trimmed;
	let agentId = defaultAgentId;
	const colon = rest.indexOf(":");
	if (colon > 0) {
		const parsed = runtimeAgentIdSchema.safeParse(rest.slice(0, colon));
		// Model ids carry colons too (`…-v1:0`): only a known agent id before the first colon is an agent.
		if (parsed.success) {
			agentId = parsed.data;
			rest = rest.slice(colon + 1);
		}
	}
	const slash = rest.indexOf("/");
	const provider = slash > 0 ? rest.slice(0, slash) : null;
	const model = slash > 0 ? rest.slice(slash + 1) : rest;
	if (!model) {
		throw new Error(`--model ${spec}: no model id`);
	}
	return { agentId, provider, model };
}

/** Every usable model of a tier (dropped ones skipped), on `agentId`. */
export function getTierContenders(kit: KitDocument, tier: string, agentId: RuntimeAgentId): RunoffContender[] {
	if (!kit.tiers || !Object.hasOwn(kit.tiers, tier)) {
		throw new Error(`tier "${tier}" is not in kit "${kit.name}"`);
	}
	return getUsableTierEntries(kit, tier).map((entry) => ({
		agentId,
		provider: entry.provider ?? null,
		model: entry.model,
	}));
}

export interface PlannedRunoffCard {
	title: string;
	prompt: string;
	baseRef: string;
	agentId: RuntimeAgentId;
	agentSettings: RuntimeTaskAgentSettings;
	contender: RunoffContender;
}

export interface RunoffPlanInput {
	name: string;
	title: string;
	prompt: string;
	baseRef: string;
	contenders: RunoffContender[];
	/** The provider stored on a card whose spec named none (resolveProposalProvider), null = the agent's own. */
	resolveProvider: (contender: RunoffContender) => string | null;
	existing: readonly RunoffEntry[];
}

export function planRunoffCards(input: RunoffPlanInput): PlannedRunoffCard[] {
	if (!RUNOFF_NAME_PATTERN.test(input.name)) {
		throw new Error(`runoff name "${input.name}": letters, digits, '.', '_' or '-' only`);
	}
	if (input.existing.some((runoff) => runoff.name === input.name)) {
		throw new Error(`runoffs.json already has a runoff named "${input.name}"`);
	}
	if (input.contenders.length < 2) {
		throw new Error("a runoff needs at least two models");
	}
	const keys = input.contenders.map(
		(contender) => `${contender.agentId}:${contender.provider ?? ""}/${contender.model}`,
	);
	if (new Set(keys).size !== keys.length) {
		throw new Error("the same agent and model is named twice");
	}
	return input.contenders.map((contender) => {
		const providerId = contender.provider ?? input.resolveProvider(contender);
		return {
			title: `${input.title} [runoff ${input.name}: ${modelSlug(contender.model)}]`,
			prompt: input.prompt,
			baseRef: input.baseRef,
			agentId: contender.agentId,
			agentSettings: { ...(providerId ? { providerId } : {}), modelId: contender.model },
			contender: { ...contender, provider: providerId },
		};
	});
}

/** The runoffs.json entry for created cards (`models` as "provider/model", the legacy format). */
export function buildRunoffEntry(input: {
	name: string;
	created: Array<{ taskId: string; card: PlannedRunoffCard }>;
	baseRef: string;
	/** Where the prompt came from: its file, `card <id>`, or `inline` (the cards carry the text). */
	promptSource: string;
	benchOnly: boolean;
	createdAt: string;
}): RunoffEntry {
	return {
		name: input.name,
		cards: input.created.map((entry) => entry.taskId),
		models: Object.fromEntries(input.created.map(({ taskId, card }) => [taskId, formatRunoffModel(card.contender)])),
		base: input.baseRef,
		prompt: input.promptSource,
		createdAt: input.createdAt,
		...(input.benchOnly ? { benchOnly: true } : {}),
		decided: null,
	};
}

/** "provider/model" (or just the model) as runoffs.json's `models` has it. */
function formatRunoffModel(model: { provider: string | null; model: string } | null): string {
	return model ? (model.provider ? `${model.provider}/${model.model}` : model.model) : "unknown";
}

/**
 * The runoffs.json entry for a group the rework stage started after a FAIL (the kit's `onFail.runoff`): the failed
 * card races its siblings from the round it failed in.
 */
export function buildRunoffEntryFromGroup(group: PipelineRunoffGroup, createdAt: string): RunoffEntry {
	return {
		name: group.name,
		cards: group.cards.map((card) => card.taskId),
		models: Object.fromEntries(group.cards.map((card) => [card.taskId, formatRunoffModel(card.model)])),
		base: group.baseRef,
		prompt: `card ${group.from} (onFail.runoff after its FAIL round ${group.round})`,
		createdAt,
		from: group.from,
		round: group.round,
		...(group.abandoned ? { abandoned: group.abandoned } : {}),
		decided: null,
	};
}
