// `kanban models list|vet|allow-provisional`: the vetted model registry (src/models/vetted-registry.ts,
// docs/team/MODELS.md).
//   - `list` shows what's vetted for which role, provisional, rejected and why (with `--project`, what that project
//     may route to);
//   - `vet` runs the smoke-test card for one combination and role (src/models/vetting/) and writes a report plus a
//     proposed registry entry; it never edits the registry (the Kanban orchestrator commits the proposal);
//   - `allow-provisional` is the user's switch for a project's provisional combinations.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import { readLemonadeModelListSettings } from "../config/model-lists-config";
import {
	getWorkspacePipelineSettings,
	readPipelineConfig,
	updateWorkspacePipelineEntry,
} from "../config/pipeline-config";
import { loadGlobalRuntimeConfig } from "../config/runtime-config";
import { getRuntimeAgentCatalogEntry } from "../core/agent-catalog";
import { type RuntimeAgentId, runtimeAgentIdEnumSchema } from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { listAllowedCombinations } from "../kits/card-routing-check";
import { loadKitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import { measureCard } from "../kits/team/scoreboard/scoreboard-store";
import { fetchLemonadeModelLoaded, lemonadeApiBaseUrl } from "../models/lemonade-models";
import {
	describeCombination,
	getEntryRoleStatus,
	getVettedRegistry,
	type ModelCombination,
	VETTING_ROLES,
	type VettedEntry,
	type VettingRole,
	vettingRoleSchema,
} from "../models/vetted-registry";
import { createVetProbe } from "../models/vetting/vet-probe";
import { buildVetProposal, formatVetReport } from "../models/vetting/vet-report";
import { DEFAULT_VET_LIMITS, runVet, type VetLimits } from "../models/vetting/vet-runner";
import { createVetTask, readTextIfExists, type VetCheckDeps, writeScratchFiles } from "../models/vetting/vet-tasks";
import { createAgentToolProcessFinder } from "../server/process-reaper";
import { getModelVettingRunsPath } from "../state/kanban-home";
import { createAgentRunSignals } from "../terminal/agent-run-signals";
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

function describeRole(entry: VettedEntry, role: VettingRole): string {
	const vetting = entry.roles[role];
	const status = getEntryRoleStatus(entry, role);
	if (status === "unknown") {
		return `${role}: -`;
	}
	const when = vetting ? ` ${vetting.at}${vetting.cliVersion ? ` cli ${vetting.cliVersion}` : ""}` : "";
	return `${role}: ${status}${when}`;
}

export function formatRegistryList(
	entries: readonly VettedEntry[],
	role: VettingRole | null,
	allowed: ReadonlySet<VettedEntry> | null,
): string[] {
	const roles = role ? [role] : [...VETTING_ROLES];
	const lines: string[] = [];
	const rejected = entries.filter((entry) => entry.rejected);
	const listed = entries.filter((entry) => !entry.rejected && roles.some((name) => entry.roles[name]));
	for (const entry of listed) {
		const combination = { agentId: entry.agent, provider: entry.provider, model: entry.model };
		const mark = allowed ? (allowed.has(entry) ? "ok  " : "--  ") : "";
		lines.push(`${mark}${describeCombination(combination)}`);
		lines.push(`    ${roles.map((name) => describeRole(entry, name)).join("   ")}`);
		for (const name of roles) {
			const vetting = entry.roles[name];
			if (vetting) {
				lines.push(`    ${name}: ${vetting.reason ? `${vetting.reason}; ` : ""}${vetting.evidence.summary}`);
			}
		}
	}
	if (rejected.length > 0) {
		lines.push("", "Rejected:");
		for (const entry of rejected) {
			const combination = { agentId: entry.agent, provider: entry.provider, model: entry.model };
			const scope =
				entry.rejected?.scope === "model"
					? `${entry.model} on every agent and provider`
					: describeCombination(combination);
			lines.push(`  ${scope} (${entry.rejected?.at}): ${entry.rejected?.reason}`);
		}
	}
	return lines;
}

async function runList(options: { project?: string; role?: string; json?: boolean }): Promise<number> {
	const registry = getVettedRegistry();
	const role = options.role ? vettingRoleSchema.parse(options.role) : null;
	let allowed: Set<VettedEntry> | null = null;
	let header: string | null = null;
	if (options.project) {
		const target = await resolveWorkspaceTarget(options.project, { allowUnregistered: false });
		const [{ config }, catalog] = await Promise.all([readPipelineConfig(), loadKitCatalog()]);
		const { kitName } = resolveWorkspaceKit(config, target.workspaceId, catalog);
		const allowProvisional = getWorkspacePipelineSettings(config, target.workspaceId).models.allowProvisional;
		allowed = new Set(
			registry.entries.filter((entry) =>
				(role ? [role] : VETTING_ROLES).some((name) => {
					const status = getEntryRoleStatus(entry, name);
					return status === "vetted" || (status === "provisional" && allowProvisional);
				}),
			),
		);
		header = `${target.workspaceId} (kit ${kitName}${listAllowedCombinations(config, target.workspaceId, kitName, "dev") === null ? ": routes nothing" : ""}): ok = it may route ${role ?? "some role's"} work there; provisional combinations ${allowProvisional ? "allowed" : "refused (the user's kanban models allow-provisional)"}`;
	}
	if (options.json) {
		printJson({
			ok: true,
			entries: registry.entries.map((entry) => ({ ...entry, ...(allowed ? { allowed: allowed.has(entry) } : {}) })),
		});
		return 0;
	}
	const lines = formatRegistryList(registry.entries, role, allowed);
	process.stdout.write(`${[header, ...lines].filter((line) => line !== null).join("\n")}\n`);
	process.stdout.write(
		"\nAn unlisted combination is refused for routing: vet it with kanban models vet --agent <a> [--provider <p>] [--model <m>] --role <dev|qa|plan>.\n",
	);
	return 0;
}

async function runAllowProvisional(state: string, options: { project?: string }): Promise<number> {
	if (state !== "on" && state !== "off") {
		throw new Error(`expected on or off, got ${state}`);
	}
	const target = await resolveWorkspaceTarget(options.project, { allowUnregistered: false });
	await updateWorkspacePipelineEntry(target.workspaceId, (entry) => {
		const models = entry.models && typeof entry.models === "object" ? entry.models : {};
		entry.models = { ...models, allowProvisional: state === "on" };
		return entry;
	});
	process.stdout.write(
		`${target.workspaceId}: provisional combinations of the vetted model registry are ${state === "on" ? "allowed" : "refused"} for its routing.\n`,
	);
	return 0;
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
			probe: createVetProbe({
				clineDataDir: config.agents.cline.dataDir,
				hungMin: config.pipeline.recovery.hungMin,
				isLemonadeModelLoaded: async (model) =>
					await fetchLemonadeModelLoaded(lemonadeApiBaseUrl(lemonade.settings.url), model),
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
	const proposal = buildVetProposal(getVettedRegistry(), result, await readCliVersion(agentId));
	await writeFile(join(runDir, "result.json"), `${JSON.stringify({ result, proposal }, null, 2)}\n`);
	await writeFile(join(runDir, "report.md"), formatVetReport(result, proposal, { repoPath }));
	if (options.json) {
		printJson({ ok: true, runDir, result, proposal });
	} else {
		process.stdout.write(
			`${result.outcome.toUpperCase()}: ${describeCombination(combination)} for ${role}${result.failure ? ` (${result.failure.kind}: ${result.failure.detail})` : ""}\nReport: ${join(runDir, "report.md")}\nProposed entry for models/vetted.json (the Kanban orchestrator commits it; nothing was changed):\n${JSON.stringify(proposal.entry, null, "\t")}\n`,
		);
	}
	return result.outcome === "passed" ? 0 : 1;
}

export function registerModelsRegistryCommands(models: Command): void {
	models
		.command("list")
		.description("Show the vetted model registry: what's vetted for which role, provisional, rejected and why.")
		.option("--project <project>", "Mark what this project may route to (its provisional switch included).")
		.option("--role <role>", "Only this role: dev, qa or plan.")
		.option("--json", "Print JSON.")
		.action(async (options: { project?: string; role?: string; json?: boolean }) => {
			try {
				process.exitCode = await runList(options);
			} catch (error) {
				process.stderr.write(`Models list failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
	models
		.command("vet")
		.description(
			"Run a throwaway smoke-test card (scratch repo in a temp dir, never landed) for one agent + provider + model and role, and write a report plus a proposed registry entry. Exit 0 when it passed.",
		)
		.requiredOption("--agent <agent>", "The agent CLI.")
		.option("--provider <provider>", "The provider (none: the agent's own).")
		.option("--model <model>", "The model (none: the agent's own default).")
		.requiredOption("--role <role>", "dev, qa or plan.")
		.option("--project <project>", "The project whose board hosts the card (default: this directory's).")
		.option("--max-min <minutes>", `Time cap (default ${DEFAULT_VET_LIMITS.maxMin}).`)
		.option("--max-cost <usd>", `Cost cap in USD (default ${DEFAULT_VET_LIMITS.maxCostUSD}).`)
		.option("--json", "Print JSON.")
		.action(async (options: VetOptions) => {
			try {
				process.exitCode = await runVetCommand(options);
			} catch (error) {
				process.stderr.write(`Models vet failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
	models
		.command("allow-provisional")
		.description(
			"The user's: allow (on) or refuse (off) the registry's provisional combinations for a project's routing.",
		)
		.argument("<state>", "on or off")
		.option("--project <project>", "The project (default: this directory's).")
		.action(async (state: string, options: { project?: string }) => {
			try {
				process.exitCode = await runAllowProvisional(state, options);
			} catch (error) {
				process.stderr.write(`Models allow-provisional failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
