import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { pruneDoneCards } from "../../../../src/pipeline/watchdog/prune-done";
import { checkWakeRequests, type WakeRequest } from "../../../../src/pipeline/watchdog/wake-requests";
import { restoreBoardFromBackup } from "../../../../src/state/board-restore";
import { getBoardBackupsPath, getWatchdogWorkspacePaths } from "../../../../src/state/kanban-home";
import { readTaskHistory } from "../../../../src/state/task-history-log";
import {
	getWorkspaceDirectoryPath,
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	mutateWorkspaceState,
} from "../../../../src/state/workspace-state";
import { createGitTestEnv } from "../../../utilities/git-env";
import { withTemporaryKanbanHome } from "../../../utilities/kanban-home";
import { createBoard, createCard } from "../../../utilities/workspace-state-store";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-07T12:00:00.000Z");

async function createWorkspace(userHomePath: string) {
	const repoPath = join(userHomePath, "repo");
	mkdirSync(repoPath);
	execFileSync("git", ["init", "-q"], { cwd: repoPath, env: createGitTestEnv() });
	const context = await loadWorkspaceContext(repoPath);
	return { repoPath, workspaceId: context.workspaceId };
}

describe("prune-done", () => {
	it("deletes only old Done cards, keeps undecided runoffs and running calibrations, and backs up first", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { repoPath, workspaceId } = await createWorkspace(userHomePath);
			await mutateWorkspaceState(repoPath, () => ({
				board: createBoard({
					review: [createCard({ id: "r0001", updatedAt: NOW - 10 * DAY })],
					trash: [
						createCard({ id: "old01", updatedAt: NOW - 5 * DAY }),
						createCard({ id: "new01", updatedAt: NOW - DAY }),
						createCard({ id: "run01", updatedAt: NOW - 5 * DAY }),
						createCard({ id: "cal01", updatedAt: NOW - 5 * DAY }),
					],
				}),
				value: null,
			}));
			const paths = getWatchdogWorkspacePaths(workspaceId);
			mkdirSync(join(paths.calibrationDir, "glm-v5"), { recursive: true });
			writeFileSync(
				join(paths.calibrationDir, "glm-v5", "state.json"),
				JSON.stringify({ runs: { a: { id: "cal01" } } }),
			);
			writeFileSync(paths.runoffs, JSON.stringify({ runoffs: [{ decided: false, cards: ["run01"] }] }));

			const dry = await pruneDoneCards({
				workspaceId,
				repoPath,
				days: 3,
				dryRun: true,
				now: NOW,
				trigger: "watchdog",
			});
			expect(dry.pruned.map((card) => card.id)).toEqual(["old01"]);
			expect(dry.kept.sort()).toEqual(["cal01", "run01"]);
			expect(dry.backupPath).toBeNull();

			expect((await readTaskHistory(workspaceId)).entries).toEqual([]);

			const result = await pruneDoneCards({ workspaceId, repoPath, days: 3, now: NOW, trigger: "watchdog" });
			expect(result.pruned.map((card) => card.id)).toEqual(["old01"]);
			const board = await loadWorkspaceBoardById(workspaceId);
			expect(board.columns.find((column) => column.id === "trash")?.cards.map((card) => card.id)).toEqual([
				"new01",
				"run01",
				"cal01",
			]);
			expect(result.backupPath?.startsWith(getBoardBackupsPath(workspaceId))).toBe(true);
			const backup = result.backupPath ?? "";
			expect(JSON.parse(readFileSync(join(backup, "board.json"), "utf8")).columns[3].cards).toHaveLength(4);
			expect(JSON.parse(readFileSync(join(backup, "deleted-cards-index.json"), "utf8"))).toEqual([
				expect.objectContaining({ id: "old01" }),
			]);
			expect(result.summary).toContain("deleted 1 older than 3 d (kept 2 runoff/calibration)");
			// Each deleted card is in the task history, as the watchdog's delete.
			expect((await readTaskHistory(workspaceId)).entries).toEqual([
				expect.objectContaining({
					at: new Date(NOW).toISOString(),
					action: "delete",
					taskId: "old01",
					role: "dev",
					fromColumnId: "trash",
					trigger: "watchdog",
					caller: null,
					status: "deleted",
					worktreeDeleted: false,
				}),
			]);
		});
	});
});

describe("board restore", () => {
	it("restores the newest board backup into an empty workspace dir and refuses a non-empty one", async () => {
		await withTemporaryKanbanHome(async () => {
			const backupDir = getBoardBackupsPath("ws1");
			mkdirSync(backupDir, { recursive: true });
			writeFileSync(
				join(backupDir, "board-latest.json"),
				JSON.stringify(createBoard({ backlog: [createCard({ id: "b0001" })] })),
			);
			const result = await restoreBoardFromBackup({ workspaceId: "ws1", now: NOW });
			expect(result.cards).toBe(1);
			expect(result.source).toBe(join(backupDir, "board-latest.json"));
			const dir = getWorkspaceDirectoryPath("ws1");
			expect(readdirSync(dir).sort()).toEqual(["board.json", "meta.json", "sessions.json"]);
			expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).revision).toBe(1000);
			expect(existsSync(result.copyOfSource)).toBe(true);

			await expect(restoreBoardFromBackup({ workspaceId: "ws1" })).rejects.toThrow(/is not empty/u);
			await expect(restoreBoardFromBackup({ workspaceId: "ws2" })).rejects.toThrow(/No board backup for ws2/u);
		});
	});
});

describe("wake requests --when-model-up", () => {
	it("needs two good probes a minute apart, and wakes anyway at the timeout", async () => {
		const request: WakeRequest = {
			id: "r1",
			createdAt: new Date(NOW).toISOString(),
			issue: "kimi is back: hand 096bd back",
			when: { kind: "model-up", model: "moonshotai.kimi-k3", provider: "bedrock" },
			timeoutMin: 60,
			lastProbeAt: null,
			upSince: null,
		};
		const board = createBoard({});
		const first = await checkWakeRequests({ requests: [request], board, now: NOW, probe: async () => true });
		expect(first.items).toEqual([]);
		expect(first.remaining[0]?.upSince).toBe(new Date(NOW).toISOString());
		const early = await checkWakeRequests({
			requests: first.remaining,
			board,
			now: NOW + 30_000,
			probe: async () => true,
		});
		expect(early.items).toEqual([]);
		const second = await checkWakeRequests({
			requests: first.remaining,
			board,
			now: NOW + 60_000,
			probe: async () => true,
		});
		expect(second.items).toEqual(["- kimi is back: hand 096bd back"]);
		expect(second.remaining).toEqual([]);

		const flap = await checkWakeRequests({
			requests: first.remaining,
			board,
			now: NOW + 60_000,
			probe: async () => false,
		});
		expect(flap.remaining[0]?.upSince).toBeNull();
		const timedOut = await checkWakeRequests({
			requests: flap.remaining,
			board,
			now: NOW + 61 * 60_000,
			probe: async () => false,
		});
		expect(timedOut.items[0]).toContain("timed out after 60 min: moonshotai.kimi-k3 still down");
	});
});
