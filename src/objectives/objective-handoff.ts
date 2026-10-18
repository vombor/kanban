import type { ObjectiveReadResponse, RuntimeObjective } from "../core/objective-contract";

/** Scoped guidance, not execution approval or another wake/ATTENTION writer. Commands are argv, never shell text. */
export function describeObjectiveHandoff(
	objective: RuntimeObjective,
	workspaceId: string,
): ObjectiveReadResponse["handoffGuide"] {
	const handoff = objective.handoff;
	if (!handoff) return null;
	const explanations: Record<NonNullable<RuntimeObjective["handoff"]>["code"], string> = {
		evidence_missing:
			"Required owner evidence is missing or incomplete. Wait for its existing owner, inspect the task, or recheck retained receipts. Recheck does not rerun checks, QA or model turns.",
		evidence_stale:
			"The pinned snapshot/attempt no longer agrees with the recorded landing, or receipt ordering is ambiguous. Inspect the current work and existing owners; old PASS evidence cannot approve a different snapshot.",
		checks_failed:
			"A required project check failed. Inspect the checks/QA report through the existing task workflow. Do not clear the failure by claiming completion or silently excluding the required script.",
		qa_failed:
			"The existing QA owner recorded FAIL. Inspect its report and the ordinary rework workflow; this control cannot change its verdict or model assignment.",
		qa_stalled:
			"QA is STALLED, not accepted implementation. Inspect the retained report and resolve its harness/user prerequisite without inventing PASS or reopening a closed benchmark.",
		landing_missing:
			"No qualified final landing receipt exists for this root or its explicit replacement. Review the existing task/landing workflow. A Done column or final reply alone is not completion.",
		attempt_limit:
			"The objective's attempt threshold was reached. Review retained lineage and user-owned admission limits. Report mode is advisory; opted-in enforcement gates future Kanban admission and never kills an ongoing tool.",
		time_limit:
			"The objective's elapsed-time threshold was reached. Review its retained attempts and user-owned limit. No running tool is killed by this reporting control.",
		cost_limit:
			"The objective's estimated-cost threshold was reached. Inspect attributed usage and its price coverage before changing a reporting limit; an estimate is not a guaranteed spending cap.",
		cost_unknown:
			"Usage or pricing coverage is unknown/incomplete, never zero. Inspect the missing provenance before approving more work; limit settings do not manufacture cost coverage.",
		delivery_uncertain:
			"An attempt was interrupted or disappeared without confirmed completion. Inspect session/task history and the existing recovery owner. Recheck only collects facts; it never replays an uncertain turn.",
		execution_blocked:
			"A tool was refused and the attempt is incomplete. Inspect the guard/session warning and choose an allowed action through the ordinary workflow. Recheck does not clear the guard, retry the turn, change providers or certify a completed candidate.",
		user_paused:
			"The user pause remains recorded. Only the user may resume Kanban admission; valid queued work may then proceed. A reference, recheck or acknowledgement is not plan/benchmark approval and no uncertain turn is replayed.",
	};
	return {
		summary: explanations[handoff.code],
		owner: handoff.owner,
		executionEnforcementAvailable: false,
		commands: [
			["kanban", "objective", "read", objective.id, "--project", workspaceId],
			["kanban", "objective", "recheck", objective.id, "--project", workspaceId],
			["kanban", "pipeline", "status", "--workspace", workspaceId],
		],
	};
}
