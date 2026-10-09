import { useSyncExternalStore } from "react";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

// The opt-in for desktop notifications when a project's orchestrator waits for the user (issue #10). It is this
// browser's, like the notification permission it needs, so it lives in local storage rather than the runtime config.
// Off by default; the settings dialog asks for the permission only when the user turns it on.
const listeners = new Set<() => void>();

function readEnabled(): boolean {
	return readLocalStorageItem(LocalStorageKey.OrchestratorWaitNotifications) === "true";
}

export function setOrchestratorWaitNotificationsEnabled(enabled: boolean): void {
	if (enabled === readEnabled()) {
		return;
	}
	writeLocalStorageItem(LocalStorageKey.OrchestratorWaitNotifications, String(enabled));
	for (const listener of listeners) {
		listener();
	}
}

export function getOrchestratorWaitNotificationsEnabled(): boolean {
	return readEnabled();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useOrchestratorWaitNotificationsEnabled(): boolean {
	return useSyncExternalStore(subscribe, readEnabled, readEnabled);
}
