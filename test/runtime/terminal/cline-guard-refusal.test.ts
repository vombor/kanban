import { describe, expect, it, vi } from "vitest";
import { isTaskExecutionBlocked, TASK_EXECUTION_BLOCK_EVENT } from "../../../src/core/task-execution-block";
import type { ClineGuardPolicy } from "../../../src/terminal/agent-guardrails";
import { buildClineGuardRefusalHook, evaluateClineGuard } from "../../../src/terminal/cline-guard";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { describeUserInputWait } from "../../../src/terminal/user-input-wait";
import { createHooksApi } from "../../../src/trpc/hooks-api";

const worktree = "/fixture/worktrees/dev01/project";
const policy: ClineGuardPolicy = {
	worktreePath: worktree,
	confineWrites: true,
	writableRoots: [worktree, "/tmp"],
	deniedCommands: [],
};
const payload = {
	workspaceRoots: [worktree],
	toolName: "editor",
	tool_call: {
		name: "editor",
		input: { path: "/fixture/kanban-home/data/project/bench/source.txt", new_text: "evidence" },
	},
};

describe("Cline guard refusal is an incomplete turn, not a silent running card (#66)", () => {
	it("reports a valid editor call refused outside the worktree without changing the deny or fabricating a tool result", () => {
		const decision = evaluateClineGuard(payload, policy);
		expect(decision.cancel).toBe(true);
		const request = buildClineGuardRefusalHook(payload, policy, decision, {
			taskId: "dev01",
			workspaceId: "project",
		});
		expect(request).toMatchObject({
			taskId: "dev01",
			workspaceId: "project",
			event: "to_review",
			metadata: {
				source: "cline-guard",
				hookEventName: TASK_EXECUTION_BLOCK_EVENT,
				notificationType: "execution_blocked",
				finalMessage: null,
			},
		});
		expect(request?.metadata?.activityText).toContain("outside this card's worktree");
		expect(decision.cancel).toBe(true);
	});
	it("does not report for a missing explicit identity, allowed tool, or another card's payload", () => {
		const decision = evaluateClineGuard(payload, policy);
		expect(buildClineGuardRefusalHook(payload, policy, decision, {})).toBeNull();
		expect(
			buildClineGuardRefusalHook(payload, policy, { cancel: false }, { taskId: "dev01", workspaceId: "project" }),
		).toBeNull();
		expect(
			buildClineGuardRefusalHook({ ...payload, workspaceRoots: ["/another/card"] }, policy, decision, {
				taskId: "dev01",
				workspaceId: "project",
			}),
		).toBeNull();
	});
	it("latched Review/error survives later TaskCancel and restart; no completed checkpoint/ready event is emitted", async () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			dev01: {
				taskId: "dev01",
				state: "running",
				agentId: "cline",
				workspacePath: worktree,
				pid: 1234,
				startedAt: 100,
				updatedAt: 100,
				lastOutputAt: null,
				reviewReason: null,
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				modelId: null,
				reasoningEffort: null,
			},
		});
		const capture = vi.fn(),
			ready = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: () => "/fixture/project",
			ensureTerminalManagerForWorkspace: async () => manager,
			broadcastRuntimeWorkspaceStateUpdated: () => {},
			broadcastTaskReadyForReview: ready,
			captureTaskTurnCheckpoint: capture,
		});
		const request = buildClineGuardRefusalHook(payload, policy, evaluateClineGuard(payload, policy), {
			taskId: "dev01",
			workspaceId: "project",
		});
		if (!request) throw new Error("No refusal");
		expect(await api.ingest(request)).toEqual({ ok: true });
		expect(manager.getSummary("dev01")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "error",
			lastTurnEnd: null,
		});
		await api.ingest({
			taskId: "dev01",
			workspaceId: "project",
			event: "to_review",
			metadata: { source: "cline-cli", hookEventName: "TaskCancel", finalMessage: "not completed" },
		});
		expect(capture).not.toHaveBeenCalled();
		expect(ready).not.toHaveBeenCalled();
		const summary = manager.getSummary("dev01");
		expect(isTaskExecutionBlocked(summary)).toBe(true);
		expect(summary?.lastTurnEnd).toBeNull();
		expect(describeUserInputWait(summary)?.kind).toBe("approval");
		const restarted = new TerminalSessionManager();
		if (!summary) throw new Error("Missing summary");
		restarted.hydrateFromRecord({ dev01: summary });
		expect(isTaskExecutionBlocked(restarted.getSummary("dev01"))).toBe(true);
		restarted.transitionToRunning("dev01");
		expect(isTaskExecutionBlocked(restarted.getSummary("dev01"))).toBe(false);
		expect(restarted.getSummary("dev01")?.warningMessage).toBeNull();
	});
});
