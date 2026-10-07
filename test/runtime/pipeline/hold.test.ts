import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskTrashResponse } from "../../../src/core/api-contract";
import type { RoutingPolicy } from "../../../src/kits/policy";
import { decideOnPass, readPipelineHold, releaseHold } from "../../../src/pipeline/hold";
import { createPipelineStateStore } from "../../../src/pipeline/pipeline-state";
import { createEffectiveCard } from "../../utilities/effective-card";
import { createTempDir } from "../../utilities/temp-dir";

const VERDICT = { verdict: "PASS" as const, round: 2 };
const NOW = Date.parse("2026-10-07T12:00:00.000Z");

function stubPolicy(onPass: ReturnType<RoutingPolicy["onPass"]>): RoutingPolicy {
	return {
		devAssignment: () => null,
		qaPolicy: () => ({ kind: "none", reason: "stub" }),
		onFail: () => ({ action: "stop", reason: "stub" }),
		onPass: () => onPass,
	};
}

function trashed(ok: boolean, overrides: Partial<RuntimeTaskTrashResponse> = {}): RuntimeTaskTrashResponse {
	return {
		ok,
		status: ok ? "trashed" : "blocked",
		taskId: "dev-1",
		previousColumnId: "review",
		readyTaskIds: [],
		autoStartedTasks: [],
		worktreeDeleted: ok,
		...overrides,
	};
}

describe("the hold", () => {
	let temp: ReturnType<typeof createTempDir> | null = null;
	afterEach(() => {
		temp?.cleanup();
		temp = null;
	});

	function createStore() {
		temp = createTempDir("kanban-hold-");
		const root = temp.path;
		return createPipelineStateStore({
			now: () => NOW,
			getStatePath: (workspaceId) => join(root, workspaceId, "pipeline-state.json"),
			getLegacyChecksStatePaths: () => [],
		});
	}

	it("records nothing when the kit answers land", async () => {
		const store = createStore();
		const dev = createEffectiveCard({ agentId: "cline", workspaceId: "foo" });

		const answer = await decideOnPass({
			store,
			policy: stubPolicy({ action: "land" }),
			dev,
			verdict: VERDICT,
			now: NOW,
		});

		expect(answer).toEqual({ action: "land" });
		expect(await store.peek("foo")).toBeNull();
	});

	it("records a hold right away when the kit answers hold", async () => {
		const store = createStore();
		const dev = createEffectiveCard({ agentId: "cline", workspaceId: "foo" });

		await decideOnPass({
			store,
			policy: stubPolicy({ action: "hold", group: "tier3-coupons" }),
			dev,
			verdict: VERDICT,
			now: NOW,
		});

		const state = await store.peek("foo");
		expect(readPipelineHold(state?.cards["dev-1"])).toEqual({
			group: "tier3-coupons",
			at: "2026-10-07T12:00:00.000Z",
			round: 2,
		});
	});

	async function heldStore() {
		const store = createStore();
		await decideOnPass({
			store,
			policy: stubPolicy({ action: "hold", group: "g1" }),
			dev: createEffectiveCard({ agentId: "cline", workspaceId: "foo" }),
			verdict: VERDICT,
			now: NOW,
		});
		return store;
	}

	it("refuses to release a card that is not held", async () => {
		const store = createStore();
		const finishTask = vi.fn();

		const result = await releaseHold(
			{ store, finishTask, preserveWork: vi.fn() },
			{ workspaceId: "foo", workspacePath: "/repo", taskId: "dev-1", decision: "land" },
		);

		expect(result).toEqual({ ok: false, error: "task dev-1 is not held" });
		expect(finishTask).not.toHaveBeenCalled();
	});

	it("tags the work first, then finishes through the Done workflow and clears the hold", async () => {
		const store = await heldStore();
		const order: string[] = [];
		const preserveWork = vi.fn(async () => {
			order.push("tag");
		});
		const finishTask = vi.fn(async () => {
			order.push("finish");
			return trashed(true, { landing: { decision: "discarded" } });
		});

		const result = await releaseHold(
			{ store, finishTask, preserveWork, now: () => NOW },
			{
				workspaceId: "foo",
				workspacePath: "/repo",
				taskId: "dev-1",
				decision: "discard",
				tag: "preserve/dev-1-kimi-k3",
			},
		);

		expect(result).toMatchObject({ ok: true, tag: "preserve/dev-1-kimi-k3" });
		expect(order).toEqual(["tag", "finish"]);
		expect(preserveWork).toHaveBeenCalledWith({
			workspacePath: "/repo",
			taskId: "dev-1",
			tag: "preserve/dev-1-kimi-k3",
		});
		expect(finishTask).toHaveBeenCalledWith({
			workspaceId: "foo",
			workspacePath: "/repo",
			taskId: "dev-1",
			landing: "discard",
		});
		const entry = (await store.peek("foo"))?.cards["dev-1"];
		expect(readPipelineHold(entry)).toBeNull();
		expect(entry?.holdReleases).toEqual([
			{ at: "2026-10-07T12:00:00.000Z", group: "g1", decision: "discard", tag: "preserve/dev-1-kimi-k3" },
		]);
	});

	it("keeps the hold when the land is refused (a conflict), so the card stays held in Review", async () => {
		const store = await heldStore();
		const finishTask = vi.fn(async () =>
			trashed(false, { error: "conflicts", landing: { decision: "conflict", files: ["a.ts"] } }),
		);

		const result = await releaseHold(
			{ store, finishTask, preserveWork: vi.fn() },
			{ workspaceId: "foo", workspacePath: "/repo", taskId: "dev-1", decision: "land" },
		);

		expect(result).toMatchObject({ ok: false, error: "conflicts" });
		expect(readPipelineHold((await store.peek("foo"))?.cards["dev-1"])?.group).toBe("g1");
	});

	it("does not finish the card when its tag can't be written", async () => {
		const store = await heldStore();
		const finishTask = vi.fn();

		const result = await releaseHold(
			{
				store,
				finishTask,
				preserveWork: vi.fn(async () => {
					throw new Error("no worktree");
				}),
			},
			{ workspaceId: "foo", workspacePath: "/repo", taskId: "dev-1", decision: "discard", tag: "preserve/x" },
		);

		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("no worktree") });
		expect(finishTask).not.toHaveBeenCalled();
	});
});
