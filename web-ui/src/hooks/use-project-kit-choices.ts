import { useEffect, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeProjectKitChoice, RuntimeProjectKitPresetChoice } from "@/runtime/types";

export interface ProjectKitChoicesState {
	/** The kits a new project may start on (src/kits/kit-choices.ts), `default` first. */
	kits: RuntimeProjectKitChoice[];
	defaultKitName: string;
	/** The kit whose models come from `presets` or a custom team. */
	teamKitName: string;
	presets: RuntimeProjectKitPresetChoice[];
	error: string | null;
	isLoading: boolean;
}

const FALLBACK_KIT_NAME = "default";
const FALLBACK_TEAM_KIT_NAME = "team";

/** Loads the kit choices each time the add-project dialog opens. */
export function useProjectKitChoices(open: boolean, workspaceId: string | null): ProjectKitChoicesState {
	const [state, setState] = useState<ProjectKitChoicesState>({
		kits: [],
		defaultKitName: FALLBACK_KIT_NAME,
		teamKitName: FALLBACK_TEAM_KIT_NAME,
		presets: [],
		error: null,
		isLoading: false,
	});

	useEffect(() => {
		if (!open) {
			return;
		}
		let cancelled = false;
		setState((previous) => ({ ...previous, isLoading: true }));
		void (async () => {
			try {
				const response = await getRuntimeTrpcClient(workspaceId).projects.kits.query();
				if (!cancelled) {
					setState({
						kits: response.kits,
						defaultKitName: response.defaultKitName,
						teamKitName: response.teamKitName,
						presets: response.presets,
						error: response.error ?? null,
						isLoading: false,
					});
				}
			} catch (error) {
				if (!cancelled) {
					setState({
						kits: [],
						defaultKitName: FALLBACK_KIT_NAME,
						teamKitName: FALLBACK_TEAM_KIT_NAME,
						presets: [],
						error: error instanceof Error ? error.message : String(error),
						isLoading: false,
					});
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, workspaceId]);

	return state;
}
