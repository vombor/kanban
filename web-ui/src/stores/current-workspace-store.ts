import { useSyncExternalStore } from "react";

// The project the board shows (App's current project id). Board cards read it for the few card actions that call
// the runtime themselves (a plan card's Approve plan) instead of threading the id through every column.
let currentWorkspaceId: string | null = null;
const listeners = new Set<() => void>();

export function setCurrentWorkspaceId(next: string | null): void {
	if (next === currentWorkspaceId) {
		return;
	}
	currentWorkspaceId = next;
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

function getSnapshot(): string | null {
	return currentWorkspaceId;
}

export function useCurrentWorkspaceId(): string | null {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
