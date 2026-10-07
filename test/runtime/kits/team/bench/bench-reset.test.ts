import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../../../../src/core/api-contract";
import { resetBench } from "../../../../../src/kits/team/bench/bench-reset";
import { getTeamBenchWorkspacePaths, type TeamBenchWorkspacePaths } from "../../../../../src/state/kanban-home";
import { createGitTestEnv } from "../../../../utilities/git-env";
import { createTempDir } from "../../../../utilities/temp-dir";

function board(reviewCards: string[] = []): RuntimeBoardData {
	const card = (id: string) => ({
		id,
		title: id,
		prompt: "",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
	});
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [card("back1")] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: reviewCards.map(card) },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	} as unknown as RuntimeBoardData;
}

let root: { path: string; cleanup: () => void };
let repo: string;
let paths: TeamBenchWorkspacePaths;

const git = (...args: string[]) =>
	execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: createGitTestEnv() }).trim();

beforeEach(() => {
	root = createTempDir("bench-reset-");
	repo = join(root.path, "repo");
	mkdirSync(repo);
	execFileSync("git", ["init", "-q", "-b", "main", repo], { env: createGitTestEnv() });
	writeFileSync(join(repo, "a.txt"), "a");
	git("add", "a.txt");
	git("commit", "-q", "-m", "init");
	paths = getTeamBenchWorkspacePaths("foo", join(root.path, "home"));
	mkdirSync(paths.dataDir, { recursive: true });
	writeFileSync(paths.scoreboardJsonl, '{"devId":"a","round":1,"verdict":"PASS","ts":"2026-10-07T00:00:00Z"}\n');
	writeFileSync(paths.qaLog, "## Claude QA a: PASS\n");
});

afterEach(() => {
	root.cleanup();
});

const input = (overrides: Partial<Parameters<typeof resetBench>[0]> = {}) => ({
	label: "tier3-v1",
	paths,
	extraFiles: [join(root.path, "missing-pipeline-state.json")],
	board: board(),
	repoPath: repo,
	baseRef: "main",
	name: "foo",
	now: new Date("2026-10-07T05:00:00Z"),
	...overrides,
});

describe("kanban bench reset", () => {
	it("archives the measurements, tags the base, empties the scoreboard and marks the QA log", async () => {
		const result = await resetBench(input());
		const snapshot = join(paths.benchSnapshotsDir, "tier3-v1");
		expect(result).toMatchObject({
			snapshotDir: snapshot,
			scoreboardLines: 1,
			tag: "bench/tier3-v1",
			tagError: null,
		});
		expect(result.files).toEqual([paths.scoreboardJsonl, paths.qaLog]);
		expect(readFileSync(join(snapshot, "scoreboard.jsonl"), "utf8")).toContain('"devId":"a"');
		expect(readFileSync(paths.scoreboardJsonl, "utf8")).toBe("");
		expect(readFileSync(paths.scoreboardMd, "utf8")).toContain("(0 lines, 0 after");
		expect(readFileSync(paths.qaLog, "utf8")).toMatch(
			/## Claude QA a: PASS\n\n## RESET tier3-v1 \(2026-10-07 05:00 UTC\)/u,
		);
		expect(git("rev-parse", "bench/tier3-v1")).toBe(git("rev-parse", "main"));
		await expect(resetBench(input())).rejects.toThrow(/exists; pick another label/u);
	});

	it("refuses while a card is In Progress or in Review unless forced, and a dry run changes nothing", async () => {
		await expect(resetBench(input({ board: board(["rev01"]) }))).rejects.toThrow(/active cards rev01 \(review\)/u);
		const dry = await resetBench(input({ board: board(["rev01"]), force: true, dryRun: true }));
		expect(dry.dryRun).toBe(true);
		expect(existsSync(dry.snapshotDir)).toBe(false);
		expect(readFileSync(paths.scoreboardJsonl, "utf8")).not.toBe("");
		await expect(resetBench(input({ label: "bad label" }))).rejects.toThrow(/may only use/u);
	});

	it("reports a failed tag and still resets", async () => {
		const result = await resetBench(input({ baseRef: "no-such-branch" }));
		expect(result.tagError).toBeTruthy();
		expect(readFileSync(paths.scoreboardJsonl, "utf8")).toBe("");
	});
});
