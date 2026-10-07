// The submission stage: what the pipeline does with a Review card before the QA gate asks the kit about it.
//
// For a dev card (its role from resolveCardRole(), so a legacy QA or calibration card is not one) whose session
// isn't running: take a snapshot of its worktree (snapshots.ts), decide from the snapshot whether there is work to
// submit (a snapshot equal to its base is not), and queue the scripted checks for a snapshot that hasn't been
// checked yet (checks.ts). A shadow workspace builds the snapshot commit without moving the ref and runs no checks.
//
// A card is snapshotted once per submission, not on every evaluation: the result is kept until the card's
// `updatedAt` or its session state changes (a card coming back to Review after a rework), or the worker restarts.
// A restarted worker re-snapshots the Review cards, as the legacy kit's startup sweep did (their worktree may
// have changed while it was down). Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597
// (onDevReview, the startup sweep: a running session is not finished work, and is not snapshotted mid-work).
import type { WorkspacePipelineSettings } from "../config/pipeline-config";
import type { RuntimeBoardCard } from "../core/api-contract";
import type { EffectiveCard } from "../kits/policy";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import { CHECKS_VERSION, type ChecksQueue, resolveChecksEnabled } from "./checks";
import type { PipelineDecisionOutcome } from "./decision-log";
import type { PipelineSessionView } from "./engine";
import type { PipelineWorkspaceState } from "./pipeline-state";
import { type TakeTaskSnapshotInput, type TaskSnapshot, takeTaskSnapshot } from "./snapshots";
import { probeTaskHasWork } from "./work-probe";

/** A stage action for the decision log; the engine adds the card's common fields. */
export interface PipelineStageRecord {
	stage: "snapshot" | "checks";
	outcome: PipelineDecisionOutcome;
	note: string;
}

export interface SubmissionInspection {
	/** Whether the card has work to submit; the QA gate asks the kit only about cards that do. */
	hasWork: boolean;
	records: PipelineStageRecord[];
}

export interface SubmissionContext {
	workspaceId: string;
	workspacePath: string;
	settings: WorkspacePipelineSettings;
	kitName: string;
	state: PipelineWorkspaceState;
}

export interface SubmissionCardInput {
	card: RuntimeBoardCard;
	effective: EffectiveCard;
	session: PipelineSessionView | null;
}

export type SubmissionInspector = (
	context: SubmissionContext,
	input: SubmissionCardInput,
) => Promise<SubmissionInspection>;

export interface SubmissionStage {
	inspect: SubmissionInspector;
	forgetWorkspace: (workspaceId: string) => void;
}

export interface CreateSubmissionStageOptions {
	checks: ChecksQueue;
	resolveWorktree?: (workspacePath: string, card: RuntimeBoardCard) => Promise<string | null>;
	takeSnapshot?: (input: TakeTaskSnapshotInput) => Promise<TaskSnapshot>;
	/** Work probe for cards that aren't snapshotted (non-dev roles). */
	probeHasWork?: (workspacePath: string, card: RuntimeBoardCard) => Promise<boolean>;
	log?: (message: string) => void;
}

async function resolveTaskWorktree(workspacePath: string, card: RuntimeBoardCard): Promise<string | null> {
	try {
		const info = await getTaskWorkspacePathInfo({ cwd: workspacePath, taskId: card.id, baseRef: card.baseRef });
		return info.exists ? info.path : null;
	} catch {
		return null;
	}
}

function short(sha: string | null): string {
	return sha ? sha.slice(0, 8) : "none";
}

/** Was this snapshot already checked by the current checker, without a harness failure? */
export function isSnapshotChecked(state: PipelineWorkspaceState, taskId: string, snapshot: string): boolean {
	const entry = state.cards[taskId];
	return entry?.snapshot === snapshot && entry.version === CHECKS_VERSION && entry.harness !== true;
}

export function createSubmissionStage(options: CreateSubmissionStageOptions): SubmissionStage {
	const resolveWorktree = options.resolveWorktree ?? resolveTaskWorktree;
	const takeSnapshot = options.takeSnapshot ?? takeTaskSnapshot;
	const probeHasWork = options.probeHasWork ?? probeTaskHasWork;
	// "<workspaceId>:<taskId>" → the inspection of the card's current submission.
	const inspections = new Map<string, { key: string; inspection: SubmissionInspection }>();

	const inspectDevCard = async (
		context: SubmissionContext,
		input: SubmissionCardInput,
	): Promise<{ inspection: SubmissionInspection; cache: boolean }> => {
		const { card } = input;
		const shadow = context.settings.pipeline.shadow;
		const worktree = await resolveWorktree(context.workspacePath, card);
		if (!worktree) {
			return { inspection: { hasWork: false, records: [] }, cache: false };
		}
		let snapshot: TaskSnapshot;
		try {
			snapshot = await takeSnapshot({
				worktreePath: worktree,
				taskId: card.id,
				baseRef: card.baseRef,
				reason: "review",
				dryRun: shadow,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Not kept: the next evaluation tries again.
			return {
				inspection: {
					hasWork: false,
					records: [{ stage: "snapshot", outcome: "none", note: `snapshot failed: ${message}` }],
				},
				cache: false,
			};
		}
		const where = `${short(snapshot.commit)} on ${short(snapshot.parent)}`;
		const snapshotNote = !snapshot.changed
			? `snapshot ${where} unchanged`
			: shadow
				? `would snapshot ${where} (ref left at ${short(snapshot.previous)})`
				: `snapshot ${where}${snapshot.previous ? ` (was ${short(snapshot.previous)})` : ""}`;
		if (!snapshot.hasChanges) {
			return {
				inspection: {
					hasWork: false,
					records: [
						{
							stage: "snapshot",
							outcome: "none",
							note: `${snapshotNote}: no changes against ${card.baseRef}; not submitted (the agent likely never ran)`,
						},
					],
				},
				cache: true,
			};
		}
		const records: PipelineStageRecord[] = [
			{ stage: "snapshot", outcome: !snapshot.changed ? "none" : shadow ? "shadow" : "acted", note: snapshotNote },
		];
		if (resolveChecksEnabled(context.settings, context.kitName)) {
			if (isSnapshotChecked(context.state, card.id, snapshot.commit)) {
				records.push({
					stage: "checks",
					outcome: "none",
					note: `checks: ${short(snapshot.commit)} already checked`,
				});
			} else if (shadow) {
				records.push({ stage: "checks", outcome: "shadow", note: `would run checks on ${short(snapshot.commit)}` });
			} else {
				const status = options.checks.enqueue({
					workspaceId: context.workspaceId,
					repoPath: context.workspacePath,
					taskId: card.id,
					title: card.title,
					baseRef: card.baseRef,
					snapshot: snapshot.commit,
					scripts: context.settings.checks.scripts,
				});
				records.push({ stage: "checks", outcome: "acted", note: `checks ${status} on ${short(snapshot.commit)}` });
			}
		}
		return { inspection: { hasWork: true, records }, cache: true };
	};

	return {
		inspect: async (context, input) => {
			const { card, effective, session } = input;
			if (effective.role !== "dev") {
				// QA, TRIAGE and calibration cards are never snapshotted or checked; the gate still records them.
				return { hasWork: await probeHasWork(context.workspacePath, card), records: [] };
			}
			if (session?.state === "running") {
				// Not finished work: session sync moves it back to In Progress, and it is inspected when it returns.
				return { hasWork: false, records: [] };
			}
			const cacheKey = `${context.workspaceId}:${card.id}`;
			const key = JSON.stringify([card.updatedAt, session?.state ?? null, context.settings.pipeline.shadow]);
			const cached = inspections.get(cacheKey);
			if (cached?.key === key) {
				return cached.inspection;
			}
			const { inspection, cache } = await inspectDevCard(context, input);
			if (cache) {
				inspections.set(cacheKey, { key, inspection });
			} else {
				inspections.delete(cacheKey);
			}
			return inspection;
		},
		forgetWorkspace: (workspaceId) => {
			for (const key of [...inspections.keys()]) {
				if (key.startsWith(`${workspaceId}:`)) {
					inspections.delete(key);
				}
			}
		},
	};
}
