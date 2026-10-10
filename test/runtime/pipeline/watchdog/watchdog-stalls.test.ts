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
		openRunoffCardIds: new Set(),
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

	it("leaves a Review card alone when the kit doesn't QA-gate it, or it is recent, escalated, stopped, an open user item, or has a QA card", () => {
		const board = createBoard({
			review: [
				old("d0006"),
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
				pipelineCards: {
					d0002: { qaflow: { escalated: { at: "2026-10-07T10:00:00Z", reason: "3 FAILs" } } },
					d0006: { qaflow: { stopped: { at: "2026-10-07T10:00:00Z", reason: "the kit does not rework" } } },
				},
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

	it("skips a card whose newest handled verdict is fresh, and a parked runoff PASS", () => {
		const verdictAfterMove: PipelineCardState = {
			qaflow: { handled: [`r1|FAIL|${new Date(NOW - 5 * MIN).toISOString()}`] },
		};
		const runoff: PipelineCardState = { snapshot: "abc", qaflow: { runoffPass: { snapshot: "abc" } } };
		const board = createBoard({ review: [old("d0001"), old("d0002")] });
		expect(detectStalls(input(board, { pipelineCards: { d0001: verdictAfterMove, d0002: runoff } })).items).toEqual(
			[],
		);
		expect(readNewestHandledVerdictAt(verdictAfterMove)).toBe(NOW - 5 * MIN);
	});

	it("safety net: a card still in Review reviewMin after the verdict acted on is reported (the verdict went nowhere)", () => {
		const verdict: PipelineCardState = {
			qaflow: { handled: [`r1|PASS|${new Date(NOW - 30 * MIN).toISOString()}`] },
		};
		const result = detectStalls(
			input(createBoard({ review: [old("d0001")] }), { pipelineCards: { d0001: verdict } }),
		);
		expect(result.items).toEqual([
			expect.objectContaining({
				key: "d0001:review-stall",
				issue: expect.stringContaining("nothing happened to it for 30 min"),
			}),
		]);
	});

	it("safety net: nothing is reported while something is pending", () => {
		const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString();
		const pipelineCards: Record<string, PipelineCardState> = {
			hold1: { qaflow: { retryAt: iso(-5) } },
			orph1: { qaflow: { orphan: { at: iso(30) } } },
			rewo1: { qaflow: { reworks: [{ at: iso(1) }] } },
			chec1: { qaChecksWait: { snapshot: "abc", since: iso(20) } },
			sent1: { qaflow: { recoverySentAt: iso(2) } },
		};
		const board = createBoard({ review: Object.keys(pipelineCards).map((id) => old(id)) });
		expect(detectStalls(input(board, { pipelineCards })).items).toEqual([]);
		// A Review that hasn't settled yet (a hook just now) is not idle either.
		const unsettled = new Map([
			[
				"d0001",
				session("d0001", { state: "awaiting_review", stateChangedAt: NOW - 60 * MIN, lastHookAt: NOW - 1000 }),
			],
		]);
		const fresh = createBoard({ review: [old("d0001")] });
		expect(detectStalls(input(fresh, { sessions: unsettled, reviewSettleMs: 12_000 })).items).toEqual([]);
		// A card the kit doesn't QA-gate waits for the user's Approve & land.
		expect(detectStalls(input(fresh, { qaGated: () => false })).items).toEqual([]);
	});

	it("an empty diff whose agent ran is reported at once, instead of the generic Review stall", () => {
		const card = createCard({ id: "b2d5b", updatedAt: NOW - 1 * MIN });
		const emptyDiff = {
			at: new Date(NOW - 30_000).toISOString(),
			cardUpdatedAt: card.updatedAt,
			snapshot: "9a631654aaaa",
			parent: "302326a2bbbb",
			baseRef: "main",
			ran: true,
			evidence: "its turn ended through the agent's hook",
		};
		const result = detectStalls(
			input(createBoard({ review: [card] }), {
				pipelineCards: { b2d5b: { emptyDiff } },
				sessions: new Map([["b2d5b", session("b2d5b", { state: "awaiting_review", reviewReason: "hook" })]]),
			}),
		);
		expect(result.items).toEqual([
			{
				key: "b2d5b:empty-diff",
				taskId: "b2d5b",
				issue: expect.stringMatching(
					/^dev card ran but changed nothing: no changes against main \(snapshot 9a631654 on 302326a2; its turn ended through the agent's hook\).*Done or restart\? \(`kanban task done --task-id b2d5b`/u,
				),
			},
		]);
		// Not for a card the kit doesn't QA-gate either way: an empty card has nothing to approve.
		expect(
			detectStalls(
				input(createBoard({ review: [card] }), { pipelineCards: { b2d5b: { emptyDiff } }, qaGated: () => false }),
			).items,
		).toHaveLength(1);
		// A record of an older submission (the card moved since) is not this card's state: the generic rules apply.
		const moved = { ...card, updatedAt: NOW - 2 * MIN };
		expect(
			detectStalls(input(createBoard({ review: [moved] }), { pipelineCards: { b2d5b: { emptyDiff } } })).items,
		).toEqual([]);
		// An open user item or an escalation is listed already.
		expect(
			detectStalls(
				input(createBoard({ review: [card] }), {
					pipelineCards: { b2d5b: { emptyDiff } },
					userItemIds: new Set(["b2d5b"]),
				}),
			).items,
		).toEqual([]);
	});

	it("an empty diff whose worktree stashed its work is reported at once with the stash (issue #22)", () => {
		const card = createCard({ id: "248ae", updatedAt: NOW - 30 * MIN });
		const emptyDiff = {
			at: new Date(NOW - MIN).toISOString(),
			cardUpdatedAt: card.updatedAt,
			snapshot: "18aba930aa",
			parent: "30e6e260bb",
			baseRef: "main",
			ran: false,
			evidence: "no hook or final message from this run",
			stashes: [
				{
					sha: "e8268879cc",
					ref: "stash@{0}",
					head: "64243cf1dd",
					at: NOW - 2 * MIN,
					message: "WIP on (no branch): 64243cf tags",
				},
			],
		};
		expect(
			detectStalls(input(createBoard({ review: [card] }), { pipelineCards: { "248ae": { emptyDiff } } })).items,
		).toEqual([
			expect.objectContaining({
				key: "248ae:empty-diff",
				issue: expect.stringMatching(
					/^dev card has no changes against main \(snapshot 18aba930 on 30e6e260\), but the card's work looks stranded in the stash: stash@\{0\} e8268879 .*git stash apply e8268879cc/u,
				),
			}),
		]);
	});

	it("an empty diff with no turn on record waits reviewMin for recovery, then is reported", () => {
		const card = createCard({ id: "e0001", updatedAt: NOW - 30 * MIN });
		const emptyDiff = (minutesAgo: number) => ({
			at: new Date(NOW - minutesAgo * MIN).toISOString(),
			cardUpdatedAt: card.updatedAt,
			snapshot: "abc",
			parent: "def",
			baseRef: "main",
			ran: false,
			evidence: "no hook or final message from this run (session awaiting_review, reviewReason exit)",
		});
		const board = createBoard({ review: [card] });
		expect(detectStalls(input(board, { pipelineCards: { e0001: { emptyDiff: emptyDiff(5) } } })).items).toEqual([]);
		expect(detectStalls(input(board, { pipelineCards: { e0001: { emptyDiff: emptyDiff(15) } } })).items).toEqual([
			expect.objectContaining({
				key: "e0001:empty-diff",
				issue: expect.stringContaining("its agent likely never ran: no changes against main"),
			}),
		]);
		// Recovery sent something after the empty snapshot: the next submission decides again.
		const nudged = {
			emptyDiff: emptyDiff(15),
			qaflow: { recoverySentAt: new Date(NOW - 12 * MIN).toISOString() },
		};
		expect(detectStalls(input(board, { pipelineCards: { e0001: nudged } })).items).toEqual([]);
	});

	it("skips a PASS held for an open runoff for the current snapshot; not an older one, nor one of a decided runoff", () => {
		const held = (snapshot: string): PipelineCardState => ({
			snapshot,
			hold: { group: "race", at: new Date(NOW - 60 * MIN).toISOString(), round: 1 },
			qaPass: { qaTaskId: "qa001", snapshot: "abc", at: NOW - 60 * MIN, action: "hold", status: null, error: null },
		});
		const board = createBoard({ review: [old("d0001"), old("d0002"), old("d0003")] });
		const result = detectStalls(
			input(board, {
				pipelineCards: { d0001: held("abc"), d0002: held("def"), d0003: held("abc") },
				// d0003's runoff is decided (or abandoned): a card still held for it is stuck.
				openRunoffCardIds: new Set(["d0001", "d0002"]),
			}),
		);
		expect(result.items.map((item) => item.key)).toEqual(["d0002:review-stall", "d0003:review-stall"]);
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

	it("never flags a plan card: it waits on its planner, or in Review for the user's approval", () => {
		const board = createBoard({
			in_progress: [old("pln01", { role: "plan" })],
			review: [old("pln02", { role: "plan" })],
		});
		const sessions = new Map([
			["pln01", session("pln01")],
			["pln02", session("pln02", { state: "awaiting_review" })],
		]);
		const result = detectStalls(input(board, { sessions }));
		expect(result.items).toEqual([]);
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

	it("counts a backlog card whose prerequisites are all Done as startable, and one still waiting as not", () => {
		const board = createBoard({ backlog: [old("a0001"), old("a0002")], trash: [old("d0001"), old("d0002")] }, [
			{ id: "dep-1", fromTaskId: "a0001", toTaskId: "d0001", createdAt: 0 },
			{ id: "dep-2", fromTaskId: "a0002", toTaskId: "d0002", createdAt: 0 },
			{ id: "dep-3", fromTaskId: "a0002", toTaskId: "a0001", createdAt: 0 },
		]);
		const roles = new Map(
			board.columns.flatMap((c) => c.cards).map((card) => [card.id, resolveWatchdogCardRole(card)]),
		);
		expect(detectPipelineIdle({ board, roles, now: NOW, newCardGraceMin: 10 })).toBe(
			"- **pipeline idle**: nothing in progress or review; backlog dev card(s) with no prerequisite waiting to be started: a0001",
		);
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
