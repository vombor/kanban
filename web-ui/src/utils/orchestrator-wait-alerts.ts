import type { RuntimeOrchestratorWait, RuntimeProjectSummary, RuntimeUserInputWaitKind } from "@/runtime/types";

// The browser side of "a project's orchestrator waits for the user" (issue #10). The runtime decides whether a
// sidebar session waits (src/terminal/user-input-wait.ts) and puts kind + start on each project summary; this module
// only decides what is new to this tab, so a pending request flashes and notifies once.

export interface WaitingProject {
	project: RuntimeProjectSummary;
	wait: RuntimeOrchestratorWait;
	/** One pending request: the same session's next request has another `since`. */
	key: string;
}

const MAX_SEEN_WAIT_KEYS = 200;

export function getOrchestratorWaitKey(projectId: string, wait: RuntimeOrchestratorWait): string {
	return `${projectId}:${wait.kind}:${wait.since}`;
}

export function listWaitingProjects(projects: readonly RuntimeProjectSummary[]): WaitingProject[] {
	const waiting: WaitingProject[] = [];
	for (const project of projects) {
		const wait = project.orchestratorWait;
		if (wait) {
			waiting.push({ project, wait, key: getOrchestratorWaitKey(project.id, wait) });
		}
	}
	return waiting;
}

/**
 * The waits this tab hasn't seen yet, and the seen keys with them added. A key stays seen after its wait clears, so
 * a project list that drops a wait and brings it back (a reconnect, a refresh) doesn't flash it again.
 */
export function takeNewOrchestratorWaits(
	seenKeys: readonly string[],
	waiting: readonly WaitingProject[],
): { added: WaitingProject[]; seenKeys: string[] } {
	const seen = new Set(seenKeys);
	const added = waiting.filter((entry) => !seen.has(entry.key));
	if (added.length === 0) {
		return { added, seenKeys: [...seenKeys] };
	}
	const next = [...seenKeys, ...added.map((entry) => entry.key)];
	return { added, seenKeys: next.slice(Math.max(0, next.length - MAX_SEEN_WAIT_KEYS)) };
}

export function describeOrchestratorWaitKind(kind: RuntimeUserInputWaitKind): string {
	return kind === "approval" ? "needs your approval" : "has a question for you";
}

export function formatOrchestratorWaitNotificationTitle(projectName: string, kind: RuntimeUserInputWaitKind): string {
	return `${projectName}: the Kanban Agent ${describeOrchestratorWaitKind(kind)}`;
}
