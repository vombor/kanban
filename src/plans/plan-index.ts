// The plan index: `data/<workspaceId>/plans.json` in the Kanban home. One entry per plan card, written by
// `kanban task create --role plan` (slug, routing), `kanban plan approve` (the user's approval, pinned to the
// breakdown's hash) and `kanban plan expand` (local id → task id, the links, the plan card's metrics). The team kit's
// scoring reads plans from here later (plan-metrics.ts); nothing in the pipeline decides on it.
//
// The expansion is written before any card is created, with the task ids chosen up front, so an expand that stops
// half way (a crash, a refused board save) resumes with the same ids instead of creating every card twice.
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { runtimeAgentIdSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getPlanIndexPath } from "../state/kanban-home";
import { planSlugSchema } from "./plan-breakdown";

export const PLAN_INDEX_VERSION = 1;

export const planApprovalSchema = z
	.object({
		at: z.string(),
		/** `approve`: `kanban plan approve` (or the UI); `expand`: `kanban plan expand --approved-by-user`. */
		via: z.enum(["approve", "expand"]),
		/** sha256 of the breakdown file the user approved; a changed breakdown needs a new approval. */
		breakdownSha256: z.string(),
	})
	.strict();
export type PlanApproval = z.infer<typeof planApprovalSchema>;

export const planExpansionSchema = z
	.object({
		status: z.enum(["creating", "done"]),
		startedAt: z.string(),
		finishedAt: z.string().nullable(),
		breakdownSha256: z.string(),
		/** Local id → task id, chosen before the first card is created. */
		cards: z.record(z.string(), z.string()),
		/** Board links by local id: `waiting` starts once `prerequisite` is Done. */
		links: z.array(z.object({ waiting: z.string(), prerequisite: z.string() }).strict()),
	})
	.strict();
export type PlanExpansion = z.infer<typeof planExpansionSchema>;

/** The plan card's own metrics, measured at expand (card metrics; a cost is null where the agent leaves none). */
export const planCardMetricsSchema = z
	.object({
		measuredAt: z.string(),
		agent: z.string().nullable(),
		provider: z.string().nullable(),
		model: z.string().nullable(),
		wallMin: z.number().nullable(),
		activeMin: z.number().nullable(),
		costUSD: z.number().nullable(),
	})
	.strict();
export type PlanCardMetrics = z.infer<typeof planCardMetricsSchema>;

export const planRecordSchema = z
	.object({
		taskId: z.string(),
		slug: planSlugSchema,
		title: z.string(),
		createdAt: z.string(),
		/** The kit and routing the plan card was created with. */
		kit: z.string(),
		agentId: runtimeAgentIdSchema.nullable(),
		providerId: z.string().nullable(),
		modelId: z.string().nullable(),
		startInPlanMode: z.boolean(),
		approval: planApprovalSchema.nullable(),
		expansion: planExpansionSchema.nullable(),
		metrics: planCardMetricsSchema.nullable(),
	})
	.strict();
export type PlanRecord = z.infer<typeof planRecordSchema>;

export const planIndexSchema = z
	.object({
		version: z.literal(PLAN_INDEX_VERSION),
		plans: z.record(z.string(), planRecordSchema),
	})
	.strict();
export type PlanIndex = z.infer<typeof planIndexSchema>;

export interface PlanIndexStore {
	read: (workspaceId: string) => Promise<PlanIndex>;
	/** Read-modify-write under the index file's lock. */
	update: (workspaceId: string, mutate: (index: PlanIndex) => PlanIndex) => Promise<PlanIndex>;
}

function emptyIndex(): PlanIndex {
	return { version: PLAN_INDEX_VERSION, plans: {} };
}

export function createPlanIndexStore(options: { getPath?: (workspaceId: string) => string } = {}): PlanIndexStore {
	const getPath = options.getPath ?? ((workspaceId: string) => getPlanIndexPath(workspaceId));

	const read = async (workspaceId: string): Promise<PlanIndex> => {
		const path = getPath(workspaceId);
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				return emptyIndex();
			}
			throw error;
		}
		const parsed = planIndexSchema.safeParse(JSON.parse(text));
		if (!parsed.success) {
			// Never overwrite a file we can't read: a newer version or a hand edit would be lost.
			throw new Error(`${path} is not a version ${PLAN_INDEX_VERSION} plan index: ${parsed.error.message}`);
		}
		return parsed.data;
	};

	const update: PlanIndexStore["update"] = async (workspaceId, mutate) => {
		const path = getPath(workspaceId);
		return await lockedFileSystem.withLock({ path, type: "file" }, async () => {
			const next = planIndexSchema.parse(mutate(structuredClone(await read(workspaceId))));
			await lockedFileSystem.writeJsonFileAtomic(path, next, { lock: null });
			return next;
		});
	};

	return { read, update };
}

/** `slug`, or `slug-2`, `slug-3`, … when another plan of the workspace already uses it. */
export function chooseUniquePlanSlug(index: PlanIndex, slug: string): string {
	const used = new Set(Object.values(index.plans).map((plan) => plan.slug));
	if (!used.has(slug)) {
		return slug;
	}
	for (let suffix = 2; ; suffix += 1) {
		const candidate = `${slug.slice(0, 60)}-${suffix}`;
		if (!used.has(candidate)) {
			return candidate;
		}
	}
}
