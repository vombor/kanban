// The only module that knows where Kanban keeps its machine state (the "Kanban home") and task worktrees.
// Everything else asks this module for paths; a test fails on hard-coded home paths anywhere else.
//
// Home resolution order:
//   1. `kanban --home <dir>` (also exported as KANBAN_HOME so child processes resolve the same home)
//   2. KANBAN_HOME
//   3. ~/.kanban, if it is an initialized home (config.json with "home": 1, or a workspaces/ dir)
//   4. ~/.cline/kanban, if it exists (legacy home)
//   5. ~/.kanban (fresh install)
//
// Worktrees root: KANBAN_WORKTREES, else `worktreesRoot` in <home>/config.json, else <home>/worktrees
// (for the legacy home: ~/.cline/worktrees, where it always lived). `legacyWorktreeRoots` in config.json
// (default ["~/.cline/worktrees"]) are searched read-only for worktrees created before a home move;
// new worktrees are never created there.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";

import type { RuntimeKanbanHomeSource, RuntimeKanbanPaths } from "../core/api-contract";

export const KANBAN_HOME_ENV = "KANBAN_HOME";
export const KANBAN_WORKTREES_ENV = "KANBAN_WORKTREES";
/** Value of `"home"` in config.json that marks an initialized Kanban home. */
export const KANBAN_HOME_MARKER_VERSION = 1;

const DEFAULT_HOME_DIR = ".kanban";
const LEGACY_HOME_PARENT_DIR = ".cline";
const LEGACY_HOME_DIR = "kanban";
const LEGACY_WORKTREES_DIR = "worktrees";
const CLINE_DATA_DIR = "data";
const CONFIG_FILENAME = "config.json";
/** Board state dir inside the home (`<home>/workspaces`). */
export const KANBAN_HOME_WORKSPACES_DIR = "workspaces";
const WORKTREES_DIR = "worktrees";
const RUN_DIR = "run";
const BACKUPS_DIR = "backups";
const KITS_DIR = "kits";
const PROJECT_CONFIG_PARENT_DIR = ".cline";
const PROJECT_CONFIG_DIR = "kanban";

export type KanbanHomeSource = RuntimeKanbanHomeSource;

export interface KanbanHomeResolution {
	homePath: string;
	source: KanbanHomeSource;
	globalConfigPath: string;
	worktreesRootPath: string;
	/** Read-only fallback roots for task worktrees created before a home move. Never contains worktreesRootPath. */
	legacyWorktreeRootPaths: string[];
}

interface KanbanHomeConfigFields {
	home?: unknown;
	worktreesRoot?: unknown;
	legacyWorktreeRoots?: unknown;
}

let homeOverridePath: string | null = null;
let cachedResolution: { key: string; resolution: KanbanHomeResolution } | null = null;

function getUserHomePath(): string {
	return homedir();
}

function expandUserPath(path: string, baseDir: string): string {
	const trimmed = path.trim();
	if (trimmed === "~") {
		return getUserHomePath();
	}
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return resolve(getUserHomePath(), trimmed.slice(2));
	}
	return resolve(baseDir, trimmed);
}

function readNonEmptyEnv(name: string): string | null {
	const value = process.env[name]?.trim();
	return value ? value : null;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function readHomeConfigFields(homePath: string): KanbanHomeConfigFields | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(homePath, CONFIG_FILENAME), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as KanbanHomeConfigFields) : null;
	} catch {
		return null;
	}
}

function isInitializedHome(homePath: string): boolean {
	if (isDirectory(join(homePath, KANBAN_HOME_WORKSPACES_DIR))) {
		return true;
	}
	return readHomeConfigFields(homePath)?.home === KANBAN_HOME_MARKER_VERSION;
}

export function getDefaultKanbanHomePath(): string {
	return join(getUserHomePath(), DEFAULT_HOME_DIR);
}

export function getLegacyKanbanHomePath(): string {
	return join(getUserHomePath(), LEGACY_HOME_PARENT_DIR, LEGACY_HOME_DIR);
}

export function getLegacyTaskWorktreesRootPath(): string {
	return join(getUserHomePath(), LEGACY_HOME_PARENT_DIR, LEGACY_WORKTREES_DIR);
}

/** Cline's own data dir. It belongs to Cline, not Kanban: the debug reset clears it, the Cline turn detector reads its sessions. */
export function getClineDataPath(): string {
	return join(getUserHomePath(), LEGACY_HOME_PARENT_DIR, CLINE_DATA_DIR);
}

/**
 * Cline's custom-provider file (`<data>/settings/models.json`), resolved the way the Cline CLI resolves it:
 * CLINE_DATA_DIR, else CLINE_DIR/data, else ~/.cline/data. `kanban setup` edits its `modelsSourceUrl`s.
 */
export function getClineModelsSettingsPath(): string {
	const clineDir = readNonEmptyEnv("CLINE_DIR");
	const dataDir =
		readNonEmptyEnv("CLINE_DATA_DIR") ?? (clineDir ? join(clineDir, CLINE_DATA_DIR) : getClineDataPath());
	return join(dataDir, "settings", "models.json");
}

function resolveHomePath(): { homePath: string; source: KanbanHomeSource } {
	if (homeOverridePath) {
		return { homePath: homeOverridePath, source: "flag" };
	}
	const envHome = readNonEmptyEnv(KANBAN_HOME_ENV);
	if (envHome) {
		return { homePath: expandUserPath(envHome, process.cwd()), source: "env" };
	}
	const defaultHome = getDefaultKanbanHomePath();
	if (isInitializedHome(defaultHome)) {
		return { homePath: defaultHome, source: "initialized" };
	}
	const legacyHome = getLegacyKanbanHomePath();
	if (existsSync(legacyHome)) {
		return { homePath: legacyHome, source: "legacy" };
	}
	return { homePath: defaultHome, source: "default" };
}

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths)];
}

export interface KanbanHomeLayoutOptions {
	/** Use the legacy defaults (worktrees in ~/.cline/worktrees). */
	legacy: boolean;
	/** Let KANBAN_WORKTREES override the worktrees root, as it does for the running process. */
	honorWorktreesEnv: boolean;
	/** Resolve against this config instead of <homePath>/config.json (for a config not written yet). */
	config?: Record<string, unknown> | null;
}

/**
 * Resolves the layout (config path, worktrees roots) of an explicit home directory, independent of
 * which home this process uses. `kanban home migrate` uses it for its source and target homes.
 */
export function resolveKanbanHomeLayout(
	homePath: string,
	options: KanbanHomeLayoutOptions,
): Omit<KanbanHomeResolution, "source"> {
	const config: KanbanHomeConfigFields | null =
		options.config !== undefined ? options.config : readHomeConfigFields(homePath);

	const envWorktrees = options.honorWorktreesEnv ? readNonEmptyEnv(KANBAN_WORKTREES_ENV) : null;
	const configWorktrees =
		typeof config?.worktreesRoot === "string" && config.worktreesRoot.trim() ? config.worktreesRoot : null;
	const defaultWorktreesRoot = options.legacy ? getLegacyTaskWorktreesRootPath() : join(homePath, WORKTREES_DIR);
	const worktreesRootPath = envWorktrees
		? expandUserPath(envWorktrees, process.cwd())
		: configWorktrees
			? expandUserPath(configWorktrees, homePath)
			: defaultWorktreesRoot;

	const configuredLegacyRoots = Array.isArray(config?.legacyWorktreeRoots)
		? config.legacyWorktreeRoots.filter((root): root is string => typeof root === "string" && root.trim() !== "")
		: null;
	const legacyWorktreeRootPaths = uniquePaths(
		(configuredLegacyRoots ?? ["~/.cline/worktrees"]).map((root) => expandUserPath(root, homePath)),
	).filter((root) => root !== worktreesRootPath);

	return {
		homePath,
		globalConfigPath: join(homePath, CONFIG_FILENAME),
		worktreesRootPath,
		legacyWorktreeRootPaths,
	};
}

function computeResolution(): KanbanHomeResolution {
	const { homePath, source } = resolveHomePath();
	return {
		...resolveKanbanHomeLayout(homePath, { legacy: source === "legacy", honorWorktreesEnv: true }),
		source,
	};
}

function getResolutionCacheKey(): string {
	return JSON.stringify([
		homeOverridePath,
		process.env[KANBAN_HOME_ENV] ?? null,
		process.env[KANBAN_WORKTREES_ENV] ?? null,
		getUserHomePath(),
	]);
}

/**
 * Resolves the Kanban home once per (flag, env, user home) combination, so a running process does not
 * switch homes because a directory appeared later.
 */
export function resolveKanbanHome(): KanbanHomeResolution {
	const key = getResolutionCacheKey();
	if (cachedResolution?.key !== key) {
		cachedResolution = { key, resolution: computeResolution() };
	}
	return cachedResolution.resolution;
}

/** Applies `kanban --home <dir>`. Also exports KANBAN_HOME so spawned agents and hook commands agree. */
export function setKanbanHomeOverride(path: string | null): void {
	homeOverridePath = path ? expandUserPath(path, process.cwd()) : null;
	if (homeOverridePath) {
		process.env[KANBAN_HOME_ENV] = homeOverridePath;
	}
	cachedResolution = null;
}

/** Test hook: forget the cached resolution and any `--home` override. */
export function resetKanbanHomeForTests(): void {
	homeOverridePath = null;
	cachedResolution = null;
}

export function getKanbanHomePath(): string {
	return resolveKanbanHome().homePath;
}

export function getKanbanGlobalConfigPath(): string {
	return resolveKanbanHome().globalConfigPath;
}

/** True when config writes should stamp `"home": 1` (any home except the legacy ~/.cline/kanban). */
export function shouldMarkKanbanHome(): boolean {
	return resolveKanbanHome().source !== "legacy";
}

/** Locks and pid files (`<home>/run`). */
export function getKanbanRunPath(homePath = getKanbanHomePath()): string {
	return join(homePath, RUN_DIR);
}

/** Backups Kanban takes before it rewrites state (`<home>/backups`). */
export function getKanbanBackupsPath(homePath = getKanbanHomePath()): string {
	return join(homePath, BACKUPS_DIR);
}

/** User routing kits (`<home>/kits/<name>.json`); the built-in kits ship in the package. */
export function getKanbanKitsPath(homePath = getKanbanHomePath()): string {
	return join(homePath, KITS_DIR);
}

export function getKanbanWorkspacesRootPath(homePath = getKanbanHomePath()): string {
	return join(homePath, KANBAN_HOME_WORKSPACES_DIR);
}

export function getTaskWorktreesRootPath(): string {
	return resolveKanbanHome().worktreesRootPath;
}

export function getLegacyTaskWorktreeRootPaths(): string[] {
	return resolveKanbanHome().legacyWorktreeRootPaths;
}

/** Every root a task worktree may live in: the current root first, then the read-only legacy roots. */
export function getTaskWorktreeSearchRootPaths(): string[] {
	const resolution = resolveKanbanHome();
	return [resolution.worktreesRootPath, ...resolution.legacyWorktreeRootPaths];
}

/** Project-local Kanban config (shortcuts). It lives in the project, not in the home. */
export function getProjectKanbanConfigPath(projectPath: string): string {
	return join(resolve(projectPath), PROJECT_CONFIG_PARENT_DIR, PROJECT_CONFIG_DIR, CONFIG_FILENAME);
}

/** Display template for the project config path when no project is selected. */
export const PROJECT_KANBAN_CONFIG_DISPLAY_PATH = `<project>/${PROJECT_CONFIG_PARENT_DIR}/${PROJECT_CONFIG_DIR}/${CONFIG_FILENAME}`;

function isUnsafeResetTarget(path: string): boolean {
	const resolvedPath = resolve(path);
	if (resolvedPath === parse(resolvedPath).root) {
		return true;
	}
	// Never delete the user's home directory or anything that contains it.
	const rel = relative(resolvedPath, getUserHomePath());
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Directories the debug "Reset all state" action deletes. */
export function getDebugResetTargetPaths(): string[] {
	const resolution = resolveKanbanHome();
	return uniquePaths([
		getClineDataPath(),
		resolution.homePath,
		resolution.worktreesRootPath,
		...resolution.legacyWorktreeRootPaths,
	]).filter((path) => !isUnsafeResetTarget(path));
}

/** The paths the web UI shows (it cannot resolve them itself). */
export function getKanbanPathsSummary(): RuntimeKanbanPaths {
	const resolution = resolveKanbanHome();
	return {
		homePath: resolution.homePath,
		homeSource: resolution.source,
		worktreesRootPath: resolution.worktreesRootPath,
		legacyWorktreeRootPaths: resolution.legacyWorktreeRootPaths,
		debugResetTargetPaths: getDebugResetTargetPaths(),
		projectConfigDisplayPath: PROJECT_KANBAN_CONFIG_DISPLAY_PATH,
	};
}
