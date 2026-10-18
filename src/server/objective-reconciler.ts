// Native read-only supervision of existing owners: no board, session, recovery, landing, wake or ATTENTION writes.
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { isTaskExecutionBlocked } from "../core/task-execution-block";
import type { ObjectiveSessionObservation } from "../objectives/objective-attempts";
import { replayObjectiveReceipts } from "../objectives/objective-receipts";
import type { ObjectiveStore } from "../objectives/objective-store";
import type { PipelineStateStore } from "../pipeline/pipeline-state";
import { isReviewSettled } from "../terminal/review-settle";

export function createObjectiveReconciler(options: {
	store: ObjectiveStore;
	pipeline: PipelineStateStore;
	listWorkspaces: () => Array<{
		workspaceId: string;
		summaries: RuntimeTaskSessionSummary[];
		isLive: (taskId: string) => boolean;
	}>;
	intervalMs?: number;
	reviewSettleMs?: number;
	now?: () => number;
	warn: (message: string) => void;
	collectUsage?: (workspaceId: string) => Promise<void>;
	serverStartedAt?: number;
}) {
	let closed = false;
	let running: Promise<void> | null = null;
	let activities: Promise<void> = Promise.resolve();
	const blockedWorkspaces = new Set<string>();
	const now = options.now ?? Date.now;
	const observation = (summary: RuntimeTaskSessionSummary, live: boolean): ObjectiveSessionObservation => ({
		taskId: summary.taskId,
		startedAt: summary.startedAt ?? null,
		updatedAt: summary.updatedAt,
		stateChangedAt: summary.stateChangedAt ?? null,
		state: summary.state,
		live,
		settled: isReviewSettled(summary, now(), options.reviewSettleMs),
		submitted: summary.dispatchPromptSubmitted !== false,
		submittedAt: summary.dispatchPromptSubmittedAt ?? null,
		executionBlocked: isTaskExecutionBlocked(summary),
	});
	const blocked = (workspaceId: string): void => {
		if (blockedWorkspaces.has(workspaceId)) return;
		blockedWorkspaces.add(workspaceId);
		options.warn(
			`Objective reconciliation for ${workspaceId} is blocked; preserve owner evidence and inspect objective storage. No work was replayed.`,
		);
	};
	type Workspace = ReturnType<typeof options.listWorkspaces>[number];
	const reconcileWorkspace = async (workspace: Workspace): Promise<void> => {
		if (!(await options.store.read(workspace.workspaceId)).objectives.length) return;
		if (options.serverStartedAt !== undefined)
			await options.store.interruptReservations(workspace.workspaceId, options.serverStartedAt);
		const pipeline = await options.pipeline.peek(workspace.workspaceId);
		if (pipeline) await replayObjectiveReceipts(options.store, workspace.workspaceId, pipeline);
		await options.store.observe(
			workspace.workspaceId,
			workspace.summaries.map((summary) => observation(summary, workspace.isLive(summary.taskId))),
		);
		await options.collectUsage?.(workspace.workspaceId);
		blockedWorkspaces.delete(workspace.workspaceId);
	};
	const reconcile = async (): Promise<void> => {
		for (const workspace of options.listWorkspaces()) {
			if (closed) break;
			try {
				await reconcileWorkspace(workspace);
			} catch {
				blocked(workspace.workspaceId);
			}
		}
	};
	const sweep = (): Promise<void> => {
		if (closed) return Promise.resolve();
		if (!running)
			running = reconcile().finally(() => {
				running = null;
			});
		return running;
	};
	const timer = setInterval(() => {
		void sweep();
	}, options.intervalMs ?? 5000);
	timer.unref();
	return {
		sweep,
		recheck: async (workspaceId: string): Promise<void> => {
			if (closed) throw new Error("Objective reconciliation is closed.");
			await Promise.all([running, activities]);
			const workspace = options.listWorkspaces().find((item) => item.workspaceId === workspaceId);
			if (!workspace) {
				// A registered project may have objectives before its first terminal/activation. Collect durable owners
				// without activating/trusting an agent workspace or pretending its unobserved sessions disappeared.
				if (!(await options.store.read(workspaceId)).objectives.length)
					throw new Error("This project's native objective owner is unavailable; no work was replayed.");
				const pipeline = await options.pipeline.peek(workspaceId);
				if (options.serverStartedAt !== undefined)
					await options.store.interruptReservations(workspaceId, options.serverStartedAt);
				if (pipeline) await replayObjectiveReceipts(options.store, workspaceId, pipeline);
				await options.store.observe(workspaceId, [], false);
				await options.collectUsage?.(workspaceId);
				return;
			}
			// Propagate storage/evidence failure to the scoped user operation instead of reporting a successful refresh.
			await reconcileWorkspace(workspace);
		},
		// Capture state transitions immediately, not at a later sweep which could miss a short turn. No model turn.
		noteActivity: (workspaceId: string, summary: RuntimeTaskSessionSummary, live: boolean): void => {
			if (closed) return;
			const fact = observation(summary, live);
			activities = activities
				.then(async () => await options.store.observe(workspaceId, [fact], false))
				.catch(() => blocked(workspaceId));
		},
		close: async () => {
			closed = true;
			clearInterval(timer);
			await Promise.all([running, activities]);
		},
	};
}
