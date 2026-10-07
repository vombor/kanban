// The `qa` landing step: the Done workflow's done gate (src/server/task-trash-workflow.ts). On a workspace with
// landing mode `qa`, Kanban squash-lands a dev card's work onto its base (src/workspace/land.ts) before the card
// goes to Done, so a conflict keeps the card where it is (plan §4.2, decision 2: land first, then Done).
//
// A plan card's spec files land the same way (src/core/card-role.ts), only ever on a human's land: the pipeline never
// QAs a plan card, so no PASS lands one.
//
// Every other workspace (landing `off`, `commit`, `pr`, or no config entry) and every card that is not a pipeline
// dev or plan card (QA/TRIAGE/calibration roles, legacy kit QA cards by their markers, `commit`/`pr` auto-review cards)
// passes straight through, exactly as before this gate existed.
//
// Two legacy kit accidents shaped the choice rule (archive/devteam-kit:services/kanban-autoland.mjs@6da71597,
// onReviewToDone): only a Review → Done move landed, so a card dragged to Done from another column with work in its
// worktree was never landed; and every Review → Done move landed, so the only way to drop a card's work was to
// delete the card. Here the column doesn't matter, and Done on a card whose worktree has work that is not on its
// base needs an explicit choice: `land` (Approve & land, `kanban task approve`, the PASS path) or `discard`
// (the work is not landed; the worktree patch is still saved as on every Done). Without one the move is refused
// with `landing.decision: "required"`, and the board asks "land or discard?".
//
// Shadow (`workspaces.<id>.pipeline.shadow`) decides and logs only: nothing lands and nothing is refused, so the
// legacy kit (which lands after Done) keeps working during the shadow day.
import { getWorkspacePipelineSettings, type ParsedPipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeBoardCard, RuntimeTaskLandingOutcome, RuntimeTaskTrashTrigger } from "../core/api-contract";
import { isKanbanLandedCard, resolveCardRole } from "../core/card-role";
import { type KitCatalog, loadKitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import {
	createPipelineDecisionLog,
	type PipelineDecisionLog,
	type PipelineDecisionOutcome,
	type PipelineDecisionRecord,
} from "../pipeline/decision-log";
import type { PipelineEventMap } from "../pipeline/events";
import { type PipelineHold, readPipelineHold } from "../pipeline/hold";
import { createPipelineStateStore } from "../pipeline/pipeline-state";
import { takeTaskSnapshot } from "../pipeline/snapshots";
import {
	buildLandCommitMessage,
	checkLand,
	type LandCheck,
	type LandResult,
	landCommit,
	type PostLandStep,
} from "../workspace/land";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import type { TaskDoneGate, TaskDoneGateDecision, TaskDoneGateInput } from "./task-trash-workflow";

export interface TaskLandingGateDependencies {
	readConfig?: () => Promise<ParsedPipelineConfig>;
	loadCatalog?: () => Promise<KitCatalog>;
	readHold?: (workspaceId: string, taskId: string) => Promise<PipelineHold | null>;
	/** The card's worktree path when it exists. */
	findWorktree?: (workspacePath: string, card: RuntimeBoardCard) => Promise<string | null>;
	/** postLand `stopUnder`: stops the processes under these directories (the process reaper). */
	stopProcessesUnder?: (directories: string[]) => Promise<void>;
	decisionLog?: PipelineDecisionLog;
	/** Kanban landed a card: the pipeline worker emits `landed` for kit features. */
	onLanded?: (event: PipelineEventMap["landed"]) => void;
	now?: () => number;
	log?: (message: string) => void;
}

/** Human requests (Approve & land, a board or CLI Done with "land") vs the pipeline's own after a QA PASS. */
function landedVia(trigger: RuntimeTaskTrashTrigger): PipelineEventMap["landed"]["via"] {
	return trigger === "pipeline" || trigger === "hold_release" ? "qa" : "approved";
}

async function defaultFindWorktree(workspacePath: string, card: RuntimeBoardCard): Promise<string | null> {
	const info = await getTaskWorkspacePathInfo({ cwd: workspacePath, taskId: card.id, baseRef: card.baseRef });
	return info.exists ? info.path : null;
}

function requiredReason(card: RuntimeBoardCard): string {
	return `Task ${card.id} has work that is not on ${card.baseRef}. Land or discard it: Approve & land (kanban task approve --task-id ${card.id}), or Done with "discard" (kanban task done --task-id ${card.id} --discard).`;
}

export function createTaskLandingGate(deps: TaskLandingGateDependencies = {}): TaskDoneGate {
	const readConfig = deps.readConfig ?? (async () => await readPipelineConfig());
	const loadCatalog = deps.loadCatalog ?? (async () => await loadKitCatalog());
	const stateStore = deps.readHold ? null : createPipelineStateStore({ log: deps.log });
	const readHold =
		deps.readHold ??
		(async (workspaceId: string, taskId: string) =>
			readPipelineHold((await stateStore?.peek(workspaceId))?.cards[taskId]));
	const findWorktree = deps.findWorktree ?? defaultFindWorktree;
	const decisionLog = deps.decisionLog ?? createPipelineDecisionLog();
	const now = deps.now ?? Date.now;
	const log = deps.log ?? (() => {});
	// One land at a time per repository: two squash merges in the same checkout (or two stashes) would collide.
	const repoChains = new Map<string, Promise<unknown>>();

	const serialized = async <T>(repoPath: string, run: () => Promise<T>): Promise<T> => {
		const previous = repoChains.get(repoPath) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(run);
		const settled = next.catch(() => {});
		repoChains.set(repoPath, settled);
		try {
			return await next;
		} finally {
			if (repoChains.get(repoPath) === settled) {
				repoChains.delete(repoPath);
			}
		}
	};

	const record = async (
		input: TaskDoneGateInput,
		context: { kit: string; shadow: boolean },
		outcome: PipelineDecisionOutcome,
		landing: RuntimeTaskLandingOutcome,
		note: string,
	): Promise<void> => {
		const entry: PipelineDecisionRecord = {
			at: new Date(now()).toISOString(),
			workspaceId: input.workspaceId,
			taskId: input.card.id,
			stage: "land",
			kit: context.kit,
			landingMode: "qa",
			shadow: context.shadow,
			effectiveAgent: null,
			model: null,
			role: resolveCardRole(input.card),
			answer: { trigger: input.trigger, landing: input.landing ?? null, ...landing },
			outcome,
			note,
		};
		await decisionLog.append([entry]).catch((error: unknown) => {
			log(`land ${input.card.id}: could not write the decision log: ${String(error)}`);
		});
	};

	const decide = async (input: TaskDoneGateInput, progress: { gated: boolean }): Promise<TaskDoneGateDecision> => {
		const parsed = await readConfig();
		const settings = getWorkspacePipelineSettings(parsed.config, input.workspaceId);
		const { card } = input;
		if (!isKanbanLandedCard(card, settings.landing.mode)) {
			return { proceed: true };
		}
		const shadow = settings.pipeline.shadow;
		progress.gated = !shadow;
		const resolution = resolveWorkspaceKit(parsed.config, input.workspaceId, await loadCatalog());
		const context = { kit: resolution.kitName, shadow };
		const baseRef = card.baseRef;

		const hold = await readHold(input.workspaceId, card.id);
		if (hold && input.trigger !== "hold_release") {
			const landing: RuntimeTaskLandingOutcome = { decision: shadow ? "shadow" : "held", baseRef };
			const note = `held for ${hold.group} since ${hold.at} (round ${hold.round}); only releaseHold lands or discards it`;
			await record(input, context, shadow ? "shadow" : "none", landing, note);
			return shadow
				? { proceed: true, landing }
				: { proceed: false, reason: `Task ${card.id} is ${note}.`, landing };
		}

		if (input.landing === "discard") {
			const landing: RuntimeTaskLandingOutcome = { decision: shadow ? "shadow" : "discarded", baseRef };
			await record(input, context, shadow ? "shadow" : "acted", landing, "discarded: Done without landing");
			return { proceed: true, landing };
		}

		const worktreePath = await findWorktree(input.workspacePath, card);
		// The pre-land snapshot is what lands (P4-2's snapshot ref). The ref moves only for a real land; a Done that
		// only asks, discards or runs in shadow takes a dry-run snapshot (the commit, not the ref).
		const source = worktreePath
			? await takeTaskSnapshot({
					worktreePath,
					taskId: card.id,
					baseRef,
					reason: "pre-land",
					dryRun: shadow || input.landing !== "land",
				})
			: null;
		if (!source) {
			// No worktree (a Backlog card never started): nothing to land.
			return { proceed: true, ...(input.landing === "land" ? { landing: { decision: "noop", baseRef } } : {}) };
		}
		const check: LandCheck = await checkLand({ repoPath: input.workspacePath, baseRef, commit: source.commit });
		if (check.status === "noop") {
			return { proceed: true, ...(input.landing === "land" ? { landing: { decision: "noop", baseRef } } : {}) };
		}

		if (shadow) {
			const would =
				input.landing === "land"
					? check.status === "clean"
						? `would land onto ${baseRef}`
						: check.status === "conflict"
							? `would refuse: conflict in ${check.files.join(", ")}`
							: `would refuse: ${check.error}`
					: `would ask "land or discard?" (${check.status} against ${baseRef})`;
			const landing: RuntimeTaskLandingOutcome = { decision: "shadow", baseRef };
			await record(input, context, "shadow", landing, would);
			return { proceed: true, landing };
		}

		if (input.landing !== "land") {
			const landing: RuntimeTaskLandingOutcome = { decision: "required", baseRef };
			await record(input, context, "none", landing, `asked "land or discard?" (trigger ${input.trigger})`);
			return { proceed: false, reason: requiredReason(card), landing };
		}

		const postLand: readonly PostLandStep[] = resolution.kit.land?.postLand ?? [];
		const result: LandResult = await serialized(input.workspacePath, async () =>
			landCommit({
				repoPath: input.workspacePath,
				baseRef,
				commit: source.commit,
				message: buildLandCommitMessage(card),
				taskId: card.id,
				postLand,
				stopProcessesUnder: deps.stopProcessesUnder,
				log,
			}),
		);
		const via = landedVia(input.trigger);
		const approved = via === "approved" ? "HUMAN_APPROVED: " : "";
		if (result.status === "landed") {
			const landing: RuntimeTaskLandingOutcome = { decision: "landed", baseRef, commit: result.commit };
			log(
				`land ${card.id}: ${baseRef} -> ${result.commit.slice(0, 8)}${result.checkout ? ` in ${result.checkout}` : ""}`,
			);
			await record(input, context, "acted", landing, `${approved}landed onto ${baseRef} as ${result.commit}`);
			// Kit features (the scoreboard's HUMAN_APPROVED line) score dev work; a plan card's spec is not one.
			if (resolveCardRole(card) === "dev") {
				deps.onLanded?.({
					workspaceId: input.workspaceId,
					taskId: card.id,
					at: now(),
					baseRef,
					commit: result.commit,
					via,
				});
			}
			return { proceed: true, landing };
		}
		if (result.status === "noop") {
			return { proceed: true, landing: { decision: "noop", baseRef } };
		}
		if (result.status === "conflict") {
			const landing: RuntimeTaskLandingOutcome = { decision: "conflict", baseRef, files: result.files };
			await record(input, context, "acted", landing, `${approved}conflict in ${result.files.join(", ")}`);
			return {
				proceed: false,
				reason: `Task ${card.id} conflicts with ${baseRef} in ${result.files.join(", ")}; nothing landed. Bring ${baseRef} into the task (rebase or merge), or discard it.`,
				landing,
			};
		}
		const landing: RuntimeTaskLandingOutcome = { decision: "error", baseRef };
		await record(input, context, "acted", landing, `${approved}land failed: ${result.error}`);
		return { proceed: false, reason: `Could not land task ${card.id} onto ${baseRef}: ${result.error}`, landing };
	};

	return async (input) => {
		const progress = { gated: false };
		try {
			return await decide(input, progress);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log(`land ${input.card.id}: the landing step failed: ${message}`);
			// A failure before the card is known to be a gated qa card (config, kit) must not block every Done on
			// every board; once it is, only "discard" may still finish it, so work is never dropped unasked.
			if (!progress.gated || input.landing === "discard") {
				return { proceed: true };
			}
			return {
				proceed: false,
				reason: `Could not ${input.landing === "land" ? "land" : "check the work of"} task ${input.card.id}: ${message}`,
				landing: { decision: "error", baseRef: input.card.baseRef },
			};
		}
	};
}
