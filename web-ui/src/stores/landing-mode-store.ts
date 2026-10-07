import { useSyncExternalStore } from "react";

import type { RuntimeLandingMode } from "@/runtime/types";

// The current project's landing mode (`workspaces.<id>.landing.mode`, from the runtime config). Board cards read
// it to show Approve & land instead of Commit / Open PR on cards Kanban lands itself (landing mode qa).
let landingMode: RuntimeLandingMode | null = null;
const listeners = new Set<() => void>();

export function setLandingMode(next: RuntimeLandingMode | null): void {
	if (next === landingMode) {
		return;
	}
	landingMode = next;
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

function getSnapshot(): RuntimeLandingMode | null {
	return landingMode;
}

export function useLandingMode(): RuntimeLandingMode | null {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
