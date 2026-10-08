// The QA gate (plan §2.4, §4.0): the core mechanism that QAs a submitted dev card on a landing-`qa` workspace.
// The kit only answers `qaPolicy` (whether, by which agent and model, with which prompt parts); everything else is
// here and the same for every kit:
//
// 1. submit: a dev card in Review with work whose kit answer is `qa` gets one QA card per snapshot: `role: "qa"`,
//    `reviewsTaskId` = the dev card, the kit's agent and model, the QA prompt (qa-prompt.ts), created in Backlog.
// 2. pump: queued QA cards start oldest first while fewer than `pipeline.qa.slots` QA cards run (machine-wide);
//    the project preview is started first when the kit names one.
// 3. ingest: a QA card in Review is done. Its outbox verdict.json is recorded (qa-log, artifacts, the dev card's
//    pipeline state, the `verdictRecorded` event), its scratch servers are stopped, and it goes to Done through the
//    Done workflow (`finishTask`, never landed). A QA card that stopped without a usable verdict is nudged, then
//    recorded STALLED.
// 4. PASS: the kit's `onPass` (decideOnPass, hold.ts) may hold the card; otherwise the Done workflow lands it
//    (src/server/task-landing-gate.ts, trigger `pipeline`). FAIL, STALLED and a land conflict are the rework stage's
//    (rework.ts): the gate records them (the verdict, `qaPass.landing`) and does nothing more.
//
// The gate only handles the QA cards it created (state entry `qaGate`): QA cards the legacy kit made stay the
// legacy kit's.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (queueQa, createQa, pumpQa, ingestQaOnce)
// and qa/qa-card.cjs@6da71597. Rules kept, each with a test in test/runtime/pipeline/qa-gate.test.ts:
// - one QA card per snapshot (`qaCreated`, the legacy field), none while another QA card reviews the dev card,
//   none for a snapshot that already has a verdict (an empty snapshot never gets here: the submission stage
//   finds no work in it);
// - no QA while the dev card's session is still running (dc6e70d/9091f4b: QA of a half-done card);
// - QA slots machine-wide, oldest first (ddbc9ae); a queued QA card waits while its dev card is In Progress again
//   instead of starting on the old snapshot (afea137, bfb20); a QA card running past `timeoutMin` frees its slot;
// - wait `verdictGraceSec` for verdict.json before nudging (8495ed2: c1e30 reached Review 0.55 s before its
//   verdict); nudges quote why the file is unusable (b9dd99b); `maxNudges`, then STALLED;
// - a PASS with visual QA blocked is STALLED (QA v4); scratch servers stopped after ingest (66797d9);
// - a QA card queued or running for a turn recovery has since resent (the dev card's `recoverySentAt` is newer than
//   the QA card) is superseded: never started, or stopped, and moved to Done unlanded with no verdict; the dev card's
//   next settled Review gets a new snapshot and a new QA card (foo 27549, 2026-10-07: QA started on the snapshot of
//   the turn recovery had redone);
// - no QA card is created or started while the snapshot says `pidPressure` (pumpQa's pid-pressure hold: zombies
//   filling pids.max wiped a board, 10/05), logged once per hold; ingest and PASS landing go on.
// - a QA card that can no longer give a verdict (describeDeadQaCard: its session died with the previous server, or
//   it went to Done or off the board with none ingested) neither "already reviews" its dev card nor holds a slot: it
//   is superseded like a resent turn's, and the dev card gets a new QA card for the same snapshot. After the
//   23:02:56Z restart on 2026-10-07 the gate trusted the column and the dead "running" summaries of a5e91 and 257a4,
//   and their dev cards sat in Review without QA until the watchdog flagged them.
// New since the legacy kit (user's choice "D", 2026-10-07): the QA card is created only once the scripted checks of
// its snapshot have finished, or after `checksWaitMin`, and its prompt gets their report (qa-checks-report.ts).
import { randomUUID } from "node:crypto";
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { PipelineConfig, WorkspacePipelineSettings } from "../config/pipeline-config";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeTaskAgentSettings,
	RuntimeTaskLandingOutcome,
	RuntimeTaskTrashResponse,
} from "../core/api-contract";
import { resolveCardRole, resolveReviewedTaskId } from "../core/card-role";
import type { EffectiveModel, EffectiveModelConfig } from "../core/effective-agent";
import { createUniqueTaskId } from "../core/task-id";
import type { KitDocument } from "../kits/kit-schema";
import type { EffectiveCard, KitVerdict, OnPassAnswer, QaPolicyAnswer, RoutingPolicy } from "../kits/policy";
import { getKanbanHomeDisplayPath, getPipelineQaLogPath, getQaArtifactsPath } from "../state/kanban-home";
import { isReviewSettled } from "../terminal/review-settle";
import type { PipelineActions } from "./actions";
import { readSnapshotCheckScripts, resolveChecksEnabled } from "./checks";
import type { PipelineDecisionOutcome, PipelineDecisionRecord } from "./decision-log";
import {
	describeUnsettledReview,
	type PipelineSessionView,
	type PipelineWorkspaceSnapshot,
	readEscalatedAt,
	toEffectiveCard,
} from "./engine";
import type { PipelineEventBus } from "./events";
import { decideOnPass, readPipelineHold } from "./hold";
import type { PipelineCardState, PipelineStateStore, PipelineWorkspaceState } from "./pipeline-state";
import {
	buildQaChecksReport,
	decideQaChecks,
	describeQaChecksOutcome,
	type QaChecksOutcome,
	readQaChecksWait,
	toQaChecksOutcome,
} from "./qa-checks-report";
import { type AppendQaLog, countQaLogRounds, formatQaLogSection, getPreviousQaRounds, readQaLog } from "./qa-log";
import type { QaPreviewController } from "./qa-preview";
import { buildQaCardTitle, buildQaPrompt, buildQaRequirements } from "./qa-prompt";
import {
	applyQaVerdictRules,
	buildQaVerdictNudge,
	createStalledQaVerdict,
	getQaVerdictPath,
	type QaVerdict,
	type QaVerdictRead,
} from "./qa-verdict";
import { type RecoveryFlowState, readRecoveryFlow } from "./recovery";
import { lostToRestart } from "./restart-recovery";
import { getSnapshotRef, readTaskSnapshot } from "./snapshots";
import type { PipelineFinishTaskRequest } from "./worker-protocol";

const effectiveModelSchema = z.object({ provider: z.string().nullable(), model: z.string() }).nullable();

/** A QA card's entry in pipeline-state.json (`cards[<qaTaskId>].qaGate`). */
export const qaGateEntrySchema = z.object({
	reviewsTaskId: z.string(),
	round: z.number().int().positive(),
	snapshot: z.string(),
	snapshotRef: z.string(),
	outboxDir: z.string(),
	scratchDir: z.string(),
	baseRef: z.string(),
	agentId: z.string(),
	model: effectiveModelSchema,
	devAgentId: z.string(),
	devModel: effectiveModelSchema,
	route: z.string().nullable(),
	/** `superseded`: recovery resent the dev card's turn after this QA card was made; it is dropped, never ingested. */
	status: z.enum(["queued", "running", "ingested", "superseded"]),
	createdAt: z.number(),
	startedAt: z.number().nullable().default(null),
	/** When the gate first saw the card in Review in this attempt (the verdict grace runs from here). */
	reviewSeenAt: z.number().nullable().default(null),
	nudges: z.number().int().nonnegative().default(0),
	timedOutAt: z.number().nullable().default(null),
	ingestedAt: z.number().nullable().default(null),
	verdict: z.string().nullable().default(null),
	trashed: z.boolean().default(false),
	supersededAt: z.number().nullable().default(null),
	/** The scripted checks the QA prompt reported (`timed_out`: QA started without them); null: no checks. */
	checks: z.enum(["PASS", "FAIL", "ERROR", "timed_out", "unknown"]).nullable().default(null),
});
export type QaGateEntry = z.infer<typeof qaGateEntrySchema>;

/** What the QA gate did with a dev card's newest PASS (`cards[<devTaskId>].qaPass`), so it acts on it once. */
export interface QaPassEntry {
	qaTaskId: string;
	snapshot: string;
	at: number;
	/** `stale`: the card changed after QA; `hold`: the kit held it; `land`: the Done workflow was asked to land it. */
	action: "stale" | "hold" | "land";
	/** The Done workflow's status for `land`. */
	status: string | null;
	error: string | null;
	/** What the landing step answered for `land` (a `conflict` with its files goes to the rework stage). */
	landing?: RuntimeTaskLandingOutcome | null;
}

export function readQaPassEntry(entry: PipelineCardState | undefined): QaPassEntry | null {
	const pass = entry?.qaPass;
	return isPlainObject(pass) && typeof pass.qaTaskId === "string" ? (pass as unknown as QaPassEntry) : null;
}

/** One recorded verdict on the dev card's entry (`cards[<devTaskId>].qaVerdicts[]`). */
export interface QaVerdictRecord {
	qaTaskId: string;
	round: number;
	snapshot: string;
	verdict: QaVerdict["verdict"];
	blocking: string[];
	notes: string;
	scores: QaVerdict["scores"];
	visual: QaVerdict["visual"];
	artifactsDir: string | null;
	at: number;
}

export interface QaGateContext {
	snapshot: PipelineWorkspaceSnapshot;
	settings: WorkspacePipelineSettings;
	qa: PipelineConfig["pipeline"]["qa"];
	kit: KitDocument;
	kitName: string;
	/** The workspace's resolved kit, asked `onPass` before a PASS lands. */
	policy: RoutingPolicy;
	/** The workspace's active features, asked `onPass` before the kit (the team `runoffs` feature holds). */
	featureOnPass?: (input: { dev: EffectiveCard; verdict: KitVerdict }) => Promise<OnPassAnswer | null>;
	agentDefaultModels?: EffectiveModelConfig["agentDefaultModels"];
	now: number;
	/** Asks for another evaluation of the workspace at `at` (a QA card waiting for checks times out then). */
	requestWake?: (at: number) => void;
}

export interface QaGateSubmitInput {
	context: QaGateContext;
	card: RuntimeBoardCard;
	session: PipelineSessionView | null;
	dev: EffectiveCard;
	answer: Extract<QaPolicyAnswer, { kind: "qa" }>;
}

export interface QaGateDependencies {
	/** Creates and starts QA cards on the server. */
	actions: PipelineActions;
	/** Types into a card's agent (the watchdog's `deliverInput` request): the verdict nudges. */
	deliverInput: (input: {
		workspaceId: string;
		taskId: string;
		text: string;
	}) => Promise<{ ok: boolean; error?: string }>;
	/** The Done workflow (`trigger: "pipeline"`): an ingested QA card (never landed), a PASS (landed). */
	finishTask: (request: PipelineFinishTaskRequest) => Promise<RuntimeTaskTrashResponse>;
	/** The worker's QA log appender (one write chain per file, shared with the checks reports). */
	appendQaLog: AppendQaLog;
	store: PipelineStateStore;
	bus: PipelineEventBus;
	preview: QaPreviewController;
	/** The card's snapshot commit (`refs/kanban/snapshots/<id>`, written by the submission stage). Default: git. */
	readSnapshot?: (repoPath: string, taskId: string) => Promise<string | null>;
	/** The configured check scripts a snapshot's package.json has (none: QA doesn't wait). Default: git show. */
	readCheckScripts?: (repoPath: string, snapshot: string, scripts: readonly string[]) => Promise<string[]>;
	readVerdict: (outboxDir: string) => Promise<QaVerdictRead>;
	stopScratchProcesses: (dirs: string[]) => Promise<number>;
	copyArtifacts?: (from: string, to: string) => Promise<void>;
	/** For reading the QA log (rounds, earlier sections). */
	getQaLogPath?: (workspaceId: string) => string;
	getArtifactsPath?: (workspaceId: string) => string;
	/** The Kanban home QA agents are told not to touch (default getKanbanHomeDisplayPath()). */
	getKanbanHome?: () => string;
	randomUuid?: () => string;
	log: (message: string) => void;
}

export interface QaGate {
	/** For a dev card whose kit answer is `qa` (never called in shadow). */
	submit: (input: QaGateSubmitInput) => Promise<{ outcome: PipelineDecisionOutcome; note: string }>;
	/** Ingests finished QA cards, starts queued ones, stops an idle preview (never called in shadow). */
	tick: (context: QaGateContext) => Promise<PipelineDecisionRecord[]>;
	/** The workspace stopped running the pipeline: its QA cards no longer hold slots. */
	forget: (workspaceId: string) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readQaGateEntry(entry: PipelineCardState | undefined): QaGateEntry | null {
	const parsed = qaGateEntrySchema.safeParse(entry?.qaGate);
	return parsed.success ? parsed.data : null;
}

export function readQaVerdictRecords(entry: PipelineCardState | undefined): QaVerdictRecord[] {
	const records = entry?.qaVerdicts;
	return Array.isArray(records) ? records.filter((record): record is QaVerdictRecord => isPlainObject(record)) : [];
}

function toAgentSettings(model: EffectiveModel | null): RuntimeTaskAgentSettings | undefined {
	if (!model) {
		return undefined;
	}
	return { ...(model.provider ? { providerId: model.provider } : {}), modelId: model.model };
}

function describeModel(model: EffectiveModel | null): string {
	return model ? model.model : "its default model";
}

function describeCreated(qaTaskId: string, entry: QaGateEntry, shortSnapshot: string): string {
	const checks = describeQaChecksOutcome(entry.checks);
	return `QA card ${qaTaskId} was created for snapshot ${shortSnapshot} (round ${entry.round}, ${entry.agentId} on ${describeModel(entry.model)})${checks ? ` with ${checks}` : ""}`;
}

/**
 * For a snapshot that already has its QA card: the same note on every evaluation (so the decision log has it once),
 * and one that can't be read as a new creation (after a worker restart it is logged again for a card made long ago).
 */
function describeExisting(qaTaskId: string, entry: QaGateEntry | null, shortSnapshot: string): string {
	if (!entry) {
		return `snapshot ${shortSnapshot} already had QA card ${qaTaskId}; no new QA card`;
	}
	const status = entry.status === "ingested" ? `ingested, ${entry.verdict ?? "no verdict"}` : entry.status;
	return `snapshot ${shortSnapshot} already has QA card ${qaTaskId} (round ${entry.round}, created ${new Date(entry.createdAt).toISOString()}, ${status}); no new QA card`;
}

/** How long a QA card the gate created may be missing from the snapshots (one may predate it) before it is gone. */
export const QA_CARD_MISSING_GRACE_MS = 2 * 60_000;

/**
 * Why a QA card the gate queued or started can no longer run to its verdict, or null while it still can: queued in
 * Backlog, a session with a process, a Review waiting for ingest (`awaiting_review`, whatever server it ended under),
 * or a session this server started (its end is the ingest's: nudge, then STALLED). A session that started before
 * this server and has no process now died with the old one: its summary may still say "running" (or "interrupted",
 * src/terminal/session-manager.ts markOrphanedSessionsInterrupted; "idle" for an agent that exited), and nothing will
 * nudge it. It may have written its verdict first: the caller reads verdict.json before it supersedes the card
 * (supersedeDeadQaCard in createQaGate).
 */
export function describeDeadQaCard(input: {
	column: RuntimeBoardColumnId | null;
	session: PipelineSessionView | null;
	entry: QaGateEntry;
	/** The QA card's recovery flow: restart recovery marks the QA cards a restart orphaned (`orphan`). */
	flow: RecoveryFlowState;
	serverStartedAt: number | undefined;
	now: number;
}): string | null {
	const { column, session, entry, serverStartedAt } = input;
	if (entry.status !== "queued" && entry.status !== "running") {
		return null;
	}
	if (column === "trash") {
		return "went to Done before its verdict was ingested";
	}
	if (column === null) {
		return input.now - entry.createdAt > QA_CARD_MISSING_GRACE_MS
			? "is no longer on the board, and its verdict was never ingested"
			: null;
	}
	if (column === "backlog" || session?.live) {
		return null;
	}
	if (column === "review" && session?.state === "awaiting_review") {
		return null;
	}
	if (serverStartedAt === undefined) {
		return null;
	}
	// Restart recovery's rule; without a summary the gate's own start (or creation) time stands in for the session's.
	if (
		!lostToRestart(
			{ live: false, startedAt: session?.startedAt ?? entry.startedAt ?? entry.createdAt },
			serverStartedAt,
		)
	) {
		return null;
	}
	const orphaned = input.flow.orphan && Date.parse(input.flow.orphan.kanbanStart) === serverStartedAt;
	return `(${column}) lost its session with the previous Kanban server (summary ${session?.state ?? "missing"}, no process now)${orphaned ? "; restart recovery handed it to the QA gate" : ""}`;
}

function listCards(
	snapshot: PipelineWorkspaceSnapshot,
): Array<{ columnId: RuntimeBoardColumnId; card: RuntimeBoardCard }> {
	return snapshot.board.columns.flatMap((column) => column.cards.map((card) => ({ columnId: column.id, card })));
}

function findColumn(snapshot: PipelineWorkspaceSnapshot, taskId: string): RuntimeBoardColumnId | null {
	return listCards(snapshot).find((entry) => entry.card.id === taskId)?.columnId ?? null;
}

async function copyDirectory(from: string, to: string): Promise<void> {
	await mkdir(to, { recursive: true });
	await cp(from, to, { recursive: true, force: true });
}

export function createQaGate(deps: QaGateDependencies): QaGate {
	const copyArtifacts = deps.copyArtifacts ?? copyDirectory;
	const qaLogPathOf = deps.getQaLogPath ?? ((workspaceId: string) => getPipelineQaLogPath(workspaceId));
	const artifactsPathOf = deps.getArtifactsPath ?? ((workspaceId: string) => getQaArtifactsPath(workspaceId));
	const randomUuid = deps.randomUuid ?? randomUUID;
	const readSnapshot = deps.readSnapshot ?? readTaskSnapshot;
	const readCheckScripts = deps.readCheckScripts ?? readSnapshotCheckScripts;
	const kanbanHomeOf = deps.getKanbanHome ?? (() => getKanbanHomeDisplayPath());
	/** workspaceId → QA cards running there, for the machine-wide slot count. */
	const runningByWorkspace = new Map<string, number>();
	/** Workspaces whose queued QA cards are held for PID pressure (already logged). */
	const pressureHolds = new Set<string>();
	/** workspaceId → the dead QA cards retired since the last tick (submit and the sweep), for one summary line. */
	const retiredByWorkspace = new Map<string, string[]>();

	const record = (
		context: QaGateContext,
		taskId: string | null,
		stage: "qa_start" | "qa_ingest" | "qa_pass",
		note: string,
	): PipelineDecisionRecord => ({
		at: new Date(context.now).toISOString(),
		workspaceId: context.snapshot.workspaceId,
		taskId,
		stage,
		kit: context.kitName,
		landingMode: context.settings.landing.mode,
		shadow: false,
		effectiveAgent: null,
		model: null,
		role: "qa",
		answer: null,
		outcome: "acted",
		note,
	});

	const updateCard = async (
		workspaceId: string,
		taskId: string,
		mutate: (entry: PipelineCardState) => PipelineCardState,
	): Promise<PipelineWorkspaceState> =>
		await deps.store.update(workspaceId, (state) => ({
			...state,
			cards: { ...state.cards, [taskId]: mutate(state.cards[taskId] ?? {}) },
		}));

	const updateQaEntry = async (workspaceId: string, qaTaskId: string, patch: Partial<QaGateEntry>): Promise<void> => {
		await updateCard(workspaceId, qaTaskId, (entry) => {
			const current = readQaGateEntry(entry);
			return current ? { ...entry, qaGate: { ...current, ...patch } } : entry;
		});
	};

	const deadReasonOf = (
		context: QaGateContext,
		state: PipelineWorkspaceState,
		qaTaskId: string,
		entry: QaGateEntry,
	): string | null =>
		describeDeadQaCard({
			column: findColumn(context.snapshot, qaTaskId),
			session: context.snapshot.sessions.find((session) => session.taskId === qaTaskId) ?? null,
			entry,
			flow: readRecoveryFlow(state.cards[qaTaskId]),
			serverStartedAt: context.snapshot.serverStartedAt,
			now: context.now,
		});

	const stopQaScratch = async (entry: QaGateEntry): Promise<number> =>
		await deps.stopScratchProcesses([entry.scratchDir, `${entry.scratchDir}-${entry.baseRef}`]).catch(() => 0);

	/**
	 * Marks the QA card `superseded` (never started, ingested or counted for a slot again; the tick moves it to Done)
	 * and drops the dev card's `qaCreated`, so the dev card's next settled Review gets a QA card of its own.
	 */
	const markSuperseded = async (context: QaGateContext, qaTaskId: string, entry: QaGateEntry): Promise<number> => {
		const workspaceId = context.snapshot.workspaceId;
		await updateQaEntry(workspaceId, qaTaskId, { status: "superseded", supersededAt: context.now });
		await updateCard(workspaceId, entry.reviewsTaskId, (dev) => {
			if (dev.qaCard !== qaTaskId) {
				return dev;
			}
			const { qaCreated: _created, qaCard: _card, ...rest } = dev;
			return rest;
		});
		return entry.status === "running" ? await stopQaScratch(entry) : 0;
	};

	/**
	 * Retires a QA card whose session can't give a verdict any more (describeDeadQaCard); returns the note. A verdict.json
	 * it finished first (before the restart, or before a human dragged the card to Done) is recorded as usual and the
	 * card goes to Done; only one without a verdict is superseded, so its dev card gets a new QA card for the snapshot.
	 */
	const supersedeDeadQaCard = async (
		context: QaGateContext,
		qaTaskId: string,
		entry: QaGateEntry,
		reason: string,
	): Promise<string> => {
		const retired = retiredByWorkspace.get(context.snapshot.workspaceId) ?? [];
		retired.push(`${qaTaskId} (for ${entry.reviewsTaskId})`);
		retiredByWorkspace.set(context.snapshot.workspaceId, retired);
		const read = await deps.readVerdict(entry.outboxDir);
		if (read.kind === "ok") {
			const recorded = await recordVerdict(
				context,
				qaTaskId,
				entry,
				read.verdict,
				`read after the QA card ${reason}`,
			);
			return `QA card ${qaTaskId} ${reason}, with its verdict written: ${recorded}; ${await trashQaCard(context, qaTaskId)}`;
		}
		const stopped = await markSuperseded(context, qaTaskId, entry);
		deps.log(`qa ${entry.reviewsTaskId}: QA card ${qaTaskId} ${reason}; superseded`);
		return `QA card ${qaTaskId} of round ${entry.round} for snapshot ${entry.snapshot.slice(0, 8)} ${reason}: superseded${stopped > 0 ? ` (stopped ${stopped} scratch process(es))` : ""}, and ${entry.reviewsTaskId} gets a new QA card for its snapshot`;
	};

	/**
	 * The QA cards of the gate's that review `card` but can't give a verdict any more (describeDeadQaCard) are
	 * superseded, so they neither block a new QA card nor hold a slot; the tick moves them to Done. Returns the QA card
	 * that does still review the card (a legacy-kit one, without an entry, always counts), and a note per superseded one.
	 */
	const supersedeDeadReviewers = async (
		context: QaGateContext,
		card: RuntimeBoardCard,
	): Promise<{ reviewer: string | null; notes: string[] }> => {
		const state = await deps.store.load(context.snapshot.workspaceId);
		const candidates = listCards(context.snapshot)
			.filter(
				({ columnId, card: other }) =>
					columnId !== "trash" &&
					other.id !== card.id &&
					resolveCardRole(other) === "qa" &&
					resolveReviewedTaskId(other) === card.id,
			)
			.map(({ columnId, card: other }) => ({ qaTaskId: other.id, columnId }));
		// The dev card's own QA card may be off the board's work columns: moved to Done by hand, or deleted.
		const recorded = state.cards[card.id]?.qaCard;
		if (typeof recorded === "string" && !candidates.some((candidate) => candidate.qaTaskId === recorded)) {
			candidates.push({ qaTaskId: recorded, columnId: findColumn(context.snapshot, recorded) ?? "trash" });
		}
		const notes: string[] = [];
		for (const { qaTaskId, columnId } of candidates) {
			const entry = readQaGateEntry(state.cards[qaTaskId]);
			const onBoard = columnId !== "trash";
			if (!entry) {
				if (onBoard) {
					return { reviewer: `QA card ${qaTaskId} (${columnId})`, notes };
				}
				continue;
			}
			if (entry.status === "superseded" || (entry.status === "ingested" && !onBoard)) {
				continue;
			}
			const dead = deadReasonOf(context, state, qaTaskId, entry);
			if (!dead) {
				if (onBoard) {
					return { reviewer: `QA card ${qaTaskId} (${columnId})`, notes };
				}
				continue;
			}
			notes.push(await supersedeDeadQaCard(context, qaTaskId, entry, dead));
		}
		return { reviewer: null, notes };
	};

	const queueQa = async ({
		context,
		card,
		dev,
		answer,
	}: QaGateSubmitInput): Promise<{ outcome: PipelineDecisionOutcome; note: string }> => {
		const { snapshot } = context;
		const workspaceId = snapshot.workspaceId;
		// The submission stage snapshotted the card and found work in it before the kit was asked.
		const snapshotCommit = await readSnapshot(snapshot.workspacePath, card.id);
		if (!snapshotCommit) {
			return { outcome: "none", note: `no snapshot yet (${getSnapshotRef(card.id)}); QA waits for one` };
		}
		const qaSnapshot = { ref: getSnapshotRef(card.id), commit: snapshotCommit };
		const short = qaSnapshot.commit.slice(0, 8);
		const state = await deps.store.load(workspaceId);
		const devEntry = state.cards[card.id];
		if (devEntry?.qaCreated === qaSnapshot.commit) {
			const qaTaskId = String(devEntry.qaCard ?? "?");
			return { outcome: "none", note: describeExisting(qaTaskId, readQaGateEntry(state.cards[qaTaskId]), short) };
		}
		if (readQaVerdictRecords(devEntry).some((verdict) => verdict.snapshot === qaSnapshot.commit)) {
			return { outcome: "none", note: `snapshot ${short} already has a QA verdict` };
		}
		// QA starts on finished checks (their report goes into the prompt), or without them after checksWaitMin. The
		// same note on every evaluation of the wait, so the decision log has it once.
		const checks = await decideQaChecks({
			entry: devEntry,
			snapshot: qaSnapshot.commit,
			now: context.now,
			waitMin: context.qa.checksWaitMin,
			enabled: resolveChecksEnabled(context.settings, context.kitName),
			readScripts: async () =>
				await readCheckScripts(snapshot.workspacePath, qaSnapshot.commit, context.settings.checks.scripts).catch(
					() => [],
				),
		});
		if (checks.kind === "waiting") {
			const wait = readQaChecksWait(devEntry);
			if (wait?.snapshot !== qaSnapshot.commit || wait.since !== checks.since) {
				await updateCard(workspaceId, card.id, (entry) => ({
					...entry,
					qaChecksWait: { snapshot: qaSnapshot.commit, since: checks.since },
				}));
				deps.log(`qa ${card.id}: QA waits for the checks of snapshot ${short}`);
			}
			context.requestWake?.(checks.deadline);
			return {
				outcome: "none",
				note: `QA waits for checks on ${short} (up to ${context.qa.checksWaitMin} min, until ${new Date(checks.deadline).toISOString()})`,
			};
		}
		const checksOutcome: QaChecksOutcome = toQaChecksOutcome(checks);
		// The same note on every evaluation of the hold, so the decision log has it once; the creation follows it.
		if (snapshot.pidPressure) {
			return { outcome: "none", note: `PID pressure: no QA card for snapshot ${short} until it clears` };
		}

		const qaLog = await readQaLog(qaLogPathOf(workspaceId));
		const round = countQaLogRounds(qaLog, card.id) + 1;
		const qaTaskId = createUniqueTaskId(new Set(listCards(snapshot).map((entry) => entry.card.id)), randomUuid);
		const outboxDir = join(context.qa.outboxRoot, qaTaskId);
		const scratchDir = join(context.qa.scratchRoot, card.id);
		const devTitle = card.title || card.prompt;
		const prompt = buildQaPrompt({
			devTaskId: card.id,
			round,
			devTitle,
			requirements: buildQaRequirements(card.prompt, answer.promptParts.blurb),
			repoPath: snapshot.workspacePath,
			snapshotRef: qaSnapshot.ref,
			baseRef: card.baseRef,
			scratchDir,
			outboxDir,
			previousRounds: getPreviousQaRounds(qaLog, card.id),
			parts: answer.promptParts,
			kanbanHome: kanbanHomeOf(),
			checksReport: buildQaChecksReport({ status: checks, snapshot: qaSnapshot.commit, baseRef: card.baseRef }),
		});
		const created = await deps.actions.run({
			kind: "createTask",
			workspaceId,
			workspacePath: snapshot.workspacePath,
			task: {
				taskId: qaTaskId,
				title: buildQaCardTitle(card.id, round, devTitle),
				prompt,
				role: "qa",
				reviewsTaskId: card.id,
				agentId: answer.agentId,
				agentSettings: toAgentSettings(answer.model),
				baseRef: card.baseRef,
			},
		});
		if (!created.ok) {
			return { outcome: "none", note: `creating the QA card failed: ${created.error}` };
		}
		const entry: QaGateEntry = {
			reviewsTaskId: card.id,
			round,
			snapshot: qaSnapshot.commit,
			snapshotRef: qaSnapshot.ref,
			outboxDir,
			scratchDir,
			baseRef: card.baseRef,
			agentId: answer.agentId,
			model: answer.model,
			devAgentId: dev.agentId,
			devModel: dev.model,
			route: answer.route,
			status: "queued",
			createdAt: context.now,
			startedAt: null,
			reviewSeenAt: null,
			nudges: 0,
			timedOutAt: null,
			ingestedAt: null,
			verdict: null,
			trashed: false,
			supersededAt: null,
			checks: checksOutcome,
		};
		await deps.store.update(workspaceId, (current) => {
			// The wait is over; a later QA of the same snapshot (a redone turn) waits afresh if it has to.
			const { qaChecksWait: _wait, ...dev } = current.cards[card.id] ?? {};
			return {
				...current,
				cards: {
					...current.cards,
					[card.id]: { ...dev, qaCreated: qaSnapshot.commit, qaCard: qaTaskId },
					[qaTaskId]: { ...(current.cards[qaTaskId] ?? {}), qaGate: entry },
				},
			};
		});
		const checksNote = describeQaChecksOutcome(checksOutcome);
		deps.log(
			`qa ${card.id}: created QA card ${qaTaskId} (round ${round}) for snapshot ${short}${checksNote ? ` with ${checksNote}` : ""}; queued`,
		);
		return { outcome: "acted", note: describeCreated(qaTaskId, entry, short) };
	};

	const submit: QaGate["submit"] = async (input) => {
		const { context, card, session } = input;
		if (!isReviewSettled(session, context.now, context.snapshot.reviewSettleMs)) {
			return { outcome: "none", note: describeUnsettledReview(session) };
		}
		const { reviewer, notes } = await supersedeDeadReviewers(context, card);
		if (reviewer) {
			return { outcome: "none", note: `${reviewer} already reviews this card` };
		}
		const queued = await queueQa(input);
		return notes.length === 0 ? queued : { outcome: "acted", note: `${notes.join("; ")}; ${queued.note}` };
	};

	const recordVerdict = async (
		context: QaGateContext,
		qaTaskId: string,
		entry: QaGateEntry,
		fileVerdict: QaVerdict,
		pipelineNote: string | null,
	): Promise<string> => {
		const workspaceId = context.snapshot.workspaceId;
		const ruled = applyQaVerdictRules(fileVerdict);
		const verdict = ruled.verdict;
		const note = [pipelineNote, ruled.changed].filter(Boolean).join("; ") || null;
		const artifactsDir = join(artifactsPathOf(workspaceId), entry.reviewsTaskId, `r${entry.round}`);
		// State first: a worker that dies halfway through never records the same verdict twice.
		const at = context.now;
		const verdictRecord: QaVerdictRecord = {
			qaTaskId,
			round: entry.round,
			snapshot: entry.snapshot,
			verdict: verdict.verdict,
			blocking: verdict.blocking.map((item) => item.slice(0, 2000)),
			notes: verdict.notes.slice(0, 2000),
			scores: verdict.scores,
			visual: verdict.visual,
			artifactsDir,
			at,
		};
		await deps.store.update(workspaceId, (state) => {
			const devEntry = state.cards[entry.reviewsTaskId] ?? {};
			const qaEntry = state.cards[qaTaskId] ?? {};
			return {
				...state,
				cards: {
					...state.cards,
					[entry.reviewsTaskId]: { ...devEntry, qaVerdicts: [...readQaVerdictRecords(devEntry), verdictRecord] },
					[qaTaskId]: {
						...qaEntry,
						qaGate: { ...entry, status: "ingested", ingestedAt: at, verdict: verdict.verdict },
					},
				},
			};
		});
		try {
			await copyArtifacts(entry.outboxDir, artifactsDir);
		} catch (error) {
			deps.log(
				`qa-ingest ${qaTaskId}: copying ${entry.outboxDir} to ${artifactsDir} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const section = formatQaLogSection({
			devTaskId: entry.reviewsTaskId,
			round: entry.round,
			verdict,
			at,
			dev: { agentId: entry.devAgentId, model: entry.devModel },
			reviewer: { qaTaskId, agentId: entry.agentId, model: entry.model },
			artifactsDir,
			verdictPath: getQaVerdictPath(entry.outboxDir),
			pipelineNote: note,
		});
		await deps.appendQaLog(workspaceId, `\n${section.trim()}\n`);
		const stopped = await deps
			.stopScratchProcesses([entry.scratchDir, `${entry.scratchDir}-${entry.baseRef}`])
			.catch(() => 0);
		await deps.bus.emit("verdictRecorded", {
			workspaceId,
			taskId: entry.reviewsTaskId,
			at,
			qaTaskId,
			verdict: {
				verdict: verdict.verdict,
				round: entry.round,
				blocking: verdict.blocking,
				notes: verdict.notes,
			},
			devAgentId: entry.devAgentId as RuntimeAgentId,
			devModel: entry.devModel,
			qaAgentId: entry.agentId as RuntimeAgentId,
			qaModel: entry.model,
		});
		return `${entry.reviewsTaskId} round ${entry.round}: ${verdict.verdict} recorded${note ? ` (${note})` : ""}${stopped > 0 ? `; stopped ${stopped} scratch process(es)` : ""}`;
	};

	const trashQaCard = async (context: QaGateContext, qaTaskId: string): Promise<string> => {
		// A QA card has no work of its own to land: the Done workflow passes it through, and "discard" makes sure.
		const done = await deps
			.finishTask({
				workspaceId: context.snapshot.workspaceId,
				taskId: qaTaskId,
				landing: "discard",
				trigger: "pipeline",
			})
			.catch((error: unknown) => ({
				ok: false,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			}));
		if (done.ok || done.status === "already_done") {
			await updateQaEntry(context.snapshot.workspaceId, qaTaskId, { trashed: true });
			return "QA card → Done";
		}
		return `moving the QA card to Done failed (${done.error ?? done.status}); retried next pass`;
	};

	const ingest = async (context: QaGateContext, qaTaskId: string, entry: QaGateEntry): Promise<string | null> => {
		const workspaceId = context.snapshot.workspaceId;
		if (entry.status === "ingested") {
			return entry.trashed ? null : await trashQaCard(context, qaTaskId);
		}
		const read = await deps.readVerdict(entry.outboxDir);
		if (read.kind === "ok") {
			const recorded = await recordVerdict(context, qaTaskId, entry, read.verdict, null);
			return `${recorded}; ${await trashQaCard(context, qaTaskId)}`;
		}
		const seenAt = entry.reviewSeenAt ?? context.now;
		if (entry.reviewSeenAt === null) {
			await updateQaEntry(workspaceId, qaTaskId, { reviewSeenAt: seenAt });
		}
		if (context.now - seenAt < context.qa.verdictGraceSec * 1000) {
			return null;
		}
		if (entry.nudges < context.qa.maxNudges) {
			const nudges = entry.nudges + 1;
			const sent = await deps.deliverInput({
				workspaceId,
				taskId: qaTaskId,
				text: buildQaVerdictNudge(entry.outboxDir, read, kanbanHomeOf()),
			});
			if (sent.ok) {
				await updateQaEntry(workspaceId, qaTaskId, { nudges, reviewSeenAt: null });
				return `no usable verdict.json${read.kind === "invalid" ? ` (${read.error})` : ""}; nudged (${nudges}/${context.qa.maxNudges})`;
			}
			deps.log(`qa-ingest ${qaTaskId}: nudge ${nudges} not delivered (${sent.error}); recording STALLED`);
		}
		const reason =
			read.kind === "invalid"
				? `QA agent stopped with an unusable verdict.json (${read.error})`
				: "QA agent stopped without a verdict.json";
		const recorded = await recordVerdict(
			context,
			qaTaskId,
			entry,
			createStalledQaVerdict(reason),
			`${entry.nudges} nudge(s) used`,
		);
		return `${recorded}; ${await trashQaCard(context, qaTaskId)}`;
	};

	/**
	 * Each dev card in Review whose newest verdict is a PASS for its current snapshot is acted on once (`qaPass` on
	 * its entry): the kit's `onPass` (decideOnPass) may hold it; otherwise the Done workflow lands it (trigger
	 * `pipeline`). A land that fails (a conflict) is recorded and not retried: FAIL handling is the rework stage's.
	 * A PASS for an older snapshot (the card changed after QA) is skipped; the new snapshot gets its own QA.
	 * A held card is never landed here (only releaseHold does that), but a newer PASS (it was reworked after the hold)
	 * refreshes its hold, so the runoff compares the PASS of its current snapshot.
	 */
	const actOnPasses = async (
		context: QaGateContext,
		sessions: Map<string, PipelineSessionView>,
	): Promise<PipelineDecisionRecord[]> => {
		const { snapshot } = context;
		const workspaceId = snapshot.workspaceId;
		const records: PipelineDecisionRecord[] = [];
		const state = await deps.store.load(workspaceId);
		const review = snapshot.board.columns.find((column) => column.id === "review")?.cards ?? [];
		for (const card of review) {
			const entry = state.cards[card.id];
			const latest = readQaVerdictRecords(entry).at(-1);
			if (!latest || latest.verdict !== "PASS" || readQaPassEntry(entry)?.qaTaskId === latest.qaTaskId) {
				continue;
			}
			const session = sessions.get(card.id) ?? null;
			// An escalated card never lands on a PASS: a sibling may have taken its task over (engine.ts readEscalatedAt).
			// A held card is not skipped: a newer PASS refreshes its hold (below), so the runoff compares the PASS of its
			// current snapshot.
			if (
				resolveCardRole(card) !== "dev" ||
				!isReviewSettled(session, context.now, snapshot.reviewSettleMs) ||
				readEscalatedAt(entry)
			) {
				continue;
			}
			const heldFor = readPipelineHold(entry)?.group ?? null;
			const markHandled = async (pass: Omit<QaPassEntry, "qaTaskId" | "snapshot" | "at">): Promise<void> => {
				const value: QaPassEntry = {
					qaTaskId: latest.qaTaskId,
					snapshot: latest.snapshot,
					at: context.now,
					...pass,
				};
				await updateCard(workspaceId, card.id, (current) => ({ ...current, qaPass: value }));
			};
			const current = await readSnapshot(snapshot.workspacePath, card.id);
			if (current !== latest.snapshot) {
				await markHandled({ action: "stale", status: null, error: null });
				records.push(
					record(
						context,
						card.id,
						"qa_pass",
						`PASS of round ${latest.round} was for snapshot ${latest.snapshot.slice(0, 8)}; the card changed since (${current?.slice(0, 8) ?? "no snapshot"}), so it is not landed`,
					),
				);
				continue;
			}
			const { effective } = toEffectiveCard({
				card,
				session,
				workspaceId,
				selectedAgentId: snapshot.selectedAgentId,
				agentDefaultModels: context.agentDefaultModels,
			});
			let answer: OnPassAnswer;
			try {
				answer = await decideOnPass({
					store: deps.store,
					policy: context.policy,
					dev: effective,
					verdict: { verdict: "PASS", round: latest.round, blocking: latest.blocking, notes: latest.notes },
					now: context.now,
					featureAnswer: context.featureOnPass,
				});
			} catch (error) {
				// Not marked handled: asked again on the next evaluation.
				deps.log(
					`qa-gate ${card.id}: PASS of round ${latest.round} left for the next evaluation: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}
			if (heldFor && answer.action === "land") {
				await markHandled({ action: "hold", status: null, error: null });
				records.push(
					record(
						context,
						card.id,
						"qa_pass",
						`PASS of round ${latest.round}: the card is still held for ${heldFor}; only releaseHold lands or discards it`,
					),
				);
				continue;
			}
			if (answer.action === "hold") {
				await markHandled({ action: "hold", status: null, error: null });
				records.push(record(context, card.id, "qa_pass", `PASS of round ${latest.round} held for ${answer.group}`));
				continue;
			}
			const result = await deps
				.finishTask({ workspaceId, taskId: card.id, landing: "land", trigger: "pipeline" })
				.catch((error: unknown) => ({
					ok: false,
					status: "failed" as const,
					error: error instanceof Error ? error.message : String(error),
				}));
			await markHandled({
				action: "land",
				status: result.status,
				error: result.ok ? null : (result.error ?? null),
				landing: "landing" in result ? (result.landing ?? null) : null,
			});
			records.push(
				record(
					context,
					card.id,
					"qa_pass",
					result.ok
						? `PASS of round ${latest.round}: landed and Done (${result.status})`
						: `PASS of round ${latest.round}: landing failed (${result.status}: ${result.error ?? "no reason given"}); left in Review`,
				),
			);
		}
		return records;
	};

	/**
	 * QA cards made before recovery resent their dev card's turn (a nudge, a provider-error retry, /clear + the
	 * prompt, a restart resume: `recoverySentAt`) review a snapshot the redone turn replaces. Each one is marked
	 * `superseded` (so it is never started, ingested or counted for a slot) and goes to Done unlanded, which also
	 * stops it if it runs; the dev card's `qaCreated` goes, so its next settled Review gets a QA card of its own even
	 * when the redone turn left the same tree. A Done that fails is retried on the next tick.
	 */
	const supersedeResentTurns = async (context: QaGateContext): Promise<PipelineDecisionRecord[]> => {
		const workspaceId = context.snapshot.workspaceId;
		const state = await deps.store.load(workspaceId);
		const records: PipelineDecisionRecord[] = [];
		for (const [qaTaskId, rawEntry] of Object.entries(state.cards)) {
			const entry = readQaGateEntry(rawEntry);
			if (!entry || entry.trashed || entry.status === "ingested") {
				continue;
			}
			if (entry.status === "superseded") {
				// Deleted from the board: there is nothing to move to Done.
				if (
					findColumn(context.snapshot, qaTaskId) === null &&
					context.now - entry.createdAt > QA_CARD_MISSING_GRACE_MS
				) {
					await updateQaEntry(workspaceId, qaTaskId, { trashed: true });
					records.push(record(context, qaTaskId, "qa_start", "superseded QA card: no longer on the board"));
					continue;
				}
				records.push(
					record(context, qaTaskId, "qa_start", `superseded QA card: ${await trashQaCard(context, qaTaskId)}`),
				);
				continue;
			}
			const sentAt = readRecoveryFlow(state.cards[entry.reviewsTaskId]).recoverySentAt;
			const sent = sentAt ? Date.parse(sentAt) : Number.NaN;
			if (!Number.isFinite(sent) || sent <= entry.createdAt) {
				continue;
			}
			const stopped = await markSuperseded(context, qaTaskId, entry);
			const was =
				entry.status === "running"
					? `running; stopped${stopped > 0 ? `, with ${stopped} scratch process(es)` : ""}`
					: "queued; not started";
			records.push(
				record(
					context,
					qaTaskId,
					"qa_start",
					`superseded: recovery resent ${entry.reviewsTaskId}'s turn at ${sentAt}, after this QA card of round ${entry.round} for snapshot ${entry.snapshot.slice(0, 8)} (${was}); the next settled Review gets a new snapshot and QA card; ${await trashQaCard(context, qaTaskId)}`,
				),
			);
		}
		return records;
	};

	/**
	 * QA cards that can't give a verdict any more (describeDeadQaCard) are superseded on every tick too, not only when
	 * their dev card is submitted: a dead QA card would otherwise hold its QA slot until `timeoutMin` (after a restart
	 * every slot), or wait for good when its dev card has left Review. supersedeResentTurns then moves them to Done.
	 */
	const supersedeDeadQaCards = async (context: QaGateContext): Promise<PipelineDecisionRecord[]> => {
		const state = await deps.store.load(context.snapshot.workspaceId);
		const records: PipelineDecisionRecord[] = [];
		for (const [qaTaskId, rawEntry] of Object.entries(state.cards)) {
			const entry = readQaGateEntry(rawEntry);
			const dead = entry && !entry.trashed ? deadReasonOf(context, state, qaTaskId, entry) : null;
			if (entry && dead) {
				records.push(
					record(context, qaTaskId, "qa_start", await supersedeDeadQaCard(context, qaTaskId, entry, dead)),
				);
			}
		}
		// One line per evaluation, the submits' retirements included: after a restart (or the first start of this build)
		// many go at once.
		const retired = retiredByWorkspace.get(context.snapshot.workspaceId) ?? [];
		retiredByWorkspace.delete(context.snapshot.workspaceId);
		if (retired.length > 0) {
			records.unshift(
				record(
					context,
					null,
					"qa_start",
					`retired ${retired.length} QA card(s) that can no longer give a verdict: ${retired.join(", ")}; each verdict already written is recorded, the rest are superseded and their dev cards get new QA cards for the same snapshots`,
				),
			);
		}
		return records;
	};

	const tick: QaGate["tick"] = async (context) => {
		const { snapshot, qa } = context;
		const workspaceId = snapshot.workspaceId;
		const records: PipelineDecisionRecord[] = [];
		const sessions = new Map(snapshot.sessions.map((session) => [session.taskId, session]));
		records.push(...(await supersedeDeadQaCards(context)));
		records.push(...(await supersedeResentTurns(context)));
		let state = await deps.store.load(workspaceId);

		// Ingest: our QA cards whose turn has ended.
		for (const [qaTaskId, rawEntry] of Object.entries(state.cards)) {
			const entry = readQaGateEntry(rawEntry);
			if (!entry || findColumn(snapshot, qaTaskId) !== "review") {
				continue;
			}
			// Superseded: dropped, never ingested (supersedeResentTurns moves it to Done); a dead one with a verdict was
			// recorded when it was retired (supersedeDeadQaCard).
			if ((entry.status === "ingested" && entry.trashed) || entry.status === "superseded") {
				continue;
			}
			// A QA card whose turn ended moments ago may still be writing its verdict.
			if (!isReviewSettled(sessions.get(qaTaskId), context.now, snapshot.reviewSettleMs)) {
				continue;
			}
			const note = await ingest(context, qaTaskId, entry);
			if (note) {
				records.push(record(context, qaTaskId, "qa_ingest", note));
			}
		}

		// PASS: the kit's onPass (decideOnPass records a hold), then land through the Done workflow.
		records.push(...(await actOnPasses(context, sessions)));

		// Slots: running QA cards (In Progress, or in Review and not ingested yet), unless timed out.
		state = await deps.store.load(workspaceId);
		const entries = Object.entries(state.cards).flatMap(([qaTaskId, raw]) => {
			const entry = readQaGateEntry(raw);
			return entry ? [{ qaTaskId, entry }] : [];
		});
		let running = 0;
		for (const { qaTaskId, entry } of entries) {
			if (entry.status !== "running" || entry.timedOutAt !== null) {
				continue;
			}
			const column = findColumn(snapshot, qaTaskId);
			if (column !== "in_progress" && column !== "review") {
				continue;
			}
			if (entry.startedAt !== null && context.now - entry.startedAt > qa.timeoutMin * 60_000) {
				await updateQaEntry(workspaceId, qaTaskId, { timedOutAt: context.now });
				records.push(
					record(context, qaTaskId, "qa_start", `still running after ${qa.timeoutMin} min; its QA slot is freed`),
				);
				continue;
			}
			running += 1;
		}
		runningByWorkspace.set(workspaceId, running);

		// Pump: oldest queued first, machine-wide slots. None start under PID pressure (one record per hold).
		const queued = entries
			.filter(({ entry }) => entry.status === "queued")
			.sort((left, right) => left.entry.createdAt - right.entry.createdAt);
		const preview = context.kit.qa?.preview ?? null;
		const waiting = queued.filter(({ qaTaskId }) => findColumn(snapshot, qaTaskId) === "backlog");
		const pressureHeld = Boolean(snapshot.pidPressure) && waiting.length > 0;
		if (!pressureHeld) {
			pressureHolds.delete(workspaceId);
		} else if (!pressureHolds.has(workspaceId)) {
			pressureHolds.add(workspaceId);
			deps.log(`qa ${workspaceId}: PID pressure; holding ${waiting.length} QA card(s) until it clears`);
			records.push({
				...record(
					context,
					null,
					"qa_start",
					`PID pressure: holding ${waiting.length} queued QA card(s) (${waiting.map(({ qaTaskId }) => qaTaskId).join(", ")}) until it clears`,
				),
				outcome: "none",
			});
		}
		for (const { qaTaskId, entry } of pressureHeld ? [] : queued) {
			const totalRunning = [...runningByWorkspace.values()].reduce((sum, count) => sum + count, 0);
			if (totalRunning >= qa.slots) {
				break;
			}
			const column = findColumn(snapshot, qaTaskId);
			if (column !== "backlog") {
				// Not created on the board yet (the snapshot predates it), or moved by hand: leave it alone.
				continue;
			}
			if (findColumn(snapshot, entry.reviewsTaskId) === "in_progress") {
				continue;
			}
			if (preview) {
				await deps.preview.ensure({ workspaceId, repoPath: snapshot.workspacePath, preview });
			}
			const started = await deps.actions.run({
				kind: "startTask",
				workspaceId,
				workspacePath: snapshot.workspacePath,
				taskId: qaTaskId,
			});
			if (!started.ok) {
				records.push(record(context, qaTaskId, "qa_start", `starting the QA card failed: ${started.error}`));
				continue;
			}
			await updateQaEntry(workspaceId, qaTaskId, { status: "running", startedAt: context.now });
			running += 1;
			runningByWorkspace.set(workspaceId, running);
			records.push(
				record(
					context,
					qaTaskId,
					"qa_start",
					`started QA of ${entry.reviewsTaskId} round ${entry.round} (slot ${totalRunning + 1}/${qa.slots})`,
				),
			);
		}

		const qaActive = entries.some(
			({ qaTaskId, entry }) =>
				(entry.status === "queued" && findColumn(snapshot, qaTaskId) === "backlog") ||
				(entry.status === "running" && entry.timedOutAt === null),
		);
		await deps.preview.stopIfIdle({
			workspaceId,
			repoPath: snapshot.workspacePath,
			preview,
			qaActive,
			idleMin: qa.previewIdleMin,
		});
		return records;
	};

	return {
		submit,
		tick,
		forget: (workspaceId) => {
			runningByWorkspace.delete(workspaceId);
			pressureHolds.delete(workspaceId);
			retiredByWorkspace.delete(workspaceId);
		},
	};
}
