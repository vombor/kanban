import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData } from "../../../../src/core/api-contract";
import type { PipelineSessionView } from "../../../../src/pipeline/engine";
import type { PipelineCardState } from "../../../../src/pipeline/pipeline-state";
import type { QaGateEntry } from "../../../../src/pipeline/qa-gate";
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
		workspaceId: "ws1",
		checks: null,
		checksWaitMin: 20,
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

	it("counts a backlog QA card the QA gate holds for its provider's usage limit (issue #49)", () => {
		const board = createBoard({
			review: [old("d0001"), old("d0002")],
			backlog: [
				old("qa001", { prompt: "You are the QA reviewer (round 1) for Kanban dev card d0001." }),
				old("qa002", { prompt: "You are the QA reviewer (round 1) for Kanban dev card d0002." }),
			],
		});
		// Only the held one: qa002 idles in Backlog for no reason the gate knows.
		expect(
			detectStalls(input(board, { limitHeldQaCardIds: new Set(["qa001"]) })).items.map((item) => item.key),
		).toEqual(["d0002:review-stall"]);
	});

	it("flags no Review card and counts a backlog QA card while the workspace's QA pipeline is paused", () => {
		const board = createBoard({
			review: [old("d0001"), old("d0002")],
			backlog: [old("qa001", { prompt: "You are the QA reviewer (round 1) for Kanban dev card d0001." })],
		});
		expect(detectStalls(input(board)).items.map((item) => item.key)).toEqual([
			"d0001:review-stall",
			"d0002:review-stall",
		]);
		expect(detectStalls(input(board, { pipelinePaused: true })).items).toEqual([]);
	});

	it("counts the QA card recorded in pipeline-state (qaCard)", () => {
		const board = createBoard({ review: [old("d0001")], in_progress: [old("q0001", { role: "qa" })] });
		const result = detectStalls(input(board, { pipelineCards: { d0001: { qaCard: "q0001" } } }));
		expect(result.items.filter((item) => item.taskId === "d0001")).toEqual([]);
	});

	describe("the QA gate's running QA card (issue #33: notes 1a48e/3d45a and 66ddd/9ef37, 2026-10-11)", () => {
		const SNAPSHOT = "6f1c2a9e0b7d";
		const gateCards = (qaGate: Partial<QaGateEntry> = {}): Record<string, PipelineCardState> => ({
			d0001: { snapshot: SNAPSHOT, qaCreated: SNAPSHOT, qaCard: "q0001" },
			q0001: {
				qaGate: {
					reviewsTaskId: "d0001",
					round: 1,
					snapshot: SNAPSHOT,
					snapshotRef: "refs/kanban/snapshots/d0001",
					outboxDir: "/tmp/outbox/q0001",
					scratchDir: "/tmp/scratch/d0001",
					baseRef: "main",
					agentId: "cline",
					model: null,
					devAgentId: "cline",
					devModel: null,
					route: null,
					status: "running",
					createdAt: NOW - 101 * MIN,
					startedAt: NOW - 100 * MIN,
					reviewSeenAt: null,
					nudges: 0,
					// Its slot was freed after qa.timeoutMin (60): slot accounting only.
					timedOutAt: NOW - 40 * MIN,
					ingestedAt: null,
					verdict: null,
					trashed: false,
					supersededAt: null,
					checks: null,
					...qaGate,
				},
			},
		});
		const qaCard = old("q0001", { role: "qa" });

		it("counts a QA card still running after its slot was freed", () => {
			const board = createBoard({ review: [old("d0001")], in_progress: [qaCard] });
			const sessions = new Map([["q0001", session("q0001", { state: "running" })]]);
			expect(detectStalls(input(board, { pipelineCards: gateCards(), sessions })).items).toEqual([]);
		});

		it("counts a QA card whose turn ended and that waits in Review for its verdict to be ingested", () => {
			const board = createBoard({ review: [old("d0001"), qaCard] });
			const sessions = new Map([["q0001", session("q0001", { state: "awaiting_review", updatedAt: NOW - 1000 })]]);
			expect(detectStalls(input(board, { pipelineCards: gateCards(), sessions })).items).toEqual([]);
		});

		it("still reports the dev card once its QA card was ingested, superseded or left the board", () => {
			const report = [expect.objectContaining({ key: "d0001:review-stall" })];
			const inReview = createBoard({ review: [old("d0001"), qaCard] });
			expect(
				detectStalls(input(inReview, { pipelineCards: gateCards({ status: "ingested", verdict: "FAIL" }) })).items,
			).toEqual(report);
			expect(detectStalls(input(inReview, { pipelineCards: gateCards({ status: "superseded" }) })).items).toEqual(
				report,
			);
			const gone = createBoard({ review: [old("d0001")], trash: [qaCard] });
			expect(detectStalls(input(gone, { pipelineCards: gateCards() })).items).toEqual(report);
		});
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
			chec1: { qaChecksWait: { snapshot: "abc", since: NOW - 15 * MIN } },
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

	describe("checks in flight (issue #34: foo e4b7c, 2026-10-11)", () => {
		const SNAPSHOT = "7e47811c70f8";
		// e4b7c: in Review since 11:05:54, checks queued 11:06:07 (wait until 11:26:07), the test step still writing at
		// 11:19:26, and the watchdog reported it at 11:19:58, 14 min in.
		const e4b7c = () => old("e4b7c", { updatedAt: NOW - 14 * MIN });
		const settled = new Map([
			["e4b7c", session("e4b7c", { state: "awaiting_review", reviewReason: "hook", updatedAt: NOW - 14 * MIN })],
		]);
		const waiting = (minutesAgo: number): Record<string, PipelineCardState> => ({
			e4b7c: { qaChecksWait: { snapshot: SNAPSHOT, since: NOW - minutesAgo * MIN } },
		});
		const report = [expect.objectContaining({ key: "e4b7c:review-stall" })];

		it("doesn't report a card whose checks are running, its QA due later", () => {
			const board = createBoard({ review: [e4b7c()] });
			const checks = {
				running: {
					workspaceId: "ws1",
					taskId: "e4b7c",
					snapshot: SNAPSHOT,
					step: "test",
					startedAt: NOW - 13 * MIN,
				},
				queued: [],
			};
			expect(detectStalls(input(board, { sessions: settled, pipelineCards: waiting(14), checks })).items).toEqual(
				[],
			);
			// The runner's word counts on its own, a wait record or not.
			expect(detectStalls(input(board, { sessions: settled, checks })).items).toEqual([]);
		});

		it("doesn't report a card whose checks are queued behind another card's", () => {
			const board = createBoard({ review: [e4b7c()] });
			const checks = {
				running: { workspaceId: "ws2", taskId: "f0001", snapshot: "1234", step: "install", startedAt: NOW - MIN },
				queued: [{ workspaceId: "ws1", taskId: "e4b7c", snapshot: SNAPSHOT }],
			};
			expect(detectStalls(input(board, { sessions: settled, checks })).items).toEqual([]);
		});

		it("doesn't report a card in its checks wait before the deadline", () => {
			const board = createBoard({ review: [e4b7c()] });
			expect(detectStalls(input(board, { sessions: settled, pipelineCards: waiting(14) })).items).toEqual([]);
		});

		it("doesn't report a card whose checks just finished and whose QA card was just created (queued in Backlog)", () => {
			// 11:19:56 checks PASS, 11:19:57 QA card 675a1 created (the gate's write ends the wait), started 11:19:59.
			const board = createBoard({ review: [e4b7c()], backlog: [old("675a1", { role: "qa" })] });
			const checksDone = {
				verdict: "PASS",
				at: new Date(NOW - 2000).toISOString(),
				logs: "",
				steps: [],
				error: null,
			};
			const qaGate: QaGateEntry = {
				reviewsTaskId: "e4b7c",
				round: 1,
				snapshot: SNAPSHOT,
				snapshotRef: "refs/kanban/snapshots/e4b7c",
				outboxDir: "/tmp/outbox/675a1",
				scratchDir: "/tmp/scratch/e4b7c",
				baseRef: "main",
				agentId: "cline",
				model: null,
				devAgentId: "codex",
				devModel: null,
				route: null,
				status: "queued",
				createdAt: NOW - 1000,
				startedAt: null,
				reviewSeenAt: null,
				nudges: 0,
				timedOutAt: null,
				ingestedAt: null,
				verdict: null,
				trashed: false,
				supersededAt: null,
				checks: "PASS",
			};
			// Each counts as the pipeline's activity on its own: the checks finishing, the gate creating the QA card.
			const checksOnly = { e4b7c: { snapshot: SNAPSHOT, checks: checksDone } };
			const qaCardOnly = { e4b7c: { qaCreated: SNAPSHOT, qaCard: "675a1" }, "675a1": { qaGate } };
			expect(detectStalls(input(board, { sessions: settled, pipelineCards: checksOnly })).items).toEqual([]);
			expect(detectStalls(input(board, { sessions: settled, pipelineCards: qaCardOnly })).items).toEqual([]);
			// The same queued QA card created 14 min ago and never started is reported, as before.
			const stale = { ...qaCardOnly, "675a1": { qaGate: { ...qaGate, createdAt: NOW - 14 * MIN } } };
			expect(detectStalls(input(board, { sessions: settled, pipelineCards: stale })).items).toEqual(report);
		});

		it("reports the card once the checks wait is past its deadline with nothing running", () => {
			const board = createBoard({ review: [old("e4b7c", { updatedAt: NOW - 30 * MIN })] });
			const quiet = new Map([["e4b7c", session("e4b7c", { state: "awaiting_review", updatedAt: NOW - 30 * MIN })]]);
			const otherCard = {
				running: { workspaceId: "ws1", taskId: "f0001", snapshot: "1234", step: "test", startedAt: NOW - MIN },
				queued: [{ workspaceId: "ws2", taskId: "e4b7c", snapshot: SNAPSHOT }],
			};
			expect(
				detectStalls(input(board, { sessions: quiet, pipelineCards: waiting(25), checks: otherCard })).items,
			).toEqual(report);
		});

		it("reports a card with really nothing pending", () => {
			const board = createBoard({ review: [e4b7c()] });
			expect(detectStalls(input(board, { sessions: settled, checks: { running: null, queued: [] } })).items).toEqual(
				report,
			);
		});
	});

	describe("a PASS being landed (foo 666f0, 2026-10-11)", () => {
		const SNAPSHOT = "77a73e0e5b1c";
		// 666f0: in Review 15 min; QA card 2f6ab's PASS ingested 13:51:02.265, the watchdog's report 13:51:03.971, the
		// land's answer 13:51:04.118.
		const card666f0 = (minutes: number) => old("666f0", { updatedAt: NOW - minutes * MIN });
		const quiet = (minutes: number) =>
			new Map([
				[
					"666f0",
					session("666f0", { state: "awaiting_review", reviewReason: "hook", updatedAt: NOW - minutes * MIN }),
				],
			]);
		const pass = (at: number) => ({
			qaTaskId: "2f6ab",
			round: 1,
			snapshot: SNAPSHOT,
			verdict: "PASS",
			blocking: [],
			notes: "",
			scores: {},
			visual: null,
			artifactsDir: null,
			at,
		});
		const qaGate = (ingestedAt: number): QaGateEntry => ({
			reviewsTaskId: "666f0",
			round: 1,
			snapshot: SNAPSHOT,
			snapshotRef: "refs/kanban/snapshots/666f0",
			outboxDir: "/tmp/outbox/2f6ab",
			scratchDir: "/tmp/scratch/666f0",
			baseRef: "main",
			agentId: "cline",
			model: null,
			devAgentId: "codex",
			devModel: null,
			route: null,
			status: "ingested",
			createdAt: NOW - 30 * MIN,
			startedAt: NOW - 29 * MIN,
			reviewSeenAt: null,
			nudges: 0,
			timedOutAt: null,
			ingestedAt,
			verdict: "PASS",
			trashed: true,
			supersededAt: null,
			checks: "PASS",
		});
		const cards = (ingestedAt: number, dev: PipelineCardState = {}): Record<string, PipelineCardState> => ({
			"666f0": {
				snapshot: SNAPSHOT,
				qaCreated: SNAPSHOT,
				qaCard: "2f6ab",
				qaVerdicts: [pass(ingestedAt)],
				...dev,
			},
			"2f6ab": { qaGate: qaGate(ingestedAt) },
		});

		it("doesn't report a card whose PASS was just ingested and whose land hasn't answered yet", () => {
			const board = createBoard({ review: [card666f0(15)] });
			expect(detectStalls(input(board, { sessions: quiet(15), pipelineCards: cards(NOW - 1706) })).items).toEqual(
				[],
			);
		});

		it("reports a PASS whose land is stuck past stall.reviewMin, measured from the ingest", () => {
			const board = createBoard({ review: [card666f0(30)] });
			expect(detectStalls(input(board, { sessions: quiet(30), pipelineCards: cards(NOW - 9 * MIN) })).items).toEqual(
				[],
			);
			const items = detectStalls(input(board, { sessions: quiet(30), pipelineCards: cards(NOW - 11 * MIN) })).items;
			expect(items).toEqual([expect.objectContaining({ key: "666f0:review-stall", taskId: "666f0" })]);
			expect(items[0]?.issue).toContain(
				"QA PASS of round 1 (QA card 2f6ab, snapshot 77a73e0e) was recorded 11 min ago",
			);
			expect(items[0]?.issue).toContain("has not landed");
		});

		it("leaves a conflicted land to the rework stage", () => {
			const board = createBoard({ review: [card666f0(30)] });
			const conflict = (at: number) => ({
				qaPass: {
					qaTaskId: "2f6ab",
					snapshot: SNAPSHOT,
					at,
					action: "land",
					status: "blocked",
					error: "conflict",
					landing: { decision: "conflict", files: ["a.ts"] },
				},
			});
			// The land just answered with a conflict: the rework stage's turn.
			expect(
				detectStalls(
					input(board, { sessions: quiet(30), pipelineCards: cards(NOW - 20 * MIN, conflict(NOW - MIN)) }),
				).items,
			).toEqual([]);
			// Its conflict rework sent and not started yet: the rework's started-check holds it.
			const reworkSent = {
				...conflict(NOW - 20 * MIN),
				qaflow: { reworks: [{ at: new Date(NOW - 20 * MIN).toISOString(), startedAt: null, restartAt: null }] },
			};
			expect(
				detectStalls(input(board, { sessions: quiet(30), pipelineCards: cards(NOW - 20 * MIN, reworkSent) })).items,
			).toEqual([]);
			// Answered long ago and nothing since: reported as before, not as a pending land.
			const items = detectStalls(
				input(board, { sessions: quiet(30), pipelineCards: cards(NOW - 20 * MIN, conflict(NOW - 20 * MIN)) }),
			).items;
			expect(items).toEqual([expect.objectContaining({ key: "666f0:review-stall" })]);
			expect(items[0]?.issue).toContain("with nothing pending");
		});
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
