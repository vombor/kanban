import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardColumnId } from "../../../../src/core/api-contract";
import { getBuiltInKits, getDefaultKit } from "../../../../src/kits/resolve-kit";
import { createRunoffsFeature, RUNOFF_ACTION_ATTEMPTS } from "../../../../src/kits/team/runoffs/runoffs-feature";
import { readRunoffs } from "../../../../src/kits/team/runoffs/runoffs-store";
import { createPipelineEventBus } from "../../../../src/pipeline/events";
import { createPipelineFeatureRegistry, type PipelineFeatureActions } from "../../../../src/pipeline/features";
import type { ReleaseHoldInput, ReleaseHoldResult } from "../../../../src/pipeline/hold";
import type { PipelineWorkspaceState } from "../../../../src/pipeline/pipeline-state";
import type { QaVerdict } from "../../../../src/pipeline/qa-verdict";
import { createEffectiveCard } from "../../../utilities/effective-card";
import { createPipelineWorkerHarness, createSnapshot } from "../../../utilities/pipeline-worker";
import { createTempDir } from "../../../utilities/temp-dir";
import { createBoard, createCard } from "../../../utilities/workspace-state-store";

function teamKit() {
	const kit = getBuiltInKits().get("team");
	if (!kit) {
		throw new Error("team kit missing");
	}
	return kit;
}

const RUNOFF = { name: "tier3-multiregion", cards: ["0789a", "b41c8"], decided: null };

/** A card's pipeline-state entry with a PASS held for the runoff (what the QA gate and decideOnPass write). */
function heldEntry(id: string, scores: Record<string, number | null>, options: { fails?: number } = {}) {
	const verdicts = [
		...Array.from({ length: options.fails ?? 0 }, (_, index) => ({
			qaTaskId: `qa-${id}-${index}`,
			round: index + 1,
			snapshot: "old",
			verdict: "FAIL",
			scores: null,
		})),
		{ qaTaskId: `qa-${id}`, round: (options.fails ?? 0) + 1, snapshot: `snap-${id}`, verdict: "PASS", scores },
	];
	return {
		qaVerdicts: verdicts,
		qaPass: { qaTaskId: `qa-${id}`, snapshot: `snap-${id}`, at: 1, action: "hold", status: null, error: null },
		hold: { group: RUNOFF.name, at: "2026-10-06T03:38:23.305Z", round: (options.fails ?? 0) + 1 },
	};
}

describe("runoffs feature", () => {
	let temp: ReturnType<typeof createTempDir> | null = null;
	afterEach(() => {
		temp?.cleanup();
		temp = null;
	});

	function setup(
		runoffs: unknown[],
		options: { release?: (input: Omit<ReleaseHoldInput, "workspaceId" | "workspacePath">) => ReleaseHoldResult } = {},
	) {
		temp = createTempDir("kanban-runoffs-feature-");
		const path = join(temp.path, "data", "foo", "runoffs.json");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ runoffs }));
		const releases: Array<Omit<ReleaseHoldInput, "workspaceId" | "workspacePath">> = [];
		const unholds: string[] = [];
		const qaLog: string[] = [];
		const actions: PipelineFeatureActions = {
			releaseHold: vi.fn(async (_workspaceId, input) => {
				releases.push(input);
				return (
					options.release?.(input) ?? {
						ok: true as const,
						tag: input.tag ?? null,
						result: { ok: true, status: "trashed" } as never,
					}
				);
			}),
			unhold: async (_workspaceId, input) => {
				unholds.push(input.taskId);
				return true;
			},
			appendQaLog: async (_workspaceId, text) => {
				qaLog.push(text);
			},
		};
		const registry = createPipelineFeatureRegistry({ bus: createPipelineEventBus(), actions });
		registry.register(
			createRunoffsFeature({
				getRunoffsPath: () => path,
				readSnapshot: async (_repo, taskId) => `snap-${taskId}`,
				readCost: async (_workspaceId, taskId) => (taskId === "b41c8" ? 1.66 : null),
				now: () => Date.parse("2026-10-06T03:38:25.223Z"),
			}),
		);
		return { path, registry, releases, unholds, qaLog };
	}

	const tick = async (
		registry: ReturnType<typeof setup>["registry"],
		columns: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>,
		cards: PipelineWorkspaceState["cards"],
	) => {
		await registry.tick("foo", {
			snapshot: createSnapshot({ workspaceId: "foo", board: createBoard(columns), selectedAgentId: "claude" }),
			state: { version: 1, since: "2026-10-06T00:00:00.000Z", importedFrom: null, cards },
			now: 0,
		});
	};

	const luna = createCard({ id: "0789a", agentId: "cline", agentSettings: { modelId: "us.openai.gpt-6-luna" } });
	const sol = createCard({ id: "b41c8", agentId: "cline", agentSettings: { modelId: "us.openai.gpt-6.1-sol" } });

	it("holds the PASS of a card in an open runoff and lets every other PASS land", async () => {
		const { registry, qaLog } = setup([
			RUNOFF,
			{ name: "old", cards: ["d1111"], decided: "2026-10-05", winner: "d1111" },
		]);
		registry.syncWorkspace("foo", teamKit());
		const verdict = { verdict: "PASS" as const, round: 2 };

		const runoffCard = { ...createEffectiveCard({ agentId: "cline" }), card: luna };
		expect(await registry.answerOnPass("foo", { dev: runoffCard, verdict })).toEqual({
			action: "hold",
			group: "tier3-multiregion",
		});
		expect(qaLog[0]).toContain("## RUNOFF HOLD 0789a: QA PASS r2 held for runoff tier3-multiregion");
		const decidedCard = { ...createEffectiveCard({ agentId: "cline" }), card: createCard({ id: "d1111" }) };
		expect(await registry.answerOnPass("foo", { dev: decidedCard, verdict })).toBeNull();
		// Not on a kit without the feature (default): the kit answers.
		registry.syncWorkspace("foo", getDefaultKit());
		expect(await registry.answerOnPass("foo", { dev: runoffCard, verdict })).toBeNull();
	});

	it("a decided runoff's winner lands its next PASS; a loser's (or a bench-only card's) PASS is held, never landed", async () => {
		const { registry, qaLog } = setup([
			{ ...RUNOFF, decided: "2026-10-08T01:04:17.000Z", winner: "b41c8" },
			{ name: "rerun", cards: ["d3333"], decided: "2026-10-08T01:04:17.000Z", winner: "d3333", benchOnly: true },
		]);
		registry.syncWorkspace("foo", teamKit());
		const verdict = { verdict: "PASS" as const, round: 3 };
		const answer = async (card: RuntimeBoardCard) =>
			await registry.answerOnPass("foo", { dev: { ...createEffectiveCard({ agentId: "cline" }), card }, verdict });

		// The winner's land conflicted, it was reworked (a rebase) and QA'd again: the kit answers, so it lands.
		expect(await answer(sol)).toBeNull();
		expect(qaLog).toEqual([]);
		expect(await answer(luna)).toEqual({ action: "hold", group: "tier3-multiregion" });
		expect(qaLog[0]).toContain("## RUNOFF HOLD 0789a: QA PASS r3 held, never landed");
		expect(qaLog[0]).toContain("decided (winner b41c8)");
		expect(qaLog[0]).toContain("kanban task release-hold --task-id 0789a --discard");
		expect(await answer(createCard({ id: "d3333" }))).toEqual({ action: "hold", group: "rerun" });
		expect(qaLog[1]).toContain("bench only, nothing lands");
	});

	it("keeps the rework stage's runoff groups: recorded in runoffs.json, then every racing card's PASS is held", async () => {
		const { path, registry } = setup([]);
		expect(registry.runoffGroups.forWorkspace("foo")).toBeNull();
		registry.syncWorkspace("foo", teamKit());
		const groups = registry.runoffGroups.forWorkspace("foo");
		if (!groups) {
			throw new Error("no runoff groups for a team workspace");
		}
		const group = {
			name: "d1111-r1",
			from: "d1111",
			round: 1,
			baseRef: "main",
			cards: [
				{
					taskId: "d1111",
					agentId: "cline" as const,
					model: { provider: "bedrock", model: "us.openai.gpt-6.1-sol" },
				},
				{
					taskId: "s0001",
					agentId: "cline" as const,
					model: { provider: "bedrock", model: "us.moonshotai.kimi-k3" },
				},
				{ taskId: "s0002", agentId: "codex" as const, model: { provider: null, model: "gpt-6.1" } },
			],
		};

		await groups.record(group);
		// The stage drops a sibling it could not create: the same group is replaced, not added twice.
		await groups.record({ ...group, cards: group.cards.slice(0, 2) });

		const { runoffs } = await readRunoffs(path);
		expect(runoffs).toEqual([
			{
				name: "d1111-r1",
				cards: ["d1111", "s0001"],
				models: { d1111: "bedrock/us.openai.gpt-6.1-sol", s0001: "bedrock/us.moonshotai.kimi-k3" },
				base: "main",
				prompt: "card d1111 (onFail.runoff after its FAIL round 1)",
				createdAt: "2026-10-06T03:38:25.223Z",
				from: "d1111",
				round: 1,
				decided: null,
			},
		]);
		expect(await groups.groupOf("s0001")).toBe("d1111-r1");
		expect(await groups.groupOf("s0002")).toBeNull();
		for (const id of ["d1111", "s0001"]) {
			const dev = { ...createEffectiveCard({ agentId: "cline" }), card: createCard({ id }) };
			expect(await registry.answerOnPass("foo", { dev, verdict: { verdict: "PASS", round: 2 } })).toEqual({
				action: "hold",
				group: "d1111-r1",
			});
		}

		// An abandoned group (no sibling could be created) holds nothing.
		await groups.record({ ...group, cards: group.cards.slice(0, 1), abandoned: "no sibling card could be created" });
		expect(await groups.groupOf("d1111")).toBeNull();
		// Not provided for a workspace whose kit doesn't run the feature.
		registry.syncWorkspace("foo", getDefaultKit());
		expect(registry.runoffGroups.forWorkspace("foo")).toBeNull();
	});

	it("refuses to answer (so nothing lands) when runoffs.json can't be read", async () => {
		const { path, registry } = setup([RUNOFF]);
		writeFileSync(path, "{ not json");
		registry.syncWorkspace("foo", teamKit());
		await expect(
			registry.answerOnPass("foo", {
				dev: { ...createEffectiveCard({ agentId: "cline" }), card: luna },
				verdict: { verdict: "PASS", round: 1 },
			}),
		).rejects.toThrow("feature runoffs failed to answer onPass");
	});

	it("waits for every card, then discards the loser with its preserve tag and lands the winner, once", async () => {
		const { path, registry, releases, qaLog } = setup([RUNOFF]);
		registry.syncWorkspace("foo", teamKit());
		const lunaEntry = heldEntry("0789a", { spec: 4, correctness: 4, tests: 3 }, { fails: 1 });
		const solEntry = heldEntry("b41c8", { spec: 4, correctness: 4, tests: 4, ux: null }, { fails: 1 });

		await tick(registry, { review: [luna], in_progress: [sol] }, { "0789a": lunaEntry });
		expect(releases).toEqual([]);
		expect((await readRunoffs(path)).runoffs[0]?.decided).toBeNull();

		await tick(registry, { review: [luna, sol] }, { "0789a": lunaEntry, b41c8: solEntry });
		expect(releases).toEqual([
			{ taskId: "0789a", decision: "discard", tag: "preserve/0789a-gpt-6-luna" },
			{ taskId: "b41c8", decision: "land" },
		]);
		const [decided] = (await readRunoffs(path)).runoffs;
		expect(decided).toMatchObject({
			decided: "2026-10-06T03:38:25.223Z",
			winner: "b41c8",
			results: [
				{ id: "0789a", out: "pass", score: 3.67, fails: 1, cost: null, model: "us.openai.gpt-6-luna", round: 2 },
				{ id: "b41c8", out: "pass", score: 4, fails: 1, cost: 1.66, model: "us.openai.gpt-6.1-sol", round: 2 },
			],
			actions: { "0789a": "discarded, tag preserve/0789a-gpt-6-luna", b41c8: "landed" },
		});
		expect(qaLog.at(-2)).toContain("## RUNOFF tier3-multiregion: b41c8 (us.openai.gpt-6.1-sol) wins");
		expect(qaLog.at(-1)).toContain(
			"- 0789a: lost; work kept as tag preserve/0789a-gpt-6-luna; card discarded to Done",
		);
		expect(qaLog.at(-1)).toContain("- b41c8: won; landed and Done");

		await tick(registry, { review: [luna, sol] }, { "0789a": lunaEntry, b41c8: solEntry });
		expect(releases).toHaveLength(2);
	});

	it("benchOnly: every PASS is preserved and discarded, nothing lands", async () => {
		const { registry, releases, qaLog } = setup([{ ...RUNOFF, benchOnly: true }]);
		registry.syncWorkspace("foo", teamKit());

		await tick(
			registry,
			{ review: [luna, sol] },
			{ "0789a": heldEntry("0789a", { spec: 3 }), b41c8: heldEntry("b41c8", { spec: 5 }) },
		);

		expect(releases).toEqual([
			{ taskId: "b41c8", decision: "discard", tag: "preserve/b41c8-gpt-6.1-sol" },
			{ taskId: "0789a", decision: "discard", tag: "preserve/0789a-gpt-6-luna" },
		]);
		expect(qaLog.at(-2)).toContain("(bench only, nothing lands)");
		expect(qaLog.at(-1)).toContain("- b41c8: won (bench only)");
	});

	it("a winner whose land conflicts leaves the hold for the rework stage; the decision is not retried", async () => {
		const { path, registry, releases, qaLog } = setup([RUNOFF], {
			release: (input) =>
				input.decision === "land"
					? { ok: false, code: "conflict", error: "conflicts in src/cart.ts" }
					: { ok: true, tag: input.tag ?? null, result: { ok: true, status: "trashed" } as never },
		});
		registry.syncWorkspace("foo", teamKit());
		const cards = { "0789a": heldEntry("0789a", { spec: 3 }), b41c8: heldEntry("b41c8", { spec: 5 }) };

		await tick(registry, { review: [luna, sol] }, cards);
		await tick(registry, { review: [luna, sol] }, cards);

		expect(releases.map((release) => `${release.taskId}:${release.decision}`)).toEqual([
			"0789a:discard",
			"b41c8:land",
		]);
		const [runoff] = (await readRunoffs(path)).runoffs;
		expect(runoff?.pending).toBeUndefined();
		expect(runoff?.actions).toMatchObject({ b41c8: "land conflict: sent back for a rebase" });
		expect(qaLog.at(-1)).toContain("b41c8: won, but its land conflicts (conflicts in src/cart.ts)");
	});

	it("retries a failing discard on later ticks, then names kanban task release-hold", async () => {
		const { path, registry, releases, qaLog } = setup([{ ...RUNOFF, benchOnly: true }], {
			release: (input) =>
				input.taskId === "0789a"
					? { ok: false, error: "server busy" }
					: { ok: true, tag: input.tag ?? null, result: { ok: true, status: "trashed" } as never },
		});
		registry.syncWorkspace("foo", teamKit());
		const cards = { "0789a": heldEntry("0789a", { spec: 3 }), b41c8: heldEntry("b41c8", { spec: 5 }) };

		await tick(registry, { review: [luna, sol] }, cards);
		expect((await readRunoffs(path)).runoffs[0]?.pending).toMatchObject([{ taskId: "0789a", attempts: 1 }]);
		await tick(registry, { review: [luna, sol] }, cards);
		await tick(registry, { review: [luna, sol] }, cards);
		await tick(registry, { review: [luna, sol] }, cards);

		expect(releases.filter((release) => release.taskId === "0789a")).toHaveLength(RUNOFF_ACTION_ATTEMPTS);
		const [runoff] = (await readRunoffs(path)).runoffs;
		expect(runoff?.pending).toBeUndefined();
		expect(runoff?.actions).toMatchObject({ "0789a": "discard failed 3 times: server busy" });
		expect(qaLog.at(-1)).toContain(
			"kanban task release-hold --task-id 0789a --discard --tag preserve/0789a-gpt-6-luna",
		);
	});

	it("resumes a decision whose actions a crash left undone", async () => {
		const { path, registry, releases } = setup([
			{
				...RUNOFF,
				decided: "2026-10-06T03:38:25.223Z",
				winner: "b41c8",
				pending: [{ taskId: "b41c8", action: "land", tag: null, label: "won", attempts: 0 }],
			},
		]);
		registry.syncWorkspace("foo", teamKit());

		await tick(registry, { review: [sol] }, { b41c8: heldEntry("b41c8", { spec: 5 }) });

		expect(releases).toEqual([{ taskId: "b41c8", decision: "land" }]);
		expect((await readRunoffs(path)).runoffs[0]).toMatchObject({ actions: { b41c8: "landed" } });
		expect((await readRunoffs(path)).runoffs[0]?.pending).toBeUndefined();
	});

	it("a runoff closed by hand unholds its other held cards for a human, landing and discarding nothing", async () => {
		const { registry, releases, unholds, qaLog } = setup([RUNOFF]);
		registry.syncWorkspace("foo", teamKit());

		await tick(registry, { trash: [luna], review: [sol] }, { b41c8: heldEntry("b41c8", { spec: 5 }) });

		expect(releases).toEqual([]);
		expect(unholds).toEqual(["b41c8"]);
		expect(qaLog.join("\n")).toContain("b41c8: unheld, left in Review for a human");
	});

	it("only closes a runoff whose cards were trashed by hand, touching no card (tier2-coupons 10/06)", async () => {
		const { path, registry, releases } = setup([RUNOFF]);
		registry.syncWorkspace("foo", teamKit());

		await tick(registry, { trash: [luna, sol] }, {});

		expect(releases).toEqual([]);
		expect((await readRunoffs(path)).runoffs[0]).toMatchObject({
			winner: null,
			results: [
				{ id: "0789a", out: "done" },
				{ id: "b41c8", out: "done" },
			],
			note: expect.stringContaining("no winner"),
		});
	});

	it("counts an escalated card as finished (qaflow.escalated, or parked in Backlog as BLOCKED:)", async () => {
		const { registry, releases } = setup([RUNOFF]);
		registry.syncWorkspace("foo", teamKit());
		const blocked = createCard({ id: "b41c8", title: "BLOCKED: tier3 card", agentId: "cline" });

		await tick(registry, { review: [luna], backlog: [blocked] }, { "0789a": heldEntry("0789a", { spec: 4 }) });

		expect(releases).toEqual([{ taskId: "0789a", decision: "land" }]);
	});
});

describe("runoffs feature in the pipeline worker", () => {
	const harnesses: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	const DEV = {
		agentId: "cline" as const,
		agentSettings: { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" },
	};
	const verdict: QaVerdict = {
		verdict: "PASS",
		scores: { spec: 5, correctness: 4, tests: 4, ux: null, code: 4, process: 5 },
		blocking: [],
		visual: { status: "n/a", artifacts: [], consoleErrors: 0 },
		notes: "",
		log: "",
	};

	it("holds a runoff card's QA PASS in Review instead of landing it, and a newer PASS refreshes the hold", async () => {
		let snapshot = "snap-d1111";
		const releaseHold = vi.fn();
		const harness = createPipelineWorkerHarness({
			config: { workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team" } } } },
			snapshot: (taskId) => (taskId === "d1111" ? snapshot : `snap-${taskId}`),
			createFeatures: ({ bus, appendQaLog, root }) => {
				const path = join(root, "data", "foo", "runoffs.json");
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, JSON.stringify({ runoffs: [{ name: "race", cards: ["d1111", "d2222"] }] }));
				const registry = createPipelineFeatureRegistry({ bus, actions: { releaseHold, appendQaLog } });
				registry.register(createRunoffsFeature({ getRunoffsPath: () => path, readSnapshot: async () => snapshot }));
				return registry;
			},
		});
		harnesses.push(harness);
		const send = async (columns: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>) =>
			await harness.send(
				createSnapshot({ workspaceId: "foo", board: createBoard(columns), selectedAgentId: "claude" }),
			);
		const dev = createCard({ id: "d1111", ...DEV });
		const other = createCard({ id: "d2222", ...DEV });

		await send({ review: [dev], in_progress: [other] });
		await send({
			backlog: [createCard({ id: "qa001", role: "qa", reviewsTaskId: "d1111" })],
			review: [dev],
			in_progress: [other],
		});
		harness.setVerdict("/tmp/kanban-qa-out/qa001", { kind: "ok", verdict });
		await send({
			review: [dev, createCard({ id: "qa001", role: "qa", reviewsTaskId: "d1111" })],
			in_progress: [other],
		});

		expect(harness.actions.filter((action) => action.kind === "finishTask").map((action) => action.taskId)).toEqual([
			"qa001",
		]);
		const state = await harness.store.load("foo");
		expect(state.cards.d1111?.hold).toMatchObject({ group: "race", round: 1 });
		expect(readFileSync(harness.qaLogPath("foo"), "utf8")).toContain("RUNOFF HOLD d1111");
		expect(harness.readCardDecisions("foo", "qa_pass")[0]?.note).toBe("PASS of round 1 held for race");
		// d2222 still works: nothing is decided.
		expect(releaseHold).not.toHaveBeenCalled();

		// Reworked after the hold: the new snapshot is QA'd again and its PASS refreshes the hold (round 2).
		snapshot = "snap-d1111-v2";
		await send({ review: [dev], in_progress: [other] });
		await send({
			backlog: [createCard({ id: "qa002", role: "qa", reviewsTaskId: "d1111" })],
			review: [dev],
			in_progress: [other],
		});
		harness.setVerdict("/tmp/kanban-qa-out/qa002", { kind: "ok", verdict });
		await send({
			review: [dev, createCard({ id: "qa002", role: "qa", reviewsTaskId: "d1111" })],
			in_progress: [other],
		});

		const after = await harness.store.load("foo");
		expect(after.cards.d1111?.hold).toMatchObject({ group: "race", round: 2 });
		expect(after.cards.d1111?.qaPass).toMatchObject({ qaTaskId: "qa002", snapshot: "snap-d1111-v2", action: "hold" });
		expect(harness.actions.filter((action) => action.kind === "finishTask").map((action) => action.taskId)).toEqual([
			"qa001",
			"qa002",
		]);
	});

	it("lands a decided runoff's winner after a land conflict once its rebase passes QA; a loser's PASS stays held", async () => {
		const releaseHold = vi.fn();
		const harness = createPipelineWorkerHarness({
			config: { workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team" } } } },
			snapshot: (taskId) => `snap-${taskId}-rebased`,
			createFeatures: ({ bus, appendQaLog, root }) => {
				const path = join(root, "data", "foo", "runoffs.json");
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(
					path,
					JSON.stringify({
						runoffs: [
							{
								name: "tier2-promos",
								cards: ["d1111", "d2222"],
								decided: "2026-10-08T01:04:17.000Z",
								winner: "d1111",
								actions: { d1111: "land conflict: sent back for a rebase", d2222: "discarded" },
							},
						],
					}),
				);
				const registry = createPipelineFeatureRegistry({ bus, actions: { releaseHold, appendQaLog } });
				registry.register(createRunoffsFeature({ getRunoffsPath: () => path }));
				return registry;
			},
		});
		harnesses.push(harness);
		// What the decision's conflicting land left: the hold released with a conflict, the PASS recorded as a land.
		await harness.store.update("foo", (state) => {
			state.cards.d1111 = {
				holdReleases: [
					{ at: "2026-10-08T01:04:18.000Z", group: "tier2-promos", decision: "land", tag: null, conflict: true },
				],
			};
			return state;
		});
		const send = async (columns: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>) =>
			await harness.send(
				createSnapshot({ workspaceId: "foo", board: createBoard(columns), selectedAgentId: "claude" }),
			);
		const winner = createCard({ id: "d1111", ...DEV });
		const loser = createCard({ id: "d2222", ...DEV });

		await send({ review: [winner, loser] });
		await send({
			backlog: [
				createCard({ id: "qa001", role: "qa", reviewsTaskId: "d1111" }),
				createCard({ id: "qa002", role: "qa", reviewsTaskId: "d2222" }),
			],
			review: [winner, loser],
		});
		harness.setVerdict("/tmp/kanban-qa-out/qa001", { kind: "ok", verdict });
		harness.setVerdict("/tmp/kanban-qa-out/qa002", { kind: "ok", verdict });
		await send({
			review: [
				winner,
				loser,
				createCard({ id: "qa001", role: "qa", reviewsTaskId: "d1111" }),
				createCard({ id: "qa002", role: "qa", reviewsTaskId: "d2222" }),
			],
		});

		const finished = harness.actions.filter((action) => action.kind === "finishTask");
		expect(finished.filter((action) => action.taskId === "d1111")).toEqual([
			expect.objectContaining({ taskId: "d1111", landing: "land", trigger: "pipeline" }),
		]);
		expect(finished.some((action) => action.taskId === "d2222")).toBe(false);
		const state = await harness.store.load("foo");
		expect(state.cards.d1111?.hold).toBeUndefined();
		expect(state.cards.d2222?.hold).toMatchObject({ group: "tier2-promos" });
		expect(readFileSync(harness.qaLogPath("foo"), "utf8")).toContain(
			"RUNOFF HOLD d2222: QA PASS r1 held, never landed",
		);
		expect(releaseHold).not.toHaveBeenCalled();
	});

	it("does nothing on a shadow workspace", async () => {
		const tickHandler = vi.fn();
		const harness = createPipelineWorkerHarness({
			config: {
				workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team" }, pipeline: { shadow: true } } },
			},
			createFeatures: ({ bus }) => {
				const registry = createPipelineFeatureRegistry({ bus });
				registry.register({
					name: "runoffs",
					activate: (context) => {
						context.onTick(tickHandler);
						return undefined;
					},
				});
				return registry;
			},
		});
		harnesses.push(harness);
		await harness.send(
			createSnapshot({
				workspaceId: "foo",
				board: createBoard({ review: [createCard({ id: "d1111", ...DEV })] }),
				selectedAgentId: "claude",
			}),
		);
		expect(tickHandler).not.toHaveBeenCalled();
	});
});
