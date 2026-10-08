// `kanban project rename-id <old> <new>`: changes a project's workspace id (user request, 2026-10-07). A user action
// like project add/create (USER_ONLY_COMMANDS in src/isolation/cli-scope.ts refuses it from every agent session),
// run in a restart window: it refuses while a Kanban server runs on the home, since it rewrites files the server
// holds open. That also rules out the console-code approval project add/create use under `enforce`, which needs the
// server; no agent session survives a stopped server.
//
// State (moved or rewritten): every path named after the id (getWorkspaceIdKeyedPaths: workspaces/<id>, data/<id>,
// backups/boards/<id>, the QA preview pid, the orchestrator lock), the index entry, config.json `workspaces.<id>` (the
// removed `orchestrator.wake.target` is deleted), the home-agent session ids (`__home_agent__:<id>:<agent>`, in every
// workspace's sessions.json), every workspace's messages.jsonl (replies look the original up by `toWorkspaceId`),
// calibration specs' `workspace`, the `[<id>]` tags of its headless orchestrator queue (a run drops lines tagged with
// another id), and `kanban restart recover` requests. History (left as written): decision logs, the
// watchdog's, isolation.jsonl, scoreboard.jsonl, qa-log.md, ATTENTION.md, orchestrator notes, logs/,
// pipeline-state.json's `importedFrom`, trashed-task patches, and backups. Task worktrees are keyed by task id and
// per-launch files (hook commands, rules) are rewritten by the next launch, so neither is touched; nor is anything
// under ~/.cline or the legacy kit's files.
//
// Idempotent: the plan's steps go into a journal (getProjectRenameJournalPath) after the backup and before the first
// change, and each step is marked done after it runs; every step also checks the files, so a step interrupted before
// it was marked runs again harmlessly. A rerun with the same ids finishes the journal's steps. The index is
// rewritten last, so until the end the old id stays registered.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";

import { migrateLegacyConfigKeys, readLegacyWakeTarget, updatePipelineConfigFile } from "../config/pipeline-config";
import { HOME_AGENT_SESSION_PREFIX, isHomeAgentSessionIdForWorkspace } from "../core/home-agent-session";
import { getKanbanRuntimeOrigin } from "../core/runtime-endpoint";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	getCalibrationPaths,
	getIsolationWorkspacePaths,
	getKanbanBackupsPath,
	getKanbanDataPath,
	getKanbanHomePath,
	getKanbanWorkspaceDataPath,
	getKanbanWorkspaceIndexPath,
	getKanbanWorkspacesRootPath,
	getProjectRenameJournalPath,
	getReservedDataDirNames,
	getRestartRecoverRequestPath,
	getWatchdogWorkspacePaths,
	getWorkspaceIdKeyedPaths,
	resolveKanbanHomeLayout,
} from "../state/kanban-home";
import {
	findRunningKanbanServerBlockers,
	formatBackupTimestamp,
	type RunningServerProbe,
} from "../state/kanban-home-migrate";

/** The ids Kanban makes from a repo folder name (workspace-state.ts toWorkspaceIdBase): lowercase words and dashes. */
const WORKSPACE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_WORKSPACE_ID_LENGTH = 64;
const JOURNAL_VERSION = 1;
const SESSIONS_FILENAME = "sessions.json";
// Files bigger than this aren't scanned for leftover mentions of the old paths.
const MENTION_SCAN_MAX_BYTES = 2 * 1024 * 1024;

const stepSchema = z.discriminatedUnion("kind", [
	/** A leftover at a new-id path (not a registered project's) goes to the run's backup dir. Paths relative to the home. */
	z.object({ kind: z.literal("move-aside"), path: z.string(), to: z.string() }),
	/** Leftover `__home_agent__:<new>:*` summaries, saved to `to` (relative) and dropped. */
	z.object({ kind: z.literal("move-aside-sessions"), to: z.string() }),
	/** A leftover config.json `workspaces.<new>`, saved to `to` (relative) and dropped. */
	z.object({ kind: z.literal("move-aside-config"), to: z.string() }),
	z.object({ kind: z.literal("move"), from: z.string(), to: z.string() }),
	z.object({
		kind: z.literal("rewrite"),
		target: z.enum([
			"sessions",
			"messages",
			"calibration-specs",
			"restart-requests",
			"orchestrator-queue",
			"config",
			"index",
		]),
	}),
]);
export type ProjectRenameIdStep = z.infer<typeof stepSchema>;
type RewriteTarget = Extract<ProjectRenameIdStep, { kind: "rewrite" }>["target"];

const journalSchema = z.object({
	version: z.literal(JOURNAL_VERSION),
	fromId: z.string(),
	toId: z.string(),
	repoPath: z.string(),
	startedAt: z.string(),
	backupPath: z.string(),
	steps: z.array(stepSchema),
	/** Steps 0..done-1 have run. */
	done: z.number().int().nonnegative(),
});
type ProjectRenameJournal = z.infer<typeof journalSchema>;

const indexSchema = z
	.object({
		version: z.number(),
		entries: z.record(z.string(), z.object({ workspaceId: z.string(), repoPath: z.string() }).passthrough()),
		repoPathToId: z.record(z.string(), z.string()),
	})
	.passthrough();
type WorkspaceIndex = z.infer<typeof indexSchema>;

export interface ProjectRenameIdRewrite {
	/** Path relative to the home, where the file is now. */
	file: string;
	detail: string;
}

export interface ProjectRenameIdPlan {
	homePath: string;
	fromId: string;
	toId: string;
	repoPath: string | null;
	/** Reasons it refuses to run. Empty when it can run. */
	blockers: string[];
	/** True when a journal of an interrupted run with these ids is finished. */
	resumed: boolean;
	/** True when there is nothing left to do (an earlier run finished). */
	upToDate: boolean;
	steps: Array<ProjectRenameIdStep & { done: boolean }>;
	/** What the rewrite steps change in the files as they are now. */
	rewrites: ProjectRenameIdRewrite[];
	/** Files in the project's data dir that still name the old paths (history, notes, scripts): left as they are. */
	mentions: string[];
	backupPath: string;
	moveAsidePath: string;
	probedOrigin: string;
}

export interface ProjectRenameIdResult {
	plan: ProjectRenameIdPlan;
	executed: boolean;
	backupPath: string | null;
}

export interface ProjectRenameIdOptions {
	fromId: string;
	toId: string;
	/** Default: the Kanban home this process uses. */
	homePath?: string;
	dryRun?: boolean;
	moveAside?: boolean;
	now?: () => Date;
	/** Looks for a server at the configured runtime endpoint (null: nothing answered). Tests inject a stub. */
	probeRuntimeServer?: () => Promise<RunningServerProbe | null>;
	/** Tests: runs after a step and before it is marked done (a throw is an interruption). */
	afterStep?: (step: ProjectRenameIdStep, index: number) => void;
}

/** Why `id` can't be a workspace id, or null. */
export function describeInvalidWorkspaceId(id: string): string | null {
	if (!WORKSPACE_ID_PATTERN.test(id) || id.length > MAX_WORKSPACE_ID_LENGTH) {
		return `"${id}" is not a valid workspace id: lowercase letters, digits and single dashes (a-z, 0-9, -), at most ${MAX_WORKSPACE_ID_LENGTH} characters.`;
	}
	if (getReservedDataDirNames().includes(id)) {
		return `"${id}" is reserved: data/${id} holds machine-wide data.`;
	}
	return null;
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathExists(path: string): boolean {
	return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function listDirectories(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(path, value, { lock: null });
}

async function writeText(path: string, text: string): Promise<void> {
	await lockedFileSystem.writeTextFileAtomic(path, text, { lock: null });
}

function readIndex(homePath: string): WorkspaceIndex | null {
	const parsed = indexSchema.safeParse(readJson(getKanbanWorkspaceIndexPath(homePath)));
	return parsed.success ? parsed.data : null;
}

function readJournal(homePath: string): ProjectRenameJournal | null {
	const parsed = journalSchema.safeParse(readJson(getProjectRenameJournalPath(homePath)));
	return parsed.success ? parsed.data : null;
}

/** Replaces one key of an object, keeping the key order. */
function renameKey(object: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(object)) {
		if (key === to && key !== from) {
			continue;
		}
		next[key === from ? to : key] = value;
	}
	return next;
}

function renameHomeAgentSessionId(sessionId: string, fromId: string, toId: string): string {
	return `${HOME_AGENT_SESSION_PREFIX}${toId}:${sessionId.slice(`${HOME_AGENT_SESSION_PREFIX}${fromId}:`.length)}`;
}

function listSessionFiles(homePath: string): string[] {
	const root = getKanbanWorkspacesRootPath(homePath);
	return listDirectories(root)
		.map((name) => join(root, name, SESSIONS_FILENAME))
		.filter((path) => existsSync(path));
}

/** Where the project's data dir is now: the old id's until the move, then the new id's. */
function currentDataDir(homePath: string, fromId: string, toId: string): { id: string; path: string } {
	const fromPath = getKanbanWorkspaceDataPath(fromId, homePath);
	return existsSync(fromPath)
		? { id: fromId, path: fromPath }
		: { id: toId, path: getKanbanWorkspaceDataPath(toId, homePath) };
}

interface RewriteContext {
	homePath: string;
	fromId: string;
	toId: string;
	repoPath: string;
	apply: boolean;
}

type Rewriter = (context: RewriteContext) => Promise<ProjectRenameIdRewrite[]>;

const rewriteSessions: Rewriter = async ({ homePath, fromId, toId, apply }) => {
	const rewrites: ProjectRenameIdRewrite[] = [];
	for (const path of listSessionFiles(homePath)) {
		const sessions = readJson(path);
		if (!isObject(sessions)) {
			continue;
		}
		const renamed = Object.keys(sessions).filter((key) => isHomeAgentSessionIdForWorkspace(key, fromId));
		if (renamed.length === 0) {
			continue;
		}
		let next = sessions;
		for (const key of renamed) {
			const newKey = renameHomeAgentSessionId(key, fromId, toId);
			const summary = next[key];
			next = renameKey(next, key, newKey);
			next[newKey] = isObject(summary) ? { ...summary, taskId: newKey } : summary;
		}
		rewrites.push({
			file: relative(homePath, path),
			detail: `session ids ${renamed.join(", ")} → ${renamed.map((key) => renameHomeAgentSessionId(key, fromId, toId)).join(", ")}`,
		});
		if (apply) {
			await writeJson(path, next);
		}
	}
	return rewrites;
};

const rewriteMessages: Rewriter = async ({ homePath, fromId, toId, apply }) => {
	const rewrites: ProjectRenameIdRewrite[] = [];
	for (const workspaceDir of listDirectories(getKanbanDataPath(homePath))) {
		const path = getIsolationWorkspacePaths(workspaceDir, homePath).messages;
		if (!existsSync(path)) {
			continue;
		}
		let changed = 0;
		const lines = readFileSync(path, "utf8")
			.split("\n")
			.map((line) => {
				if (!line.trim()) {
					return line;
				}
				let message: unknown;
				try {
					message = JSON.parse(line);
				} catch {
					return line;
				}
				if (!isObject(message) || (message.fromWorkspaceId !== fromId && message.toWorkspaceId !== fromId)) {
					return line;
				}
				changed += 1;
				return JSON.stringify({
					...message,
					...(message.fromWorkspaceId === fromId ? { fromWorkspaceId: toId } : {}),
					...(message.toWorkspaceId === fromId ? { toWorkspaceId: toId } : {}),
				});
			});
		if (changed === 0) {
			continue;
		}
		rewrites.push({
			file: relative(homePath, path),
			detail: `${changed} message(s): from/toWorkspaceId ${fromId} → ${toId}`,
		});
		if (apply) {
			await writeText(path, lines.join("\n"));
		}
	}
	return rewrites;
};

const rewriteCalibrationSpecs: Rewriter = async ({ homePath, fromId, toId, apply }) => {
	const rewrites: ProjectRenameIdRewrite[] = [];
	const data = currentDataDir(homePath, fromId, toId);
	for (const name of listDirectories(getWatchdogWorkspacePaths(data.id, homePath).calibrationDir)) {
		const path = getCalibrationPaths(data.id, name, homePath).spec;
		const spec = readJson(path);
		if (!isObject(spec) || spec.workspace !== fromId) {
			continue;
		}
		rewrites.push({ file: relative(homePath, path), detail: `workspace ${fromId} → ${toId}` });
		if (apply) {
			await writeJson(path, { ...spec, workspace: toId });
		}
	}
	return rewrites;
};

const rewriteRestartRequests: Rewriter = async ({ homePath, fromId, toId, apply }) => {
	const path = getRestartRecoverRequestPath(homePath);
	if (!existsSync(path)) {
		return [];
	}
	let changed = 0;
	const lines = readFileSync(path, "utf8")
		.split("\n")
		.map((line) => {
			// "<iso> <workspaceId>" (restart-recovery.ts requestRestartRecovery).
			const [at, workspaceId, ...rest] = line.trim().split(/\s+/u);
			if (workspaceId !== fromId) {
				return line;
			}
			changed += 1;
			return [at, toId, ...rest].join(" ");
		});
	if (changed === 0) {
		return [];
	}
	if (apply) {
		await writeText(path, lines.join("\n"));
	}
	return [{ file: relative(homePath, path), detail: `${changed} request line(s): ${fromId} → ${toId}` }];
};

function getConfigPath(homePath: string): string {
	return resolveKanbanHomeLayout(homePath, { honorWorktreesEnv: false }).globalConfigPath;
}

const rewriteConfig: Rewriter = async ({ homePath, fromId, toId, apply }) => {
	const configPath = getConfigPath(homePath);
	const config = readJson(configPath);
	if (!isObject(config)) {
		return [];
	}
	const details: string[] = [];
	if (isObject(config.workspaces) && fromId in config.workspaces) {
		details.push(`workspaces.${fromId} → workspaces.${toId}`);
	}
	// The removed machine-wide wake target is deleted (as doctor --fix does), never renamed: every workspace wakes
	// its own orchestrator now (docs/fork/watchdog-isolation.md).
	if (readLegacyWakeTarget(config) !== undefined) {
		details.push("removed orchestrator.wake.target (no longer used)");
	}
	if (details.length === 0) {
		return [];
	}
	if (apply) {
		await updatePipelineConfigFile((raw) => {
			const next = { ...raw };
			if (isObject(next.workspaces) && fromId in next.workspaces) {
				next.workspaces = renameKey(next.workspaces, fromId, toId);
			}
			return readLegacyWakeTarget(next) === undefined ? next : migrateLegacyConfigKeys(next).config;
		}, configPath);
	}
	return [{ file: relative(homePath, configPath), detail: details.join("; ") }];
};

/** The `[<id>]` tags of the project's headless orchestrator queue lines; a run drops lines tagged with another id. */
const rewriteOrchestratorQueue: Rewriter = async ({ homePath, fromId, toId, apply }) => {
	const data = currentDataDir(homePath, fromId, toId);
	const path = getWatchdogWorkspacePaths(data.id, homePath).orchestratorQueue;
	if (!existsSync(path)) {
		return [];
	}
	let changed = 0;
	const tag = `[${fromId}]`;
	const lines = readFileSync(path, "utf8")
		.split("\n")
		.map((line) => {
			// "<iso> [<workspaceId>] <issue>" (headless-run.ts appendOrchestratorQueue).
			const [at, workspaceTag, ...rest] = line.split(" ");
			if (workspaceTag !== tag) {
				return line;
			}
			changed += 1;
			return [at, `[${toId}]`, ...rest].join(" ");
		});
	if (changed === 0) {
		return [];
	}
	if (apply) {
		await writeText(path, lines.join("\n"));
	}
	return [{ file: relative(homePath, path), detail: `${changed} queued line(s): [${fromId}] → [${toId}]` }];
};

const rewriteIndex: Rewriter = async ({ homePath, fromId, toId, repoPath, apply }) => {
	const index = readIndex(homePath);
	if (!index?.entries[fromId]) {
		return [];
	}
	if (apply) {
		const entries = renameKey(index.entries, fromId, toId) as WorkspaceIndex["entries"];
		entries[toId] = { ...index.entries[fromId], workspaceId: toId, repoPath };
		await writeJson(getKanbanWorkspaceIndexPath(homePath), {
			...index,
			entries,
			repoPathToId: { ...index.repoPathToId, [repoPath]: toId },
		});
	}
	return [
		{ file: relative(homePath, getKanbanWorkspaceIndexPath(homePath)), detail: `${fromId} → ${toId} (${repoPath})` },
	];
};

const REWRITERS: Record<RewriteTarget, Rewriter> = {
	sessions: rewriteSessions,
	messages: rewriteMessages,
	"calibration-specs": rewriteCalibrationSpecs,
	"restart-requests": rewriteRestartRequests,
	"orchestrator-queue": rewriteOrchestratorQueue,
	config: rewriteConfig,
	// Last: until it runs, the old id is the registered one.
	index: rewriteIndex,
};

/** `__home_agent__:<toId>:*` summaries in any sessions.json: leftovers of an earlier project with that id. */
function findLeftoverSessions(homePath: string, toId: string): Array<{ path: string; keys: string[] }> {
	return listSessionFiles(homePath)
		.map((path) => {
			const sessions = readJson(path);
			return {
				path,
				keys: isObject(sessions)
					? Object.keys(sessions).filter((key) => isHomeAgentSessionIdForWorkspace(key, toId))
					: [],
			};
		})
		.filter((file) => file.keys.length > 0);
}

function hasConfigWorkspace(homePath: string, workspaceId: string): boolean {
	const config = readJson(getConfigPath(homePath));
	return isObject(config) && isObject(config.workspaces) && workspaceId in config.workspaces;
}

/** Files in the project's data dir that still name `data/<old>` or `workspaces/<old>` (none of them is read back by id). */
function findMentions(homePath: string, fromId: string, toId: string): string[] {
	const data = currentDataDir(homePath, fromId, toId);
	const needles = [`data/${fromId}`, `workspaces/${fromId}`];
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else if (entry.isFile() && statSync(path).size <= MENTION_SCAN_MAX_BYTES) {
				const text = readFileSync(path, "utf8");
				if (needles.some((needle) => text.includes(needle))) {
					found.push(relative(homePath, path));
				}
			}
		}
	};
	if (existsSync(data.path)) {
		walk(data.path);
	}
	return found;
}

interface FreshPlan {
	blockers: string[];
	repoPath: string | null;
	steps: ProjectRenameIdStep[];
	upToDate: boolean;
}

function planFreshSteps(input: {
	homePath: string;
	fromId: string;
	toId: string;
	moveAside: boolean;
	moveAsidePath: string;
}): FreshPlan {
	const { homePath, fromId, toId } = input;
	const index = readIndex(homePath);
	if (!index) {
		return {
			blockers: [`${getKanbanWorkspaceIndexPath(homePath)} is missing or unreadable: is ${homePath} a Kanban home?`],
			repoPath: null,
			steps: [],
			upToDate: false,
		};
	}
	const fromEntry = index.entries[fromId] ?? null;
	const toEntry = index.entries[toId] ?? null;
	if (!fromEntry) {
		return toEntry
			? { blockers: [], repoPath: toEntry.repoPath, steps: [], upToDate: true }
			: { blockers: [`${fromId} is not a registered project.`], repoPath: null, steps: [], upToDate: false };
	}
	if (toEntry) {
		return {
			blockers: [`${toId} is already the id of a registered project (${toEntry.repoPath}).`],
			repoPath: fromEntry.repoPath,
			steps: [],
			upToDate: false,
		};
	}
	const relativeAside = (path: string) => relative(homePath, join(input.moveAsidePath, relative(homePath, path)));
	const blockers: string[] = [];
	const steps: ProjectRenameIdStep[] = [];
	const leftovers: string[] = [];
	const fromPaths = getWorkspaceIdKeyedPaths(fromId, homePath);
	const toPaths = getWorkspaceIdKeyedPaths(toId, homePath);
	for (const [position, target] of toPaths.entries()) {
		if (pathExists(target.path)) {
			leftovers.push(relative(homePath, target.path));
			steps.push({ kind: "move-aside", path: relative(homePath, target.path), to: relativeAside(target.path) });
		}
		const source = fromPaths[position];
		if (source && pathExists(source.path)) {
			steps.push({ kind: "move", from: relative(homePath, source.path), to: relative(homePath, target.path) });
		}
	}
	const leftoverSessions = findLeftoverSessions(homePath, toId);
	if (leftoverSessions.length > 0) {
		leftovers.push(...leftoverSessions.map((file) => `${relative(homePath, file.path)}: ${file.keys.join(", ")}`));
		steps.push({
			kind: "move-aside-sessions",
			to: relative(homePath, join(input.moveAsidePath, "home-agent-sessions.json")),
		});
	}
	if (hasConfigWorkspace(homePath, toId)) {
		leftovers.push(`config.json workspaces.${toId}`);
		steps.push({
			kind: "move-aside-config",
			to: relative(homePath, join(input.moveAsidePath, `config-workspaces-${toId}.json`)),
		});
	}
	if (leftovers.length > 0 && !input.moveAside) {
		blockers.push(
			`${toId} is not a registered project, but its state is still here: ${leftovers.join("; ")}. ` +
				`Rerun with --move-aside to move it to ${input.moveAsidePath} first.`,
		);
	}
	// Leftovers go aside before anything moves onto their paths.
	const order = (step: ProjectRenameIdStep) => (step.kind.startsWith("move-aside") ? 0 : 1);
	steps.sort((left, right) => order(left) - order(right));
	for (const target of Object.keys(REWRITERS) as RewriteTarget[]) {
		steps.push({ kind: "rewrite", target });
	}
	return { blockers, repoPath: fromEntry.repoPath, steps, upToDate: false };
}

export async function planProjectIdRename(options: ProjectRenameIdOptions): Promise<ProjectRenameIdPlan> {
	const homePath = resolve(options.homePath ?? getKanbanHomePath());
	const fromId = options.fromId.trim();
	const toId = options.toId.trim();
	const timestamp = formatBackupTimestamp((options.now ?? (() => new Date()))());
	const journal = readJournal(homePath);
	const backupPath = journal?.backupPath ?? join(getKanbanBackupsPath(homePath), `rename-id-${timestamp}.tgz`);
	const moveAsidePath = journal
		? backupPath.replace(/\.tgz$/u, "")
		: join(getKanbanBackupsPath(homePath), `rename-id-${timestamp}`);
	// Only the new id is checked: the old one only has to be registered, whatever an older Kanban made it.
	const idBlockers = [
		...(fromId ? [] : ["The old id is empty."]),
		...[describeInvalidWorkspaceId(toId)].filter((blocker): blocker is string => blocker !== null),
		...(fromId === toId ? ["The old and the new id are the same."] : []),
	];
	const blockers = [...idBlockers];
	blockers.push(...(await findRunningKanbanServerBlockers([homePath], options.probeRuntimeServer)));
	const base = {
		homePath,
		fromId,
		toId,
		backupPath,
		moveAsidePath,
		probedOrigin: getKanbanRuntimeOrigin(),
	};
	if (journal && (journal.fromId !== fromId || journal.toId !== toId)) {
		blockers.push(
			`An earlier rename ${journal.fromId} → ${journal.toId} didn't finish (${getProjectRenameJournalPath(homePath)}). ` +
				`Finish it first: kanban project rename-id ${journal.fromId} ${journal.toId}`,
		);
	}
	const fresh = journal
		? null
		: idBlockers.length > 0
			? { blockers: [], repoPath: null, steps: [], upToDate: false }
			: planFreshSteps({ homePath, fromId, toId, moveAside: options.moveAside === true, moveAsidePath });
	blockers.push(...(fresh?.blockers ?? []));
	const steps = journal ? journal.steps : (fresh?.steps ?? []);
	const done = journal?.done ?? 0;
	const repoPath = journal?.repoPath ?? fresh?.repoPath ?? null;
	const rewrites: ProjectRenameIdRewrite[] = [];
	if (repoPath && blockers.length === 0) {
		for (const step of steps.slice(done)) {
			if (step.kind === "rewrite") {
				rewrites.push(...(await REWRITERS[step.target]({ homePath, fromId, toId, repoPath, apply: false })));
			}
		}
	}
	return {
		...base,
		repoPath,
		blockers,
		resumed: journal !== null,
		upToDate: fresh?.upToDate === true,
		steps: steps.map((step, position) => ({ ...step, done: position < done })),
		rewrites,
		mentions: repoPath && blockers.length === 0 ? findMentions(homePath, fromId, toId) : [],
	};
}

/** Archives everything the run may change, with paths relative to the home. */
function writeBackupTarball(plan: ProjectRenameIdPlan): void {
	const { homePath, fromId, toId } = plan;
	const paths = [
		getConfigPath(homePath),
		getKanbanWorkspacesRootPath(homePath),
		getRestartRecoverRequestPath(homePath),
		...getWorkspaceIdKeyedPaths(fromId, homePath).map((entry) => entry.path),
		...getWorkspaceIdKeyedPaths(toId, homePath).map((entry) => entry.path),
		...listDirectories(getKanbanDataPath(homePath)).map(
			(workspaceDir) => getIsolationWorkspacePaths(workspaceDir, homePath).messages,
		),
	];
	const sources = [...new Set(paths)].filter(pathExists).map((path) => relative(homePath, path));
	mkdirSync(dirname(plan.backupPath), { recursive: true });
	const result = spawnSync("tar", ["-czf", plan.backupPath, "--exclude=*.lock", "-C", homePath, ...sources], {
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(`Backup failed (tar -czf ${plan.backupPath}): ${result.stderr?.trim() || result.error?.message}`);
	}
}

function movePath(homePath: string, from: string, to: string): void {
	const source = join(homePath, from);
	const target = join(homePath, to);
	if (!pathExists(source)) {
		// Moved by an interrupted run (or gone): nothing to do.
		return;
	}
	if (pathExists(target)) {
		throw new Error(`Can't move ${source}: ${target} exists. Move one of them out of the way and rerun.`);
	}
	mkdirSync(dirname(target), { recursive: true });
	renameSync(source, target);
}

async function runStep(step: ProjectRenameIdStep, context: RewriteContext): Promise<void> {
	const { homePath, toId } = context;
	switch (step.kind) {
		case "move-aside":
			movePath(homePath, step.path, step.to);
			return;
		case "move":
			movePath(homePath, step.from, step.to);
			return;
		case "move-aside-sessions": {
			// Saved first (merged with what an interrupted run saved), then dropped.
			const savedPath = join(homePath, step.to);
			const saved = isObject(readJson(savedPath)) ? (readJson(savedPath) as Record<string, unknown>) : {};
			const leftovers = findLeftoverSessions(homePath, toId);
			for (const file of leftovers) {
				const sessions = readJson(file.path);
				if (isObject(sessions)) {
					saved[relative(homePath, file.path)] = Object.fromEntries(file.keys.map((key) => [key, sessions[key]]));
				}
			}
			if (leftovers.length > 0) {
				mkdirSync(dirname(savedPath), { recursive: true });
				await writeJson(savedPath, saved);
			}
			for (const file of leftovers) {
				const sessions = readJson(file.path);
				if (isObject(sessions)) {
					await writeJson(
						file.path,
						Object.fromEntries(Object.entries(sessions).filter(([key]) => !file.keys.includes(key))),
					);
				}
			}
			return;
		}
		case "move-aside-config": {
			const configPath = getConfigPath(homePath);
			const config = readJson(configPath);
			if (!isObject(config) || !isObject(config.workspaces) || !(toId in config.workspaces)) {
				return;
			}
			mkdirSync(dirname(join(homePath, step.to)), { recursive: true });
			await writeJson(join(homePath, step.to), config.workspaces[toId]);
			await updatePipelineConfigFile((raw) => {
				if (!isObject(raw.workspaces)) {
					return raw;
				}
				const { [toId]: _dropped, ...workspaces } = raw.workspaces;
				return { ...raw, workspaces };
			}, configPath);
			return;
		}
		case "rewrite":
			await REWRITERS[step.target]({ ...context, apply: true });
			return;
	}
}

export async function runProjectIdRename(options: ProjectRenameIdOptions): Promise<ProjectRenameIdResult> {
	const plan = await planProjectIdRename(options);
	if (options.dryRun || plan.blockers.length > 0 || plan.upToDate || !plan.repoPath) {
		return { plan, executed: false, backupPath: null };
	}
	const { homePath, fromId, toId, repoPath } = plan;
	const journalPath = getProjectRenameJournalPath(homePath);
	// Held for the whole run: CLI commands that register or open a project in-process take the same lock.
	await lockedFileSystem.withLock({ path: getKanbanWorkspaceIndexPath(homePath), type: "file" }, async () => {
		let journal = readJournal(homePath);
		if (!journal) {
			writeBackupTarball(plan);
			journal = {
				version: JOURNAL_VERSION,
				fromId,
				toId,
				repoPath,
				startedAt: new Date().toISOString(),
				backupPath: plan.backupPath,
				steps: plan.steps.map(({ done: _done, ...step }) => step),
				done: 0,
			};
			await writeJson(journalPath, journal);
		}
		const context: RewriteContext = { homePath, fromId, toId, repoPath, apply: true };
		for (let position = journal.done; position < journal.steps.length; position += 1) {
			const step = journal.steps[position];
			if (!step) {
				continue;
			}
			await runStep(step, context);
			options.afterStep?.(step, position);
			journal = { ...journal, done: position + 1 };
			await writeJson(journalPath, journal);
		}
		rmSync(journalPath, { force: true });
	});
	return { plan, executed: true, backupPath: plan.backupPath };
}
