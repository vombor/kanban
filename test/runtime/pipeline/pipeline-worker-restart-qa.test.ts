// QA cards a restart orphaned get a replacement right after startup (foo, 2026-10-07 23:02:56Z). Restart recovery
// logged the In Progress QA cards a5e91 and 257a4 as `recreate_qa` / not implemented, and the QA gate then said "QA
// card a5e91 (in_progress) already reviews this card", trusting the column and a dead "running" summary. The QA cards
// later went to Done with no verdict, their qaGate entries still `running`, and the dev cards sat in Review without
// QA until the watchdog flagged them. These run the real recovery stage and the QA gate in the pipeline worker.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardColumnId } from "../../../src/core/api-contract";
import { createRunoffsFeature } from "../../../src/kits/team/runoffs/runoffs-feature";
import { readRunoffs } from "../../../src/kits/team/runoffs/runoffs-store";
import { createPipelineFeatureRegistry } from "../../../src/pipeline/features";
import type { ReleaseHoldInput } from "../../../src/pipeline/hold";
import { type QaGateEntry, readQaGateEntry } from "../../../src/pipeline/qa-gate";
import type { QaVerdict } from "../../../src/pipeline/qa-verdict";
import { readRecoveryFlow } from "../../../src/pipeline/recovery";
import { applyRecoveryPatches } from "../../../src/pipeline/recovery-runtime";
import { createRecoveryStage, type RecoveryAction } from "../../../src/pipeline/recovery-stage";
import { createPipelineWorkerHarness, createSnapshot, type QaGateHarnessAction } from "../../utilities/pipeline-worker";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const T0 = Date.parse("2026-10-07T23:03:26.000Z");
const SERVER_START = Date.parse("2026-10-07T23:02:56.000Z");
const BEFORE = SERVER_START - 20 * 60_000;
const CONFIG = {
	workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team" }, models: { allowProvisional: true } } },
	pipeline: { recovery: { mode: "on" }, qa: { slots: 1 } },
};
const DEV = { agentId: "cline" as const, agentSettings: { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" } };

const PASS: QaVerdict = {
	verdict: "PASS",
	scores: { spec: 5, correctness: 4, tests: 4, ux: null, code: 4, process: 5 },
	blocking: [],
	visual: { status: "n/a", artifacts: [], consoleErrors: 0 },
	notes: "looks right",
	log: "- no blocking issues",
};

/** A QA card the gate made and started under the previous server. */
function runningQaEntry(qaTaskId: string, devTaskId: string): QaGateEntry {
	return {
		reviewsTaskId: devTaskId,
		round: 1,
		snapshot: `snap-${devTaskId}`,
		snapshotRef: `refs/kanban/snapshots/${devTaskId}`,
		outboxDir: `/tmp/kanban-qa-out/${qaTaskId}`,
		scratchDir: `/tmp/kanban-qa/${devTaskId}`,
		baseRef: "main",
		agentId: "codex",
		model: null,
		devAgentId: "cline",
		devModel: { provider: "bedrock", model: "us.openai.gpt-6.1-sol" },
		route: null,
		status: "running",
		createdAt: BEFORE,
		startedAt: BEFORE,
		reviewSeenAt: null,
		nudges: 0,
		timedOutAt: null,
		ingestedAt: null,
		verdict: null,
		trashed: false,
		supersededAt: null,
		checks: null,
	};
}

type Columns = Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>;
type SessionInput = NonNullable<Parameters<typeof createSnapshot>[0]["sessions"]>[number];

describe("pipeline worker: QA cards orphaned by a restart", () => {
	const harnesses: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	function setup(options: { runoff?: { name: string; cards: string[] } } = {}) {
		const resumes: RecoveryAction[] = [];
		const releases: Array<Omit<ReleaseHoldInput, "workspaceId" | "workspacePath">> = [];
		let runoffsPath: string | null = null;
		let harness: ReturnType<typeof createPipelineWorkerHarness> | null = null;
		harness = createPipelineWorkerHarness({
			config: CONFIG,
			now: T0,
			createRecovery: () =>
				createRecoveryStage({
					locateWorktree: async (_workspacePath, card) => `/wt/${card.id}`,
					readSessionDetail: async () => null,
					findRunningTool: async () => null,
					canProbe: () => false,
					probe: async () => ({ up: true, detail: "200" }),
					act: async (_workspaceId, action) => {
						resumes.push(action);
						return { ok: true, status: "started" };
					},
					cleanGeneratedReports: async () => [],
					tagRestartWip: async () => null,
					hasTrackedChanges: async () => false,
					readManifest: async () => null,
					removeManifest: async () => {},
					markManifestPlanned: async () => {},
					consumeRecoverRequest: async () => false,
					updateCards: async (workspaceId, patches) => {
						await harness?.store.update(workspaceId, (state) => ({
							...state,
							cards: applyRecoveryPatches(state.cards, patches),
						}));
					},
					appendRecords: async () => {},
					sleep: async () => {},
					now: () => T0,
					log: () => {},
				}),
			...(options.runoff
				? {
						createFeatures: ({ bus, appendQaLog, root }) => {
							runoffsPath = join(root, "data", "foo", "runoffs.json");
							mkdirSync(dirname(runoffsPath), { recursive: true });
							writeFileSync(runoffsPath, JSON.stringify({ runoffs: [options.runoff] }));
							const registry = createPipelineFeatureRegistry({
								bus,
								actions: {
									releaseHold: vi.fn(async (_workspaceId, input) => {
										releases.push(input);
										return {
											ok: true as const,
											tag: input.tag ?? null,
											result: { ok: true, status: "trashed" } as never,
										};
									}),
									appendQaLog,
								},
							});
							const path = runoffsPath;
							registry.register(
								createRunoffsFeature({
									getRunoffsPath: () => path,
									readSnapshot: async (_repoPath, taskId) => `snap-${taskId}`,
									readCost: async () => null,
									now: () => T0,
								}),
							);
							return registry;
						},
					}
				: {}),
		});
		harnesses.push(harness);
		const h = harness;
		const send = async (columns: Columns, sessions: SessionInput[]) => {
			await h.send({
				...createSnapshot({ workspaceId: "foo", board: createBoard(columns), selectedAgentId: "claude", sessions }),
				serverStartedAt: SERVER_START,
				previousServerStartedAt: BEFORE - 60_000,
			});
		};
		const kinds = () =>
			h.actions
				.filter((action: QaGateHarnessAction) => action.kind !== "deliverInput")
				.map(
					(action) =>
						`${action.kind}:${"taskId" in action ? action.taskId : "task" in action ? action.task.taskId : ""}`,
				);
		return {
			harness: h,
			send,
			kinds,
			resumes,
			releases,
			readRunoffsFile: async () => (runoffsPath ? await readRunoffs(runoffsPath) : null),
		};
	}

	/** The dev card in Review, its turn over before the restart; the QA card In Progress with a dead session. */
	const devSession = (taskId: string): SessionInput => ({
		taskId,
		agentId: "cline",
		state: "awaiting_review",
		startedAt: BEFORE,
		stateChangedAt: BEFORE,
		live: false,
	});
	const deadQaSession = (taskId: string, state: "running" | "interrupted"): SessionInput => ({
		taskId,
		agentId: "codex",
		state,
		pid: null,
		startedAt: BEFORE,
		live: false,
	});

	it("hands an orphaned In Progress QA card to the gate, which supersedes it and starts a new QA card for the same snapshot", async () => {
		const { harness, send, kinds, resumes } = setup();
		await harness.store.update("foo", (state) => ({
			...state,
			cards: {
				...state.cards,
				d6f75: { qaCreated: "snap-d6f75", qaCard: "a5e91" },
				a5e91: { qaGate: runningQaEntry("a5e91", "d6f75") },
			},
		}));
		const dev = createCard({ id: "d6f75", ...DEV });
		const qa = createCard({ id: "a5e91", role: "qa", reviewsTaskId: "d6f75" });

		await send({ in_progress: [qa], review: [dev] }, [devSession("d6f75"), deadQaSession("a5e91", "running")]);

		// Restart recovery: no resume of a QA card, a hand-off to the gate.
		expect(resumes).toEqual([]);
		expect(harness.readCardDecisions("foo", "restart")).toMatchObject([
			{
				taskId: "a5e91",
				answer: { kind: "recreate_qa" },
				outcome: "acted",
				note: expect.stringContaining(
					"handed to the QA gate, which supersedes it and queues a new QA card for d6f75's snapshot snap-d6f",
				),
			},
		]);
		// The gate: the old QA card is superseded and goes to Done unlanded, a new one is queued for the same snapshot.
		const state = await harness.store.load("foo");
		expect(readQaGateEntry(state.cards.a5e91)).toMatchObject({
			status: "superseded",
			supersededAt: T0,
			trashed: true,
		});
		expect(readRecoveryFlow(state.cards.a5e91).orphan).toMatchObject({ kind: "qa" });
		expect(readQaGateEntry(state.cards.qa001)).toMatchObject({
			status: "queued",
			reviewsTaskId: "d6f75",
			snapshot: "snap-d6f75",
			round: 1,
		});
		expect(state.cards.d6f75).toMatchObject({ qaCreated: "snap-d6f75", qaCard: "qa001" });
		expect(kinds()).toEqual(["createTask:qa001", "finishTask:a5e91"]);
		const gate = harness.readCardDecisions("foo").find((record) => record.taskId === "d6f75");
		expect(gate).toMatchObject({ outcome: "acted" });
		expect(gate?.note).toContain(
			"QA card a5e91 of round 1 for snapshot snap-d6f (in_progress) lost its session with the previous Kanban server (summary running, no process now); restart recovery handed it to the QA gate: superseded",
		);
		expect(gate?.note).toContain("QA card qa001 was created for snapshot snap-d6f");

		expect(
			harness.readDecisions("foo").filter((record) => record.stage === "qa_start" && record.taskId === null),
		).toMatchObject([
			{ note: expect.stringContaining("retired 1 QA card(s) that can no longer give a verdict: a5e91 (for d6f75)") },
		]);
		// The dead card held the only QA slot; it no longer does, so the replacement starts on the next pass.
		harness.actions.length = 0;
		const replacement = createCard({ id: "qa001", role: "qa", reviewsTaskId: "d6f75" });
		await send({ backlog: [replacement], review: [dev], trash: [qa] }, [
			devSession("d6f75"),
			deadQaSession("a5e91", "interrupted"),
		]);
		expect(kinds()).toEqual(["startTask:qa001"]);
		expect(harness.readCardDecisions("foo").at(-1)?.note).toContain(
			"QA card qa001 (backlog) already reviews this card",
		);
	});

	it("keeps a held runoff PASS held, and decides the runoff once the sibling's replacement QA card passes", async () => {
		const { harness, send, kinds, releases, readRunoffsFile } = setup({
			runoff: { name: "tier2-promos", cards: ["d8558", "d8d02"] },
		});
		await harness.store.update("foo", (state) => ({
			...state,
			cards: {
				...state.cards,
				// 85584: PASS before the restart, held for its runoff group, waiting on its sibling.
				d8558: {
					qaCreated: "snap-d8558",
					qaCard: "c7a61",
					qaVerdicts: [
						{
							qaTaskId: "c7a61",
							round: 1,
							snapshot: "snap-d8558",
							verdict: "PASS",
							blocking: [],
							notes: "",
							scores: PASS.scores,
							visual: PASS.visual,
							artifactsDir: null,
							at: BEFORE,
						},
					],
					qaPass: {
						qaTaskId: "c7a61",
						snapshot: "snap-d8558",
						at: BEFORE,
						action: "hold",
						status: null,
						error: null,
					},
					hold: { group: "tier2-promos", at: new Date(BEFORE).toISOString(), round: 1 },
				},
				c7a61: {
					qaGate: { ...runningQaEntry("c7a61", "d8558"), status: "ingested", verdict: "PASS", trashed: true },
				},
				// Its sibling's QA card was running when Kanban restarted.
				d8d02: { qaCreated: "snap-d8d02", qaCard: "257a4" },
				"257a4": { qaGate: runningQaEntry("257a4", "d8d02") },
			},
		}));
		const held = createCard({ id: "d8558", ...DEV });
		const sibling = createCard({ id: "d8d02", ...DEV });
		const orphanQa = createCard({ id: "257a4", role: "qa", reviewsTaskId: "d8d02" });

		await send({ in_progress: [orphanQa], review: [held, sibling] }, [
			devSession("d8558"),
			devSession("d8d02"),
			deadQaSession("257a4", "interrupted"),
		]);
		expect(kinds()).toEqual(["createTask:qa001", "finishTask:257a4"]);
		expect((await harness.store.load("foo")).cards.d8558?.hold).toMatchObject({ group: "tier2-promos" });
		expect(harness.readCardDecisions("foo").find((record) => record.taskId === "d8558")?.note).toContain(
			"snapshot snap-d85 already has QA card c7a61 (round 1, created 2026-10-07T22:42:56.000Z, ingested, PASS); no new QA card",
		);
		expect(releases).toEqual([]);

		const replacement = createCard({ id: "qa001", role: "qa", reviewsTaskId: "d8d02" });
		await send({ backlog: [replacement], review: [held, sibling], trash: [orphanQa] }, [
			devSession("d8558"),
			devSession("d8d02"),
		]);
		expect(kinds().at(-1)).toBe("startTask:qa001");
		expect(releases).toEqual([]);

		// The replacement passes: the sibling's PASS is held too, and the runoff is decided with both.
		harness.setVerdict("/tmp/kanban-qa-out/qa001", { kind: "ok", verdict: PASS });
		harness.setNow(T0 + 60_000);
		await send({ review: [held, sibling, replacement], trash: [orphanQa] }, [
			devSession("d8558"),
			devSession("d8d02"),
			// Started by this server; its Review has settled.
			{ taskId: "qa001", agentId: "codex", state: "awaiting_review", startedAt: T0, stateChangedAt: T0, live: true },
		]);
		const state = await harness.store.load("foo");
		expect(state.cards.d8d02?.qaPass).toMatchObject({ qaTaskId: "qa001", action: "hold" });
		expect(releases.map((release) => [release.taskId, release.decision]).sort()).toEqual([
			["d8558", expect.stringMatching(/^(land|discard)$/)],
			["d8d02", expect.stringMatching(/^(land|discard)$/)],
		]);
		expect(new Set(releases.map((release) => release.decision))).toEqual(new Set(["land", "discard"]));
		expect((await readRunoffsFile())?.runoffs[0]).toMatchObject({
			name: "tier2-promos",
			decided: expect.any(String),
		});
	});
});
