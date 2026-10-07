import { validateProjectDirectoryName } from "@runtime-project-paths";
import { useEffect, useRef, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useDebouncedEffect } from "@/utils/react-use";

export const PROJECT_NAME_CHECK_DEBOUNCE_MS = 250;

export type ProjectNameCheckStatus =
	| { kind: "idle" }
	| { kind: "invalid"; message: string }
	| { kind: "checking" }
	| { kind: "available" }
	| { kind: "exists-empty" }
	| { kind: "exists"; isGitRepository: boolean }
	| { kind: "error"; message: string };

/** New and empty directories can take a new project or a clone; everything else blocks the button. */
export function isProjectNameUsable(status: ProjectNameCheckStatus): boolean {
	return status.kind === "available" || status.kind === "exists-empty";
}

/**
 * Advisory typeahead for `<root>/<name>`: validates the name locally, then asks the server (debounced) whether the
 * directory exists. The server checks again on create, so a stale "available" can never create over something.
 */
export function useProjectNameCheck(input: {
	root: string | null;
	name: string;
	workspaceId: string | null;
	enabled: boolean;
}): ProjectNameCheckStatus {
	const { root, name, workspaceId, enabled } = input;
	const key = root ? `${root}\u0000${name}` : null;
	const localError = validateProjectDirectoryName(name);
	const [result, setResult] = useState<{ key: string; status: ProjectNameCheckStatus } | null>(null);
	const requestIdRef = useRef(0);

	useEffect(() => {
		// A new key invalidates any answer still in flight for the old one.
		requestIdRef.current += 1;
	}, [key]);

	useDebouncedEffect(
		() => {
			if (!enabled || !root || !key || localError) {
				return;
			}
			const requestId = ++requestIdRef.current;
			void (async () => {
				let status: ProjectNameCheckStatus;
				try {
					const response = await getRuntimeTrpcClient(workspaceId).projects.checkName.query({ root, name });
					if (!response.ok) {
						status = { kind: "error", message: response.error ?? "Could not check this name." };
					} else if (!response.exists) {
						status = { kind: "available" };
					} else if (response.isEmpty) {
						status = { kind: "exists-empty" };
					} else {
						status = { kind: "exists", isGitRepository: response.isGitRepository };
					}
				} catch (error) {
					status = { kind: "error", message: error instanceof Error ? error.message : String(error) };
				}
				if (requestId === requestIdRef.current) {
					setResult({ key, status });
				}
			})();
		},
		PROJECT_NAME_CHECK_DEBOUNCE_MS,
		[enabled, key, localError, workspaceId],
	);

	if (!enabled || !root) {
		return { kind: "idle" };
	}
	if (localError) {
		return name.length === 0 ? { kind: "idle" } : { kind: "invalid", message: localError };
	}
	return result?.key === key ? result.status : { kind: "checking" };
}
