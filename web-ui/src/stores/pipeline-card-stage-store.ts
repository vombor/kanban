import { useCallback, useSyncExternalStore } from "react";

import type { RuntimePipelineCardStage } from "@/runtime/types";

// The current project's pipeline card stages (issue #30), as the runtime state stream last sent them
// (`pipeline_card_stages_updated`, computed by the pipeline worker, src/pipeline/card-stage.ts). Board cards show their
// stage, and Approve & land asks first while a card's checks or QA are in flight. Empty on boards not on landing qa.
let stagesByTaskId = new Map<string, RuntimePipelineCardStage>();
const listeners = new Set<() => void>();

export function setPipelineCardStages(stages: readonly RuntimePipelineCardStage[]): void {
	if (stages.length === 0 && stagesByTaskId.size === 0) {
		return;
	}
	stagesByTaskId = new Map(stages.map((stage) => [stage.taskId, stage]));
	for (const listener of listeners) {
		listener();
	}
}

export function getPipelineCardStage(taskId: string): RuntimePipelineCardStage | null {
	return stagesByTaskId.get(taskId) ?? null;
}

/**
 * The card's stage while its checks or QA are in flight (the stage's `inFlight`), else null: the one rule for "landing
 * now skips the pipeline", asked by Approve & land and by the Done move's "land or discard?" dialog.
 */
export function getInFlightPipelineCardStage(taskId: string): RuntimePipelineCardStage | null {
	const stage = getPipelineCardStage(taskId);
	return stage?.inFlight ? stage : null;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function usePipelineCardStage(taskId: string): RuntimePipelineCardStage | null {
	const getSnapshot = useCallback(() => getPipelineCardStage(taskId), [taskId]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useInFlightPipelineCardStage(taskId: string | null): RuntimePipelineCardStage | null {
	const getSnapshot = useCallback(() => (taskId ? getInFlightPipelineCardStage(taskId) : null), [taskId]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
