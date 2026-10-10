// Issue #20 (foo f0ba7, 2026-10-09): a dev card's first turn changed nothing (its plan spec wasn't on main yet), so
// its snapshot had no changes. The orchestrator's messages then made the agent do the work in the same session while
// the card stayed in Review: its turns ended through hooks with no column or state change. Each was only logged as
// "waiting for the Review to settle", and no snapshot or QA card followed for 2.5 h. These run the pipeline worker
// with the real submission stage on a temp repo and the real QA gate.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { readEmptyDiff } from "../../../src/pipeline/empty-diff";
import { readQaGateEntry } from "../../../src/pipeline/qa-gate";
import { readRecoveryFlow } from "../../../src/pipeline/recovery";
import { applyRecoveryPatches } from "../../../src/pipeline/recovery-runtime";
import { createRecoveryStage } from "../../../src/pipeline/recovery-stage";
import { recordResubmitRequest } from "../../../src/pipeline/resubmit";
import { createSubmissionStage } from "../../../src/pipeline/submission-stage";
import { createRepoWithWorktree } from "../../utilities/git-repo";
import { createPipelineWorkerHarness, createSnapshot } from "../../utilities/pipeline-worker";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const T0 = Date.parse("2026-10-09T06:04:52.000Z");
const QA_WORKSPACE = { landing: { mode: "qa" }, kit: { name: "team" }, models: { allowProvisional: true } };
const DEV = createCard({ id: "f0ba7", updatedAt: T0 - 120_000 });

describe("a turn that ends while the card is already in Review (issue #20)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	function setup(options: { recovery?: boolean; dev?: typeof DEV } = {}) {
		const dev = options.dev ?? DEV;
		const repo = createRepoWithWorktree();
		cleanups.push(repo.cleanup);
		let now = T0;
		const stage = createSubmissionStage({
			checks: { enqueue: () => "queued" },
			resolveWorktree: async () => repo.worktreePath,
			recordEmptyDiff: async (workspaceId, taskId, record) => {
				await harness.store.update(workspaceId, (state) => {
					const { emptyDiff: _previous, ...entry } = state.cards[taskId] ?? {};
					return {
						...state,
						cards: { ...state.cards, [taskId]: record ? { ...entry, emptyDiff: record } : entry },
					};
				});
			},
			now: () => now,
		});
		const harness = createPipelineWorkerHarness({
			config: {
				workspaces: { foo: QA_WORKSPACE },
				...(options.recovery ? { pipeline: { recovery: { mode: "on" } } } : {}),
			},
			clock: () => now,
			inspectSubmission: stage.inspect,
			// The real recovery stage (codex: no session files to read); its server side is faked.
			...(options.recovery
				? {
						createRecovery: () =>
							createRecoveryStage({
								locateWorktree: async () => repo.worktreePath,
								readSessionDetail: async () => null,
								findRunningTool: async () => null,
								canProbe: () => false,
								probe: async () => ({ up: true, detail: "200" }),
								act: async () => ({ ok: true, status: "delivered", evidence: "output" }),
								cleanGeneratedReports: async () => [],
								tagRestartWip: async () => null,
								hasTrackedChanges: async () => false,
								readManifest: async () => null,
								removeManifest: async () => {},
								markManifestPlanned: async () => {},
								consumeRecoverRequest: async () => false,
								updateCards: async (workspaceId, patches) => {
									await harness.store.update(workspaceId, (state) => ({
										...state,
										cards: applyRecoveryPatches(state.cards, patches),
									}));
								},
								appendRecords: async () => {},
								sleep: async () => {},
								now: () => now,
								log: () => {},
							}),
					}
				: {}),
		});
		cleanups.push(harness.cleanup);
		const send = async (session: Partial<RuntimeTaskSessionSummary>, backlog: (typeof DEV)[] = []) =>
			await harness.send(
				createSnapshot({
					workspaceId: "foo",
					board: createBoard({ backlog, review: [dev] }),
					selectedAgentId: "codex",
					sessions: [
						{
							taskId: dev.id,
							agentId: "codex",
							state: "awaiting_review",
							reviewReason: "hook",
							live: true,
							...session,
						},
					],
				}),
			);
		const qaCards = () => harness.actions.filter((action) => action.kind === "createTask");
		return {
			repo,
			harness,
			send,
			qaCards,
			setNow: (next: number) => {
				now = next;
			},
		};
	}

	it("snapshots the settled turn and QAs it after an earlier no-changes snapshot", async () => {
		const { repo, harness, send, qaCards, setNow } = setup();
		const firstTurn = { startedAt: T0 - 600_000, stateChangedAt: T0 - 60_000, lastHookAt: T0 - 60_000 };

		// 06:04:52: the first turn changed nothing.
		await send(firstTurn);
		expect(harness.readCardDecisions("foo", "snapshot").at(-1)?.note).toContain("no changes against main");
		expect(readEmptyDiff((await harness.store.load("foo")).cards[DEV.id])).toMatchObject({ ran: true });
		expect(qaCards()).toEqual([]);

		// The agent works in the same session; the card never leaves Review and the session never shows running. Its
		// turn ends through a hook at 06:26: moments later the Review hasn't settled.
		writeFileSync(join(repo.worktreePath, "schema.prisma"), "model Loyalty {}\n");
		const turnEnd = T0 + 21 * 60_000;
		setNow(turnEnd + 2_000);
		await send({ ...firstTurn, lastHookAt: turnEnd });
		expect(harness.readCardDecisions("foo").at(-1)?.note).toBe(
			"the turn ended moments ago; QA waits for the Review to settle",
		);
		expect(qaCards()).toEqual([]);

		// Once it has settled: a new snapshot, the empty-diff record goes, and the QA gate gets the card.
		setNow(turnEnd + 20_000);
		await send({ ...firstTurn, lastHookAt: turnEnd });
		expect(harness.readCardDecisions("foo", "snapshot").at(-1)).toMatchObject({ outcome: "acted" });
		expect(readEmptyDiff((await harness.store.load("foo")).cards[DEV.id])).toBeNull();
		expect(qaCards()).toHaveLength(1);
		expect(qaCards()[0]).toMatchObject({ task: { role: "qa", reviewsTaskId: DEV.id } });
	});

	it("kanban task resubmit's request snapshots a card whose Review clock never moved", async () => {
		const { repo, harness, send, qaCards } = setup();
		const turn = { startedAt: T0 - 600_000, stateChangedAt: T0 - 60_000, lastHookAt: T0 - 60_000 };
		await send(turn);
		// Work that came with no hook at all (an agent with no hook for it, or a person in the worktree).
		writeFileSync(join(repo.worktreePath, "schema.prisma"), "model Loyalty {}\n");
		await send(turn);
		expect(qaCards()).toEqual([]);

		await recordResubmitRequest(harness.store, {
			workspaceId: "foo",
			taskId: DEV.id,
			request: { at: new Date(T0).toISOString(), by: "orchestrator __home_agent__:foo:claude" },
		});
		await send(turn);
		expect(qaCards()).toHaveLength(1);
	});

	// foo f0ba7, 2026-10-09/10: one orchestrator message made codex run while the card sat in Review, so recovery held
	// it (`liveHold`, 06:16). Codex's turn outcome isn't readable, so every settled Review after that was recovery's
	// "none", which carries no patch: the hold stayed, and the engine skipped the card without a word, through every
	// later turn and the resubmit of 09:19:59 (no review snapshot until `kanban task resume` cleared the hold).
	it("a hold recovery set while the session ran in Review ends once the Review settles, and the work gets QA", async () => {
		const { repo, harness, send, qaCards, setNow } = setup({ recovery: true });
		const firstTurn = { startedAt: T0 - 600_000, stateChangedAt: T0 - 60_000, lastHookAt: T0 - 60_000 };
		await send(firstTurn);
		expect(readEmptyDiff((await harness.store.load("foo")).cards[DEV.id])).not.toBeNull();

		// 06:16: the orchestrator's message makes the agent run; the card stays in Review.
		const ranAt = T0 + 12 * 60_000;
		setNow(ranAt);
		await send({ ...firstTurn, state: "running", stateChangedAt: ranAt, lastHookAt: ranAt });
		expect(harness.readCardDecisions("foo", "recovery").at(-1)?.note).toContain("is still running");
		expect(readRecoveryFlow((await harness.store.load("foo")).cards[DEV.id]).liveHold).toBe("session");

		// The work is done and the turn ends through a hook; the session is idle (awaiting_review, reviewReason hook).
		writeFileSync(join(repo.worktreePath, "schema.prisma"), "model Loyalty {}\n");
		const endedAt = ranAt + 10 * 60_000;
		const idle = { ...firstTurn, stateChangedAt: endedAt, lastHookAt: endedAt };
		setNow(endedAt + 2_000);
		await send(idle);
		expect(qaCards()).toEqual([]);
		setNow(endedAt + 20_000);
		await send(idle);
		expect(readRecoveryFlow((await harness.store.load("foo")).cards[DEV.id]).liveHold).toBeNull();
		expect(harness.readCardDecisions("foo", "snapshot").at(-1)).toMatchObject({ outcome: "acted" });
		expect(readEmptyDiff((await harness.store.load("foo")).cards[DEV.id])).toBeNull();
		expect(qaCards()).toHaveLength(1);
		expect(qaCards()[0]).toMatchObject({ task: { role: "qa", reviewsTaskId: DEV.id } });
	});

	it("a resubmit snapshots an idle Review card with an emptyDiff record that recovery once held", async () => {
		const { repo, harness, send, qaCards, setNow } = setup({ recovery: true });
		const firstTurn = { startedAt: T0 - 600_000, stateChangedAt: T0 - 60_000, lastHookAt: T0 - 60_000 };
		await send(firstTurn);
		// A hold left by a build before the fix (the state foo's f0ba7 was in at 09:19:59).
		await harness.store.update("foo", (state) => ({
			...state,
			cards: applyRecoveryPatches(state.cards, new Map([[DEV.id, { liveHold: "session" }]])),
		}));
		writeFileSync(join(repo.worktreePath, "schema.prisma"), "model Loyalty {}\n");
		const resubmitAt = T0 + 26 * 60 * 60_000;
		setNow(resubmitAt);
		await recordResubmitRequest(harness.store, {
			workspaceId: "foo",
			taskId: DEV.id,
			request: { at: new Date(resubmitAt).toISOString(), by: "orchestrator __home_agent__:foo:claude" },
		});
		await send(firstTurn);
		expect(harness.readCardDecisions("foo", "snapshot").at(-1)).toMatchObject({ outcome: "acted" });
		expect(qaCards()).toHaveLength(1);
	});

	// foo 59d13, 2026-10-09/10: its only QA card (163a5, round 1) recorded STALLED on a harness problem, the orchestrator
	// handed the card back, and the work never changed (snapshot 110a3f80). The resubmit at 09:20:00 re-ran the checks,
	// but the QA gate answered "already has QA card 163a5 (…, ingested, STALLED); no new QA card", the line logged at
	// 09:12 already, so the decision log showed nothing at all.
	it("a resubmit gives an unchanged snapshot whose QA STALLED a new QA round, and its decisions are logged", async () => {
		const dev = createCard({ id: "59d13", updatedAt: T0 - 120_000 });
		const { repo, harness, send, qaCards, setNow } = setup({ dev });
		writeFileSync(join(repo.worktreePath, "box.tsx"), "export const Box = () => null;\n");
		const turn = { startedAt: T0 - 600_000, stateChangedAt: T0 - 60_000, lastHookAt: T0 - 60_000 };
		await send(turn);
		expect(qaCards()).toHaveLength(1);
		const firstQa = qaCards()[0];
		const firstQaId = firstQa?.kind === "createTask" ? firstQa.task.taskId : "";

		// Its QA card recorded STALLED, the rework stage handled it (round 1), and the card was handed back.
		const stalledAt = T0 + 20 * 60_000;
		await harness.store.update("foo", (state) => {
			const qaEntry = readQaGateEntry(state.cards[firstQaId]);
			if (!qaEntry) {
				throw new Error("no QA gate entry");
			}
			const devEntry = state.cards[dev.id] ?? {};
			return {
				...state,
				cards: {
					...state.cards,
					[firstQaId]: {
						...state.cards[firstQaId],
						qaGate: { ...qaEntry, status: "ingested", ingestedAt: stalledAt, verdict: "STALLED", trashed: true },
					},
					[dev.id]: {
						...devEntry,
						qaVerdicts: [
							{
								qaTaskId: firstQaId,
								round: 1,
								snapshot: qaEntry.snapshot,
								verdict: "STALLED",
								blocking: [],
								notes: "STALLED: the browse tool could not drive the region change",
								scores: null,
								visual: null,
								artifactsDir: "/tmp/qa-artifacts",
								at: stalledAt,
							},
						],
						qaflow: {
							handled: [`r1|STALLED|${new Date(stalledAt).toISOString()}`],
							lastRound: 1,
							failRounds: [],
							handbacks: [
								{ at: new Date(stalledAt + 60_000).toISOString(), by: "orchestrator", note: "harness" },
							],
						},
					},
				},
			};
		});
		setNow(stalledAt + 120_000);
		await send(turn);
		expect(harness.readCardDecisions("foo").at(-1)?.note).toContain(`already has QA card ${firstQaId}`);
		expect(qaCards()).toHaveLength(1);

		// 09:20:00: the resubmit. The snapshot is the same, and the gate gives it a new QA card.
		const resubmit = async (at: number) => {
			setNow(at);
			await recordResubmitRequest(harness.store, {
				workspaceId: "foo",
				taskId: dev.id,
				request: { at: new Date(at).toISOString(), by: "orchestrator __home_agent__:foo:claude" },
			});
		};
		const unchangedLogged = () =>
			harness.readCardDecisions("foo", "snapshot").filter((record) => record.note.endsWith("unchanged")).length;
		await resubmit(stalledAt + 10 * 60_000);
		await send(turn);
		expect(unchangedLogged()).toBe(1);
		expect(qaCards()).toHaveLength(2);
		const secondQa = qaCards()[1];
		expect(secondQa).toMatchObject({ task: { role: "qa", reviewsTaskId: dev.id } });
		expect(harness.readCardDecisions("foo").at(-1)).toMatchObject({ outcome: "acted" });

		// A second resubmit while that QA card is queued makes no third one, and its unchanged decisions are logged again.
		const queued = secondQa?.kind === "createTask" ? [createCard({ id: secondQa.task.taskId, role: "qa" })] : [];
		await send(turn, queued);
		const logged = harness.readDecisions("foo").length;
		await send(turn, queued);
		expect(harness.readDecisions("foo")).toHaveLength(logged);
		await resubmit(stalledAt + 20 * 60_000);
		await send(turn, queued);
		expect(unchangedLogged()).toBe(2);
		expect(harness.readCardDecisions("foo").at(-1)?.note).toContain("already reviews this card");
		expect(qaCards()).toHaveLength(2);
	});
});
