import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { type BoardBackupSettings, createBoardBackups, formatBackupStamp } from "../../../src/state/board-backups";
import { getBoardBackupsPath, getKanbanGlobalConfigPath } from "../../../src/state/kanban-home";
import {
	loadWorkspaceContext,
	loadWorkspaceState,
	mutateWorkspaceState,
	saveWorkspaceState,
} from "../../../src/state/workspace-state";
import { createRepoWithWorktree } from "../../utilities/git-repo";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createTempDir } from "../../utilities/temp-dir";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const DEFAULTS = parsePipelineConfig({}).config.backups.board;

describe("board backups", () => {
	const temps: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const temp of temps.splice(0)) {
			temp.cleanup();
		}
	});

	function setup(settings: Partial<BoardBackupSettings> = {}, startMs = Date.parse("2026-10-07T10:00:00.000Z")) {
		const temp = createTempDir("kanban-board-backups-");
		temps.push(temp);
		let nowMs = startMs;
		const errors: unknown[] = [];
		const backups = createBoardBackups({
			readSettings: async () => ({ ...DEFAULTS, ...settings }),
			getDir: (workspaceId) => join(temp.path, workspaceId),
			now: () => nowMs,
			onError: (_workspaceId, error) => errors.push(error),
		});
		return {
			backups,
			dir: join(temp.path, "foo"),
			errors,
			advanceMin: (minutes: number) => {
				nowMs += minutes * 60_000;
			},
		};
	}

	const stamped = (dir: string) =>
		readdirSync(dir)
			.filter((file) => /^board-\d{8}T\d{6}\.json$/.test(file))
			.sort();

	it("writes board-latest.json on every write and a timestamped copy at most every everyMin", async () => {
		const { backups, dir, advanceMin, errors } = setup({ everyMin: 10 });
		await backups.backup("foo", createBoard({ backlog: [createCard({ id: "a" })] }));
		advanceMin(3);
		await backups.backup("foo", createBoard({ backlog: [createCard({ id: "b" })] }));

		expect(JSON.parse(readFileSync(join(dir, "board-latest.json"), "utf8")).columns[0].cards[0].id).toBe("b");
		expect(stamped(dir)).toEqual(["board-20261007T100000.json"]);

		advanceMin(10);
		await backups.backup("foo", createBoard({ backlog: [createCard({ id: "c" })] }));
		expect(stamped(dir)).toEqual(["board-20261007T100000.json", "board-20261007T101300.json"]);
		expect(errors).toEqual([]);
	});

	it("keeps the newest `keep` timestamped copies", async () => {
		const { backups, dir, advanceMin } = setup({ everyMin: 1, keep: 2 });
		for (let index = 0; index < 4; index += 1) {
			await backups.backup("foo", createBoard({}));
			advanceMin(1);
		}
		expect(stamped(dir)).toEqual(["board-20261007T100200.json", "board-20261007T100300.json"]);
	});

	it("a restarted process reads the newest copy from the dir instead of writing one at once", async () => {
		const first = setup({ everyMin: 10 });
		await first.backups.backup("foo", createBoard({}));
		const second = createBoardBackups({
			readSettings: async () => ({ ...DEFAULTS, everyMin: 10 }),
			getDir: () => first.dir,
			now: () => Date.parse("2026-10-07T10:05:00.000Z"),
		});
		await second.backup("foo", createBoard({}));
		expect(stamped(first.dir)).toEqual(["board-20261007T100000.json"]);
	});

	it("writes nothing when disabled, and a failure never throws", async () => {
		const disabled = setup({ enabled: false });
		await disabled.backups.backup("foo", createBoard({}));
		expect(existsSync(disabled.dir)).toBe(false);

		const broken = setup();
		mkdirSync(join(broken.dir, ".."), { recursive: true });
		writeFileSync(broken.dir, "a file where the dir should be");
		await expect(broken.backups.backup("foo", createBoard({}))).resolves.toBeUndefined();
		expect(broken.errors).toHaveLength(1);
	});

	it("formats stamps in UTC", () => {
		expect(formatBackupStamp(Date.parse("2026-10-04T23:10:00.000Z"))).toBe("20261004T231000");
	});

	it("every board write (save and atomic mutation) backs up the board outside the workspaces dir", async () => {
		await withTemporaryKanbanHome(async () => {
			const repo = createRepoWithWorktree("kanban-backup-repo-");
			temps.push(repo);
			const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
			try {
				const initial = await loadWorkspaceState(repo.repoPath);
				const dir = getBoardBackupsPath((await loadWorkspaceContext(repo.repoPath)).workspaceId);
				await saveWorkspaceState(repo.repoPath, {
					board: createBoard({ backlog: [createCard({ id: "saved" })] }),
					sessions: {},
					expectedRevision: initial.revision,
				});
				expect(readFileSync(join(dir, "board-latest.json"), "utf8")).toContain('"saved"');

				await mutateWorkspaceState(repo.repoPath, () => ({
					board: createBoard({ review: [createCard({ id: "mutated" })] }),
					value: null,
				}));
				expect(readFileSync(join(dir, "board-latest.json"), "utf8")).toContain('"mutated"');
				expect(stamped(dir)).toHaveLength(1);

				// backups.board.enabled false in config.json turns it off.
				mkdirSync(join(getKanbanGlobalConfigPath(), ".."), { recursive: true });
				writeFileSync(getKanbanGlobalConfigPath(), JSON.stringify({ backups: { board: { enabled: false } } }));
				await mutateWorkspaceState(repo.repoPath, () => ({
					board: createBoard({ review: [createCard({ id: "not-backed-up" })] }),
					value: null,
				}));
				expect(readFileSync(join(dir, "board-latest.json"), "utf8")).toContain('"mutated"');
				expect(warn).not.toHaveBeenCalled();
			} finally {
				warn.mockRestore();
			}
		});
	});
});
