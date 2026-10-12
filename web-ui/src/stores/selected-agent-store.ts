import { useSyncExternalStore } from "react";

import type { RuntimeAgentId } from "@/runtime/types";

// The current project's selected agent (Kanban settings, from the runtime config). Board cards show it as the agent of
// a card that names none and has no session yet, the effective agent's last fallback (src/core/effective-agent.ts).
let selectedAgentId: RuntimeAgentId | null = null;
const listeners = new Set<() => void>();

export function setSelectedAgentId(next: RuntimeAgentId | null): void {
	if (next === selectedAgentId) {
		return;
	}
	selectedAgentId = next;
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

function getSnapshot(): RuntimeAgentId | null {
	return selectedAgentId;
}

export function useSelectedAgentId(): RuntimeAgentId | null {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
