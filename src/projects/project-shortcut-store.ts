// Where a project's shortcuts (the top bar's script runner: a label, a command typed into a terminal, an icon) are
// kept: `<home>/data/<workspaceId>/shortcuts.json` (getProjectShortcutsPath), outside every repo. They used to be in
// the project's own Kanban config file (getProjectKanbanConfigPath), which a card could edit in its worktree and land
// with its work (or write through a symlinked `.cline`), planting a command the user later runs with a click. The only writer is the shortcut route (src/trpc/shortcuts-api.ts, through
// src/projects/project-shortcuts.ts), which decides who may.
//
// The first read of a project with no store imports the shortcuts of that file once: the
// committed copy on the base branch, else (a project that git-ignores `.cline/`, like foo) the main checkout's
// working-tree copy, which the old code read; never a card's worktree. It logs the import to the shortcut history
// and writes the store even when there was nothing to import: from then on the repo copy is ignored (doctor reports
// one that still has shortcuts, src/doctor/project-shortcut-checks.ts).
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { getWorkspacePipelineSettings, readPipelineConfig } from "../config/pipeline-config";
import { areRuntimeProjectShortcutsEqual, normalizeRuntimeProjectShortcuts } from "../config/shortcut-utils";
import type { RuntimeProjectShortcut } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import type { KitSettingsActor } from "../kits/project-settings";
import {
	getProjectKanbanConfigPath,
	getProjectShortcutsPath,
	getShortcutHistoryPath,
	PROJECT_KANBAN_CONFIG_RELATIVE_PATH,
} from "../state/kanban-home";
import { detectProjectBaseBranch, runGit } from "../workspace/git-utils";

/** The repo file the shortcuts used to live in, relative to the project root (getProjectKanbanConfigPath). */
export const LEGACY_PROJECT_SHORTCUTS_FILE = PROJECT_KANBAN_CONFIG_RELATIVE_PATH;

const STORE_VERSION = 1;

/** Where the one-time import read the shortcuts from; null: neither copy had any. */
export type ProjectShortcutImportSource =
	| { kind: "base-branch"; path: string; ref: string; commit: string }
	| { kind: "main-checkout"; path: string };

interface ProjectShortcutStoreFile {
	version: typeof STORE_VERSION;
	shortcuts: RuntimeProjectShortcut[];
	/** The one-time import from the repo, recorded so it never runs again. */
	imported: ProjectShortcutImportRecord;
}

export interface ProjectShortcutImportRecord {
	at: string;
	source: ProjectShortcutImportSource | null;
	/** What the import brought in, for review: a card could have written the repo copy before it. */
	shortcuts?: RuntimeProjectShortcut[];
	/** When doctor listed them for review (it lists them once). */
	listedAt?: string;
}

/** shortcuts.json exists but can't be read: never overwritten (a rewrite would drop the user's shortcuts). */
export class ProjectShortcutStoreCorruptError extends Error {}

export type ShortcutChangeVia = "shortcut add" | "shortcut remove" | "settings dialog";

export interface ShortcutChangeHistoryEntry {
	at: string;
	workspaceId: string;
	label: string;
	/** Absent: the shortcut is new. */
	from?: RuntimeProjectShortcut;
	/** Absent: the shortcut is removed. */
	to?: RuntimeProjectShortcut;
	by: KitSettingsActor;
	via: ShortcutChangeVia;
}

/** One per imported shortcut (label and command in `to`), so the history shows what the import brought in. */
export interface ShortcutImportHistoryEntry {
	at: string;
	workspaceId: string;
	label: string;
	to: RuntimeProjectShortcut;
	by: { kind: "kanban" };
	via: "import";
	source: ProjectShortcutImportSource;
}

export type ShortcutHistoryEntry = ShortcutChangeHistoryEntry | ShortcutImportHistoryEntry;

export interface ProjectShortcutStoreInput {
	workspaceId: string;
	/** The project's main checkout, where the base branch is read for the one-time import. */
	repoPath: string;
	/** Tests: the Kanban home the store and the history are in. */
	homePath?: string;
	/** Tests: the base branch (default: the workspace's defaultBaseRef, else origin's HEAD, else HEAD's branch). */
	resolveBaseBranch?: () => Promise<string | null>;
	now?: () => Date;
}

export async function appendShortcutHistory(
	entry: ShortcutHistoryEntry,
	options: { homePath?: string } = {},
): Promise<void> {
	const path = getShortcutHistoryPath(entry.workspaceId, options.homePath);
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

async function readStoreFile(path: string): Promise<ProjectShortcutStoreFile | null> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new ProjectShortcutStoreCorruptError(
			`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix or remove it, Kanban won't overwrite it`,
		);
	}
	if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { shortcuts?: unknown }).shortcuts)) {
		throw new ProjectShortcutStoreCorruptError(
			`${path} has no shortcuts list; fix or remove it, Kanban won't overwrite it`,
		);
	}
	const file = parsed as Partial<ProjectShortcutStoreFile>;
	return {
		version: STORE_VERSION,
		shortcuts: normalizeRuntimeProjectShortcuts(file.shortcuts),
		imported: file.imported ?? { at: "", source: null },
	};
}

async function writeStoreFile(path: string, file: ProjectShortcutStoreFile): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(path, file, { lock: null });
}

/** The branch the import reads: the workspace's defaultBaseRef, else origin's HEAD, else the checked-out branch. */
export async function resolveProjectShortcutBaseBranch(workspaceId: string, repoPath: string): Promise<string | null> {
	const configured = await readPipelineConfig()
		.then(({ config }) => getWorkspacePipelineSettings(config, workspaceId).defaultBaseRef)
		.catch(() => null);
	return configured ?? (await detectProjectBaseBranch(repoPath));
}

/** The base branch's commit: the local branch, else origin's; null when neither exists (no commit yet). */
async function resolveBaseCommit(repoPath: string, branch: string): Promise<{ ref: string; commit: string } | null> {
	for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
		const result = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
		if (result.ok && result.stdout) {
			return { ref, commit: result.stdout };
		}
	}
	return null;
}

type LegacyShortcutsRead = { source: ProjectShortcutImportSource; shortcuts: RuntimeProjectShortcut[] } | null;

function parseLegacyShortcuts(raw: string): RuntimeProjectShortcut[] {
	try {
		return normalizeRuntimeProjectShortcuts(JSON.parse(raw)?.shortcuts);
	} catch {
		// Not JSON: nothing the old reader would have shown either.
		return [];
	}
}

/**
 * The base branch's committed copy of that file (an object read with `git show`, so no worktree and no
 * uncommitted edit counts); null when the project has no base commit yet or the file isn't committed there.
 */
export async function readBaseBranchProjectShortcuts(
	repoPath: string,
	baseBranch: string | null,
): Promise<LegacyShortcutsRead> {
	const base = baseBranch ? await resolveBaseCommit(repoPath, baseBranch) : null;
	if (!base) {
		return null;
	}
	const object = `${base.commit}:${LEGACY_PROJECT_SHORTCUTS_FILE}`;
	if (!(await runGit(repoPath, ["cat-file", "-e", object])).ok) {
		return null;
	}
	const shown = await runGit(repoPath, ["show", object], { trimStdout: false });
	if (!shown.ok) {
		throw new Error(`could not read ${object} in ${repoPath}: ${shown.error ?? shown.stderr}`);
	}
	return {
		source: { kind: "base-branch", path: LEGACY_PROJECT_SHORTCUTS_FILE, ...base },
		shortcuts: parseLegacyShortcuts(shown.stdout),
	};
}

function isPathInside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The main checkout's working-tree copy, for a project that never committed it (git-ignored `.cline/`). Only from
 * the main checkout itself (its git dir is the common one, so never a card's linked worktree) and only a file that
 * really is inside it (not a symlink out); null otherwise or when there is none.
 */
export async function readMainCheckoutProjectShortcuts(repoPath: string): Promise<LegacyShortcutsRead> {
	const dirs = await runGit(repoPath, [
		"rev-parse",
		"--path-format=absolute",
		"--git-dir",
		"--git-common-dir",
		"--show-toplevel",
	]);
	const [gitDir, commonDir, topLevel] = dirs.ok ? dirs.stdout.split("\n") : [];
	if (!gitDir || !commonDir || !topLevel || resolve(gitDir) !== resolve(commonDir)) {
		return null;
	}
	const path = getProjectKanbanConfigPath(topLevel);
	let raw: string;
	try {
		if (!isPathInside(await realpath(path), await realpath(topLevel))) {
			return null;
		}
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
	return { source: { kind: "main-checkout", path }, shortcuts: parseLegacyShortcuts(raw) };
}

/** Reads the store, importing from the repo first when there is none. Call under the store's lock. */
async function readOrImportLocked(input: ProjectShortcutStoreInput, path: string): Promise<RuntimeProjectShortcut[]> {
	const stored = await readStoreFile(path);
	if (stored) {
		return stored.shortcuts;
	}
	const baseBranch = await (input.resolveBaseBranch?.() ??
		resolveProjectShortcutBaseBranch(input.workspaceId, input.repoPath));
	const found =
		(await readBaseBranchProjectShortcuts(input.repoPath, baseBranch)) ??
		(await readMainCheckoutProjectShortcuts(input.repoPath));
	const shortcuts = found?.shortcuts ?? [];
	const at = (input.now?.() ?? new Date()).toISOString();
	await writeStoreFile(path, {
		version: STORE_VERSION,
		shortcuts,
		imported: { at, source: found?.source ?? null, ...(shortcuts.length > 0 ? { shortcuts } : {}) },
	});
	for (const shortcut of shortcuts) {
		if (found) {
			await appendShortcutHistory(
				{
					at,
					workspaceId: input.workspaceId,
					label: shortcut.label,
					to: shortcut,
					by: { kind: "kanban" },
					via: "import",
					source: found.source,
				},
				{ homePath: input.homePath },
			);
		}
	}
	return shortcuts;
}

/** A project's shortcuts. The first read imports them from the repo once (see the header). */
export async function readProjectShortcuts(input: ProjectShortcutStoreInput): Promise<RuntimeProjectShortcut[]> {
	const path = getProjectShortcutsPath(input.workspaceId, input.homePath);
	const stored = await readStoreFile(path);
	if (stored) {
		return stored.shortcuts;
	}
	return await lockedFileSystem.withLocks([{ path, type: "file" }], async () => await readOrImportLocked(input, path));
}

/**
 * Changes a project's shortcuts under the store's lock. For the shortcut route only (src/projects/project-shortcuts.ts):
 * `plan` gets the stored shortcuts, and nothing is written when its answer is the same.
 */
export async function updateStoredProjectShortcuts(
	input: ProjectShortcutStoreInput,
	plan: (current: RuntimeProjectShortcut[]) => RuntimeProjectShortcut[],
): Promise<{ before: RuntimeProjectShortcut[]; after: RuntimeProjectShortcut[] }> {
	const path = getProjectShortcutsPath(input.workspaceId, input.homePath);
	return await lockedFileSystem.withLocks([{ path, type: "file" }], async () => {
		const before = await readOrImportLocked(input, path);
		const after = normalizeRuntimeProjectShortcuts(plan(before));
		if (!areRuntimeProjectShortcutsEqual(before, after)) {
			const stored = await readStoreFile(path);
			await writeStoreFile(path, {
				version: STORE_VERSION,
				shortcuts: after,
				imported: stored?.imported ?? { at: "", source: null },
			});
		}
		return { before, after };
	});
}

/** The store as doctor sees it (null: no store yet, the next read imports). Never imports. */
export async function readProjectShortcutStore(
	workspaceId: string,
	homePath?: string,
): Promise<{ shortcuts: RuntimeProjectShortcut[]; imported: ProjectShortcutImportRecord } | null> {
	return await readStoreFile(getProjectShortcutsPath(workspaceId, homePath));
}

/**
 * Records that doctor listed the imported shortcuts for review, so it lists them once. Only the import record
 * changes, never the shortcuts.
 */
export async function markProjectShortcutImportListed(
	workspaceId: string,
	options: { homePath?: string; now?: () => Date } = {},
): Promise<void> {
	const path = getProjectShortcutsPath(workspaceId, options.homePath);
	await lockedFileSystem.withLocks([{ path, type: "file" }], async () => {
		const stored = await readStoreFile(path);
		if (!stored || stored.imported.listedAt) {
			return;
		}
		await writeStoreFile(path, {
			...stored,
			imported: { ...stored.imported, listedAt: (options.now?.() ?? new Date()).toISOString() },
		});
	});
}
