// The runtime side of a plan card's approval (docs/team/WORKFLOW.md §13): `plans.preview` shows what would be
// approved, `plans.approve` records the user's approval of that exact spec/breakdown/knowledge bundle. Approval is the user's in every
// isolation mode, off included: an agent session (orchestrator or card, any workspace, by credential or traced to its
// process tree) and an unidentified caller are refused; a caller the strict lookup takes for the user (the board, or
// the CLI from the user's own shell) approves at once, with no console code (user request, 2026-10-09). The cost:
// "no credential and no session above it" is not proof of the user, since a reparented (detached) process looks the
// same, so such a process can approve a plan.
import type { IsolationService } from "../isolation/isolation-service";
import { describeCaller, type RuntimeCaller } from "../isolation/session-identity";
import { authorizeKnowledgeCaller } from "../knowledge/knowledge-api";
import type { PlanBundleStore } from "../knowledge/plan-bundle-store";
import { createPlanIndexStore, type PlanIndexStore } from "../plans/plan-index";
import {
	type FindPlanWorktree,
	type PlanApprovalPreview,
	previewPlanApproval,
	recordPlanApproval,
} from "../plans/plan-target";
import type { RuntimePlansApi } from "./plans-contract";

export {
	type PlanApproveResponse,
	type PlanPreviewResponse,
	planApprovalPreviewSchema,
	planApproveRequestSchema,
	planApproveResponseSchema,
	planPreviewRequestSchema,
	planPreviewResponseSchema,
	type RuntimePlansApi,
} from "./plans-contract";

export interface CreatePlansApiDependencies {
	log: IsolationService["log"];
	index?: PlanIndexStore;
	findWorktree?: FindPlanWorktree;
	bundles?: PlanBundleStore;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function planApprovalRefusal(taskId: string, caller: RuntimeCaller): string {
	return `Plan approval is the user's; ask them to run kanban plan approve ${taskId} or use the board (${describeCaller(caller)} can't approve a plan).`;
}

export function createPlansApi(deps: CreatePlansApiDependencies): RuntimePlansApi {
	const planDeps = {
		index: deps.index ?? createPlanIndexStore(),
		findWorktree: deps.findWorktree,
		bundles: deps.bundles,
	};
	const preview = async (repoPath: string, taskId: string) =>
		await previewPlanApproval({ repoPath, taskId }, planDeps);
	const record = async (input: Parameters<typeof recordPlanApproval>[0]) => await recordPlanApproval(input, planDeps);

	return {
		preview: async (repoPath, input, caller, workspaceId) => {
			try {
				authorizeKnowledgeCaller(caller, workspaceId);
				return { ok: true, plan: await preview(repoPath, input.taskId) };
			} catch (error) {
				return { ok: false, plan: null, error: toErrorMessage(error) };
			}
		},
		approve: async ({ caller, workspaceId, repoPath, request }) => {
			const { taskId, via } = request;
			if (caller.kind !== "user") {
				await deps.log([workspaceId, caller.kind === "session" ? caller.session.workspaceId : null], {
					kind: "refused",
					taskId: caller.kind === "session" ? caller.session.taskId : null,
					from: caller.kind === "session" ? caller.session.workspaceId : null,
					to: workspaceId,
					action: "plans.approve",
					detail: `plan ${taskId}: approval is the user's (${caller.kind === "session" ? `via ${caller.via}` : caller.reason})`,
				});
				return {
					ok: false,
					approval: null,
					plan: null,
					error: planApprovalRefusal(taskId, caller),
				};
			}
			let shown: PlanApprovalPreview;
			try {
				shown = await preview(repoPath, taskId);
			} catch (error) {
				return { ok: false, approval: null, plan: null, error: toErrorMessage(error) };
			}
			const expectedSha256 = request.breakdownSha256 ?? shown.breakdownSha256;
			if (!request.bundleRevision || request.bundleRevision !== shown.bundle.revision)
				return {
					ok: false,
					approval: null,
					plan: shown,
					error: "Review the full immutable spec/breakdown/knowledge bundle; its exact revision is required and may have changed since it was shown.",
				};
			if (expectedSha256 !== shown.breakdownSha256) {
				return {
					ok: false,
					approval: null,
					plan: shown,
					error: `The breakdown of plan ${taskId} changed since it was shown; review it again.`,
				};
			}
			try {
				const recorded = await record({
					repoPath,
					taskId,
					via,
					expectedSha256,
					expectedBundleRevision: request.bundleRevision,
				});
				await deps.log([workspaceId], {
					kind: "approval",
					taskId: null,
					from: null,
					to: workspaceId,
					action: "plans.approve",
					detail: `plan ${taskId} approved by the user, bundle ${recorded.approval.bundleRevision}, breakdown ${recorded.approval.breakdownSha256}`,
				});
				return { ok: true, approval: recorded.approval, plan: recorded.preview };
			} catch (error) {
				return { ok: false, approval: null, plan: shown, error: toErrorMessage(error) };
			}
		},
	};
}
