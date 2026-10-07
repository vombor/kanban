// `kanban bench reset <label>`: archive a workspace's QA measurements and start a fresh scoreboard (user, 2026-10-05:
// "snapshot the results and reset the QA measurements" before the tier-3 runoff).
// Copies scoreboard.jsonl/.md, qa-log.md, pipeline-state.json and model-prices.md to
// `data/<ws>/bench/snapshots/<label>/`, tags the base branch as `bench/<label>`, empties scoreboard.jsonl, rebuilds
// scoreboard.md and appends a "## RESET <label>" marker to the QA log (the log itself is kept: QA rounds are counted
// from it). Refuses while any card is In Progress or in Review, unless forced.
//
// Ported from archive/devteam-kit:bench/snapshot-reset.mjs@264680fc.
import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import type { RuntimeBoardData } from "../../../core/api-contract";
import { createGitProcessEnv } from "../../../core/git-process-env";
import type { TeamBenchWorkspacePaths } from "../../../state/kanban-home";
import { rebuildScoreboardMarkdown } from "../scoreboard/scoreboard-store";

const execFileAsync = promisify(execFile);
const LABEL_PATTERN = /^[\w.-]+$/u;
const ACTIVE_COLUMNS = new Set(["in_progress", "review"]);

export interface BenchResetInput {
	label: string;
	paths: TeamBenchWorkspacePaths;
	/** Other files archived with the scoreboard when they exist (pipeline-state.json, model-prices.md). */
	extraFiles: string[];
	board: RuntimeBoardData;
	repoPath: string;
	baseRef: string;
	/** Shown in scoreboard.md's title. */
	name: string;
	force?: boolean;
	dryRun?: boolean;
	now?: Date;
}

export interface BenchResetResult {
	snapshotDir: string;
	files: string[];
	scoreboardLines: number;
	tag: string;
	/** Why the tag wasn't created, when it wasn't. */
	tagError: string | null;
	dryRun: boolean;
}

async function exists(path: string): Promise<boolean> {
	return await stat(path).then(
		() => true,
		() => false,
	);
}

export function isValidBenchLabel(label: string): boolean {
	return LABEL_PATTERN.test(label);
}

/** Cards that make a reset unsafe (they would score into the old or the new scoreboard), as "<id> (<column>)". */
export function listActiveBenchCards(board: RuntimeBoardData): string[] {
	return board.columns
		.filter((column) => ACTIVE_COLUMNS.has(column.id))
		.flatMap((column) => column.cards.map((card) => `${card.id} (${column.id})`));
}

export async function resetBench(input: BenchResetInput): Promise<BenchResetResult> {
	if (!isValidBenchLabel(input.label)) {
		throw new Error(`label "${input.label}" may only use letters, digits, ".", "_" and "-"`);
	}
	const active = listActiveBenchCards(input.board);
	if (active.length && !input.force) {
		throw new Error(`not resetting: active cards ${active.join(", ")} (--force to override)`);
	}
	const snapshotDir = join(input.paths.benchSnapshotsDir, input.label);
	if (await exists(snapshotDir)) {
		throw new Error(`${snapshotDir} exists; pick another label`);
	}
	const candidates = [input.paths.scoreboardJsonl, input.paths.scoreboardMd, input.paths.qaLog, ...input.extraFiles];
	const files: string[] = [];
	for (const file of candidates) {
		if (await exists(file)) {
			files.push(file);
		}
	}
	const scoreboardText = await readFile(input.paths.scoreboardJsonl, "utf8").catch(() => "");
	const scoreboardLines = scoreboardText.split("\n").filter(Boolean).length;
	const tag = `bench/${input.label}`;
	if (input.dryRun) {
		return { snapshotDir, files, scoreboardLines, tag, tagError: null, dryRun: true };
	}

	await mkdir(snapshotDir, { recursive: true });
	for (const file of files) {
		await copyFile(file, join(snapshotDir, basename(file)));
	}
	let tagError: string | null = null;
	try {
		await execFileAsync("git", ["-C", input.repoPath, "tag", tag, input.baseRef], { env: createGitProcessEnv() });
	} catch (error) {
		tagError =
			(error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
	}
	await mkdir(input.paths.dataDir, { recursive: true });
	await writeFile(input.paths.scoreboardJsonl, "");
	const now = input.now ?? new Date();
	await rebuildScoreboardMarkdown({ paths: input.paths, name: input.name, now });
	await appendFile(
		input.paths.qaLog,
		`\n## RESET ${input.label} (${now.toISOString().slice(0, 16).replace("T", " ")} UTC)\n- QA measurements archived to ${snapshotDir}; scoreboard restarted empty.\n`,
	);
	return { snapshotDir, files, scoreboardLines, tag, tagError, dryRun: false };
}
