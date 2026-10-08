// The headless orchestrator run: one pass of the selected agent's headless runner (`claude -p`, `codex exec`) in the
// target workspace's project, for issues the watchdog queued. `kanban orchestrator run` runs it as a detached process,
// so a worker or server restart doesn't cut a run short.
//
//   - one run per workspace: `<home>/run/orchestrator-<ws>.lock` holds its pid. The watchdog queues new issues
//     into `data/<ws>/orchestrator-queue.txt` while it runs, and the run handles them in a follow-up pass.
//   - no run while an interactive session of the agent in the project is live (transcript written in the last
//     `orchestrator.wake.liveSessionMin`); the issues stay queued and the watchdog re-wakes after its cooldown.
//   - each pass times out after `orchestrator.wake.timeoutMin`.
//   - before a follow-up, issues whose card is no longer in that workspace's ATTENTION.md are dropped.
//
// Ported from archive/devteam-kit:bin/orchestrator-wake.mjs@6da71597 (lock, queue, prompt, runOnce, stillOpen) and kit
// main cc1eefe / 6f4fa93 (the live-session check, also before follow-ups; a skipped follow-up re-queues its lines).
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { appendFile, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RuntimeAgentId } from "../../core/api-contract";
import {
	getKanbanDataPath,
	getKanbanLogsPath,
	getOrchestratorLockPath,
	getWatchdogWorkspacePaths,
} from "../../state/kanban-home";
import {
	findLiveInteractiveSession,
	getHeadlessOrchestratorCommand,
	HEADLESS_ORCHESTRATOR_MARKER,
	type HeadlessOrchestratorCommand,
	type LiveInteractiveSession,
} from "../../terminal/orchestrator-agents";

/** A queue line: `<iso> [<watched workspace>] <issue>`. */
const QUEUE_LINE = /^(\S+Z) \[([^\]]+)\] (.*)$/u;

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
	}
}

/** The pid in a run lock if that process is alive, else 0 (a dead pid's lock is ignored). */
export async function readLiveLockPid(
	lockPath: string,
	alive: (pid: number) => boolean = isProcessAlive,
): Promise<number> {
	const pid = Number((await readFile(lockPath, "utf8").catch(() => "")).trim());
	return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : 0;
}

export async function appendOrchestratorQueue(
	queuePath: string,
	watchedWorkspaceId: string,
	issues: readonly string[],
	now: Date,
): Promise<void> {
	if (issues.length === 0) {
		return;
	}
	await mkdir(dirname(queuePath), { recursive: true });
	const lines = issues.map(
		(issue) =>
			`${now.toISOString()} [${watchedWorkspaceId}] ${issue.replace(/^- /u, "").replace(/\*\*/gu, "").replace(/\s+/gu, " ")}\n`,
	);
	await appendFile(queuePath, lines.join(""), "utf8");
}

async function takeQueue(queuePath: string): Promise<string> {
	const text = (await readFile(queuePath, "utf8").catch(() => "")).trim();
	if (text) {
		await writeFile(queuePath, "", "utf8");
	}
	return text;
}

/**
 * Only the queue lines tagged `[<workspaceId>]`: a run is that workspace's orchestrator and never handles another
 * project's items. Lines tagged with another workspace are left over from the removed `orchestrator.wake.target`,
 * which queued every workspace's items for one target (docs/fork/watchdog-isolation.md). Untagged lines can't be
 * traced to a workspace and are dropped too.
 */
export function keepOwnQueueLines(queue: string, workspaceId: string): { kept: string; dropped: number } {
	const lines = queue.split("\n").filter(Boolean);
	const kept = lines.filter((line) => QUEUE_LINE.exec(line)?.[2] === workspaceId);
	return { kept: kept.join("\n").trim(), dropped: lines.length - kept.length };
}

/**
 * `kanban doctor --fix` for the removed target: rewrites every workspace's `orchestrator-queue.txt` in the home with
 * only the lines tagged with that workspace. Returns the workspaces whose queue changed and how many lines each lost.
 */
export async function stripForeignQueueLines(
	homePath: string,
): Promise<Array<{ workspaceId: string; dropped: number }>> {
	const entries = await readdir(getKanbanDataPath(homePath), { withFileTypes: true }).catch(() => []);
	const changed: Array<{ workspaceId: string; dropped: number }> = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const queuePath = getWatchdogWorkspacePaths(entry.name, homePath).orchestratorQueue;
		const own = keepOwnQueueLines(await readFile(queuePath, "utf8").catch(() => ""), entry.name);
		if (own.dropped > 0) {
			await writeFile(queuePath, own.kept ? `${own.kept}\n` : "", "utf8");
			changed.push({ workspaceId: entry.name, dropped: own.dropped });
		}
	}
	return changed;
}

/**
 * Queue lines still worth a follow-up: lines without a card id, or whose card is still in the run's own workspace's
 * ATTENTION.md (archive/devteam-kit:bin/orchestrator-wake.mjs@6da71597 stillOpen). The queue holds only that
 * workspace's lines (keepOwnQueueLines), so no other workspace's ATTENTION.md is read.
 */
export async function filterStillOpen(
	queue: string,
	readOwnAttention: () => Promise<string>,
): Promise<{ kept: string; dropped: number }> {
	const lines = queue.split("\n").filter(Boolean);
	const kept: string[] = [];
	const attention = lines.length > 0 ? await readOwnAttention() : "";
	for (const line of lines) {
		const issue = QUEUE_LINE.exec(line)?.[3] ?? line;
		const id = /^([0-9a-f]{5})\b/u.exec(issue)?.[1];
		if (!id || attention.includes(id)) {
			kept.push(line);
		}
	}
	return { kept: kept.join("\n").trim(), dropped: lines.length - kept.length };
}

/**
 * Starts `kanban orchestrator run` detached (the same CLI script and Node flags as this process), so the run outlives a
 * worker reload. Its lock and queue make a second start a no-op.
 */
export function spawnOrchestratorRunProcess(options: OrchestratorRunOptions): {
	ok: boolean;
	pid?: number;
	error?: string;
} {
	const script = process.argv[1];
	if (!script) {
		return { ok: false, error: "cannot locate the Kanban CLI script" };
	}
	try {
		const child = spawn(
			process.execPath,
			[
				...process.execArgv,
				script,
				"orchestrator",
				"run",
				"--workspace",
				options.workspaceId,
				"--project",
				options.projectPath,
				"--agent",
				options.agentId,
				"--timeout-min",
				String(options.timeoutMin),
				"--live-session-min",
				String(options.liveSessionMin),
			],
			{ cwd: options.projectPath, detached: true, stdio: "ignore", env: { ...process.env, ...options.env } },
		);
		child.on("error", () => {});
		child.unref();
		return { ok: true, pid: child.pid };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Does the model answer? Runs `kanban models probe --provider <p> <model>` (P3-3: a Bedrock tool call, or Lemonade's
 * /health) with this process's CLI, so the probe and its credentials stay in one place. Exit 0 = up.
 */
export async function probeModelWithCli(provider: string, model: string): Promise<boolean> {
	const script = process.argv[1];
	if (!script) {
		return false;
	}
	return await new Promise<boolean>((resolve) => {
		execFile(
			process.execPath,
			[...process.execArgv, script, "models", "probe", "--provider", provider, model],
			{ timeout: 180_000, env: process.env },
			(error) => resolve(!error),
		);
	});
}

export interface OrchestratorRunPromptInput {
	workspaceId: string;
	projectPath: string;
	queue: string;
	dataDir: string;
	actionsPath: string;
	attentionPath: string;
	logsPath: string;
}

export function buildOrchestratorRunPrompt(input: OrchestratorRunPromptInput): string {
	return `You are the Kanban ORCHESTRATOR for the workspace "${input.workspaceId}" (${input.projectPath}), ${HEADLESS_ORCHESTRATOR_MARKER} because something needs judgment. No human is watching. Follow your user and project instructions and memory.

Issues reported by the watchdog (oldest first; [workspace] says which board each is about):
${input.queue}

Do this:
1. Assess the whole board, not only the issues above: kanban task list --project-path ${input.projectPath}; kanban doctor ${input.projectPath}; kanban pipeline status; ${input.attentionPath}; the logs in ${input.logsPath}; the QA log and pipeline decisions in ${input.dataDir}. Find anything stuck, wrong or idle.
2. Fix it the way the sidebar orchestrator would: resume or restart cards the safe way, send rework with kanban task send, and apply the standing rules for model/benchmark decisions. Never write app code in ${input.projectPath} yourself. Never restart the pod or containers. Pass --project-path to every kanban command.
3. Leave only genuine product/budget decisions for the user: list them in ${input.attentionPath} under "## Orchestrator: needs the user".
4. Append a short "## <UTC time> orchestrator run" section to ${input.actionsPath}: what you found, what you did, what's left. Save anything non-obvious you learned to your memory. Then stop.`;
}

export interface OrchestratorRunOptions {
	workspaceId: string;
	projectPath: string;
	agentId: RuntimeAgentId;
	timeoutMin: number;
	liveSessionMin: number;
	/** Skip the live interactive-session check (a human-run test). */
	ignoreLive?: boolean;
	/** Extra env for the run and its agent (the session credential of project isolation). */
	env?: Record<string, string>;
}

export interface OrchestratorRunDependencies {
	spawnAgent?: (command: HeadlessOrchestratorCommand, options: { cwd: string; outputPath: string }) => ChildProcess;
	findLiveSession?: (
		agentId: RuntimeAgentId,
		projectPath: string,
		liveMs: number,
	) => Promise<LiveInteractiveSession | null>;
	/** The run's own workspace's ATTENTION.md. */
	readAttention?: () => Promise<string>;
	pid?: number;
	now?: () => Date;
}

function defaultSpawnAgent(
	command: HeadlessOrchestratorCommand,
	options: { cwd: string; outputPath: string },
	output: { fd: number },
): ChildProcess {
	return spawn(command.binary, command.args, { cwd: options.cwd, stdio: ["ignore", output.fd, output.fd] });
}

/** `kanban orchestrator run`: returns once every queued issue is handled, skipped or the lock is held. */
export async function runOrchestratorHeadless(
	options: OrchestratorRunOptions,
	deps: OrchestratorRunDependencies = {},
): Promise<{ runs: number; skipped: string | null }> {
	const now = deps.now ?? (() => new Date());
	const pid = deps.pid ?? process.pid;
	const paths = getWatchdogWorkspacePaths(options.workspaceId);
	const logsPath = getKanbanLogsPath();
	const logPath = join(logsPath, "orchestrator.log");
	const lockPath = getOrchestratorLockPath(options.workspaceId);
	await mkdir(logsPath, { recursive: true });
	const log = async (message: string) =>
		await appendFile(logPath, `${now().toISOString()} [${options.workspaceId}] ${message}\n`, "utf8");
	const liveMs = options.liveSessionMin * 60_000;
	const findLive =
		deps.findLiveSession ??
		(async (agentId: RuntimeAgentId, projectPath: string, ms: number) =>
			await findLiveInteractiveSession(agentId, projectPath, { liveMs: ms }));
	const readAttention = deps.readAttention ?? (async () => await readFile(paths.attention, "utf8").catch(() => ""));
	/** The queue with only this workspace's lines; any other line is logged and dropped. */
	const takeOwnQueue = async (when: string): Promise<string> => {
		const own = keepOwnQueueLines(await takeQueue(paths.orchestratorQueue), options.workspaceId);
		if (own.dropped > 0) {
			await log(
				`${when}: dropped ${own.dropped} queued line(s) not tagged [${options.workspaceId}] (not this workspace's items)`,
			);
		}
		return own.kept;
	};

	const holder = await readLiveLockPid(lockPath);
	if (holder && holder !== pid) {
		await log(`run ${holder} already going; its follow-up handles the queue`);
		return { runs: 0, skipped: `run ${holder} active` };
	}
	if (!getHeadlessOrchestratorCommand(options.agentId, "")) {
		await log(`${options.agentId} has no headless runner; the watchdog wakes its sidebar instead`);
		return { runs: 0, skipped: "no headless runner" };
	}
	if (!options.ignoreLive) {
		const live = await findLive(options.agentId, options.projectPath, liveMs);
		if (live) {
			await log(
				`interactive session ${live.id} active (${live.ageSec}s ago); left the issue(s) queued for it, no headless run`,
			);
			return { runs: 0, skipped: `interactive session ${live.id}` };
		}
	}

	await mkdir(dirname(lockPath), { recursive: true });
	await writeFile(lockPath, String(pid), "utf8");
	let runs = 0;
	try {
		let queue = await takeOwnQueue("start");
		while (queue) {
			const prompt = buildOrchestratorRunPrompt({
				workspaceId: options.workspaceId,
				projectPath: options.projectPath,
				queue,
				dataDir: paths.dataDir,
				actionsPath: paths.orchestratorActions,
				attentionPath: paths.attention,
				logsPath,
			});
			const command = getHeadlessOrchestratorCommand(options.agentId, prompt);
			if (!command) {
				break;
			}
			await log(`run starting (${queue.split("\n").length} issue line(s), ${options.agentId})`);
			runs += 1;
			await runOnce(command, {
				cwd: options.projectPath,
				outputPath: join(logsPath, `orchestrator-${options.workspaceId}-last.txt`),
				timeoutMs: options.timeoutMin * 60_000,
				spawnAgent: deps.spawnAgent,
				log,
			});
			const next = await filterStillOpen(await takeOwnQueue("follow-up"), readAttention);
			if (next.dropped > 0) {
				await log(`follow-up: dropped ${next.dropped} queued issue(s) no longer in ATTENTION.md`);
			}
			queue = next.kept;
			if (queue && !options.ignoreLive) {
				const live = await findLive(options.agentId, options.projectPath, liveMs);
				if (live) {
					await appendFile(paths.orchestratorQueue, `${queue}\n`, "utf8");
					await log(
						`follow-up: interactive session ${live.id} active (${live.ageSec}s ago); left ${queue.split("\n").length} issue(s) queued, no headless run`,
					);
					break;
				}
			}
		}
	} finally {
		if ((await readLiveLockPid(lockPath, () => true)) === pid) {
			await rm(lockPath, { force: true });
		}
	}
	return { runs, skipped: null };
}

async function runOnce(
	command: HeadlessOrchestratorCommand,
	options: {
		cwd: string;
		outputPath: string;
		timeoutMs: number;
		spawnAgent?: OrchestratorRunDependencies["spawnAgent"];
		log: (message: string) => Promise<void>;
	},
): Promise<void> {
	const output = await open(options.outputPath, "w");
	try {
		await new Promise<void>((resolve) => {
			const child = options.spawnAgent
				? options.spawnAgent(command, { cwd: options.cwd, outputPath: options.outputPath })
				: defaultSpawnAgent(command, options, output);
			const timer = setTimeout(() => {
				void options.log("run timed out; stopping it");
				child.kill("SIGTERM");
			}, options.timeoutMs);
			child.on("error", (error) => {
				clearTimeout(timer);
				void options.log(`run failed to start: ${error.message}`).finally(resolve);
			});
			child.on("exit", (code) => {
				clearTimeout(timer);
				void options.log(`run finished (exit ${code ?? "signal"})`).finally(resolve);
			});
		});
	} finally {
		await output.close();
	}
}
