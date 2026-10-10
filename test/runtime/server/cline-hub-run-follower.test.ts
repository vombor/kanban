import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { createClineHubRunFollower } from "../../../src/server/cline-hub-run-follower";
import type { CancelClineHubRunsRequest } from "../../../src/terminal/cline-hub-runs";

const WORKTREE = "/home/u/worktrees/33288/foo";
const STARTED = 1_000_000;

function summary(patch: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	return {
		taskId: "33288",
		state: "running",
		agentId: "cline",
		workspacePath: WORKTREE,
		pid: 4242,
		startedAt: STARTED,
		updatedAt: STARTED,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
		...patch,
	};
}

function createHarness() {
	const requests: CancelClineHubRunsRequest[] = [];
	let listener: ((summary: RuntimeTaskSessionSummary) => void) | null = null;
	const follower = createClineHubRunFollower({
		canceller: {
			cancelRuns: async (request) => {
				requests.push(request);
				return [];
			},
		},
		log: () => {},
		now: () => STARTED + 60_000,
	});
	follower.trackWorkspace("foo", {
		onSummary: (next) => {
			listener = next;
			return () => {
				listener = null;
			};
		},
	});
	const emit = (next: RuntimeTaskSessionSummary) => listener?.(next);
	return { follower, requests, emit, isSubscribed: () => listener !== null };
}

describe("cline hub run follower", () => {
	it("ends the run's own hub sessions once when a Cline card's TUI exits (foo QA 33288)", async () => {
		const { follower, requests, emit } = createHarness();
		emit(summary({}));
		emit(summary({ state: "awaiting_review", reviewReason: "exit", exitCode: 0, pid: null }));
		emit(summary({ state: "awaiting_review", reviewReason: "exit", exitCode: 0, pid: null, updatedAt: STARTED + 1 }));
		await follower.settle();
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			workspaceId: "foo",
			taskId: "33288",
			worktreePaths: [WORKTREE],
			window: { from: STARTED, to: STARTED + 60_000 },
		});
		expect(requests[0]?.reason).toContain("(code 0)");
	});

	it("leaves other agents' sessions and sessions it never saw live alone", async () => {
		const { follower, requests, emit } = createHarness();
		emit(summary({ agentId: "claude" }));
		emit(summary({ agentId: "claude", pid: null }));
		emit(summary({ taskId: "other", pid: null }));
		await follower.settle();
		expect(requests).toEqual([]);
	});

	it("ends the runs of sessions that died with the previous server", async () => {
		const { follower, requests } = createHarness();
		follower.endOrphanedRuns("foo", [
			summary({ state: "interrupted", reviewReason: "interrupted", pid: null }),
			summary({ taskId: "codex-card", agentId: "codex", state: "interrupted", pid: null }),
		]);
		await follower.settle();
		expect(requests.map((request) => request.taskId)).toEqual(["33288"]);
	});

	it("stops following an untracked workspace", () => {
		const { follower, isSubscribed } = createHarness();
		follower.untrackWorkspace("foo");
		expect(isSubscribed()).toBe(false);
	});
});
