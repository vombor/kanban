import type { RuntimeAgentDefaultSettings } from "@runtime-task-agent-settings";
import { useSyncExternalStore } from "react";

// Kanban's default model per agent CLI (Kanban settings, from the runtime config): what a launch passes when a card
// names no model (src/core/task-agent-settings.ts resolveLaunchAgentSettings). Board cards and the create dialog show
// it where the card's own model would be.
const NO_AGENT_DEFAULTS: RuntimeAgentDefaultSettings = {};
let agentDefaults: RuntimeAgentDefaultSettings = NO_AGENT_DEFAULTS;
const listeners = new Set<() => void>();

export function setAgentDefaults(next: RuntimeAgentDefaultSettings | null | undefined): void {
	const value = next ?? NO_AGENT_DEFAULTS;
	// Every config fetch is a new object: keep the snapshot (and every subscriber's memo) while the values are equal.
	if (JSON.stringify(value) === JSON.stringify(agentDefaults)) {
		return;
	}
	agentDefaults = value;
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

function getSnapshot(): RuntimeAgentDefaultSettings {
	return agentDefaults;
}

export function useAgentDefaults(): RuntimeAgentDefaultSettings {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
