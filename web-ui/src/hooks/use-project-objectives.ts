import type {
	ObjectiveControlRequest,
	ObjectiveCreate,
	ObjectiveLimitsChange,
	ObjectiveManualLineage,
	ObjectiveReadResponse,
	RuntimeObjective,
} from "@runtime-objectives";
import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useInterval } from "@/utils/react-use";

const PAGE_SIZE = 20;
interface ObjectiveView {
	workspaceId: string;
	objectives: RuntimeObjective[];
	offset: number;
	total: number;
	selectedId: string | null;
	detail: ObjectiveReadResponse | null;
	loading: boolean;
	reading: boolean;
	busy: boolean;
	listError: string | null;
	detailError: string | null;
}
const empty = (workspaceId: string): ObjectiveView => ({
	workspaceId,
	objectives: [],
	offset: 0,
	total: 0,
	selectedId: null,
	detail: null,
	loading: true,
	reading: false,
	busy: false,
	listError: null,
	detailError: null,
});

/** Independent scope/request fences protect private evidence. Only a user recheck writes; polling is read-only. */
export function useProjectObjectives(workspaceId: string) {
	const [state, setState] = useState<ObjectiveView>(() => empty(workspaceId));
	const scope = useRef({ workspaceId, alive: false });
	if (scope.current.workspaceId !== workspaceId) scope.current = { workspaceId, alive: false };
	const token = scope.current;
	const listGeneration = useRef(0),
		detailGeneration = useRef(0);
	const selected = useRef<string | null>(null),
		writing = useRef(false);
	const retryOperation = useRef<(() => Promise<RuntimeObjective>) | null>(null);
	const [retryAvailable, setRetryAvailable] = useState(false);
	const current = useCallback(() => scope.current === token && token.alive, [token]);
	const refresh = useCallback(
		async (offset = 0) => {
			if (!current()) return;
			const generation = ++listGeneration.current;
			setState((view) => ({ ...view, offset, loading: true, listError: null }));
			try {
				const result = await getRuntimeTrpcClient(workspaceId).objectives.list.query({ offset, limit: PAGE_SIZE });
				if (current() && generation === listGeneration.current)
					setState((view) => ({ ...view, objectives: result.objectives, total: result.total, loading: false }));
			} catch {
				if (current() && generation === listGeneration.current)
					setState((view) => ({
						...view,
						objectives: [],
						loading: false,
						listError: "Could not load this project's objectives. Evidence and saved limits are unchanged.",
					}));
			}
		},
		[workspaceId, current],
	);
	const read = useCallback(
		async (id: string, replace: boolean) => {
			if (!current() || writing.current) return;
			selected.current = id;
			const generation = ++detailGeneration.current;
			setState((view) => ({
				...view,
				selectedId: id,
				detail: replace ? null : view.detail,
				reading: true,
				detailError: null,
			}));
			try {
				const result = await getRuntimeTrpcClient(workspaceId).objectives.read.query({ id });
				if (current() && generation === detailGeneration.current)
					setState((view) => ({ ...view, detail: result, reading: false }));
			} catch {
				if (current() && generation === detailGeneration.current)
					setState((view) => ({
						...view,
						reading: false,
						detailError:
							"Could not refresh pinned objective evidence. Any visible details are the last retained response, not newly verified acceptance.",
					}));
			}
		},
		[workspaceId, current],
	);
	useEffect(() => {
		token.alive = true;
		selected.current = null;
		writing.current = false;
		retryOperation.current = null;
		setRetryAvailable(false);
		setState(empty(workspaceId));
		void refresh();
		return () => {
			token.alive = false;
			listGeneration.current++;
			detailGeneration.current++;
		};
	}, [token, workspaceId, refresh]);
	useInterval(() => {
		if (document.visibilityState !== "hidden" && !writing.current && !state.loading && !state.reading) {
			void refresh(state.offset);
			if (selected.current) void read(selected.current, false);
		}
	}, 15000);
	const recheck = async () => {
		const id = selected.current;
		if (!current() || !id || writing.current || state.reading) return;
		writing.current = true;
		const generation = ++detailGeneration.current;
		setState((view) => ({ ...view, busy: true, detailError: null }));
		try {
			const result = await getRuntimeTrpcClient(workspaceId).objectives.recheck.mutate({ id });
			if (current() && generation === detailGeneration.current) {
				setState((view) => ({ ...view, detail: result }));
				await refresh(state.offset);
			}
		} catch {
			if (current() && generation === detailGeneration.current)
				setState((view) => ({
					...view,
					detailError:
						"Recheck could not be confirmed. Inspect the latest evidence before retrying; no work was started and no guard was overridden.",
				}));
		} finally {
			if (current()) {
				writing.current = false;
				setState((view) => ({ ...view, busy: false }));
			}
		}
	};
	const view = state.workspaceId === workspaceId ? state : empty(workspaceId);
	const mutate = async (operation: () => Promise<RuntimeObjective>): Promise<boolean> => {
		if (!current() || writing.current || state.reading) return false;
		writing.current = true;
		retryOperation.current = operation;
		setRetryAvailable(false);
		const generation = ++detailGeneration.current;
		setState((view) => ({ ...view, busy: true, detailError: null }));
		try {
			const objective = await operation();
			if (!current()) return false;
			const detail = await getRuntimeTrpcClient(workspaceId).objectives.read.query({ id: objective.id });
			if (current() && generation === detailGeneration.current) {
				selected.current = objective.id;
				setState((view) => ({ ...view, selectedId: objective.id, detail }));
				await refresh(state.offset);
				retryOperation.current = null;
				setRetryAvailable(false);
			}
			return true;
		} catch {
			if (current() && generation === detailGeneration.current) {
				setRetryAvailable(true);
				setState((view) => ({
					...view,
					detailError:
						"Objective mutation could not be confirmed or its revision changed. Inspect retained state; exact retry uses the same request identity and cannot duplicate a confirmed change.",
				}));
			}
			return false;
		} finally {
			if (current()) {
				writing.current = false;
				setState((view) => ({ ...view, busy: false }));
			}
		}
	};
	return {
		...view,
		error: view.detailError ?? view.listError,
		refresh: () => refresh(view.offset),
		select: (id: string) => read(id, true),
		recheck,
		retryAvailable: state.workspaceId === workspaceId && retryAvailable,
		retry: () => (retryOperation.current ? mutate(retryOperation.current) : Promise.resolve(false)),
		create: (input: ObjectiveCreate) =>
			mutate(() => getRuntimeTrpcClient(workspaceId).objectives.create.mutate(input)),
		limits: (input: ObjectiveLimitsChange) =>
			mutate(() => getRuntimeTrpcClient(workspaceId).objectives.setLimits.mutate(input)),
		control: (input: ObjectiveControlRequest) =>
			mutate(() => getRuntimeTrpcClient(workspaceId).objectives.control.mutate(input)),
		link: (input: ObjectiveManualLineage) =>
			mutate(() => getRuntimeTrpcClient(workspaceId).objectives.manualLineage.mutate(input)),
		previous: () => refresh(Math.max(0, view.offset - PAGE_SIZE)),
		next: () => refresh(view.offset + PAGE_SIZE),
	};
}
