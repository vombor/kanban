import { useCallback, useSyncExternalStore } from "react";

import type { RuntimeTaskTokenUsage } from "@/runtime/types";

// The current project's card token counts, as the runtime last answered workspace.getTaskTokenUsage (read from the
// agents' own session files, src/terminal/agent-token-usage.ts). Polled by useTaskTokenUsagePolling.
let usageByTaskId = new Map<string, RuntimeTaskTokenUsage>();
const listeners = new Set<() => void>();

function isSameUsage(a: RuntimeTaskTokenUsage | undefined, b: RuntimeTaskTokenUsage): boolean {
	return (
		a !== undefined &&
		a.input === b.input &&
		a.output === b.output &&
		a.cacheRead === b.cacheRead &&
		a.cacheWrite === b.cacheWrite
	);
}

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
	usageByTaskId = next;
	for (const listener of listeners) {
		listener();
	}
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
