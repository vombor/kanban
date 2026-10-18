import { createHash } from "node:crypto";
import type { ExecutionObservation, MaintenanceConfig, MaintenanceJob, Verification, WorkerResult } from "./contracts";

export function maintenanceTargetHash(config: MaintenanceConfig): string {
	return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function activeMaintenanceJob(job: MaintenanceJob): boolean {
	// Blocked/unknown work retains its admission reservation: an old queued prompt may still execute later.
	return job.state !== "completed";
}

export function observedState(
	job: MaintenanceJob,
	observation: ExecutionObservation,
): { state: MaintenanceJob["state"]; reason?: string } {
	if (observation.queued) return { state: "queued" };
	if (!observation.delivered)
		return { state: job.state === "prepared" ? "prepared" : "admission_unknown", reason: "delivery_unconfirmed" };
	if (!observation.scopedTurn) return { state: "awaiting_evidence", reason: "conversation_mixed_requires_job_result" };
	if (observation.failed) return { state: "blocked", reason: "scoped_execution_failed" };
	if (observation.interrupted) return { state: "blocked", reason: "scoped_execution_interrupted" };
	if (observation.active) return { state: "running" };
	return {
		state: "awaiting_evidence",
		reason: observation.completeTurn ? "turn_finished_result_required" : "execution_receipt_required",
	};
}

export function judgeMaintenanceEvidence(
	job: MaintenanceJob,
	result: WorkerResult,
	verification: Verification,
): { state: MaintenanceJob["state"]; reason?: string } {
	if (result.jobId !== job.id || result.startingCommit !== job.startingCommit)
		return { state: "blocked", reason: "result_identity_mismatch" };
	const requested = job.issues.map((item) => item.number).sort((a, b) => a - b);
	const reported = result.issues.map((item) => item.number).sort((a, b) => a - b);
	if (new Set(reported).size !== reported.length || JSON.stringify(requested) !== JSON.stringify(reported))
		return { state: "blocked", reason: "result_scope_mismatch" };
	if (result.issues.some((item) => item.disposition === "blocked"))
		return { state: "blocked", reason: "worker_handoff_required" };
	for (const issue of result.issues) {
		const proof = verification.issues.find((item) => item.number === issue.number);
		if (!proof || !proof.materialMatches) return { state: "blocked", reason: "issue_evidence_changed" };
		if (!proof.closed || !proof.linkedResolution)
			return { state: "verifying", reason: "linked_issue_closure_required" };
		if (issue.disposition !== "fixed") continue;
		for (const sha of issue.commits) {
			const commit = verification.commits.find((item) => item.sha === sha);
			if (!commit || !commit.pushed || !commit.descendedFromStart || sha === job.startingCommit)
				return { state: "blocked", reason: "commit_provenance_unverified" };
			if (commit.ci === "failed") return { state: "blocked", reason: "required_ci_failed" };
			if (commit.ci !== "passed") return { state: "verifying", reason: "exact_commit_ci_required" };
		}
	}
	if (job.smokeRequired) {
		const smoke = verification.localSmoke;
		if (!smoke) return { state: "verifying", reason: "exact_commit_local_smoke_required" };
		const commit = verification.commits.find((row) => row.sha === smoke.commit);
		if (
			!result.issues.some((issue) => issue.disposition === "fixed" && issue.commits.includes(smoke.commit)) ||
			!commit ||
			!commit.pushed ||
			!commit.descendedFromStart ||
			commit.ci !== "passed"
		)
			return { state: "blocked", reason: "local_smoke_source_unverified" };
	}
	return { state: "completed" };
}
