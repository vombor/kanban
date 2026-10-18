// A plan card on its board, with its plan index entry and the breakdown in its worktree: what `kanban plan` and the
// runtime's plan approval route (src/trpc/plans-api.ts) both read. The approval itself is the user's only: it is
// recorded here, but only the runtime route calls `recordPlanApproval`, once its strict caller lookup has taken the
// caller for the user (never an agent session).
import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeWorkspaceStateResponse } from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { readPlanSlugFromPrompt } from "../kits/plan-prompt";
import { createPlanBundleStore, type PlanBundleStore, type PreparedPlanBundle } from "../knowledge/plan-bundle-store";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceContext, mutateWorkspaceState } from "../state/workspace-state";
import type { PlanApprovalPreview } from "../trpc/plans-contract";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import { type PlanBreakdown, parsePlanBreakdown, readPlanFiles } from "./plan-breakdown";
import { hashPlanBreakdown } from "./plan-expand";
import type { PlanApproval, PlanIndexStore, PlanRecord } from "./plan-index";

export type { PlanApprovalPreview } from "../trpc/plans-contract";

export interface PlanTarget {
	repoPath: string;
	workspaceId: string;
	state: RuntimeWorkspaceStateResponse;
}

export interface LocatedPlan {
	card: RuntimeBoardCard;
	column: RuntimeBoardColumnId;
	record: PlanRecord | null;
	slug: string;
}

/** The plan card's worktree, or null when it has none. */
export type FindPlanWorktree = (repoPath: string, card: RuntimeBoardCard) => Promise<string | null>;

export const findPlanWorktree: FindPlanWorktree = async (repoPath, card) => {
	const info = await getTaskWorkspacePathInfo({ cwd: repoPath, taskId: card.id, baseRef: card.baseRef });
	return info.exists ? info.path : null;
};

export async function loadPlanTarget(cwd: string, projectPath?: string): Promise<PlanTarget> {
	const path = projectPath?.trim() ? resolveProjectInputPath(projectPath.trim(), cwd) : cwd;
	const context = await loadWorkspaceContext(path, { autoCreateIfMissing: false });
	// A read through the board lock: nothing is saved.
	const { state } = await mutateWorkspaceState(context.repoPath, (current) => ({
		board: current.board,
		value: null,
		save: false,
	}));
	return { repoPath: context.repoPath, workspaceId: context.workspaceId, state };
}

export function findBoardCard(
	state: RuntimeWorkspaceStateResponse,
	taskId: string,
): { card: RuntimeBoardCard; column: RuntimeBoardColumnId } | null {
	for (const column of state.board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return { card, column: column.id };
		}
	}
	return null;
}

export async function locatePlan(target: PlanTarget, index: PlanIndexStore, taskId: string): Promise<LocatedPlan> {
	const found = findBoardCard(target.state, taskId);
	if (!found) {
		throw new Error(`Task ${taskId} is not on the board of ${target.repoPath}.`);
	}
	const role = resolveCardRole(found.card);
	if (role !== "plan") {
		throw new Error(`Task ${taskId} is a ${role} card, not a plan card.`);
	}
	const record = (await index.read(target.workspaceId)).plans[taskId] ?? null;
	const slug = record?.slug ?? readPlanSlugFromPrompt(found.card.prompt);
	if (!slug) {
		throw new Error(
			`Plan card ${taskId} names no docs/specs/<slug>.cards.json in its prompt and has no plan index entry.`,
		);
	}
	return { ...found, record, slug };
}

export async function readPlanWorktreeFiles(target: PlanTarget, plan: LocatedPlan, findWorktree: FindPlanWorktree) {
	const worktreePath = await findWorktree(target.repoPath, plan.card);
	if (!worktreePath) {
		throw new Error(`Plan card ${plan.card.id} has no worktree (never started, or already Done).`);
	}
	return await readPlanFiles(worktreePath, plan.slug);
}

export interface ValidPlanBreakdown {
	breakdown: PlanBreakdown;
	sha: string;
	specPath: string;
	spec: string | null;
	breakdownText: string;
	breakdownPath: string;
}

/** Reads and validates the plan card's breakdown; throws with every issue when it doesn't validate. */
export async function readValidBreakdown(
	target: PlanTarget,
	plan: LocatedPlan,
	findWorktree: FindPlanWorktree,
): Promise<ValidPlanBreakdown> {
	const files = await readPlanWorktreeFiles(target, plan, findWorktree);
	if (files.breakdownText === null) {
		throw new Error(`Plan ${plan.card.id} has no ${files.paths.breakdownPath} in its worktree.`);
	}
	const parsed = parsePlanBreakdown(files.breakdownText, plan.slug);
	if (!parsed.ok) {
		throw new Error(`The breakdown ${files.paths.breakdownPath} is invalid: ${parsed.issues.join("; ")}`);
	}
	return {
		breakdown: parsed.breakdown,
		sha: hashPlanBreakdown(files.breakdownText),
		specPath: files.paths.specPath,
		spec: files.spec,
		breakdownText: files.breakdownText,
		breakdownPath: files.paths.breakdownPath,
	};
}

/** The spec's first `# ` heading, or null. */
export function readPlanSpecTitle(spec: string | null): string | null {
	const heading = spec?.split("\n").find((line) => /^#\s+\S/u.test(line));
	return heading ? heading.replace(/^#\s+/u, "").trim() : null;
}

export type PlanApprovalState = "approved" | "stale" | "not approved" | "legacy breakdown only";

export function describePlanApprovalState(
	approval: PlanApproval | null,
	breakdownSha256: string | null,
	bundleRevision?: string | null,
): PlanApprovalState {
	if (!approval) {
		return "not approved";
	}
	if (!approval.bundleRevision) return "legacy breakdown only";
	if (bundleRevision !== undefined) {
		if (approval.bundleRevision !== bundleRevision) return "stale";
	}
	return approval.breakdownSha256 === breakdownSha256 ? "approved" : "stale";
}

export interface PlanApprovalDependencies {
	index: PlanIndexStore;
	findWorktree?: FindPlanWorktree;
	now?: () => Date;
	bundles?: PlanBundleStore;
}

async function readApprovablePlan(
	input: { repoPath: string; taskId: string },
	deps: PlanApprovalDependencies,
): Promise<{ target: PlanTarget; plan: LocatedPlan; preview: PlanApprovalPreview; prepared: PreparedPlanBundle }> {
	const target = await loadPlanTarget(input.repoPath);
	const plan = await locatePlan(target, deps.index, input.taskId);
	if (plan.record?.expansion?.status === "done") {
		throw new Error(`Plan ${plan.card.id} was already expanded.`);
	}
	if (plan.column !== "review") {
		throw new Error(`Plan ${plan.card.id} is in ${plan.column}; approve it once its planner has finished (Review).`);
	}
	const valid = await readValidBreakdown(target, plan, deps.findWorktree ?? findPlanWorktree);
	const approval = plan.record?.approval ?? null;
	const prepared = await (deps.bundles ?? createPlanBundleStore()).prepare(target.workspaceId, {
		planTaskId: plan.card.id,
		slug: plan.slug,
		specPath: valid.specPath,
		breakdownPath: valid.breakdownPath,
		spec: valid.spec,
		breakdownText: valid.breakdownText,
		breakdown: valid.breakdown,
	});
	return {
		target,
		plan,
		prepared,
		preview: {
			taskId: plan.card.id,
			title: plan.card.title ?? "",
			slug: plan.slug,
			specPath: valid.specPath,
			specTitle: readPlanSpecTitle(valid.spec),
			cards: valid.breakdown.cards.length,
			breakdownSha256: valid.sha,
			bundle: prepared.bundle,
			approval: approval
				? { ...approval, state: describePlanApprovalState(approval, valid.sha, prepared.bundle.revision) }
				: null,
		},
	};
}

/** What the user is asked to approve; throws when the plan can't be approved now (not in Review, invalid, expanded). */
export async function previewPlanApproval(
	input: { repoPath: string; taskId: string },
	deps: PlanApprovalDependencies,
): Promise<PlanApprovalPreview> {
	return (await readApprovablePlan(input, deps)).preview;
}

/**
 * Records the user's exact reviewed bundle only after its immutable content is durable. A stale preview never
 * approves new spec/breakdown/knowledge content, and historical breakdown-only approval remains provenance.
 */
export async function recordPlanApproval(
	input: {
		repoPath: string;
		taskId: string;
		via: PlanApproval["via"];
		expectedSha256?: string | null;
		expectedBundleRevision: string;
	},
	deps: PlanApprovalDependencies,
): Promise<{ approval: PlanApproval; preview: PlanApprovalPreview }> {
	const now = (deps.now ?? (() => new Date()))();
	const { target, plan, preview, prepared } = await readApprovablePlan(input, deps);
	if (input.expectedSha256 && input.expectedSha256 !== preview.breakdownSha256) {
		throw new Error(
			`The breakdown of plan ${plan.card.id} changed while the approval waited; approve the new breakdown (kanban plan approve ${plan.card.id}).`,
		);
	}
	if (input.expectedBundleRevision !== preview.bundle.revision)
		throw new Error(
			"The reviewed plan bundle changed (spec, breakdown or knowledge revisions); review and approve its exact new revision.",
		);
	await (deps.bundles ?? createPlanBundleStore()).persist(target.workspaceId, prepared);
	let approval: PlanApproval = {
		at: now.toISOString(),
		via: input.via,
		breakdownSha256: preview.breakdownSha256,
		bundleRevision: preview.bundle.revision,
	};
	await deps.index.update(target.workspaceId, (current) => {
		const existing = current.plans[plan.card.id];
		if (existing?.expansion?.status === "done")
			throw new Error("Plan was already expanded while approval was being recorded.");
		if (existing?.expansion && existing.approval?.bundleRevision !== approval.bundleRevision)
			throw new Error(
				"Plan expansion already reserved another approval; preserve its tasks and explicitly resolve that expansion before changing the approved bundle.",
			);
		if (existing?.approval && existing.approval.bundleRevision === approval.bundleRevision)
			approval = existing.approval;
		const record: PlanRecord = existing ?? {
			// A plan card made by hand (no `task create --role plan`) gets its entry on first approval.
			taskId: plan.card.id,
			slug: plan.slug,
			title: plan.card.title ?? "",
			createdAt: new Date(plan.card.createdAt || now.getTime()).toISOString(),
			kit: "unknown",
			agentId: plan.card.agentId ?? null,
			providerId: plan.card.agentSettings?.providerId ?? null,
			modelId: plan.card.agentSettings?.modelId ?? null,
			startInPlanMode: plan.card.startInPlanMode,
			approval: null,
			expansion: null,
			metrics: null,
		};
		const history = [...(record.approvalHistory ?? [])];
		if (record.approval && record.approval.bundleRevision !== approval.bundleRevision) history.push(record.approval);
		return {
			...current,
			plans: { ...current.plans, [plan.card.id]: { ...record, approval, approvalHistory: history } },
		};
	});
	return { approval, preview: { ...preview, approval: { ...approval, state: "approved" } } };
}
