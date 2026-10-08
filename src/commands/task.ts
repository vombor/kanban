import type { Command } from "commander";
import { getRuntimeAgentCatalogEntry } from "../core/agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardDependency,
	RuntimeTaskAgentSettings,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskLandingChoice,
	RuntimeTaskLandingOutcome,
	RuntimeTaskRole,
	RuntimeTaskTrashAutoStart,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import {
	runtimeAgentIdEnumSchema,
	runtimeAgentIdSchema,
	runtimeTaskAutoReviewModeSchema,
	runtimeTaskRoleSchema,
} from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { getKanbanRuntimeOrigin } from "../core/runtime-endpoint";
import { cloneRuntimeTaskAgentSettings } from "../core/task-agent-settings";
import {
	addTaskDependency,
	addTaskToColumn,
	deleteTasksFromBoard,
	getTaskColumnId,
	moveTaskToColumn,
	type RuntimeAddTaskDependencyResult,
	removeTaskDependency,
	updateTask,
} from "../core/task-board-mutations";
import { type DevAssignmentDecision, recordDevAssignment, resolveDevAssignment } from "../kits/dev-assignment";
import { readRunoffs, reopenRunoffWithoutWinner } from "../kits/team/runoffs/runoffs-store";
import { BLOCKED_TITLE_PREFIX } from "../pipeline/actions";
import { handBackTask } from "../pipeline/handback";
import { clearHold, preserveTaskWork, readPipelineHold } from "../pipeline/hold";
import { createPipelineStateStore } from "../pipeline/pipeline-state";
import { createQaLogAppender } from "../pipeline/qa-log";
import { type PreparedPlanCard, preparePlanCard, recordPlanCard } from "../plans/plan-card";
import { createPlanIndexStore } from "../plans/plan-index";
import { resolveProjectInputPath } from "../projects/project-path";
import { getWatchdogWorkspacePaths } from "../state/kanban-home";
import { loadWorkspaceContext, mutateWorkspaceState } from "../state/workspace-state";
import {
	createRuntimeTrpcClient,
	notifyRuntimeWorkspaceStateUpdated,
	type RuntimeTrpcClient,
} from "./runtime-trpc-client";
import { restartTaskFresh, resumeTasks, sendTaskMessage } from "./task-recovery";

const LIST_TASK_COLUMNS = ["backlog", "in_progress", "review", "trash"] as const;
type ListTaskColumn = (typeof LIST_TASK_COLUMNS)[number];
type TaskCommandTarget = { taskId?: string; column?: ListTaskColumn };

type ResolvedTaskCommandTarget =
	| {
			kind: "task";
			taskId: string;
	  }
	| {
			kind: "column";
			column: ListTaskColumn;
	  };

interface RuntimeWorkspaceMutationResult<T> {
	board: RuntimeWorkspaceStateResponse["board"];
	value: T;
}

type JsonRecord = Record<string, unknown>;

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseListColumn(value: string | undefined): ListTaskColumn | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "done") {
		return "trash";
	}
	if (value === "backlog" || value === "in_progress" || value === "review" || value === "trash") {
		return value;
	}
	throw new Error(`Invalid column "${value}". Expected one of: ${LIST_TASK_COLUMNS.join(", ")}, done.`);
}

function parseAutoReviewMode(value: string | undefined): RuntimeTaskAutoReviewMode | undefined {
	if (value === undefined) {
		return undefined;
	}
	const parsed = runtimeTaskAutoReviewModeSchema.safeParse(value);
	if (parsed.success) {
		return parsed.data;
	}
	throw new Error(`Invalid auto review mode "${value}". Expected: commit, pr, qa.`);
}

function parseTaskRole(value: string | undefined): RuntimeTaskRole | undefined {
	if (value === undefined) {
		return undefined;
	}
	const parsed = runtimeTaskRoleSchema.safeParse(value);
	if (parsed.success) {
		return parsed.data;
	}
	throw new Error(`Invalid role "${value}". Expected: ${runtimeTaskRoleSchema.options.join(", ")}.`);
}

const VALID_AGENT_IDS = runtimeAgentIdEnumSchema.options;

function parseAgentId(value: string | undefined): RuntimeAgentId | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "default") {
		return null;
	}
	const result = runtimeAgentIdSchema.safeParse(value);
	if (result.success) {
		return result.data;
	}
	throw new Error(`Invalid agent ID "${value}". Expected one of: ${VALID_AGENT_IDS.join(", ")}, default.`);
}

function parseOptionalStringOrDefault(value: string | undefined): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "default") {
		return null;
	}
	return value;
}

type ParsedTaskReasoningEffort = string | null | undefined;

function parseTaskReasoningEffort(value: string | undefined): ParsedTaskReasoningEffort {
	if (value === undefined) {
		return undefined;
	}
	if (value === "inherit") {
		return null;
	}
	return value;
}

/**
 * Emits `agentSettings` plus a deprecated `clineSettings` mirror so existing
 * CLI consumers keep working until the mirror is removed.
 */
export function formatTaskAgentSettings(settings?: RuntimeTaskAgentSettings): JsonRecord {
	if (settings === undefined) {
		return {};
	}
	const cloned = cloneRuntimeTaskAgentSettings(settings) ?? {};
	return {
		agentSettings: cloned,
		clineSettings: cloned,
	};
}

export function buildTaskAgentSettingsForCreate(input: {
	providerId?: string;
	modelId?: string;
	reasoningEffort?: ParsedTaskReasoningEffort;
}): RuntimeTaskAgentSettings | undefined {
	const providerId = input.providerId?.trim();
	const modelId = input.modelId?.trim();
	const reasoningEffort = input.reasoningEffort === null ? undefined : input.reasoningEffort;
	if (!providerId && !modelId && reasoningEffort === undefined) {
		return undefined;
	}
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(reasoningEffort && reasoningEffort !== "default" ? { reasoningEffort } : {}),
	};
}

export function buildTaskAgentSettingsForUpdate(
	currentSettings: RuntimeTaskAgentSettings | undefined,
	input: {
		providerId?: string | null;
		modelId?: string | null;
		reasoningEffort?: ParsedTaskReasoningEffort;
	},
): RuntimeTaskAgentSettings | null | undefined {
	if (input.providerId === undefined && input.modelId === undefined && input.reasoningEffort === undefined) {
		return undefined;
	}
	const nextSettings = cloneRuntimeTaskAgentSettings(currentSettings) ?? {};
	let preserveEmptyOverride = currentSettings !== undefined && Object.keys(currentSettings).length === 0;

	if (input.providerId !== undefined) {
		const providerId = input.providerId?.trim();
		if (providerId) {
			nextSettings.providerId = providerId;
		} else {
			delete nextSettings.providerId;
		}
	}

	if (input.modelId !== undefined) {
		const modelId = input.modelId?.trim();
		if (modelId) {
			nextSettings.modelId = modelId;
		} else {
			delete nextSettings.modelId;
		}
	}

	if (input.reasoningEffort !== undefined) {
		if (input.reasoningEffort === "default") {
			delete nextSettings.reasoningEffort;
			preserveEmptyOverride = true;
		} else if (input.reasoningEffort === null) {
			delete nextSettings.reasoningEffort;
			preserveEmptyOverride = false;
		} else {
			nextSettings.reasoningEffort = input.reasoningEffort;
		}
	}

	if (
		nextSettings.providerId === undefined &&
		nextSettings.modelId === undefined &&
		nextSettings.reasoningEffort === undefined &&
		!preserveEmptyOverride
	) {
		return null;
	}

	return nextSettings;
}

/** True only when the command itself named an agent (`--agent-id`), not when a card already has one. */
export function shouldWarnOnExplicitAgentId(
	explicitAgentId: RuntimeAgentId | null | undefined,
): explicitAgentId is RuntimeAgentId {
	return explicitAgentId != null;
}

/**
 * Never silently drop per-task settings: when an explicit agent override is
 * set, warn on stderr about settings the agent has no launch mechanism for.
 * Values are always stored and passed through verbatim regardless.
 */
export function warnOnAgentSettingsMechanismGaps(
	agentId: RuntimeAgentId,
	settings: RuntimeTaskAgentSettings | undefined,
): void {
	if (!settings) {
		return;
	}
	const entry = getRuntimeAgentCatalogEntry(agentId);
	if (!entry) {
		return;
	}
	const { label, capabilities } = entry;
	if (settings.modelId && capabilities.modelOverride === "none") {
		process.stderr.write(
			`Warning: ${label} has no launch-time model override; --model "${settings.modelId}" is stored but ignored at launch.\n`,
		);
	}
	if (settings.reasoningEffort && capabilities.effortOverride === "none") {
		process.stderr.write(
			`Warning: ${label} has no launch-time reasoning-effort override; --effort "${settings.reasoningEffort}" is stored but ignored at launch.\n`,
		);
	}
	if (settings.providerId && capabilities.providerOverride === "none") {
		process.stderr.write(
			`Warning: ${label} does not read a provider; --provider "${settings.providerId}" is stored but ignored at launch.\n`,
		);
	}
}

function resolveTaskCommandTarget(input: TaskCommandTarget, commandName: string): ResolvedTaskCommandTarget {
	const taskId = input.taskId?.trim();
	const column = input.column;
	if (taskId && column) {
		throw new Error(`${commandName} accepts exactly one of --task-id or --column.`);
	}
	if (taskId) {
		return {
			kind: "task",
			taskId,
		};
	}
	if (column) {
		return {
			kind: "column",
			column,
		};
	}
	throw new Error(`${commandName} requires either --task-id or --column.`);
}

async function resolveRuntimeWorkspace(
	projectPath: string | undefined,
	cwd: string,
	options: { autoCreateIfMissing?: boolean } = {},
) {
	const normalizedProjectPath = (projectPath ?? "").trim();
	const resolvedPath = normalizedProjectPath ? resolveProjectInputPath(normalizedProjectPath, cwd) : cwd;
	return await loadWorkspaceContext(resolvedPath, {
		autoCreateIfMissing: options.autoCreateIfMissing ?? true,
	});
}

async function resolveWorkspaceRepoPath(
	projectPath: string | undefined,
	cwd: string,
	options: { autoCreateIfMissing?: boolean } = {},
): Promise<string> {
	const workspace = await resolveRuntimeWorkspace(projectPath, cwd, options);
	return workspace.repoPath;
}

async function ensureRuntimeWorkspace(workspaceRepoPath: string): Promise<string> {
	const runtimeClient = createRuntimeTrpcClient(null);
	const added = await runtimeClient.projects.add.mutate({
		path: workspaceRepoPath,
	});
	if (!added.ok || !added.project) {
		throw new Error(added.error ?? `Could not register project ${workspaceRepoPath} in Kanban runtime.`);
	}
	return added.project.id;
}

async function updateRuntimeWorkspaceState<T>(
	runtimeClient: RuntimeTrpcClient,
	workspaceRepoPath: string,
	mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceMutationResult<T>,
): Promise<T> {
	const mutationResponse = await mutateWorkspaceState(workspaceRepoPath, (state) => {
		const mutation = mutate(state);
		return {
			board: mutation.board,
			value: mutation.value,
		};
	});

	if (mutationResponse.saved) {
		await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	}

	return mutationResponse.value;
}

function resolveTaskBaseRef(state: RuntimeWorkspaceStateResponse): string {
	return state.git.currentBranch ?? state.git.defaultBranch ?? state.git.branches[0] ?? "";
}

function findTaskRecord(
	state: RuntimeWorkspaceStateResponse,
	taskId: string,
): { task: RuntimeBoardCard; columnId: RuntimeBoardColumnId } | null {
	for (const column of state.board.columns) {
		const task = column.cards.find((candidate) => candidate.id === taskId);
		if (task) {
			return {
				task,
				columnId: column.id,
			};
		}
	}
	return null;
}

function formatTaskRecord(
	state: RuntimeWorkspaceStateResponse,
	task: RuntimeBoardCard,
	columnId: RuntimeBoardColumnId,
): JsonRecord {
	const session = state.sessions[task.id] ?? null;
	return {
		id: task.id,
		prompt: task.prompt,
		column: columnId,
		baseRef: task.baseRef,
		startInPlanMode: task.startInPlanMode,
		autoReviewEnabled: task.autoReviewEnabled === true,
		autoReviewMode: task.autoReviewMode ?? "commit",
		...(task.role ? { role: task.role } : {}),
		...(task.agentId ? { agentId: task.agentId } : {}),
		...formatTaskAgentSettings(task.agentSettings),
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		session: session
			? {
					state: session.state,
					agentId: session.agentId,
					pid: session.pid,
					startedAt: session.startedAt,
					updatedAt: session.updatedAt,
					lastOutputAt: session.lastOutputAt,
					reviewReason: session.reviewReason,
					exitCode: session.exitCode,
				}
			: null,
	};
}

function formatDependencyRecord(
	state: RuntimeWorkspaceStateResponse,
	dependency: RuntimeBoardDependency,
): Record<string, unknown> {
	return {
		id: dependency.id,
		backlogTaskId: dependency.fromTaskId,
		backlogTaskColumn: getTaskColumnId(state.board, dependency.fromTaskId),
		linkedTaskId: dependency.toTaskId,
		linkedTaskColumn: getTaskColumnId(state.board, dependency.toTaskId),
		createdAt: dependency.createdAt,
	};
}

function getLinkFailureMessage(reason: RuntimeAddTaskDependencyResult["reason"]): string {
	if (reason === "same_task") {
		return "A task cannot be linked to itself.";
	}
	if (reason === "duplicate") {
		return "These tasks are already linked.";
	}
	if (reason === "trash_task") {
		return "Links cannot include done tasks.";
	}
	if (reason === "non_backlog") {
		return "Links require at least one backlog task.";
	}
	return "One or both tasks could not be found.";
}

function findTasksInColumn(
	state: RuntimeWorkspaceStateResponse,
	columnId: ListTaskColumn,
): Array<{ task: RuntimeBoardCard; columnId: RuntimeBoardColumnId }> {
	const column = state.board.columns.find((candidate) => candidate.id === columnId);
	if (!column) {
		return [];
	}
	return column.cards.map((task) => ({
		task,
		columnId: column.id,
	}));
}

/** Who moved cards to Done or deleted them, and what that did (src/state/task-history-log.ts), oldest first. */
async function listTaskHistory(input: {
	cwd: string;
	projectPath?: string;
	taskId?: string;
	limit?: number;
}): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const history = await runtimeClient.workspace.getTaskHistory.query({
		...(input.taskId ? { taskId: input.taskId } : {}),
		// Without a task, the newest 50; a task's history is short and shown whole unless --limit says otherwise.
		...(input.limit || !input.taskId ? { limit: input.limit ?? 50 } : {}),
	});
	return {
		ok: true,
		workspacePath: workspace.repoPath,
		taskId: input.taskId ?? null,
		path: history.path,
		entries: history.entries,
		count: history.entries.length,
	};
}

async function listTasks(input: { cwd: string; projectPath?: string; column?: ListTaskColumn }): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();

	const tasks = state.board.columns.flatMap((boardColumn) => {
		if (!input.column && boardColumn.id === "trash") {
			return [];
		}
		if (input.column && boardColumn.id !== input.column) {
			return [];
		}
		return boardColumn.cards.map((task) => formatTaskRecord(state, task, boardColumn.id));
	});

	return {
		ok: true,
		workspacePath: workspace.repoPath,
		column: input.column ?? null,
		tasks,
		dependencies: state.board.dependencies.map((dependency) => formatDependencyRecord(state, dependency)),
		count: tasks.length,
	};
}

interface DeletedCardRecord {
	taskId: string;
	columnId: RuntimeBoardColumnId;
	role: RuntimeTaskRole;
	title: string | null;
}

/** Stops the task's sessions, reaps, deletes the worktree and logs the delete in the task history (server side). */
async function deleteTaskWorkspace(
	runtimeClient: RuntimeTrpcClient,
	card: DeletedCardRecord,
): Promise<{ removed: boolean; error?: string }> {
	try {
		const deleted = await runtimeClient.workspace.deleteWorktree.mutate({
			taskId: card.taskId,
			trigger: "cli",
			fromColumnId: card.columnId,
			role: card.role,
			...(card.title ? { title: card.title } : {}),
		});
		return {
			removed: deleted.removed,
			error: deleted.ok ? undefined : deleted.error,
		};
	} catch (error) {
		return {
			removed: false,
			error: toErrorMessage(error),
		};
	}
}

function formatDevAssignment(decision: DevAssignmentDecision): JsonRecord {
	return { kit: decision.kitName, outcome: decision.outcome, proposal: decision.proposal };
}

/** Tells the creator on stderr what the kit did (stdout stays the JSON result). */
function reportDevAssignment(decision: DevAssignmentDecision): void {
	for (const issue of decision.issues) {
		process.stderr.write(`Warning: ${issue}\n`);
	}
	const proposal = decision.proposal;
	if (decision.outcome !== "shadow" || !proposal) {
		return;
	}
	const model = proposal.agentSettings?.modelId ? ` on ${proposal.agentSettings.modelId}` : "";
	process.stderr.write(`Kit ${decision.kitName} (shadow) would assign ${proposal.agentId}${model}; not applied.\n`);
}

export async function createTask(input: {
	cwd: string;
	/** A card id chosen beforehand (unique on the board); default a fresh one. */
	taskId?: string;
	title?: string;
	prompt: string;
	projectPath?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: RuntimeTaskAutoReviewMode;
	role?: RuntimeTaskRole;
	/** null = explicitly the selected agent (`--agent-id default`); the kit's devAssignment is then not applied. */
	agentId?: RuntimeAgentId | null;
	agentSettings?: RuntimeTaskAgentSettings;
	/** A plan card's spec slug (`docs/specs/<slug>.md`); default from the title. */
	planSlug?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	if (shouldWarnOnExplicitAgentId(input.agentId)) {
		warnOnAgentSettingsMechanismGaps(input.agentId, input.agentSettings);
	}
	// A plan card gets the kit's plan routing and the plan prompt around the requirement (src/plans/plan-card.ts).
	const planIndex = input.role === "plan" ? createPlanIndexStore() : null;
	const planCard: PreparedPlanCard | null = planIndex
		? await preparePlanCard(
				{
					workspaceId,
					title: input.title,
					requirement: input.prompt,
					slug: input.planSlug,
					agentId: input.agentId,
					agentSettings: input.agentSettings,
					startInPlanMode: input.startInPlanMode,
				},
				{ index: planIndex },
			)
		: null;
	if (!planCard && input.planSlug !== undefined) {
		throw new Error("--plan-slug is only for --role plan.");
	}
	// devAssignment answers for dev cards only: a QA, TRIAGE, calibration or plan card is created as its creator set it.
	const devAssignment =
		(input.role ?? "dev") === "dev"
			? await resolveDevAssignment({
					workspaceId,
					title: input.title ?? "",
					prompt: input.prompt,
					agentId: input.agentId,
					agentSettings: input.agentSettings,
				})
			: null;
	if (devAssignment) {
		reportDevAssignment(devAssignment);
	}
	const created = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (state) => {
		const resolvedBaseRef = (input.baseRef ?? "").trim() || resolveTaskBaseRef(state);
		if (!resolvedBaseRef) {
			throw new Error("Could not determine task base branch for this workspace.");
		}
		const result = addTaskToColumn(
			state.board,
			"backlog",
			{
				...(input.taskId ? { taskId: input.taskId } : {}),
				title: planCard ? planCard.title : input.title,
				prompt: planCard ? planCard.prompt : input.prompt,
				startInPlanMode: planCard ? planCard.startInPlanMode : input.startInPlanMode,
				autoReviewEnabled: input.autoReviewEnabled,
				autoReviewMode: input.autoReviewMode,
				role: input.role,
				agentId: planCard ? planCard.agentId : devAssignment ? devAssignment.agentId : (input.agentId ?? undefined),
				agentSettings: planCard
					? planCard.agentSettings
					: devAssignment
						? devAssignment.agentSettings
						: input.agentSettings,
				baseRef: resolvedBaseRef,
			},
			() => globalThis.crypto.randomUUID(),
		);
		return {
			board: result.board,
			value: result.task,
		};
	});

	if (devAssignment) {
		await recordDevAssignment(devAssignment, created).catch((error: unknown) => {
			process.stderr.write(`Warning: could not log the kit's agent proposal: ${toErrorMessage(error)}\n`);
		});
	}

	if (planCard && planIndex) {
		await recordPlanCard(planIndex, workspaceId, planCard, { id: created.id, title: created.title });
	}

	return {
		ok: true,
		...(!devAssignment || devAssignment.outcome === "none"
			? {}
			: { devAssignment: formatDevAssignment(devAssignment) }),
		...(planCard
			? {
					plan: {
						kit: planCard.kitName,
						outcome: planCard.outcome,
						slug: planCard.slug,
						spec: `docs/specs/${planCard.slug}.md`,
						breakdown: `docs/specs/${planCard.slug}.cards.json`,
					},
				}
			: {}),
		task: {
			id: created.id,
			column: "backlog",
			workspacePath: workspaceRepoPath,
			title: created.title,
			prompt: created.prompt,
			baseRef: created.baseRef,
			startInPlanMode: created.startInPlanMode,
			autoReviewEnabled: created.autoReviewEnabled === true,
			autoReviewMode: created.autoReviewMode ?? "commit",
			...(created.role ? { role: created.role } : {}),
			...(created.agentId ? { agentId: created.agentId } : {}),
			...formatTaskAgentSettings(created.agentSettings),
		},
	};
}

async function updateTaskCommand(input: {
	cwd: string;
	taskId: string;
	title?: string;
	projectPath?: string;
	prompt?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: RuntimeTaskAutoReviewMode;
	agentId?: RuntimeAgentId | null;
	providerId?: string | null;
	modelId?: string | null;
	reasoningEffort?: ParsedTaskReasoningEffort;
}): Promise<JsonRecord> {
	if (
		input.title === undefined &&
		input.prompt === undefined &&
		input.baseRef === undefined &&
		input.startInPlanMode === undefined &&
		input.autoReviewEnabled === undefined &&
		input.autoReviewMode === undefined &&
		input.agentId === undefined &&
		input.providerId === undefined &&
		input.modelId === undefined &&
		input.reasoningEffort === undefined
	) {
		throw new Error("task update requires at least one field to change.");
	}

	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	let mergedAgentSettings: RuntimeTaskAgentSettings | null | undefined;
	const updated = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const taskRecord = findTaskRecord(runtimeState, input.taskId);
		if (!taskRecord) {
			throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
		}
		const agentSettings = buildTaskAgentSettingsForUpdate(taskRecord.task.agentSettings, {
			providerId: input.providerId,
			modelId: input.modelId,
			reasoningEffort: input.reasoningEffort,
		});
		mergedAgentSettings = agentSettings;

		const updatedTask = updateTask(runtimeState.board, input.taskId, {
			title: input.title ?? taskRecord.task.title,
			prompt: input.prompt ?? taskRecord.task.prompt,
			baseRef: input.baseRef ?? taskRecord.task.baseRef,
			startInPlanMode: input.startInPlanMode ?? taskRecord.task.startInPlanMode,
			autoReviewEnabled: input.autoReviewEnabled ?? taskRecord.task.autoReviewEnabled === true,
			autoReviewMode: input.autoReviewMode ?? taskRecord.task.autoReviewMode ?? "commit",
			agentId: input.agentId,
			agentSettings,
		});
		if (!updatedTask.updated || !updatedTask.task) {
			throw new Error(`Task "${input.taskId}" could not be updated.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: updatedTask.board,
		};

		return {
			board: updatedTask.board,
			value: formatTaskRecord(nextState, updatedTask.task, taskRecord.columnId),
		};
	});

	if (shouldWarnOnExplicitAgentId(input.agentId)) {
		warnOnAgentSettingsMechanismGaps(input.agentId, mergedAgentSettings ?? undefined);
	}

	return {
		ok: true,
		task: updated,
		workspacePath: workspaceRepoPath,
	};
}

async function linkTasks(input: {
	cwd: string;
	taskId: string;
	linkedTaskId: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const dependency = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const linked = addTaskDependency(runtimeState.board, input.taskId, input.linkedTaskId);
		if (!linked.added || !linked.dependency) {
			throw new Error(getLinkFailureMessage(linked.reason));
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: linked.board,
		};
		return {
			board: linked.board,
			value: formatDependencyRecord(nextState, linked.dependency),
		};
	});
	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		dependency,
	};
}

/**
 * Links many card pairs in one board save (`kanban plan expand`): `waitingTaskId` waits on `prerequisiteTaskId`, as
 * `task link --task-id <waiting> --linked-task-id <prerequisite>` for two Backlog cards. A pair that is already linked
 * is skipped, so a resumed expand doesn't fail on the links an earlier run added.
 */
export async function linkTaskPairs(input: {
	cwd: string;
	projectPath?: string;
	pairs: ReadonlyArray<{ waitingTaskId: string; prerequisiteTaskId: string }>;
}): Promise<{ added: RuntimeBoardDependency[]; skipped: number }> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	return await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (state) => {
		let board = state.board;
		const added: RuntimeBoardDependency[] = [];
		let skipped = 0;
		for (const pair of input.pairs) {
			const linked = addTaskDependency(board, pair.waitingTaskId, pair.prerequisiteTaskId);
			if (linked.added && linked.dependency) {
				board = linked.board;
				added.push(linked.dependency);
			} else if (linked.reason === "duplicate") {
				skipped += 1;
			} else {
				throw new Error(
					`Could not link ${pair.waitingTaskId} to ${pair.prerequisiteTaskId}: ${getLinkFailureMessage(linked.reason)}`,
				);
			}
		}
		return { board, value: { added, skipped } };
	});
}

async function unlinkTasks(input: { cwd: string; dependencyId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const removedDependency = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const dependency =
			runtimeState.board.dependencies.find((candidate) => candidate.id === input.dependencyId) ?? null;
		if (!dependency) {
			throw new Error(`Dependency "${input.dependencyId}" was not found in workspace ${workspaceRepoPath}.`);
		}

		const unlinked = removeTaskDependency(runtimeState.board, input.dependencyId);
		if (!unlinked.removed) {
			throw new Error(`Dependency "${input.dependencyId}" could not be removed.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: unlinked.board,
		};
		return {
			board: unlinked.board,
			value: formatDependencyRecord(nextState, dependency),
		};
	});
	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		removedDependency,
	};
}

export async function startTask(input: { cwd: string; taskId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const runtimeState = await runtimeClient.workspace.getState.query();
	const fromColumnId = getTaskColumnId(runtimeState.board, input.taskId);
	if (!fromColumnId) {
		throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
	}

	if (fromColumnId !== "backlog" && fromColumnId !== "in_progress") {
		throw new Error(
			`Task "${input.taskId}" is in "${fromColumnId}" and can only be started from backlog or in_progress.`,
		);
	}

	const currentRecord = findTaskRecord(runtimeState, input.taskId);
	const task = currentRecord?.task;
	if (!task) {
		throw new Error(`Task "${input.taskId}" could not be resolved.`);
	}

	const existingSession = runtimeState.sessions[task.id] ?? null;
	const shouldStartSession = !existingSession || existingSession.state !== "running";

	if (shouldStartSession) {
		const ensured = await runtimeClient.workspace.ensureWorktree.mutate({
			taskId: task.id,
			baseRef: task.baseRef,
		});
		if (!ensured.ok) {
			throw new Error(ensured.error ?? "Could not ensure task worktree.");
		}

		const started = await runtimeClient.runtime.startTaskSession.mutate({
			taskId: task.id,
			prompt: task.prompt,
			taskTitle: task.title,
			startInPlanMode: task.startInPlanMode,
			baseRef: task.baseRef,
			agentId: task.agentId,
			agentSettings: task.agentSettings,
		});
		if (!started.ok || !started.summary) {
			throw new Error(started.error ?? "Could not start task session.");
		}
	}

	const moved = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (latestState) => {
		const movement = moveTaskToColumn(latestState.board, input.taskId, "in_progress");
		if (!movement.task) {
			throw new Error(`Task "${input.taskId}" could not be resolved.`);
		}
		if (!movement.moved) {
			return {
				board: latestState.board,
				value: movement,
			};
		}
		return {
			board: movement.board,
			value: movement,
		};
	});

	if (!moved.moved) {
		return {
			ok: true,
			message: `Task "${input.taskId}" is already in progress.`,
			task: {
				id: task.id,
				prompt: task.prompt,
				column: "in_progress",
				workspacePath: workspaceRepoPath,
			},
		};
	}

	return {
		ok: true,
		task: {
			id: task.id,
			prompt: task.prompt,
			column: "in_progress",
			workspacePath: workspaceRepoPath,
		},
	};
}

interface TrashTaskExecutionResult {
	task: JsonRecord;
	taskId: string;
	previousColumnId: ListTaskColumn;
	readyTaskIds: string[];
	autoStartedTasks: JsonRecord[];
	worktreeDeleted: boolean;
	worktreeDeleteError?: string;
	landing?: RuntimeTaskLandingOutcome;
	alreadyInTrash: boolean;
}

function formatAutoStartedTask(
	state: RuntimeWorkspaceStateResponse,
	workspaceRepoPath: string,
	started: RuntimeTaskTrashAutoStart,
): JsonRecord {
	const record = findTaskRecord(state, started.taskId);
	return {
		ok: started.ok,
		...(started.error ? { error: started.error } : {}),
		task: {
			id: started.taskId,
			prompt: record?.task.prompt ?? null,
			column: record?.columnId ?? null,
			workspacePath: workspaceRepoPath,
		},
	};
}

// The Done steps (land on landing mode qa, stop sessions, keep the patch,
// delete the worktree, start linked backlog tasks) run in the runtime's shared
// workflow (src/server/task-trash-workflow.ts); the CLI only formats the result.
async function trashTaskById(input: {
	taskId: string;
	workspaceRepoPath: string;
	runtimeClient: RuntimeTrpcClient;
	landing?: RuntimeTaskLandingChoice;
	trigger?: "cli" | "approve";
}): Promise<TrashTaskExecutionResult> {
	const result = await input.runtimeClient.workspace.trashTask.mutate({
		taskId: input.taskId,
		trigger: input.trigger ?? "cli",
		...(input.landing ? { landing: input.landing } : {}),
	});
	if (result.status === "not_found" || result.status === "failed" || result.status === "blocked") {
		throw new Error(result.error ?? `Task "${input.taskId}" could not be moved to done.`);
	}
	const state = await input.runtimeClient.workspace.getState.query();
	const record = findTaskRecord(state, input.taskId);
	if (!record) {
		throw new Error(`Task "${input.taskId}" was not found in workspace ${input.workspaceRepoPath}.`);
	}
	const alreadyInTrash = result.status === "already_done";
	return {
		task: formatTaskRecord(state, record.task, record.columnId),
		taskId: input.taskId,
		previousColumnId: result.previousColumnId ?? record.columnId,
		readyTaskIds: result.readyTaskIds,
		autoStartedTasks: result.autoStartedTasks.map((started) =>
			formatAutoStartedTask(state, input.workspaceRepoPath, started),
		),
		worktreeDeleted: result.worktreeDeleted,
		worktreeDeleteError: result.worktreeDeleteError,
		...(result.landing ? { landing: result.landing } : {}),
		alreadyInTrash,
	};
}

function parseLandingChoice(options: { land?: boolean; discard?: boolean }): RuntimeTaskLandingChoice | undefined {
	if (options.land && options.discard) {
		throw new Error("Use --land or --discard, not both.");
	}
	return options.land ? "land" : options.discard ? "discard" : undefined;
}

export async function trashTask(input: {
	cwd: string;
	taskId?: string;
	column?: ListTaskColumn;
	projectPath?: string;
	landing?: RuntimeTaskLandingChoice;
}): Promise<JsonRecord> {
	const target = resolveTaskCommandTarget(input, "task done");
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);

	if (target.kind === "task") {
		const trashed = await trashTaskById({
			taskId: target.taskId,
			workspaceRepoPath,
			runtimeClient,
			landing: input.landing,
		});
		if (trashed.alreadyInTrash) {
			return {
				ok: true,
				message: `Task "${target.taskId}" is already done.`,
				task: trashed.task,
				workspacePath: workspaceRepoPath,
				readyTaskIds: [],
				autoStartedTasks: [],
			};
		}
		return {
			ok: true,
			task: trashed.task,
			workspacePath: workspaceRepoPath,
			readyTaskIds: trashed.readyTaskIds,
			autoStartedTasks: trashed.autoStartedTasks,
			worktreeDeleted: trashed.worktreeDeleted,
			worktreeDeleteError: trashed.worktreeDeleteError,
			...(trashed.landing ? { landing: trashed.landing } : {}),
		};
	}

	const initialState = await runtimeClient.workspace.getState.query();
	const targetTasks = findTasksInColumn(initialState, target.column);
	if (targetTasks.length === 0) {
		return {
			ok: true,
			column: target.column,
			workspacePath: workspaceRepoPath,
			trashedTasks: [],
			alreadyTrashedTasks: [],
			readyTaskIds: [],
			autoStartedTasks: [],
			worktreeCleanup: [],
			count: 0,
		};
	}

	const results: TrashTaskExecutionResult[] = [];
	for (const { task } of targetTasks) {
		results.push(
			await trashTaskById({
				taskId: task.id,
				workspaceRepoPath,
				runtimeClient,
				landing: input.landing,
			}),
		);
	}

	const trashedTasks = results.filter((result) => !result.alreadyInTrash);
	const alreadyTrashedTasks = results.filter((result) => result.alreadyInTrash);

	return {
		ok: true,
		column: target.column,
		workspacePath: workspaceRepoPath,
		trashedTasks: trashedTasks.map((result) => result.task),
		alreadyTrashedTasks: alreadyTrashedTasks.map((result) => result.task),
		readyTaskIds: [...new Set(trashedTasks.flatMap((result) => result.readyTaskIds))],
		autoStartedTasks: trashedTasks.flatMap((result) => result.autoStartedTasks),
		worktreeCleanup: trashedTasks.map((result) => ({
			taskId: result.taskId,
			removed: result.worktreeDeleted,
			error: result.worktreeDeleteError,
		})),
		count: trashedTasks.length,
	};
}

/**
 * `kanban task approve`: Approve & land. On landing mode qa, Kanban squash-lands the task onto its base (no QA,
 * recorded as HUMAN_APPROVED in the decision log) and moves it to Done; a conflict leaves it where it is. On any
 * other landing mode it is the same as `task done`.
 */
export async function approveTask(input: { cwd: string; taskId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const approved = await trashTaskById({
		taskId: input.taskId,
		workspaceRepoPath,
		runtimeClient,
		landing: "land",
		trigger: "approve",
	});
	return {
		ok: true,
		...(approved.alreadyInTrash ? { message: `Task "${input.taskId}" is already done.` } : {}),
		task: approved.task,
		workspacePath: workspaceRepoPath,
		landing: approved.landing ?? null,
		readyTaskIds: approved.readyTaskIds,
		autoStartedTasks: approved.autoStartedTasks,
		worktreeDeleted: approved.worktreeDeleted,
		worktreeDeleteError: approved.worktreeDeleteError,
	};
}

/**
 * `kanban task handback`: gives an escalated card back to the pipeline (src/pipeline/handback.ts). The card loses its
 * `BLOCKED: ` title prefix; with `--extra-rounds N` it goes from Backlog to Review, where the pipeline reworks the
 * FAIL that escalated it with N more FAIL rounds. Without extra rounds, or after a STALLED QA round (never reworked),
 * it stays in Backlog for you to restart, and the result says so.
 */
export async function handbackTask(input: {
	cwd: string;
	taskId: string;
	note: string;
	extraRounds: number;
	by?: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const runoffsPath = getWatchdogWorkspacePaths(workspaceId).runoffs;
	// A card of a decided runoff that has a winner (or lands nothing: benchOnly) must not come back: its next PASS
	// would land next to the winner. Only a runoff decided with no winner reopens (below).
	const decidedRunoff = (await readRunoffs(runoffsPath)).runoffs.find(
		(runoff) => runoff.cards.includes(input.taskId) && runoff.decided && (runoff.winner || runoff.benchOnly === true),
	);
	if (decidedRunoff) {
		throw new Error(
			`Task "${input.taskId}" raced in runoff ${decidedRunoff.name}, which is decided (${decidedRunoff.benchOnly === true ? "bench only, nothing lands" : `winner ${decidedRunoff.winner}`}); handing it back would let it land too. Discard it (kanban task done --task-id ${input.taskId} --discard) or start a new card.`,
		);
	}
	const result = await handBackTask(createPipelineStateStore(), {
		workspaceId,
		taskId: input.taskId,
		note: input.note,
		extraRounds: input.extraRounds,
		by: input.by?.trim() || "orchestrator",
		now: Date.now(),
	});
	// A runoff decided with no winner (every card escalated) reopens when one of its cards comes back. Ported from
	// archive/devteam-kit:bin/kit@6da71597 (158817d; tier2-coupons 10/06).
	const runoffReopened = await reopenRunoffWithoutWinner(runoffsPath, input.taskId, result.handback.at);
	await createQaLogAppender()(
		workspaceId,
		runoffReopened
			? `${result.qaLogSection}- Runoff ${runoffReopened} had no winner; reopened.\n`
			: result.qaLogSection,
	);
	const task = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (state) => {
		const record = findTaskRecord(state, input.taskId);
		if (!record) {
			return { board: state.board, value: null };
		}
		let board = state.board;
		let card = record.task;
		let columnId = record.columnId;
		if (card.title.startsWith(BLOCKED_TITLE_PREFIX)) {
			const updated = updateTask(board, card.id, {
				title: card.title.slice(BLOCKED_TITLE_PREFIX.length),
				prompt: card.prompt,
				baseRef: card.baseRef,
				startInPlanMode: card.startInPlanMode,
				autoReviewEnabled: card.autoReviewEnabled === true,
				autoReviewMode: card.autoReviewMode,
				images: card.images,
			});
			if (updated.updated && updated.task) {
				board = updated.board;
				card = updated.task;
			}
		}
		if (result.reworks && columnId === "backlog") {
			const moved = moveTaskToColumn(board, card.id, "review");
			if (moved.moved) {
				board = moved.board;
				card = moved.task ?? card;
				columnId = "review";
			}
		}
		return { board, value: formatTaskRecord({ ...state, board }, card, columnId) };
	});
	return {
		ok: true,
		task,
		workspacePath: workspaceRepoPath,
		handback: result.handback,
		...(runoffReopened ? { runoffReopened } : {}),
		message: result.reworks
			? `Escalation cleared with ${input.extraRounds} more FAIL round(s); the pipeline reworks the card's last FAIL once it is in Review.`
			: input.extraRounds > 0
				? `Escalation cleared with ${input.extraRounds} more FAIL round(s), but it was escalated over a STALLED QA round, which the pipeline does not rework: restart the card (or change it) so it gets a new snapshot and QA round.`
				: "Escalation cleared, no extra rounds: restart or rework the card yourself.",
	};
}

/**
 * `kanban task release-hold`: the human way out of the pipeline's hold (src/pipeline/hold.ts). The hold is lifted
 * (logged in the pipeline state and the QA log), then the card goes through the ordinary Done workflow with the
 * chosen landing, as `kanban task done --land|--discard` does. `--discard --tag preserve/…` tags its work first. A land that
 * fails (a conflict) leaves the card unheld in Review.
 */
export async function releaseHoldTask(input: {
	cwd: string;
	taskId: string;
	landing: RuntimeTaskLandingChoice;
	tag?: string;
	note?: string;
	by?: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const store = createPipelineStateStore();
	const hold = readPipelineHold((await store.peek(workspaceId))?.cards[input.taskId]);
	if (!hold) {
		throw new Error(`Task "${input.taskId}" is not held in the pipeline state of ${workspaceId}.`);
	}
	const tag = input.tag?.trim() || null;
	if (tag) {
		await preserveTaskWork({ workspacePath: workspaceRepoPath, taskId: input.taskId, tag });
	}
	const by = input.by?.trim() || "orchestrator";
	const note = input.note?.trim() || `kanban task release-hold --${input.landing}`;
	await clearHold(store, { workspaceId, taskId: input.taskId, by, reason: note, now: Date.now() });
	await createQaLogAppender()(
		workspaceId,
		`\n## HOLD RELEASED ${input.taskId}: ${input.landing}${tag ? ` (work kept as tag ${tag})` : ""}\n- ${new Date().toISOString()} by ${by} (kanban task release-hold): ${note}\n- Was held for ${hold.group} since ${hold.at} (round ${hold.round}).\n`,
	);
	const done = await trashTask({
		cwd: input.cwd,
		taskId: input.taskId,
		projectPath: workspaceRepoPath,
		landing: input.landing,
	});
	return { ...done, released: { group: hold.group, landing: input.landing, tag } };
}

async function deleteTaskCommand(input: {
	cwd: string;
	taskId?: string;
	column?: ListTaskColumn;
	projectPath?: string;
}): Promise<JsonRecord> {
	const target = resolveTaskCommandTarget(input, "task delete");
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const mutation = await mutateWorkspaceState(workspaceRepoPath, (latestState) => {
		const latestTargetRecords =
			target.kind === "task"
				? (() => {
						const record = findTaskRecord(latestState, target.taskId);
						if (!record) {
							throw new Error(`Task "${target.taskId}" was not found in workspace ${workspaceRepoPath}.`);
						}
						return [record];
					})()
				: findTasksInColumn(latestState, target.column);

		if (latestTargetRecords.length === 0) {
			return {
				board: latestState.board,
				value: {
					deletedCards: [] as DeletedCardRecord[],
					deletedTasks: [] as JsonRecord[],
				},
				save: false,
			};
		}

		const deleted = deleteTasksFromBoard(
			latestState.board,
			latestTargetRecords.map(({ task }) => task.id),
		);
		if (!deleted.deleted) {
			return {
				board: latestState.board,
				value: {
					deletedCards: [] as DeletedCardRecord[],
					deletedTasks: [] as JsonRecord[],
				},
				save: false,
			};
		}

		const deletedTasks = latestTargetRecords.map(({ task, columnId }) =>
			formatTaskRecord(latestState, task, columnId),
		);
		const deletedIds = new Set(deleted.deletedTaskIds);
		const deletedCards = latestTargetRecords
			.filter(({ task }) => deletedIds.has(task.id))
			.map(({ task, columnId }) => ({
				taskId: task.id,
				columnId,
				role: resolveCardRole(task),
				title: task.title ?? null,
			}));
		return {
			board: deleted.board,
			value: {
				deletedCards,
				deletedTasks,
			},
		};
	});

	if (mutation.saved) {
		await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	}

	if (mutation.value.deletedCards.length === 0) {
		return {
			ok: true,
			workspacePath: workspaceRepoPath,
			column: target.kind === "column" ? target.column : null,
			deletedTasks: [],
			count: 0,
		};
	}

	// The server stops the sessions (the task's and its detail terminal) with the worktree cleanup.
	const workspaceCleanupResults = await Promise.all(
		mutation.value.deletedCards.map(async (card) => ({
			taskId: card.taskId,
			...(await deleteTaskWorkspace(runtimeClient, card)),
		})),
	);

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		column: target.kind === "column" ? target.column : null,
		deletedTasks: mutation.value.deletedTasks,
		count: mutation.value.deletedCards.length,
		worktreeCleanup: workspaceCleanupResults,
	};
}

/**
 * Resolve a settings flag that has both a generic form and a deprecated
 * `--cline-*` alias. Passing both forms for the same field is an error.
 */
export function resolveSettingsFlag(
	generic: string | undefined,
	alias: string | undefined,
	genericName: string,
	aliasName: string,
): string | undefined {
	if (generic !== undefined && alias !== undefined) {
		throw new Error(`Cannot use both ${genericName} and the deprecated ${aliasName} for the same field.`);
	}
	return generic ?? alias;
}

function parseOptionalBooleanOption(value: unknown, flagName: string): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === true || value === false) {
		return value;
	}
	if (typeof value !== "string") {
		throw new Error(`Invalid boolean value for ${flagName}. Use true or false.`);
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") {
		return true;
	}
	if (normalized === "false" || normalized === "0" || normalized === "no") {
		return false;
	}
	throw new Error(`Invalid boolean value for ${flagName}: "${value}". Use true or false.`);
}

function parsePositiveIntegerOption(value: string): number {
	const number = Number(value);
	if (!Number.isInteger(number) || number <= 0) {
		throw new Error(`Expected a positive whole number, got "${value}".`);
	}
	return number;
}

async function runTaskCommand(handler: () => Promise<JsonRecord>): Promise<void> {
	try {
		printJson(await handler());
	} catch (error) {
		printJson({
			ok: false,
			error: `Task command failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
}

export function registerTaskCommand(program: Command): void {
	const task = program.command("task").alias("tasks").description("Manage Kanban board tasks from the CLI.");

	task
		.command("list")
		.description("List Kanban tasks for a workspace.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option(
			"--column <column>",
			"Filter column: backlog | in_progress | review | done. trash is also accepted.",
			parseListColumn,
		)
		.action(async (options: { projectPath?: string; column?: ListTaskColumn }) => {
			await runTaskCommand(
				async () =>
					await listTasks({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						column: options.column,
					}),
			);
		});

	task
		.command("history")
		.description(
			"Show who moved cards to Done or deleted them: trigger, caller, from-column, landing, sessions stopped, worktree deleted.",
		)
		.argument("[taskId]", "Only this task's entries.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--limit <n>", "Only the newest n entries (default 50 without a task id).", parsePositiveIntegerOption)
		.action(async (taskId: string | undefined, options: { projectPath?: string; limit?: number }) => {
			await runTaskCommand(
				async () =>
					await listTaskHistory({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						taskId: taskId?.trim() || undefined,
						limit: options.limit,
					}),
			);
		});

	task
		.command("create")
		.description("Create a task in backlog.")
		.option("--title <text>", "Task title.")
		.requiredOption("--prompt <text>", "Task prompt text.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--base-ref <branch>", "Task base branch/ref.")
		.option("--start-in-plan-mode [value]", "Set plan mode (true|false). Flag-only implies true.")
		.option("--auto-review-enabled [value]", "Enable auto-review behavior (true|false). Flag-only implies true.")
		.option(
			"--auto-review-mode <mode>",
			"Auto-review mode: commit | pr | qa (qa: the pipeline QA-gates the card and Kanban lands it; for landing mode qa).",
			parseAutoReviewMode,
		)
		.option(
			"--role <role>",
			"Card role: dev (default) | qa | triage | calibration | plan. Only dev cards are QA'd or reworked. plan: --prompt is the business requirement; the project's kit picks the planner (agent, model, plan mode) and the card gets the plan prompt (spec + card breakdown, see kanban plan).",
			parseTaskRole,
		)
		.option(
			"--plan-slug <slug>",
			"For --role plan: the spec's file name, docs/specs/<slug>.md (default from the title).",
		)
		.option(
			"--agent-id <id>",
			'Agent override: cline | claude | codex | copilot | droid | gemini | opencode | kiro | default. Without --agent-id, --provider or --model, the project\'s routing kit may choose the agent and model; "default" keeps the selected agent.',
		)
		.option("--provider <id>", "Provider override for the task's agent. Valid values depend on the agent.")
		.option("--model <id>", "Model override for the task's agent. Valid values depend on the agent.")
		.option("--effort <level>", "Reasoning effort override for the task's agent. Valid values depend on the agent.")
		.option("--cline-provider <id>", "(Deprecated: use --provider) Provider override for the task's agent.")
		.option("--cline-model <id>", "(Deprecated: use --model) Model override for the task's agent.")
		.option("--cline-reasoning-effort <level>", "(Deprecated: use --effort) Reasoning effort override.")
		.action(
			async (options: {
				title?: string;
				prompt: string;
				projectPath?: string;
				baseRef?: string;
				startInPlanMode?: unknown;
				autoReviewEnabled?: unknown;
				autoReviewMode?: RuntimeTaskAutoReviewMode;
				role?: RuntimeTaskRole;
				agentId?: string;
				provider?: string;
				model?: string;
				effort?: string;
				clineProvider?: string;
				clineModel?: string;
				clineReasoningEffort?: string;
				planSlug?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await createTask({
							cwd: process.cwd(),
							planSlug: options.planSlug,
							title: options.title,
							prompt: options.prompt,
							projectPath: options.projectPath,
							baseRef: options.baseRef,
							startInPlanMode: parseOptionalBooleanOption(options.startInPlanMode, "--start-in-plan-mode"),
							autoReviewEnabled: parseOptionalBooleanOption(options.autoReviewEnabled, "--auto-review-enabled"),
							autoReviewMode: options.autoReviewMode,
							role: options.role,
							agentId: parseAgentId(options.agentId),
							agentSettings: buildTaskAgentSettingsForCreate({
								providerId:
									parseOptionalStringOrDefault(
										resolveSettingsFlag(
											options.provider,
											options.clineProvider,
											"--provider",
											"--cline-provider",
										),
									) ?? undefined,
								modelId:
									parseOptionalStringOrDefault(
										resolveSettingsFlag(options.model, options.clineModel, "--model", "--cline-model"),
									) ?? undefined,
								reasoningEffort: parseTaskReasoningEffort(
									resolveSettingsFlag(
										options.effort,
										options.clineReasoningEffort,
										"--effort",
										"--cline-reasoning-effort",
									),
								),
							}),
						}),
				);
			},
		);

	task
		.command("update")
		.description("Update an existing task.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--title <text>", "Replacement task title.")
		.option("--prompt <text>", "Replacement task prompt.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--base-ref <branch>", "Replacement base branch/ref.")
		.option("--start-in-plan-mode [value]", "Set plan mode (true|false). Flag-only implies true.")
		.option("--auto-review-enabled [value]", "Enable auto-review behavior (true|false). Flag-only implies true.")
		.option(
			"--auto-review-mode <mode>",
			"Auto-review mode: commit | pr | qa (qa: the pipeline QA-gates the card and Kanban lands it; for landing mode qa).",
			parseAutoReviewMode,
		)
		.option(
			"--agent-id <id>",
			'Agent override: cline | claude | codex | copilot | droid | gemini | opencode | kiro. Use "default" to clear.',
		)
		.option(
			"--provider <id>",
			'Provider override for the task\'s agent. Use "default" to clear. Valid values depend on the agent.',
		)
		.option(
			"--model <id>",
			'Model override for the task\'s agent. Use "default" to clear. Valid values depend on the agent.',
		)
		.option(
			"--effort <level>",
			'Reasoning effort override for the task\'s agent. Use "default" or "inherit" to clear.',
		)
		.option("--cline-provider <id>", "(Deprecated: use --provider) Provider override for the task's agent.")
		.option("--cline-model <id>", "(Deprecated: use --model) Model override for the task's agent.")
		.option("--cline-reasoning-effort <level>", "(Deprecated: use --effort) Reasoning effort override.")
		.action(
			async (options: {
				taskId: string;
				title?: string;
				prompt?: string;
				projectPath?: string;
				baseRef?: string;
				startInPlanMode?: unknown;
				autoReviewEnabled?: unknown;
				autoReviewMode?: RuntimeTaskAutoReviewMode;
				agentId?: string;
				provider?: string;
				model?: string;
				effort?: string;
				clineProvider?: string;
				clineModel?: string;
				clineReasoningEffort?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await updateTaskCommand({
							cwd: process.cwd(),
							taskId: options.taskId,
							title: options.title,
							projectPath: options.projectPath,
							prompt: options.prompt,
							baseRef: options.baseRef,
							startInPlanMode: parseOptionalBooleanOption(options.startInPlanMode, "--start-in-plan-mode"),
							autoReviewEnabled: parseOptionalBooleanOption(options.autoReviewEnabled, "--auto-review-enabled"),
							autoReviewMode: options.autoReviewMode,
							agentId: parseAgentId(options.agentId),
							providerId: parseOptionalStringOrDefault(
								resolveSettingsFlag(options.provider, options.clineProvider, "--provider", "--cline-provider"),
							),
							modelId: parseOptionalStringOrDefault(
								resolveSettingsFlag(options.model, options.clineModel, "--model", "--cline-model"),
							),
							reasoningEffort: parseTaskReasoningEffort(
								resolveSettingsFlag(
									options.effort,
									options.clineReasoningEffort,
									"--effort",
									"--cline-reasoning-effort",
								),
							),
						}),
				);
			},
		);

	task
		.command("trash")
		.alias("done")
		.description("Move a task or an entire column to done and clean up task workspaces.")
		.option("--task-id <id>", "Task ID.")
		.option(
			"--column <column>",
			"Column to move to done: backlog | in_progress | review | done. trash is also accepted.",
			parseListColumn,
		)
		.option(
			"--land",
			"Landing mode qa: squash-land the work onto its base first (same as task approve). Required, or --discard, when the task has work not on its base.",
		)
		.option("--discard", "Landing mode qa: move to done without landing the work (its patch is still saved).")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(
			async (options: {
				taskId?: string;
				column?: ListTaskColumn;
				projectPath?: string;
				land?: boolean;
				discard?: boolean;
			}) => {
				await runTaskCommand(
					async () =>
						await trashTask({
							cwd: process.cwd(),
							taskId: options.taskId,
							column: options.column,
							projectPath: options.projectPath,
							landing: parseLandingChoice(options),
						}),
				);
			},
		);

	task
		.command("approve")
		.description(
			"Approve & land: on landing mode qa, squash-land the task onto its base without QA, then move it to done.",
		)
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await approveTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("handback")
		.description(
			"Give an escalated task back to the pipeline (landing mode qa): clears the escalation, drops the BLOCKED: prefix.",
		)
		.requiredOption("--task-id <id>", "Task ID.")
		.requiredOption("--note <text>", "Why it goes back (recorded in the QA log and the pipeline state).")
		.option(
			"--extra-rounds <n>",
			"Grant N more FAIL rounds; the task moves to Review and the pipeline reworks the FAIL that escalated it.",
			"0",
		)
		.option("--by <name>", "Who hands it back (default: orchestrator).")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(
			async (options: { taskId: string; note: string; extraRounds: string; by?: string; projectPath?: string }) => {
				await runTaskCommand(
					async () =>
						await handbackTask({
							cwd: process.cwd(),
							taskId: options.taskId,
							note: options.note,
							extraRounds: Number(options.extraRounds),
							by: options.by,
							projectPath: options.projectPath,
						}),
				);
			},
		);

	task
		.command("release-hold")
		.description(
			"Release a task the pipeline holds (a runoff PASS, landing mode qa): lift the hold and finish it with --land or --discard.",
		)
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--land", "Land the task onto its base, then Done.")
		.option("--discard", "Done without landing.")
		.option("--tag <tag>", "Tag its work first (preserve/<id>-<model>), e.g. with --discard.")
		.option("--note <text>", "Why (recorded in the QA log).")
		.option("--by <name>", "Who releases it (default: orchestrator).")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(
			async (options: {
				taskId: string;
				land?: boolean;
				discard?: boolean;
				tag?: string;
				note?: string;
				by?: string;
				projectPath?: string;
			}) => {
				await runTaskCommand(async () => {
					if (Boolean(options.land) === Boolean(options.discard)) {
						throw new Error("task release-hold needs exactly one of --land or --discard.");
					}
					return await releaseHoldTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						landing: options.land ? "land" : "discard",
						tag: options.tag,
						note: options.note,
						by: options.by,
						projectPath: options.projectPath,
					});
				});
			},
		);

	task
		.command("delete")
		.description("Permanently delete a task or every task in a column.")
		.option("--task-id <id>", "Task ID to permanently delete.")
		.option(
			"--column <column>",
			"Column to bulk-delete: backlog | in_progress | review | done. trash is also accepted.",
			parseListColumn,
		)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId?: string; column?: ListTaskColumn; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await deleteTaskCommand({
						cwd: process.cwd(),
						taskId: options.taskId,
						column: options.column,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("link")
		.description("Link two tasks so one task waits on another.")
		.requiredOption("--task-id <id>", "One of the two task IDs to link.")
		.requiredOption("--linked-task-id <id>", "The other task ID to link.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.addHelpText(
			"after",
			[
				"",
				"Dependency direction:",
				"  If both linked tasks are in backlog, Kanban preserves the order you pass:",
				"  --task-id waits on --linked-task-id, and on the board the arrow points into",
				"  --linked-task-id.",
				"  Once only one linked task remains in backlog, Kanban reorients the saved link",
				"  so the backlog task is the waiting dependent task and the other task is the",
				"  prerequisite.",
				"  When the prerequisite finishes review and moves to done, the waiting backlog",
				"  task becomes ready to start.",
				"",
			].join("\n"),
		)
		.action(async (options: { taskId: string; linkedTaskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await linkTasks({
						cwd: process.cwd(),
						taskId: options.taskId,
						linkedTaskId: options.linkedTaskId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("unlink")
		.description("Remove an existing dependency link.")
		.requiredOption("--dependency-id <id>", "Dependency ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { dependencyId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await unlinkTasks({
						cwd: process.cwd(),
						dependencyId: options.dependencyId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("start")
		.description("Start a task session and move task to in_progress.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await startTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("send")
		.description(
			"Type a message into a task's agent and confirm it was picked up (text, or @file for a file's contents).",
		)
		.argument("<taskId>", "Task ID.")
		.argument("<text>", "The message, or @path to send a file's contents.")
		.option("--no-enter", "Type the text without pressing Enter.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (taskId: string, text: string, options: { enter: boolean; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await sendTaskMessage({
						cwd: process.cwd(),
						taskId,
						text,
						enter: options.enter,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("resume")
		.description(
			"Restart tasks whose session died (a Kanban or container restart): WIP tag, a new session with the card prompt (+ a WIP note when the worktree has changes), In Progress. Same agent and model.",
		)
		.argument("<taskIds...>", "Task IDs.")
		.option("--dry-run", "Print what would happen; tag and start nothing.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (taskIds: string[], options: { dryRun?: boolean; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await resumeTasks({
						cwd: process.cwd(),
						taskIds,
						dryRun: options.dryRun === true,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("restart-fresh")
		.description(
			"Start a task over, possibly on another model: preserve the worktree as preserve/<id>-<label>, stop the session, reset the worktree to the base, drop REWORK sections and the BLOCKED prefix, set the model, reset its pipeline history, start it.",
		)
		.argument("<taskId>", "Task ID.")
		.requiredOption("--model <id>", "Model for the restarted card.")
		.requiredOption("--label <suffix>", "Tag suffix: the work so far is kept as preserve/<id>-<label>.")
		.option("--provider <id>", "Provider for the model (kept from the card when omitted).")
		.option("--hold", "Leave it in Backlog instead of starting it.")
		.option("--after <taskId>", "Link it to wait on this task (implies --hold).")
		.option("--note <text>", "Note stored with the pipeline history reset.")
		.option("--dry-run", "Print the steps; change nothing.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(
			async (
				taskId: string,
				options: {
					model: string;
					label: string;
					provider?: string;
					hold?: boolean;
					after?: string;
					note?: string;
					dryRun?: boolean;
					projectPath?: string;
				},
			) => {
				await runTaskCommand(
					async () =>
						await restartTaskFresh({
							cwd: process.cwd(),
							taskId,
							model: options.model,
							label: options.label,
							provider: options.provider,
							hold: options.hold === true,
							after: options.after,
							note: options.note,
							dryRun: options.dryRun === true,
							projectPath: options.projectPath,
						}),
				);
			},
		);
}
