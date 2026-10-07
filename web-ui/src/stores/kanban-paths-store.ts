import { useSyncExternalStore } from "react";

import type { RuntimeKanbanPaths } from "@/runtime/types";

// Kanban home and worktree paths resolved by the runtime (src/state/kanban-home.ts). The browser
// cannot resolve them itself, so components read them from here instead of hard-coding them.
let kanbanPaths: RuntimeKanbanPaths | null = null;
const listeners = new Set<() => void>();

export function setKanbanPaths(next: RuntimeKanbanPaths | null): void {
	if (next === kanbanPaths) {
		return;
	}
	kanbanPaths = next;
	for (const listener of listeners) {
		listener();
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function getSnapshot(): RuntimeKanbanPaths | null {
	return kanbanPaths;
}

export function useKanbanPaths(): RuntimeKanbanPaths | null {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
