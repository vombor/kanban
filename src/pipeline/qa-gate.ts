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
// - no QA card is created or started while the snapshot says `pidPressure` (pumpQa's pid-pressure hold: zombies
//   filling pids.max wiped a board, 10/05), logged once per hold; ingest and PASS landing go on.
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
	status: z.enum(["queued", "running", "ingested"]),
	createdAt: z.number(),
	startedAt: z.number().nullable().default(null),
	/** When the gate first saw the card in Review in this attempt (the verdict grace runs from here). */
	reviewSeenAt: z.number().nullable().default(null),
	nudges: z.number().int().nonnegative().default(0),
	timedOutAt: z.number().nullable().default(null),
	ingestedAt: z.number().nullable().default(null),
	verdict: z.string().nullable().default(null),
	trashed: z.boolean().default(false),
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

/** The same note on every evaluation, so the decision log has the creation once. */
function describeCreated(qaTaskId: string, entry: QaGateEntry | null, shortSnapshot: string): string {
	const details = entry ? ` (round ${entry.round}, ${entry.agentId} on ${describeModel(entry.model)})` : "";
	return `QA card ${qaTaskId} was created for snapshot ${shortSnapshot}${details}`;
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
	const kanbanHomeOf = deps.getKanbanHome ?? (() => getKanbanHomeDisplayPath());
	/** workspaceId → QA cards running there, for the machine-wide slot count. */
	const runningByWorkspace = new Map<string, number>();
	/** Workspaces whose queued QA cards are held for PID pressure (already logged). */
	const pressureHolds = new Set<string>();

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

	const submit: QaGate["submit"] = async ({ context, card, session, dev, answer }) => {
		const { snapshot } = context;
		const workspaceId = snapshot.workspaceId;
		if (!isReviewSettled(session, context.now, snapshot.reviewSettleMs)) {
			return { outcome: "none", note: describeUnsettledReview(session) };
		}
		const reviewer = listCards(snapshot).find(
			({ columnId, card: other }) =>
				columnId !== "trash" &&
				other.id !== card.id &&
				resolveCardRole(other) === "qa" &&
				resolveReviewedTaskId(other) === card.id,
		);
		if (reviewer) {
			return {
				outcome: "none",
				note: `QA card ${reviewer.card.id} (${reviewer.columnId}) already reviews this card`,
			};
		}
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
			return { outcome: "acted", note: describeCreated(qaTaskId, readQaGateEntry(state.cards[qaTaskId]), short) };
		}
		if (readQaVerdictRecords(devEntry).some((verdict) => verdict.snapshot === qaSnapshot.commit)) {
			return { outcome: "none", note: `snapshot ${short} already has a QA verdict` };
		}
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
		};
		await deps.store.update(workspaceId, (current) => ({
			...current,
			cards: {
				...current.cards,
				[card.id]: { ...(current.cards[card.id] ?? {}), qaCreated: qaSnapshot.commit, qaCard: qaTaskId },
				[qaTaskId]: { ...(current.cards[qaTaskId] ?? {}), qaGate: entry },
			},
		}));
		deps.log(`qa ${card.id}: created QA card ${qaTaskId} (round ${round}) for snapshot ${short}; queued`);
		return { outcome: "acted", note: describeCreated(qaTaskId, entry, short) };
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

	const tick: QaGate["tick"] = async (context) => {
		const { snapshot, qa } = context;
		const workspaceId = snapshot.workspaceId;
		const records: PipelineDecisionRecord[] = [];
		const sessions = new Map(snapshot.sessions.map((session) => [session.taskId, session]));
		let state = await deps.store.load(workspaceId);

		// Ingest: our QA cards whose turn has ended.
		for (const [qaTaskId, rawEntry] of Object.entries(state.cards)) {
			const entry = readQaGateEntry(rawEntry);
			if (!entry || findColumn(snapshot, qaTaskId) !== "review") {
				continue;
			}
			if (entry.status === "ingested" && entry.trashed) {
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
		},
	};
}
