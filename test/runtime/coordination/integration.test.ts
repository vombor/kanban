import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { buildCoordinationReport } from "../../../src/coordination/report";
import { buildIntegrationCandidate } from "../../../src/integration/candidate";
import { IntegrationChecksUnavailableError } from "../../../src/integration/checks-admission";
import { createIntegrationApi } from "../../../src/integration/integration-api";
import { createIntegrationReportStore } from "../../../src/integration/report-store";
import type { ChecksRequest, ChecksResult } from "../../../src/pipeline/checks";
import { prepareChecksProjectEnv, readChecksEnvFingerprint } from "../../../src/pipeline/checks-project-env";
import { getIntegrationReportPaths } from "../../../src/state/kanban-home";
import type { CoordinationTask } from "../../../src/trpc/coordination-contract";
import { integrationManifestSchema, integrationRunSchema } from "../../../src/trpc/integration-contract";
import { createGitTestEnv } from "../../utilities/git-env";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

async function fixture(homePath: string, conflict = false) {
	const repo = join(homePath, "repo");
	await mkdir(repo, { recursive: true });
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: repo,
			env: createGitTestEnv(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	git("init", "-b", "main");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.invalid");
	await writeFile(join(repo, "a.txt"), "base a\n");
	await writeFile(join(repo, "b.txt"), "base b\n");
	await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }));
	git("add", ".");
	git("commit", "-m", "base");
	const base = git("rev-parse", "HEAD");
	git("checkout", "-b", "dev1");
	await writeFile(join(repo, "a.txt"), "first\n");
	git("add", ".");
	git("commit", "-m", "first");
	const first = git("rev-parse", "HEAD");
	git("checkout", "-b", "dev2", base);
	await writeFile(join(repo, conflict ? "a.txt" : "b.txt"), "second\n");
	git("add", ".");
	git("commit", "-m", "second");
	const second = git("rev-parse", "HEAD");
	git("checkout", "main");
	const tasks: CoordinationTask[] = [first, second].map((snapshot, index) => ({
		id: `dev${index + 1}`,
		taskId: `dev${index + 1}`,
		title: "Fixture",
		state: "review",
		prerequisites: null,
		readiness: "not_backlog",
		ownerStates: [],
		reviewSettled: true,
		model: null,
		capacityHold: null,
		otherProjectHolders: 0,
		hints: null,
		snapshot,
		baseCommit: base,
		observedPaths: [],
		pathsTruncated: false,
	}));
	let report = buildCoordinationReport({
		tasks,
		dependencies: [],
		planTaskId: null,
		approvedBundle: null,
		now: 1000,
		truncated: false,
		warnings: [],
		capacity: {},
		concurrency: {},
	});
	const settings = parsePipelineConfig({ pipeline: { checks: { scratchRoot: join(homePath, "checks") } } }).config
		.pipeline.checks;
	let enabled = true;
	const checks = vi.fn(
		async (request: ChecksRequest): Promise<ChecksResult> => ({
			request,
			verdict: "PASS",
			harness: false,
			steps: [
				{ name: "install", ok: true },
				{ name: "test", ok: true },
			],
			logsDir: "/private/never-return",
			startedAt: 1000,
			finishedAt: 2000,
			timeoutMin: 1,
			error: null,
		}),
	);
	const preview = vi.fn(async () => report);
	const service = createIntegrationApi({
		homePath,
		coordination: { preview },
		contexts: { read: async () => null },
		setup: async () => ({
			repoPath: repo,
			settings,
			scripts: ["test"],
			project: undefined,
			checksEnabled: enabled,
			alternateWorker: false,
			paused: false,
		}),
		checks,
		toolchain: () => "a".repeat(64),
		now: () => 2000,
	});
	return {
		repo,
		git,
		service,
		checks,
		preview,
		setReport: (value: typeof report) => {
			report = value;
		},
		getReport: () => report,
		disable: () => {
			enabled = false;
		},
	};
}
describe("exact candidate integration reports", () => {
	it("refuses retention overflow without evicting reports or executing another candidate", async () =>
		withTemporaryKanbanHome(async ({ homePath }) => {
			const f = await fixture(homePath),
				manifest = await f.service.api.preview({ kind: "user" }, "own", { taskIds: ["dev1", "dev2"] }),
				id = randomUUID();
			await f.service.api.run({ kind: "user" }, "own", {
				taskIds: ["dev1", "dev2"],
				requestId: id,
				fingerprint: manifest.fingerprint,
			});
			await f.service.idle();
			const report = await f.service.api.read({ kind: "user" }, "own", { id }),
				store = createIntegrationReportStore(homePath);
			await store.update("own", () => Array.from({ length: 100 }, () => ({ ...report, id: randomUUID() })));
			const path = getIntegrationReportPaths("own", homePath).manifest,
				before = await readFile(path, "utf8");
			await expect(
				f.service.api.run({ kind: "user" }, "own", {
					taskIds: ["dev1", "dev2"],
					requestId: randomUUID(),
					fingerprint: manifest.fingerprint,
				}),
			).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
			expect(await readFile(path, "utf8")).toBe(before);
			expect(f.checks).toHaveBeenCalledTimes(1);
		}));
	it("refuses a changed pinned checks environment before copying it or exposing values", async () =>
		withTemporaryKanbanHome(async ({ homePath }) => {
			await mkdir(homePath, { recursive: true });
			const path = join(homePath, ".env");
			await writeFile(path, "DATABASE_URL=postgres://user:owned-sensitive-password@localhost/fixture\n");
			const fingerprint = await readChecksEnvFingerprint(homePath, ".env");
			await writeFile(path, "DATABASE_URL=postgres://user:changed-sensitive-password@localhost/fixture\n");
			const exportDir = join(homePath, "export");
			await mkdir(exportDir);
			await expect(
				prepareChecksProjectEnv({
					facts: { envFile: ".env", databaseUrlVar: "DATABASE_URL" },
					worktreePath: homePath,
					exportDir,
					workspaceId: "integration",
					taskId: "owned",
					excludedNames: [],
					expectedEnvFingerprint: fingerprint,
				}),
			).rejects.toThrow("environment changed");
			await expect(access(join(exportDir, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
		}));
	it("distinguishes a proven pre-submission refusal from an uncertain execution", async () =>
		withTemporaryKanbanHome(async ({ homePath }) => {
			const f = await fixture(homePath),
				manifest = await f.service.api.preview({ kind: "user" }, "own", { taskIds: ["dev1", "dev2"] }),
				id = randomUUID();
			f.checks.mockRejectedValueOnce(new IntegrationChecksUnavailableError());
			await f.service.api.run({ kind: "user" }, "own", {
				taskIds: ["dev1", "dev2"],
				requestId: id,
				fingerprint: manifest.fingerprint,
			});
			await f.service.idle();
			expect(await f.service.api.read({ kind: "user" }, "own", { id })).toMatchObject({
				status: "unavailable",
				cleanup: "complete",
			});
		}));
	it("keeps preview read-only, deterministic candidates disposable, and execution exactly once without writing QA/board/branch state", async () =>
		withTemporaryKanbanHome(async ({ homePath }) => {
			const f = await fixture(homePath),
				before = {
					head: f.git("rev-parse", "HEAD"),
					refs: f.git("show-ref"),
					index: await readFile(join(f.repo, ".git/index")),
				};
			const manifest = await f.service.api.preview({ kind: "user" }, "own", { taskIds: ["dev2", "dev1"] });
			await expect(access(getIntegrationReportPaths("own", homePath).root)).rejects.toMatchObject({
				code: "ENOENT",
			});
			const candidate1 = await buildIntegrationCandidate(f.repo, join(homePath, "candidate1"), manifest),
				candidate2 = await buildIntegrationCandidate(f.repo, join(homePath, "candidate2"), manifest);
			expect(candidate1).toEqual(candidate2);
			expect(candidate1.conflictTaskId).toBeNull();
			const request = { taskIds: ["dev1", "dev2"], fingerprint: manifest.fingerprint, requestId: randomUUID() };
			await Promise.all([
				f.service.api.run({ kind: "user" }, "own", request),
				f.service.api.run({ kind: "user" }, "own", request),
			]);
			await f.service.idle();
			const result = await f.service.api.read({ kind: "user" }, "own", { id: request.requestId });
			expect(result).toMatchObject({
				status: "checks_passed",
				freshness: "current",
				cleanup: "complete",
				authority: "speculative_report_not_qa_or_landing_approval",
			});
			expect(f.checks).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(result)).not.toContain("/private/never-return");
			await f.service.api.run({ kind: "user" }, "own", request);
			expect(f.checks).toHaveBeenCalledTimes(1);
			expect({
				head: f.git("rev-parse", "HEAD"),
				refs: f.git("show-ref"),
				index: await readFile(join(f.repo, ".git/index")),
			}).toEqual(before);
			await expect(
				access(join(getIntegrationReportPaths("own", homePath).candidates, request.requestId)),
			).rejects.toMatchObject({ code: "ENOENT" });
		}));
	it("reports merge conflicts without inventing a resolution or running checks", async () =>
		withTemporaryKanbanHome(async ({ homePath }) => {
			const f = await fixture(homePath, true),
				manifest = await f.service.api.preview({ kind: "user" }, "own", { taskIds: ["dev1", "dev2"] }),
				id = randomUUID();
			await f.service.api.run({ kind: "user" }, "own", {
				taskIds: ["dev1", "dev2"],
				fingerprint: manifest.fingerprint,
				requestId: id,
			});
			await f.service.idle();
			expect(await f.service.api.read({ kind: "user" }, "own", { id })).toMatchObject({
				status: "conflicts",
				conflictTaskId: "dev2",
				candidateCommit: null,
				cleanup: "complete",
			});
			expect(f.checks).not.toHaveBeenCalled();
		}));
	it("invalidates results when base/snapshot/context/config evidence changes and never reruns for a read", async () =>
		withTemporaryKanbanHome(async ({ homePath }) => {
			const f = await fixture(homePath),
				manifest = await f.service.api.preview({ kind: "user" }, "own", { taskIds: ["dev1", "dev2"] }),
				id = randomUUID();
			f.disable();
			await expect(
				f.service.api.run({ kind: "user" }, "own", {
					taskIds: ["dev1", "dev2"],
					requestId: id,
					fingerprint: manifest.fingerprint,
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(f.checks).not.toHaveBeenCalled();
			const updated = await f.service.api.preview({ kind: "user" }, "own", { taskIds: ["dev1", "dev2"] });
			await f.service.api.run({ kind: "user" }, "own", {
				taskIds: ["dev1", "dev2"],
				requestId: id,
				fingerprint: updated.fingerprint,
			});
			await f.service.idle();
			expect(await f.service.api.read({ kind: "user" }, "own", { id })).toMatchObject({
				status: "unavailable",
				freshness: "current",
			});
			f.setReport({ ...f.getReport(), fingerprint: "b".repeat(64) });
			expect(await f.service.api.read({ kind: "user" }, "own", { id })).toMatchObject({ freshness: "stale" });
			expect(f.checks).not.toHaveBeenCalled();
		}));
	it("retains uncertain execution and refuses replay, preserves damaged journals and authorizes before sources", async () =>
		withTemporaryKanbanHome(async ({ homePath }) => {
			const f = await fixture(homePath),
				other = {
					kind: "session" as const,
					via: "credential" as const,
					session: {
						workspaceId: "elsewhere",
						role: "card" as const,
						taskId: "dev",
						agentId: "claude" as const,
						cwd: "/other",
					},
				};
			await expect(f.service.api.preview(other, "own", { taskIds: ["dev1", "dev2"] })).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(f.preview).not.toHaveBeenCalled();
			await expect(
				f.service.api.run({ ...other, session: { ...other.session, workspaceId: "own" } }, "own", {
					taskIds: ["dev1", "dev2"],
					requestId: randomUUID(),
					fingerprint: "a".repeat(64),
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			const manifest = await f.service.api.preview({ kind: "user" }, "own", { taskIds: ["dev1", "dev2"] }),
				id = randomUUID();
			f.checks.mockRejectedValueOnce(new Error("secret-bearing fake uncertainty"));
			await f.service.api.run({ kind: "user" }, "own", {
				taskIds: ["dev1", "dev2"],
				fingerprint: manifest.fingerprint,
				requestId: id,
			});
			await f.service.idle();
			const report = await f.service.api.read({ kind: "user" }, "own", { id });
			expect(report).toMatchObject({ status: "uncertain", cleanup: "retained_uncertain" });
			expect(JSON.stringify(report)).not.toContain("secret-bearing");
			await f.service.api.run({ kind: "user" }, "own", {
				taskIds: ["dev1", "dev2"],
				fingerprint: manifest.fingerprint,
				requestId: id,
			});
			expect(f.checks).toHaveBeenCalledTimes(1);
			await expect(
				f.service.api.run({ kind: "user" }, "own", {
					taskIds: ["dev1", "dev2"],
					fingerprint: manifest.fingerprint,
					requestId: randomUUID(),
				}),
			).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
			const path = getIntegrationReportPaths("own", homePath).manifest;
			await writeFile(path, "damaged");
			await expect(f.service.api.list({ kind: "user" }, "own", { offset: 0 })).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
			});
			expect(await readFile(path, "utf8")).toBe("damaged");
		}));
	it("refuses duplicate selection and missing/unsafe exact identities", () => {
		expect(
			integrationRunSchema.safeParse({
				taskIds: ["dev1", "dev1"],
				requestId: randomUUID(),
				fingerprint: "a".repeat(64),
			}).success,
		).toBe(false);
		expect(integrationManifestSchema.safeParse({}).success).toBe(false);
	});
});
