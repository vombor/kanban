import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getWorkspacePipelineSettings, parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { RuntimeBoardCard, RuntimeBoardColumnId } from "../../../src/core/api-contract";
import { createRoutingPolicy } from "../../../src/kits/policy";
import { getDefaultKit, loadKitCatalog } from "../../../src/kits/resolve-kit";
import { createPipelineDecisionLog, type PipelineDecisionRecord } from "../../../src/pipeline/decision-log";
import { evaluatePipelineWorkspace } from "../../../src/pipeline/engine";
import type { PipelineEventMap } from "../../../src/pipeline/events";
import type { PipelineHold } from "../../../src/pipeline/hold";
import { createAutoReviewReconciler } from "../../../src/server/auto-review-reconciler";
import { createTaskLandingGate } from "../../../src/server/task-landing-gate";
import { createTaskTrashWorkflow, type TaskTrashTrigger } from "../../../src/server/task-trash-workflow";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createLandRepo } from "../../utilities/land-repo";
import {
	createBoard,
	createCard,
	createFakeTaskTrashWorkflowDependencies,
	createWorkspaceStateStore,
	findCardInBoard,
} from "../../utilities/workspace-state-store";

const WORKSPACE_ID = "foo";

type Repo = ReturnType<typeof createLandRepo>;

function landingConfig(mode: "off" | "commit" | "pr" | "qa", extra: Record<string, unknown> = {}) {
	return { workspaces: { [WORKSPACE_ID]: { landing: { mode }, ...extra } } };
}

/** The landing gate inside the real Done workflow, on a temp repository, with an in-memory board. */
function createHarness(input: {
	repo: Repo;
	config: unknown;
	cards: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>;
	worktrees?: Record<string, string>;
	holds?: Record<string, PipelineHold>;
}) {
	const logPath = join(input.repo.root, "data", WORKSPACE_ID, "pipeline-decisions.jsonl");
	const landed: Array<PipelineEventMap["landed"]> = [];
	const gate = createTaskLandingGate({
		readConfig: async () => parsePipelineConfig(input.config),
		loadCatalog: async () => await loadKitCatalog(join(input.repo.root, "kits")),
		readHold: async (_workspaceId, taskId) => input.holds?.[taskId] ?? null,
		findWorktree: async (_workspacePath, card) => input.worktrees?.[card.id] ?? null,
		decisionLog: createPipelineDecisionLog({ getLogPath: () => logPath }),
		onLanded: (event) => landed.push(event),
		now: () => Date.parse("2026-10-07T12:00:00.000Z"),
	});
	const store = createWorkspaceStateStore({ board: createBoard(input.cards), sessions: {}, revision: 1 });
	const effects = createFakeTaskTrashWorkflowDependencies(store);
	const workflow = createTaskTrashWorkflow({ ...effects.dependencies, doneGate: gate, now: () => 1_000 });
	const done = (
		taskId: string,
		options: { landing?: "land" | "discard"; trigger?: TaskTrashTrigger; canTrash?: () => boolean } = {},
	) =>
		workflow.trashTask({
			workspaceId: WORKSPACE_ID,
			workspacePath: input.repo.repoPath,
			taskId,
			trigger: options.trigger ?? "browser",
			landing: options.landing,
			...(options.canTrash ? { canTrash: options.canTrash } : {}),
		});
	const readDecisions = (): PipelineDecisionRecord[] =>
		existsSync(logPath)
			? readFileSync(logPath, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as PipelineDecisionRecord)
			: [];
	const columnOf = (taskId: string) => findCardInBoard(store.stored.board, taskId)?.columnId ?? null;
	return { done, store, effects, landed, readDecisions, columnOf };
}

/** A repo with a task worktree that changed src/app.ts. */
function repoWithWork(taskId = "dev01") {
	const repo = createLandRepo();
	const worktree = repo.addWorktree(taskId);
	repo.write(worktree, "src/app.ts", "export const value = 2;\n");
	return { repo, worktree };
}

describe("landing modes", () => {
	let repo: Repo | null = null;
	afterEach(() => {
		repo?.cleanup();
		repo = null;
	});

	it.each(["off", "commit", "pr"] as const)(
		"landing %s: Done is unchanged and nothing lands, even with land",
		async (mode) => {
			const setup = repoWithWork();
			repo = setup.repo;
			const before = repo.tip();
			const harness = createHarness({
				repo,
				config: landingConfig(mode),
				cards: { review: [createCard({ id: "dev01" })] },
				worktrees: { dev01: setup.worktree },
			});

			const result = await harness.done("dev01", { landing: "land", trigger: "approve" });

			expect(result).toMatchObject({ ok: true, status: "trashed" });
			expect(result.landing).toBeUndefined();
			expect(repo.tip()).toBe(before);
			expect(harness.readDecisions()).toEqual([]);
		},
	);

	it("a workspace with no config entry (landing off on the default kit) never asks", async () => {
		const setup = repoWithWork();
		repo = setup.repo;
		const harness = createHarness({
			repo,
			config: {},
			cards: { review: [createCard({ id: "dev01" })] },
			worktrees: { dev01: setup.worktree },
		});

		expect(await harness.done("dev01")).toMatchObject({ ok: true, status: "trashed" });
	});

	it("off arms nothing: the auto-review reconciler leaves a card without auto-review alone", async () => {
		const store = createWorkspaceStateStore({
			board: createBoard({ review: [createCard({ id: "dev01" })] }),
			sessions: {},
			revision: 1,
		});
		const trashTask = vi.fn();
		const probeTaskWorkspace = vi.fn(async () => ({ exists: true, headCommit: "abc", changedFiles: 3 }));
		const reconciler = createAutoReviewReconciler({
			listWorkspaces: () => [
				{
					workspaceId: WORKSPACE_ID,
					workspacePath: "/repo",
					terminalManager: { getSummary: () => ({ taskId: "dev01" }) } as unknown as TerminalSessionManager,
				},
			],
			getWorkspaceState: store.getWorkspaceState,
			mutateWorkspaceState: store.mutateWorkspaceState,
			getPromptTemplates: async () => null,
			probeTaskWorkspace,
			trashTask,
		});

		await reconciler.evaluateWorkspace(WORKSPACE_ID);
		reconciler.close();

		expect(probeTaskWorkspace).not.toHaveBeenCalled();
		expect(trashTask).not.toHaveBeenCalled();
		expect(findCardInBoard(store.stored.board, "dev01")?.card.pendingGitAction ?? null).toBeNull();
	});

	describe("qa", () => {
		it("qaPolicy none (the default kit) decides no QA, and the card waits for Approve & land", async () => {
			const card = createCard({ id: "dev01" });
			const decisions = await evaluatePipelineWorkspace({
				snapshot: {
					workspaceId: WORKSPACE_ID,
					workspacePath: "/repo",
					board: createBoard({ review: [card] }),
					sessions: [],
					selectedAgentId: "claude",
				},
				settings: getWorkspacePipelineSettings(parsePipelineConfig(landingConfig("qa")).config, WORKSPACE_ID),
				kitName: "default",
				policy: createRoutingPolicy(getDefaultKit()),
				state: { version: 1, since: "2026-10-07T00:00:00.000Z", importedFrom: null, cards: {} },
				limits: { maxFailRounds: 3 },
				recoveryNudgeCheckMs: 120_000,
				inspectSubmission: async () => ({ hasWork: true, records: [] }),
				now: 0,
			});

			expect(decisions).toEqual([
				expect.objectContaining({
					taskId: "dev01",
					outcome: "none",
					note: expect.stringContaining("waits for Approve & land"),
				}),
			]);
		});

		it('a manual Done on a card with work asks "land or discard?" and leaves the card and the base alone', async () => {
			const setup = repoWithWork();
			repo = setup.repo;
			const before = repo.tip();
			const harness = createHarness({
				repo,
				config: landingConfig("qa"),
				cards: { review: [createCard({ id: "dev01" })] },
				worktrees: { dev01: setup.worktree },
			});

			const result = await harness.done("dev01");

			expect(result).toMatchObject({
				ok: false,
				status: "blocked",
				landing: { decision: "required", baseRef: "main" },
			});
			expect(result.error).toContain("kanban task approve --task-id dev01");
			expect(harness.columnOf("dev01")).toBe("review");
			expect(harness.effects.stopTaskSession).not.toHaveBeenCalled();
			expect(harness.effects.deleteTaskWorktree).not.toHaveBeenCalled();
			expect(repo.tip()).toBe(before);
			expect(harness.readDecisions()).toEqual([
				expect.objectContaining({ stage: "land", outcome: "none", taskId: "dev01" }),
			]);
		});

		it("asks for a card dragged to Done from any column, not only Review (the legacy Backlog → Done miss)", async () => {
			const setup = repoWithWork();
			repo = setup.repo;
			const harness = createHarness({
				repo,
				config: landingConfig("qa"),
				cards: { backlog: [createCard({ id: "dev01" })] },
				worktrees: { dev01: setup.worktree },
			});

			expect(await harness.done("dev01", { trigger: "cli" })).toMatchObject({
				status: "blocked",
				landing: { decision: "required" },
			});
			expect(harness.columnOf("dev01")).toBe("backlog");
		});

		it("Done passes straight through for a card with no worktree or no work beyond its base", async () => {
			repo = createLandRepo();
			const clean = repo.addWorktree("clean1");
			const harness = createHarness({
				repo,
				config: landingConfig("qa"),
				cards: { backlog: [createCard({ id: "never1" })], review: [createCard({ id: "clean1" })] },
				worktrees: { clean1: clean },
			});

			expect(await harness.done("never1")).toMatchObject({ ok: true, status: "trashed" });
			expect(await harness.done("clean1")).toMatchObject({ ok: true, status: "trashed" });
		});

		it("discard finishes the card without landing", async () => {
			const setup = repoWithWork();
			repo = setup.repo;
			const before = repo.tip();
			const harness = createHarness({
				repo,
				config: landingConfig("qa"),
				cards: { review: [createCard({ id: "dev01" })] },
				worktrees: { dev01: setup.worktree },
			});

			const result = await harness.done("dev01", { landing: "discard" });

			expect(result).toMatchObject({ ok: true, status: "trashed", landing: { decision: "discarded" } });
			expect(repo.tip()).toBe(before);
			expect(harness.effects.deleteTaskWorktree).toHaveBeenCalled();
			expect(harness.landed).toEqual([]);
		});

		it("Approve & land squash-lands onto the base before Done, as HUMAN_APPROVED", async () => {
			const setup = repoWithWork();
			repo = setup.repo;
			const before = repo.tip();
			const harness = createHarness({
				repo,
				config: landingConfig("qa"),
				cards: { review: [createCard({ id: "dev01", title: "Add value 2" })] },
				worktrees: { dev01: setup.worktree },
			});
			harness.effects.deleteTaskWorktree.mockImplementation(async () => {
				// Land first, then Done: the base already has the work when the worktree goes.
				expect(repo?.git(["show", "main:src/app.ts"])).toBe("export const value = 2;");
				return { ok: true, removed: true };
			});

			const result = await harness.done("dev01", { landing: "land", trigger: "approve" });

			const tip = repo.tip();
			expect(tip).not.toBe(before);
			expect(result).toMatchObject({
				ok: true,
				status: "trashed",
				landing: { decision: "landed", baseRef: "main", commit: tip },
			});
			expect(repo.git(["log", "-1", "--format=%s", "main"])).toBe("Add value 2");
			expect(harness.columnOf("dev01")).toBe("trash");
			expect(harness.landed).toEqual([
				{
					workspaceId: WORKSPACE_ID,
					taskId: "dev01",
					at: expect.any(Number),
					baseRef: "main",
					commit: tip,
					via: "approved",
				},
			]);
			expect(harness.readDecisions()).toEqual([
				expect.objectContaining({
					stage: "land",
					outcome: "acted",
					note: expect.stringMatching(/^HUMAN_APPROVED: landed/u),
				}),
			]);
		});

		it("a land from the pipeline (after a QA PASS) is reported as via qa", async () => {
			const setup = repoWithWork();
			repo = setup.repo;
			const harness = createHarness({
				repo,
				config: landingConfig("qa"),
				cards: { review: [createCard({ id: "dev01" })] },
				worktrees: { dev01: setup.worktree },
			});

			await harness.done("dev01", { landing: "land", trigger: "pipeline" });

			expect(harness.landed[0]?.via).toBe("qa");
		});

		it("a conflict keeps the card where it is with the conflicting files, and lands nothing", async () => {
			const setup = repoWithWork();
			repo = setup.repo;
			repo.write(repo.repoPath, "src/app.ts", "export const value = 99;\n");
			repo.commitAll(repo.repoPath, "base moved");
			const before = repo.tip();
			const harness = createHarness({
				repo,
				config: landingConfig("qa"),
				cards: { review: [createCard({ id: "dev01" })] },
				worktrees: { dev01: setup.worktree },
			});

			const result = await harness.done("dev01", { landing: "land", trigger: "approve" });

			expect(result).toMatchObject({
				ok: false,
				status: "blocked",
				landing: { decision: "conflict", files: ["src/app.ts"] },
			});
			expect(harness.columnOf("dev01")).toBe("review");
			expect(harness.effects.deleteTaskWorktree).not.toHaveBeenCalled();
			expect(repo.tip()).toBe(before);
			expect(harness.landed).toEqual([]);
		});

		it("never gates QA, TRIAGE or calibration cards, including legacy kit cards without a role", async () => {
			const setup = repoWithWork("qa001");
			repo = setup.repo;
			const triage = repo.addWorktree("tri01");
			repo.write(triage, "x.txt", "x\n");
			const legacyQa = repo.addWorktree("lqa01");
			repo.write(legacyQa, "x.txt", "x\n");
			const legacyCal = repo.addWorktree("cal01");
			repo.write(legacyCal, "x.txt", "x\n");
			const harness = createHarness({
				repo,
				config: landingConfig("qa"),
				cards: {
					review: [
						createCard({ id: "qa001", role: "qa" }),
						createCard({ id: "tri01", role: "triage" }),
						createCard({ id: "lqa01", title: "QA2 d0001: check the feature" }),
						createCard({ id: "cal01", title: "QA-CAL run 3" }),
					],
				},
				worktrees: { qa001: setup.worktree, tri01: triage, lqa01: legacyQa, cal01: legacyCal },
			});

			for (const id of ["qa001", "tri01", "lqa01", "cal01"]) {
				expect(await harness.done(id)).toMatchObject({ ok: true, status: "trashed" });
			}
			expect(harness.readDecisions()).toEqual([]);
		});

		it("lands a plan card's spec files like docs on a human's land, and gives kit features no landed event", async () => {
			const repo1 = createLandRepo();
			repo = repo1;
			const worktree = repo1.addWorktree("pln01");
			repo1.write(worktree, "docs/specs/coupons.md", "# Coupons\n");
			repo1.write(worktree, "docs/specs/coupons.cards.json", "{}\n");
			const before = repo1.tip();
			const harness = createHarness({
				repo: repo1,
				config: landingConfig("qa"),
				cards: { review: [createCard({ id: "pln01", role: "plan" })] },
				worktrees: { pln01: worktree },
			});

			expect(await harness.done("pln01")).toMatchObject({ status: "blocked", landing: { decision: "required" } });
			expect(repo1.tip()).toBe(before);

			const landed = await harness.done("pln01", { landing: "land", trigger: "approve" });
			expect(landed).toMatchObject({ ok: true, landing: { decision: "landed" } });
			expect(repo1.tip()).not.toBe(before);
			expect(harness.landed).toEqual([]);
			expect(harness.readDecisions().at(-1)).toMatchObject({ taskId: "pln01", role: "plan", outcome: "acted" });
		});

		it("leaves commit/pr auto-review cards to the reconciler", async () => {
			const setup = repoWithWork();
			repo = setup.repo;
			const before = repo.tip();
			const harness = createHarness({
				repo,
				config: landingConfig("qa"),
				cards: { review: [createCard({ id: "dev01", autoReviewEnabled: true, autoReviewMode: "commit" })] },
				worktrees: { dev01: setup.worktree },
			});

			expect(await harness.done("dev01", { trigger: "auto_review" })).toMatchObject({ ok: true, status: "trashed" });
			expect(repo.tip()).toBe(before);
		});

		it("refuses to finish a held card unless the hold is released", async () => {
			const setup = repoWithWork();
			repo = setup.repo;
			const before = repo.tip();
			const hold = { group: "tier3-coupons", at: "2026-10-07T11:00:00.000Z", round: 1 };
			const harness = createHarness({
				repo,
				config: landingConfig("qa"),
				cards: { review: [createCard({ id: "dev01" })] },
				worktrees: { dev01: setup.worktree },
				holds: { dev01: hold },
			});

			expect(await harness.done("dev01", { landing: "land", trigger: "approve" })).toMatchObject({
				status: "blocked",
				landing: { decision: "held" },
			});
			expect(await harness.done("dev01", { landing: "discard" })).toMatchObject({ status: "blocked" });
			expect(repo.tip()).toBe(before);

			const released = await harness.done("dev01", { landing: "land", trigger: "hold_release" });
			expect(released).toMatchObject({ ok: true, landing: { decision: "landed" } });
		});

		it("shadow decides and logs only: nothing lands and nothing is refused", async () => {
			const setup = repoWithWork();
			repo = setup.repo;
			const before = repo.tip();
			const harness = createHarness({
				repo,
				config: landingConfig("qa", { pipeline: { shadow: true } }),
				cards: { review: [createCard({ id: "dev01" }), createCard({ id: "dev02" })] },
				worktrees: { dev01: setup.worktree, dev02: setup.worktree },
			});

			expect(await harness.done("dev01")).toMatchObject({
				ok: true,
				status: "trashed",
				landing: { decision: "shadow" },
			});
			expect(await harness.done("dev02", { landing: "land", trigger: "approve" })).toMatchObject({
				ok: true,
				landing: { decision: "shadow" },
			});
			expect(repo.tip()).toBe(before);
			expect(harness.landed).toEqual([]);
			expect(harness.readDecisions().map((record) => [record.outcome, record.note])).toEqual([
				["shadow", 'would ask "land or discard?" (clean against main)'],
				["shadow", "would land onto main"],
			]);
		});
	});
});
