import { useCallback, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export interface ProjectRenameState {
	isSaving: boolean;
	error: string | null;
	clearError: () => void;
	/** Sets the project's display name (empty = drop it, the directory name is shown); true once the server took it. */
	rename: (projectId: string, name: string) => Promise<boolean>;
}

/** The project menu's Rename: the server's `projectName.set` (src/trpc/project-name-api.ts) decides and validates. */
export function useProjectRename(): ProjectRenameState {
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const rename = useCallback(async (projectId: string, name: string): Promise<boolean> => {
		const trimmed = name.trim();
		setIsSaving(true);
		setError(null);
		try {
			const response = await getRuntimeTrpcClient(projectId).projectName.set.mutate({
				name: trimmed.length > 0 ? trimmed : null,
			});
			if (!response.ok) {
				setError(response.error ?? "The project could not be renamed.");
				return false;
			}
			return true;
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
			return false;
		} finally {
			setIsSaving(false);
		}
	}, []);

	const clearError = useCallback(() => setError(null), []);
	return { isSaving, error, clearError, rename };
}
