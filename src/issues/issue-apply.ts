// Applies a sync's fetched issues to a workspace's board: the one writer of issue cards. The server runs it for the
// pipeline worker's `applyIssues` request (src/server/pipeline-actions.ts), `kanban issues sync` runs it in-process.
//
// Cards are created through the normal create path, as `kanban task create` does: a dev card gets the kit's
// devAssignment (resolveDevAssignment + its log), a plan card the kit's plan routing and plan prompt
// (preparePlanCard + its plan index entry). New cards go to Backlog and are never started. The plan is computed
// once outside the lock (the create fields need async kit reads) and again under the board lock, so a card that
// appeared meanwhile (another sync, a human) is never doubled.
import { randomUUID } from "node:crypto";

import {
	getWorkspacePipelineSettings,
	type IssueProviderId,
	type ParsedPipelineConfig,
	type PipelineConfig,
	readPipelineConfig,
} from "../config/pipeline-config";
import type {
	RuntimeAgentId,
	RuntimeBoardData,
	RuntimeTaskAgentSettings,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { addTaskToColumn } from "../core/task-board-mutations";
import {
	type DevAssignmentDecision,
	recordDevAssignment,
	resolveDevAssignment as resolveDevAssignmentDefault,
} from "../kits/dev-assignment";
import { answerPlanAssignment } from "../kits/policy";
import { type KitCatalog, loadKitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import { slugifyPlanTitle } from "../plans/plan-breakdown";
import { type PreparedPlanCard, preparePlanCard, recordPlanCard } from "../plans/plan-card";
import { createPlanIndexStore, type PlanIndexStore } from "../plans/plan-index";
import type { MutateWorkspaceState } from "../server/task-trash-workflow";
import { getIssueWorkspacePaths } from "../state/kanban-home";
import { type FetchedIssue, issueKey } from "./issue-provider";
import { type GitRemote, listGitRemotes, resolvePinnedIssueRepo } from "./issue-repo";
import { type IssueSyncState, readIssueSyncState, withIssueSyncState } from "./issue-state";
import { buildImportedRecord, type IssueSyncAction, planIssueSync } from "./issue-sync-plan";

export interface IssueApplyInput {
	workspaceId: string;
	workspacePath: string;
	provider: IssueProviderId;
	repo: string;
	issues: FetchedIssue[];
}

export interface IssueApplyResult {
	created: Array<{ number: number; taskId: string; title: string; plan: boolean; note: string }>;
	updated: Array<{ number: number; taskId: string; change: "updated" | "closed" | "reopened"; note: string }>;
	notes: Array<{ number: number; taskId: string; note: string; wake: boolean }>;
	skipped: Array<{ number: number; title: string; reason: string; detail: string }>;
	/** New issues whose card appeared between the plan and the write: not created again. */
	deduped: number[];
}

export interface IssueApplyDependencies {
	mutateWorkspaceState: MutateWorkspaceState;
	readConfig?: () => Promise<ParsedPipelineConfig>;
	loadCatalog?: () => Promise<KitCatalog>;
	listRemotes?: (repoPath: string) => Promise<GitRemote[]>;
	getStatePath?: (workspaceId: string) => string;
	resolveDevAssignment?: typeof resolveDevAssignmentDefault;
	planIndex?: PlanIndexStore;
	onBoardMutated?: (scope: { workspaceId: string; workspacePath: string }) => Promise<void> | void;
	/** Writes the kit's dev-assignment log entries (default on). */
	logDevAssignment?: boolean;
	randomUuid?: () => string;
	now?: () => number;
}

/** Whether the project's kit makes plan cards. */
export function isPlanRoleEnabled(config: PipelineConfig, workspaceId: string, catalog: KitCatalog): boolean {
	return answerPlanAssignment(resolveWorkspaceKit(config, workspaceId, catalog).kit).kind !== "disabled";
}

export function emptyIssueApplyResult(): IssueApplyResult {
	return { created: [], updated: [], notes: [], skipped: [], deduped: [] };
}

/** The result of a plan that is only reported (mode `report`, `--dry-run`): what would happen. */
export function describeIssueSyncActions(actions: readonly IssueSyncAction[]): IssueApplyResult {
	const result = emptyIssueApplyResult();
	for (const action of actions) {
		if (action.kind === "create") {
			result.created.push({
				number: action.issue.number,
				taskId: "",
				title: action.title,
				plan: action.asPlan,
				note: [action.via, action.planNote].filter(Boolean).join("; "),
			});
		} else if (action.kind === "update") {
			result.updated.push({
				number: action.issue.number,
				taskId: action.taskId,
				change: action.change,
				note: action.note,
			});
		} else if (action.kind === "note") {
			result.notes.push({
				number: action.issue.number,
				taskId: action.taskId,
				note: action.note,
				wake: action.wake,
			});
		} else {
			result.skipped.push({
				number: action.issue.number,
				title: action.issue.title,
				reason: action.reason,
				detail: action.detail,
			});
		}
	}
	return result;
}

interface PreparedCreate {
	title: string;
	prompt: string;
	role: "dev" | "plan";
	agentId: RuntimeAgentId | undefined;
	agentSettings: RuntimeTaskAgentSettings | undefined;
	startInPlanMode: boolean;
	planCard: PreparedPlanCard | null;
	devAssignment: DevAssignmentDecision | null;
	planNote: string | null;
}

function resolveBaseRef(state: RuntimeWorkspaceStateResponse, configured: string | null): string {
	return configured?.trim() || state.git.defaultBranch || state.git.currentBranch || state.git.branches[0] || "";
}

function replaceCard(
	board: RuntimeBoardData,
	taskId: string,
	update: Extract<IssueSyncAction, { kind: "update" }>,
	now: number,
): RuntimeBoardData {
	return {
		...board,
		columns: board.columns.map((column) => ({
			...column,
			cards: column.cards.map((card) =>
				card.id === taskId
					? { ...card, title: update.title, prompt: update.prompt, issue: update.cardIssue, updatedAt: now }
					: card,
			),
		})),
	};
}

export async function applyIssueSync(input: IssueApplyInput, deps: IssueApplyDependencies): Promise<IssueApplyResult> {
	const readConfig = deps.readConfig ?? (async () => await readPipelineConfig());
	const loadCatalog = deps.loadCatalog ?? (async () => await loadKitCatalog());
	const getStatePath = deps.getStatePath ?? ((workspaceId: string) => getIssueWorkspacePaths(workspaceId).state);
	const resolveDevAssignment = deps.resolveDevAssignment ?? resolveDevAssignmentDefault;
	const planIndex = deps.planIndex ?? createPlanIndexStore();
	const randomUuid = deps.randomUuid ?? randomUUID;
	const now = deps.now ?? Date.now;

	const [{ config }, catalog] = await Promise.all([readConfig(), loadCatalog()]);
	const settings = getWorkspacePipelineSettings(config, input.workspaceId);
	if (settings.issues.mode !== "on") {
		throw new Error(`issue import is ${settings.issues.mode} for workspace ${input.workspaceId}; nothing applied`);
	}
	if (settings.issues.provider !== input.provider) {
		throw new Error(`workspace ${input.workspaceId} imports from ${settings.issues.provider}, not ${input.provider}`);
	}
	const statePath = getStatePath(input.workspaceId);
	const initialState = await readIssueSyncState(statePath);
	// Project isolation: whoever asks, a project's board only ever gets issues of its own (pinned) repository.
	const repo = resolvePinnedIssueRepo({
		provider: input.provider,
		configured: settings.issues.repo,
		remotes: await (deps.listRemotes ?? listGitRemotes)(input.workspacePath),
		pinned: initialState.pinnedRepo,
	});
	if (!repo.ok) {
		throw new Error(repo.error);
	}
	if (repo.repo.toLowerCase() !== input.repo.toLowerCase()) {
		throw new Error(`issues of ${input.repo} are not this project's (${repo.repo}); nothing applied`);
	}
	const planEnabled = isPlanRoleEnabled(config, input.workspaceId, catalog);
	const planInput = {
		provider: input.provider,
		repo: repo.repo,
		settings: settings.issues,
		planEnabled,
		issues: input.issues,
	};

	// First pass, no lock: which cards are new, so their kit routing can be resolved.
	const { state: preview } = await deps.mutateWorkspaceState(input.workspacePath, (state) => ({
		board: state.board,
		value: null,
		save: false,
	}));
	const firstPlan = planIssueSync({
		...planInput,
		board: preview.board,
		records: initialState.issues,
	});
	const prepared = new Map<string, PreparedCreate>();
	for (const action of firstPlan) {
		if (action.kind !== "create") {
			continue;
		}
		let planCard: PreparedPlanCard | null = null;
		let planNote = action.planNote;
		if (action.asPlan) {
			try {
				planCard = await preparePlanCard(
					{
						workspaceId: input.workspaceId,
						title: action.title,
						requirement: action.prompt,
						slug:
							slugifyPlanTitle(`issue ${action.issue.number} ${action.issue.title}`) ||
							`issue-${action.issue.number}`,
					},
					{ index: planIndex },
				);
			} catch (error) {
				planNote = `could not be a plan card (${error instanceof Error ? error.message : String(error)}): created as a dev card`;
			}
		}
		const devAssignment = planCard
			? null
			: await resolveDevAssignment({ workspaceId: input.workspaceId, title: action.title, prompt: action.prompt });
		prepared.set(action.key, {
			title: planCard?.title ?? action.title,
			prompt: planCard?.prompt ?? action.prompt,
			role: planCard ? "plan" : "dev",
			agentId: planCard ? planCard.agentId : devAssignment?.agentId,
			agentSettings: planCard ? planCard.agentSettings : devAssignment?.agentSettings,
			startInPlanMode: planCard?.startInPlanMode ?? false,
			planCard,
			devAssignment,
			// A refused kit proposal (the vetted model registry) leaves the card without an agent; it is never started here.
			planNote:
				devAssignment?.outcome === "refused"
					? `no kit model: ${devAssignment.proposal?.refused ?? "refused by the vetted model registry"}`
					: planNote,
		});
	}

	// Second pass under the issues-state lock and then the board lock, with the records as they are now: a concurrent
	// apply waits here, so it never plans against records this one is about to change (no double Update sections).
	const at = now();
	const importedAt = new Date(at).toISOString();
	const { applied, saved } = await withIssueSyncState(
		statePath,
		async (current) => {
			const outcome = await mutateBoard(current.issues);
			return {
				state: recordApplied(current, outcome.value),
				value: { applied: outcome.value, saved: outcome.saved },
			};
		},
		now,
	);

	async function mutateBoard(records: IssueSyncState["issues"]) {
		return await deps.mutateWorkspaceState(input.workspacePath, (state) => {
			const actions = planIssueSync({ ...planInput, board: state.board, records });
			const baseRef = resolveBaseRef(state, settings.defaultBaseRef);
			let board = state.board;
			let changed = false;
			const result = emptyIssueApplyResult();
			const createdCards: Array<{
				key: string;
				action: Extract<IssueSyncAction, { kind: "create" }>;
				taskId: string;
			}> = [];
			const firstKeys = new Set(firstPlan.filter((action) => action.kind === "create").map((action) => action.key));
			for (const action of actions) {
				if (action.kind === "create") {
					const fields = prepared.get(action.key);
					if (!fields || !baseRef) {
						// New since the first pass (its routing isn't resolved): the next sync creates it.
						continue;
					}
					const created = addTaskToColumn(
						board,
						"backlog",
						{
							title: fields.title,
							prompt: fields.prompt,
							role: fields.role,
							startInPlanMode: fields.startInPlanMode,
							agentId: fields.agentId,
							agentSettings: fields.agentSettings,
							issue: action.cardIssue,
							baseRef,
							autoReviewEnabled: false,
						},
						randomUuid,
						at,
					);
					board = created.board;
					changed = true;
					createdCards.push({ key: action.key, action, taskId: created.task.id });
					result.created.push({
						number: action.issue.number,
						taskId: created.task.id,
						title: created.task.title ?? fields.title,
						plan: fields.role === "plan",
						note: [action.via, fields.planNote].filter(Boolean).join("; "),
					});
				} else if (action.kind === "update") {
					board = replaceCard(board, action.taskId, action, at);
					changed = true;
					result.updated.push({
						number: action.issue.number,
						taskId: action.taskId,
						change: action.change,
						note: action.note,
					});
				} else if (action.kind === "note") {
					result.notes.push({
						number: action.issue.number,
						taskId: action.taskId,
						note: action.note,
						wake: action.wake,
					});
				} else {
					result.skipped.push({
						number: action.issue.number,
						title: action.issue.title,
						reason: action.reason,
						detail: action.detail,
					});
				}
			}
			const secondCreates = new Set(
				actions.filter((action) => action.kind === "create").map((action) => action.key),
			);
			for (const action of firstPlan) {
				if (firstKeys.has(action.key) && !secondCreates.has(action.key)) {
					result.deduped.push(action.issue.number);
				}
			}
			return { board, value: { result, actions, createdCards }, save: changed };
		});
	}

	function recordApplied(
		state: IssueSyncState,
		applied: Awaited<ReturnType<typeof mutateBoard>>["value"],
	): IssueSyncState {
		const issues = { ...state.issues };
		const skipped = { ...state.skipped };
		for (const created of applied.createdCards) {
			issues[created.key] = buildImportedRecord(created.action.issue, {
				provider: input.provider,
				repo: planInput.repo,
				taskId: created.taskId,
				importedAt,
				plan: prepared.get(created.key)?.role === "plan",
			});
			delete skipped[created.key];
		}
		for (const action of applied.actions) {
			if (action.kind === "update" || action.kind === "note") {
				issues[action.key] = action.record;
			} else if (action.kind === "skip") {
				skipped[action.key] = {
					number: action.issue.number,
					title: action.issue.title,
					reason: action.reason,
					detail: action.detail,
					at: importedAt,
					updatedAt: action.issue.updatedAt,
				};
			}
		}
		return { ...state, issues, skipped };
	}

	for (const created of applied.createdCards) {
		const fields = prepared.get(created.key);
		const task = { id: created.taskId, title: fields?.title ?? created.action.title };
		if (fields?.planCard) {
			await recordPlanCard(planIndex, input.workspaceId, fields.planCard, task, new Date(at));
		} else if (fields?.devAssignment && deps.logDevAssignment !== false) {
			await recordDevAssignment(fields.devAssignment, task, { source: "issues", now: new Date(at) }).catch(
				() => null,
			);
		}
	}
	if (saved) {
		await deps.onBoardMutated?.({ workspaceId: input.workspaceId, workspacePath: input.workspacePath });
	}
	return applied.result;
}

/** The import keys of the cards on a board plus the recorded ones (what the sync must fetch comments for). */
export function collectKnownIssueKeys(board: RuntimeBoardData, records: Record<string, unknown>): Set<string> {
	const keys = new Set(Object.keys(records));
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (card.issue) {
				keys.add(issueKey(card.issue));
			}
		}
	}
	return keys;
}
