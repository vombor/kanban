// The only module that knows where Kanban keeps its machine state (the "Kanban home") and task worktrees.
// Everything else asks this module for paths; a test fails on hard-coded home paths anywhere else.
//
// Home resolution order:
//   1. `kanban --home <dir>` (also exported as KANBAN_HOME so child processes resolve the same home)
//   2. KANBAN_HOME
//   3. ~/.kanban of the user running Kanban
// Nothing else, and no fallback: Kanban never switches to another directory because one exists (or is missing).
// ~/.cline belongs to the Cline CLI; Kanban keeps none of its own state there.
//
// Worktrees root: KANBAN_WORKTREES, else `worktreesRoot` in <home>/config.json, else <home>/worktrees. Only an
// explicit `legacyWorktreeRoots` entry in config.json (default: none) is searched, read-only, for worktrees created
// before a home move; new worktrees are never created there.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";

import type { RuntimeKanbanHomeSource, RuntimeKanbanPaths } from "../core/api-contract";

export const KANBAN_HOME_ENV = "KANBAN_HOME";
export const KANBAN_WORKTREES_ENV = "KANBAN_WORKTREES";
/** Value of `"home"` in config.json that marks an initialized Kanban home. */
export const KANBAN_HOME_MARKER_VERSION = 1;

const DEFAULT_HOME_DIR = ".kanban";
const CLINE_DIR = ".cline";
const CLINE_DATA_DIR = "data";
const CLINE_SETTINGS_DIR = "settings";
const CONFIG_FILENAME = "config.json";
/** Board state dir inside the home (`<home>/workspaces`). */
export const KANBAN_HOME_WORKSPACES_DIR = "workspaces";
const WORKTREES_DIR = "worktrees";
const RUN_DIR = "run";
const BACKUPS_DIR = "backups";
const KITS_DIR = "kits";
const DATA_DIR = "data";
const MODELS_DATA_DIR = "models";
const LOGS_DIR = "logs";
const LEGACY_KIT_BOARD_BACKUPS_DIR = "board-backups";
const LEGACY_KIT_BOARD_LATEST_FILENAME = "board-latest.json";
const PIPELINE_STATE_FILENAME = "pipeline-state.json";
const PIPELINE_DECISIONS_FILENAME = "pipeline-decisions.jsonl";
/** Names kept from the legacy kit (plan §1.2): people, prompts and history use them. */
const QA_LOG_FILENAME = "qa-log.md";
const QA_ARTIFACTS_DIR = "qa-artifacts";
const BOARD_BACKUPS_DIR = "boards";
const RESTART_MANIFEST_FILENAME = "restart-manifest.json";
const RESTART_RECOVER_REQUEST_FILENAME = "restart-recover.now";
const SERVER_START_RECORD_FILENAME = "server-start.json";
/** The legacy kit's per-card pipeline state (`checks-state.json` in its per-project data dir). */
const LEGACY_KIT_CHECKS_STATE_FILENAME = "checks-state.json";
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

function readHomeConfigFields(homePath: string): KanbanHomeConfigFields | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(homePath, CONFIG_FILENAME), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as KanbanHomeConfigFields) : null;
	} catch {
		return null;
	}
}

export function getDefaultKanbanHomePath(): string {
	return join(getUserHomePath(), DEFAULT_HOME_DIR);
}

/** The Cline CLI's own directory (~/.cline). Kanban keeps nothing there; `kanban doctor` warns about Kanban state in it. */
export function getClineHomeDirPath(): string {
	return join(getUserHomePath(), CLINE_DIR);
}

/** Cline's own data dir. It belongs to Cline, not Kanban: the Cline turn detector reads its sessions, nothing deletes it. */
export function getClineDataPath(): string {
	return join(getUserHomePath(), CLINE_DIR, CLINE_DATA_DIR);
}

/** Cline's config dir as the Cline CLI resolves it: CLINE_DIR, else ~/.cline. */
function getClineConfigDirPath(): string {
	return readNonEmptyEnv("CLINE_DIR") ?? join(getUserHomePath(), CLINE_DIR);
}

/**
 * Cline's data dir, resolved the way the Cline CLI resolves it: CLINE_DATA_DIR, else CLINE_DIR/data, else
 * ~/.cline/data. `dataDirOverride` is `agents.cline.dataDir` from config.json (null = Cline's own default).
 */
function resolveClineDataDir(dataDirOverride: string | null): string {
	if (dataDirOverride?.trim()) {
		return expandUserPath(dataDirOverride, getUserHomePath());
	}
	const clineDir = readNonEmptyEnv("CLINE_DIR");
	return readNonEmptyEnv("CLINE_DATA_DIR") ?? (clineDir ? join(clineDir, CLINE_DATA_DIR) : getClineDataPath());
}

/** Cline's data dir as the Cline CLI resolves it; `dataDirOverride` is `agents.cline.dataDir` (null = Cline's default). */
export function getClineDataDirPath(dataDirOverride: string | null = null): string {
	return resolveClineDataDir(dataDirOverride);
}

/** Cline's custom-provider file (`<data>/settings/models.json`). `kanban setup` edits its `modelsSourceUrl`s. */
export function getClineModelsSettingsPath(dataDirOverride: string | null = null): string {
	return join(resolveClineDataDir(dataDirOverride), CLINE_SETTINGS_DIR, "models.json");
}

/** Cline's provider settings (`<data>/settings/providers.json`): API keys, `lastUsedProvider`. */
export function getClineProvidersSettingsPath(dataDirOverride: string | null = null): string {
	return join(resolveClineDataDir(dataDirOverride), CLINE_SETTINGS_DIR, "providers.json");
}

/** Cline's "notice shown" record (`<data>/settings/cli-notices.json`). */
export function getClineCliNoticesPath(dataDirOverride: string | null = null): string {
	return join(resolveClineDataDir(dataDirOverride), CLINE_SETTINGS_DIR, "cli-notices.json");
}

/** Cline 3.x loads global rules from `<config>/rules` (~/.cline/rules). */
export function getClineGlobalRulesPath(): string {
	return join(getClineConfigDirPath(), "rules");
}

// The legacy dev-team kit (plan §1: "legacy kit") is a git repo in ~/.kanban until cutover (P5-3), with its own
// config and its services' pid files. `kanban doctor` reads them (read-only) for the "one owner" check, and
// `kanban config import-kit` maps its config into Kanban's. Same resolution as its lib/config.cjs.
const LEGACY_KIT_HOME_ENV = "KANBAN_KIT_HOME";
const LEGACY_KIT_CONFIG_ENV = "KIT_CONFIG";
const LEGACY_KIT_CONFIG_FILENAME = "kit.config.json";
/** Env vars that point at the legacy kit (tests clear them). */
export const LEGACY_KIT_ENV_NAMES: readonly string[] = [LEGACY_KIT_HOME_ENV, LEGACY_KIT_CONFIG_ENV];

/** The legacy kit's home: KANBAN_KIT_HOME, else ~/.kanban. */
export function getLegacyKitHomePath(): string {
	const envHome = readNonEmptyEnv(LEGACY_KIT_HOME_ENV);
	return envHome ? expandUserPath(envHome, process.cwd()) : getDefaultKanbanHomePath();
}

/** The legacy kit's config: KIT_CONFIG, else <kit home>/kit.config.json. */
export function getLegacyKitConfigPath(): string {
	const envConfig = readNonEmptyEnv(LEGACY_KIT_CONFIG_ENV);
	return envConfig
		? expandUserPath(envConfig, process.cwd())
		: join(getLegacyKitHomePath(), LEGACY_KIT_CONFIG_FILENAME);
}

/** The legacy kit's default run dir (pid files and `<service>.disabled` switches); its config may move it. */
export function getLegacyKitDefaultRunPath(): string {
	return join(getLegacyKitHomePath(), RUN_DIR);
}

/**
 * The legacy kit's autoland log (`<kit home>/logs/kanban-autoland.log`, its default `logs.autoland`), which the
 * cutover's shadow diff compares with the pipeline's decision log. Read-only.
 */
export function getLegacyKitAutolandLogPath(): string {
	return join(getLegacyKitHomePath(), LOGS_DIR, "kanban-autoland.log");
}

/**
 * The legacy kit's per-project data root (`<kit home>/data`, its default `dataRoot`; projects keep their files in
 * `<dataRoot>/<workspaceId>`). Read-only: `kanban pipeline import-legacy` copies from it at the cutover.
 */
export function getLegacyKitDefaultDataRootPath(): string {
	return join(getLegacyKitHomePath(), DATA_DIR);
}

/** Expands `~` and resolves relative paths against `baseDir`, as config values in the home are read. */
export function expandKanbanConfigPath(path: string, baseDir: string): string {
	return expandUserPath(path, baseDir);
}

function resolveHomePath(): { homePath: string; source: KanbanHomeSource } {
	if (homeOverridePath) {
		return { homePath: homeOverridePath, source: "flag" };
	}
	const envHome = readNonEmptyEnv(KANBAN_HOME_ENV);
	if (envHome) {
		return { homePath: expandUserPath(envHome, process.cwd()), source: "env" };
	}
	return { homePath: getDefaultKanbanHomePath(), source: "default" };
}

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths)];
}

export interface KanbanHomeLayoutOptions {
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
	const worktreesRootPath = envWorktrees
		? expandUserPath(envWorktrees, process.cwd())
		: configWorktrees
			? expandUserPath(configWorktrees, homePath)
			: join(homePath, WORKTREES_DIR);

	const configuredLegacyRoots = Array.isArray(config?.legacyWorktreeRoots)
		? config.legacyWorktreeRoots.filter((root): root is string => typeof root === "string" && root.trim() !== "")
		: null;
	const legacyWorktreeRootPaths = uniquePaths(
		(configuredLegacyRoots ?? []).map((root) => expandUserPath(root, homePath)),
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
		...resolveKanbanHomeLayout(homePath, { honorWorktreesEnv: true }),
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

/** The Kanban home for text people and agents read: `~/…` when it is inside the user's home directory. */
export function getKanbanHomeDisplayPath(homePath = getKanbanHomePath()): string {
	const userHome = homedir();
	const fromUserHome = relative(userHome, homePath);
	return fromUserHome && !fromUserHome.startsWith("..") && !isAbsolute(fromUserHome)
		? `~/${fromUserHome.split("\\").join("/")}`
		: homePath;
}

export function getKanbanGlobalConfigPath(): string {
	return resolveKanbanHome().globalConfigPath;
}

/** Locks and pid files (`<home>/run`). */
export function getKanbanRunPath(homePath = getKanbanHomePath()): string {
	return join(homePath, RUN_DIR);
}

/** Backups Kanban takes before it rewrites state (`<home>/backups`). */
export function getKanbanBackupsPath(homePath = getKanbanHomePath()): string {
	return join(homePath, BACKUPS_DIR);
}

/** Copies of a workspace's board.json (`<home>/backups/boards/<workspaceId>`), outside the workspaces dir on purpose. */
export function getBoardBackupsPath(workspaceId: string, homePath = getKanbanHomePath()): string {
	return join(getKanbanBackupsPath(homePath), BOARD_BACKUPS_DIR, workspaceId);
}

/** User routing kits (`<home>/kits/<name>.json`); the built-in kits ship in the package. */
export function getKanbanKitsPath(homePath = getKanbanHomePath()): string {
	return join(homePath, KITS_DIR);
}

/** Per-workspace pipeline data and machine-wide caches (`<home>/data`). */
export function getKanbanDataPath(homePath = getKanbanHomePath()): string {
	return join(homePath, DATA_DIR);
}

/** Model metadata caches, such as Bedrock's inference-profile list (`<home>/data/models`). */
export function getKanbanModelsDataPath(homePath = getKanbanHomePath()): string {
	return join(getKanbanDataPath(homePath), MODELS_DATA_DIR);
}

// The team kit's `bench` feature (plan §2.4, §6.2): model list prices and the AWS Price List cache, machine-wide.
const PRICES_DATA_DIR = "prices";
const PRICE_SYNC_LOG_FILENAME = "price-sync.log";
const LEGACY_KIT_BENCH_DIR = "bench";

export interface PricesDataPaths {
	dir: string;
	/** The price table card metrics use (`kanban models prices sync --apply` writes it). */
	pricesJson: string;
	/** Machine-generated normalized AWS rows (`kanban models prices sync` writes it). */
	pricesAwsJson: string;
	/** Hand-written price sources. */
	modelPricesMd: string;
	/** Downloaded AWS offer files. */
	rawDir: string;
	/** Offer versions and the last check. */
	state: string;
	/** The previous run's normalized rows, for change detection. */
	rowsLast: string;
	log: string;
}

/** `<home>/data/prices/…` and `<home>/logs/price-sync.log`. */
export function getPricesDataPaths(homePath = getKanbanHomePath()): PricesDataPaths {
	const dir = join(getKanbanDataPath(homePath), PRICES_DATA_DIR);
	return {
		dir,
		pricesJson: join(dir, "prices.json"),
		pricesAwsJson: join(dir, "prices-aws.json"),
		modelPricesMd: join(dir, "model-prices.md"),
		rawDir: join(dir, "raw"),
		state: join(dir, "state.json"),
		rowsLast: join(dir, "rows-last.json"),
		log: join(getKanbanLogsPath(homePath), PRICE_SYNC_LOG_FILENAME),
	};
}

/**
 * Where a price table may be, first match wins: this home's `data/prices/prices.json`, then the legacy kit's
 * `bench/prices.json` (its sync still keeps that one current until cutover moves it, plan §8.4 step 3). Read-only.
 */
export function getPriceTableCandidatePaths(homePath = getKanbanHomePath()): string[] {
	return uniquePaths([
		getPricesDataPaths(homePath).pricesJson,
		join(getLegacyKitHomePath(), LEGACY_KIT_BENCH_DIR, "prices.json"),
	]);
}

/** The team kit's per-workspace bench files (`<home>/data/<workspaceId>/…`; names kept from the legacy kit). */
export interface TeamBenchWorkspacePaths {
	dataDir: string;
	scoreboardJsonl: string;
	scoreboardMd: string;
	qaLog: string;
	attention: string;
	/** `kanban bench reset <label>` archives into `<dir>/<label>/`. */
	benchSnapshotsDir: string;
}

export function getTeamBenchWorkspacePaths(
	workspaceId: string,
	homePath = getKanbanHomePath(),
): TeamBenchWorkspacePaths {
	const { dataDir, qaLog, attention } = getWatchdogWorkspacePaths(workspaceId, homePath);
	return {
		dataDir,
		scoreboardJsonl: join(dataDir, "scoreboard.jsonl"),
		scoreboardMd: join(dataDir, "scoreboard.md"),
		qaLog,
		attention,
		benchSnapshotsDir: join(dataDir, "bench", "snapshots"),
	};
}

/**
 * Directories with board backups of a workspace, newest home first: `<home>/backups/boards/<id>` and the legacy kit's
 * `backups/board-backups/<id>` (autoland's). Card metrics look a deleted card up there. Read-only.
 */
export function getBoardBackupSearchDirs(workspaceId: string, homePath = getKanbanHomePath()): string[] {
	return uniquePaths([
		getBoardBackupsPath(workspaceId, homePath),
		join(getLegacyKitHomePath(), BACKUPS_DIR, LEGACY_KIT_BOARD_BACKUPS_DIR, workspaceId),
	]);
}

/** Codex's rollout files (`$CODEX_HOME/sessions`, else `~/.codex/sessions`); `homeOverride` is `agents.codex.home`. */
export function getCodexSessionsPath(homeOverride: string | null = null): string {
	const codexHome = homeOverride?.trim() || readNonEmptyEnv("CODEX_HOME");
	return join(
		codexHome ? expandUserPath(codexHome, getUserHomePath()) : join(getUserHomePath(), ".codex"),
		"sessions",
	);
}

/** Per-workspace pipeline data that people and agents read (`<home>/data/<workspaceId>`, plan §6.2). */
export function getKanbanWorkspaceDataPath(workspaceId: string, homePath = getKanbanHomePath()): string {
	return join(getKanbanDataPath(homePath), workspaceId);
}

/** The pipeline's per-card state (`<home>/data/<workspaceId>/pipeline-state.json`). */
export function getPipelineStatePath(workspaceId: string, homePath = getKanbanHomePath()): string {
	return join(getKanbanWorkspaceDataPath(workspaceId, homePath), PIPELINE_STATE_FILENAME);
}

/** Plan cards, their approval, the cards they expanded to and their metrics (`<home>/data/<workspaceId>/plans.json`). */
export function getPlanIndexPath(workspaceId: string, homePath = getKanbanHomePath()): string {
	return join(getKanbanWorkspaceDataPath(workspaceId, homePath), "plans.json");
}

/** The pipeline's decision log, one JSON line per decision (`<home>/data/<workspaceId>/pipeline-decisions.jsonl`). */
export function getPipelineDecisionLogPath(workspaceId: string, homePath = getKanbanHomePath()): string {
	return join(getKanbanWorkspaceDataPath(workspaceId, homePath), PIPELINE_DECISIONS_FILENAME);
}

/** The workspace's QA log (`<home>/data/<workspaceId>/qa-log.md`): check results, verdicts; people and agents read it. */
export function getPipelineQaLogPath(workspaceId: string, homePath = getKanbanHomePath()): string {
	return join(getKanbanWorkspaceDataPath(workspaceId, homePath), QA_LOG_FILENAME);
}

/** Ingested QA outboxes, `<dir>/<devTaskId>/r<round>/` (`<home>/data/<workspaceId>/qa-artifacts`). */
export function getQaArtifactsPath(workspaceId: string, homePath = getKanbanHomePath()): string {
	return join(getKanbanWorkspaceDataPath(workspaceId, homePath), QA_ARTIFACTS_DIR);
}

/** The pid of the project preview the QA gate started (`<home>/run/qa-preview-<workspaceId>.pid`). */
export function getQaPreviewMarkPath(workspaceId: string, homePath = getKanbanHomePath()): string {
	return join(getKanbanRunPath(homePath), `qa-preview-${workspaceId}.pid`);
}

/**
 * The watchdog's files for one workspace (`<home>/data/<workspaceId>/…`, plan §6.2). ATTENTION.md, qa-log.md,
 * orchestrator-plan.md, runoffs.json and calibration/ keep the legacy kit's names: people, prompts and the
 * orchestrator's memory already use them.
 */
export interface WatchdogWorkspacePaths {
	dataDir: string;
	attention: string;
	qaLog: string;
	state: string;
	decisions: string;
	orchestratorPlan: string;
	orchestratorQueue: string;
	orchestratorActions: string;
	/** `kanban orchestrator wake` requests (immediate and `--when-*`) the watchdog picks up. */
	wakeRequests: string;
	runoffs: string;
	calibrationDir: string;
}

export function getWatchdogWorkspacePaths(workspaceId: string, homePath = getKanbanHomePath()): WatchdogWorkspacePaths {
	const dataDir = getKanbanWorkspaceDataPath(workspaceId, homePath);
	return {
		dataDir,
		attention: join(dataDir, "ATTENTION.md"),
		qaLog: join(dataDir, "qa-log.md"),
		state: join(dataDir, "watchdog-state.json"),
		decisions: join(dataDir, "watchdog-decisions.jsonl"),
		orchestratorPlan: join(dataDir, "orchestrator-plan.md"),
		orchestratorQueue: join(dataDir, "orchestrator-queue.txt"),
		orchestratorActions: join(dataDir, "orchestrator-actions.md"),
		wakeRequests: join(dataDir, "orchestrator-wake-requests.json"),
		runoffs: join(dataDir, "runoffs.json"),
		calibrationDir: join(dataDir, "calibration"),
	};
}

/** Kanban's own logs (`<home>/logs`): the orchestrator's headless runs write here. */
export function getKanbanLogsPath(homePath = getKanbanHomePath()): string {
	return join(homePath, LOGS_DIR);
}

/**
 * One calibration run's files (`<home>/data/<workspaceId>/calibration/<name>/`, the legacy kit's layout): its spec,
 * resumable state, results and the judge's README/report, plus the runner's pid lock.
 */
export interface CalibrationPaths {
	dir: string;
	spec: string;
	state: string;
	resultsJson: string;
	resultsMd: string;
	readme: string;
	lock: string;
}

export function getCalibrationPaths(
	workspaceId: string,
	name: string,
	homePath = getKanbanHomePath(),
): CalibrationPaths {
	const dir = join(getWatchdogWorkspacePaths(workspaceId, homePath).calibrationDir, name);
	return {
		dir,
		spec: join(dir, "spec.json"),
		state: join(dir, "state.json"),
		resultsJson: join(dir, "results.json"),
		resultsMd: join(dir, "results.md"),
		readme: join(dir, "README.md"),
		lock: join(dir, "runner.pid"),
	};
}

/** The calibration runner's log (`<home>/logs/calibrate.log`, the legacy kit's name). */
export function getCalibrationLogPath(homePath = getKanbanHomePath()): string {
	return join(getKanbanLogsPath(homePath), "calibrate.log");
}

/** The headless orchestrator run's lock for a workspace (`<home>/run/orchestrator-<workspaceId>.lock`, holds its pid). */
export function getOrchestratorLockPath(workspaceId: string, homePath = getKanbanHomePath()): string {
	return join(getKanbanRunPath(homePath), `orchestrator-${workspaceId}.lock`);
}

/** Flag files the watchdog keeps while PID use is high (`<home>/run/pid-pressure`, `<home>/run/pid-brownout`). */
export function getPidPressureFlagPaths(homePath = getKanbanHomePath()): { pressure: string; brownout: string } {
	const runPath = getKanbanRunPath(homePath);
	return { pressure: join(runPath, "pid-pressure"), brownout: join(runPath, "pid-brownout") };
}

/** The legacy kit's newest board backup of a workspace (`<kit home>/backups/board-backups/<id>/board-latest.json`, kept by autoland until cutover). Read-only. */
export function getLegacyKitLatestBoardBackupPath(workspaceId: string): string {
	return join(
		getLegacyKitHomePath(),
		BACKUPS_DIR,
		LEGACY_KIT_BOARD_BACKUPS_DIR,
		workspaceId,
		LEGACY_KIT_BOARD_LATEST_FILENAME,
	);
}

/**
 * What `kanban restart prepare` recorded before a restart (`<home>/data/<workspaceId>/restart-manifest.json`, the
 * legacy kit's name and format).
 */
export function getRestartManifestPath(workspaceId: string, homePath = getKanbanHomePath()): string {
	return join(getKanbanWorkspaceDataPath(workspaceId, homePath), RESTART_MANIFEST_FILENAME);
}

/** The running server's pid and start time (`<home>/run/server-start.json`), for `kanban restart prepare`. */
export function getServerStartRecordPath(homePath = getKanbanHomePath()): string {
	return join(getKanbanRunPath(homePath), SERVER_START_RECORD_FILENAME);
}

/** `kanban restart recover` asks the pipeline worker to check a workspace now (`<home>/run/restart-recover.now`). */
export function getRestartRecoverRequestPath(homePath = getKanbanHomePath()): string {
	return join(getKanbanRunPath(homePath), RESTART_RECOVER_REQUEST_FILENAME);
}

/**
 * Where the legacy kit may have kept a workspace's `checks-state.json`, newest home first: the Kanban home's data dir
 * (the same file once the home is `~/.kanban`) and the legacy kit's own data dir (`<kit home>/data/<workspaceId>`,
 * `~/.kanban` unless KANBAN_KIT_HOME says otherwise; getLegacyKitHomePath()).
 * Read-only: the pipeline imports it once and never writes it.
 */
export function getLegacyKitChecksStatePaths(workspaceId: string, homePath = getKanbanHomePath()): string[] {
	return uniquePaths([
		join(getKanbanWorkspaceDataPath(workspaceId, homePath), LEGACY_KIT_CHECKS_STATE_FILENAME),
		join(getKanbanWorkspaceDataPath(workspaceId, getLegacyKitHomePath()), LEGACY_KIT_CHECKS_STATE_FILENAME),
	]);
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

function isPathInside(path: string, root: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Cline's dirs as the Cline CLI resolves them (~/.cline, CLINE_DIR, CLINE_DATA_DIR). Kanban never deletes in them. */
function getClineOwnedRootPaths(): string[] {
	return uniquePaths([getClineHomeDirPath(), getClineConfigDirPath(), resolveClineDataDir(null)]);
}

/**
 * Directories the debug "Reset all state" action deletes: Kanban's home and worktree roots only. Nothing in or
 * around Cline's dirs (Kanban writes and deletes nothing under ~/.cline, user rule 2026-10-07), so a legacy worktree
 * root under ~/.cline/worktrees is left alone too.
 */
export function getDebugResetTargetPaths(): string[] {
	const resolution = resolveKanbanHome();
	const clineRoots = getClineOwnedRootPaths();
	return uniquePaths([
		resolution.homePath,
		resolution.worktreesRootPath,
		...resolution.legacyWorktreeRootPaths,
	]).filter(
		(path) =>
			!isUnsafeResetTarget(path) && !clineRoots.some((root) => isPathInside(path, root) || isPathInside(root, path)),
	);
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
