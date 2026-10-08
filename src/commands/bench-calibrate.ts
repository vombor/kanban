// `kanban bench calibrate <spec>`: the team kit's calibration runner (src/kits/team/calibration/). It detaches by
// default (a calibration lasts hours and must outlive the shell and a pipeline reload) and logs to
// `<home>/logs/calibrate.log`; `--foreground` runs it in this process, `--print` only checks the inputs. A second
// runner for the same calibration is refused while the first one lives (`<dir>/runner.pid`, calibration-runner-lock.ts;
// the detaching command takes it and hands it to its worker); a new runner after a crash or restart resumes from
// state.json.
//
// Run from an agent session, the detached worker leaves the session's process tree, so the session's credential
// would make it an unidentified caller. It gets a child credential instead (docs/fork/project-isolation.md): this
// command asks the server for one, spawns the worker with it, has the server bind it to the worker's pid (checked
// through /proc as this process's child), and only then tells the worker on its stdin to go ahead. Where the server
// won't bind one, detached mode is refused up front and points to `--foreground`, except where the project's
// isolation mode is off: there it falls back to the plain detach, as before isolation.
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
import { readSessionCredential } from "../isolation/cli-scope";
import { resolveIsolationMode } from "../isolation/isolation-settings";
import { KANBAN_SESSION_CREDENTIAL_ENV } from "../isolation/session-identity";
import type { KitDocument } from "../kits/kit-schema";
import { getPromptParts } from "../kits/policy";
import { loadKitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import { locateCard } from "../kits/team/bench/card-locator";
import { stripReworkSections } from "../kits/team/calibration/calibration-prompt";
import { type CalibrationDependencies, runCalibration } from "../kits/team/calibration/calibration-runner";
import {
	acquireCalibrationRunnerLock,
	CalibrationRunnerBusyError,
	type CalibrationRunnerLock,
} from "../kits/team/calibration/calibration-runner-lock";
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
	getWatchdogWorkspacePaths,
} from "../state/kanban-home";
import { readPidPressureFlags } from "../state/pid-pressure-flags";
import { createAgentRunSignals } from "../terminal/agent-run-signals";
import { runGit } from "../workspace/git-utils";
import { getTaskWorktreeCandidatePaths } from "../workspace/task-worktree";
import { createRuntimeTrpcClient, type RuntimeTrpcClient } from "./runtime-trpc-client";
import { createTask, startTask, trashTask } from "./task";
import { resolveWorkspaceTarget } from "./workspace-target";

export interface CalibrateCommandDependencies {
	/** Starts the detached worker (node's spawn; tests inject a fake). */
	spawn?: typeof spawn;
	/** The env the session credential is read from (default process.env). */
	env?: NodeJS.ProcessEnv;
	/** The runtime client for the child credential (tests inject a fake). */
	createClient?: (workspaceId: string) => Pick<RuntimeTrpcClient, "isolation">;
}

/** What the detaching command writes on its worker's stdin once the worker's child credential is bound. */
export const CALIBRATE_IDENTITY_BOUND_LINE = "identity-bound";
const IDENTITY_WAIT_MS = 30_000;

export interface CalibrateOptions {
	project?: string;
	foreground?: boolean;
	worker?: boolean;
	/** The worker waits for {@link CALIBRATE_IDENTITY_BOUND_LINE} on stdin before it starts (set by the detaching command). */
	awaitIdentity?: boolean;
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

/** The calibration's runner lock; `inheritFrom`: the detaching command, for its worker. */
async function lockRunner(target: CalibrationTarget, inheritFrom: number[] = []): Promise<CalibrationRunnerLock> {
	await mkdir(target.paths.dir, { recursive: true });
	try {
		return await acquireCalibrationRunnerLock(target.paths.lock, { inheritFrom });
	} catch (error) {
		if (error instanceof CalibrationRunnerBusyError) {
			throw new Error(`calibration ${target.spec.name} is ${error.message}`);
		}
		throw error;
	}
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

function detachRefusal(specPath: string, reason: string): Error {
	return new Error(
		`a detached calibration from an agent session needs its own identity, bound by the Kanban server to the runner's process, and could not get one: ${reason}. Run \`kanban bench calibrate ${specPath} --foreground\` instead.`,
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function startDetached(
	target: CalibrationTarget,
	options: CalibrateOptions,
	deps: CalibrateCommandDependencies,
): Promise<number | undefined> {
	const env = deps.env ?? process.env;
	const logPath = getCalibrationLogPath();
	mkdirSync(dirname(logPath), { recursive: true });
	const output = openSync(logPath, "a");
	const spawnWorker = (childCredential: string | null) => {
		const [command, ...args] = buildKanbanCommandParts([
			"bench",
			"calibrate",
			target.specPath,
			"--worker",
			"--project",
			target.workspaceId,
			...(options.force ? ["--force"] : []),
			...(childCredential ? ["--await-identity"] : []),
		]);
		if (!command) {
			throw new Error("cannot locate the Kanban CLI");
		}
		const child = (deps.spawn ?? spawn)(command, args, {
			cwd: target.repoPath,
			detached: true,
			stdio: [childCredential ? "pipe" : "ignore", output, output],
			env: childCredential ? { ...env, [KANBAN_SESSION_CREDENTIAL_ENV]: childCredential } : env,
		});
		child.on("error", () => {});
		return child;
	};
	const plainDetach = () => {
		const child = spawnWorker(null);
		child.unref();
		return child.pid;
	};
	// From the user's shell: the plain detach, as always.
	if (!readSessionCredential(env)) {
		return plainDetach();
	}
	// From an agent session: a child credential for the worker. Required where the project's isolation mode is
	// report or enforce; with it off a failed issue or bind falls back to the plain detach (as before isolation).
	const { config } = await readPipelineConfig();
	const required = resolveIsolationMode(config, target.workspaceId) !== "off";
	const client = (deps.createClient ?? createRuntimeTrpcClient)(target.workspaceId);
	const issued = await client.isolation.issueChildCredential
		.mutate()
		.catch((error: unknown) => ({ ok: false, credential: null, error: errorText(error) }));
	if (!issued.ok || !issued.credential) {
		if (required) {
			throw detachRefusal(target.specPath, issued.error ?? "the server refused");
		}
		return plainDetach();
	}
	const child = spawnWorker(issued.credential);
	if (child.pid === undefined) {
		return undefined;
	}
	const bound = await client.isolation.bindChildCredential
		.mutate({ credential: issued.credential, pid: child.pid })
		.catch((error: unknown) => ({ ok: false, credential: null, error: errorText(error) }));
	if (!bound.ok) {
		// The worker waits on its stdin, so it has done nothing yet.
		child.kill("SIGTERM");
		if (required) {
			throw detachRefusal(target.specPath, bound.error ?? "the server refused");
		}
		return plainDetach();
	}
	child.stdin?.end(`${CALIBRATE_IDENTITY_BOUND_LINE}\n`);
	child.unref();
	return child.pid;
}

/** The worker's side of the handshake: resolves on the bound line, rejects on anything else, EOF or timeout. */
export async function awaitCalibrateIdentity(
	input: NodeJS.ReadableStream,
	timeoutMs: number = IDENTITY_WAIT_MS,
): Promise<void> {
	await new Promise<void>((resolveWait, rejectWait) => {
		let buffered = "";
		const finish = (error: Error | null) => {
			clearTimeout(timer);
			input.removeListener("data", onData);
			input.removeListener("end", onEnd);
			input.removeListener("error", onError);
			if ("pause" in input && typeof input.pause === "function") {
				input.pause();
			}
			if (error) {
				rejectWait(error);
			} else {
				resolveWait();
			}
		};
		const onData = (chunk: Buffer | string) => {
			buffered += String(chunk);
			const newline = buffered.indexOf("\n");
			if (newline >= 0) {
				const line = buffered.slice(0, newline).trim();
				finish(
					line === CALIBRATE_IDENTITY_BOUND_LINE
						? null
						: new Error("the calibrate command sent no identity confirmation"),
				);
			}
		};
		const onEnd = () => finish(new Error("the calibrate command did not bind this runner's identity"));
		const onError = (error: Error) => finish(error);
		const timer = setTimeout(
			() => finish(new Error(`no identity confirmation from the calibrate command within ${timeoutMs} ms`)),
			timeoutMs,
		);
		input.on("data", onData);
		input.on("end", onEnd);
		input.on("error", onError);
	});
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
		readPidPressure: async () => await readPidPressureFlags(),
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

async function runInThisProcess(target: CalibrationTarget, lock: CalibrationRunnerLock, echo: boolean): Promise<void> {
	const { paths } = target;
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
		await lock.release();
	}
}

export async function runCalibrateCommand(
	specArgument: string,
	options: CalibrateOptions,
	deps: CalibrateCommandDependencies = {},
): Promise<number> {
	const target = await loadTarget(specArgument, options);
	if (options.print) {
		await printInputs(target);
		return 0;
	}
	if (options.worker && options.awaitIdentity) {
		// Started from an agent session: no runtime call before the command has bound this process's credential.
		try {
			await awaitCalibrateIdentity(process.stdin);
		} catch (error) {
			createLogger(false)(`calibration ${target.spec.name} not started: ${errorText(error)}`);
			throw error;
		}
	}
	if (options.foreground || options.worker) {
		// A worker takes the lock over from the command that spawned it (it may not have handed it over yet).
		const lock = await lockRunner(target, options.worker ? [process.ppid] : []);
		await runInThisProcess(target, lock, options.foreground === true);
		return 0;
	}
	const lock = await lockRunner(target);
	let pid: number | undefined;
	try {
		pid = await startDetached(target, options, deps);
	} finally {
		await (pid === undefined ? lock.release() : lock.handOver(pid));
	}
	process.stdout.write(
		`calibration ${target.spec.name} started (pid ${pid ?? "?"}); log ${getCalibrationLogPath()}; state ${target.paths.state}\n`,
	);
	return 0;
}
