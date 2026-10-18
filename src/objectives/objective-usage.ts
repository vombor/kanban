import type { AgentUsageObservation } from "../core/agent-usage-observation";
import type { RuntimeObjective } from "../core/objective-contract";
import { type ObjectiveUsageRecord, objectiveUsageRecordSchema } from "../core/objective-usage";
import { isUnmeteredProvider, type PriceTable, turnCost } from "../kits/team/bench/prices";
import { objectiveDigest } from "./objective-identity";

export function priceObjectiveObservation(input: {
	objective: RuntimeObjective;
	taskId: string;
	observation: AgentUsageObservation;
	prices: PriceTable;
	observedAt: string;
}): ObjectiveUsageRecord {
	const { objective, taskId, observation, prices, observedAt } = input;
	const member = objective.tasks.find((task) => task.taskId === taskId);
	if (!member) throw new Error("Usage has no explicit objective member.");
	const uncertainty: string[] = [...observation.uncertainty];
	if (observation.basis !== "request") uncertainty.push("session_total_not_request_attributed");
	if (observation.at === null || observation.at < Date.parse(member.attachedAt))
		uncertainty.push("time_not_objective_attributed");
	const attempts = objective.attempts.filter(
		(attempt) =>
			attempt.taskId === taskId &&
			attempt.requirementsHash === objective.requirementsHash &&
			observation.at !== null &&
			Date.parse(attempt.startedAt) <= observation.at &&
			(attempt.endedAt === null || Date.parse(attempt.endedAt) >= observation.at),
	);
	const attemptId = attempts.length === 1 ? (attempts[0]?.id ?? null) : null;
	if (!attemptId) uncertainty.push("attempt_attribution_unknown");
	const rates = observation.provider ? prices.priceFor(observation.model, observation.provider) : null;
	if (!rates) uncertainty.push("price_unknown");
	else if (rates.source === "aws" && observation.provider !== "bedrock" && !isUnmeteredProvider(observation.provider))
		uncertainty.push("price_provider_mismatch");
	let price: ObjectiveUsageRecord["price"] = null;
	if (uncertainty.length === 0 && rates && observation.tokens) {
		const tokens = observation.tokens;
		const totalInput = tokens.input + tokens.cacheRead + tokens.cacheWrite;
		const selected = rates.longOver && rates.long && totalInput > rates.longOver ? rates.long : rates;
		price = {
			revision: objectiveDigest(JSON.stringify(prices.file)),
			source: prices.source === "seed" ? "seed" : "configured",
			kind: isUnmeteredProvider(observation.provider) ? "unmetered" : "table_estimate",
			rates: {
				input: selected.in,
				output: selected.out,
				cacheRead: selected.cacheRead,
				cacheWrite: selected.cacheWrite,
			},
			estimatedUsd: turnCost(rates, { ...tokens, input: totalInput }),
		};
	}
	const data = { taskId, requirementsHash: objective.requirementsHash, attemptId, observation, price, uncertainty };
	return objectiveUsageRecordSchema.parse({
		// Copied/resumed history can appear in a replacement's worktree: one backend request is charged once per goal.
		id: objectiveDigest(JSON.stringify([objective.id, observation.key])),
		version: objectiveDigest(JSON.stringify(data)),
		observedAt,
		...data,
	});
}

/** Append revisions without summing re-reads/copies or discarding disappeared source files. */
export function retainObjectiveUsage(objective: RuntimeObjective, records: readonly ObjectiveUsageRecord[]): boolean {
	let changed = false;
	for (const raw of records) {
		const record = objectiveUsageRecordSchema.parse(raw);
		if (
			record.requirementsHash !== objective.requirementsHash ||
			!objective.tasks.some((task) => task.taskId === record.taskId)
		)
			throw new Error("Usage receipt lost pinned task attribution.");
		const existing = objective.usage.find((item) => item.id === record.id && item.version === record.version);
		if (existing) continue;
		if (objective.usage.length >= 10000)
			throw new Error("Objective usage retention ceiling reached; no history was evicted.");
		objective.usage.push(record);
		changed = true;
	}
	if (!changed) return false;
	// Missing files, late attribution or revised rates cannot silently credit back a previously observed charge.
	const highest = new Map<string, ObjectiveUsageRecord>();
	for (const record of objective.usage) {
		if (record.price && record.price.estimatedUsd >= (highest.get(record.id)?.price?.estimatedUsd ?? -1))
			highest.set(record.id, record);
	}
	const priced = [...highest.values()];
	objective.observedEstimatedUsd = priced.length
		? priced.reduce((sum, record) => sum + (record.price?.estimatedUsd ?? 0), 0)
		: null;
	// Full coverage needs every admitted attempt/backend, billing route and historical source. Not available yet.
	objective.estimatedUsd = null;
	objective.costCoverage = priced.length ? "partial" : "unknown";
	return true;
}
