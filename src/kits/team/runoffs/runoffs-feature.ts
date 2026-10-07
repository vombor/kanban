// The team kit's `runoffs` feature (plan §2.6, §3.2): runs on the core hold for workspaces whose kit lists it.
//
// - onPass: a PASS of a card in an open runoff (runoffs.json, written by `kanban bench runoff create` or by hand) is
//   held for that runoff instead of landing. Nothing else in the pipeline changes: QA, FAIL rounds, rework and
//   escalation run as for any dev card.
// - groups: the rework stage records the group it starts for the kit's `onFail.runoff` answer (the failed card and
//   its sibling cards on other models) here before it creates the siblings (PipelineRunoffGroupHandler).
// - tick (each pipeline evaluation outside shadow): once every card of an open runoff has a held PASS for its
//   current snapshot or is escalated, the runoff is decided (runoff-decision.ts). Losers (every PASS for
//   `benchOnly`) are tagged `preserve/<id>-<model>` and discarded through the Done workflow (`releaseHold`, never
//   landed); the winner is landed through it. The decision goes to runoffs.json and a `## RUNOFF` section of the QA
//   log. A runoff with a card trashed or deleted by hand is closed, and its other held cards are unheld and left in
//   Review for a human.
// - no card stays held for good: the decision's actions are written into the entry with it (`pending`) and resumed
//   on later ticks after a crash; a failing release is retried RUNOFF_ACTION_ATTEMPTS times, then the QA log names
//   `kanban task release-hold`; a winner whose land conflicts leaves the hold for the rework stage's conflict path
//   (src/pipeline/hold.ts releaseHold).
//
// The core never reads runoffs.json: only this feature does (and the watchdog's read-only keep/stall checks).
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (the runoff hold in qaflowSweep's PASS path
// and decideRunoffs; 83aa4d0, 2ffe609, 4007b3b). The legacy kit deleted a loser because its Done always landed; here
// the loser goes through the Done workflow with `discard`, which keeps its patch as well as the tag.
import { z } from "zod";

import type { RuntimeBoardCard, RuntimeBoardColumnId } from "../../../core/api-contract";
import { type PipelineSessionView, readCardHistory, toEffectiveCard } from "../../../pipeline/engine";
import type { PipelineFeature, PipelineFeatureContext, PipelineFeatureTickInput } from "../../../pipeline/features";
import { readPipelineHold } from "../../../pipeline/hold";
import type { PipelineCardState } from "../../../pipeline/pipeline-state";
import { readQaPassEntry, readQaVerdictRecords } from "../../../pipeline/qa-gate";
import { readTaskSnapshot } from "../../../pipeline/snapshots";
import { getTeamBenchWorkspacePaths, getWatchdogWorkspacePaths } from "../../../state/kanban-home";
import { readScoreboard } from "../scoreboard/scoreboard-line";
import { buildRunoffEntryFromGroup } from "./runoff-create";
import { decideRunoff, getRunoffPreserveTag, type RunoffCardFacts, type RunoffDecision } from "./runoff-decision";
import { findOpenRunoff, isOpenRunoff, type RunoffEntry, readRunoffs, updateRunoffs } from "./runoffs-store";

export interface RunoffsFeatureDependencies {
	/** runoffs.json of a workspace (default `<home>/data/<ws>/runoffs.json`). */
	getRunoffsPath?: (workspaceId: string) => string;
	/** The card's snapshot commit. Default: git (`refs/kanban/snapshots/<id>`). */
	readSnapshot?: (repoPath: string, taskId: string) => Promise<string | null>;
	/** What a card's PASS round cost in USD (default: its scoreboard line's metrics), null when unknown. */
	readCost?: (workspaceId: string, taskId: string, round: number) => Promise<number | null>;
	now?: () => number;
}

async function readScoreboardCost(workspaceId: string, taskId: string, round: number): Promise<number | null> {
	const { rows } = await readScoreboard(getTeamBenchWorkspacePaths(workspaceId).scoreboardJsonl);
	const row = rows.filter((line) => line.devId === taskId && line.round === round && line.verdict === "PASS").at(-1);
	return row?.metrics?.costUSD ?? null;
}

/**
 * Whether the pipeline escalated the card. The legacy `qaflow.escalated` field (P4-5's rework loop writes it there,
 * as the watchdog's stall check reads it), and a card parked in Backlog as `BLOCKED:` (escalation with
 * `requireApproval`, plan §4.0).
 */
export function isRunoffCardEscalated(
	card: RuntimeBoardCard,
	column: RuntimeBoardColumnId,
	entry: PipelineCardState | undefined,
): boolean {
	return (
		readCardHistory(entry).history.escalations > 0 || (column === "backlog" && /^BLOCKED:/u.test(card.title ?? ""))
	);
}

function findCard(
	input: PipelineFeatureTickInput,
	taskId: string,
): { card: RuntimeBoardCard; column: RuntimeBoardColumnId } | null {
	for (const column of input.snapshot.board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return { card, column: column.id };
		}
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** "provider/model" or "model" as `kanban bench runoff create` writes `models[<id>]`: the model part. */
function modelFromRunoffEntry(runoff: RunoffEntry, taskId: string): string | null {
	const value = runoff.models?.[taskId];
	if (!value) {
		return null;
	}
	const slash = value.indexOf("/");
	return slash > 0 && !value.slice(0, slash).includes(".") ? value.slice(slash + 1) : value;
}

async function collectFacts(
	input: PipelineFeatureTickInput,
	runoff: RunoffEntry,
	deps: Required<Pick<RunoffsFeatureDependencies, "readSnapshot" | "readCost">>,
): Promise<RunoffCardFacts[]> {
	const { snapshot, state } = input;
	const sessions = new Map<string, PipelineSessionView>(snapshot.sessions.map((session) => [session.taskId, session]));
	const facts: RunoffCardFacts[] = [];
	for (const id of runoff.cards) {
		const entry = state.cards[id];
		const found = findCard(input, id);
		const hold = readPipelineHold(entry);
		const pass = readQaPassEntry(entry);
		const held =
			hold?.group === runoff.name || (!hold && pass?.action === "hold")
				? { round: hold?.round ?? 0, snapshot: pass?.action === "hold" ? pass.snapshot : null, at: hold?.at ?? "" }
				: null;
		const verdicts = readQaVerdictRecords(entry);
		const passRecord = held
			? verdicts.filter((record) => record.verdict === "PASS" && record.round === held.round).at(-1)
			: null;
		const failRounds = new Set([
			...verdicts.filter((record) => record.verdict === "FAIL").map((record) => record.round),
			...readCardHistory(entry).history.failRounds,
		]);
		const effectiveModel = found
			? toEffectiveCard({
					card: found.card,
					session: sessions.get(id) ?? null,
					workspaceId: snapshot.workspaceId,
					selectedAgentId: snapshot.selectedAgentId,
				}).effective.model?.model
			: null;
		const inReview = found?.column === "review" && held !== null;
		facts.push({
			id,
			column: found?.column ?? null,
			escalated: found ? isRunoffCardEscalated(found.card, found.column, entry) : false,
			held,
			currentSnapshot: inReview ? await deps.readSnapshot(snapshot.workspacePath, id) : null,
			model: effectiveModel ?? modelFromRunoffEntry(runoff, id),
			scores: Object.values(passRecord?.scores ?? {}).filter((score): score is number => typeof score === "number"),
			fails: failRounds.size,
			cost: inReview && held ? await deps.readCost(snapshot.workspaceId, id, held.round) : null,
		});
	}
	return facts;
}

/**
 * What a decision still has to do, written into the runoff entry (`pending`) together with the decision, so a crash
 * between the two resumes on the next tick instead of leaving the cards held for good.
 */
const pendingActionSchema = z.object({
	taskId: z.string(),
	/** `unhold`: a runoff closed by hand lifts the other cards' holds (a human decides in Review). */
	action: z.enum(["land", "discard", "unhold"]),
	tag: z.string().nullable(),
	label: z.string(),
	attempts: z.number().int().nonnegative(),
});
type PendingAction = z.infer<typeof pendingActionSchema>;

/** A failing release is retried on this many ticks, then left to a human (`kanban task release-hold`). */
export const RUNOFF_ACTION_ATTEMPTS = 3;

function readPending(runoff: RunoffEntry): PendingAction[] {
	const parsed = z.array(pendingActionSchema).safeParse(runoff.pending);
	return parsed.success ? parsed.data : [];
}

function planActions(
	runoff: RunoffEntry,
	decision: Exclude<RunoffDecision, { kind: "open" }>,
	facts: readonly RunoffCardFacts[],
): PendingAction[] {
	if (decision.kind === "closed_by_hand") {
		// Cards still held for this runoff (in Review, not trashed or deleted) are left to the human, unheld.
		return facts
			.filter((card) => card.held && card.column !== null && card.column !== "trash")
			.map((card) => ({ taskId: card.id, action: "unhold", tag: null, label: "closed by hand", attempts: 0 }));
	}
	const discards = decision.discard.map(
		(result): PendingAction => ({
			taskId: result.id,
			action: "discard",
			tag: getRunoffPreserveTag(result),
			label: result.id === decision.winner?.id ? "won (bench only)" : "lost",
			attempts: 0,
		}),
	);
	const land: PendingAction[] = decision.land
		? [{ taskId: decision.land.id, action: "land", tag: null, label: "won", attempts: 0 }]
		: [];
	// Losers first, as the legacy kit did; the winner's land can then conflict without touching them.
	return runoff.benchOnly === true ? discards : [...discards, ...land];
}

function describeResult(result: NonNullable<RunoffEntry["results"]>[number]): string {
	return result.out === "pass"
		? ` r${result.round}, ${result.model}, score ${result.score}, ${result.fails} FAIL round(s), cost ${result.cost ?? "n/a"}`
		: "";
}

function describeDecision(
	runoff: RunoffEntry,
	decision: Exclude<RunoffDecision, { kind: "open" }>,
	at: string,
): string {
	if (decision.kind === "closed_by_hand") {
		return [
			`## RUNOFF ${runoff.name}: closed by hand, winner ${decision.winner ?? "none"}`,
			`- ${at} by the runoffs feature: ${decision.note}. Cards still held are unheld and left in Review for a human (Done asks "land or discard?").`,
			...decision.results.map((result) => `- ${result.id}: ${result.out}`),
		].join("\n");
	}
	const { winner } = decision;
	return [
		`## RUNOFF ${runoff.name}: ${winner ? `${winner.id} (${winner.model}) wins` : "no PASS, nothing lands"}${runoff.benchOnly === true ? " (bench only, nothing lands)" : ""}`,
		`- ${at} by the runoffs feature. Mean QA score, then fewer FAIL rounds (the round that started a runoff counts for the card that failed it), then lower cost.`,
		...decision.results.map((result) => `- ${result.id}: ${result.out}${describeResult(result)}`),
	].join("\n");
}

/** Carries out one pending action; `done` = drop it from `pending` with `outcome`. */
async function runPendingAction(
	context: PipelineFeatureContext,
	pending: PendingAction,
): Promise<{ done: boolean; outcome: string; line: string | null }> {
	const { taskId } = pending;
	if (pending.action === "unhold") {
		const lifted = await context.unhold({ taskId, reason: "runoff closed by hand" });
		return {
			done: true,
			outcome: lifted ? "unheld" : "not held",
			line: lifted ? `- ${taskId}: unheld, left in Review for a human` : null,
		};
	}
	const released = await context.releaseHold({
		taskId,
		decision: pending.action,
		...(pending.tag ? { tag: pending.tag } : {}),
	});
	if (released.ok) {
		return {
			done: true,
			outcome: pending.action === "land" ? "landed" : `discarded, tag ${pending.tag}`,
			line:
				pending.action === "land"
					? `- ${taskId}: ${pending.label}; landed and Done`
					: `- ${taskId}: ${pending.label}; work kept as tag ${pending.tag}; card discarded to Done (not landed)`,
		};
	}
	if (released.code === "not_held") {
		return {
			done: true,
			outcome: "not held any more (released by hand?)",
			line: `- ${taskId}: not held any more; nothing done`,
		};
	}
	if (released.code === "conflict") {
		return {
			done: true,
			outcome: "land conflict: sent back for a rebase",
			line: `- ${taskId}: ${pending.label}, but its land conflicts (${released.error}); it left the hold and the rework stage sends it back for a rebase`,
		};
	}
	const attempts = pending.attempts + 1;
	if (attempts < RUNOFF_ACTION_ATTEMPTS) {
		return { done: false, outcome: released.error, line: null };
	}
	const how = pending.action === "land" ? "--land" : `--discard --tag ${pending.tag}`;
	return {
		done: true,
		outcome: `${pending.action} failed ${attempts} times: ${released.error}`,
		line: `- ${taskId}: ${pending.label}, but ${pending.action} failed ${attempts} times (${released.error}); still held: kanban task release-hold --task-id ${taskId} ${how}`,
	};
}

export function createRunoffsFeature(deps: RunoffsFeatureDependencies = {}): PipelineFeature {
	const getRunoffsPath =
		deps.getRunoffsPath ?? ((workspaceId: string) => getWatchdogWorkspacePaths(workspaceId).runoffs);
	const readSnapshot = deps.readSnapshot ?? readTaskSnapshot;
	const readCost = deps.readCost ?? readScoreboardCost;
	const now = deps.now ?? Date.now;

	/** Runs a decided runoff's pending actions (right after the decision, and again on later ticks). */
	const processPending = async (context: PipelineFeatureContext, path: string, name: string): Promise<void> => {
		const runoff = (await readRunoffs(path)).runoffs.find((entry) => entry.name === name);
		const pending = runoff ? readPending(runoff) : [];
		if (pending.length === 0) {
			return;
		}
		const remaining: PendingAction[] = [];
		const outcomes: Record<string, string> = {};
		const lines: string[] = [];
		for (const action of pending) {
			const result = await runPendingAction(context, action);
			if (result.done) {
				outcomes[action.taskId] = result.outcome;
			} else {
				remaining.push({ ...action, attempts: action.attempts + 1 });
				context.log(
					`runoff ${name}: ${action.action} ${action.taskId} failed (${result.outcome}); retried next tick`,
				);
			}
			if (result.line) {
				lines.push(result.line);
			}
		}
		await updateRunoffs(path, (runoffs) => {
			const entry = runoffs.find((candidate) => candidate.name === name);
			if (!entry) {
				return;
			}
			entry.actions = { ...(isRecord(entry.actions) ? entry.actions : {}), ...outcomes };
			if (remaining.length > 0) {
				entry.pending = remaining;
			} else {
				delete entry.pending;
			}
		});
		if (lines.length > 0) {
			await context.appendQaLog(`## RUNOFF ${name}: actions\n${lines.join("\n")}`);
		}
	};

	const decideOpenRunoffs = async (
		context: PipelineFeatureContext,
		input: PipelineFeatureTickInput,
	): Promise<void> => {
		const path = getRunoffsPath(context.workspaceId);
		const { runoffs } = await readRunoffs(path);
		for (const runoff of runoffs) {
			if (!isOpenRunoff(runoff)) {
				// A decision whose actions a crash or a failure left undone.
				if (runoff.decided && readPending(runoff).length > 0) {
					await processPending(context, path, runoff.name);
				}
				continue;
			}
			const facts = await collectFacts(input, runoff, { readSnapshot, readCost });
			const decision = decideRunoff(runoff, facts, { now: input.now });
			if (decision.kind === "open") {
				continue;
			}
			const decidedAt = new Date(now()).toISOString();
			const pending = planActions(runoff, decision, facts);
			// Recorded with its actions before acting: a crash mid-way never decides twice and resumes the actions.
			const { value: claimed } = await updateRunoffs(path, (current) => {
				const entry = current.find((candidate) => candidate.name === runoff.name);
				if (!entry || !isOpenRunoff(entry)) {
					return false;
				}
				entry.decided = decidedAt;
				entry.winner = decision.kind === "decided" ? (decision.winner?.id ?? null) : decision.winner;
				entry.results = decision.results;
				if (decision.kind === "closed_by_hand") {
					entry.note = decision.note;
				}
				if (pending.length > 0) {
					entry.pending = pending;
				}
				return true;
			});
			if (!claimed) {
				continue;
			}
			context.log(
				`runoff ${runoff.name}: ${decision.kind === "closed_by_hand" ? decision.note : `decided, winner ${decision.winner?.id ?? "none"}`}`,
			);
			await context.appendQaLog(describeDecision(runoff, decision, decidedAt));
			await processPending(context, path, runoff.name);
		}
	};

	return {
		name: "runoffs",
		activate: (context) => {
			context.onPass(async ({ dev, verdict }) => {
				const { runoffs } = await readRunoffs(getRunoffsPath(context.workspaceId));
				const runoff = findOpenRunoff(runoffs, dev.card.id);
				if (!runoff) {
					return null;
				}
				const others = runoff.cards.filter((id) => id !== dev.card.id).join(", ");
				await context.appendQaLog(
					`## RUNOFF HOLD ${dev.card.id}: QA PASS r${verdict.round} held for runoff ${runoff.name}\n- Lands only if it outscores ${others}; decided once every runoff card has a PASS for its current snapshot or is escalated.`,
				);
				return { action: "hold", group: runoff.name };
			});
			context.onTick(async (input) => await decideOpenRunoffs(context, input));
			context.provideRunoffGroups({
				groupOf: async (taskId) =>
					findOpenRunoff((await readRunoffs(getRunoffsPath(context.workspaceId))).runoffs, taskId)?.name ?? null,
				record: async (group) => {
					const entry = buildRunoffEntryFromGroup(group, new Date(now()).toISOString());
					await updateRunoffs(getRunoffsPath(context.workspaceId), (runoffs) => {
						const index = runoffs.findIndex((runoff) => runoff.name === group.name);
						if (index >= 0) {
							runoffs[index] = { ...entry, createdAt: runoffs[index]?.createdAt ?? entry.createdAt };
						} else {
							runoffs.push(entry);
						}
					});
				},
			});
			return undefined;
		},
	};
}
