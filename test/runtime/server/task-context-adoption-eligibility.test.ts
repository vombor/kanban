import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { canAdoptTaskReferences } from "../../../src/server/task-context-adoption-eligibility";
import { getTaskHistoryLogPath } from "../../../src/state/kanban-home";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const worktree = vi.hoisted(() => ({ exists: false }));
vi.mock("../../../src/workspace/task-worktree", () => ({
	getTaskWorkspacePathInfo: async () => ({ exists: worktree.exists }),
}));
describe("reference adoption's unstarted evidence", () => {
	it("requires Backlog dev, no live/persisted sessions, no pipeline/worktree or damaged history", async () =>
		withTemporaryKanbanHome(async () => {
			worktree.exists = false;
			const card = createCard({ id: "dev1" });
			const state = { board: createBoard({ backlog: [card] }), sessions: {}, revision: 1 };
			const base = { workspaceId: "demo", taskId: "dev1", repoPath: "/owned", state, live: {}, pipelineTaskIds: [] };
			expect(await canAdoptTaskReferences(base)).toBe(true);
			for (const update of [
				{ state: { ...state, board: createBoard({ review: [card] }) } },
				{ state: { ...state, board: createBoard({ backlog: [createCard({ id: "dev1", role: "qa" })] }) } },
				{ pipelineTaskIds: ["dev1"] },
				{ live: { dev1: {} as RuntimeTaskSessionSummary } },
				{ state: { ...state, sessions: { dev1: {} as RuntimeTaskSessionSummary } } },
			])
				expect(await canAdoptTaskReferences({ ...base, ...update })).toBe(false);
			worktree.exists = true;
			expect(await canAdoptTaskReferences(base)).toBe(false);
			worktree.exists = false;
			const path = getTaskHistoryLogPath("demo");
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, "damaged history\n");
			await expect(canAdoptTaskReferences(base)).rejects.toThrow(/readable own task history/u);
		}));
});
