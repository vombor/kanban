// `kanban models vet` (docs/team/MODELS.md "Vetting"): the Kanban orchestrator's smoke test for one agent + provider
// + model and role (src/models/vetting/). It writes a report under `<home>/data/models/vetting/<run>` and changes
// nothing else: Kanban keeps no list of allowed models. Cline's models.json is the allow list, and the orchestrator
// puts a model there by hand once it passed.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import { readLemonadeModelListSettings } from "../config/model-lists-config";
import { readPipelineConfig } from "../config/pipeline-config";
import { loadGlobalRuntimeConfig } from "../config/runtime-config";
import { getRuntimeAgentCatalogEntry } from "../core/agent-catalog";
import { type RuntimeAgentId, runtimeAgentIdEnumSchema } from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { measureCard } from "../kits/team/scoreboard/scoreboard-store";
import { fetchLemonadeModelLoaded, lemonadeApiBaseUrl } from "../models/lemonade-models";
import {
	describeCombination,
	type ModelCombination,
	type VettingRole,
	vettingRoleSchema,
} from "../models/model-combination";
import { LEMONADE_PROVIDER_ID } from "../models/model-probe";
import { createVetProbe } from "../models/vetting/vet-probe";
import { describeVetSummary, formatVetReport } from "../models/vetting/vet-report";
import { DEFAULT_VET_LIMITS, runVet, type VetLimits } from "../models/vetting/vet-runner";
import { createVetTask, readTextIfExists, type VetCheckDeps, writeScratchFiles } from "../models/vetting/vet-tasks";
import { createAgentToolProcessFinder } from "../server/process-reaper";
import { getClineDataDirPath, getModelVettingRunsPath } from "../state/kanban-home";
import { createAgentRunSignals } from "../terminal/agent-run-signals";
import { getAgentTurnEndSource } from "../terminal/agent-session-adapters";
import { readClineTuiSignInGap } from "../terminal/cline-tui-sign-in";
import { runGit } from "../workspace/git-utils";
import { getTaskWorktreeCandidatePaths } from "../workspace/task-worktree";
import { createRuntimeTrpcClient } from "./runtime-trpc-client";
import { createTask, startTask, trashTask } from "./task";
import { resolveWorkspaceTarget } from "./workspace-target";

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function readCliVersion(agentId: RuntimeAgentId): Promise<string | null> {
	const binary = getRuntimeAgentCatalogEntry(agentId)?.binary;
	if (!binary) {
		return Promise.resolve(null);
	}
	return new Promise((resolveVersion) => {
		execFile(binary, ["--version"], { timeout: 15_000, encoding: "utf8" }, (error, stdout, stderr) => {
			const line = `${stdout ?? ""}\n${stderr ?? ""}`.trim().split("\n")[0]?.trim() ?? "";
			resolveVersion(error && !line ? null : line || null);
		});
	});
}

/** The scratch repo's env for git and the test suite: no Kanban or git redirect variables. */
function createScratchEnv(): NodeJS.ProcessEnv {
	const env = createGitProcessEnv();
	for (const name of Object.keys(env)) {
		if (name.startsWith("KANBAN_")) {
			delete env[name];
		}
	}
	return env;
}

async function git(repoPath: string, args: string[]): Promise<string> {
	const result = await runGit(repoPath, args, { env: createScratchEnv() });
	if (!result.ok) {
		throw new Error(`git ${args.join(" ")} in ${repoPath}: ${result.error ?? result.output}`);
	}
	return result.stdout;
}

async function createScratchRepo(runId: string, role: VettingRole) {
	const dir = await mkdtemp(join(tmpdir(), `kanban-vet-${runId}-`));
	const repoPath = join(dir, "repo");
	await mkdir(repoPath, { recursive: true });
	const task = createVetTask(role);
	await git(repoPath, ["init", "-q", "-b", "main"]);
	await git(repoPath, ["config", "user.name", "Kanban vet"]);
	await git(repoPath, ["config", "user.email", "vet@kanban.invalid"]);
	for (const commit of task.commits) {
		await writeScratchFiles(repoPath, commit.files);
		await git(repoPath, ["add", "-A"]);
		await git(repoPath, ["commit", "-q", "-m", commit.message]);
	}
	const base = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
	return { repoPath, task, base };
}

async function latestWriteAt(path: string): Promise<number | null> {
	let newest: number | null = null;
	const walk = async (dir: string, depth: number) => {
		if (depth > 6) {
			return;
		}
		for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
			const child = join(dir, entry.name);
			const info = await stat(child).catch(() => null);
			if (info && (newest === null || info.mtimeMs > newest)) {
				newest = info.mtimeMs;
			}
			if (entry.isDirectory() && entry.name !== "node_modules") {
				await walk(child, depth + 1);
			}
		}
	};
	await walk(path, 0);
	return newest;
}

function createCheckDeps(base: string): VetCheckDeps {
	return {
		readText: readTextIfExists,
		runTests: (repoPath) =>
			new Promise((resolveRun) => {
				execFile(
					"npm",
					["test", "--silent"],
					{ cwd: repoPath, timeout: 120_000, encoding: "utf8", env: createScratchEnv() },
					(error, stdout, stderr) => resolveRun({ ok: !error, output: `${stdout ?? ""}${stderr ?? ""}` }),
				);
			}),
		listChangedFiles: async (repoPath) => {
			const tracked = await git(repoPath, ["diff", "--name-only", base]).catch(() => "");
			const untracked = await git(repoPath, ["ls-files", "--others", "--exclude-standard"]).catch(() => "");
			return [
				...new Set(
					`${tracked}\n${untracked}`
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean),
				),
			];
		},
		countNewCommits: async (repoPath) =>
			Number.parseInt((await git(repoPath, ["rev-list", "--count", `${base}..HEAD`]).catch(() => "0")).trim(), 10) ||
			0,
	};
}

interface VetOptions {
	agent: string;
	provider?: string;
	model?: string;
	role: string;
	project?: string;
	maxMin?: string;
	maxCost?: string;
	capacityWaitMin?: string;
	json?: boolean;
}

function parsePositive(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined) {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive number`);
	}
	return parsed;
}

async function runVetCommand(options: VetOptions): Promise<number> {
	const agentId = runtimeAgentIdEnumSchema.parse(options.agent);
	const role = vettingRoleSchema.parse(options.role);
	const combination: ModelCombination = {
		agentId,
		provider: options.provider?.trim() || null,
		model: options.model?.trim() || null,
	};
	const limits: VetLimits = {
		...DEFAULT_VET_LIMITS,
		maxMin: parsePositive(options.maxMin, DEFAULT_VET_LIMITS.maxMin, "--max-min"),
		maxCostUSD: parsePositive(options.maxCost, DEFAULT_VET_LIMITS.maxCostUSD, "--max-cost"),
		capacityWaitMin: parsePositive(
			options.capacityWaitMin,
			DEFAULT_VET_LIMITS.capacityWaitMin,
			"--capacity-wait-min",
		),
	};
	const target = await resolveWorkspaceTarget(options.project, { allowUnregistered: false });
	const repoPathOfProject = target.repoPath;
	if (!repoPathOfProject) {
		throw new Error(`workspace ${target.workspaceId} has no registered repo`);
	}
	const runId = `${new Date().toISOString().slice(0, 10)}-${role}-${agentId}-${Math.random().toString(36).slice(2, 7)}`;
	const runDir = join(getModelVettingRunsPath(), runId);
	await mkdir(runDir, { recursive: true });
	const logPath = join(runDir, "run.log");
	const log = (message: string) => {
		const line = `${new Date().toISOString()} ${message}\n`;
		process.stderr.write(line);
		void writeFile(logPath, line, { flag: "a" }).catch(() => {});
	};
	const { repoPath, task, base } = await createScratchRepo(runId, role);
	log(
		`vet ${runId}: ${describeCombination(combination)} for ${role}; scratch repo ${repoPath}; project ${target.workspaceId} hosts the card`,
	);
	const [{ config }, runtimeConfig, lemonade] = await Promise.all([
		readPipelineConfig(),
		loadGlobalRuntimeConfig(),
		readLemonadeModelListSettings(),
	]);
	const runtimeClient = createRuntimeTrpcClient(target.workspaceId);
	const signals = createAgentRunSignals();
	const projectArgs = { cwd: repoPathOfProject, projectPath: repoPathOfProject };
	let capacityUnknown = false;
	const result = await runVet(
		{ runId, combination, role, task, repoPath, limits },
		{
			board: {
				createTask: async (input) => {
					const created = await createTask({
						...projectArgs,
						title: input.title,
						prompt: input.prompt,
						// Calibration cards are left alone by the pipeline, auto-review and the watchdog's stall checks.
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
					await startTask({ ...projectArgs, taskId });
				},
				discardTask: async (taskId) => {
					await trashTask({ ...projectArgs, taskId, landing: "discard" });
				},
				deliverInput: async (taskId, text) => {
					const delivery = await runtimeClient.runtime.deliverTaskInput.mutate({ taskId, text });
					return { ok: delivery.ok, error: delivery.error ?? delivery.status };
				},
				readTask: async (taskId) => {
					const state = await runtimeClient.workspace.getState.query();
					const column = state.board.columns.find((candidate) =>
						candidate.cards.some((card) => card.id === taskId),
					);
					return { columnId: column?.id ?? null, session: state.sessions[taskId] ?? null };
				},
			},
			signals: {
				isSignedIn: (id) => signals.isSignedIn(id),
				hasStartedTurn: (id, path) => signals.hasStartedTurn(id, path),
				hasImageRejection: async (id, path) => {
					const rejection = await signals.hasImageRejection(id, path);
					return rejection === null ? null : rejection !== false;
				},
				countToolUse: (id, path) => signals.countToolUse(id, path),
				findToolCallLoop: (id, path, last) => signals.findToolCallLoop(id, path, last),
			},
			readSignInGap: async ({ agentId, provider }) =>
				getAgentTurnEndSource(agentId) === "cline-session-files"
					? await readClineTuiSignInGap(getClineDataDirPath(config.agents.cline.dataDir), provider)
					: null,
			findCapacityHold: async ({ provider, model }) => {
				if (!provider || !model || capacityUnknown) {
					return null;
				}
				try {
					return (await runtimeClient.models.capacity.query({ provider, model })).hold;
				} catch (error) {
					// A server without the route (an older build): the run goes ahead as before, said once.
					capacityUnknown = true;
					log(
						`vet ${runId}: the server can't tell ${provider}'s capacity (${toErrorMessage(error)}); not waiting for it`,
					);
					return null;
				}
			},
			probe: createVetProbe({
				clineDataDir: config.agents.cline.dataDir,
				hungMin: config.pipeline.recovery.hungMin,
				isModelLoaded: async (provider, model) => {
					if (provider === LEMONADE_PROVIDER_ID) {
						return await fetchLemonadeModelLoaded(lemonadeApiBaseUrl(lemonade.settings.url), model);
					}
					return null;
				},
				findRunningTool: createAgentToolProcessFinder(),
			}),
			findWorktreePath: async (taskId) => {
				for (const path of getTaskWorktreeCandidatePaths(repoPathOfProject, taskId)) {
					if (
						await stat(path).then(
							() => true,
							() => false,
						)
					) {
						return path;
					}
				}
				return null;
			},
			measureCostUSD: async (taskId) => {
				try {
					const { metrics } = await measureCard({
						taskId,
						workspaceId: target.workspaceId,
						selectedAgentId: runtimeConfig.selectedAgentId,
						config,
					});
					return metrics.metrics.costUSD ?? null;
				} catch {
					return null;
				}
			},
			readLatestWriteAt: latestWriteAt,
			checks: createCheckDeps(base),
			now: Date.now,
			sleep: async (ms) => await new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
			log,
		},
	);
	const cliVersion = await readCliVersion(agentId);
	const summary = describeVetSummary(result);
	await writeFile(join(runDir, "result.json"), `${JSON.stringify({ result, cliVersion, summary }, null, 2)}\n`);
	await writeFile(join(runDir, "report.md"), formatVetReport(result, { repoPath }, cliVersion));
	if (options.json) {
		printJson({ ok: true, runDir, result, cliVersion, summary });
	} else {
		process.stdout.write(
			`${result.outcome.toUpperCase()}: ${describeCombination(combination)} for ${role}${result.failure ? ` (${result.failure.kind}: ${result.failure.detail})` : ""}\n${summary}\nReport: ${join(runDir, "report.md")}\n`,
		);
	}
	return result.outcome === "passed" ? 0 : result.outcome === "inconclusive" ? 2 : 1;
}

export function registerModelsVetCommand(models: Command): void {
	models
		.command("vet")
		.description(
			"Run a throwaway smoke-test card (scratch repo in a temp dir, never landed) for one agent + provider + model and role, and write a report (passed, failed or inconclusive, with the tool-call counts). Changes nothing else. Waits first for the provider's capacity (models.providerCapacity). Exit 0 when it passed, 1 when it failed, 2 when it was inconclusive (a harness or environment cause).",
		)
		.requiredOption("--agent <agent>", "The agent CLI.")
		.option("--provider <provider>", "The provider (none: the agent's own).")
		.option("--model <model>", "The model (none: the agent's own default).")
		.requiredOption("--role <role>", "dev, qa or plan.")
		.option("--project <project>", "The project whose board hosts the card (default: this directory's).")
		.option("--max-min <minutes>", `Time cap (default ${DEFAULT_VET_LIMITS.maxMin}).`)
		.option("--max-cost <usd>", `Cost cap in USD (default ${DEFAULT_VET_LIMITS.maxCostUSD}).`)
		.option(
			"--capacity-wait-min <minutes>",
			`How long to wait for the provider's capacity before giving up (default ${DEFAULT_VET_LIMITS.capacityWaitMin}).`,
		)
		.option("--json", "Print JSON.")
		.action(async (options: VetOptions) => {
			try {
				process.exitCode = await runVetCommand(options);
			} catch (error) {
				process.stderr.write(`Models vet failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
