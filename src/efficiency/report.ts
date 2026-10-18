import type { RuntimeObjective } from "../core/objective-contract";
import type { ObjectiveUsageRecord } from "../core/objective-usage";
import { type EfficiencySpan, efficiencyReportSchema } from "../trpc/efficiency-contract";
import type { EfficiencyTimingState } from "./timing-store";

/** Union, not sum, of overlapping sampled windows: summed agent/stage occupancy is not critical-path elapsed time. */
export function unionDuration(spans: readonly Pick<EfficiencySpan, "start" | "end">[]): number | null {
	if (!spans.length) return null;
	let total = 0,
		start = 0,
		end = 0,
		first = true;
	for (const span of [...spans].sort((a, b) => a.start - b.start)) {
		if (first) {
			start = span.start;
			end = span.end;
			first = false;
		} else if (span.start <= end) end = Math.max(end, span.end);
		else {
			total += end - start;
			start = span.start;
			end = span.end;
		}
	}
	return total + end - start;
}
export function buildEfficiencyReport(input: {
	objectives: RuntimeObjective[];
	timing: EfficiencyTimingState;
	taskIds: ReadonlySet<string>;
	now: number;
	scope: "project" | "task" | "objective" | "plan";
	attachedAfter?: Map<string, number>;
}) {
	const warnings = new Set<string>([
		"sampled_stage_occupancy_not_exact_durations",
		"unobserved_transitions_and_short_waits_may_be_missing",
		"complete_internal_cli_usage_and_billing_unknown",
		"planning_and_orchestrator_overhead_unattributed",
		"forecast_model_not_implemented",
		"same_card_rework_usage_not_separately_attributed",
		"token_counters_highest_retained_not_billed_totals",
		"setup_install_and_provider_wait_substeps_not_fully_retained",
	]);
	if (input.timing.gaps) warnings.add("restart_or_sampling_gaps_not_charged_as_active_time");
	const spans = input.timing.spans.filter(
		(span) => input.taskIds.has(span.taskId) && span.start >= (input.attachedAfter?.get(span.taskId) ?? 0),
	);
	const active = input.timing.agentSamples.filter(
		(sample) => input.taskIds.has(sample.taskId) && sample.start >= (input.attachedAfter?.get(sample.taskId) ?? 0),
	);
	const components = new Map<string, { tasks: Set<string>; records: Map<string, ObjectiveUsageRecord> }>(),
		observations = new Map<string, { records: ObjectiveUsageRecord[]; roles: Set<string> }>();
	for (const objective of input.objectives)
		for (const record of objective.usage) {
			if (!input.taskIds.has(record.taskId)) continue;
			const after = input.attachedAfter?.get(record.taskId);
			if (after !== undefined && (record.observation.at === null || record.observation.at < after)) {
				warnings.add("usage_before_or_without_family_attribution_excluded");
				continue;
			}
			const role = objective.tasks.find((task) => task.taskId === record.taskId)?.kind ?? "unattributed",
				key = record.observation.key;
			const group = observations.get(key) ?? { records: [], roles: new Set<string>() };
			group.records.push(record);
			group.roles.add(role);
			observations.set(key, group);
		}
	const priceRevisions = new Set<string>(),
		priceSources = new Set<"seed" | "configured">(),
		chargeKinds = new Set<"unmetered" | "table_estimate">();
	let subtotal = 0,
		priced = 0;
	for (const [key, group] of observations) {
		const kind = group.roles.size === 1 ? ([...group.roles][0] ?? "unattributed") : "unattributed",
			component = components.get(kind) ?? {
				tasks: new Set<string>(),
				records: new Map<string, ObjectiveUsageRecord>(),
			};
		const best = group.records.reduce((a, b) =>
			(b.price?.estimatedUsd ?? -1) > (a.price?.estimatedUsd ?? -1) ? b : a,
		);
		const counted = group.records.flatMap((record) => (record.observation.tokens ? [record.observation.tokens] : []));
		const tokens = counted.length
			? counted.reduce(
					(max, value) => ({
						input: Math.max(max.input, value.input),
						output: Math.max(max.output, value.output),
						cacheRead: Math.max(max.cacheRead, value.cacheRead),
						cacheWrite: Math.max(max.cacheWrite, value.cacheWrite),
					}),
					{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				)
			: null;
		for (const record of group.records) {
			component.tasks.add(record.taskId);
			if (record.price) {
				priceRevisions.add(record.price.revision);
				priceSources.add(record.price.source);
				chargeKinds.add(record.price.kind);
			}
			for (const warning of record.uncertainty) warnings.add(warning);
		}
		component.records.set(key, { ...best, observation: { ...best.observation, tokens } });
		components.set(kind, component);
		if (best.price) {
			subtotal += best.price.estimatedUsd;
			priced++;
		} else warnings.add("price_or_usage_attribution_unknown");
	}
	const rows = [...components].map(([kind, component]) => {
		const records = [...component.records.values()],
			tokens = records.filter((record) => record.observation.tokens);
		return {
			kind,
			tasks: component.tasks.size,
			observedEstimatedUsd: records.some((record) => record.price)
				? records.reduce((sum, record) => sum + (record.price?.estimatedUsd ?? 0), 0)
				: null,
			observedTokens: tokens.length
				? tokens.reduce(
						(sum, record) => {
							const t = record.observation.tokens;
							if (t) {
								sum.input += t.input;
								sum.output += t.output;
								sum.cacheRead += t.cacheRead;
								sum.cacheWrite += t.cacheWrite;
							}
							return sum;
						},
						{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					)
				: null,
		};
	});
	if (!observations.size) warnings.add("no_retained_attributed_usage_observations");
	if (priceRevisions.size > 50) warnings.add("price_revision_list_truncated");
	return efficiencyReportSchema.parse({
		generatedAt: input.now,
		scope: input.scope,
		taskCount: input.taskIds.size,
		observedAgentRunningMs: active.length ? active.reduce((sum, sample) => sum + sample.ms, 0) : null,
		observedElapsedMs: unionDuration(spans),
		summedSampledMs: spans.length ? spans.reduce((sum, span) => sum + span.end - span.start, 0) : null,
		timing: [...new Set(spans.map((span) => span.category))].map((category) => ({
			category,
			sampledMs: unionDuration(spans.filter((span) => span.category === category)) ?? 0,
		})),
		components: rows,
		observedEstimatedUsd: priced ? subtotal : null,
		totalEstimatedUsd: null,
		priceRevisions: [...priceRevisions].slice(0, 50),
		priceSources: [...priceSources],
		chargeKinds: [...chargeKinds],
		coverage: "partial_or_unknown",
		forecast: "insufficient_evidence",
		warnings:
			warnings.size > 30 ? [...[...warnings].slice(0, 29), "additional_coverage_warnings_truncated"] : [...warnings],
		authority: "report_only_not_acceptance_or_billing",
	});
}
