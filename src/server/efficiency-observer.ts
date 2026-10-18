import { randomUUID } from "node:crypto";
import type { RuntimePipelineCardStage, RuntimeTaskSessionSummary } from "../core/api-contract";
import { readTaskRunningTime } from "../core/task-running-time";
import type { createEfficiencyTimingStore } from "../efficiency/timing-store";
import { isReviewSettled } from "../terminal/review-settle";
import { describeUserInputWait } from "../terminal/user-input-wait";
import { type EfficiencyCategory, efficiencyCategorySchema } from "../trpc/efficiency-contract";

export function efficiencySample(input: {
	sessions: RuntimeTaskSessionSummary[];
	stages: RuntimePipelineCardStage[];
	isLive: (taskId: string) => boolean;
	taskIds: ReadonlySet<string>;
	now: number;
	settleMs: number;
}) {
	const labels: Record<string, EfficiencyCategory[]> = {},
		counters: Record<string, number> = {};
	for (const summary of input.sessions) {
		if (
			!input.taskIds.has(summary.taskId) ||
			Object.hasOwn(Object.prototype, summary.taskId) ||
			summary.taskId === "prototype"
		)
			continue;
		const live = input.isLive(summary.taskId),
			current: EfficiencyCategory[] = [];
		if (live && summary.state === "running") current.push("agent_running");
		if (summary.state === "awaiting_review" && isReviewSettled(summary, input.now, input.settleMs))
			current.push("review_settled");
		if (live && describeUserInputWait(summary)) current.push("user_input_wait");
		labels[summary.taskId] = current;
		const running = readTaskRunningTime(summary, live ? input.now : Math.min(input.now, summary.updatedAt));
		if (running) counters[summary.taskId] = running.totalMs;
	}
	for (const stage of input.stages) {
		if (
			!input.taskIds.has(stage.taskId) ||
			Object.hasOwn(Object.prototype, stage.taskId) ||
			stage.taskId === "prototype"
		)
			continue;
		const category = efficiencyCategorySchema.safeParse(stage.kind);
		if (category.success) {
			labels[stage.taskId] ??= [];
			labels[stage.taskId].push(category.data);
		}
	}
	return { labels, counters };
}
export function createEfficiencyObserver(deps: {
	store: ReturnType<typeof createEfficiencyTimingStore>;
	workspaces: () => string[];
	sample: (
		workspaceId: string,
	) => Promise<{ labels: Record<string, EfficiencyCategory[]>; counters: Record<string, number> }>;
	warn: (message: string) => void;
	now?: () => number;
}) {
	const serverId = randomUUID(),
		now = deps.now ?? Date.now;
	let busy: Promise<void> | null = null,
		closed = false;
	const warned = new Set<string>();
	const tick = () => {
		if (closed || busy) return;
		busy = (async () => {
			for (const workspaceId of deps.workspaces()) {
				try {
					const observations = await deps.sample(workspaceId);
					await deps.store.sample(workspaceId, { serverId, at: now(), ...observations });
					warned.delete(workspaceId);
				} catch {
					if (!warned.has(workspaceId)) {
						warned.add(workspaceId);
						deps.warn(
							"Efficiency observation unavailable for a project; no history was replaced or workflow changed.",
						);
					}
				}
			}
		})().finally(() => {
			busy = null;
		});
	};
	const timer = setInterval(tick, 10000);
	timer.unref();
	tick();
	return {
		close: async () => {
			closed = true;
			clearInterval(timer);
			await busy;
		},
	};
}
