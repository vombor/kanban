// A plan card on its board, with its plan index entry and the breakdown in its worktree: what `kanban plan` and the
// runtime's plan approval route (src/trpc/plans-api.ts) both read. The approval itself is the user's only: it is
// recorded here, but only the runtime route calls `recordPlanApproval`, once its strict caller lookup has taken the
// caller for the user (never an agent session).
import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeWorkspaceStateResponse } from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { readPlanSlugFromPrompt } from "../kits/plan-prompt";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceContext, mutateWorkspaceState } from "../state/workspace-state";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import { type PlanBreakdown, parsePlanBreakdown, readPlanFiles } from "./plan-breakdown";
import { hashPlanBreakdown } from "./plan-expand";
import type { PlanApproval, PlanIndexStore, PlanRecord } from "./plan-index";

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
	};
}

/** The spec's first `# ` heading, or null. */
export function readPlanSpecTitle(spec: string | null): string | null {
	const heading = spec?.split("\n").find((line) => /^#\s+\S/u.test(line));
	return heading ? heading.replace(/^#\s+/u, "").trim() : null;
}

export type PlanApprovalState = "approved" | "stale" | "not approved";

export function describePlanApprovalState(
	approval: PlanApproval | null,
	breakdownSha256: string | null,
): PlanApprovalState {
	if (!approval) {
		return "not approved";
	}
	return approval.breakdownSha256 === breakdownSha256 ? "approved" : "stale";
}

export interface PlanApprovalPreview {
	taskId: string;
	title: string;
	slug: string;
	specPath: string;
	/** The spec's first heading (null when the spec has none or is missing). */
	specTitle: string | null;
	cards: number;
	breakdownSha256: string;
	approval: (PlanApproval & { state: PlanApprovalState }) | null;
}

export interface PlanApprovalDependencies {
	index: PlanIndexStore;
	findWorktree?: FindPlanWorktree;
	now?: () => Date;
}

async function readApprovablePlan(
	input: { repoPath: string; taskId: string },
	deps: PlanApprovalDependencies,
): Promise<{ target: PlanTarget; plan: LocatedPlan; preview: PlanApprovalPreview }> {
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
	return {
		target,
		plan,
		preview: {
			taskId: plan.card.id,
			title: plan.card.title ?? "",
			slug: plan.slug,
			specPath: valid.specPath,
			specTitle: readPlanSpecTitle(valid.spec),
			cards: valid.breakdown.cards.length,
			breakdownSha256: valid.sha,
			approval: approval ? { ...approval, state: describePlanApprovalState(approval, valid.sha) } : null,
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
 * Records the user's approval, pinned to the breakdown's hash. `expectedSha256` is the breakdown the user was shown:
 * a breakdown changed while the approval waited for the code is refused, so it gets an approval of its own.
 */
export async function recordPlanApproval(
	input: { repoPath: string; taskId: string; via: PlanApproval["via"]; expectedSha256?: string | null },
	deps: PlanApprovalDependencies,
): Promise<{ approval: PlanApproval; preview: PlanApprovalPreview }> {
	const now = (deps.now ?? (() => new Date()))();
	const { target, plan, preview } = await readApprovablePlan(input, deps);
	if (input.expectedSha256 && input.expectedSha256 !== preview.breakdownSha256) {
		throw new Error(
			`The breakdown of plan ${plan.card.id} changed while the approval waited; approve the new breakdown (kanban plan approve ${plan.card.id}).`,
		);
	}
	const approval: PlanApproval = { at: now.toISOString(), via: input.via, breakdownSha256: preview.breakdownSha256 };
	await deps.index.update(target.workspaceId, (current) => {
		const existing = current.plans[plan.card.id];
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
		return { ...current, plans: { ...current.plans, [plan.card.id]: { ...record, approval } } };
	});
	return { approval, preview: { ...preview, approval: { ...approval, state: "approved" } } };
}
