import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { createBoard, createCard } from "../utilities/workspace-state-store";

const mocks = vi.hoisted(() => ({
	state: null as unknown,
	selectedAgentId: "cline" as RuntimeAgentId,
	startTaskSession: vi.fn(),
	ensureWorktree: vi.fn(async () => ({ ok: true })),
	updateTrackedPipelineCardFlow: vi.fn(async () => true),
}));

// Never reach a real Kanban server, board or worktree from a test.
vi.mock("../../src/commands/runtime-trpc-client", () => ({
	createRuntimeTrpcClient: () => ({
		workspace: {
			getState: { query: async () => mocks.state },
			ensureWorktree: { mutate: mocks.ensureWorktree },
		},
		runtime: {
			getConfig: { query: async () => ({ selectedAgentId: mocks.selectedAgentId }) },
			startTaskSession: { mutate: mocks.startTaskSession },
		},
	}),
	notifyRuntimeWorkspaceStateUpdated: vi.fn(async () => undefined),
}));
vi.mock("../../src/state/workspace-state", () => ({
	loadWorkspaceContext: async () => ({ workspaceId: "foo", repoPath: "/repos/foo" }),
	mutateWorkspaceState: async () => ({ value: true, saved: false }),
}));
vi.mock("../../src/workspace/task-worktree", () => ({
	getTaskWorkspacePathInfo: async () => ({ exists: false, path: "/wt/none" }),
}));
vi.mock("../../src/pipeline/recovery-runtime", () => ({
	updateTrackedPipelineCardFlow: mocks.updateTrackedPipelineCardFlow,
}));

import { resumeTasks } from "../../src/commands/task-recovery";
import { RESTART_RESUME_NOTE } from "../../src/pipeline/recovery-prompts";

function deadSession(agentId: RuntimeAgentId): RuntimeTaskSessionSummary {
	return { taskId: "dev01", agentId, state: "awaiting_review", pid: null } as RuntimeTaskSessionSummary;
}

describe("kanban task resume", () => {
	beforeEach(() => {
		mocks.startTaskSession.mockReset();
		mocks.startTaskSession.mockResolvedValue({ ok: true, summary: { state: "running" } });
		mocks.selectedAgentId = "cline";
	});

	it("continues a Claude card's conversation with the resume note as launch prompt", async () => {
		mocks.state = {
			board: createBoard({ review: [createCard({ id: "dev01", prompt: "Do the card." })] }),
			sessions: { dev01: deadSession("claude") },
		};
		const result = await resumeTasks({ cwd: "/repos/foo", taskIds: ["dev01"], dryRun: false });
		expect(result).toMatchObject({ ok: true, results: [{ agentId: "claude", continuesConversation: true }] });
		expect(mocks.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "dev01",
				prompt: RESTART_RESUME_NOTE,
				agentId: "claude",
				resumeFromTrash: true,
				// A live session that finished its turn is refused, never reattached as "resumed" (issue #16).
				requireNewTurn: true,
			}),
		);
	});

	it("an unpinned card with no session runs on the selected agent: Cline restarts fresh with the card prompt", async () => {
		mocks.state = {
			board: createBoard({ in_progress: [createCard({ id: "dev01", prompt: "Do the card." })] }),
			sessions: {},
		};
		const result = await resumeTasks({ cwd: "/repos/foo", taskIds: ["dev01"], dryRun: false });
		expect(result).toMatchObject({ ok: true, results: [{ agentId: "cline", continuesConversation: false }] });
		const input = mocks.startTaskSession.mock.calls[0]?.[0];
		expect(input).toMatchObject({ prompt: "Do the card.", agentId: "cline" });
		expect(input).not.toHaveProperty("resumeFromTrash");
	});

	it("an unpinned card on a selected Claude continues too", async () => {
		mocks.selectedAgentId = "claude";
		mocks.state = { board: createBoard({ review: [createCard({ id: "dev01" })] }), sessions: {} };
		await resumeTasks({ cwd: "/repos/foo", taskIds: ["dev01"], dryRun: false });
		expect(mocks.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: RESTART_RESUME_NOTE, agentId: "claude", resumeFromTrash: true }),
		);
	});
});
