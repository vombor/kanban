// The submission stage on real temp repos, with a recording checks queue.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { RuntimeBoardCard } from "../../../src/core/api-contract";
import { CHECKS_VERSION, type ChecksRequest } from "../../../src/pipeline/checks";
import type { EmptyDiffRecord } from "../../../src/pipeline/empty-diff";
import type { PipelineSessionView } from "../../../src/pipeline/engine";
import type { PipelineWorkspaceState } from "../../../src/pipeline/pipeline-state";
import { readTaskSnapshot } from "../../../src/pipeline/snapshots";
import { createSubmissionStage, type SubmissionContext } from "../../../src/pipeline/submission-stage";
import { createEffectiveCard } from "../../utilities/effective-card";
import { createRepoWithWorktree } from "../../utilities/git-repo";
import { createCard } from "../../utilities/workspace-state-store";

const TEAM_QA = { landing: { mode: "qa" }, kit: { name: "team" }, models: { allowProvisional: true } };

function settingsFor(entry: unknown) {
	const settings = parsePipelineConfig({ workspaces: { foo: entry } }).config.workspaces.foo;
	if (!settings) {
		throw new Error("no settings");
	}
	return settings;
}

const NOW = Date.parse("2026-10-09T04:44:58.000Z");

function session(overrides: Partial<PipelineSessionView>): PipelineSessionView {
	return { taskId: "t", agentId: "cline", modelId: null, state: "awaiting_review", ...overrides };
}

function emptyState(cards: PipelineWorkspaceState["cards"] = {}): PipelineWorkspaceState {
	return { version: 1, since: "2026-10-07T00:00:00.000Z", importedFrom: null, cards };
}

describe("submission stage", () => {
	const repos: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const repo of repos.splice(0)) {
			repo.cleanup();
		}
	});

	function setup(options: { workspace?: unknown; kitName?: string; state?: PipelineWorkspaceState } = {}) {
		const repo = createRepoWithWorktree();
		repos.push(repo);
		const enqueued: ChecksRequest[] = [];
		const probeHasWork = vi.fn(async () => true);
		const emptyDiffs: Array<{ workspaceId: string; taskId: string; record: EmptyDiffRecord | null }> = [];
		const stage = createSubmissionStage({
			checks: {
				enqueue: (request) => {
					enqueued.push(request);
					return "queued";
				},
			},
			resolveWorktree: async () => repo.worktreePath,
			probeHasWork,
			recordEmptyDiff: async (workspaceId, taskId, record) => {
				emptyDiffs.push({ workspaceId, taskId, record });
			},
			now: () => NOW,
		});
		const settings = settingsFor(options.workspace ?? TEAM_QA);
		const context: SubmissionContext = {
			workspaceId: "foo",
			workspacePath: repo.repoPath,
			settings,
			kitName: options.kitName ?? "team",
			state: options.state ?? emptyState(),
		};
		const inspect = async (
			card: RuntimeBoardCard,
			role: "dev" | "qa" | "calibration" = "dev",
			session: PipelineSessionView | null = null,
		) =>
			await stage.inspect(context, {
				card,
				effective: { ...createEffectiveCard({ agentId: "cline", role }), card },
				session,
			});
		return { repo, stage, enqueued, probeHasWork, context, inspect, emptyDiffs };
	}

	it("snapshots a dev card with work and queues checks on the snapshot", async () => {
		const { repo, enqueued, inspect, context } = setup();
		context.projectChecks = { envFile: ".env", setup: "npx prisma migrate deploy" };
		writeFileSync(join(repo.worktreePath, "work.txt"), "work\n");

		const inspection = await inspect(createCard({ id: "dev-1", title: "Add work" }));

		const snapshot = await readTaskSnapshot(repo.repoPath, "dev-1");
		expect(snapshot).toBeTruthy();
		expect(inspection.hasWork).toBe(true);
		expect(inspection.records.map((record) => [record.stage, record.outcome])).toEqual([
			["snapshot", "acted"],
			["checks", "acted"],
		]);
		expect(enqueued).toEqual([
			{
				workspaceId: "foo",
				repoPath: repo.repoPath,
				taskId: "dev-1",
				title: "Add work",
				baseRef: "main",
				snapshot,
				scripts: ["typecheck", "lint", "test", "build"],
				// The project's checks environment, read from the card's own worktree.
				worktreePath: repo.worktreePath,
				project: { envFile: ".env", setup: "npx prisma migrate deploy" },
			},
		]);
	});

	it("a card whose snapshot equals its base is not submitted", async () => {
		const { enqueued, inspect } = setup();
		const inspection = await inspect(createCard({ id: "dev-1" }));
		expect(inspection.hasWork).toBe(false);
		expect(inspection.records[0]?.note).toContain("no changes against main");
		expect(enqueued).toEqual([]);
	});

	it("records an empty diff with whether the agent ran, from its hooks (issue #14)", async () => {
		const { inspect, emptyDiffs } = setup();
		const ran = session({ state: "awaiting_review", reviewReason: "hook" });
		const card = createCard({ id: "b2d5b", updatedAt: 7 });
		const inspection = await inspect(card, "dev", ran);
		expect(inspection.records[0]?.note).toMatch(
			/no changes against main; not submitted \(the agent ran but changed nothing: its turn ended through the agent's hook\)$/u,
		);
		expect(emptyDiffs).toEqual([
			{
				workspaceId: "foo",
				taskId: "b2d5b",
				record: {
					at: new Date(NOW).toISOString(),
					cardUpdatedAt: 7,
					snapshot: expect.any(String),
					parent: expect.any(String),
					baseRef: "main",
					ran: true,
					evidence: "its turn ended through the agent's hook",
				},
			},
		]);

		// No hook from this run: never ran.
		const never = await inspect(
			createCard({ id: "e0001" }),
			"dev",
			session({ state: "awaiting_review", reviewReason: "exit", startedAt: 100, lastHookAt: 50 }),
		);
		expect(never.records[0]?.note).toContain("(the agent likely never ran: no hook or final message from this run");
		expect(emptyDiffs[1]?.record).toMatchObject({ ran: false });
	});

	it("a submission with changes removes an earlier empty-diff record; shadow records nothing", async () => {
		const { repo, inspect, emptyDiffs } = setup({ state: emptyState({ "dev-1": { emptyDiff: { at: "x" } } }) });
		writeFileSync(join(repo.worktreePath, "work.txt"), "work\n");
		await inspect(createCard({ id: "dev-1" }));
		expect(emptyDiffs).toEqual([{ workspaceId: "foo", taskId: "dev-1", record: null }]);

		const shadow = setup({ workspace: { ...TEAM_QA, pipeline: { shadow: true } } });
		await shadow.inspect(createCard({ id: "dev-2" }));
		expect(shadow.emptyDiffs).toEqual([]);
	});

	it("snapshots once per submission: the same card state is not snapshotted or checked again", async () => {
		const { repo, enqueued, inspect } = setup();
		writeFileSync(join(repo.worktreePath, "work.txt"), "work\n");
		const card = createCard({ id: "dev-1", updatedAt: 1 });
		const first = await inspect(card);
		writeFileSync(join(repo.worktreePath, "more.txt"), "more\n");
		expect(await inspect(card)).toEqual(first);
		expect(enqueued).toHaveLength(1);

		// Back in Review after a rework: a new submission.
		const second = await inspect({ ...card, updatedAt: 2 });
		expect(second.records[0]?.note).toContain("(was ");
		expect(enqueued).toHaveLength(2);
		expect(enqueued[1]?.snapshot).not.toBe(enqueued[0]?.snapshot);
	});

	it("a turn that ends while the card is already in Review gets a new snapshot (issue #20, f0ba7)", async () => {
		const { repo, enqueued, inspect, emptyDiffs, context } = setup();
		const card = createCard({ id: "f0ba7", updatedAt: 1 });
		// 06:04: the agent saw its plan spec missing and ended its turn: no changes, recorded.
		const first = session({ taskId: "f0ba7", reviewReason: "hook", stateChangedAt: 1_000, lastHookAt: 1_000 });
		const empty = await inspect(card, "dev", first);
		expect(empty.hasWork).toBe(false);
		expect(emptyDiffs).toHaveLength(1);
		context.state = emptyState({ f0ba7: { emptyDiff: emptyDiffs[0]?.record } });

		// The orchestrator's message made it do the work in the same session; neither the card nor the session state
		// changed, only its hooks. The same Review clock is still the cached answer.
		writeFileSync(join(repo.worktreePath, "schema.prisma"), "model Loyalty {}\n");
		expect(await inspect(card, "dev", first)).toEqual(empty);
		const later = await inspect(card, "dev", { ...first, lastHookAt: 9_000 });
		expect(later.hasWork).toBe(true);
		expect(later.records.map((record) => [record.stage, record.outcome])).toEqual([
			["snapshot", "acted"],
			["checks", "acted"],
		]);
		expect(enqueued).toHaveLength(1);
		// The empty-diff record goes with the submission that has changes.
		expect(emptyDiffs[1]).toEqual({ workspaceId: "foo", taskId: "f0ba7", record: null });
	});

	it("a later settled turn that still changed nothing records the empty diff again", async () => {
		const { inspect, emptyDiffs } = setup();
		const card = createCard({ id: "f0ba7", updatedAt: 1 });
		await inspect(card, "dev", session({ reviewReason: "hook", stateChangedAt: 1_000 }));
		await inspect(card, "dev", session({ reviewReason: "hook", stateChangedAt: 1_000, lastHookAt: 5_000 }));
		expect(emptyDiffs.map((entry) => entry.record?.cardUpdatedAt)).toEqual([1, 1]);
	});

	it("a kanban task resubmit request snapshots the card again", async () => {
		const { repo, enqueued, inspect, context } = setup();
		const card = createCard({ id: "f0ba7", updatedAt: 1 });
		const idle = session({ reviewReason: "hook", stateChangedAt: 1_000 });
		expect((await inspect(card, "dev", idle)).hasWork).toBe(false);
		writeFileSync(join(repo.worktreePath, "work.txt"), "work\n");
		expect((await inspect(card, "dev", idle)).hasWork).toBe(false);

		context.state = emptyState({ f0ba7: { resubmit: { at: "2026-10-09T09:00:00.000Z", by: "user" } } });
		expect((await inspect(card, "dev", idle)).hasWork).toBe(true);
		expect(enqueued).toHaveLength(1);
	});

	it("does not check a snapshot the current checker already checked (including one imported from the legacy kit)", async () => {
		const { repo, enqueued, inspect, context } = setup();
		writeFileSync(join(repo.worktreePath, "work.txt"), "work\n");
		await inspect(createCard({ id: "dev-1", updatedAt: 1 }));
		const snapshot = enqueued[0]?.snapshot as string;

		context.state = emptyState({ "dev-1": { snapshot, version: CHECKS_VERSION, harness: false } });
		const again = await inspect(createCard({ id: "dev-1", updatedAt: 2 }));
		expect(again.records.find((record) => record.stage === "checks")).toMatchObject({ outcome: "none" });
		expect(enqueued).toHaveLength(1);

		// A harness failure is checked again on the next submission.
		context.state = emptyState({ "dev-1": { snapshot, version: CHECKS_VERSION, harness: true } });
		await inspect(createCard({ id: "dev-1", updatedAt: 3 }));
		expect(enqueued).toHaveLength(2);
	});

	it("shadow: builds the snapshot without moving the ref and runs no checks", async () => {
		const { repo, enqueued, inspect } = setup({ workspace: { ...TEAM_QA, pipeline: { shadow: true } } });
		writeFileSync(join(repo.worktreePath, "work.txt"), "work\n");
		const inspection = await inspect(createCard({ id: "dev-1" }));
		expect(inspection.hasWork).toBe(true);
		expect(inspection.records.map((record) => [record.stage, record.outcome])).toEqual([
			["snapshot", "shadow"],
			["checks", "shadow"],
		]);
		expect(await readTaskSnapshot(repo.repoPath, "dev-1")).toBeNull();
		expect(enqueued).toEqual([]);
	});

	it("the default kit (and checks.enabled false) snapshots but never runs checks", async () => {
		for (const options of [
			{ workspace: { landing: { mode: "qa" } }, kitName: "default" },
			{ workspace: { ...TEAM_QA, checks: { enabled: false } }, kitName: "team" },
		]) {
			const { repo, enqueued, inspect } = setup(options);
			writeFileSync(join(repo.worktreePath, "work.txt"), "work\n");
			const inspection = await inspect(createCard({ id: "dev-1" }));
			expect(inspection.records.map((record) => record.stage)).toEqual(["snapshot"]);
			expect(enqueued).toEqual([]);
		}
	});

	it("QA and calibration cards (legacy ones included) are never snapshotted or checked", async () => {
		const { repo, enqueued, inspect, probeHasWork } = setup();
		writeFileSync(join(repo.worktreePath, "work.txt"), "work\n");
		for (const role of ["qa", "calibration"] as const) {
			const inspection = await inspect(createCard({ id: `${role}-1` }), role);
			expect(inspection).toEqual({ hasWork: true, records: [] });
		}
		expect(probeHasWork).toHaveBeenCalledTimes(2);
		expect(await readTaskSnapshot(repo.repoPath, "qa-1")).toBeNull();
		expect(enqueued).toEqual([]);
	});

	it("a card whose session is still running is not snapshotted mid-work", async () => {
		const { repo, enqueued, inspect } = setup();
		writeFileSync(join(repo.worktreePath, "work.txt"), "work\n");
		const inspection = await inspect(createCard({ id: "dev-1" }), "dev", {
			taskId: "dev-1",
			agentId: "cline",
			modelId: null,
			state: "running",
		});
		expect(inspection).toEqual({ hasWork: false, records: [] });
		expect(await readTaskSnapshot(repo.repoPath, "dev-1")).toBeNull();
		expect(enqueued).toEqual([]);
	});

	it("a card without a worktree has no work", async () => {
		const enqueue = vi.fn((_request: ChecksRequest) => "queued" as const);
		const stage = createSubmissionStage({ checks: { enqueue }, resolveWorktree: async () => null });
		const inspection = await stage.inspect(
			{
				workspaceId: "foo",
				workspacePath: "/nonexistent",
				settings: settingsFor(TEAM_QA),
				kitName: "team",
				state: emptyState(),
			},
			{ card: createCard({ id: "dev-1" }), effective: createEffectiveCard({ agentId: "cline" }), session: null },
		);
		expect(inspection).toEqual({ hasWork: false, records: [] });
		expect(enqueue).not.toHaveBeenCalled();
	});
});
