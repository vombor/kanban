import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData } from "../../../../src/core/api-contract";
import type { PipelineSessionView } from "../../../../src/pipeline/engine";
import type { PipelineCardState } from "../../../../src/pipeline/pipeline-state";
import {
	detectPipelineIdle,
	detectStalls,
	readNewestHandledVerdictAt,
	resolveWatchdogCardRole,
	type StallInput,
} from "../../../../src/pipeline/watchdog/stalls";
import { createBoard, createCard } from "../../../utilities/workspace-state-store";

const MIN = 60_000;
const NOW = Date.parse("2026-10-07T12:00:00.000Z");

function session(taskId: string, overrides: Partial<PipelineSessionView> = {}): PipelineSessionView {
	return { taskId, agentId: "cline", modelId: null, state: "idle", updatedAt: NOW - 60 * MIN, pid: 1, ...overrides };
}

function input(board: RuntimeBoardData, overrides: Partial<StallInput> = {}): StallInput {
	const cards = board.columns.flatMap((column) => column.cards);
	return {
		board,
		sessions: new Map(),
		roles: new Map(cards.map((card) => [card.id, resolveWatchdogCardRole(card)])),
		pipelineCards: {},
		qaGated: () => true,
		userItemIds: new Set(),
		resumed: {},
		pidPressure: false,
		pidBrownout: false,
		settings: { reviewMin: 10, qaMin: 45, idleMin: 30, resumeIdleMin: 5, newCardGraceMin: 10 },
		now: NOW,
		...overrides,
	};
}

const old = (id: string, overrides: Partial<RuntimeBoardCard> = {}) =>
	createCard({ id, updatedAt: NOW - 60 * MIN, createdAt: NOW - 120 * MIN, ...overrides });

describe("detectStalls", () => {
	it("flags a QA-gated dev card in Review with no QA card and no newer verdict", () => {
		const result = detectStalls(input(createBoard({ review: [old("d0001")] })));
		expect(result.items).toEqual([expect.objectContaining({ key: "d0001:review-stall", taskId: "d0001" })]);
	});

	it("leaves a Review card alone when the kit doesn't QA-gate it, or it is recent, escalated, an open user item, or has a QA card", () => {
		const board = createBoard({
			review: [
				old("d0001"),
				old("d0002"),
				old("d0003"),
				createCard({ id: "d0004", updatedAt: NOW - 2 * MIN }),
				old("d0005"),
			],
			in_progress: [old("qa001", { prompt: "You are the QA reviewer (round 1) for Kanban dev card d0005." })],
		});
		const result = detectStalls(
			input(board, {
				qaGated: (card) => card.id !== "d0001",
				pipelineCards: { d0002: { qaflow: { escalated: { at: "2026-10-07T10:00:00Z", reason: "3 FAILs" } } } },
				userItemIds: new Set(["d0003"]),
				sessions: new Map([["qa001", session("qa001", { state: "running" })]]),
			}),
		);
		expect(result.items).toEqual([]);
	});

	it("counts a backlog QA card only while PID pressure holds it", () => {
		const board = createBoard({
			review: [old("d0001")],
			backlog: [old("qa001", { prompt: "You are the QA reviewer (round 1) for Kanban dev card d0001." })],
		});
		expect(detectStalls(input(board)).items).toHaveLength(1);
		expect(detectStalls(input(board, { pidPressure: true })).items).toHaveLength(0);
	});

	it("counts the QA card recorded in pipeline-state (qaCard)", () => {
		const board = createBoard({ review: [old("d0001")], in_progress: [old("q0001", { role: "qa" })] });
		const result = detectStalls(input(board, { pipelineCards: { d0001: { qaCard: "q0001" } } }));
		expect(result.items.filter((item) => item.taskId === "d0001")).toEqual([]);
	});

	it("skips a card whose newest handled verdict is newer than its last move, and a parked runoff PASS", () => {
		const verdictAfterMove: PipelineCardState = {
			qaflow: { handled: [`r1|FAIL|${new Date(NOW - 30 * MIN).toISOString()}`] },
		};
		const runoff: PipelineCardState = { snapshot: "abc", qaflow: { runoffPass: { snapshot: "abc" } } };
		const board = createBoard({ review: [old("d0001"), old("d0002")] });
		expect(detectStalls(input(board, { pipelineCards: { d0001: verdictAfterMove, d0002: runoff } })).items).toEqual(
			[],
		);
		expect(readNewestHandledVerdictAt(verdictAfterMove)).toBe(NOW - 30 * MIN);
	});

	it("flags a QA or TRIAGE card in progress past qaMin whose session isn't running; never a calibration card", () => {
		const board = createBoard({
			in_progress: [
				old("qa001", { prompt: "You are the QA reviewer (round 1) for Kanban dev card d0001." }),
				old("cal01", { title: "QA-CAL glm", prompt: "You are the QA reviewer (calibration run 1)" }),
			],
		});
		const result = detectStalls(input(board, { sessions: new Map([["qa001", session("qa001")]]) }));
		expect(result.items.map((item) => item.key)).toEqual(["qa001:qa-stall"]);
		expect(result.continues).toEqual([]);
	});

	it("legacy QA cards without a role are not dev cards (no continue, no review stall)", () => {
		const legacyQa = old("qa001", { prompt: "You are the QA reviewer (round 3) for Kanban dev card d0009." });
		const board = createBoard({ in_progress: [legacyQa] });
		const result = detectStalls(
			input(board, { sessions: new Map([["qa001", session("qa001", { updatedAt: NOW - 10 * MIN })]]) }),
		);
		expect(result.continues).toEqual([]);
	});

	it("sends one continue for a dead session, then flags it idle; no continue in a brownout", () => {
		const board = createBoard({ in_progress: [old("d0001")] });
		const sessions = new Map([["d0001", session("d0001", { updatedAt: NOW - 40 * MIN })]]);
		const first = detectStalls(input(board, { sessions }));
		expect(first.continues).toEqual([{ taskId: "d0001", resumeKey: `d0001:${NOW - 40 * MIN}`, minutes: 40 }]);
		expect(first.items).toEqual([]);

		const second = detectStalls(input(board, { sessions, resumed: { [`d0001:${NOW - 40 * MIN}`]: "x" } }));
		expect(second.continues).toEqual([]);
		expect(second.items.map((item) => item.key)).toEqual(["d0001:idle"]);

		const brownout = detectStalls(input(board, { sessions, pidBrownout: true }));
		expect(brownout.continues).toEqual([]);
		expect(brownout.items.map((item) => item.key)).toEqual(["d0001:idle"]);
	});

	it("ignores running sessions", () => {
		const board = createBoard({ in_progress: [old("d0001")] });
		const sessions = new Map([["d0001", session("d0001", { state: "running" })]]);
		expect(detectStalls(input(board, { sessions }))).toEqual({ items: [], continues: [] });
	});
});

describe("detectPipelineIdle", () => {
	it("lists startable backlog dev cards when nothing is in progress or review", () => {
		const board = createBoard(
			{
				backlog: [
					old("a0001"),
					old("a0002"),
					old("a0003", { title: "BLOCKED: needs a model" }),
					createCard({ id: "a0004", createdAt: NOW - 2 * MIN }),
					old("qa001", { prompt: "You are the QA reviewer (round 1) for Kanban dev card a0001." }),
				],
			},
			[{ id: "dep", fromTaskId: "a0002", toTaskId: "a0001", createdAt: 0 }],
		);
		const roles = new Map(
			board.columns.flatMap((c) => c.cards).map((card) => [card.id, resolveWatchdogCardRole(card)]),
		);
		expect(detectPipelineIdle({ board, roles, now: NOW, newCardGraceMin: 10 })).toBe(
			"- **pipeline idle**: nothing in progress or review; backlog dev card(s) with no prerequisite waiting to be started: a0001",
		);
		const busy = createBoard({ backlog: [old("a0001")], review: [old("b0001")] });
		expect(detectPipelineIdle({ board: busy, roles, now: NOW, newCardGraceMin: 10 })).toBeNull();
	});
});

describe("resolveWatchdogCardRole", () => {
	it("uses resolveCardRole, links a legacy QA card to its dev card, and counts calibration runs by id", () => {
		expect(
			resolveWatchdogCardRole(
				createCard({ id: "q1", prompt: "You are the QA reviewer (round 2) for Kanban dev card 9f3e1. …" }),
			),
		).toEqual({ role: "qa", reviewsTaskId: "9f3e1" });
		expect(resolveWatchdogCardRole(createCard({ id: "c3", title: "renamed" }), new Set(["c3"]))).toEqual({
			role: "calibration",
			reviewsTaskId: null,
		});
		expect(resolveWatchdogCardRole(createCard({ id: "c3", role: "dev" }), new Set(["c3"])).role).toBe("dev");
		expect(resolveWatchdogCardRole(createCard({ id: "d1", prompt: "Fix the login page" }))).toEqual({
			role: "dev",
			reviewsTaskId: null,
		});
	});
});
