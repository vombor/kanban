import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { objectiveCreateSchema } from "../../../src/core/objective-contract";
import { TASK_EXECUTION_BLOCK_PREFIX } from "../../../src/core/task-execution-block";
import { createObjectiveStore } from "../../../src/objectives/objective-store";
import { createPipelineStateStore } from "../../../src/pipeline/pipeline-state";
import { createObjectiveReconciler } from "../../../src/server/objective-reconciler";
import { createTempDir } from "../../utilities/temp-dir";

const T0 = Date.parse("2026-10-17T10:00:00Z");
const summary = (at: number) =>
	runtimeTaskSessionSummarySchema.parse({
		taskId: "dev01",
		agentId: "claude",
		state: "running",
		startedAt: at,
		stateChangedAt: at,
		updatedAt: at,
		workspacePath: "/fixture/dev01",
		pid: 12345,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
	});
describe("objective supervision stays in the native runtime", () => {
	it("rechecks a fresh project without activating a terminal owner or calling unobserved work settled", async () => {
		const temp = createTempDir("objective-unactivated-project-");
		const store = createObjectiveStore({ home: temp.path, now: () => new Date(T0) });
		const pipeline = createPipelineStateStore({
			getStatePath: (id) => join(temp.path, id, "pipeline.json"),
			getLegacyChecksStatePaths: () => [],
		});
		const observer = createObjectiveReconciler({ store, pipeline, listWorkspaces: () => [], warn: () => {} });
		try {
			await store.create(
				"fresh",
				objectiveCreateSchema.parse({
					requestId: randomUUID(),
					title: "Objective",
					requirements: "Acceptance",
					taskIds: ["dev01"],
				}),
			);
			await store.observe("fresh", [
				{
					taskId: "dev01",
					startedAt: T0 + 1000,
					stateChangedAt: T0 + 1000,
					updatedAt: T0 + 1000,
					state: "running",
					live: true,
					settled: false,
				},
			]);
			await observer.recheck("fresh");
			const objective = (await store.read("fresh")).objectives[0];
			expect(objective?.attempts[0]?.state).toBe("running");
			expect(objective?.finalCommits).toEqual([]);
			expect(objective?.status).not.toBe("completed");
		} finally {
			await observer.close();
			temp.cleanup();
		}
	});
	it("user recheck collects only the requested project's owners and propagates unavailable storage", async () => {
		const temp = createTempDir("objective-scoped-refresh-");
		const store = createObjectiveStore({ home: temp.path });
		const pipeline = createPipelineStateStore({
			getStatePath: (id) => join(temp.path, id, "pipeline.json"),
			getLegacyChecksStatePaths: () => [],
		});
		const observer = createObjectiveReconciler({
			store,
			pipeline,
			listWorkspaces: () => [
				{ workspaceId: "own", summaries: [], isLive: () => false },
				{ workspaceId: "other", summaries: [], isLive: () => false },
			],
			intervalMs: 60_000,
			warn: () => {},
		});
		try {
			await store.create(
				"own",
				objectiveCreateSchema.parse({
					requestId: randomUUID(),
					title: "Objective",
					requirements: "Acceptance",
					taskIds: ["dev01"],
				}),
			);
			const read = vi.spyOn(store, "read");
			await observer.recheck("own");
			expect(read.mock.calls.every(([id]) => id === "own")).toBe(true);
			await expect(observer.recheck("missing")).rejects.toThrow("unavailable");
			read.mockRejectedValueOnce(new Error("damaged journal"));
			await expect(observer.recheck("own")).rejects.toThrow("damaged journal");
		} finally {
			await observer.close();
			temp.cleanup();
		}
	});
	it("retains an execution-blocked turn as interrupted, never settled acceptance or a replay request", async () => {
		const temp = createTempDir("objective-guard-blocked-");
		let clock = T0;
		const store = createObjectiveStore({ home: temp.path, now: () => new Date(clock) });
		const pipeline = createPipelineStateStore({
			getStatePath: (id) => join(temp.path, id, "pipeline.json"),
			getLegacyChecksStatePaths: () => [],
		});
		let current = summary(T0 + 1000);
		const observer = createObjectiveReconciler({
			store,
			pipeline,
			now: () => clock,
			listWorkspaces: () => [{ workspaceId: "foo", summaries: [current], isLive: () => true }],
			warn: () => {},
		});
		try {
			await store.create(
				"foo",
				objectiveCreateSchema.parse({
					requestId: randomUUID(),
					title: "Objective",
					requirements: "Acceptance",
					taskIds: ["dev01"],
				}),
			);
			clock = T0 + 1000;
			await observer.sweep();
			clock = T0 + 20000;
			current = {
				...current,
				state: "awaiting_review",
				reviewReason: "error",
				stateChangedAt: T0 + 2000,
				updatedAt: T0 + 20000,
				warningMessage: `${TASK_EXECUTION_BLOCK_PREFIX}editor refused`,
			};
			await observer.sweep();
			const objective = (await store.read("foo")).objectives[0];
			expect(objective?.attempts[0]).toMatchObject({
				state: "interrupted",
				executionBlocked: true,
				endedAt: new Date(T0 + 2000).toISOString(),
			});
			expect(objective?.handoff).toMatchObject({
				code: "execution_blocked",
				owner: "user",
				action: "inspect_execution",
			});
			expect(objective?.status).toBe("held");
			expect(objective?.finalCommits).toEqual([]);
		} finally {
			await observer.close();
			temp.cleanup();
		}
	});
	it("captures short-turn activity before the sweep, waits for settled Review, and flushes on close", async () => {
		const temp = createTempDir("objective-native-observer-");
		let clock = T0;
		const warnings: string[] = [];
		const store = createObjectiveStore({ home: temp.path, now: () => new Date(clock) });
		const pipeline = createPipelineStateStore({
			getStatePath: (id) => join(temp.path, id, "pipeline.json"),
			getLegacyChecksStatePaths: () => [],
		});
		let current = summary(T0 + 1000);
		const observer = createObjectiveReconciler({
			store,
			pipeline,
			now: () => clock,
			listWorkspaces: () => [{ workspaceId: "foo", summaries: [current], isLive: () => true }],
			warn: (message) => warnings.push(message),
		});
		try {
			await store.create(
				"foo",
				objectiveCreateSchema.parse({
					requestId: randomUUID(),
					title: "Objective",
					requirements: "Acceptance",
					taskIds: ["dev01"],
				}),
			);
			clock = T0 + 1000;
			observer.noteActivity("foo", current, true);
			clock = T0 + 2000;
			current = { ...current, state: "awaiting_review", stateChangedAt: clock, updatedAt: clock };
			observer.noteActivity("foo", current, true);
			await observer.sweep();
			expect((await store.read("foo")).objectives[0]?.attempts).toHaveLength(1);
			expect((await store.read("foo")).objectives[0]?.attempts[0]?.state).toBe("running");
			clock = T0 + 20_000;
			await observer.sweep();
			expect((await store.read("foo")).objectives[0]?.attempts[0]?.state).toBe("settled");
			clock = T0 + 21_000;
			current = summary(clock);
			observer.noteActivity("foo", current, true);
			await observer.close();
			expect((await store.read("foo")).objectives[0]?.attempts).toHaveLength(2);
			expect(warnings).toEqual([]);
			observer.noteActivity("foo", summary(T0 + 30_000), true);
			await observer.sweep();
			expect((await store.read("foo")).objectives[0]?.attempts).toHaveLength(2);
		} finally {
			await observer.close();
			temp.cleanup();
		}
	});
	it("keeps untouched projects uninitialized and does not count an unsubmitted composer", async () => {
		const temp = createTempDir("objective-no-composer-turn-");
		const store = createObjectiveStore({ home: temp.path, now: () => new Date(T0) });
		const pipeline = createPipelineStateStore({
			getStatePath: (id) => join(temp.path, id, "pipeline.json"),
			getLegacyChecksStatePaths: () => [],
		});
		const current = { ...summary(T0 + 1000), dispatchPromptSubmitted: false };
		const observer = createObjectiveReconciler({
			store,
			pipeline,
			listWorkspaces: () => [
				{ workspaceId: "unused", summaries: [], isLive: () => false },
				{ workspaceId: "foo", summaries: [current], isLive: () => true },
			],
			warn: () => {},
		});
		try {
			await store.create(
				"foo",
				objectiveCreateSchema.parse({
					requestId: randomUUID(),
					title: "Objective",
					requirements: "Acceptance",
					taskIds: ["dev01"],
				}),
			);
			await observer.sweep();
			expect((await store.read("foo")).objectives[0]?.attempts).toEqual([]);
			expect(await pipeline.peek("unused")).toBeNull();
			expect((await store.read("unused")).objectives).toEqual([]);
		} finally {
			await observer.close();
			temp.cleanup();
		}
	});
});
