import { useCallback, useEffect, useMemo, useRef } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeWorkspaceChangesMode,
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceFileChange,
} from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { retainWorkspaceDiffFiles } from "@/runtime/workspace-diff-identity";

export interface UseRuntimeWorkspaceChangesResult {
	changes: RuntimeWorkspaceChangesResponse | null;
	isLoading: boolean;
	isRuntimeAvailable: boolean;
	refresh: () => Promise<void>;
}

export function useRuntimeWorkspaceChanges(
	taskId: string | null,
	workspaceId: string | null,
	baseRef: string | null,
	mode: RuntimeWorkspaceChangesMode = "working_copy",
	stateVersion = 0,
	pollIntervalMs: number | null = null,
	viewKey: string | null = null,
	clearOnViewTransition = true,
	active = true,
): UseRuntimeWorkspaceChangesResult {
	const hasWorkspaceScope = active && taskId !== null && workspaceId !== null && baseRef !== null;
	const normalizedViewKey = viewKey ?? "__default__";
	const requestKey = JSON.stringify([workspaceId, taskId, baseRef, mode, normalizedViewKey]);
	const previousRequestKeyRef = useRef(requestKey);
	const isRequestTransitioning = previousRequestKeyRef.current !== requestKey;
	const queryFn = useMemo(() => {
		let previousFiles: RuntimeWorkspaceFileChange[] | null = null;
		let latestRequest = 0;
		return async () => {
			if (!taskId || !workspaceId || !baseRef) {
				throw new Error("Missing workspace scope.");
			}
			void normalizedViewKey;
			const trpcClient = getRuntimeTrpcClient(workspaceId);
			const request = ++latestRequest;
			const response = await trpcClient.workspace.getChanges.query({
				taskId,
				baseRef,
				mode,
			});
			// Older concurrent polls must not replace the identity baseline of a newer response.
			if (request !== latestRequest) return response;
			const files = retainWorkspaceDiffFiles(previousFiles, response.files);
			previousFiles = files;
			return { ...response, files };
		};
	}, [baseRef, mode, normalizedViewKey, taskId, workspaceId]);
	const changesQuery = useTrpcQuery<RuntimeWorkspaceChangesResponse>({
		enabled: hasWorkspaceScope,
		queryFn,
	});

	const refresh = useCallback(async () => {
		if (!hasWorkspaceScope) {
			return;
		}
		await changesQuery.refetch();
	}, [changesQuery.refetch, hasWorkspaceScope]);
	const previousStateVersionRef = useRef(stateVersion);

	useEffect(() => {
		if (!isRequestTransitioning || !active) {
			return;
		}
		previousRequestKeyRef.current = requestKey;
		if (clearOnViewTransition) {
			changesQuery.setData(null);
		}
	}, [active, changesQuery.setData, clearOnViewTransition, isRequestTransitioning, requestKey]);

	useEffect(() => {
		if (!hasWorkspaceScope) {
			if (active) previousRequestKeyRef.current = requestKey;
			previousStateVersionRef.current = stateVersion;
			return;
		}
		if (previousStateVersionRef.current === stateVersion) {
			return;
		}
		previousStateVersionRef.current = stateVersion;
		void changesQuery.refetch();
	}, [active, changesQuery.refetch, hasWorkspaceScope, requestKey, stateVersion]);

	useEffect(() => {
		if (!hasWorkspaceScope || pollIntervalMs == null) {
			return;
		}
		const interval = window.setInterval(() => {
			void changesQuery.refetch();
		}, pollIntervalMs);
		return () => {
			window.clearInterval(interval);
		};
	}, [changesQuery.refetch, hasWorkspaceScope, pollIntervalMs]);

	if (!taskId) {
		return {
			changes: null,
			isLoading: false,
			isRuntimeAvailable: true,
			refresh,
		};
	}

	if (!workspaceId) {
		return {
			changes: null,
			isLoading: false,
			isRuntimeAvailable: false,
			refresh,
		};
	}

	const shouldHideDuringTransition = clearOnViewTransition && isRequestTransitioning;
	const visibleChanges = shouldHideDuringTransition ? null : changesQuery.data;
	const visibleIsLoading = shouldHideDuringTransition || changesQuery.isLoading;
	const visibleIsRuntimeAvailable = shouldHideDuringTransition ? true : !changesQuery.isError;

	return {
		changes: visibleChanges,
		isLoading: visibleIsLoading,
		isRuntimeAvailable: visibleIsRuntimeAvailable,
		refresh,
	};
}
