import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getDefaultWorkspacePipelineSettings, parsePipelineConfig } from "../../../src/config/pipeline-config";
import {
	CHECKS_TAIL_LINES,
	type ChecksRequest,
	type ChecksResult,
	type ChecksSettings,
	createCheckStepEnv,
	createChecksRunner,
	exportSnapshotToDir,
	formatChecksReport,
	type RunCheckStepInput,
	resolveChecksEnabled,
	runCheckStep,
	tailCheckOutput,
	toStoredChecksResult,
} from "../../../src/pipeline/checks";
import { createRepoWithWorktree, git } from "../../utilities/git-repo";
import { createTempDir } from "../../utilities/temp-dir";

function createDeferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function request(overrides: Partial<ChecksRequest> = {}): ChecksRequest {
	return {
		workspaceId: "foo",
		repoPath: "/repos/foo",
		taskId: "dev-1",
		title: "Add the thing",
		baseRef: "main",
		snapshot: "aaaaaaaa11111111",
		scripts: ["typecheck", "lint", "test", "build"],
		...overrides,
	};
}

describe("resolveChecksEnabled", () => {
	const settingsFor = (entry: unknown) =>
		parsePipelineConfig({ workspaces: { foo: entry } }).config.workspaces.foo ??
		getDefaultWorkspacePipelineSettings();

	it("is off for a workspace without an entry and for the default kit, even on landing qa", () => {
		expect(resolveChecksEnabled(getDefaultWorkspacePipelineSettings(), "default")).toBe(false);
		expect(resolveChecksEnabled(settingsFor({ landing: { mode: "qa" } }), "default")).toBe(false);
	});

	it("is on by default only for landing qa on another kit", () => {
		expect(resolveChecksEnabled(settingsFor({ landing: { mode: "qa" }, kit: { name: "team" } }), "team")).toBe(true);
		expect(resolveChecksEnabled(settingsFor({ landing: { mode: "commit" }, kit: { name: "team" } }), "team")).toBe(
			false,
		);
	});

	it("an explicit setting wins both ways", () => {
		expect(resolveChecksEnabled(settingsFor({ landing: { mode: "qa" }, checks: { enabled: false } }), "team")).toBe(
			false,
		);
		expect(resolveChecksEnabled(settingsFor({ checks: { enabled: true } }), "default")).toBe(true);
	});
});

describe("check step environment", () => {
	it("caps test-runner workers, drops Kanban, git repo and secret token variables and NODE_ENV", () => {
		const previous = { ...process.env };
		process.env.KANBAN_HOME = "/live/home";
		process.env.KANBAN_RUNTIME_PORT = "3484";
		process.env.GIT_DIR = "/elsewhere/.git";
		process.env.NODE_ENV = "production";
		process.env.GH_TOKEN = "user-pat";
		process.env.GITHUB_TOKEN = "user-pat";
		process.env.COPILOT_GITHUB_TOKEN = "copilot-token";
		process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-key";
		process.env.AWS_REGION = "us-east-1";
		try {
			const settings = parsePipelineConfig({ pipeline: { checks: { maxWorkers: 3 } } }).config.pipeline.checks;
			const env = createCheckStepEnv(settings, "/tmp/checks/.npmrc");
			expect(env).toMatchObject({
				CI: "1",
				npm_config_userconfig: "/tmp/checks/.npmrc",
				VITEST_MAX_WORKERS: "3",
				VITEST_MAX_THREADS: "3",
				VITEST_MAX_FORKS: "3",
			});
			for (const key of [
				"KANBAN_HOME",
				"KANBAN_RUNTIME_PORT",
				"GIT_DIR",
				"NODE_ENV",
				"GH_TOKEN",
				"GITHUB_TOKEN",
				"COPILOT_GITHUB_TOKEN",
				"AWS_BEARER_TOKEN_BEDROCK",
			]) {
				expect(env[key]).toBeUndefined();
			}
		} finally {
			process.env = previous;
		}
	});
});

describe("runCheckStep", () => {
	const temps: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const temp of temps.splice(0)) {
			temp.cleanup();
		}
	});
	const tempDir = () => {
		const temp = createTempDir("kanban-check-step-");
		temps.push(temp);
		return temp.path;
	};

	it("runs the command niced with its output in the log file", async () => {
		const dir = tempDir();
		const result = await runCheckStep({
			command: "echo hello; nice",
			cwd: dir,
			logFile: join(dir, "logs", "step.log"),
			env: process.env,
			timeoutMs: 10_000,
			niceness: 7,
			onSpawn: () => {},
		});
		expect(result.ok).toBe(true);
		// `nice` with no arguments prints the niceness it runs at.
		expect(
			readFileSync(join(dir, "logs", "step.log"), "utf8")
				.split("\n")
				.slice(0, 2),
		).toEqual(["hello", expect.stringMatching(/^\d+$/)]);
		expect(Number(result.text?.split("\n")[1])).toBeGreaterThanOrEqual(7);
	});

	it("kills the step's whole process group at the timeout", async () => {
		const dir = tempDir();
		const pidFile = join(dir, "child.pid");
		const started = Date.now();
		const result = await runCheckStep({
			// A background child in the same group must go too.
			command: `sleep 30 & echo $! > ${pidFile}; wait`,
			cwd: dir,
			logFile: join(dir, "step.log"),
			env: process.env,
			timeoutMs: 300,
			niceness: 0,
			onSpawn: () => {},
		});
		expect(result).toMatchObject({ ok: false, timedOut: true });
		expect(Date.now() - started).toBeLessThan(10_000);
		const pid = Number(readFileSync(pidFile, "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(() => process.kill(pid, 0)).toThrow();
	});
});

describe("checks runner", () => {
	const temps: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const temp of temps.splice(0)) {
			temp.cleanup();
		}
	});

	function createHarness(options: { scripts?: Record<string, string>; failing?: string[]; holdFirst?: boolean } = {}) {
		const temp = createTempDir("kanban-checks-");
		temps.push(temp);
		const settings: ChecksSettings = {
			...parsePipelineConfig({}).config.pipeline.checks,
			scratchRoot: join(temp.path, "scratch"),
		};
		const steps: RunCheckStepInput[] = [];
		const results: ChecksResult[] = [];
		const exported: string[] = [];
		const hold = createDeferred();
		let active = 0;
		let maxActive = 0;
		const runner = createChecksRunner({
			readSettings: async () => settings,
			onResult: async (result) => {
				results.push(result);
			},
			log: () => {},
			exportSnapshot: async (_repoPath, snapshot, dir) => {
				exported.push(snapshot);
				mkdirSync(join(dir, "node_modules"), { recursive: true });
				writeFileSync(join(dir, "package-lock.json"), "{}");
				writeFileSync(
					join(dir, "package.json"),
					JSON.stringify({ scripts: options.scripts ?? { typecheck: "tsc", test: "vitest run" } }),
				);
			},
			runStep: async (input) => {
				steps.push(input);
				active += 1;
				maxActive = Math.max(maxActive, active);
				if (options.holdFirst && steps.length === 1) {
					await hold.promise;
				}
				active -= 1;
				const failed = options.failing?.some((name) => input.command.includes(name)) ?? false;
				return { ok: !failed, ms: 1000, timedOut: false, text: failed ? "Error: boom\nfailed" : "Tests  3 passed" };
			},
		});
		return { runner, settings, steps, results, exported, hold, getMaxActive: () => maxActive };
	}

	it("installs, runs the configured scripts that exist, niced and capped, and reports PASS", async () => {
		const harness = createHarness();
		expect(harness.runner.enqueue(request())).toBe("queued");
		await harness.runner.idle();

		expect(harness.steps.map((step) => step.command)).toEqual([
			"npm ci --no-audit --no-fund",
			"npm run -s typecheck",
			"npm run -s test",
		]);
		for (const step of harness.steps) {
			expect(step.niceness).toBe(10);
			expect(step.timeoutMs).toBe(15 * 60_000);
			expect(step.env.VITEST_MAX_WORKERS).toBe("2");
		}
		expect(harness.results).toHaveLength(1);
		expect(harness.results[0]).toMatchObject({ verdict: "PASS", harness: false, error: null });
		// node_modules is removed after the run; the logs stay.
		const dir = join(harness.settings.scratchRoot, "foo", "dev-1");
		expect(existsSync(join(dir, "node_modules"))).toBe(false);
		expect(existsSync(join(dir, ".checks"))).toBe(true);
		expect(readFileSync(join(harness.settings.scratchRoot, ".npmrc-checks"), "utf8")).toContain(
			"allow-scripts=esbuild,prisma,@prisma/engines,@prisma/client,sqlite3",
		);
	});

	it("runs one step at a time across cards, and a newer snapshot replaces a queued one", async () => {
		const harness = createHarness({ holdFirst: true });
		expect(harness.runner.enqueue(request({ taskId: "a" }))).toBe("queued");
		expect(harness.runner.enqueue(request({ taskId: "b", snapshot: "b1" }))).toBe("queued");
		expect(harness.runner.enqueue(request({ taskId: "b", snapshot: "b1" }))).toBe("already_queued");
		expect(harness.runner.enqueue(request({ taskId: "b", snapshot: "b2" }))).toBe("requeued");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(harness.runner.enqueue(request({ taskId: "a" }))).toBe("running");
		harness.hold.resolve();
		await harness.runner.idle();

		expect(harness.getMaxActive()).toBe(1);
		expect(harness.exported).toEqual(["aaaaaaaa11111111", "b2"]);
		expect(harness.results.map((result) => [result.request.taskId, result.request.snapshot])).toEqual([
			["a", "aaaaaaaa11111111"],
			["b", "b2"],
		]);
	});

	it("a newer snapshot of the card being checked stops that run and drops its result", async () => {
		const harness = createHarness({ holdFirst: true });
		expect(harness.runner.enqueue(request({ taskId: "a", snapshot: "a1" }))).toBe("queued");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(harness.runner.enqueue(request({ taskId: "a", snapshot: "a2" }))).toBe("superseded");
		// The old snapshot is not "running" any more: asking for it again queues it.
		expect(harness.runner.enqueue(request({ taskId: "a", snapshot: "a2" }))).toBe("already_queued");
		harness.hold.resolve();
		await harness.runner.idle();

		expect(harness.exported).toEqual(["a1", "a2"]);
		// a1 stopped after its install step; only a2's result is reported.
		expect(harness.steps.map((step) => step.command)).toEqual([
			"npm ci --no-audit --no-fund",
			"npm ci --no-audit --no-fund",
			"npm run -s typecheck",
			"npm run -s test",
		]);
		expect(harness.results.map((result) => result.request.snapshot)).toEqual(["a2"]);
	});

	it("keeps each step's command and a bounded tail of a failed step's output for the QA prompt", async () => {
		const harness = createHarness({ failing: ["typecheck"] });
		harness.runner.enqueue(request());
		await harness.runner.idle();
		const stored = toStoredChecksResult(harness.results[0] as ChecksResult);
		expect(stored.steps).toEqual([
			{ name: "install", status: "ok", ms: 1000, command: "npm ci --no-audit --no-fund", harness: false, tail: [] },
			{
				name: "typecheck",
				status: "fail",
				ms: 1000,
				command: "npm run -s typecheck",
				harness: false,
				tail: ["Error: boom", "failed"],
			},
			{ name: "test", status: "ok", ms: 1000, command: "npm run -s test", harness: false, tail: [] },
		]);
		const long = Array.from({ length: 100 }, (_, index) => `\x1b[31mline ${index}\x1b[0m ${"x".repeat(400)}`).join(
			"\n",
		);
		const tail = tailCheckOutput(long);
		expect(tail).toHaveLength(CHECKS_TAIL_LINES);
		expect(tail[0]?.startsWith("line 40 ")).toBe(true);
		expect(tail.every((line) => line.length <= 300)).toBe(true);
	});

	it("reports a failing script as FAIL with the cause first", async () => {
		const harness = createHarness({ failing: ["typecheck"] });
		harness.runner.enqueue(request());
		await harness.runner.idle();

		const [result] = harness.results;
		expect(result?.verdict).toBe("FAIL");
		const report = formatChecksReport(result as ChecksResult);
		expect(report).toContain("## dev-1 Add the thing — checks FAIL");
		expect(report).toContain("typecheck ❌");
		expect(report).toContain("- typecheck failed:");
		expect(report).toContain("Error: boom");
		expect(report).toContain("- Tests: Tests  3 passed");
	});

	it("skips the scripts when the root install fails, and flags network errors as harness problems", async () => {
		const harness = createHarness({ failing: ["npm ci"] });
		harness.runner.enqueue(request());
		await harness.runner.idle();
		expect(harness.results[0]?.steps.map((step) => [step.name, step.ok, step.skipped ?? null])).toEqual([
			["install", false, null],
			["typecheck", false, true],
			["test", false, true],
		]);
	});

	it("a checker error (export failed) is ERROR with harness set, and the queue goes on", async () => {
		const temp = createTempDir("kanban-checks-");
		temps.push(temp);
		const results: ChecksResult[] = [];
		const runner = createChecksRunner({
			readSettings: async () => ({ ...parsePipelineConfig({}).config.pipeline.checks, scratchRoot: temp.path }),
			onResult: async (result) => {
				results.push(result);
			},
			log: () => {},
			exportSnapshot: async (_repo, snapshot) => {
				if (snapshot === "bad") {
					throw new Error("git archive failed");
				}
			},
			runStep: async () => ({ ok: true }),
		});
		runner.enqueue(request({ taskId: "a", snapshot: "bad" }));
		runner.enqueue(request({ taskId: "b", snapshot: "good" }));
		await runner.idle();
		expect(results.map((result) => [result.request.taskId, result.verdict, result.harness])).toEqual([
			["a", "ERROR", true],
			["b", "PASS", false],
		]);
		expect(results[0]?.error).toContain("git archive failed");
	});

	it("close() drops the queue", async () => {
		const harness = createHarness({ holdFirst: true });
		harness.runner.enqueue(request({ taskId: "a" }));
		harness.runner.enqueue(request({ taskId: "b" }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		harness.runner.close();
		harness.hold.resolve();
		await harness.runner.idle();
		expect(harness.results).toEqual([]);
		expect(harness.exported).toEqual(["aaaaaaaa11111111"]);
	});
});

describe("exportSnapshotToDir", () => {
	const cleanups: Array<() => void> = [];
	const previousPath = process.env.PATH;
	afterEach(() => {
		process.env.PATH = previousPath;
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	/** A `git` on PATH that runs `body` (sh) instead of the real git; without `systemPath` it is all there is on PATH. */
	function useFakeGit(body: string, systemPath = true): string {
		const temp = createTempDir("kanban-fake-git-");
		cleanups.push(temp.cleanup);
		const binDir = join(temp.path, "bin");
		mkdirSync(binDir);
		writeFileSync(join(binDir, "git"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		process.env.PATH = systemPath ? `${binDir}:${previousPath}` : binDir;
		return temp.path;
	}

	function outDir(): string {
		const temp = createTempDir("kanban-export-");
		cleanups.push(temp.cleanup);
		return join(temp.path, "out");
	}

	it("exports a commit of the repo's object store", async () => {
		const repo = createRepoWithWorktree();
		cleanups.push(repo.cleanup);
		const dir = outDir();
		await exportSnapshotToDir(repo.repoPath, git(repo.repoPath, ["rev-parse", "HEAD"]), dir);
		expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("hello\n");
	});

	it("waits for git to exit when tar finishes first (foo 27549: 'exit null/0' on every export)", async () => {
		const root = useFakeGit("");
		const source = join(root, "source");
		mkdirSync(source);
		writeFileSync(join(source, "file.txt"), "content\n");
		// Writes the whole archive, closes stdout so tar exits, then takes its time to exit itself.
		useFakeGit(`tar -cf - -C '${source}' .\nexec 1>&-\nsleep 0.3\nexit 0`);
		const dir = outDir();
		await exportSnapshotToDir(root, "ae949cde00000000", dir);
		expect(readFileSync(join(dir, "file.txt"), "utf8")).toBe("content\n");
	});

	it("says which side failed, with git's stderr", async () => {
		const repo = createRepoWithWorktree();
		cleanups.push(repo.cleanup);
		await expect(exportSnapshotToDir(repo.repoPath, "ae949cde00000000", outDir())).rejects.toThrow(
			/^exporting ae949cde failed: git archive exited with 128; tar exited with \d+: fatal: not a valid object name/,
		);
	});

	it("names the signal that killed git", async () => {
		const root = useFakeGit("kill -TERM $$");
		await expect(exportSnapshotToDir(root, "ae949cde00000000", outDir())).rejects.toThrow(
			"exporting ae949cde failed: git archive was killed by SIGTERM",
		);
	});

	it("names the spawn error of a missing tar and doesn't hang on git", async () => {
		const root = useFakeGit("while :; do echo xxxxxxxxxxxxxxxx; done", false);
		await expect(exportSnapshotToDir(root, "ae949cde00000000", outDir())).rejects.toThrow(
			/^exporting ae949cde failed: git archive was killed by SIGKILL; tar could not run \(ENOENT\)/,
		);
	});

	it("stops git when tar fails while git still writes, instead of hanging on the full pipe", async () => {
		const root = useFakeGit("while :; do echo xxxxxxxxxxxxxxxx; done");
		writeFileSync(join(root, "bin", "tar"), '#!/bin/sh\necho "tar: cannot write" >&2\nexit 2\n', { mode: 0o755 });
		await expect(exportSnapshotToDir(root, "ae949cde00000000", outDir())).rejects.toThrow(
			/^exporting ae949cde failed: git archive was killed by SIGKILL; tar exited with 2: tar: cannot write/,
		);
	});
});
