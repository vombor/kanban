// Plan-card metrics for a later benchmark of planners (agents and models), without one yet: per plan, who planned it
// (agent, model), how long and how much it took (card metrics, measured at expand), how many cards it produced,
// whether the user approved it, and how many reworks its cards needed. The plan index holds what is known at
// expand; the rework counts are read from pipeline-state when asked, since they grow after the expand.
import type { PipelineWorkspaceState } from "../pipeline/pipeline-state";
import { readEscalationRecord, readQaflow, readReworks } from "../pipeline/rework";
import type { PlanIndex, PlanRecord } from "./plan-index";

export interface PlanMetricsRow {
	planTaskId: string;
	slug: string;
	title: string;
	createdAt: string;
	agent: string | null;
	provider: string | null;
	model: string | null;
	wallMin: number | null;
	activeMin: number | null;
	costUSD: number | null;
	approved: boolean;
	approvedAt: string | null;
	expandedAt: string | null;
	cards: number;
	/** Reworks sent to the plan's cards so far (pipeline-state `qaflow.reworks`). */
	reworks: number;
	reworksByCard: Record<string, number>;
	/** Cards of the plan the pipeline escalated. */
	escalated: number;
}

export function buildPlanMetricsRow(record: PlanRecord, pipelineState: PipelineWorkspaceState | null): PlanMetricsRow {
	const cardIds = Object.values(record.expansion?.cards ?? {});
	const reworksByCard: Record<string, number> = {};
	let escalated = 0;
	for (const taskId of cardIds) {
		const qaflow = readQaflow(pipelineState?.cards[taskId]);
		reworksByCard[taskId] = readReworks(qaflow).length;
		if (readEscalationRecord(qaflow)) {
			escalated += 1;
		}
	}
	return {
		planTaskId: record.taskId,
		slug: record.slug,
		title: record.title,
		createdAt: record.createdAt,
		agent: record.metrics?.agent ?? record.agentId,
		provider: record.metrics?.provider ?? record.providerId,
		model: record.metrics?.model ?? record.modelId,
		wallMin: record.metrics?.wallMin ?? null,
		activeMin: record.metrics?.activeMin ?? null,
		costUSD: record.metrics?.costUSD ?? null,
		approved: record.approval !== null,
		approvedAt: record.approval?.at ?? null,
		expandedAt: record.expansion?.status === "done" ? record.expansion.finishedAt : null,
		cards: cardIds.length,
		reworks: Object.values(reworksByCard).reduce((sum, count) => sum + count, 0),
		reworksByCard,
		escalated,
	};
}

export function buildPlanMetrics(index: PlanIndex, pipelineState: PipelineWorkspaceState | null): PlanMetricsRow[] {
	return Object.values(index.plans)
		.map((record) => buildPlanMetricsRow(record, pipelineState))
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
