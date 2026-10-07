// `kanban doctor`'s rows for Kanban state outside its home. The home is KANBAN_HOME (or --home), else ~/.kanban,
// with no fallback; ~/.cline belongs to the Cline CLI. So a `legacyWorktreeRoots` entry (worktrees left behind by a
// home move) and any Kanban home, board, state file or task worktree found under ~/.cline are warnings: they should
// drain or move, and nothing in Kanban should create them again.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { KANBAN_HOME_MARKER_VERSION, KANBAN_HOME_WORKSPACES_DIR } from "../state/kanban-home";
import type { DoctorFinding } from "./doctor-report";

export interface HomeLocationCheckInput {
	homePath: string;
	configPath: string;
	/** `legacyWorktreeRoots` from config.json, resolved. */
	legacyWorktreeRootPaths: string[];
	/** The Cline CLI's directory (~/.cline). */
	clineDirPath: string;
}

async function listDirectories(path: string): Promise<string[]> {
	try {
		return (await readdir(path, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/** Task worktrees under a root (`<root>/<taskId>/<repo>` with a `.git` file). */
async function listTaskWorktrees(rootPath: string): Promise<string[]> {
	const worktrees: string[] = [];
	for (const taskDir of await listDirectories(rootPath)) {
		for (const repoDir of await listDirectories(join(rootPath, taskDir))) {
			if (await isFile(join(rootPath, taskDir, repoDir, ".git"))) {
				worktrees.push(join(rootPath, taskDir, repoDir));
			}
		}
	}
	return worktrees;
}

async function hasHomeMarker(dirPath: string): Promise<boolean> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(dirPath, "config.json"), "utf8"));
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			(parsed as { home?: unknown }).home === KANBAN_HOME_MARKER_VERSION
		);
	} catch {
		return false;
	}
}

/** What Kanban state a directory holds: a home (marker, workspaces/, boards), pipeline state, or nothing. */
async function describeKanbanState(dirPath: string): Promise<string | null> {
	const workspaces = join(dirPath, KANBAN_HOME_WORKSPACES_DIR);
	const boards = (
		await Promise.all(
			(await listDirectories(workspaces)).map(async (id) => await isFile(join(workspaces, id, "board.json"))),
		)
	).filter(Boolean).length;
	if (boards > 0 || (await isFile(join(workspaces, "index.json"))) || (await hasHomeMarker(dirPath))) {
		return `a Kanban home${boards > 0 ? ` (${boards} board(s))` : ""}`;
	}
	const dataDir = join(dirPath, "data");
	for (const id of await listDirectories(dataDir)) {
		if (await isFile(join(dataDir, id, "pipeline-state.json"))) {
			return "Kanban pipeline state";
		}
	}
	return null;
}

export async function checkHomeLocation(input: HomeLocationCheckInput): Promise<DoctorFinding[]> {
	const findings: DoctorFinding[] = [];
	const legacyRoots = new Set(input.legacyWorktreeRootPaths.map((root) => resolve(root)));
	for (const root of legacyRoots) {
		const left = await listTaskWorktrees(root);
		findings.push({
			level: "warn",
			area: "home",
			message: `${input.configPath} legacyWorktreeRoots lists ${root} (${left.length} task worktree(s) there): Kanban still looks for worktrees outside its home`,
			hint:
				left.length > 0
					? `once those cards are Done (or their worktrees moved under ${input.homePath}/worktrees), remove the entry`
					: "remove the entry",
		});
	}
	const clineDir = resolve(input.clineDirPath);
	if (resolve(input.homePath).startsWith(`${clineDir}/`) || resolve(input.homePath) === clineDir) {
		findings.push({
			level: "warn",
			area: "home",
			message: `the Kanban home ${input.homePath} is inside ${clineDir}, which belongs to the Cline CLI`,
			hint: "move the home (kanban home migrate --from <this home> --to ~/.kanban) and unset KANBAN_HOME",
		});
	}
	for (const name of await listDirectories(clineDir)) {
		const dirPath = join(clineDir, name);
		if (legacyRoots.has(dirPath) || resolve(input.homePath) === dirPath) {
			continue; // reported above
		}
		const state = await describeKanbanState(dirPath);
		const worktrees = state ? [] : await listTaskWorktrees(dirPath);
		if (!state && worktrees.length === 0) {
			continue;
		}
		findings.push({
			level: "warn",
			area: "home",
			message: `${dirPath} holds ${state ?? `${worktrees.length} Kanban task worktree(s)`} inside the Cline CLI's directory; Kanban does not use it`,
			hint: state
				? `with Kanban stopped, copy what you need into the home (kanban home migrate --from ${dirPath}), then move it out of ${clineDir}; a home kept for a rollback can live anywhere (KANBAN_HOME=<dir> runs Kanban on it)`
				: `finish or move those cards' worktrees under ${input.homePath}/worktrees`,
		});
	}
	return findings;
}
