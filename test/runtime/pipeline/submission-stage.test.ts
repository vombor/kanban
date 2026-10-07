// The submission stage on real temp repos, with a recording checks queue.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { RuntimeBoardCard } from "../../../src/core/api-contract";
import { CHECKS_VERSION, type ChecksRequest } from "../../../src/pipeline/checks";
import type { PipelineSessionView } from "../../../src/pipeline/engine";
import type { PipelineWorkspaceState } from "../../../src/pipeline/pipeline-state";
import { readTaskSnapshot } from "../../../src/pipeline/snapshots";
import { createSubmissionStage, type SubmissionContext } from "../../../src/pipeline/submission-stage";
import { createEffectiveCard } from "../../utilities/effective-card";
import { createRepoWithWorktree } from "../../utilities/git-repo";
import { createCard } from "../../utilities/workspace-state-store";

const TEAM_QA = { landing: { mode: "qa" }, kit: { name: "team" } };

function settingsFor(entry: unknown) {
	const settings = parsePipelineConfig({ workspaces: { foo: entry } }).config.workspaces.foo;
	if (!settings) {
		throw new Error("no settings");
	}
	return settings;
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
		const stage = createSubmissionStage({
			checks: {
				enqueue: (request) => {
					enqueued.push(request);
					return "queued";
				},
			},
			resolveWorktree: async () => repo.worktreePath,
			probeHasWork,
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
		return { repo, stage, enqueued, probeHasWork, context, inspect };
	}

	it("snapshots a dev card with work and queues checks on the snapshot", async () => {
		const { repo, enqueued, inspect } = setup();
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
