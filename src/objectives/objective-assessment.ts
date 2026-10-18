import type { RuntimeObjective } from "../core/objective-contract";
import type { ObjectiveEvidence } from "../core/objective-evidence";
import { createObjectiveTaskLineage } from "../core/objective-task-lineage";
import { objectiveDigest } from "./objective-identity";

export type ObjectiveAssessment = Pick<RuntimeObjective, "status" | "handoff" | "finalCommits">;
export function assessObjective(objective: RuntimeObjective, now: string): ObjectiveAssessment {
	const hold = (
		code: NonNullable<RuntimeObjective["handoff"]>["code"],
		owner: NonNullable<RuntimeObjective["handoff"]>["owner"],
		action: NonNullable<RuntimeObjective["handoff"]>["action"],
		taskId: string | null,
	): ObjectiveAssessment => ({
		status: "held",
		finalCommits: [],
		handoff: {
			code,
			owner,
			action,
			taskId,
			since: objective.handoff?.code === code && objective.handoff.taskId === taskId ? objective.handoff.since : now,
		},
	});
	if (objective.pausedByUser) return hold("user_paused", "user", "resume", null);
	const policyHash = objectiveDigest(JSON.stringify(objective.policy));
	const current = (evidence: ObjectiveEvidence) =>
		evidence.binding.objectiveId === objective.id &&
		evidence.binding.requirementsHash === objective.requirementsHash &&
		evidence.binding.policyHash === policyHash;
	const latest = (taskIds: string | readonly string[], kind: ObjectiveEvidence["kind"], snapshot?: string) => {
		const ids = new Set(typeof taskIds === "string" ? [taskIds] : taskIds);
		const candidates = objective.evidence
			.filter((e) => ids.has(e.taskId) && e.kind === kind && current(e) && (!snapshot || e.snapshot === snapshot))
			.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
		const newest = candidates[0];
		if (!newest) return null;
		const fact = (evidence: ObjectiveEvidence) =>
			JSON.stringify([
				evidence.taskId,
				evidence.snapshot,
				evidence.kind === "qa"
					? evidence.verdict
					: evidence.kind === "checks"
						? evidence.scripts
						: [evidence.commit, evidence.baseRef],
			]);
		// Conflicting receipts at one clock tick have no proven ordering. Array insertion order is not acceptance.
		if (
			candidates.some(
				(evidence) => Date.parse(evidence.at) === Date.parse(newest.at) && fact(evidence) !== fact(newest),
			)
		)
			return null;
		return newest;
	};
	const commits: string[] = [];
	const lineage = createObjectiveTaskLineage(objective.tasks);
	for (const task of objective.tasks.filter((task) => task.kind === "dev")) {
		const family = lineage.workFor(task.taskId);
		const members = new Set(family);
		const land = latest(family, "landed");
		if (
			!land &&
			objective.evidence.some(
				(evidence) => members.has(evidence.taskId) && evidence.kind === "landed" && current(evidence),
			)
		)
			return hold("evidence_stale", "supervision", "wait_for_evidence", task.taskId);
		if (
			land &&
			objective.attempts.some(
				(attempt) =>
					members.has(attempt.taskId) &&
					attempt.requirementsHash === objective.requirementsHash &&
					(attempt.state === "running" || Date.parse(attempt.startedAt) >= Date.parse(land.at)),
			)
		)
			return hold("evidence_stale", "supervision", "wait_for_evidence", task.taskId);
		if (
			land &&
			objective.tasks.some(
				(member) => members.has(member.taskId) && Date.parse(member.attachedAt) > Date.parse(land.at),
			)
		)
			return hold("evidence_stale", "supervision", "wait_for_evidence", task.taskId);
		if (
			land &&
			objective.evidence.some(
				(evidence) =>
					evidence.taskId === land.taskId &&
					current(evidence) &&
					evidence.snapshot !== land.snapshot &&
					Date.parse(evidence.at) >= Date.parse(land.at),
			)
		)
			return hold("evidence_stale", "supervision", "wait_for_evidence", task.taskId);
		if (!land || land.kind !== "landed") {
			const active = objective.attempts.some(
				(attempt) => members.has(attempt.taskId) && attempt.state === "running",
			);
			const candidate =
				objective.tasks
					.filter((member) => members.has(member.taskId))
					.sort((a, b) => Date.parse(b.attachedAt) - Date.parse(a.attachedAt))[0]?.taskId ?? task.taskId;
			if (!active && objective.attempts.filter((attempt) => attempt.taskId === candidate).at(-1)?.executionBlocked)
				return hold("execution_blocked", "user", "inspect_execution", candidate);
			const recentChecks = latest(candidate, "checks");
			if (
				recentChecks?.kind === "checks" &&
				recentChecks.scripts.some(
					(script) =>
						objective.policy.requiredChecks.includes(script.name) && script.status === "fail" && !script.harness,
				)
			)
				if (!active) return hold("checks_failed", "checks", "inspect_checks", candidate);
			const recentQa = latest(candidate, "qa");
			if (!active && recentQa?.kind === "qa" && recentQa.verdict !== "PASS")
				return hold(recentQa.verdict === "STALLED" ? "qa_stalled" : "qa_failed", "qa", "inspect_qa", candidate);
			if (
				!active &&
				objective.attempts.some(
					(attempt) =>
						attempt.taskId === candidate && (attempt.state === "interrupted" || attempt.state === "unknown"),
				)
			)
				return hold("delivery_uncertain", "recovery", "confirm_delivery", candidate);
			return {
				status: active ? "running" : "awaiting_evidence",
				finalCommits: [],
				handoff: {
					code: "landing_missing",
					owner: "landing",
					action: active ? "wait_for_evidence" : "resolve_landing",
					taskId: candidate,
					since: objective.handoff?.code === "landing_missing" ? objective.handoff.since : now,
				},
			};
		}
		const checks = latest(land.taskId, "checks", land.snapshot);
		if (!checks || checks.kind !== "checks")
			return hold("evidence_missing", "checks", "wait_for_evidence", task.taskId);
		for (const script of objective.policy.requiredChecks) {
			const result = checks.scripts.find((step) => step.name === script && !step.harness);
			if (!result || result.status === "unknown")
				return hold("evidence_missing", "checks", "wait_for_evidence", task.taskId);
			if (result.status === "fail") return hold("checks_failed", "checks", "inspect_checks", task.taskId);
		}
		if (objective.policy.requireQa) {
			const qa = latest(land.taskId, "qa", land.snapshot);
			if (!qa || qa.kind !== "qa") return hold("evidence_missing", "qa", "wait_for_evidence", task.taskId);
			if (qa.verdict !== "PASS")
				return hold(qa.verdict === "STALLED" ? "qa_stalled" : "qa_failed", "qa", "inspect_qa", task.taskId);
		}
		commits.push(land.commit);
	}
	if (!commits.length) return hold("evidence_missing", "supervision", "wait_for_evidence", null);
	return { status: "completed", handoff: null, finalCommits: [...new Set(commits)] };
}
