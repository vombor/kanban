import type { ObjectiveAdmissionDecision, ObjectiveControl, ObjectiveReservation } from "../core/objective-admission";
import type { RuntimeObjective } from "../core/objective-contract";
import { objectiveDigest } from "./objective-identity";

export function objectiveOverride(
	objective: RuntimeObjective,
	taskId: string,
	kind: ObjectiveReservation["kind"],
): ObjectiveControl | undefined {
	return objective.controls.find(
		(row) =>
			row.action === "override" &&
			row.usedBy === null &&
			row.revokedBy === null &&
			row.taskId === taskId &&
			row.kind === kind &&
			row.requirementsHash === objective.requirementsHash &&
			row.limitsHash === objectiveDigest(JSON.stringify(objective.limits)),
	);
}
export function decideObjectiveAdmission(
	objective: RuntimeObjective,
	taskId: string,
	kind: ObjectiveReservation["kind"],
	at: number,
	available: boolean,
): ObjectiveAdmissionDecision {
	const refuse = (reason: ObjectiveAdmissionDecision["reason"]): ObjectiveAdmissionDecision => ({
		bound: true,
		allowed: false,
		reason,
	});
	if (objective.pausedByUser) return refuse("user_paused");
	if (objective.limits.mode === "report") return { bound: true, allowed: true, reason: null };
	if (!available) return refuse("enforcement_unavailable");
	const unresolved = objective.reservations.some(
		(row) =>
			(row.state === "uncertain" || row.state === "reserved") &&
			!objective.controls.some((control) => control.action === "acknowledge" && control.reservationId === row.id),
	);
	if (unresolved) return refuse("delivery_uncertain");
	const reasons = describeObjectiveAdmission(objective, at).filter(
		(reason) => reason !== "cost_unknown" || objective.limits.unknownCost === "hold",
	);
	if (reasons.length && !objectiveOverride(objective, taskId, kind)) return refuse(reasons[0] ?? null);
	return { bound: true, allowed: true, reason: null };
}

export function describeObjectiveAdmission(objective: RuntimeObjective, at: number): ObjectiveReservation["report"] {
	const report: ObjectiveReservation["report"] = [];
	const pending = objective.reservations.filter((row) => row.state !== "released");
	const matchedStarts = new Set(
		pending.flatMap((row) => (row.startedAt === null ? [] : [`${row.taskId}:${row.startedAt}`])),
	);
	const attempts =
		pending.length +
		objective.attempts.filter((row) => !matchedStarts.has(`${row.taskId}:${Date.parse(row.startedAt)}`)).length;
	if (objective.limits.maxAttempts !== null && attempts >= objective.limits.maxAttempts) report.push("attempt_limit");
	if (
		objective.limits.maxElapsedMinutes !== null &&
		at - Date.parse(objective.createdAt) >= objective.limits.maxElapsedMinutes * 60_000
	)
		report.push("time_limit");
	if (objective.limits.maxEstimatedUsd !== null) {
		if (objective.observedEstimatedUsd !== null && objective.observedEstimatedUsd >= objective.limits.maxEstimatedUsd)
			report.push("cost_limit");
		if (objective.costCoverage !== "complete" || objective.estimatedUsd === null) report.push("cost_unknown");
	}
	return report;
}
