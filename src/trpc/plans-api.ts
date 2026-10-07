// The runtime side of a plan card's approval (docs/team/WORKFLOW.md §13): `plans.preview` shows what would be
// approved, `plans.approve` records the user's approval of exactly that breakdown. Approval is the user's in every
// isolation mode, off included: an agent session (orchestrator or card, any workspace, by credential or traced to its
// process tree) is refused, and "no credential and no session above it" is not proof of the user (a reparented
// process looks the same). So anyone else's approval waits for the one-time code the server prints on its console
// (src/isolation/approvals.ts, completed through `isolation.approve`), except a passcode-authenticated browser.
import { z } from "zod";

import type { ApprovalStore } from "../isolation/approvals";
import type { IsolationService } from "../isolation/isolation-service";
import { describeCaller, type RuntimeCaller } from "../isolation/session-identity";
import { createPlanIndexStore, type PlanIndexStore, planApprovalSchema } from "../plans/plan-index";
import {
	type FindPlanWorktree,
	type PlanApprovalPreview,
	previewPlanApproval,
	recordPlanApproval,
} from "../plans/plan-target";

export const planApprovalPreviewSchema = z.object({
	taskId: z.string(),
	title: z.string(),
	slug: z.string(),
	specPath: z.string(),
	specTitle: z.string().nullable(),
	cards: z.number().int().nonnegative(),
	breakdownSha256: z.string(),
	approval: planApprovalSchema.extend({ state: z.enum(["approved", "stale", "not approved"]) }).nullable(),
});

export const planPreviewRequestSchema = z.object({ taskId: z.string().min(1) });
export const planPreviewResponseSchema = z.object({
	ok: z.boolean(),
	plan: planApprovalPreviewSchema.nullable(),
	error: z.string().optional(),
});
export type PlanPreviewResponse = z.infer<typeof planPreviewResponseSchema>;

export const planApproveRequestSchema = z.object({
	taskId: z.string().min(1),
	/** `expand`: `kanban plan expand --approved-by-user`. */
	via: z.enum(["approve", "expand"]).default("approve"),
	/** The breakdown the user was shown; a different one is refused. */
	breakdownSha256: z.string().min(1).nullable().default(null),
});
export const planApproveResponseSchema = z.object({
	ok: z.boolean(),
	/** Recorded now (a passcode-authenticated browser); null while it waits for the console code. */
	approval: planApprovalSchema.nullable(),
	/** The pending approval to complete with the code from the server's console (`isolation.approve`). */
	approvalId: z.string().nullable(),
	plan: planApprovalPreviewSchema.nullable(),
	error: z.string().optional(),
});
export type PlanApproveResponse = z.infer<typeof planApproveResponseSchema>;

export interface RuntimePlansApi {
	preview: (repoPath: string, input: z.infer<typeof planPreviewRequestSchema>) => Promise<PlanPreviewResponse>;
	approve: (input: {
		caller: RuntimeCaller;
		/** A passcode-authenticated browser session (remote mode): the user, no console code needed. */
		trustedBrowser: boolean;
		workspaceId: string;
		repoPath: string;
		request: z.infer<typeof planApproveRequestSchema>;
	}) => Promise<PlanApproveResponse>;
}

export interface CreatePlansApiDependencies {
	approvals: ApprovalStore;
	log: IsolationService["log"];
	index?: PlanIndexStore;
	findWorktree?: FindPlanWorktree;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function planApprovalRefusal(taskId: string, caller: RuntimeCaller): string {
	return `Plan approval is the user's; ask them to run kanban plan approve ${taskId} or use the board (${describeCaller(caller)} can't approve a plan).`;
}

export function createPlansApi(deps: CreatePlansApiDependencies): RuntimePlansApi {
	const planDeps = { index: deps.index ?? createPlanIndexStore(), findWorktree: deps.findWorktree };
	const preview = async (repoPath: string, taskId: string) =>
		await previewPlanApproval({ repoPath, taskId }, planDeps);
	const record = async (input: Parameters<typeof recordPlanApproval>[0]) => await recordPlanApproval(input, planDeps);

	return {
		preview: async (repoPath, input) => {
			try {
				return { ok: true, plan: await preview(repoPath, input.taskId) };
			} catch (error) {
				return { ok: false, plan: null, error: toErrorMessage(error) };
			}
		},
		approve: async ({ caller, trustedBrowser, workspaceId, repoPath, request }) => {
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
					approvalId: null,
					plan: null,
					error: planApprovalRefusal(taskId, caller),
				};
			}
			let shown: PlanApprovalPreview;
			try {
				shown = await preview(repoPath, taskId);
			} catch (error) {
				return { ok: false, approval: null, approvalId: null, plan: null, error: toErrorMessage(error) };
			}
			const expectedSha256 = request.breakdownSha256 ?? shown.breakdownSha256;
			if (expectedSha256 !== shown.breakdownSha256) {
				return {
					ok: false,
					approval: null,
					approvalId: null,
					plan: shown,
					error: `The breakdown of plan ${taskId} changed since it was shown; review it again.`,
				};
			}
			const apply = async () => {
				const recorded = await record({ repoPath, taskId, via, expectedSha256 });
				await deps.log([workspaceId], {
					kind: "approval",
					taskId: null,
					from: null,
					to: workspaceId,
					action: "plans.approve",
					detail: `plan ${taskId} approved by the user${trustedBrowser ? " (passcode browser)" : " with the console code"}, breakdown ${recorded.approval.breakdownSha256}`,
				});
				return recorded;
			};
			if (trustedBrowser) {
				try {
					const recorded = await apply();
					return { ok: true, approval: recorded.approval, approvalId: null, plan: recorded.preview };
				} catch (error) {
					return { ok: false, approval: null, approvalId: null, plan: shown, error: toErrorMessage(error) };
				}
			}
			const pending = deps.approvals.request({
				kind: "plan.approve",
				summary: `plan ${taskId} "${shown.specTitle ?? shown.title}" in ${workspaceId}: ${shown.cards} cards, breakdown ${shown.breakdownSha256.slice(0, 12)}`,
				run: async () => {
					await apply();
					return `plan ${taskId} approved (${shown.cards} cards)`;
				},
			});
			return { ok: true, approval: null, approvalId: pending.id, plan: shown };
		},
	};
}
