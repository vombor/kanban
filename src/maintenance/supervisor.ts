import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { renameDurably, writeFileSynced } from "../fs/durable-file";

import {
	commitShaSchema,
	type MaintenanceConfig,
	type MaintenanceJob,
	type MaintenanceJournal,
	workerProgressSchema,
	workerResultSchema,
} from "./contracts";
import { activeMaintenanceJob, judgeMaintenanceEvidence, maintenanceTargetHash, observedState } from "./decisions";
import type { MaintenancePorts } from "./ports";
import { buildMaintenancePrompt } from "./prompt";
import type { MaintenanceStore } from "./store";

async function optionalPrivateJson(path: string): Promise<unknown | null> {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024)
			throw new Error("Invalid bounded worker report");
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error("Worker report unreadable; raw content withheld");
	}
}

function transition(
	journal: MaintenanceJournal,
	job: MaintenanceJob,
	now: Date,
	state: MaintenanceJob["state"],
	reason?: string,
) {
	if (job.state === state && job.reason === reason) return;
	job.state = state;
	job.reason = reason;
	job.updatedAt = now.toISOString();
	journal.events.push({ at: job.updatedAt, jobId: job.id, state, reason });
}

export class MaintenanceSupervisor {
	constructor(
		readonly config: MaintenanceConfig,
		readonly store: MaintenanceStore,
		readonly ports: MaintenancePorts,
	) {}

	async daily(day: string): Promise<MaintenanceJournal> {
		if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new Error("Invalid maintenance day");
		return await this.store.transaction(async (journal, save) => {
			const targetHash = maintenanceTargetHash(this.config);
			if (journal.checks.some((check) => check.day === day && check.targetHash === targetHash)) return journal;
			const now = this.ports.now();
			// No competing admission, including an older configuration or an uncertain/blocked queue item.
			if (
				journal.jobs.some(
					(job) =>
						activeMaintenanceJob(job) &&
						(job.repository === this.config.repository || job.sessionId === this.config.sessionId),
				)
			) {
				journal.checks.push({ targetHash, day, at: now.toISOString(), outcome: "held" });
				await save();
				return journal;
			}
			const issues = await this.ports.issues();
			if (issues.length === 0) {
				journal.checks.push({ targetHash, day, at: now.toISOString(), outcome: "no_work" });
				await save();
				return journal;
			}
			if (issues.length > 100 || new Set(issues.map((item) => item.number)).size !== issues.length)
				throw new Error("Issue admission scope invalid or oversized");
			if (journal.jobs.length >= this.config.maxJobs)
				throw new Error("Maintenance retention limit reached; no job or receipt was evicted");
			await this.ports.validateTarget();
			const startingCommit = commitShaSchema.parse(await this.ports.startingCommit());
			const id = `maint-${randomUUID().replaceAll("-", "")}`;
			const job: MaintenanceJob = {
				id,
				targetHash,
				repository: this.config.repository,
				sessionId: this.config.sessionId,
				day,
				startingCommit,
				issues,
				inputId: `msg_${id.replaceAll("-", "_")}`,
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
				state: "prepared",
				commits: [],
				ciUrls: [],
				closedIssues: [],
			};
			journal.jobs.push(job);
			journal.checks.push({ targetHash, day, at: now.toISOString(), outcome: "admitted", jobId: id });
			journal.events.push({ at: job.createdAt, jobId: id, state: "prepared" });
			await save();
			const directory = this.store.paths.jobDirectory(id);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			transition(journal, job, now, "submitting");
			await save(); // The durable no-replay reservation MUST precede POST.
			try {
				await this.ports.submit(job, buildMaintenancePrompt(this.config, job, directory));
				transition(journal, job, this.ports.now(), "queued");
			} catch {
				transition(journal, job, this.ports.now(), "admission_unknown", "inspect_delivery_no_replay");
			}
			await save();
			return journal;
		});
	}

	async reconcile(): Promise<MaintenanceJournal> {
		return await this.store.transaction(async (journal, save) => {
			const targetHash = maintenanceTargetHash(this.config);
			for (const job of journal.jobs.filter(activeMaintenanceJob)) {
				const now = this.ports.now();
				if (job.targetHash !== targetHash) {
					transition(journal, job, now, "blocked", "operator_configuration_changed");
					await save();
					continue;
				}
				if (now.getTime() - Date.parse(job.createdAt) >= this.config.maxJobHours * 3_600_000) {
					transition(journal, job, now, "blocked", "execution_deadline_handoff_required");
					await save();
					continue;
				}
				try {
					const directory = this.store.paths.jobDirectory(job.id);
					const progress = await optionalPrivateJson(join(directory, "progress.json"));
					if (progress !== null) {
						const reported = workerProgressSchema.parse(progress);
						if (reported.jobId !== job.id) throw new Error("Worker progress identity mismatch");
						job.workerStage = reported.stage;
					}
					const body = await optionalPrivateJson(join(directory, "result.json"));
					if (body !== null) {
						const result = workerResultSchema.parse(body);
						const digest = createHash("sha256").update(JSON.stringify(result)).digest("hex");
						if (job.resultDigest && job.resultDigest !== digest) {
							transition(journal, job, now, "blocked", "result_changed_requires_operator_review");
							await save();
							continue;
						}
						const preliminary = judgeMaintenanceEvidence(job, result, { issues: [], commits: [] });
						if (
							["result_identity_mismatch", "result_scope_mismatch", "worker_handoff_required"].includes(
								preliminary.reason ?? "",
							)
						) {
							transition(journal, job, now, preliminary.state, preliminary.reason);
							await save();
							continue;
						}
						job.resultDigest = digest;
						if (job.state !== "verifying")
							transition(journal, job, now, "verifying", "independent_verification_pending");
						await save();
						const verification = await this.ports.verify(job, result);
						const decision = judgeMaintenanceEvidence(job, result, verification);
						if (decision.state === "completed") {
							const receipt = JSON.stringify({
								version: 1,
								jobId: job.id,
								verifiedAt: now.toISOString(),
								verification,
							});
							const verificationDigest = createHash("sha256").update(receipt).digest("hex");
							const temporary = join(directory, `${randomUUID()}.tmp`);
							await writeFileSynced(temporary, receipt, { mode: 0o600, flag: "wx" });
							await renameDurably(temporary, join(directory, `proof-${verificationDigest}.json`));
							job.verificationDigest = verificationDigest;
							job.commits = [
								...new Set(result.issues.flatMap((item) => (item.disposition === "fixed" ? item.commits : []))),
							];
							job.ciUrls = [...new Set(verification.commits.flatMap((item) => item.urls))];
							job.closedIssues = result.issues.map((item) => item.number);
						}
						transition(journal, job, now, decision.state, decision.reason);
					} else {
						if (job.workerStage === "blocked") {
							transition(journal, job, now, "blocked", "worker_handoff_required");
							await save();
							continue;
						}
						const observation = await this.ports.observe(job);
						const decision = observedState(job, observation);
						transition(journal, job, now, decision.state, decision.reason);
					}
				} catch {
					transition(journal, job, now, "blocked", "observation_or_evidence_unavailable");
				}
				await save();
			}
			return journal;
		});
	}
}
