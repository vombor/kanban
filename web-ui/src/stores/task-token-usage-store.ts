import { useCallback, useSyncExternalStore } from "react";

import type { RuntimeTaskTokenUsage } from "@/runtime/types";

// The current project's card token counts and used models (read from the agents' own session files, src/terminal/agent-token-usage.ts):
// the whole list as the runtime last answered workspace.getTaskTokenUsage (fetched by useTaskTokenUsagePolling), plus
// the cards it pushed since (`task_token_usage_updated`, src/server/task-token-usage-monitor.ts).
let usageByTaskId = new Map<string, RuntimeTaskTokenUsage>();
const listeners = new Set<() => void>();

function isSameUsage(a: RuntimeTaskTokenUsage | undefined, b: RuntimeTaskTokenUsage): boolean {
	return (
		a !== undefined &&
		a.input === b.input &&
		a.output === b.output &&
		a.cacheRead === b.cacheRead &&
		a.cacheWrite === b.cacheWrite &&
		a.models.length === b.models.length &&
		a.models.every((model, index) => model === b.models[index])
	);
}

function publish(next: Map<string, RuntimeTaskTokenUsage>): void {
	usageByTaskId = next;
	for (const listener of listeners) {
		listener();
	}
}

/** The whole list: cards it leaves out have no count. */
export function setTaskTokenUsage(usage: readonly RuntimeTaskTokenUsage[]): void {
	if (
		usage.length === usageByTaskId.size &&
		usage.every((entry) => isSameUsage(usageByTaskId.get(entry.taskId), entry))
	) {
		return;
	}
	const next = new Map<string, RuntimeTaskTokenUsage>();
	for (const entry of usage) {
		const previous = usageByTaskId.get(entry.taskId);
		// Unchanged cards keep their object, so only the cards whose counts moved re-render.
		next.set(entry.taskId, previous && isSameUsage(previous, entry) ? previous : entry);
	}
	publish(next);
}

/** Some cards' new counts; every other card keeps its own. */
export function mergeTaskTokenUsage(usage: readonly RuntimeTaskTokenUsage[]): void {
	const changed = usage.filter((entry) => !isSameUsage(usageByTaskId.get(entry.taskId), entry));
	if (changed.length === 0) {
		return;
	}
	const next = new Map(usageByTaskId);
	for (const entry of changed) {
		next.set(entry.taskId, entry);
	}
	publish(next);
}

export function getTaskTokenUsage(taskId: string): RuntimeTaskTokenUsage | null {
	return usageByTaskId.get(taskId) ?? null;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useTaskTokenUsage(taskId: string): RuntimeTaskTokenUsage | null {
	const getSnapshot = useCallback(() => getTaskTokenUsage(taskId), [taskId]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
