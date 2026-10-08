// Manages the synthetic home agent session lifecycle for the sidebar.
// It keeps one in-memory session identity stable per workspace while the app
// stays open and rotates it only when the selected agent configuration
// meaningfully changes.

import { createHomeAgentSessionId, isHomeAgentSessionIdForWorkspace } from "@runtime-home-agent-session";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useMemo, useRef } from "react";

import { notifyError } from "@/components/app-toaster";
import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeConfigResponse, RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";

// Every home agent (Cline included) is a CLI that runs in the sidebar terminal.
type HomeAgentPanelMode = "terminal";

interface HomeAgentDescriptor {
	panelMode: HomeAgentPanelMode;
	descriptorKey: string;
	taskId: string;
}

interface UseHomeAgentSessionInput {
	currentProjectId: string | null;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	workspaceGit: RuntimeGitRepositoryInfo | null;
	sessionSummaries: Record<string, RuntimeTaskSessionSummary>;
	setSessionSummaries: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	upsertSessionSummary: (summary: RuntimeTaskSessionSummary) => void;
}

interface UseHomeAgentSessionResult {
	panelMode: HomeAgentPanelMode | null;
	taskId: string | null;
}

interface HomeAgentSessionIdentity {
	workspaceId: string;
	taskId: string;
}

interface HomeAgentWorkspaceDescriptor {
	descriptorKey: string;
	panelMode: HomeAgentPanelMode;
	taskId: string;
}

function buildTerminalDescriptor(config: RuntimeConfigResponse): string {
	return JSON.stringify({
		agentId: config.selectedAgentId,
		command: config.effectiveCommand ?? "",
	});
}

function resolveHomeAgentBaseRef(workspaceGit: RuntimeGitRepositoryInfo | null): string {
	return workspaceGit?.currentBranch ?? workspaceGit?.defaultBranch ?? "HEAD";
}

function pruneWorkspaceHomeAgentSessions(
	setSessionSummaries: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>,
	workspaceId: string,
	keepTaskId: string | null,
): void {
	setSessionSummaries((currentSessions) => {
		let didChange = false;
		const nextSessions: Record<string, RuntimeTaskSessionSummary> = {};

		for (const [taskId, summary] of Object.entries(currentSessions)) {
			if (isHomeAgentSessionIdForWorkspace(taskId, workspaceId) && taskId !== keepTaskId) {
				didChange = true;
				continue;
			}
			nextSessions[taskId] = summary;
		}

		return didChange ? nextSessions : currentSessions;
	});
}

// Whether the session this hook started (or a later one) was stopped by Kanban
// rather than ended by its agent: the server went down with it, or something
// stopped it (the sidebar has no Stop button). Within one server the session
// manager restarts an exited sidebar session itself, but its start request lives
// in memory only, so after a restart nothing starts the sidebar again unless the
// page is reloaded or the watchdog wakes it: the panel stayed black. A start
// that finds a live session (the watchdog's) gets that one back unchanged.
function wasInterruptedSinceStart(summary: RuntimeTaskSessionSummary | null, startedAt: number | null): boolean {
	return (
		summary !== null &&
		summary.state === "interrupted" &&
		summary.pid === null &&
		(summary.startedAt ?? 0) >= (startedAt ?? 0)
	);
}

function buildHomeAgentSessionKey(session: HomeAgentSessionIdentity): string {
	return `${session.workspaceId}:${session.taskId}`;
}

async function stopHomeAgentSession(session: HomeAgentSessionIdentity | null): Promise<void> {
	if (!session) {
		return;
	}
	try {
		await getRuntimeTrpcClient(session.workspaceId).runtime.stopTaskSession.mutate({
			taskId: session.taskId,
		});
	} catch {
		// Ignore stop errors during cleanup.
	}
}

export function useHomeAgentSession({
	currentProjectId,
	runtimeProjectConfig,
	workspaceGit,
	sessionSummaries,
	setSessionSummaries,
	upsertSessionSummary,
}: UseHomeAgentSessionInput): UseHomeAgentSessionResult {
	const latestBaseRefRef = useRef("HEAD");
	const homeDescriptorByWorkspaceRef = useRef(new Map<string, HomeAgentWorkspaceDescriptor>());
	const desiredTaskIdByWorkspaceRef = useRef(new Map<string, string>());
	// Session key -> startedAt of the session this hook started.
	const startedSessionsRef = useRef(new Map<string, number | null>());
	const pendingStartRequestIdsRef = useRef(new Map<string, number>());
	const nextStartRequestIdRef = useRef(0);
	const disposedRef = useRef(false);

	useEffect(() => {
		latestBaseRefRef.current = resolveHomeAgentBaseRef(workspaceGit);
	}, [workspaceGit?.currentBranch, workspaceGit?.defaultBranch]);

	const descriptor = useMemo<HomeAgentDescriptor | null>(() => {
		if (!currentProjectId || !runtimeProjectConfig) {
			return null;
		}

		if (!runtimeProjectConfig.effectiveCommand) {
			return null;
		}
		const panelMode: HomeAgentPanelMode = "terminal";
		const descriptorKey = buildTerminalDescriptor(runtimeProjectConfig);

		const existingDescriptor = homeDescriptorByWorkspaceRef.current.get(currentProjectId);
		if (
			existingDescriptor &&
			existingDescriptor.descriptorKey === descriptorKey &&
			existingDescriptor.panelMode === panelMode
		) {
			return {
				panelMode,
				descriptorKey,
				taskId: existingDescriptor.taskId,
			};
		}

		const taskId = createHomeAgentSessionId(currentProjectId, runtimeProjectConfig.selectedAgentId);
		homeDescriptorByWorkspaceRef.current.set(currentProjectId, {
			descriptorKey,
			panelMode,
			taskId,
		});
		return {
			panelMode,
			descriptorKey,
			taskId,
		};
	}, [currentProjectId, runtimeProjectConfig?.effectiveCommand, runtimeProjectConfig?.selectedAgentId]);

	const descriptorTaskId = descriptor?.taskId ?? null;
	const hasLoadedRuntimeProjectConfig = runtimeProjectConfig !== null;

	useEffect(() => {
		if (!currentProjectId || !hasLoadedRuntimeProjectConfig) {
			return;
		}

		const previousTaskId = desiredTaskIdByWorkspaceRef.current.get(currentProjectId) ?? null;

		if (!descriptorTaskId) {
			if (!previousTaskId) {
				return;
			}

			homeDescriptorByWorkspaceRef.current.delete(currentProjectId);
			desiredTaskIdByWorkspaceRef.current.delete(currentProjectId);
			startedSessionsRef.current.delete(
				buildHomeAgentSessionKey({
					workspaceId: currentProjectId,
					taskId: previousTaskId,
				}),
			);
			pruneWorkspaceHomeAgentSessions(setSessionSummaries, currentProjectId, null);
			void stopHomeAgentSession({
				workspaceId: currentProjectId,
				taskId: previousTaskId,
			});
			return;
		}

		if (previousTaskId === descriptorTaskId) {
			return;
		}

		desiredTaskIdByWorkspaceRef.current.set(currentProjectId, descriptorTaskId);
		pruneWorkspaceHomeAgentSessions(setSessionSummaries, currentProjectId, descriptorTaskId);

		if (!previousTaskId) {
			return;
		}

		startedSessionsRef.current.delete(
			buildHomeAgentSessionKey({
				workspaceId: currentProjectId,
				taskId: previousTaskId,
			}),
		);
		void stopHomeAgentSession({
			workspaceId: currentProjectId,
			taskId: previousTaskId,
		});
	}, [currentProjectId, descriptorTaskId, hasLoadedRuntimeProjectConfig, setSessionSummaries]);

	useEffect(() => {
		if (!currentProjectId || !descriptor) {
			return;
		}

		const session = {
			workspaceId: currentProjectId,
			taskId: descriptor.taskId,
		} satisfies HomeAgentSessionIdentity;
		const sessionKey = buildHomeAgentSessionKey(session);

		if (desiredTaskIdByWorkspaceRef.current.get(session.workspaceId) !== session.taskId) {
			return;
		}

		const startedAt = startedSessionsRef.current.get(sessionKey);
		if (startedAt !== undefined) {
			if (!wasInterruptedSinceStart(sessionSummaries[session.taskId] ?? null, startedAt)) {
				return;
			}
			// Start it again below.
			startedSessionsRef.current.delete(sessionKey);
		}

		if (pendingStartRequestIdsRef.current.has(sessionKey)) {
			return;
		}

		const requestId = nextStartRequestIdRef.current + 1;
		nextStartRequestIdRef.current = requestId;
		pendingStartRequestIdsRef.current.set(sessionKey, requestId);

		void (async () => {
			try {
				const geometry = estimateTaskSessionGeometry(window.innerWidth, window.innerHeight);
				const trpcClient = getRuntimeTrpcClient(session.workspaceId);
				const response = await trpcClient.runtime.startTaskSession.mutate({
					taskId: session.taskId,
					prompt: "",
					baseRef: latestBaseRefRef.current,
					cols: geometry.cols,
					rows: geometry.rows,
				});

				if (!response.ok || !response.summary) {
					throw new Error(response.error ?? "Could not start home agent session.");
				}

				if (pendingStartRequestIdsRef.current.get(sessionKey) !== requestId) {
					return;
				}
				pendingStartRequestIdsRef.current.delete(sessionKey);

				if (desiredTaskIdByWorkspaceRef.current.get(session.workspaceId) !== session.taskId) {
					await stopHomeAgentSession(session);
					return;
				}

				if (disposedRef.current) {
					return;
				}

				startedSessionsRef.current.set(sessionKey, response.summary.startedAt);
				upsertSessionSummary(response.summary);
			} catch (error) {
				if (pendingStartRequestIdsRef.current.get(sessionKey) !== requestId) {
					return;
				}
				pendingStartRequestIdsRef.current.delete(sessionKey);
				if (
					disposedRef.current ||
					desiredTaskIdByWorkspaceRef.current.get(session.workspaceId) !== session.taskId
				) {
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				notifyError(message);
			}
		})();
	}, [currentProjectId, descriptor, sessionSummaries, upsertSessionSummary]);

	useEffect(() => {
		return () => {
			disposedRef.current = true;
			desiredTaskIdByWorkspaceRef.current.clear();
			homeDescriptorByWorkspaceRef.current.clear();
			startedSessionsRef.current.clear();
			pendingStartRequestIdsRef.current.clear();
		};
	}, []);

	return {
		panelMode: descriptor?.panelMode ?? null,
		taskId: descriptor?.taskId ?? null,
	};
}
