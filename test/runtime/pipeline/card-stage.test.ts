// The board's pipeline card stages (issue #30): foo's 8c28e sat in Review for 11 minutes while its checks ran, with
// nothing on the card, and was landed by hand without QA. Each test gives describePipelineCardStages what the worker
// has after an evaluation and checks the badge a card gets.
import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardColumnId } from "../../../src/core/api-contract";
import {
	describePipelineCardStages,
	findDetailTimes,
	type PipelineCardStagesInput,
} from "../../../src/pipeline/card-stage";
import type { PipelineCardOutcome } from "../../../src/pipeline/engine";
import { PIPELINE_STATE_VERSION, type PipelineCardState } from "../../../src/pipeline/pipeline-state";
import type { QaGateEntry, QaQueueWait } from "../../../src/pipeline/qa-gate";
import { createCard } from "../../utilities/workspace-state-store";

const NOW = Date.parse("2026-10-11T06:50:00.000Z");
const SINCE = Date.parse("2026-10-11T06:43:23.000Z");
const DEV = createCard({ id: "8c28e" });
const SNAPSHOT = "885ac393aaaa";
const SUBMITTED: PipelineCardOutcome = { kind: "submitted", snapshot: SNAPSHOT, qa: true, reason: null };
const QA_CARD = createCard({ id: "12ab6", role: "qa" });

function qaEntry(overrides: Partial<QaGateEntry> = {}): QaGateEntry {
	return {
		reviewsTaskId: DEV.id,
		round: 2,
		snapshot: SNAPSHOT,
		snapshotRef: `refs/kanban/snapshots/${DEV.id}`,
		outboxDir: "/tmp/outbox/12ab6",
		scratchDir: "/tmp/scratch/8c28e",
		baseRef: "main",
		agentId: "claude",
		model: null,
		devAgentId: "codex",
		devModel: null,
		route: null,
		status: "queued",
		createdAt: NOW - 60_000,
		startedAt: null,
		reviewSeenAt: null,
		nudges: 0,
		timedOutAt: null,
		ingestedAt: null,
		verdict: null,
		trashed: false,
		supersededAt: null,
		checks: "PASS",
		...overrides,
	};
}

function describeStages(input: {
	column?: RuntimeBoardColumnId;
	card?: RuntimeBoardCard;
	cards?: Record<string, PipelineCardState>;
	outcome?: PipelineCardOutcome | null;
	checks?: PipelineCardStagesInput["checks"];
	queueWaits?: Map<string, QaQueueWait>;
	pidPressure?: boolean;
	/** Other cards on the board (a QA card), by column. */
	others?: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>;
}) {
	const card = input.card ?? DEV;
	const column = input.column ?? "review";
	const columnIds: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "trash"];
	return describePipelineCardStages({
		columns: columnIds.map((id) => ({
			id,
			cards: [...(id === column ? [card] : []), ...(input.others?.[id] ?? [])],
		})),
		sessions: [],
		state: {
			version: PIPELINE_STATE_VERSION,
			since: "2026-10-01T00:00:00.000Z",
			importedFrom: null,
			cards: input.cards ?? {},
		},
		outcomes: new Map(input.outcome === null ? [] : [[card.id, input.outcome ?? SUBMITTED]]),
		checks: input.checks ?? { running: null, queued: [] },
		workspaceId: "foo",
		queueWaits: input.queueWaits ?? new Map(),
		checksWaitMin: 20,
		recoveryNudgeCheckMs: 90_000,
		pidPressure: input.pidPressure ?? false,
		now: NOW,
	});
}

const WAITING_FOR_CHECKS: Record<string, PipelineCardState> = {
	[DEV.id]: { qaChecksWait: { snapshot: SNAPSHOT, since: SINCE } },
};

describe("describePipelineCardStages", () => {
	it("shows running checks with their step, QA next and the checks wait's deadline (foo 8c28e)", () => {
		expect(
			describeStages({
				cards: WAITING_FOR_CHECKS,
				checks: {
					running: { workspaceId: "foo", taskId: DEV.id, snapshot: SNAPSHOT, step: "test", startedAt: SINCE },
					queued: [],
				},
			}),
		).toEqual([
			{
				taskId: DEV.id,
				kind: "checks_running",
				label: "Checks running (test)",
				next: "QA next",
				qaTaskId: null,
				deadline: Date.parse("2026-10-11T07:03:23.000Z"),
				detail: null,
				detailTimes: [],
				inFlight: true,
			},
		]);
	});

	it("counts the cards ahead of queued checks, other projects' included, and never takes another project's run", () => {
		const [stage] = describeStages({
			cards: WAITING_FOR_CHECKS,
			checks: {
				running: { workspaceId: "notes", taskId: DEV.id, snapshot: "other", step: "install", startedAt: SINCE },
				queued: [
					{ workspaceId: "foo", taskId: "aaaaa", snapshot: "a" },
					{ workspaceId: "foo", taskId: DEV.id, snapshot: SNAPSHOT },
				],
			},
		});
		expect(stage).toMatchObject({
			kind: "checks_queued",
			label: "Checks queued",
			detail: "2 card(s) ahead in the machine-wide checks queue",
			inFlight: true,
		});
	});

	it("waits for checks the runner doesn't have yet until the deadline", () => {
		expect(describeStages({ cards: WAITING_FOR_CHECKS })[0]).toMatchObject({
			kind: "qa_waiting_checks",
			label: "Waiting for checks",
			deadline: Date.parse("2026-10-11T07:03:23.000Z"),
			inFlight: true,
		});
	});

	it("names the QA card and why it waits for a slot", () => {
		const [stage] = describeStages({
			cards: { [DEV.id]: { qaCreated: SNAPSHOT, qaCard: "12ab6" }, "12ab6": { qaGate: qaEntry() } },
			queueWaits: new Map([
				["12ab6", { kind: "slot", provider: null, note: "waiting for a QA slot: 2/2 cloud slot(s) taken" }],
			]),
		});
		expect(stage).toMatchObject({
			kind: "qa_queued",
			label: "Waiting for QA slot",
			next: "QA r2",
			qaTaskId: "12ab6",
			detail: "waiting for a QA slot: 2/2 cloud slot(s) taken",
			inFlight: true,
		});
	});

	it("shows a running QA card with its round", () => {
		const [stage] = describeStages({
			cards: {
				[DEV.id]: { qaCreated: SNAPSHOT, qaCard: "12ab6" },
				"12ab6": { qaGate: qaEntry({ status: "running", startedAt: NOW - 30_000 }) },
			},
			others: { in_progress: [QA_CARD] },
		});
		expect(stage).toMatchObject({ kind: "qa_running", label: "QA r2 running", qaTaskId: "12ab6", inFlight: true });
	});

	it("keeps showing the QA card running after its slot was freed, and while it waits in Review for ingestion (issue #33)", () => {
		const cards = {
			[DEV.id]: { qaCreated: SNAPSHOT, qaCard: "12ab6" },
			"12ab6": {
				qaGate: qaEntry({ status: "running", startedAt: NOW - 70 * 60_000, timedOutAt: NOW - 10 * 60_000 }),
			},
		};
		const running = { kind: "qa_running", label: "QA r2 running", qaTaskId: "12ab6", inFlight: true };
		expect(describeStages({ cards, others: { in_progress: [QA_CARD] } })[0]).toMatchObject(running);
		expect(describeStages({ cards, others: { review: [QA_CARD] } })[0]).toMatchObject(running);
		// One that went to Done without its verdict is not running (the gate supersedes it).
		expect(describeStages({ cards, others: { trash: [QA_CARD] } })[0]).toMatchObject({ kind: "qa_next" });
	});

	it("shows the snapshot's verdict and what follows it, not in flight", () => {
		const verdict = {
			qaTaskId: "12ab6",
			round: 2,
			snapshot: SNAPSHOT,
			verdict: "FAIL",
			blocking: ["the login test fails"],
			notes: "",
			scores: {},
			visual: null,
			artifactsDir: null,
			at: NOW,
		};
		const cards = {
			[DEV.id]: { qaCreated: SNAPSHOT, qaCard: "12ab6", qaVerdicts: [verdict] },
			"12ab6": { qaGate: qaEntry({ status: "ingested", verdict: "FAIL" }) },
		};
		expect(describeStages({ cards })[0]).toMatchObject({
			kind: "qa_verdict",
			label: "QA r2 FAIL",
			next: "rework next",
			detail: "the login test fails",
			inFlight: false,
		});
		const passed = {
			...cards,
			[DEV.id]: {
				...cards[DEV.id],
				qaVerdicts: [{ ...verdict, verdict: "PASS", blocking: [] }],
				qaPass: {
					qaTaskId: "12ab6",
					snapshot: SNAPSHOT,
					at: NOW,
					action: "land",
					status: "ok",
					error: null,
					landing: { decision: "conflict", files: ["a.ts"] },
				},
			},
		};
		expect(describeStages({ cards: passed })[0]).toMatchObject({
			label: "QA r2 PASS",
			next: "land conflict · rework next",
			inFlight: false,
		});
		// Ingested, its land not answered yet (readPendingQaPass): landing, in flight.
		const landing = { ...cards, [DEV.id]: { ...passed[DEV.id], qaPass: undefined } };
		expect(describeStages({ cards: landing })[0]).toMatchObject({
			label: "QA r2 PASS",
			next: "landing",
			inFlight: true,
		});
	});

	it("says QA is next once the checks are recorded and no QA card exists yet", () => {
		expect(describeStages({})[0]).toMatchObject({ kind: "qa_next", label: "QA next", inFlight: true });
	});

	it("says when the kit wants no QA, and that running checks lead to Approve & land", () => {
		const outcome: PipelineCardOutcome = { kind: "submitted", snapshot: SNAPSHOT, qa: false, reason: "plan card" };
		expect(describeStages({ outcome })[0]).toMatchObject({
			kind: "no_qa",
			label: "No QA",
			next: "Approve & land",
			detail: "plan card",
			inFlight: false,
		});
		expect(
			describeStages({
				outcome,
				checks: {
					running: { workspaceId: "foo", taskId: DEV.id, snapshot: SNAPSHOT, step: "lint", startedAt: SINCE },
					queued: [],
				},
			})[0],
		).toMatchObject({ kind: "checks_running", next: "Approve & land", inFlight: true });
	});

	it("shows settling, escalations, stops, recovery holds and runoff holds", () => {
		expect(describeStages({ outcome: { kind: "unsettled", running: false } })[0]).toMatchObject({
			kind: "settling",
			label: "Settling",
		});
		expect(
			describeStages({
				cards: { [DEV.id]: { qaflow: { escalated: { at: "2026-10-11T06:00:00.000Z", reason: "3 FAIL rounds" } } } },
			})[0],
		).toMatchObject({ kind: "escalated", label: "Escalated", next: "waits for handback", detail: "3 FAIL rounds" });
		expect(
			describeStages({ cards: { [DEV.id]: { qaflow: { stopped: { at: "x", reason: "kit said stop" } } } } })[0],
		).toMatchObject({ kind: "stopped", detail: "kit said stop" });
		expect(
			describeStages({ cards: { [DEV.id]: { qaflow: { retryAt: "2026-10-11T07:00:00.000Z" } } } })[0],
		).toMatchObject({
			kind: "recovery",
			detail: "provider-error retry due at 2026-10-11T07:00:00.000Z",
			detailTimes: [{ text: "2026-10-11T07:00:00.000Z", at: Date.parse("2026-10-11T07:00:00.000Z") }],
		});
		expect(
			describeStages({
				cards: { [DEV.id]: { hold: { group: "r1", at: "2026-10-11T06:00:00.000Z", round: 1 } } },
			})[0],
		).toMatchObject({
			kind: "held",
			label: "Held",
			detail: "held for r1 since 2026-10-11T06:00:00.000Z",
			detailTimes: [{ text: "2026-10-11T06:00:00.000Z", at: Date.parse("2026-10-11T06:00:00.000Z") }],
		});
	});

	it("shows a sent rework on an In Progress card until it returns", () => {
		const rework = {
			round: 1,
			next: 2,
			at: "2026-10-11T06:36:00.000Z",
			snapshot: "old",
			kind: "fail",
			via: "chat",
			agentId: "codex",
			model: { provider: null, model: "us.openai.gpt-6.1-sol" },
			clearedContext: false,
		};
		const cards = { [DEV.id]: { qaflow: { reworks: [rework] } } };
		expect(describeStages({ column: "in_progress", cards, outcome: null })[0]).toMatchObject({
			kind: "rework_sent",
			label: "Rework sent",
			next: "QA r2 next",
			inFlight: false,
			detailTimes: [{ text: "2026-10-11T06:36:00.000Z", at: Date.parse("2026-10-11T06:36:00.000Z") }],
		});
		const returned = { [DEV.id]: { qaflow: { reworks: [{ ...rework, returned: "2026-10-11T06:43:00.000Z" }] } } };
		expect(describeStages({ column: "in_progress", cards: returned, outcome: null })).toEqual([]);
	});

	it("leaves QA cards, auto-review cards, cards with nothing pending and other columns alone", () => {
		const qaCard = createCard({ id: "12ab6", role: "qa", reviewsTaskId: DEV.id });
		expect(describeStages({ card: qaCard })).toEqual([]);
		const autoReview = createCard({ id: "c0ffe", autoReviewEnabled: true, autoReviewMode: "commit" });
		expect(describeStages({ card: autoReview })).toEqual([]);
		expect(describeStages({ outcome: { kind: "no_work" } })).toEqual([]);
		expect(describeStages({ outcome: null })).toEqual([]);
		expect(describeStages({ column: "backlog" })).toEqual([]);
	});
});

describe("findDetailTimes", () => {
	it("lists every instant a detail embeds, as written there, for the browser to show locally", () => {
		expect(
			findDetailTimes("sent 2026-10-11T06:36:00.000Z, due 2026-10-11T09:00+02:00 or 2026-10-11T07:00:05Z"),
		).toEqual([
			{ text: "2026-10-11T06:36:00.000Z", at: Date.parse("2026-10-11T06:36:00.000Z") },
			{ text: "2026-10-11T09:00+02:00", at: Date.parse("2026-10-11T07:00:00.000Z") },
			{ text: "2026-10-11T07:00:05Z", at: Date.parse("2026-10-11T07:00:05.000Z") },
		]);
		expect(findDetailTimes("2 card(s) ahead in the machine-wide checks queue")).toEqual([]);
		expect(findDetailTimes(null)).toEqual([]);
		// A date without a time of day or zone isn't an instant.
		expect(findDetailTimes("plan of 2026-10-11, at 07:00")).toEqual([]);
	});
});
