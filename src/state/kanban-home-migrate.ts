// `kanban home migrate --from <dir>`: copies Kanban's state from an old home into a new home,
// marks the new home, and records where the old task worktrees live. Plan: docs/fork/kit-merge-plan.md §6, §8.3, §8.4.
//
// Rules:
// - The source is never modified. Files already in the target are never overwritten (a re-run is a no-op,
//   and boards written by a server on the new home win over the legacy copy).
// - Refuses while a Kanban server runs for either home, and when the target is a git repository (the
//   legacy dev-team kit in the default home dir: board files there would be untracked files in the kit repo, §8.3).
// - A backup tarball goes into <target>/backups before anything is written.
// - The resolver treats a home with workspaces/ or the config.json marker as initialized, so a half-copied
//   target must have neither. Everything is staged in <target>/.migrate-staging first; workspaces/ and
//   config.json are renamed into place last. A leftover staging dir (interrupted run) is rebuilt on re-run.
// - Worktrees stay where they are (found through legacyWorktreeRoots) unless `--worktrees` is given, and
//   even then only worktrees of idle cards (Backlog/Done, no running session, not `git worktree lock`ed) move.
// - data/ (pipeline state, decision logs, scoreboard, runoffs, plans, prices, models, restart manifests) and
//   run/server-start.json (restart recovery matches the old server's restart manifest by it) are copied too. For
//   these the newer file wins: a target file that differs is kept when it is as new as the source's or newer (a
//   conflict, reported), and replaced only by a strictly newer source file, after the target's version is saved to
//   <target>/backups/home-migrate-<ts>/. Every other target file is never overwritten.
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { buildKanbanRuntimeUrl, getKanbanRuntimeOrigin, getRuntimeFetch } from "../core/runtime-endpoint";
import { runGit } from "../workspace/git-utils";
import { KANBAN_TRASHED_TASK_PATCHES_DIR_NAME } from "../workspace/task-worktree";
import {
	getWorkspaceFolderLabelForWorktreePath,
	normalizeTaskIdForWorktreePath,
} from "../workspace/task-worktree-path";
import {
	getKanbanBackupsPath,
	getKanbanDataPath,
	getKanbanWorkspacesRootPath,
	getServerStartRecordPath,
	KANBAN_HOME_MARKER_VERSION,
	KANBAN_HOME_WORKSPACES_DIR,
	resolveKanbanHomeLayout,
} from "./kanban-home";
import { getKanbanServerLockPath, readLiveKanbanServerLock } from "./kanban-server-lock";

const CONFIG_FILENAME = "config.json";
const INDEX_FILENAME = "index.json";
const BOARD_FILENAME = "board.json";
const SESSIONS_FILENAME = "sessions.json";
const STAGING_DIR = ".migrate-staging";
// Agent hook configs; agent-session-adapters.ts writes them to <home>/hooks/<agent>.
const HOOKS_DIR = "hooks";
// Directories that are home state. Every top-level file is home state too (config.json is merged, not
// copied), and so is data/ (getDataDirName); other top-level directories (run/, backups/, ...) are runtime output
// and are not copied, except the server start record (getServerStartRecordRelativePath).
const MIGRATED_DIRS = [KANBAN_HOME_WORKSPACES_DIR, HOOKS_DIR, KANBAN_TRASHED_TASK_PATCHES_DIR_NAME];
// Lock files, pid files (a calibration runner's lock) and half-written temp files belong to the process that made them.
const TRANSIENT_ENTRY_PATTERN = /\.(?:lock|tmp|pid)$/u;
// Cards in these columns are not running and will not be resumed on restart.
const IDLE_COLUMN_IDS: ReadonlySet<string> = new Set(["backlog", "trash", "done"]);

/**
 * `keep-target`: the target's file differs and is kept (for data/ and the server start record a conflict: the
 * target's is as new or newer). `replace`: data/ and the server start record only, the source's is strictly newer;
 * the target's version is saved to the run's backup dir first.
 */
export type HomeMigrateFileAction = "copy" | "unchanged" | "keep-target" | "replace";

export interface HomeMigrateFileStep {
	/** Path relative to both homes. */
	path: string;
	kind: "file" | "symlink";
	action: HomeMigrateFileAction;
}

export interface HomeMigrateConfigStep {
	action: "create" | "update" | "unchanged";
	/** The config.json the target ends up with. */
	config: Record<string, unknown>;
	/** Keys set in both homes to different values; the target's value is kept. */
	keptTargetKeys: string[];
}

export interface HomeMigrateWorktreeStep {
	workspaceId: string;
	taskId: string;
	repoPath: string;
	from: string;
	to: string;
	/** `relink`: moved by an earlier, interrupted run; only the target's session record still points at `from`. */
	action: "move" | "relink" | "skip";
	reason: string | null;
}

export interface HomeMigratePlan {
	fromPath: string;
	toPath: string;
	/** Reasons the migration refuses to run. Empty when it can run. */
	blockers: string[];
	files: HomeMigrateFileStep[];
	config: HomeMigrateConfigStep;
	/** Top-level source entries that are not Kanban home state and are not copied. */
	ignoredEntries: string[];
	/** Where the target looks for new and old task worktrees after the migration. */
	worktreesRootPath: string;
	legacyWorktreeRootPaths: string[];
	/** Only filled with `--worktrees`. */
	worktrees: HomeMigrateWorktreeStep[];
	/** The runtime endpoint that was asked whether a server is running. */
	probedOrigin: string;
	/** Path of the backup tarball the run writes (nothing is written when there is nothing to do). */
	backupPath: string;
	/** Where the run saves the target's version of every `replace` file, at its path relative to the home. */
	replacedBackupPath: string;
	/** True when there is nothing left to write. */
	upToDate: boolean;
}

export interface HomeMigrateWorktreeResult extends HomeMigrateWorktreeStep {
	moved: boolean;
	error: string | null;
}

export interface HomeMigrateResult {
	plan: HomeMigratePlan;
	executed: boolean;
	backupPath: string | null;
	worktrees: HomeMigrateWorktreeResult[];
}

export interface RunningServerProbe {
	origin: string;
	/** The home the server reports, or null for a server that does not report one. */
	homePath: string | null;
}

export interface HomeMigrateOptions {
	fromPath: string;
	/** Where the source home's task worktrees are, when its config.json doesn't say (`worktreesRoot`). */
	fromWorktreesPath?: string;
	toPath: string;
	dryRun?: boolean;
	moveWorktrees?: boolean;
	now?: () => Date;
	/** Looks for a server at the configured runtime endpoint (null: nothing answered). Tests inject a stub. */
	probeRuntimeServer?: () => Promise<RunningServerProbe | null>;
}

const workspaceIndexSchema = z.object({
	entries: z.record(z.string(), z.object({ workspaceId: z.string(), repoPath: z.string() })),
});

const boardSchema = z.object({
	columns: z.array(z.object({ id: z.string(), cards: z.array(z.object({ id: z.string() }).passthrough()) })),
});

const sessionsSchema = z.record(
	z.string(),
	z.object({ state: z.string().optional(), workspacePath: z.string().nullable().optional() }).passthrough(),
);
type SessionRecords = z.infer<typeof sessionsSchema>;

const configResponseSchema = z.object({
	result: z.object({
		data: z.object({ kanbanPaths: z.object({ homePath: z.string() }).optional() }).passthrough(),
	}),
});

function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function readConfigObject(path: string): Record<string, unknown> | null {
	const parsed = readJsonFile(path);
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

function readSessions(path: string): SessionRecords | null {
	const parsed = sessionsSchema.safeParse(readJsonFile(path));
	return parsed.success ? parsed.data : null;
}

function writeJsonFileAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.migrate-${process.pid}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tempPath, path);
}

function isDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function isPathUnder(path: string, root: string): boolean {
	return path.startsWith(`${root}${sep}`);
}

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths.map((path) => resolve(path)))];
}

interface SourceEntry {
	path: string;
	kind: "file" | "symlink";
}

function listEntriesRecursive(root: string, relativeDir: string): SourceEntry[] {
	const entries: SourceEntry[] = [];
	for (const entry of readdirSync(join(root, relativeDir), { withFileTypes: true })) {
		if (TRANSIENT_ENTRY_PATTERN.test(entry.name)) {
			continue;
		}
		const path = join(relativeDir, entry.name);
		if (entry.isDirectory()) {
			entries.push(...listEntriesRecursive(root, path));
		} else if (entry.isFile()) {
			entries.push({ path, kind: "file" });
		} else if (entry.isSymbolicLink()) {
			entries.push({ path, kind: "symlink" });
		}
	}
	return entries;
}

/** `data/`, relative to a home: the pipeline's, the watchdog's and the team kit's files, restart manifests. */
function getDataDirName(homePath: string): string {
	return relative(homePath, getKanbanDataPath(homePath));
}

/** `run/server-start.json`, relative to a home: restart recovery matches the old server's restart manifest by it. */
function getServerStartRecordRelativePath(homePath: string): string {
	return relative(homePath, getServerStartRecordPath(homePath));
}

/** The files the newer copy wins for: everything under data/ and the server start record. */
function isNewerWinsPath(homePath: string, path: string): boolean {
	return path.startsWith(`${getDataDirName(homePath)}${sep}`) || path === getServerStartRecordRelativePath(homePath);
}

function listSourceEntries(fromPath: string): { entries: SourceEntry[]; ignoredEntries: string[] } {
	if (!isDirectory(fromPath)) {
		return { entries: [], ignoredEntries: [] };
	}
	const entries: SourceEntry[] = [];
	const ignoredEntries: string[] = [];
	const migratedDirs = [...MIGRATED_DIRS, getDataDirName(fromPath)];
	const serverStartRecord = getServerStartRecordRelativePath(fromPath);
	if (lstatSync(join(fromPath, serverStartRecord), { throwIfNoEntry: false })?.isFile()) {
		entries.push({ path: serverStartRecord, kind: "file" });
	}
	for (const entry of readdirSync(fromPath, { withFileTypes: true })) {
		if (entry.name === CONFIG_FILENAME || entry.name === STAGING_DIR || TRANSIENT_ENTRY_PATTERN.test(entry.name)) {
			continue;
		}
		if (entry.isDirectory()) {
			if (migratedDirs.includes(entry.name)) {
				entries.push(...listEntriesRecursive(fromPath, entry.name));
			} else {
				ignoredEntries.push(`${entry.name}/`);
			}
		} else if (entry.isFile()) {
			entries.push({ path: entry.name, kind: "file" });
		} else if (entry.isSymbolicLink()) {
			entries.push({ path: entry.name, kind: "symlink" });
		} else {
			ignoredEntries.push(entry.name);
		}
	}
	return { entries, ignoredEntries };
}

function entriesEqual(sourcePath: string, targetPath: string, kind: SourceEntry["kind"]): boolean {
	try {
		if (kind === "symlink") {
			return isSymlink(targetPath) && readlinkSync(sourcePath) === readlinkSync(targetPath);
		}
		return !isSymlink(targetPath) && readFileSync(sourcePath).equals(readFileSync(targetPath));
	} catch {
		return false;
	}
}

/**
 * A target sessions.json whose only differences are session paths that `--worktrees` moved into the
 * target's worktrees root is the migrated copy of the source, not a newer board.
 */
function sessionsEquivalentAfterMove(
	sourcePath: string,
	targetPath: string,
	sourceWorktreeRootPaths: string[],
	targetWorktreesRootPath: string,
): boolean {
	const source = readSessions(sourcePath);
	const target = readSessions(targetPath);
	if (!source || !target) {
		return false;
	}
	const normalize = (sessions: SessionRecords) =>
		Object.fromEntries(
			Object.entries(sessions).map(([taskId, session]) => {
				const root = [...sourceWorktreeRootPaths, targetWorktreesRootPath].find(
					(candidate) => session.workspacePath && isPathUnder(session.workspacePath, candidate),
				);
				return [
					taskId,
					root && session.workspacePath
						? { ...session, workspacePath: `<worktrees>/${relative(root, session.workspacePath)}` }
						: session,
				];
			}),
		);
	return isDeepStrictEqual(normalize(source), normalize(target));
}

interface PlannedConfig {
	step: HomeMigrateConfigStep;
	worktreesRootPath: string;
	legacyWorktreeRootPaths: string[];
	/** Roots the source home's worktrees may be in. */
	sourceWorktreeRootPaths: string[];
}

function planConfig(fromPath: string, toPath: string, fromWorktreesPath: string | undefined): PlannedConfig {
	const sourceConfig = readConfigObject(join(fromPath, CONFIG_FILENAME)) ?? {};
	const targetConfig = readConfigObject(join(toPath, CONFIG_FILENAME));
	const sourceLayout = resolveKanbanHomeLayout(fromPath, {
		honorWorktreesEnv: false,
		config: fromWorktreesPath ? { ...sourceConfig, worktreesRoot: resolve(fromWorktreesPath) } : sourceConfig,
	});
	const sourceWorktreeRootPaths = uniquePaths([
		sourceLayout.worktreesRootPath,
		...sourceLayout.legacyWorktreeRootPaths,
	]);

	// The target's own values win, then the source's; the marker and legacy roots are always set.
	const merged: Record<string, unknown> = { ...sourceConfig, ...(targetConfig ?? {}) };
	merged.home = KANBAN_HOME_MARKER_VERSION;
	const targetRootPath = resolveKanbanHomeLayout(toPath, {
		honorWorktreesEnv: true,
		config: merged,
	}).worktreesRootPath;
	const existingLegacyRoots = Array.isArray(targetConfig?.legacyWorktreeRoots)
		? targetConfig.legacyWorktreeRoots.filter((root): root is string => typeof root === "string")
		: [];
	const addedLegacyRoots = sourceWorktreeRootPaths.filter(
		(root) => root !== resolve(targetRootPath) && !existingLegacyRoots.includes(root),
	);
	merged.legacyWorktreeRoots = [...existingLegacyRoots, ...addedLegacyRoots];

	const targetLayout = resolveKanbanHomeLayout(toPath, { honorWorktreesEnv: true, config: merged });
	const keptTargetKeys = targetConfig
		? Object.keys(sourceConfig).filter(
				(key) => key in targetConfig && !isDeepStrictEqual(sourceConfig[key], targetConfig[key]),
			)
		: [];
	const action = !targetConfig ? "create" : isDeepStrictEqual(merged, targetConfig) ? "unchanged" : "update";
	return {
		step: { action, config: merged, keptTargetKeys },
		worktreesRootPath: targetLayout.worktreesRootPath,
		legacyWorktreeRootPaths: targetLayout.legacyWorktreeRootPaths,
		sourceWorktreeRootPaths,
	};
}

function planFiles(fromPath: string, toPath: string, config: PlannedConfig): HomeMigrateFileStep[] {
	return listSourceEntries(fromPath).entries.map(({ path, kind }) => {
		const sourcePath = join(fromPath, path);
		const targetPath = join(toPath, path);
		let action: HomeMigrateFileAction;
		if (!existsSync(targetPath) && !isSymlink(targetPath)) {
			action = "copy";
		} else if (
			entriesEqual(sourcePath, targetPath, kind) ||
			(basename(path) === SESSIONS_FILENAME &&
				sessionsEquivalentAfterMove(
					sourcePath,
					targetPath,
					config.sourceWorktreeRootPaths,
					config.worktreesRootPath,
				))
		) {
			action = "unchanged";
		} else if (isNewerWinsPath(fromPath, path) && isStrictlyNewer(sourcePath, targetPath)) {
			action = "replace";
		} else {
			action = "keep-target";
		}
		return { path, kind, action };
	});
}

function isStrictlyNewer(sourcePath: string, targetPath: string): boolean {
	try {
		return lstatSync(sourcePath).mtimeMs > lstatSync(targetPath).mtimeMs;
	} catch {
		return false;
	}
}

function isWrittenByRun(file: HomeMigrateFileStep): boolean {
	return file.action === "copy" || file.action === "replace";
}

/** Paths the run creates directories along must not be files: a copy would fail half-way (ENOTDIR). */
function findPathConflicts(toPath: string, relativePaths: string[]): string[] {
	const conflicts = new Set<string>();
	// Paths outside the target (a worktreesRoot elsewhere) are created by git, not by the copy.
	for (const relativePath of relativePaths.filter((path) => !path.startsWith(".."))) {
		let current = toPath;
		for (const segment of [
			"",
			...dirname(relativePath)
				.split(sep)
				.filter((part) => part && part !== "."),
		]) {
			current = segment ? join(current, segment) : current;
			if (!existsSync(current)) {
				break;
			}
			if (!statSync(current).isDirectory()) {
				conflicts.add(current);
				break;
			}
		}
	}
	return [...conflicts].map((path) => `${path} is in the way: it is not a directory. Move it aside first.`);
}

interface WorktreeInfo {
	locked: boolean;
}

async function listGitWorktrees(repoPath: string): Promise<Map<string, WorktreeInfo>> {
	const worktrees = new Map<string, WorktreeInfo>();
	const result = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
	if (!result.ok) {
		return worktrees;
	}
	let current: string | null = null;
	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			current = resolve(line.slice("worktree ".length));
			worktrees.set(current, { locked: false });
		} else if (current && (line === "locked" || line.startsWith("locked "))) {
			worktrees.set(current, { locked: true });
		}
	}
	return worktrees;
}

async function planWorktrees(
	fromPath: string,
	toPath: string,
	config: PlannedConfig,
): Promise<HomeMigrateWorktreeStep[]> {
	const workspacesRoot = getKanbanWorkspacesRootPath(fromPath);
	const index = workspaceIndexSchema.safeParse(readJsonFile(join(workspacesRoot, INDEX_FILENAME)));
	if (!index.success) {
		return [];
	}
	const searchRoots = config.sourceWorktreeRootPaths.filter((root) => root !== resolve(config.worktreesRootPath));
	const steps: HomeMigrateWorktreeStep[] = [];
	for (const { workspaceId, repoPath } of Object.values(index.data.entries)) {
		const board = boardSchema.safeParse(readJsonFile(join(workspacesRoot, workspaceId, BOARD_FILENAME)));
		if (!board.success) {
			continue;
		}
		const sessions = readSessions(join(workspacesRoot, workspaceId, SESSIONS_FILENAME));
		const targetSessions = readSessions(join(getKanbanWorkspacesRootPath(toPath), workspaceId, SESSIONS_FILENAME));
		const gitWorktrees = isDirectory(repoPath) ? await listGitWorktrees(repoPath) : new Map<string, WorktreeInfo>();
		const label = getWorkspaceFolderLabelForWorktreePath(repoPath);
		for (const column of board.data.columns) {
			for (const card of column.cards) {
				let taskId: string;
				try {
					taskId = normalizeTaskIdForWorktreePath(card.id);
				} catch {
					continue;
				}
				const candidates = searchRoots.map((root) => join(root, taskId, label));
				const to = join(config.worktreesRootPath, taskId, label);
				const from = candidates.find((path) => isDirectory(path));
				if (!from) {
					// Moved by an interrupted run whose session rewrite did not happen.
					const recordedPath = targetSessions?.[taskId]?.workspacePath;
					if (recordedPath && candidates.includes(recordedPath) && isDirectory(to)) {
						steps.push({ workspaceId, taskId, repoPath, from: recordedPath, to, action: "relink", reason: null });
					}
					continue;
				}
				const sessionState = sessions?.[taskId]?.state;
				const reason = !IDLE_COLUMN_IDS.has(column.id)
					? `card is in ${column.id}; live worktrees are never moved`
					: sessionState === "running"
						? "card has a running session"
						: !isDirectory(repoPath)
							? `repository ${repoPath} is missing`
							: gitWorktrees.get(resolve(from))?.locked
								? "worktree is locked (git worktree lock)"
								: existsSync(to)
									? `${to} already exists`
									: null;
				steps.push({ workspaceId, taskId, repoPath, from, to, action: reason ? "skip" : "move", reason });
			}
		}
	}
	return steps;
}

/** Asks the server at the configured runtime endpoint which home it serves. */
export async function probeConfiguredRuntimeServer(): Promise<RunningServerProbe | null> {
	const origin = getKanbanRuntimeOrigin();
	let response: Response;
	try {
		const runtimeFetch = await getRuntimeFetch();
		response = await runtimeFetch(buildKanbanRuntimeUrl("/api/trpc/runtime.getConfig"), {
			method: "GET",
			signal: AbortSignal.timeout(1_500),
		});
	} catch {
		return null;
	}
	// Something answers on the port. Only a Kanban server that reports its home can be told apart.
	const parsed = configResponseSchema.safeParse(await response.json().catch(() => null));
	return { origin, homePath: parsed.success ? (parsed.data.result.data.kanbanPaths?.homePath ?? null) : null };
}

async function findBlockers(
	fromPath: string,
	toPath: string,
	probeRuntimeServer: () => Promise<RunningServerProbe | null>,
): Promise<string[]> {
	const blockers: string[] = [];
	const fromToTo = relative(fromPath, toPath);
	const toToFrom = relative(toPath, fromPath);
	if (fromToTo === "") {
		blockers.push(`Source and target are the same directory (${fromPath}).`);
	} else if (!fromToTo.startsWith("..") || !toToFrom.startsWith("..")) {
		blockers.push(`Source ${fromPath} and target ${toPath} must not contain each other.`);
	}
	if (!existsSync(join(fromPath, CONFIG_FILENAME)) && !isDirectory(getKanbanWorkspacesRootPath(fromPath))) {
		blockers.push(`${fromPath} has no Kanban state (no config.json, no workspaces/).`);
	}
	if (existsSync(join(toPath, ".git"))) {
		blockers.push(
			`${toPath} is a git repository (the legacy dev-team kit?). Board files would become untracked files in it. ` +
				"Retire the repository first (plan §8.3, P5-3) or choose another target with --to.",
		);
	}
	for (const homePath of [fromPath, toPath]) {
		const lock = readLiveKanbanServerLock(homePath);
		if (lock) {
			const lockPath = getKanbanServerLockPath(homePath);
			blockers.push(
				`A Kanban server (pid ${lock.pid}, ${lock.url}) is running for ${homePath} (recorded in ${lockPath}). ` +
					`Stop it first. If pid ${lock.pid} is not a Kanban server (check \`ps -p ${lock.pid} -o args\`), ` +
					`the record is stale: delete ${lockPath}.`,
			);
		}
	}
	const probe = await probeRuntimeServer();
	if (probe && (probe.homePath === null || [fromPath, toPath].includes(resolve(probe.homePath)))) {
		blockers.push(
			`A Kanban server answers at ${probe.origin}${probe.homePath ? ` for ${probe.homePath}` : " (its home is unknown)"}. Stop it first.`,
		);
	}
	return blockers;
}

function formatBackupTimestamp(date: Date): string {
	return date
		.toISOString()
		.replace(/\.\d+Z$/u, "Z")
		.replace(/:/gu, "-");
}

export async function planKanbanHomeMigration(options: HomeMigrateOptions): Promise<HomeMigratePlan> {
	if (!options.fromPath?.trim()) {
		throw new Error("The source home is required (--from <dir>).");
	}
	const fromPath = resolve(options.fromPath);
	const toPath = resolve(options.toPath);
	const blockers = await findBlockers(fromPath, toPath, options.probeRuntimeServer ?? probeConfiguredRuntimeServer);
	const config = planConfig(fromPath, toPath, options.fromWorktreesPath);
	const files = planFiles(fromPath, toPath, config);
	const worktrees = options.moveWorktrees ? await planWorktrees(fromPath, toPath, config) : [];
	const timestamp = formatBackupTimestamp((options.now ?? (() => new Date()))());
	const backupPath = join(getKanbanBackupsPath(toPath), `home-migrate-${timestamp}.tgz`);
	const replacedBackupPath = join(getKanbanBackupsPath(toPath), `home-migrate-${timestamp}`);
	blockers.push(
		...findPathConflicts(toPath, [
			...files.filter(isWrittenByRun).map((file) => file.path),
			...worktrees.filter((step) => step.action === "move").map((step) => relative(toPath, step.to)),
			join(STAGING_DIR, CONFIG_FILENAME),
			relative(toPath, backupPath),
		]),
	);
	return {
		fromPath,
		toPath,
		blockers,
		files,
		config: config.step,
		ignoredEntries: listSourceEntries(fromPath).ignoredEntries,
		worktreesRootPath: config.worktreesRootPath,
		legacyWorktreeRootPaths: config.legacyWorktreeRootPaths,
		worktrees,
		probedOrigin: getKanbanRuntimeOrigin(),
		backupPath,
		replacedBackupPath,
		upToDate:
			config.step.action === "unchanged" &&
			!files.some(isWrittenByRun) &&
			worktrees.every((worktree) => worktree.action === "skip"),
	};
}

/** Archives the state the migration reads and the target files it may rewrite, with paths from the filesystem root. */
function writeBackupTarball(plan: HomeMigratePlan): void {
	const topLevel = [
		CONFIG_FILENAME,
		...MIGRATED_DIRS,
		getDataDirName(plan.toPath),
		getServerStartRecordRelativePath(plan.toPath),
		...plan.files.filter((file) => !file.path.includes(sep)).map((file) => file.path),
	];
	const sources = [...new Set(topLevel)]
		.flatMap((entry) => [join(plan.fromPath, entry), join(plan.toPath, entry)])
		.filter((path) => existsSync(path) || isSymlink(path));
	const root = parse(plan.toPath).root;
	mkdirSync(dirname(plan.backupPath), { recursive: true });
	const result = spawnSync(
		"tar",
		["-czf", plan.backupPath, "-C", root, ...sources.map((path) => relative(root, path))],
		{
			encoding: "utf8",
		},
	);
	if (result.status !== 0) {
		throw new Error(`Backup failed (tar -czf ${plan.backupPath}): ${result.stderr?.trim() || result.error?.message}`);
	}
}

function copyEntry(sourcePath: string, targetPath: string, kind: SourceEntry["kind"]): void {
	mkdirSync(dirname(targetPath), { recursive: true });
	if (kind === "symlink") {
		symlinkSync(readlinkSync(sourcePath), targetPath);
		return;
	}
	copyFileSync(sourcePath, targetPath);
	const source = statSync(sourcePath);
	chmodSync(targetPath, source.mode & 0o7777);
	// The newer-wins rule compares mtimes, so a copy keeps the source's.
	utimesSync(targetPath, source.atime, source.mtime);
}

/** Saves the target's version of every file the run replaces, at its path under the run's backup dir. */
function backupReplacedFiles(plan: HomeMigratePlan): void {
	for (const file of plan.files.filter((step) => step.action === "replace")) {
		copyEntry(join(plan.toPath, file.path), join(plan.replacedBackupPath, file.path), file.kind);
	}
}

/** Copies everything the run writes into the staging dir. Nothing outside it is touched. */
function stage(plan: HomeMigratePlan, stagingPath: string): void {
	rmSync(stagingPath, { recursive: true, force: true });
	mkdirSync(stagingPath, { recursive: true });
	for (const file of plan.files) {
		if (isWrittenByRun(file)) {
			copyEntry(join(plan.fromPath, file.path), join(stagingPath, file.path), file.kind);
		}
	}
	if (plan.config.action !== "unchanged") {
		writeJsonFileAtomic(join(stagingPath, CONFIG_FILENAME), plan.config.config);
	}
}

/**
 * Renames staged entries into the target. Entries that do not make the home initialized go first;
 * workspaces/ (one rename when the target has none yet) and config.json with the marker go last.
 */
function commitStaged(plan: HomeMigratePlan, stagingPath: string): void {
	const workspacesPrefix = `${KANBAN_HOME_WORKSPACES_DIR}${sep}`;
	const staged = plan.files.filter(isWrittenByRun);
	const renameIntoPlace = (relativePath: string) => {
		const targetPath = join(plan.toPath, relativePath);
		mkdirSync(dirname(targetPath), { recursive: true });
		renameSync(join(stagingPath, relativePath), targetPath);
	};
	for (const file of staged.filter((step) => !step.path.startsWith(workspacesPrefix))) {
		renameIntoPlace(file.path);
	}
	const stagedWorkspaces = staged.filter((step) => step.path.startsWith(workspacesPrefix));
	if (stagedWorkspaces.length > 0) {
		if (existsSync(getKanbanWorkspacesRootPath(plan.toPath))) {
			for (const file of stagedWorkspaces) {
				renameIntoPlace(file.path);
			}
		} else {
			renameIntoPlace(KANBAN_HOME_WORKSPACES_DIR);
		}
	}
	if (plan.config.action !== "unchanged") {
		renameIntoPlace(CONFIG_FILENAME);
	}
	rmSync(stagingPath, { recursive: true, force: true });
}

function pruneEmptyDirectory(path: string): void {
	try {
		if (readdirSync(path).length === 0) {
			rmdirSync(path);
		}
	} catch {
		// Not empty or already gone.
	}
}

async function moveWorktree(step: HomeMigrateWorktreeStep): Promise<string | null> {
	mkdirSync(dirname(step.to), { recursive: true });
	// No fallback to a plain rename: it would bypass `git worktree lock` and git's other refusals.
	const moved = await runGit(step.repoPath, ["worktree", "move", step.from, step.to]);
	if (!moved.ok) {
		pruneEmptyDirectory(dirname(step.to));
		return `git worktree move failed: ${moved.stderr || moved.error}`;
	}
	pruneEmptyDirectory(dirname(step.from));
	return null;
}

/** Points the target's session records of moved worktrees at their new paths. */
function rewriteSessionWorkspacePaths(toPath: string, moved: HomeMigrateWorktreeStep[]): void {
	const byWorkspace = new Map<string, HomeMigrateWorktreeStep[]>();
	for (const worktree of moved) {
		byWorkspace.set(worktree.workspaceId, [...(byWorkspace.get(worktree.workspaceId) ?? []), worktree]);
	}
	for (const [workspaceId, worktrees] of byWorkspace) {
		const sessionsPath = join(getKanbanWorkspacesRootPath(toPath), workspaceId, SESSIONS_FILENAME);
		const sessions = readSessions(sessionsPath);
		if (!sessions) {
			continue;
		}
		let changed = false;
		for (const worktree of worktrees) {
			const session = sessions[worktree.taskId];
			if (session?.workspacePath === worktree.from) {
				sessions[worktree.taskId] = { ...session, workspacePath: worktree.to };
				changed = true;
			}
		}
		if (changed) {
			writeJsonFileAtomic(sessionsPath, sessions);
		}
	}
}

export async function runKanbanHomeMigration(options: HomeMigrateOptions): Promise<HomeMigrateResult> {
	const plan = await planKanbanHomeMigration(options);
	if (options.dryRun || plan.blockers.length > 0 || plan.upToDate) {
		return { plan, executed: false, backupPath: null, worktrees: [] };
	}
	writeBackupTarball(plan);
	backupReplacedFiles(plan);
	const stagingPath = join(plan.toPath, STAGING_DIR);
	try {
		stage(plan, stagingPath);
	} catch (error) {
		rmSync(stagingPath, { recursive: true, force: true });
		throw error;
	}
	commitStaged(plan, stagingPath);
	const worktrees: HomeMigrateWorktreeResult[] = [];
	for (const step of plan.worktrees) {
		if (step.action === "move") {
			const error = await moveWorktree(step);
			worktrees.push({ ...step, moved: error === null, error });
		} else {
			worktrees.push({ ...step, moved: step.action === "relink", error: null });
		}
	}
	rewriteSessionWorkspacePaths(
		plan.toPath,
		worktrees.filter((worktree) => worktree.moved),
	);
	return { plan, executed: true, backupPath: plan.backupPath, worktrees };
}
