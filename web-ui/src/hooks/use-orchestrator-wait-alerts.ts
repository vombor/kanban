import { useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeOrchestratorWaitDetail, RuntimeProjectSummary } from "@/runtime/types";
import { fetchOrchestratorWait } from "@/runtime/workspace-state-query";
import { getBrowserNotificationPermission } from "@/utils/notification-permission";
import {
	formatOrchestratorWaitNotificationTitle,
	listWaitingProjects,
	takeNewOrchestratorWaits,
	type WaitingProject,
} from "@/utils/orchestrator-wait-alerts";
import { useLatest, useUnmount } from "@/utils/react-use";

// Badge, flash and notification when any project's orchestrator waits for the user (issue #10). The badge is the
// project summary's `orchestratorWait` itself, so it clears whenever the runtime says the wait is over (the user
// answered, the session runs again or ended). This hook adds what happens once per pending request: a short flash
// of that project's badge and, when the user opted in and the tab is in the background, a desktop notification
// whose click focuses the tab and opens the project's sidebar.

/** How long a new wait's badge flashes (the badge's animation runs three times in it). */
export const ORCHESTRATOR_WAIT_FLASH_MS = 2400;

interface UseOrchestratorWaitAlertsOptions {
	projects: RuntimeProjectSummary[];
	/** The first project list after a (re)load is a baseline: its waits flash but don't notify. */
	hasReceivedSnapshot: boolean;
	notificationsEnabled: boolean;
	onOpenProjectSidebar: (projectId: string) => void;
	/** The question itself, which only the project's workspace-scoped query carries; tests inject it. */
	fetchWaitDetail?: (projectId: string) => Promise<RuntimeOrchestratorWaitDetail | null>;
}

export interface OrchestratorWaitAlerts {
	waitingCount: number;
	flashingProjectIds: ReadonlySet<string>;
}

function isTabInForeground(): boolean {
	return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}

function showOrchestratorWaitNotification(
	entry: WaitingProject,
	detail: RuntimeOrchestratorWaitDetail | null,
	onClick: () => void,
): void {
	try {
		const notification = new Notification(
			formatOrchestratorWaitNotificationTitle(entry.project.name, detail?.kind ?? entry.wait.kind),
			{
				body: detail?.text ?? "",
				tag: `orchestrator-wait-${entry.project.id}`,
				icon: "/assets/icon-notification.png",
			},
		);
		notification.onclick = () => {
			window.focus();
			onClick();
			notification.close();
		};
	} catch {
		// Ignore browser notification failures.
	}
}

export function useOrchestratorWaitAlerts({
	projects,
	hasReceivedSnapshot,
	notificationsEnabled,
	onOpenProjectSidebar,
	fetchWaitDetail = fetchOrchestratorWait,
}: UseOrchestratorWaitAlertsOptions): OrchestratorWaitAlerts {
	const waiting = useMemo(() => listWaitingProjects(projects), [projects]);
	const seenKeysRef = useRef<string[] | null>(null);
	const flashTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	const [flashingProjectIds, setFlashingProjectIds] = useState<ReadonlySet<string>>(() => new Set());
	const latest = useLatest({ notificationsEnabled, onOpenProjectSidebar, fetchWaitDetail });

	useEffect(() => {
		if (!hasReceivedSnapshot) {
			return;
		}
		const isBaseline = seenKeysRef.current === null;
		const { added, seenKeys } = takeNewOrchestratorWaits(seenKeysRef.current ?? [], waiting);
		seenKeysRef.current = seenKeys;
		if (added.length === 0) {
			return;
		}
		setFlashingProjectIds((current) => new Set([...current, ...added.map((entry) => entry.project.id)]));
		for (const entry of added) {
			const projectId = entry.project.id;
			clearTimeout(flashTimersRef.current.get(projectId));
			flashTimersRef.current.set(
				projectId,
				setTimeout(() => {
					flashTimersRef.current.delete(projectId);
					setFlashingProjectIds((current) => {
						const next = new Set(current);
						next.delete(projectId);
						return next;
					});
				}, ORCHESTRATOR_WAIT_FLASH_MS),
			);
		}
		const { notificationsEnabled: enabled, fetchWaitDetail: fetchDetail } = latest.current;
		if (isBaseline || !enabled || getBrowserNotificationPermission() !== "granted" || isTabInForeground()) {
			return;
		}
		for (const entry of added) {
			void fetchDetail(entry.project.id)
				.catch(() => null)
				.then((detail) => {
					// The text is for this request only: a detail of a newer one names what that one asks.
					const current = detail && detail.since === entry.wait.since ? detail : null;
					showOrchestratorWaitNotification(entry, current, () => {
						latest.current.onOpenProjectSidebar(entry.project.id);
					});
				});
		}
	}, [hasReceivedSnapshot, latest, waiting]);

	useUnmount(() => {
		for (const timer of flashTimersRef.current.values()) {
			clearTimeout(timer);
		}
		flashTimersRef.current.clear();
	});

	return { waitingCount: waiting.length, flashingProjectIds };
}
