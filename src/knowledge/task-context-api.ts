import { TRPCError } from "@trpc/server";
import type { RuntimeTaskKnowledgeApi } from "../trpc/knowledge-execution-contract";
import { authorizeKnowledgeCaller } from "./knowledge-api";
import { KnowledgeError } from "./knowledge-error";
import { currentKnowledgeRevision } from "./knowledge-revisions";
import { createProjectKnowledgeStore, type ProjectKnowledgeStore } from "./knowledge-store";
import { describeKnowledgeMarkdown, sliceKnowledgeText } from "./markdown";
import { createPlanBundleStore, type PlanBundleStore } from "./plan-bundle-store";
import { createTaskContextStore, type TaskContextStore } from "./task-context-store";

/** Always own-project, including isolation off and grants; no arbitrary object hash or mutable-worktree fallback. */
export function createTaskContextApi(
	options: {
		contexts?: TaskContextStore;
		bundles?: PlanBundleStore;
		knowledge?: ProjectKnowledgeStore;
		admissionAvailable?: boolean;
		canAdopt?: (workspaceId: string, taskId: string) => Promise<boolean>;
		canAttachDerived?: (workspaceId: string, taskId: string) => Promise<boolean>;
		validateAnchor?: (workspaceId: string, taskId: string) => Promise<void>;
	} = {},
): RuntimeTaskKnowledgeApi {
	const contexts = options.contexts ?? createTaskContextStore();
	const bundles = options.bundles ?? createPlanBundleStore();
	const knowledge = options.knowledge ?? createProjectKnowledgeStore();
	const run = async <T>(operation: () => Promise<T>): Promise<T> => {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof KnowledgeError) throw new TRPCError({ code: error.code, message: error.message });
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Pinned task context is unreadable; restore the retained data before retrying.",
			});
		}
	};
	return {
		attachDerived: async (caller, workspaceId, input) => {
			const actor = authorizeKnowledgeCaller(caller, workspaceId);
			if (actor.kind !== "user" && actor.role !== "orchestrator")
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Derived reference attachment belongs to the user or this project's orchestrator.",
				});
			return run(async () => {
				await options.validateAnchor?.(workspaceId, input.sourceTaskId);
				const existing = await contexts.read(workspaceId, input.taskId);
				if (!existing && !(await options.canAttachDerived?.(workspaceId, input.taskId)))
					throw new KnowledgeError(
						"PRECONDITION_FAILED",
						"New derived references require a fresh reserved target id, never an existing or historical task.",
					);
				return {
					context: await contexts.attachDerived(
						workspaceId,
						input.taskId,
						{
							sourceTaskId: input.sourceTaskId,
							kind: input.kind,
							...(input.snapshot ? { snapshot: input.snapshot } : {}),
						},
						() => options.canAttachDerived?.(workspaceId, input.taskId) ?? Promise.resolve(false),
					),
				};
			});
		},
		attempts: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			return run(async () => {
				await options.validateAnchor?.(workspaceId, input.taskId);
				const attempts = [...(await contexts.attempts(workspaceId, input.taskId))].reverse();
				return {
					attempts: attempts.slice(input.offset, input.offset + input.limit),
					authority: "reference_provenance_not_execution_approval" as const,
					total: attempts.length,
					nextOffset: input.offset + input.limit < attempts.length ? input.offset + input.limit : null,
				};
			});
		},
		adopt: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			if (caller.kind !== "user")
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Reference revision adoption is the user's choice; agents can report drift but cannot adopt.",
				});
			if (!options.admissionAvailable || !options.canAdopt)
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Physical-start serialization is unavailable; no reference revision was adopted.",
				});
			return run(async () => ({
				...(await contexts.adopt(
					workspaceId,
					input,
					() => options.canAdopt?.(workspaceId, input.taskId) ?? Promise.resolve(false),
				)),
				authority: "pinned_reference_not_execution_approval" as const,
			}));
		},
		get: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			return run(async () => {
				await options.validateAnchor?.(workspaceId, input.taskId);
				const { context, history, startReservation } = await contexts.inspect(workspaceId, input.taskId);
				if (!context)
					return {
						context: null,
						bundle: null,
						drift: [],
						history: [],
						startReservation: null,
						canAdopt: false,
						authority: "pinned_reference_not_execution_approval" as const,
					};
				const bundle = await bundles.read(workspaceId, context.bundleRevision);
				const manifest = await knowledge.snapshot(workspaceId);
				const drift = context.documents.flatMap((document) => {
					const current = currentKnowledgeRevision(manifest, document.id)?.revision ?? null;
					return current === document.revision ? [] : [{ id: document.id, pinned: document.revision, current }];
				});
				const canAdopt = Boolean(
					caller.kind === "user" &&
						options.admissionAvailable &&
						!startReservation &&
						(await options.canAdopt?.(workspaceId, input.taskId).catch(() => false)),
				);
				return {
					context,
					bundle,
					drift,
					history: history.map((item) => ({
						revision: item.revision,
						attachedAt: item.attachedAt,
						adoption: item.adoption ?? null,
					})),
					startReservation,
					canAdopt,
					authority: "pinned_reference_not_execution_approval" as const,
				};
			});
		},
		read: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			return run(async () => {
				await options.validateAnchor?.(workspaceId, input.taskId);
				const attempt = input.attemptId
					? (await contexts.attempts(workspaceId, input.taskId)).find((item) => item.id === input.attemptId)
					: null;
				if (input.attemptId && !attempt)
					throw new KnowledgeError("NOT_FOUND", "That retained attempt does not belong to this project's task.");
				if (attempt && input.contextRevision && attempt.contextRevision !== input.contextRevision)
					throw new KnowledgeError("CONFLICT", "Attempt and requested context identify different revisions.");
				const context = await contexts.read(
					workspaceId,
					input.taskId,
					attempt?.contextRevision ?? input.contextRevision,
				);
				if (!context) throw new KnowledgeError("NOT_FOUND", "This task has no approved-plan knowledge handoff.");
				const bundle = await bundles.read(workspaceId, context.bundleRevision);
				const document = input.part === "document" ? context.documents.find((item) => item.id === input.id) : null;
				if (input.part === "document" && !document)
					throw new KnowledgeError(
						"NOT_FOUND",
						"That document is not pinned to this task; use ordinary project discovery separately.",
					);
				const contentHash =
					document?.contentHash ??
					(input.part === "spec" ? bundle.spec.contentHash : bundle.breakdown.contentHash);
				const markdown = await bundles.readPart(workspaceId, contentHash);
				const sections = input.part === "breakdown" ? [] : describeKnowledgeMarkdown(markdown).sections;
				const section = input.section ? sections.find((item) => item.id === input.section) : null;
				if (input.section && !section)
					throw new KnowledgeError("NOT_FOUND", "That section is not in this pinned revision.");
				return {
					contextRevision: context.revision,
					contentHash,
					sections,
					...sliceKnowledgeText(
						section ? markdown.slice(section.start, section.end) : markdown,
						input.offset,
						input.limit,
					),
					authority: "pinned_reference_not_execution_approval" as const,
				};
			});
		},
		attachExpansion: async (caller, workspaceId, input) => {
			const actor = authorizeKnowledgeCaller(caller, workspaceId);
			if (actor.kind === "session" && actor.role !== "orchestrator")
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Plan handoff attachment belongs to the user or this project's orchestrator.",
				});
			return run(async () => {
				await contexts.attachExpansion(workspaceId, input.planTaskId);
				return { ok: true as const };
			});
		},
	};
}
