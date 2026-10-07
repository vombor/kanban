// `kanban bench calibrate <spec>`: the team kit's calibration runner (src/kits/team/calibration/). It detaches by
// default (a calibration lasts hours and must outlive the shell and a pipeline reload) and logs to
// `<home>/logs/calibrate.log`; `--foreground` runs it in this process, `--print` only checks the inputs. A second
// runner for the same calibration is refused while the first one lives (`<dir>/runner.pid`); a new runner after a
// crash or restart resumes from state.json.
//
// Ported from archive/devteam-kit:qa/calibrate.mjs@94247a7 (detach, --foreground, --print).
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, openSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { readPipelineConfig } from "../config/pipeline-config";
import { loadGlobalRuntimeConfig } from "../config/runtime-config";
import { createGitProcessEnv } from "../core/git-process-env";
import { buildKanbanCommandParts } from "../core/kanban-command";
import type { KitDocument } from "../kits/kit-schema";
import { getPromptParts } from "../kits/policy";
import { loadKitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import { locateCard } from "../kits/team/bench/card-locator";
import { stripReworkSections } from "../kits/team/calibration/calibration-prompt";
import { type CalibrationDependencies, runCalibration } from "../kits/team/calibration/calibration-runner";
import { type CalibrationSpec, parseCalibrationSpec } from "../kits/team/calibration/calibration-spec";
import { measureCard } from "../kits/team/scoreboard/scoreboard-store";
import { buildQaRequirements } from "../pipeline/qa-prompt";
import { readQaVerdictFile } from "../pipeline/qa-verdict";
import { stopScratchProcesses } from "../pipeline/scratch-processes";
import { addWakeRequest } from "../pipeline/watchdog/wake-requests";
import {
	type CalibrationPaths,
	getCalibrationLogPath,
	getCalibrationPaths,
	getKanbanHomeDisplayPath,
	getPidPressureFlagPaths,
	getWatchdogWorkspacePaths,
} from "../state/kanban-home";
import { createAgentRunSignals } from "../terminal/agent-run-signals";
import { runGit } from "../workspace/git-utils";
import { getTaskWorktreeCandidatePaths } from "../workspace/task-worktree";
import { createRuntimeTrpcClient } from "./runtime-trpc-client";
import { createTask, startTask, trashTask } from "./task";
import { resolveWorkspaceTarget } from "./workspace-target";

export interface CalibrateOptions {
	project?: string;
	foreground?: boolean;
	worker?: boolean;
	print?: boolean;
	force?: boolean;
}

interface CalibrationTarget {
	spec: CalibrationSpec;
	specPath: string;
	workspaceId: string;
	repoPath: string;
	kit: KitDocument;
	paths: CalibrationPaths;
}

async function exists(path: string): Promise<boolean> {
	return await stat(path).then(
		() => true,
		() => false,
	);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The pid of a live runner for this calibration (other than this process), or null. */
async function readLiveRunnerPid(lockPath: string): Promise<number | null> {
	const pid = Number((await readFile(lockPath, "utf8").catch(() => "")).trim());
	return Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid) ? pid : null;
}

async function loadTarget(specArgument: string, options: CalibrateOptions): Promise<CalibrationTarget> {
	const specPath = resolve(specArgument);
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(specPath, "utf8"));
	} catch (error) {
		throw new Error(`cannot read ${specPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const spec = parseCalibrationSpec(raw);
	const target = await resolveWorkspaceTarget(options.project ?? spec.workspace, { allowUnregistered: false });
	if (!target.repoPath) {
		throw new Error(`workspace ${target.workspaceId} has no registered repo`);
	}
	const { config } = await readPipelineConfig();
	const resolution = resolveWorkspaceKit(config, target.workspaceId, await loadKitCatalog());
	const kit = resolution.kit;
	if (!(kit.features ?? []).includes("calibration") && !options.force && !options.print) {
		throw new Error(
			`workspace ${target.workspaceId} is on kit ${resolution.kitName}, which doesn't list the calibration feature (--force to run anyway)`,
		);
	}
	const known = kit.qa?.rules ?? {};
	for (const model of spec.models) {
		const unknown = model.rules.filter((rule) => !Object.hasOwn(known, rule));
		if (unknown.length > 0) {
			throw new Error(
				`model ${model.key}: rule ${unknown.join(", ")} is not in kit ${resolution.kitName}'s qa.rules (${Object.keys(known).join(", ") || "none"})`,
			);
		}
	}
	return {
		spec,
		specPath,
		workspaceId: target.workspaceId,
		repoPath: target.repoPath,
		kit,
		paths: getCalibrationPaths(target.workspaceId, spec.name),
	};
}

async function readDevPrompt(taskId: string, workspaceId: string): Promise<string | null> {
	return (await locateCard(taskId, workspaceId))?.boardCard.prompt ?? null;
}

async function revParse(repoPath: string, ref: string): Promise<string | null> {
	const result = await runGit(repoPath, ["rev-parse", "--short", "--verify", "-q", `${ref}^{commit}`], {
		env: createGitProcessEnv(),
	});
	return result.ok && result.stdout ? result.stdout : null;
}

/** `--print`: check the inputs without creating cards. */
async function printInputs(target: CalibrationTarget): Promise<void> {
	for (const set of target.spec.sets) {
		const prompt = await readDevPrompt(set.fromCard, target.workspaceId);
		const requirements = prompt ? buildQaRequirements(stripReworkSections(prompt), target.kit.qa?.blurb ?? "") : null;
		process.stdout.write(
			`${set.id}: ${set.fromCard} prompt ${prompt ? `${prompt.length} chars → requirements ${requirements?.length}` : "MISSING"}; ref ${(await revParse(target.repoPath, set.ref)) ?? "BAD"} base ${(await revParse(target.repoPath, set.base)) ?? "BAD"}\n`,
		);
	}
	process.stdout.write(
		`${target.spec.sets.length * target.spec.models.length} runs, ${target.spec.parallel} at a time; state ${target.paths.state}\n`,
	);
}

function startDetached(target: CalibrationTarget, options: CalibrateOptions): number | undefined {
	const logPath = getCalibrationLogPath();
	mkdirSync(dirname(logPath), { recursive: true });
	const output = openSync(logPath, "a");
	const [command, ...args] = buildKanbanCommandParts([
		"bench",
		"calibrate",
		target.specPath,
		"--worker",
		"--project",
		target.workspaceId,
		...(options.force ? ["--force"] : []),
	]);
	if (!command) {
		throw new Error("cannot locate the Kanban CLI");
	}
	const child = spawn(command, args, {
		cwd: target.repoPath,
		detached: true,
		stdio: ["ignore", output, output],
		env: process.env,
	});
	child.on("error", () => {});
	child.unref();
	return child.pid;
}

function createLogger(echo: boolean): (message: string) => void {
	const logPath = getCalibrationLogPath();
	mkdirSync(dirname(logPath), { recursive: true });
	return (message) => {
		const line = `${new Date().toISOString()} ${message}\n`;
		appendFileSync(logPath, line);
		if (echo) {
			process.stderr.write(line);
		}
	};
}

function createDependencies(target: CalibrationTarget, log: (message: string) => void): CalibrationDependencies {
	const { workspaceId, repoPath } = target;
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const selectedAgentId = loadGlobalRuntimeConfig().then((config) => config.selectedAgentId);
	const pipelineConfig = readPipelineConfig().then(({ config }) => config);
	const pidFlags = getPidPressureFlagPaths();
	return {
		board: {
			read: async () => await runtimeClient.workspace.getState.query(),
			createTask: async (input) => {
				const created = await createTask({
					cwd: repoPath,
					projectPath: repoPath,
					title: input.title,
					prompt: input.prompt,
					role: "calibration",
					autoReviewEnabled: false,
					agentId: input.agentId,
					agentSettings: input.agentSettings,
				});
				const id = (created.task as { id?: unknown } | undefined)?.id;
				if (typeof id !== "string") {
					throw new Error(`create failed: ${JSON.stringify(created).slice(0, 200)}`);
				}
				return id;
			},
			startTask: async (taskId) => {
				await startTask({ cwd: repoPath, projectPath: repoPath, taskId });
			},
			finishTask: async (taskId) => {
				await trashTask({ cwd: repoPath, projectPath: repoPath, taskId, landing: "discard" });
			},
			deliverInput: async (taskId, text) => {
				const result = await runtimeClient.runtime.deliverTaskInput.mutate({ taskId, text });
				return { ok: result.ok, error: result.error ?? result.status };
			},
		},
		signals: createAgentRunSignals(),
		readDevPrompt: async (taskId) => await readDevPrompt(taskId, workspaceId),
		updateRef: async (ref, targetRef) => {
			const result = await runGit(repoPath, ["update-ref", ref, targetRef], { env: createGitProcessEnv() });
			if (!result.ok) {
				throw new Error(`git update-ref ${ref} ${targetRef}: ${result.error ?? result.output}`);
			}
		},
		resetOutbox: async (dir) => {
			await rm(dir, { recursive: true, force: true });
		},
		readVerdict: readQaVerdictFile,
		measure: async (taskId) => {
			const { metrics } = await measureCard({
				taskId,
				workspaceId,
				selectedAgentId: await selectedAgentId,
				config: await pipelineConfig,
			});
			return {
				costUSD: metrics.metrics.costUSD,
				tokens: {
					in: metrics.metrics.tokensIn,
					out: metrics.metrics.tokensOut,
					cacheRead: metrics.metrics.tokensCacheRead,
				},
			};
		},
		stopScratchProcesses: async (dirs) => await stopScratchProcesses(dirs, log),
		readPidPressure: async () => ({
			pressure: await exists(pidFlags.pressure),
			brownout: await exists(pidFlags.brownout),
		}),
		findWorktreePath: async (taskId) => {
			for (const path of getTaskWorktreeCandidatePaths(repoPath, taskId)) {
				if (await exists(path)) {
					return path;
				}
			}
			return null;
		},
		wakeOrchestrator: async (issue) => {
			await addWakeRequest(getWatchdogWorkspacePaths(workspaceId).wakeRequests, { issue, when: null });
		},
		now: Date.now,
		sleep: async (ms) => await new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
		log,
	};
}

async function runInThisProcess(target: CalibrationTarget, echo: boolean): Promise<void> {
	const { paths } = target;
	await mkdir(paths.dir, { recursive: true });
	await writeFile(paths.lock, `${process.pid}\n`);
	const log = createLogger(echo);
	try {
		await writeFile(paths.spec, `${JSON.stringify(target.spec, null, 2)}\n`);
		const { config } = await readPipelineConfig();
		await runCalibration(
			{
				spec: target.spec,
				paths,
				repoPath: target.repoPath,
				outboxRoot: join(config.pipeline.qa.outboxRoot, "cal", target.spec.name),
				scratchRoot: config.pipeline.qa.scratchRoot,
				promptParts: (rules) => getPromptParts(target.kit, rules),
				kanbanHome: getKanbanHomeDisplayPath(),
			},
			createDependencies(target, log),
		);
	} catch (error) {
		log(`calibration ${target.spec.name} stopped: ${error instanceof Error ? error.message : String(error)}`);
		throw error;
	} finally {
		await rm(paths.lock, { force: true });
	}
}

export async function runCalibrateCommand(specArgument: string, options: CalibrateOptions): Promise<number> {
	const target = await loadTarget(specArgument, options);
	if (options.print) {
		await printInputs(target);
		return 0;
	}
	const livePid = await readLiveRunnerPid(target.paths.lock);
	if (livePid !== null) {
		throw new Error(`calibration ${target.spec.name} is already running (pid ${livePid}, ${target.paths.lock})`);
	}
	if (options.foreground || options.worker) {
		await runInThisProcess(target, options.foreground === true);
		return 0;
	}
	const pid = startDetached(target, options);
	process.stdout.write(
		`calibration ${target.spec.name} started (pid ${pid ?? "?"}); log ${getCalibrationLogPath()}; state ${target.paths.state}\n`,
	);
	return 0;
}
