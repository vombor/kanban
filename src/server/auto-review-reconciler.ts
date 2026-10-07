// Reconciles auto-review state inside the runtime instead of a browser tab.
//
// The browser implementation lived in a React effect and lost pending git
// actions on unmount, reload, or project switch. This module observes durable
// state (the board card's `pendingGitAction` field) and corrects the
// difference each cycle, so auto-review keeps running with no client
// connected and recovers armed cards after a restart.
//
// Git metadata is probed on demand: each cycle selects candidate cards from
// the board first, then probes only the worktrees of those candidates. A
// workspace with no auto-review candidates costs zero git work.

import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskGitAction,
	RuntimeTaskPendingGitAction,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { resolveEffectiveAgent } from "../core/effective-agent";
import { isPendingGitActionStale } from "../core/task-board-mutations";
import { type DeliverTaskInputResult, deliverTaskInput } from "../terminal/deliver-task-input";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { probeGitWorkspaceState } from "../workspace/git-sync";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import type { MutateWorkspaceState, TaskTrashWorkflow } from "./task-trash-workflow";

export type { MutateWorkspaceState } from "./task-trash-workflow";

/**
 * Evaluation cadence. Nothing here is latency critical: a slower interval
 * bounds the git-probe cost while still advancing cards promptly.
 */
const AUTO_REVIEW_EVALUATION_INTERVAL_MS = 5_000;

const AUTO_REVIEW_BASE_REF_TOKEN = "{{base_ref}}";

export interface TaskGitPromptTemplates {
	commitPromptTemplate?: string | null;
	openPrPromptTemplate?: string | null;
	commitPromptTemplateDefault?: string | null;
	openPrPromptTemplateDefault?: string | null;
}

export interface AutoReviewWorkspace {
	workspaceId: string;
	workspacePath: string | null;
	terminalManager: TerminalSessionManager | null;
}

/** Git metadata for one task worktree, probed on demand. */
export interface AutoReviewTaskProbe {
	exists: boolean;
	headCommit: string | null;
	changedFiles: number;
}

export interface CreateAutoReviewReconcilerDependencies {
	listWorkspaces: () => AutoReviewWorkspace[];
	getWorkspaceState: (workspaceId: string, workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
	mutateWorkspaceState: MutateWorkspaceState;
	getPromptTemplates: (workspaceId: string, workspacePath: string) => Promise<TaskGitPromptTemplates | null>;
	/** Workspace-level default agent; cards may override it via `agentId`. */
	getSelectedAgentId?: (workspaceId: string, workspacePath: string) => Promise<RuntimeAgentId | null>;
	/** Types the git action prompt into the task session; injected in tests. */
	deliverTaskInput?: typeof deliverTaskInput;
	/** Probes one task worktree; injected in tests to count calls. */
	probeTaskWorkspace?: (input: {
		workspacePath: string;
		taskId: string;
		baseRef: string;
	}) => Promise<AutoReviewTaskProbe>;
	/**
	 * Notified after the reconciler mutates a board so connected browsers can
	 * resync. Optional: reconciliation is correct without it, browsers just
	 * observe the change later.
	 */
	onBoardMutated?: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	/** The shared Done workflow (src/server/task-trash-workflow.ts); completes armed cards. */
	trashTask: TaskTrashWorkflow["trashTask"];
	evaluationIntervalMs?: number;
	now?: () => number;
	warn?: (message: string) => void;
}

export interface AutoReviewReconciler {
	/** Starts the evaluation cadence for every workspace managed by the runtime. */
	start: () => Promise<void>;
	/** Ensures a newly tracked workspace is picked up without waiting for the next cycle. */
	trackWorkspace: (workspaceId: string) => void;
	/** Stops tracking a workspace that was removed from the runtime. */
	untrackWorkspace: (workspaceId: string) => void;
	/** Runs one reconciliation cycle for a workspace. */
	evaluateWorkspace: (workspaceId: string) => Promise<void>;
	close: () => void;
}

interface ReconcilerWorkspaceRuntime {
	evaluationPromise: Promise<void> | null;
	pendingEvaluation: boolean;
	gitActionInFlightTaskIds: Set<string>;
	deliveryAborts: Set<AbortController>;
}

function createWorkspaceRuntime(): ReconcilerWorkspaceRuntime {
	return {
		evaluationPromise: null,
		pendingEvaluation: false,
		gitActionInFlightTaskIds: new Set<string>(),
		deliveryAborts: new Set<AbortController>(),
	};
}

function resolveAutoReviewMode(card: RuntimeBoardCard): RuntimeTaskGitAction {
	return card.autoReviewMode === "pr" ? "pr" : "commit";
}

/**
 * The cards this reconciler types a commit/PR prompt into. A `qa`-mode card belongs to the pipeline (it QA-gates
 * the card and Kanban lands it), and QA, TRIAGE and calibration cards are never auto-reviewed (plan §3.6).
 */
function isGitActionCard(card: RuntimeBoardCard): boolean {
	return card.autoReviewEnabled === true && card.autoReviewMode !== "qa" && (card.role ?? "dev") === "dev";
}

function resolvePromptTemplate(action: RuntimeTaskGitAction, templates: TaskGitPromptTemplates | null): string {
	if (action === "commit") {
		const template = templates?.commitPromptTemplate?.trim();
		if (template) {
			return template;
		}
		const defaultTemplate = templates?.commitPromptTemplateDefault?.trim();
		if (defaultTemplate) {
			return defaultTemplate;
		}
		return "Handle this commit action using the provided git context.";
	}
	const template = templates?.openPrPromptTemplate?.trim();
	if (template) {
		return template;
	}
	const defaultTemplate = templates?.openPrPromptTemplateDefault?.trim();
	if (defaultTemplate) {
		return defaultTemplate;
	}
	return "Handle this pull request action using the provided git context.";
}

function buildGitActionPrompt(
	action: RuntimeTaskGitAction,
	baseRef: string,
	templates: TaskGitPromptTemplates | null,
): string {
	return resolvePromptTemplate(action, templates).replaceAll(AUTO_REVIEW_BASE_REF_TOKEN, baseRef);
}

interface CardLocation {
	columnId: RuntimeBoardColumnId;
	card: RuntimeBoardCard;
}

function findCardLocation(board: RuntimeBoardData, taskId: string): CardLocation | null {
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (card.id === taskId) {
				return { columnId: column.id, card };
			}
		}
	}
	return null;
}

function replaceBoardCard(board: RuntimeBoardData, taskId: string, nextCard: RuntimeBoardCard): RuntimeBoardData {
	return {
		...board,
		columns: board.columns.map((column) => {
			if (!column.cards.some((card) => card.id === taskId)) {
				return column;
			}
			return {
				...column,
				cards: column.cards.map((card) => (card.id === taskId ? nextCard : card)),
			};
		}),
	};
}

async function defaultProbeTaskWorkspace(input: {
	workspacePath: string;
	taskId: string;
	baseRef: string;
}): Promise<AutoReviewTaskProbe> {
	const pathInfo = await getTaskWorkspacePathInfo({
		cwd: input.workspacePath,
		taskId: input.taskId,
		baseRef: input.baseRef,
	});
	if (!pathInfo.exists) {
		return { exists: false, headCommit: null, changedFiles: 0 };
	}
	const probe = await probeGitWorkspaceState(pathInfo.path);
	return {
		exists: true,
		headCommit: probe.headCommit,
		changedFiles: probe.changedFiles,
	};
}

export function createAutoReviewReconciler(deps: CreateAutoReviewReconcilerDependencies): AutoReviewReconciler {
	const workspaceRuntimes = new Map<string, ReconcilerWorkspaceRuntime>();
	const probeTaskWorkspace = deps.probeTaskWorkspace ?? defaultProbeTaskWorkspace;
	const deliver = deps.deliverTaskInput ?? deliverTaskInput;
	let disposed = false;
	let evaluationTimer: NodeJS.Timeout | null = null;

	const getOrCreateRuntime = (workspaceId: string): ReconcilerWorkspaceRuntime => {
		const existing = workspaceRuntimes.get(workspaceId);
		if (existing) {
			return existing;
		}
		const created = createWorkspaceRuntime();
		workspaceRuntimes.set(workspaceId, created);
		return created;
	};

	const armPendingGitAction = async (
		workspacePath: string,
		taskId: string,
		action: RuntimeTaskGitAction,
		headCommitAtRequest: string | null,
		timestamp: number,
	): Promise<boolean> => {
		try {
			const response = await deps.mutateWorkspaceState(workspacePath, (currentState) => {
				const location = findCardLocation(currentState.board, taskId);
				if (!location || location.columnId !== "review" || !isGitActionCard(location.card)) {
					return { board: currentState.board, value: "unavailable" as const, save: false };
				}
				const existing = location.card.pendingGitAction ?? null;
				if (existing && !isPendingGitActionStale(existing, timestamp)) {
					// Another actor already armed this card; the persisted field is the lock.
					return { board: currentState.board, value: "locked" as const, save: false };
				}
				const pendingGitAction: RuntimeTaskPendingGitAction = {
					action,
					requestedAt: timestamp,
					headCommitAtRequest,
					attempt: existing ? existing.attempt + 1 : 0,
				};
				return {
					board: replaceBoardCard(currentState.board, taskId, {
						...location.card,
						pendingGitAction,
						updatedAt: timestamp,
					}),
					value: "armed" as const,
				};
			});
			return response.value === "armed";
		} catch {
			return false;
		}
	};

	const clearPendingGitAction = async (workspacePath: string, taskId: string): Promise<boolean> => {
		try {
			const response = await deps.mutateWorkspaceState(workspacePath, (currentState) => {
				const location = findCardLocation(currentState.board, taskId);
				if (!location || (location.card.pendingGitAction ?? null) === null) {
					return { board: currentState.board, value: false, save: false };
				}
				return {
					board: replaceBoardCard(currentState.board, taskId, {
						...location.card,
						pendingGitAction: null,
						updatedAt: deps.now?.() ?? Date.now(),
					}),
					value: true,
				};
			});
			return response.value;
		} catch {
			return false;
		}
	};

	// Completion goes through the shared Done workflow so the session stops, the
	// worktree is cleaned up and linked backlog tasks start, with or without a
	// browser open. The guard re-checks the arming inside the board mutation.
	const completePendingGitAction = async (
		workspace: AutoReviewWorkspace,
		workspacePath: string,
		taskId: string,
	): Promise<void> => {
		try {
			await deps.trashTask({
				workspaceId: workspace.workspaceId,
				workspacePath,
				taskId,
				trigger: "auto_review",
				canTrash: (card, columnId) =>
					columnId === "review" && isGitActionCard(card) && Boolean(card.pendingGitAction),
			});
		} catch (error) {
			deps.warn?.(`Auto-review could not complete ${taskId}: ${String(error)}`);
		}
	};

	const handleDeliveryResult = async (
		workspace: AutoReviewWorkspace,
		workspacePath: string,
		taskId: string,
		delivery: DeliverTaskInputResult,
	): Promise<void> => {
		if (delivery.ok || delivery.status === "aborted" || disposed || !workspaceRuntimes.has(workspace.workspaceId)) {
			return;
		}
		if (delivery.status === "undelivered") {
			// The prompt is typed into the TUI, so re-arming would type it twice.
			// Stay armed: a late pickup still completes on HEAD moving, and the
			// staleness timeout re-arms the card otherwise.
			deps.warn?.(`Auto-review prompt for task ${taskId} was not confirmed: ${delivery.error ?? delivery.status}`);
			return;
		}
		// No session to deliver to: disarm so the card can be armed again later.
		if (await clearPendingGitAction(workspacePath, taskId)) {
			try {
				await deps.onBoardMutated?.(workspace.workspaceId, workspacePath);
			} catch {
				// Broadcast is best-effort; the persisted board is already correct.
			}
		}
	};

	// Delivery runs in the background: confirming it can take several seconds
	// and must not hold up the other cards of the workspace. The armed
	// `pendingGitAction` keeps the card from being armed again meanwhile.
	const triggerGitAction = (input: {
		workspace: AutoReviewWorkspace;
		workspacePath: string;
		terminalManager: TerminalSessionManager;
		card: RuntimeBoardCard;
		effectiveAgent: RuntimeAgentId | null;
		templates: TaskGitPromptTemplates | null;
		runtime: ReconcilerWorkspaceRuntime;
	}): void => {
		const action = resolveAutoReviewMode(input.card);
		const prompt = buildGitActionPrompt(action, input.card.baseRef, input.templates);
		const abort = new AbortController();
		input.runtime.deliveryAborts.add(abort);
		void deliver(input.terminalManager, input.card.id, prompt, {
			agentId: input.effectiveAgent,
			signal: abort.signal,
		})
			.catch(
				(error): DeliverTaskInputResult => ({
					ok: false,
					status: "error",
					evidence: null,
					enterAttempts: 0,
					summary: null,
					error: String(error),
				}),
			)
			.then((delivery) => handleDeliveryResult(input.workspace, input.workspacePath, input.card.id, delivery))
			.catch((error) => {
				deps.warn?.(`Auto-review could not settle delivery for task ${input.card.id}: ${String(error)}`);
			})
			.finally(() => {
				input.runtime.deliveryAborts.delete(abort);
			});
	};

	const reconcileWorkspace = async (
		workspace: AutoReviewWorkspace,
		workspacePath: string,
		state: RuntimeWorkspaceStateResponse,
		runtime: ReconcilerWorkspaceRuntime,
	): Promise<void> => {
		const timestamp = deps.now?.() ?? Date.now();
		// Aborted mid-cycle when the workspace gets removed (project deletion or
		// shutdown); mutating a workspace that is being torn down could resurrect it.
		const stillTracked = (): boolean => workspaceRuntimes.has(workspace.workspaceId);
		let boardMutated = false;

		// Housekeeping pass first: armed cards that left review (or lost the
		// auto-review toggle, or became a pipeline card) are disarmed. This needs no git work.
		const candidates: RuntimeBoardCard[] = [];
		for (const column of state.board.columns) {
			for (const card of column.cards) {
				const pendingGitAction = card.pendingGitAction ?? null;
				if (column.id !== "review") {
					// A card that left review while armed must not stay armed forever.
					if (pendingGitAction && stillTracked() && (await clearPendingGitAction(workspacePath, card.id))) {
						boardMutated = true;
					}
					continue;
				}
				if (!isGitActionCard(card)) {
					if (pendingGitAction && stillTracked() && (await clearPendingGitAction(workspacePath, card.id))) {
						boardMutated = true;
					}
					continue;
				}
				candidates.push(card);
			}
		}

		// No candidates: nothing to probe, nothing to arm or complete. This is the
		// common case and must cost zero git work.
		if (candidates.length > 0) {
			let selectedAgentId: RuntimeAgentId | null = null;
			try {
				selectedAgentId = (await deps.getSelectedAgentId?.(workspace.workspaceId, workspacePath)) ?? null;
			} catch {
				selectedAgentId = null;
			}
			let templates: TaskGitPromptTemplates | null = null;
			try {
				templates = await deps.getPromptTemplates(workspace.workspaceId, workspacePath);
			} catch {
				templates = null;
			}
			// One probe per card per cycle, even if both the armed and unarmed
			// branches look at the same card.
			const probeCache = new Map<string, Promise<AutoReviewTaskProbe>>();
			const probeTask = (card: RuntimeBoardCard): Promise<AutoReviewTaskProbe> => {
				const cached = probeCache.get(card.id);
				if (cached) {
					return cached;
				}
				const probe = probeTaskWorkspace({
					workspacePath,
					taskId: card.id,
					baseRef: card.baseRef,
				}).catch(() => ({ exists: false, headCommit: null, changedFiles: 0 }) satisfies AutoReviewTaskProbe);
				probeCache.set(card.id, probe);
				return probe;
			};

			for (const card of candidates) {
				if (!stillTracked()) {
					break;
				}
				const pendingGitAction = card.pendingGitAction ?? null;
				// The agent the session actually runs on wins over card.agentId (plan §4.0, the 2026-10-06 incident).
				const summary = workspace.terminalManager?.getSummary(card.id) ?? null;
				const effectiveAgent = selectedAgentId
					? resolveEffectiveAgent(card, summary, { selectedAgentId })
					: (summary?.agentId ?? card.agentId ?? null);

				if (pendingGitAction) {
					if (isPendingGitActionStale(pendingGitAction, timestamp)) {
						if (await clearPendingGitAction(workspacePath, card.id)) {
							boardMutated = true;
						}
						continue;
					}
					// Completion is judged on evidence: HEAD moved past the commit
					// recorded at arming time. Zero changed files alone proves nothing.
					const probe = await probeTask(card);
					if (
						probe.exists &&
						probe.headCommit !== null &&
						probe.headCommit !== pendingGitAction.headCommitAtRequest
					) {
						// The Done workflow broadcasts the board itself, so this does not
						// mark the cycle as mutated (that would broadcast a second time).
						if (stillTracked()) {
							await completePendingGitAction(workspace, workspacePath, card.id);
						}
					}
					continue;
				}

				// Never arm a card whose delivery channel is missing: it could only
				// "complete" via the staleness timeout, which silently strands it.
				if (!workspace.terminalManager || !summary) {
					// No terminal session to deliver the prompt to.
					continue;
				}

				const probe = await probeTask(card);
				// Review entries with zero changes (common during planning loops)
				// are intentionally ignored.
				if (!probe.exists || probe.changedFiles <= 0 || runtime.gitActionInFlightTaskIds.has(card.id)) {
					continue;
				}

				runtime.gitActionInFlightTaskIds.add(card.id);
				try {
					const armed = await armPendingGitAction(
						workspacePath,
						card.id,
						resolveAutoReviewMode(card),
						probe.headCommit,
						timestamp,
					);
					if (!armed || !stillTracked()) {
						continue;
					}
					boardMutated = true;
					triggerGitAction({
						workspace,
						workspacePath,
						terminalManager: workspace.terminalManager,
						card,
						effectiveAgent,
						templates,
						runtime,
					});
				} finally {
					runtime.gitActionInFlightTaskIds.delete(card.id);
				}
			}
		}

		if (boardMutated && stillTracked()) {
			try {
				await deps.onBoardMutated?.(workspace.workspaceId, workspacePath);
			} catch {
				// Broadcast is best-effort; the persisted board is already correct.
			}
		}
	};

	const evaluateWorkspaceOnce = async (workspaceId: string, runtime: ReconcilerWorkspaceRuntime): Promise<void> => {
		const workspace = deps.listWorkspaces().find((candidate) => candidate.workspaceId === workspaceId) ?? null;
		const workspacePath = workspace?.workspacePath ?? null;
		if (!workspace || !workspacePath) {
			workspaceRuntimes.delete(workspaceId);
			return;
		}

		let state: RuntimeWorkspaceStateResponse;
		try {
			state = await deps.getWorkspaceState(workspace.workspaceId, workspacePath);
		} catch (error) {
			deps.warn?.(`Auto-review could not read workspace state for ${workspace.workspaceId}: ${String(error)}`);
			return;
		}
		// The workspace may have been untracked while its state was being read.
		if (!workspaceRuntimes.has(workspaceId)) {
			return;
		}

		await reconcileWorkspace(workspace, workspacePath, state, runtime);
	};

	const evaluateWorkspace = async (workspaceId: string): Promise<void> => {
		if (disposed) {
			return;
		}
		const runtime = getOrCreateRuntime(workspaceId);
		// One evaluation chain per workspace. Late callers mark a pending cycle and
		// wait for the running chain, then run their own cycle, so every caller
		// observes a settled state.
		while (runtime.evaluationPromise) {
			runtime.pendingEvaluation = true;
			await runtime.evaluationPromise;
			if (disposed) {
				return;
			}
		}
		const chain = (async () => {
			do {
				runtime.pendingEvaluation = false;
				await evaluateWorkspaceOnce(workspaceId, runtime);
			} while (runtime.pendingEvaluation && !disposed);
		})()
			.catch((error) => {
				deps.warn?.(`Auto-review evaluation failed for ${workspaceId}: ${String(error)}`);
			})
			.finally(() => {
				runtime.evaluationPromise = null;
			});
		runtime.evaluationPromise = chain;
		await chain;
	};

	const evaluateAllWorkspaces = (): void => {
		for (const workspace of deps.listWorkspaces()) {
			if (workspace.workspacePath) {
				void evaluateWorkspace(workspace.workspaceId);
			}
		}
	};

	return {
		start: async () => {
			if (disposed) {
				return;
			}
			const intervalMs = deps.evaluationIntervalMs ?? AUTO_REVIEW_EVALUATION_INTERVAL_MS;
			if (!evaluationTimer) {
				evaluationTimer = setInterval(() => {
					if (!disposed) {
						evaluateAllWorkspaces();
					}
				}, intervalMs);
				evaluationTimer.unref();
			}
			evaluateAllWorkspaces();
		},
		trackWorkspace: (workspaceId: string) => {
			void evaluateWorkspace(workspaceId);
		},
		untrackWorkspace: (workspaceId: string) => {
			const runtime = workspaceRuntimes.get(workspaceId);
			if (runtime) {
				for (const abort of runtime.deliveryAborts) {
					abort.abort();
				}
			}
			workspaceRuntimes.delete(workspaceId);
		},
		evaluateWorkspace,
		close: () => {
			disposed = true;
			if (evaluationTimer) {
				clearInterval(evaluationTimer);
				evaluationTimer = null;
			}
			for (const runtime of workspaceRuntimes.values()) {
				for (const abort of runtime.deliveryAborts) {
					abort.abort();
				}
				runtime.deliveryAborts.clear();
				runtime.gitActionInFlightTaskIds.clear();
			}
			workspaceRuntimes.clear();
		},
	};
}
