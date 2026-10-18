import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	type ExecutionObservation,
	type MaintenanceJob,
	maintenanceConfigSchema,
	type Verification,
	type WorkerResult,
} from "../../../src/maintenance/contracts";
import { maintenanceReport } from "../../../src/maintenance/report";
import { MaintenanceStore } from "../../../src/maintenance/store";
import { MaintenanceSupervisor } from "../../../src/maintenance/supervisor";

const start = "a".repeat(40);
const commit = "b".repeat(40);
const issue = { number: 7, materialHash: "c".repeat(64), comments: [{ id: "42", hash: "d".repeat(64) }] };
const config = maintenanceConfigSchema.parse({
	version: 1,
	repository: "example/project",
	projectDirectory: "/fixture",
	branch: "main",
	sessionId: "ses_fixture",
	opencodeCli: "/fixture/opencode",
	githubBridge: { executable: "/fixture/bridge", args: [] },
	timezone: "UTC",
	requiredWorkflows: ["checks.yml"],
});
const observed: ExecutionObservation = {
	queued: false,
	delivered: true,
	scopedTurn: true,
	active: true,
	failed: false,
	interrupted: false,
	completeTurn: false,
};
const proof: Verification = {
	issues: [{ number: 7, closed: true, materialMatches: true, linkedResolution: true }],
	commits: [
		{
			sha: commit,
			pushed: true,
			descendedFromStart: true,
			ci: "passed",
			urls: ["https://github.com/example/project/actions/runs/123"],
		},
	],
};

function first<T>(items: T[]): T {
	const value = items[0];
	if (!value) throw new Error("Missing fixture item");
	return value;
}

async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "maintenance-test-"));
	const store = new MaintenanceStore(home);
	const ports = {
		now: vi.fn(() => new Date("2026-10-17T10:00:00Z")),
		startingCommit: vi.fn(async () => start),
		issues: vi.fn(async () => [issue]),
		validateTarget: vi.fn(async () => {}),
		submit: vi.fn(async (_job: MaintenanceJob, _text: string) => {}),
		observe: vi.fn(async () => observed),
		verify: vi.fn(async () => proof),
	};
	return { home, store, ports, supervisor: new MaintenanceSupervisor(config, store, ports) };
}

async function writeResult(store: MaintenanceStore, job: MaintenanceJob, overrides: Partial<WorkerResult> = {}) {
	const result: WorkerResult = {
		version: 1,
		jobId: job.id,
		startingCommit: start,
		issues: [{ number: 7, disposition: "fixed", commits: [commit] }],
		...overrides,
	};
	await writeFile(join(store.paths.jobDirectory(job.id), "result.json"), JSON.stringify(result), { mode: 0o600 });
}

describe("supervised host maintenance", () => {
	it("records no work without waking or even opening a session", async () => {
		const f = await fixture();
		f.ports.issues.mockResolvedValue([]);
		const journal = await f.supervisor.daily("2026-10-17");
		expect(journal.checks[0]?.outcome).toBe("no_work");
		expect(journal.jobs).toHaveLength(0);
		expect(f.ports.submit).not.toHaveBeenCalled();
		expect(f.ports.validateTarget).not.toHaveBeenCalled();
	});
	it("persists a private no-replay reservation BEFORE the admission mutation", async () => {
		const f = await fixture();
		f.ports.submit.mockImplementation(async (job) => {
			expect((await f.store.read()).jobs[0]?.state).toBe("submitting");
			expect(job.startingCommit).toBe(start);
		});
		await f.supervisor.daily("2026-10-17");
		expect((await stat(f.store.paths.journal)).mode & 0o777).toBe(0o600);
		expect((await f.store.read()).jobs[0]?.state).toBe("queued");
	});
	it("does not repeat a prompt after an uncertain timeout, restart or next-day check", async () => {
		const f = await fixture();
		f.ports.submit.mockRejectedValue(new Error("secret-provider-body"));
		await f.supervisor.daily("2026-10-17");
		expect((await f.store.read()).jobs[0]?.state).toBe("admission_unknown");
		const restarted = new MaintenanceSupervisor(config, new MaintenanceStore(f.home), f.ports);
		await restarted.daily("2026-10-17");
		await restarted.daily("2026-10-18");
		expect(f.ports.submit).toHaveBeenCalledTimes(1);
		expect(await readFile(f.store.paths.journal, "utf8")).not.toContain("secret-provider-body");
	});
	it("reconciles an admission timeout whose exact input later appears in the inbox", async () => {
		const f = await fixture();
		f.ports.submit.mockRejectedValue(new Error("timeout"));
		await f.supervisor.daily("2026-10-17");
		f.ports.observe.mockResolvedValue({ ...observed, queued: true, delivered: false });
		expect((await f.supervisor.reconcile()).jobs[0]?.state).toBe("queued");
		expect(f.ports.submit).toHaveBeenCalledTimes(1);
	});
	it("refuses a second concurrent checker instead of overlapping admission", async () => {
		const f = await fixture();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.ports.submit.mockImplementation(async () => await gate);
		const first = f.supervisor.daily("2026-10-17");
		await vi.waitFor(() => expect(f.ports.submit).toHaveBeenCalledTimes(1));
		await expect(
			new MaintenanceSupervisor(config, new MaintenanceStore(f.home), f.ports).daily("2026-10-17"),
		).rejects.toThrow();
		release?.();
		await first;
		expect(f.ports.submit).toHaveBeenCalledTimes(1);
	});
	it("does not complete from a finished assistant or unrelated running turn", async () => {
		const f = await fixture();
		await f.supervisor.daily("2026-10-17");
		f.ports.observe.mockResolvedValue({ ...observed, active: false, completeTurn: true });
		expect((await f.supervisor.reconcile()).jobs[0]?.state).toBe("awaiting_evidence");
		f.ports.observe.mockResolvedValue({ ...observed, scopedTurn: false, completeTurn: true, failed: true });
		expect((await f.supervisor.reconcile()).jobs[0]?.reason).toBe("conversation_mixed_requires_job_result");
		expect(f.ports.verify).not.toHaveBeenCalled();
	});
	it("marks a scoped failure as blocked but retains its admission reservation", async () => {
		const f = await fixture();
		await f.supervisor.daily("2026-10-17");
		f.ports.observe.mockResolvedValue({ ...observed, failed: true });
		expect((await f.supervisor.reconcile()).jobs[0]?.reason).toBe("scoped_execution_failed");
		await f.supervisor.daily("2026-10-18");
		expect(f.ports.submit).toHaveBeenCalledTimes(1);
	});
	it("independently verifies explicit job result and exact commit CI before completion", async () => {
		const f = await fixture();
		const job = (await f.supervisor.daily("2026-10-17")).jobs[0];
		if (!job) throw new Error("No job");
		await writeResult(f.store, job);
		const journal = await f.supervisor.reconcile();
		expect(journal.jobs[0]?.state).toBe("completed");
		expect(journal.jobs[0]?.commits).toEqual([commit]);
		expect(f.ports.verify).toHaveBeenCalledOnce();
		expect(maintenanceReport(journal)).toContain("verified 1 commit(s)");
		await f.supervisor.reconcile();
		expect(f.ports.verify).toHaveBeenCalledOnce();
	});
	it.each([
		[
			"changed issue",
			{ ...proof, issues: [{ ...first(proof.issues), materialMatches: false }] },
			"issue_evidence_changed",
		],
		["CI failure", { ...proof, commits: [{ ...first(proof.commits), ci: "failed" as const }] }, "required_ci_failed"],
		[
			"unpushed commit",
			{ ...proof, commits: [{ ...first(proof.commits), pushed: false }] },
			"commit_provenance_unverified",
		],
		[
			"wrong ancestry",
			{ ...proof, commits: [{ ...first(proof.commits), descendedFromStart: false }] },
			"commit_provenance_unverified",
		],
	])("holds %s evidence", async (_label, evidence, reason) => {
		const f = await fixture();
		const job = first((await f.supervisor.daily("2026-10-17")).jobs);
		await writeResult(f.store, job);
		f.ports.verify.mockResolvedValue(evidence);
		expect((await f.supervisor.reconcile()).jobs[0]?.reason).toBe(reason);
	});
	it("waits for CI without spending another agent turn", async () => {
		const f = await fixture();
		const job = first((await f.supervisor.daily("2026-10-17")).jobs);
		await writeResult(f.store, job);
		f.ports.verify.mockResolvedValue({ ...proof, commits: [{ ...first(proof.commits), ci: "pending" }] });
		expect((await f.supervisor.reconcile()).jobs[0]?.state).toBe("verifying");
		f.ports.verify.mockResolvedValue(proof);
		expect((await f.supervisor.reconcile()).jobs[0]?.state).toBe("completed");
		expect(f.ports.submit).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ startingCommit: "e".repeat(40) },
		{ issues: [{ number: 8, disposition: "fixed" as const, commits: [commit] }] },
		{ issues: [{ number: 7, disposition: "blocked" as const, reason: "acceptance" as const }] },
	])("does not verify a stale/out-of-scope/blocked worker result", async (result) => {
		const f = await fixture();
		const job = first((await f.supervisor.daily("2026-10-17")).jobs);
		await writeResult(f.store, job, result);
		expect((await f.supervisor.reconcile()).jobs[0]?.state).toBe("blocked");
		expect(f.ports.verify).not.toHaveBeenCalled();
	});
	it("pins a result once verification begins instead of silently accepting replacement evidence", async () => {
		const f = await fixture();
		const job = first((await f.supervisor.daily("2026-10-17")).jobs);
		await writeResult(f.store, job);
		f.ports.verify.mockRejectedValue(new Error("secret upstream error"));
		await f.supervisor.reconcile();
		await writeResult(f.store, job, { issues: [{ number: 7, disposition: "fixed", commits: ["e".repeat(40)] }] });
		expect((await f.supervisor.reconcile()).jobs[0]?.reason).toBe("result_changed_requires_operator_review");
		expect(f.ports.verify).toHaveBeenCalledTimes(1);
	});
	it("does not renew its deadline on a restart or retry reads forever", async () => {
		const f = await fixture();
		await f.supervisor.daily("2026-10-17");
		f.ports.now.mockReturnValue(new Date("2026-10-19T10:00:00Z"));
		expect((await f.supervisor.reconcile()).jobs[0]?.reason).toBe("execution_deadline_handoff_required");
		expect(f.ports.observe).not.toHaveBeenCalled();
	});
	it("configuration changes preserve the old reservation and require review", async () => {
		const f = await fixture();
		await f.supervisor.daily("2026-10-17");
		const changed = new MaintenanceSupervisor({ ...config, branch: "other" }, f.store, f.ports);
		expect((await changed.reconcile()).jobs[0]?.reason).toBe("operator_configuration_changed");
		expect((await f.store.read()).jobs[0]?.reason).toBe("operator_configuration_changed");
		await changed.daily("2026-10-18");
		expect(f.ports.submit).toHaveBeenCalledTimes(1);
	});
	it("refuses corrupt journals without resetting history or admitting work", async () => {
		const f = await fixture();
		await f.supervisor.daily("2026-10-17");
		await writeFile(f.store.paths.journal, "");
		await expect(f.supervisor.daily("2026-10-18")).rejects.toThrow("never reset");
		expect(f.ports.submit).toHaveBeenCalledTimes(1);
		expect(await readFile(f.store.paths.journal, "utf8")).toBe("");
	});
	it("refuses a symlinked result and never copies raw errors into reports", async () => {
		const f = await fixture();
		const job = first((await f.supervisor.daily("2026-10-17")).jobs);
		const outside = join(f.home, "untrusted.json");
		await writeFile(outside, '{"secret":"do-not-log"}');
		await symlink(outside, join(f.store.paths.jobDirectory(job.id), "result.json"));
		expect((await f.supervisor.reconcile()).jobs[0]?.state).toBe("blocked");
		expect(await readFile(f.store.paths.journal, "utf8")).not.toContain("do-not-log");
	});
});
