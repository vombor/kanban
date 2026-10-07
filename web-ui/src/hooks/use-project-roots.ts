import { useEffect, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export interface ProjectRootsState {
	/** The allowed projects roots (`projects.roots`); the first is the default. */
	roots: string[];
	error: string | null;
	isLoading: boolean;
}

/** Loads the projects roots each time the add-project dialog opens. */
export function useProjectRoots(open: boolean, workspaceId: string | null): ProjectRootsState {
	const [state, setState] = useState<ProjectRootsState>({ roots: [], error: null, isLoading: false });

	useEffect(() => {
		if (!open) {
			return;
		}
		let cancelled = false;
		setState((previous) => ({ ...previous, isLoading: true }));
		void (async () => {
			try {
				const response = await getRuntimeTrpcClient(workspaceId).projects.roots.query();
				if (!cancelled) {
					setState({ roots: response.roots, error: response.error ?? null, isLoading: false });
				}
			} catch (error) {
				if (!cancelled) {
					setState({ roots: [], error: error instanceof Error ? error.message : String(error), isLoading: false });
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, workspaceId]);

	return state;
}
