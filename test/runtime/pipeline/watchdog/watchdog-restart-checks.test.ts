import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData } from "../../../../src/core/api-contract";
import type { PipelineSessionView } from "../../../../src/pipeline/engine";
import type { PipelineCardState } from "../../../../src/pipeline/pipeline-state";
import type { QaGateEntry } from "../../../../src/pipeline/qa-gate";
import { detectRestartQaGaps, type RestartCheckInput } from "../../../../src/pipeline/watchdog/restart-checks";
import { resolveWatchdogCardRole } from "../../../../src/pipeline/watchdog/stalls";
import { createBoard, createCard } from "../../../utilities/workspace-state-store";

const MIN = 60_000;
// The 2026-10-07 restart.
const STARTED = Date.parse("2026-10-07T23:02:56.000Z");
const NOT_REPLACED = "the automatic QA replacement didn't happen";

function qaGate(reviewsTaskId: string, overrides: Partial<QaGateEntry> = {}): QaGateEntry {
	return {
		reviewsTaskId,
		round: 1,
		snapshot: "abcdef0123456789",
		snapshotRef: `refs/kanban/snapshots/${reviewsTaskId}`,
		outboxDir: "/tmp/outbox",
		scratchDir: "/tmp/scratch",
		baseRef: "main",
		agentId: "claude",
		model: null,
		devAgentId: "cline",
		devModel: null,
		route: null,
		status: "running",
		createdAt: STARTED - 30 * MIN,
		startedAt: STARTED - 29 * MIN,
		reviewSeenAt: null,
		nudges: 0,
		timedOutAt: null,
		ingestedAt: null,
		verdict: null,
		trashed: false,
		supersededAt: null,
		checks: null,
		...overrides,
	};
}

function withQa(devId: string, qaId: string, gate: Partial<QaGateEntry> = {}): Record<string, PipelineCardState> {
	return { [devId]: { qaCard: qaId, qaCreated: "abcdef0123456789" }, [qaId]: { qaGate: qaGate(devId, gate) } };
}

/** A QA card's summary as the server leaves it after a restart: marked interrupted, no process. */
function deadSession(taskId: string, overrides: Partial<PipelineSessionView> = {}): PipelineSessionView {
	return {
		taskId,
		agentId: "claude",
		modelId: null,
		state: "interrupted",
		startedAt: STARTED - 29 * MIN,
		pid: null,
		live: false,
		...overrides,
	};
}

const qaCard = (id: string, devId: string, overrides: Partial<RuntimeBoardCard> = {}) =>
	createCard({ id, role: "qa", reviewsTaskId: devId, ...overrides });

function input(board: RuntimeBoardData, overrides: Partial<RestartCheckInput> = {}): RestartCheckInput {
	const cards = board.columns.flatMap((column) => column.cards);
	return {
		board,
		sessions: new Map(),
		roles: new Map(cards.map((card) => [card.id, resolveWatchdogCardRole(card)])),
		pipelineCards: {},
		serverStartedAt: STARTED,
		userItemIds: new Set(),
		pidPressure: false,
		firstSeenGone: new Map(),
		settings: { graceMin: 1, resumeGapSec: 20 },
		now: STARTED + 2 * MIN,
		...overrides,
	};
}

describe("detectRestartQaGaps: the automatic QA replacement didn't happen", () => {
	it("flags a dead QA card the gate has not superseded once the grace since the start has passed", () => {
		const board = createBoard({ review: [createCard({ id: "6f756" })], in_progress: [qaCard("q0001", "6f756")] });
		const base = input(board, {
			pipelineCards: withQa("6f756", "q0001"),
			sessions: new Map([["q0001", deadSession("q0001")]]),
		});
		// Within the grace the gate's own fix still has time.
		expect(detectRestartQaGaps({ ...base, now: STARTED + 50_000 })).toEqual({ items: [], notes: [] });
		expect(detectRestartQaGaps({ ...base, now: STARTED + MIN }).items).toEqual([
			{
				key: "6f756:qa-not-replaced:q0001",
				taskId: "6f756",
				issue: expect.stringMatching(
					new RegExp(
						`^dev card is in Review and ${NOT_REPLACED}: its QA card q0001 \\(round 1, snapshot abcdef01\\) \\(in_progress\\) lost its session with the previous Kanban server \\(summary interrupted, no process now\\)`,
					),
				),
			},
		]);
	});

	it("flags a superseded QA card with no replacement once the grace since the supersede has passed", () => {
		const board = createBoard({ review: [createCard({ id: "d0001" })], trash: [qaCard("q0001", "d0001")] });
		const supersededAt = STARTED + 70_000;
		const base = input(board, {
			pipelineCards: {
				d0001: {},
				q0001: { qaGate: qaGate("d0001", { status: "superseded", supersededAt }) },
			},
		});
		expect(detectRestartQaGaps({ ...base, now: supersededAt + 30_000 }).items).toEqual([]);
		const { items } = detectRestartQaGaps({ ...base, now: supersededAt + MIN });
		expect(items.map((item) => item.key)).toEqual(["d0001:qa-not-replaced:q0001"]);
		expect(items[0]?.issue).toContain(`${NOT_REPLACED}: the QA gate superseded its dead QA card q0001`);
		expect(items[0]?.issue).toContain("made no new QA card since");
	});

	it("never flags a replacement waiting for a QA slot or PID pressure: it says so instead", () => {
		const board = createBoard({
			review: [createCard({ id: "d0001" }), createCard({ id: "d0002" })],
			backlog: [qaCard("q0011", "d0001")],
			trash: [qaCard("q0001", "d0001"), qaCard("q0002", "d0002")],
		});
		const pipelineCards = {
			d0001: { qaCard: "q0011", qaCreated: "abcdef0123456789" },
			q0001: { qaGate: qaGate("d0001", { status: "superseded", supersededAt: STARTED + 70_000 }) },
			q0011: { qaGate: qaGate("d0001", { status: "queued", createdAt: STARTED + 71_000, startedAt: null }) },
			d0002: {},
			q0002: { qaGate: qaGate("d0002", { status: "superseded", supersededAt: STARTED + 70_000 }) },
		};
		const slots = detectRestartQaGaps(input(board, { pipelineCards, now: STARTED + 30 * MIN }));
		// d0002's replacement was never made and nothing holds it.
		expect(slots.items.map((item) => item.key)).toEqual(["d0002:qa-not-replaced:q0002"]);
		expect(slots.notes).toEqual([
			{
				taskId: "d0001",
				note: expect.stringMatching(
					/QA card q0011 .* replaces a dead QA card and is queued: waiting for a QA slot or provider capacity$/u,
				),
			},
		]);

		const pressure = detectRestartQaGaps(input(board, { pipelineCards, pidPressure: true, now: STARTED + 30 * MIN }));
		expect(pressure.items).toEqual([]);
		expect(pressure.notes.map((note) => [note.taskId, note.note.endsWith("PID pressure to clear")])).toEqual([
			["d0001", true],
			["d0002", true],
		]);
	});

	it("flags a QA card moved to Done or off the board that the gate doesn't supersede, a grace after it was first seen gone", () => {
		const board = createBoard({
			review: [createCard({ id: "d0001" }), createCard({ id: "d0002" })],
			trash: [qaCard("q0002", "d0002")],
		});
		const firstSeenGone = new Map<string, number>();
		const pipelineCards = { ...withQa("d0001", "q0001"), ...withQa("d0002", "q0002") };
		const first = detectRestartQaGaps(input(board, { pipelineCards, firstSeenGone, now: STARTED + 10 * MIN }));
		expect(first.items).toEqual([]);
		expect([...firstSeenGone.keys()]).toEqual(["d0001:q0001", "d0002:q0002"]);
		const later = detectRestartQaGaps(input(board, { pipelineCards, firstSeenGone, now: STARTED + 11 * MIN }));
		expect(
			later.items.map((item) => [
				item.key,
				item.issue.includes("is no longer on the board"),
				item.issue.includes("went to Done"),
			]),
		).toEqual([
			["d0001:qa-not-replaced:q0001", true, false],
			["d0002:qa-not-replaced:q0002", false, true],
		]);
		// Superseded meanwhile: the memory goes.
		const fixed = {
			...pipelineCards,
			q0001: { qaGate: qaGate("d0001", { status: "superseded", supersededAt: STARTED + 11 * MIN }) },
		};
		detectRestartQaGaps(input(board, { pipelineCards: fixed, firstSeenGone, now: STARTED + 11 * MIN + 10_000 }));
		expect([...firstSeenGone.keys()]).toEqual(["d0002:q0002"]);
	});

	it("leaves alone a live QA card, one this server started, a first queued one, an ingested one, a recorded verdict, a resent turn's supersede and a running replacement", () => {
		const ids = ["d0001", "d0002", "d0003", "d0004", "d0005", "d0006", "d0007"];
		const board = createBoard({
			review: ids.map((id) => createCard({ id })),
			in_progress: [
				qaCard("q0001", "d0001"),
				qaCard("q0002", "d0002"),
				qaCard("q0005", "d0005"),
				qaCard("q0017", "d0007"),
			],
			backlog: [qaCard("q0003", "d0003")],
		});
		const { items, notes } = detectRestartQaGaps(
			input(board, {
				pipelineCards: {
					...withQa("d0001", "q0001"),
					...withQa("d0002", "q0002"),
					...withQa("d0003", "q0003", { status: "queued", startedAt: null }),
					...withQa("d0004", "q0004", { status: "ingested", verdict: "PASS" }),
					d0005: {
						qaCard: "q0005",
						qaVerdicts: [{ qaTaskId: "q0005", round: 1, snapshot: "abcdef0123456789", verdict: "FAIL" }],
					},
					q0005: { qaGate: qaGate("d0005") },
					d0006: { qaflow: { recoverySentAt: new Date(STARTED + MIN).toISOString() } },
					q0006: { qaGate: qaGate("d0006", { status: "superseded", supersededAt: STARTED + MIN }) },
					d0007: { qaCard: "q0017" },
					q0007: { qaGate: qaGate("d0007", { status: "superseded", supersededAt: STARTED + 70_000 }) },
					q0017: { qaGate: qaGate("d0007", { createdAt: STARTED + 71_000, startedAt: STARTED + 72_000 }) },
				},
				sessions: new Map([
					["q0001", deadSession("q0001", { live: true, state: "running" })],
					// Started by this server and gone quiet: the ingest's and the generic QA stall's, not the restart's.
					["q0002", deadSession("q0002", { startedAt: STARTED + 1_000 })],
					["q0005", deadSession("q0005")],
					["q0017", deadSession("q0017", { live: true, state: "running", startedAt: STARTED + 72_000 })],
				]),
				now: STARTED + 30 * MIN,
			}),
		);
		expect(items).toEqual([]);
		expect(notes).toEqual([]);
	});

	it("skips escalated, stopped and open user-item dev cards", () => {
		const board = createBoard({
			review: ["d0001", "d0002", "d0003"].map((id) => createCard({ id })),
			in_progress: ["d0001", "d0002", "d0003"].map((id) => qaCard(`q${id.slice(1)}`, id)),
		});
		const pipelineCards = { ...withQa("d0001", "q0001"), ...withQa("d0002", "q0002"), ...withQa("d0003", "q0003") };
		pipelineCards.d0001 = { ...pipelineCards.d0001, qaflow: { escalated: { at: "x", reason: "3 FAILs" } } };
		pipelineCards.d0002 = { ...pipelineCards.d0002, qaflow: { stopped: { at: "x", reason: "stop" } } };
		const { items } = detectRestartQaGaps(
			input(board, {
				pipelineCards,
				userItemIds: new Set(["d0003"]),
				sessions: new Map(["q0001", "q0002", "q0003"].map((id) => [id, deadSession(id)])),
				now: STARTED + 30 * MIN,
			}),
		);
		expect(items).toEqual([]);
	});
});

describe("detectRestartQaGaps: cards still held for a restart", () => {
	const kanbanStart = new Date(STARTED).toISOString();
	const orphan = (at: number, kind = "dev") => ({
		qaflow: { orphan: { at: new Date(at).toISOString(), kanbanStart, kind } },
	});

	it("flags a dev orphan mark after the grace plus its place in the resume queue; a QA orphan is the gate's", () => {
		const board = createBoard({
			in_progress: [createCard({ id: "d0001" }), qaCard("q0009", "d0009")],
			review: [createCard({ id: "d0002" })],
		});
		const base = input(board, {
			pipelineCards: {
				d0001: orphan(STARTED + 5_000),
				d0002: orphan(STARTED + 5_000),
				q0009: orphan(STARTED + 5_000, "qa"),
			},
			sessions: new Map([["d0001", deadSession("d0001")]]),
		});
		// 1 min grace + 2 marked dev cards × 20 s (the QA card's mark doesn't queue a resume).
		expect(detectRestartQaGaps({ ...base, now: STARTED + 5_000 + 99_000 }).items).toEqual([]);
		const { items } = detectRestartQaGaps({ ...base, now: STARTED + 5_000 + 100_000 });
		expect(items.map((item) => item.key)).toEqual([
			`d0001:restart-held:${kanbanStart}`,
			`d0002:restart-held:${kanbanStart}`,
		]);
		expect(items[0]?.issue).toContain("kanban task resume d0001");
	});

	it("uses restart recovery's own staleness: a mark of an earlier start or a card with a session again is not held", () => {
		const board = createBoard({ in_progress: [createCard({ id: "d0001" }), createCard({ id: "d0002" })] });
		const { items } = detectRestartQaGaps(
			input(board, {
				pipelineCards: {
					d0001: {
						qaflow: {
							orphan: { at: "2026-10-06T10:00:00.000Z", kanbanStart: "2026-10-06T09:59:00.000Z", kind: "dev" },
						},
					},
					d0002: orphan(STARTED),
				},
				sessions: new Map([
					["d0002", deadSession("d0002", { live: true, state: "running", startedAt: STARTED + 30_000 })],
				]),
				now: STARTED + 30 * MIN,
			}),
		);
		expect(items).toEqual([]);
	});

	it("waits while PID pressure holds the resumes, and a held dev card gets no QA item of its own", () => {
		const board = createBoard({ review: [createCard({ id: "d0001" })] });
		const pipelineCards = { ...withQa("d0001", "q0001"), d0001: { qaCard: "q0001", ...orphan(STARTED) } };
		const held = input(board, { pipelineCards, now: STARTED + 30 * MIN });
		expect(detectRestartQaGaps({ ...held, pidPressure: true }).items).toEqual([]);
		expect(detectRestartQaGaps(held).items.map((item) => item.key)).toEqual([`d0001:restart-held:${kanbanStart}`]);
	});
});
