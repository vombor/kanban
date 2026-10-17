import { getWorkspacePipelineSettings, readPipelineConfig } from "../config/pipeline-config";
import { readProjectProviderConcurrency, readProviderConcurrency } from "../config/provider-concurrency-setting";
import type { RuntimeTaskSessionStartResponse } from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { getDispatchProvider } from "../core/dispatch-provider";
import { isHomeAgentSessionId, isHomeAgentSessionIdForWorkspace } from "../core/home-agent-session";
import { mergeProviderConcurrency } from "../core/provider-concurrency";
import { providerStartFingerprint } from "../core/provider-start-intent";
import { moveTaskToColumn } from "../core/task-board-mutations";
import { isLocalProvider } from "../kits/team/bench/prices";
import { manualReviewHoldReason } from "../pipeline/manual-review";
import { createPipelineStateStore } from "../pipeline/pipeline-state";
import { createProviderUsageHolds } from "../pipeline/provider-usage-holds";
import { readLegacyProviderUsageHolds } from "../pipeline/provider-usage-holds-legacy";
import { readQaGateEntry } from "../pipeline/qa-gate";
import { listWorkspaceIndexEntries, loadWorkspaceBoardById, mutateWorkspaceState } from "../state/workspace-state";
import { isReviewSettled } from "../terminal/review-settle";
import { createProviderDispatcher, type ProviderActivity, type ProviderStartIntent } from "./provider-dispatcher";
import type { WorkspaceRegistry } from "./workspace-registry";

export function createProviderDispatchRuntime(deps: {
	registry: WorkspaceRegistry;
	launch: (intent: ProviderStartIntent, signal: AbortSignal) => Promise<RuntimeTaskSessionStartResponse>;
	broadcast: (workspaceId: string) => Promise<void>;
	log: (message: string) => void;
}) {
	const store = createPipelineStateStore();
	const holds = createProviderUsageHolds({ readLegacy: readLegacyProviderUsageHolds });
	const workspaceIds = async () => (await listWorkspaceIndexEntries()).map((entry) => entry.workspaceId);
	const resources = (provider: string | null, qa: boolean) => [
		provider ? `provider:${provider}` : "provider:*",
		...(qa && !isLocalProvider(provider) ? ["qa:cloud"] : []),
	];
	const activity = async (): Promise<ProviderActivity[]> => {
		const result: ProviderActivity[] = [];
		const { config } = await readPipelineConfig();
		for (const workspace of deps.registry.listManagedWorkspaces()) {
			const manager = deps.registry.getTerminalManagerForWorkspace(workspace.workspaceId);
			if (!manager) continue;
			const board = await loadWorkspaceBoardById(workspace.workspaceId);
			const state = await store.peek(workspace.workspaceId);
			for (const session of manager.listSummaries()) {
				if (!manager.hasLiveProcess(session.taskId)) continue;
				if (session.dispatchPromptSubmitted === false && (session.lastHookAt ?? 0) <= (session.startedAt ?? 0))
					continue;
				const card = board.columns.flatMap((column) => column.cards).find((card) => card.id === session.taskId);
				if (!card && !isHomeAgentSessionId(session.taskId)) continue;
				const provider = getDispatchProvider(
					session.agentId,
					session.providerId ? { providerId: session.providerId } : card?.agentSettings,
				);
				const modelActive = session.state === "running" || !isReviewSettled(session, Date.now());
				const qa = readQaGateEntry(state?.cards[session.taskId]);
				const column = board.columns.find((column) => column.cards.some((card) => card.id === session.taskId))?.id;
				const paused = getWorkspacePipelineSettings(config, workspace.workspaceId).pipeline.paused;
				const cloudHeld =
					!isLocalProvider(provider) &&
					Boolean(card && resolveCardRole(card) === "qa") &&
					(qa
						? (qa.status === "queued" && modelActive) ||
							(qa.status === "running" &&
								qa.timedOutAt === null &&
								(column === "in_progress" || (column === "review" && !paused)))
						: modelActive);
				if (modelActive || cloudHeld)
					result.push({
						key: `${workspace.workspaceId}\0${session.taskId}`,
						resources: [...(modelActive ? resources(provider, false) : []), ...(cloudHeld ? ["qa:cloud"] : [])],
					});
			}
		}
		return result;
	};
	const admission = async (intent: ProviderStartIntent) => {
		await holds.ready();
		await holds.refresh?.();
		const { config } = await readPipelineConfig();
		const provider = getDispatchProvider(intent.body.agentId, intent.body.agentSettings);
		const board = await loadWorkspaceBoardById(intent.workspaceId);
		const card = board.columns.flatMap((column) => column.cards).find((card) => card.id === intent.taskId);
		const state = await store.peek(intent.workspaceId);
		const qa = card && resolveCardRole(card) === "qa";
		const entry = readQaGateEntry(state?.cards[intent.taskId]);
		const settings = getWorkspacePipelineSettings(config, intent.workspaceId);
		const paused =
			!deps.registry.getTerminalManagerForWorkspace(intent.workspaceId) ||
			(qa && !intent.explicit && settings.pipeline.paused && !entry?.evidenceOnly);
		return {
			provider,
			resources: resources(provider, Boolean(qa)),
			until: paused
				? Number.MAX_SAFE_INTEGER
				: provider
					? holds.until(provider, Date.now())
					: Math.max(0, ...Object.values(holds.active?.(Date.now()) ?? {})) || null,
		};
	};
	const dispatcher = createProviderDispatcher({
		workspaceIds,
		activity,
		admission,
		limits: async () => {
			const { config } = await readPipelineConfig();
			const values = [await readProviderConcurrency()];
			values.push(...(await readProjectProviderConcurrency(await workspaceIds())));
			return {
				...Object.fromEntries(
					Object.entries(mergeProviderConcurrency(values)).map(([provider, cap]) => [`provider:${provider}`, cap]),
				),
				"qa:cloud": config.pipeline.qa.slots,
			};
		},
		valid: async (intent) => {
			if (isHomeAgentSessionId(intent.taskId))
				return (
					isHomeAgentSessionIdForWorkspace(intent.taskId, intent.workspaceId) &&
					Boolean((await listWorkspaceIndexEntries()).find((entry) => entry.workspaceId === intent.workspaceId))
				);
			const board = await loadWorkspaceBoardById(intent.workspaceId);
			const column = board.columns.find((column) => column.cards.some((card) => card.id === intent.taskId));
			const card = column?.cards.find((card) => card.id === intent.taskId);
			if (!card || column?.id === "trash" || providerStartFingerprint(card) !== intent.fingerprint) return false;
			const state = await store.peek(intent.workspaceId);
			if (manualReviewHoldReason(state?.cards[card.id])) return false;
			const qa = readQaGateEntry(state?.cards[card.id]);
			if (qa && (qa.status === "superseded" || qa.status === "ingested")) return false;
			if (qa && !qa.evidenceOnly && manualReviewHoldReason(state?.cards[qa.reviewsTaskId])) return false;
			return true;
		},
		execute: async (intent, signal) => {
			return await deps.launch(intent, signal);
		},
		queued: async (intent, decision) => {
			if (isHomeAgentSessionId(intent.taskId)) return;
			await mutateWorkspaceState(
				(await listWorkspaceIndexEntries()).find((entry) => entry.workspaceId === intent.workspaceId)?.repoPath ??
					"",
				(state) => {
					const columns = state.board.columns.map((column) => ({
						...column,
						cards: column.cards.map((card) =>
							card.id === intent.taskId
								? {
										...card,
										providerQueue: {
											providerId: decision.provider,
											requestedAt: intent.at,
											until: decision.until === Number.MAX_SAFE_INTEGER ? null : decision.until,
										},
									}
								: card,
						),
					}));
					return { board: { ...state.board, columns }, value: null };
				},
			);
			await deps.broadcast(intent.workspaceId);
		},
		finished: async (intent, result) => {
			if (isHomeAgentSessionId(intent.taskId)) return;
			const repo = (await listWorkspaceIndexEntries()).find(
				(entry) => entry.workspaceId === intent.workspaceId,
			)?.repoPath;
			if (!repo) return;
			await mutateWorkspaceState(repo, (state) => {
				const board =
					result?.ok && result.summary
						? moveTaskToColumn(state.board, intent.taskId, "in_progress", result.summary.updatedAt - 1).board
						: state.board;
				const columns = board.columns.map((column) => ({
					...column,
					cards: column.cards.map((card) => {
						if (card.id !== intent.taskId) return card;
						const { providerQueue: _queue, ...rest } = card;
						return rest;
					}),
				}));
				return { board: { ...board, columns }, value: null };
			});
			await deps.broadcast(intent.workspaceId);
		},
		log: deps.log,
	});
	return { ...dispatcher, admission };
}
