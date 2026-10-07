// Scripted checks (plan §2.6): a submitted card's snapshot is exported to a scratch dir, its dependencies are
// installed, and the workspace's check scripts (`workspaces.<id>.checks.scripts`, default typecheck, lint, test,
// build) that exist in its package.json are run. The result goes to the QA log for QA and people to read; the QA
// gate never waits on it.
//
// A full install + test suite per Review card once pegged the shared pod, so checks are fenced in:
//
// - Per project: off unless `workspaces.<id>.checks.enabled` is true, or it is unset and the workspace has landing
//   `qa` with a kit other than `default` (resolveChecksEnabled). A project on the `default` kit never runs any.
// - Serialized: one queue for the whole worker, one step at a time. A newer snapshot of a queued card replaces the
//   queued one instead of adding a run.
// - Resource-limited: every step runs under `nice` (`pipeline.checks.niceness`), test runners get
//   `pipeline.checks.maxWorkers` workers, and a step is killed (its whole process group) after
//   `pipeline.checks.timeoutMin`.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (enqueueChecks, exportSnapshot, runStep,
// installDirs, writeChecksNpmrc, prismaSchemas, the harness-failure patterns and the report).
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

import type { PipelineConfig, WorkspacePipelineSettings } from "../config/pipeline-config";
import { createGitProcessEnv } from "../core/git-process-env";
import { DEFAULT_KIT_NAME } from "../kits/resolve-kit";

/** Bump when the checker changes so that old results are stale. 2 = the legacy kit's checker. */
export const CHECKS_VERSION = 2;

export type ChecksSettings = PipelineConfig["pipeline"]["checks"];

/** Whether a workspace runs scripted checks: its explicit setting, else only with landing `qa` on a real kit. */
export function resolveChecksEnabled(settings: WorkspacePipelineSettings, kitName: string): boolean {
	return settings.checks.enabled ?? (settings.landing.mode === "qa" && kitName !== DEFAULT_KIT_NAME);
}

export interface ChecksRequest {
	workspaceId: string;
	/** The workspace's repo (snapshots are exported from its object store, so a deleted worktree doesn't matter). */
	repoPath: string;
	taskId: string;
	title: string;
	baseRef: string;
	snapshot: string;
	scripts: string[];
}

export interface CheckStepResult {
	name: string;
	ok: boolean;
	/** `true`: not run (the install failed); `"harness"`: failed for a checker reason and not counted. */
	skipped?: true | "harness";
	/** The failure (or the warning) is the checker's environment, not the code; the snapshot is checked again. */
	harness?: boolean;
	ms?: number;
	timedOut?: boolean;
	text?: string;
}

export interface ChecksResult {
	request: ChecksRequest;
	/** `ERROR`: the checker itself failed (export, scratch dir); `harness` is then true. */
	verdict: "PASS" | "FAIL" | "ERROR";
	harness: boolean;
	steps: CheckStepResult[];
	logsDir: string;
	startedAt: number;
	finishedAt: number;
	timeoutMin: number;
	error: string | null;
}

export type ChecksEnqueueStatus = "queued" | "requeued" | "already_queued" | "running";

export interface ChecksQueue {
	enqueue: (request: ChecksRequest) => ChecksEnqueueStatus;
}

export interface ChecksRunner extends ChecksQueue {
	/** Resolves once the queue is empty and nothing runs. */
	idle: () => Promise<void>;
	/** Drops the queue and kills the running step. */
	close: () => void;
}

export interface RunCheckStepInput {
	command: string;
	cwd: string;
	logFile: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	niceness: number;
	/** Called with the spawned child, so close() can kill it. */
	onSpawn: (child: ChildProcess) => void;
}

export interface CreateChecksRunnerOptions {
	readSettings: () => Promise<ChecksSettings>;
	onResult: (result: ChecksResult) => Promise<void>;
	log: (message: string) => void;
	runStep?: (input: RunCheckStepInput) => Promise<Omit<CheckStepResult, "name">>;
	exportSnapshot?: (repoPath: string, snapshot: string, dir: string) => Promise<void>;
	now?: () => number;
}

// Failures caused by the checker's environment, not the code.
const HARNESS_LINT = /Invalid project directory provided, no such directory: \S*\/lint\b/;
const HARNESS_INSTALL = /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENOSPC)\b|install scripts blocked/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes from tool output.
const ANSI = /\x1b\[[0-9;]*m/g;

/** Environment for every check step: no Kanban or git repository variables leak into the project's scripts. */
export function createCheckStepEnv(settings: ChecksSettings, npmrcPath: string): NodeJS.ProcessEnv {
	const env = createGitProcessEnv();
	for (const key of Object.keys(env)) {
		// A project's own tests must never find the server's Kanban home or runtime port (Kanban's own suite would
		// write into the live home).
		if (key.startsWith("KANBAN_")) {
			delete env[key];
		}
	}
	// NODE_ENV=production makes npm skip devDependencies.
	delete env.NODE_ENV;
	const workers = String(settings.maxWorkers);
	return {
		...env,
		CI: "1",
		npm_config_userconfig: npmrcPath,
		// Vitest 3+ reads VITEST_MAX_WORKERS; older majors read the threads/forks variants.
		VITEST_MAX_WORKERS: workers,
		VITEST_MAX_THREADS: workers,
		VITEST_MAX_FORKS: workers,
		UV_THREADPOOL_SIZE: workers,
	};
}

function killProcessGroup(child: ChildProcess): void {
	if (child.pid === undefined) {
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

/** Runs one shell command, niced, in its own process group, with its output in `logFile`. */
export async function runCheckStep(input: RunCheckStepInput): Promise<Omit<CheckStepResult, "name">> {
	await mkdir(dirname(input.logFile), { recursive: true });
	const fd = openSync(input.logFile, "w");
	const startedAt = Date.now();
	try {
		const shell = ["sh", "-c", input.command];
		const [file, ...args] = input.niceness > 0 ? ["nice", "-n", String(input.niceness), ...shell] : shell;
		// Detached: the step leads its own process group, so a timeout kills everything it started.
		const child = spawn(file as string, args, {
			cwd: input.cwd,
			env: input.env,
			stdio: ["ignore", fd, fd],
			detached: true,
		});
		input.onSpawn(child);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killProcessGroup(child);
		}, input.timeoutMs);
		const code = await new Promise<number | null>((resolve) => {
			child.on("error", () => resolve(null));
			child.on("close", (exitCode) => resolve(exitCode));
		});
		clearTimeout(timer);
		// Anything the step left behind in its group (a dev server a test started) goes too.
		killProcessGroup(child);
		const text = readFileSync(input.logFile, "utf8");
		return { ok: code === 0 && !timedOut, ms: Date.now() - startedAt, timedOut, text };
	} finally {
		closeSync(fd);
	}
}

/** `git archive <snapshot> | tar -x -C <dir>` into a fresh dir. */
export async function exportSnapshotToDir(repoPath: string, snapshot: string, dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	await new Promise<void>((resolve, reject) => {
		const archive = spawn("git", ["archive", "--format=tar", snapshot], {
			cwd: repoPath,
			env: createGitProcessEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const untar = spawn("tar", ["-x", "-C", dir], { stdio: ["pipe", "ignore", "pipe"] });
		let stderr = "";
		archive.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		untar.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		archive.stdout.pipe(untar.stdin);
		let archiveCode: number | null = null;
		archive.on("error", reject);
		untar.on("error", reject);
		archive.on("close", (code) => {
			archiveCode = code;
		});
		untar.on("close", (code) => {
			if (archiveCode === 0 && code === 0) {
				resolve();
			} else {
				reject(
					new Error(`exporting ${snapshot.slice(0, 8)} failed: ${stderr.trim() || `exit ${archiveCode}/${code}`}`),
				);
			}
		});
	});
}

/** The root plus every package up to two levels down (server/, tools/preview/), skipping dot dirs and node_modules. */
export function findInstallDirs(dir: string, depth = 2, rel = "."): string[] {
	const dirs = existsSync(join(dir, rel, "package.json")) ? [rel] : [];
	if (depth === 0) {
		return dirs;
	}
	for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
			continue;
		}
		dirs.push(...findInstallDirs(dir, depth - 1, rel === "." ? entry.name : join(rel, entry.name)));
	}
	return dirs;
}

/** Prisma schemas outside node_modules (prisma/schema.prisma, server/prisma/schema.prisma, …). */
export function findPrismaSchemas(dir: string, depth = 3, rel = "."): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") {
			continue;
		}
		const path = rel === "." ? entry.name : join(rel, entry.name);
		if (entry.isFile() && entry.name === "schema.prisma") {
			found.push(path);
		} else if (entry.isDirectory() && depth > 0) {
			found.push(...findPrismaSchemas(dir, depth - 1, path));
		}
	}
	return found;
}

/** The nearest dir at or above the schema with the prisma CLI installed. */
function findPrismaDir(dir: string, schema: string): string | null {
	for (let current = dirname(schema); ; current = dirname(current)) {
		if (existsSync(join(dir, current, "node_modules/.bin/prisma"))) {
			return current;
		}
		if (current === ".") {
			return null;
		}
	}
}

/**
 * The checks' own npm user config: the user's ~/.npmrc plus `allow-scripts`. npm refuses `--allow-scripts` for a
 * project install, so the allowlist can only go in an npmrc.
 */
async function writeChecksNpmrc(path: string, allowScripts: readonly string[]): Promise<void> {
	const userNpmrc = join(homedir(), ".npmrc");
	const base = existsSync(userNpmrc) ? `${(await readFile(userNpmrc, "utf8")).trimEnd()}\n` : "";
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, allowScripts.length > 0 ? `${base}allow-scripts=${allowScripts.join(",")}\n` : base);
}

function logName(name: string): string {
	return name.replaceAll("/", "-");
}

async function readScripts(dir: string): Promise<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
		const scripts = parsed && typeof parsed === "object" ? (parsed as { scripts?: unknown }).scripts : undefined;
		return scripts && typeof scripts === "object" ? (scripts as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export function createChecksRunner(options: CreateChecksRunnerOptions): ChecksRunner {
	const runStep = options.runStep ?? runCheckStep;
	const exportSnapshot = options.exportSnapshot ?? exportSnapshotToDir;
	const now = options.now ?? Date.now;
	const queue: ChecksRequest[] = [];
	let current: ChecksRequest | null = null;
	let currentChild: ChildProcess | null = null;
	let pumping: Promise<void> | null = null;
	let closed = false;

	const sameCard = (a: ChecksRequest, b: ChecksRequest) => a.workspaceId === b.workspaceId && a.taskId === b.taskId;

	const run = async (request: ChecksRequest): Promise<ChecksResult> => {
		const settings = await options.readSettings();
		const dir = join(settings.scratchRoot, request.workspaceId, request.taskId);
		const logsDir = join(dir, ".checks");
		const startedAt = now();
		const steps: CheckStepResult[] = [];
		const result = (verdict: ChecksResult["verdict"], harness: boolean, error: string | null): ChecksResult => ({
			request,
			verdict,
			harness,
			steps,
			logsDir,
			startedAt,
			finishedAt: now(),
			timeoutMin: settings.timeoutMin,
			error,
		});
		const npmrcPath = join(settings.scratchRoot, ".npmrc-checks");
		let installDirs: string[] = [];
		try {
			await exportSnapshot(request.repoPath, request.snapshot, dir);
			await mkdir(logsDir, { recursive: true });
			await writeChecksNpmrc(npmrcPath, settings.allowScripts);
			const env = createCheckStepEnv(settings, npmrcPath);
			const step = async (name: string, command: string, cwd: string, logFile: string) =>
				await runStep({
					command,
					cwd,
					logFile: join(logsDir, logFile),
					env,
					timeoutMs: settings.timeoutMin * 60_000,
					niceness: settings.niceness,
					onSpawn: (child) => {
						currentChild = child;
					},
				}).then((stepResult) => ({ name, ...stepResult }));

			installDirs = findInstallDirs(dir);
			for (const installDir of installDirs) {
				if (closed) {
					break;
				}
				const cwd = join(dir, installDir);
				// Never let npm ci run through a committed node_modules symlink into a shared tree.
				const nodeModules = join(cwd, "node_modules");
				if (lstatSync(nodeModules, { throwIfNoEntry: false })?.isSymbolicLink()) {
					await unlink(nodeModules);
				}
				const command = existsSync(join(cwd, "package-lock.json"))
					? "npm ci --no-audit --no-fund"
					: "npm install --no-audit --no-fund";
				const label = installDir === "." ? "install" : `install ${installDir}/`;
				const stepResult = await step(
					label,
					command,
					cwd,
					`install-${installDir === "." ? "root" : logName(installDir)}.log`,
				);
				steps.push({ ...stepResult, harness: HARNESS_INSTALL.test(stepResult.text ?? "") });
			}
			// A broken sub-package install is reported but doesn't block the scripts.
			const installed = steps[0]?.ok ?? false;
			if (installed) {
				for (const schema of findPrismaSchemas(dir)) {
					if (closed) {
						break;
					}
					const at = findPrismaDir(dir, schema) ?? ".";
					const stepResult = await step(
						`prisma generate${schema === "prisma/schema.prisma" ? "" : ` ${schema}`}`,
						`./node_modules/.bin/prisma generate --schema=${relative(at, schema)}`,
						join(dir, at),
						`prisma-generate-${logName(schema)}.log`,
					);
					steps.push({ ...stepResult, harness: !stepResult.ok });
				}
			}
			const scripts = await readScripts(dir);
			for (const name of request.scripts) {
				if (!scripts[name] || closed) {
					continue;
				}
				if (!installed) {
					steps.push({ name, ok: false, skipped: true });
					continue;
				}
				const stepResult = await step(name, `npm run -s ${name}`, dir, `${logName(name)}.log`);
				// `next lint` is gone from newer Next.js; it parses "lint" as a project directory instead.
				const lintHarness = !stepResult.ok && name === "lint" && HARNESS_LINT.test(stepResult.text ?? "");
				steps.push(lintHarness ? { ...stepResult, skipped: "harness" } : stepResult);
			}
			const failed = steps.filter((entry) => !entry.ok && !entry.skipped);
			return result(
				failed.length === 0 ? "PASS" : "FAIL",
				steps.some((entry) => entry.harness === true),
				null,
			);
		} catch (error) {
			return result("ERROR", true, error instanceof Error ? error.message : String(error));
		} finally {
			currentChild = null;
			// The exported source and the logs stay for people to read; node_modules is most of the disk.
			for (const installDir of installDirs) {
				await rm(join(dir, installDir, "node_modules"), { recursive: true, force: true }).catch(() => {});
			}
		}
	};

	const pump = (): Promise<void> => {
		if (pumping) {
			return pumping;
		}
		pumping = (async () => {
			while (queue.length > 0 && !closed) {
				const request = queue.shift() as ChecksRequest;
				current = request;
				options.log(`checks ${request.taskId}: started on ${request.snapshot.slice(0, 8)}`);
				const result = await run(request);
				current = null;
				if (closed) {
					break;
				}
				try {
					await options.onResult(result);
				} catch (error) {
					options.log(
						`checks ${request.taskId}: recording the result failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		})().finally(() => {
			pumping = null;
		});
		return pumping;
	};

	return {
		enqueue: (request) => {
			if (closed) {
				return "already_queued";
			}
			if (current && sameCard(current, request) && current.snapshot === request.snapshot) {
				return "running";
			}
			const index = queue.findIndex((queued) => sameCard(queued, request));
			let status: ChecksEnqueueStatus = "queued";
			if (index >= 0) {
				if (queue[index]?.snapshot === request.snapshot) {
					return "already_queued";
				}
				queue[index] = request;
				status = "requeued";
			} else {
				queue.push(request);
			}
			void pump();
			return status;
		},
		idle: async () => {
			while (pumping) {
				await pumping;
			}
		},
		close: () => {
			closed = true;
			queue.length = 0;
			if (currentChild) {
				killProcessGroup(currentChild);
			}
		},
	};
}

function stepIcon(step: CheckStepResult): string {
	if (step.skipped === "harness") {
		return "⏭️ skipped (harness)";
	}
	if (step.skipped) {
		return "⏭️";
	}
	return step.ok ? "✅" : step.timedOut ? "⏱️" : "❌";
}

function testSummary(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(ANSI, "").trim())
		.filter((line) => /^(Tests?( Files)?|Test Suites:|Tests:)\s/.test(line))
		.join("; ");
}

/** The QA-log section for a result (the legacy kit's format, so QA prompts and people read it the same way). */
export function formatChecksReport(result: ChecksResult): string {
	const { request } = result;
	const header = `## ${request.taskId} ${request.title} — checks ${result.verdict}${result.harness ? " (harness problems; will re-check)" : ""}`;
	const lines = [
		header,
		`- Checked: ${new Date(result.finishedAt).toISOString()} | snapshot ${request.snapshot.slice(0, 8)} on ${request.baseRef} | logs: ${result.logsDir} | checker v${CHECKS_VERSION}`,
	];
	if (result.error) {
		lines.push(`- Checker error: ${result.error}`);
	}
	if (result.steps.length > 0) {
		lines.push(
			`- Checks: ${result.steps
				.map(
					(step) =>
						`${step.name} ${stepIcon(step)}${step.ms && !step.skipped ? ` (${Math.round(step.ms / 1000)}s)` : ""}`,
				)
				.join(" · ")}`,
		);
	}
	const tests = result.steps.find((step) => step.name === "test");
	const summary = tests?.text ? testSummary(tests.text) : "";
	if (summary) {
		lines.push(`- Tests: ${summary}`);
	}
	for (const step of result.steps.filter((entry) => entry.ok && entry.harness)) {
		lines.push(
			`- ${step.name}: install scripts still blocked (see ${result.logsDir}); add them to pipeline.checks.allowScripts`,
		);
	}
	for (const step of result.steps.filter((entry) => !entry.ok && !entry.skipped)) {
		const all = (step.text ?? "")
			.trim()
			.split("\n")
			.map((line) => line.replace(ANSI, "").slice(0, 200));
		// Wrappers like Turbopack's put the real cause far above the stack tail; lead with it.
		const cause = all.find(
			(line) => /^\s*Error: /.test(line) && !/Turbopack build failed|Error evaluating/.test(line),
		);
		const tail = all.slice(-6);
		if (cause && !tail.includes(cause)) {
			tail.unshift(cause.trim(), "    ...");
		}
		lines.push(
			`- ${step.name} failed${step.timedOut ? ` (timed out after ${result.timeoutMin} min)` : ""}:`,
			...tail.map((line) => `    ${line}`),
		);
	}
	lines.push("- Scripted checks only; QA reviews the requirements.");
	return `\n${lines.join("\n")}\n`;
}
