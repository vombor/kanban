import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";
import { parsePlanBreakdown } from "../plans/plan-breakdown";
import { createPlanIndexStore, type PlanIndexStore } from "../plans/plan-index";
import { getPlanIndexPath, getProjectKnowledgePaths } from "../state/kanban-home";
import { knowledgeRevisionSchema } from "../trpc/knowledge-contract";
import {
	executionTaskIdSchema,
	type KnowledgeAttempt,
	type KnowledgeSource,
	knowledgeSourceSchema,
	type TaskContextAdoptRequest,
	type TaskContextStartReservation,
	type TaskKnowledgeContext,
	taskKnowledgeContextSchema,
} from "../trpc/knowledge-execution-contract";
import { hashKnowledgeContent } from "./content-store";
import { KnowledgeError } from "./knowledge-error";
import { describeKnowledgeRevision, findKnowledgeRevision } from "./knowledge-revisions";
import { createProjectKnowledgeStore, type ProjectKnowledgeStore } from "./knowledge-store";
import { createPlanBundleStore, type PlanBundleStore } from "./plan-bundle-store";
import { applyTaskContextAdoption, findTaskContextAdoption } from "./task-context-adoption";
import { readTaskContextState, type TaskContextState, writeTaskContextState } from "./task-context-state";
import { createKnowledgeAttemptStore, inheritTaskContext, type ReserveKnowledgeAttempt } from "./task-context-workflow";

export interface TaskContextInspection {
	context: TaskKnowledgeContext | null;
	history: TaskKnowledgeContext[];
	startReservation: TaskContextStartReservation | null;
}
export interface TaskContextStore {
	attachDerived(
		workspaceId: string,
		taskId: string,
		source: KnowledgeSource,
		canAttach?: () => Promise<boolean>,
	): Promise<TaskKnowledgeContext | null>;
	attempts(workspaceId: string, taskId: string): Promise<KnowledgeAttempt[]>;
	reserveAttempt(
		workspaceId: string,
		input: ReserveKnowledgeAttempt,
		rootRevision?: string,
	): Promise<{ context: TaskKnowledgeContext; attempt: KnowledgeAttempt } | null>;
	settleAttempt(
		workspaceId: string,
		taskId: string,
		id: string,
		outcome: "started" | "uncertain",
		startedAt: number | null,
	): Promise<void>;
	read(workspaceId: string, taskId: string, revision?: string): Promise<TaskKnowledgeContext | null>;
	inspect(workspaceId: string, taskId: string): Promise<TaskContextInspection>;
	attachExpansion(workspaceId: string, planTaskId: string): Promise<void>;
	reserveStart(workspaceId: string, taskId: string): Promise<TaskKnowledgeContext | null>;
	adopt(
		workspaceId: string,
		input: TaskContextAdoptRequest,
		canAdopt: () => Promise<boolean>,
	): Promise<{ context: TaskKnowledgeContext; duplicate: boolean }>;
}
/** Task ids and immutable pinned versions are retained after pruning. This store never approves, creates or starts a task. */
export function createTaskContextStore(
	options: {
		homePath?: string;
		index?: PlanIndexStore;
		bundles?: PlanBundleStore;
		knowledge?: ProjectKnowledgeStore;
		now?: () => Date;
	} = {},
): TaskContextStore {
	const index =
			options.index ??
			createPlanIndexStore({ getPath: (workspaceId) => getPlanIndexPath(workspaceId, options.homePath) }),
		bundles = options.bundles ?? createPlanBundleStore({ homePath: options.homePath });
	const knowledge = options.knowledge ?? createProjectKnowledgeStore({ homePath: options.homePath });
	const file = (workspaceId: string) =>
		join(getProjectKnowledgePaths(workspaceId, options.homePath).root, "task-contexts.json");
	const snapshot = (workspaceId: string) => readTaskContextState(file(workspaceId));
	const validateHistory = async (workspaceId: string, history: TaskKnowledgeContext[]) => {
		const original = history[0];
		if (!original) return;
		const bundle = await bundles.read(workspaceId, original.bundleRevision);
		if (
			bundle.planTaskId !== original.planTaskId ||
			(!original.inheritance &&
				original.documents.some(
					(document) => !bundle.documents.some((item) => JSON.stringify(item) === JSON.stringify(document)),
				))
		)
			throw new KnowledgeError(
				"PRECONDITION_FAILED",
				"Original task context no longer matches its reviewed bundle.",
			);
		const manifest = await knowledge.snapshot(workspaceId),
			hashes = new Set<string>();
		for (const context of history)
			for (const document of context.documents) {
				const actual = describeKnowledgeRevision(findKnowledgeRevision(manifest, document.id, document.revision));
				if (JSON.stringify(actual) !== JSON.stringify(document))
					throw new KnowledgeError(
						"PRECONDITION_FAILED",
						"A retained task reference does not match its exact published revision.",
					);
				hashes.add(document.contentHash);
			}
		for (const hash of hashes) await knowledge.readContent(workspaceId, hash);
	};
	const inspectState = async (
		workspaceId: string,
		taskId: string,
		state: TaskContextState,
	): Promise<TaskContextInspection> => {
		const history = state.tasks[taskId] ?? [];
		if (!history.length) {
			const plans = await index.read(workspaceId);
			if (
				Object.values(plans.plans).some(
					(plan) => plan.expansion?.bundleRevision && Object.values(plan.expansion.cards).includes(taskId),
				)
			)
				throw new KnowledgeError(
					"PRECONDITION_FAILED",
					"The reserved task's pinned knowledge handoff is missing; no unpinned launch/read fallback is permitted.",
				);
		}
		await validateHistory(workspaceId, history);
		return { context: history.at(-1) ?? null, history, startReservation: state.starts?.[taskId] ?? null };
	};
	const inspect = async (workspaceId: string, taskId: string): Promise<TaskContextInspection> => {
		if (!executionTaskIdSchema.safeParse(taskId).success)
			return { context: null, history: [], startReservation: null };
		return inspectState(workspaceId, taskId, await snapshot(workspaceId));
	};
	const attemptStore = createKnowledgeAttemptStore({
		file,
		snapshot,
		inspect: inspectState,
		now: options.now ?? (() => new Date()),
	});
	return {
		reserveAttempt: async (workspaceId, input, rootRevision) => {
			if (!executionTaskIdSchema.safeParse(input.taskId).success) {
				if (rootRevision)
					throw new KnowledgeError("PRECONDITION_FAILED", "Invalid retained handoff task identity.");
				return null;
			}
			return attemptStore.reserve(workspaceId, input, rootRevision);
		},
		settleAttempt: attemptStore.settle,
		attempts: async (workspaceId, taskId) => {
			const state = await snapshot(workspaceId);
			await inspectState(workspaceId, executionTaskIdSchema.parse(taskId), state);
			return state.attempts?.[taskId] ?? [];
		},
		attachDerived: async (workspaceId, taskId, raw, canAttach) =>
			lockedFileSystem.withLock({ path: file(workspaceId) }, async () => {
				const id = executionTaskIdSchema.parse(taskId),
					source = knowledgeSourceSchema.parse(raw);
				if (!executionTaskIdSchema.safeParse(source.sourceTaskId).success) return null;
				const state = await snapshot(workspaceId);
				await inspectState(workspaceId, source.sourceTaskId, state);
				if (state.tasks[id]) await inspectState(workspaceId, id, state);
				if (!state.tasks[id] && canAttach && !(await canAttach()))
					throw new KnowledgeError(
						"PRECONDITION_FAILED",
						"A derived handoff cannot attach to an existing, started or historical task.",
					);
				const context = inheritTaskContext(state, id, source, (options.now?.() ?? new Date()).toISOString());
				if (context) await writeTaskContextState(file(workspaceId), state);
				return context;
			}),
		inspect,
		read: async (workspaceId, taskId, revision) => {
			const parsedId = executionTaskIdSchema.safeParse(taskId);
			// Legacy/synthetic ordinary session ids cannot have a newly reserved plan handoff; do not break their launches.
			if (!parsedId.success) {
				if (revision) throw new KnowledgeError("NOT_FOUND", "That session has no retained plan task context.");
				return null;
			}
			const { history } = await inspect(workspaceId, parsedId.data);
			if (!history.length) {
				if (revision)
					throw new KnowledgeError("NOT_FOUND", "This task has no matching retained knowledge context.");
				return null;
			}
			const context = revision
				? history.find((item) => item.revision === knowledgeRevisionSchema.parse(revision))
				: history.at(-1);
			if (!context) throw new KnowledgeError("NOT_FOUND", "That pinned task-context revision is not retained.");
			return context;
		},
		reserveStart: async (workspaceId, taskId) => {
			if (!executionTaskIdSchema.safeParse(taskId).success) return null;
			return lockedFileSystem.withLock({ path: file(workspaceId) }, async () => {
				const state = await snapshot(workspaceId),
					view = await inspectState(workspaceId, taskId, state);
				if (!view.context) return null;
				if (!view.startReservation) {
					state.starts ??= {};
					state.starts[taskId] = {
						contextRevision: view.context.revision,
						at: (options.now?.() ?? new Date()).toISOString(),
					};
					await writeTaskContextState(file(workspaceId), state);
				}
				return view.context;
			});
		},
		adopt: async (workspaceId, input, canAdopt) =>
			lockedFileSystem.withLocks(
				[{ path: file(workspaceId) }, { path: getProjectKnowledgePaths(workspaceId, options.homePath).manifest }],
				async () => {
					const state = await snapshot(workspaceId),
						receipt = findTaskContextAdoption(state, input);
					if (receipt) {
						await inspectState(workspaceId, receipt.taskId, state);
						return { context: receipt, duplicate: true };
					}
					await inspectState(workspaceId, input.taskId, state);
					if (state.starts?.[input.taskId] || !(await canAdopt()))
						throw new KnowledgeError(
							"PRECONDITION_FAILED",
							"Reference adoption requires a provably unstarted Backlog dev task, with no physical-start reservation, session, worktree or prior task history.",
						);
					const actual = describeKnowledgeRevision(
						findKnowledgeRevision(await knowledge.snapshot(workspaceId), input.documentId),
					);
					if (actual.revision !== input.targetRevision)
						throw new KnowledgeError(
							"CONFLICT",
							"The replacement document changed since review; select its exact current revision again.",
						);
					await knowledge.readContent(workspaceId, actual.contentHash);
					const context = applyTaskContextAdoption(
						state,
						input,
						actual,
						(options.now?.() ?? new Date()).toISOString(),
					);
					await writeTaskContextState(file(workspaceId), state);
					return { context, duplicate: false };
				},
			),
		attachExpansion: async (workspaceId, planTaskId) => {
			const plan = (await index.read(workspaceId)).plans[executionTaskIdSchema.parse(planTaskId)];
			if (
				!plan?.approval?.bundleRevision ||
				!plan.expansion ||
				plan.expansion.bundleRevision !== plan.approval.bundleRevision ||
				plan.expansion.breakdownSha256 !== plan.approval.breakdownSha256
			)
				throw new KnowledgeError(
					"PRECONDITION_FAILED",
					"Task pins require the existing user's exact approved and reserved expansion, never a reference or publisher claim.",
				);
			const bundle = await bundles.read(workspaceId, plan.approval.bundleRevision);
			const expansion = plan.expansion;
			if (bundle.planTaskId !== planTaskId || bundle.breakdown.contentHash !== plan.approval.breakdownSha256)
				throw new KnowledgeError("PRECONDITION_FAILED", "Reserved expansion lost its approved bundle identity.");
			const ids = Object.values(plan.expansion.cards);
			if (new Set(ids).size !== ids.length)
				throw new KnowledgeError("CONFLICT", "Each planned task must have one reserved identity.");
			const parsed = parsePlanBreakdown(
				await bundles.readPart(workspaceId, bundle.breakdown.contentHash),
				bundle.slug,
			);
			if (
				!parsed.ok ||
				parsed.breakdown.cards.length !== ids.length ||
				parsed.breakdown.cards.some((card) => !plan.expansion?.cards[card.id])
			)
				throw new KnowledgeError(
					"PRECONDITION_FAILED",
					"Reserved task identities do not match the exact approved breakdown.",
				);
			const root = getProjectKnowledgePaths(workspaceId, options.homePath).root;
			await mkdir(root, { recursive: true, mode: 0o700 });
			await lockedFileSystem.withLock({ path: file(workspaceId) }, async () => {
				const state = await snapshot(workspaceId);
				let changed = false;
				for (const card of parsed.breakdown.cards) {
					const taskId = expansion.cards[card.id];
					if (!taskId) throw new KnowledgeError("PRECONDITION_FAILED", "Reserved task identity is missing.");
					const selected = new Set(
						[...(parsed.breakdown.knowledgeReferences ?? []), ...(card.knowledgeReferences ?? [])].map(
							(reference) => reference.id,
						),
					);
					const definition = {
						version: 1 as const,
						taskId: executionTaskIdSchema.parse(taskId),
						planTaskId,
						bundleRevision: bundle.revision,
						documents: bundle.documents.filter((document) => document.pinnedByUser || selected.has(document.id)),
					};
					const revision = hashKnowledgeContent(JSON.stringify(definition)),
						existing = state.tasks[taskId];
					if (existing) {
						if (existing[0]?.revision !== revision)
							throw new KnowledgeError(
								"CONFLICT",
								"A task already has another pinned context; adoption must be explicit, never silently rebased by expansion.",
							);
						await validateHistory(workspaceId, existing);
						continue;
					}
					state.tasks[taskId] = [
						taskKnowledgeContextSchema.parse({
							...definition,
							revision,
							attachedAt: (options.now?.() ?? new Date()).toISOString(),
						}),
					];
					changed = true;
				}
				if (!changed) return;
				await writeTaskContextState(file(workspaceId), state);
			});
		},
	};
}
