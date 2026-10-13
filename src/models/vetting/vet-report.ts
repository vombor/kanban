// What `kanban models vet` leaves behind: `report.md` (people) and `result.json` (the run and its summary) in
// `<home>/data/models/vetting/<run>/`. The summary says passed, failed or inconclusive with the tool-call counts. An
// `inconclusive` run (`failure.harness`: sign-in, provider and transport errors, a context overflow, no capacity,
// Kanban) says nothing about the model. Nothing is written anywhere else: the user decides whether the
// model goes into Cline's models.json (docs/team/MODELS.md).
import { describeCombination } from "../model-combination";
import type { VetRunResult } from "./vet-runner";

/** One line about the run: its outcome, how long it took, its cost and its tool calls. */
export function describeVetSummary(result: VetRunResult): string {
	const duration = Math.round((result.finishedAt - result.startedAt) / 60_000);
	const cost = result.costUSD === null ? "cost unknown" : `$${result.costUSD.toFixed(2)}`;
	const tools = result.toolUse
		? `, ${result.toolUse.native} native tool call(s), ${result.toolUse.textual} as text`
		: ", tool calls not readable";
	if (result.outcome === "inconclusive") {
		return `kanban models vet ${result.role} smoke test inconclusive after ${duration} min (${cost}${tools}), for a harness or environment reason (not the model's): ${result.failure?.kind}: ${result.failure?.detail}`;
	}
	if (result.outcome === "passed") {
		return `kanban models vet ${result.role} smoke test passed (${result.checks.map((check) => check.name).join(", ")}) in ${duration} min, ${cost}${tools}`;
	}
	const by = result.failure?.harness ? " for a harness or environment reason (not the model's)" : "";
	return `kanban models vet ${result.role} smoke test failed${by} after ${duration} min (${cost}${tools}): ${result.failure?.kind}: ${result.failure?.detail}`;
}

export function formatVetReport(
	result: VetRunResult,
	paths: { repoPath: string },
	cliVersion: string | null = null,
): string {
	const lines = [
		`# Vetting ${result.runId}: ${describeCombination(result.combination)} for ${result.role}`,
		"",
		`Outcome: **${result.outcome.toUpperCase()}**${result.failure ? ` (${result.failure.kind}: ${result.failure.detail})` : ""}`,
		"",
		describeVetSummary(result),
		"",
		...(result.outcome === "inconclusive"
			? [
					"The harness or the environment caused this failure, not the model. Run it again once the cause is gone.",
					"",
				]
			: []),
		`- card: ${result.taskId ?? "none"} (discarded, never landed)`,
		`- agent CLI: ${cliVersion ?? "version unknown"}`,
		`- started ${new Date(result.startedAt).toISOString()}, finished ${new Date(result.finishedAt).toISOString()}`,
		`- cost: ${result.costUSD === null ? "unknown" : `$${result.costUSD.toFixed(2)}`}`,
		`- tool calls: ${result.toolUse ? `${result.toolUse.native} native, ${result.toolUse.textual} as text, ${result.toolUse.turns} turn(s)` : "not readable for this agent"}`,
		`- images: ${result.sawImageRejection ? "rejected" : "no rejection seen"}`,
		`- turn ended: ${result.turnEnded ? "yes" : "no"}`,
		`- scratch repo: ${paths.repoPath}`,
		"",
	];
	if (result.checks.length > 0) {
		lines.push(
			"## Checks",
			"",
			...result.checks.map((check) => `- ${check.ok ? "ok" : "FAIL"} ${check.name}: ${check.detail}`),
			"",
		);
	}
	return lines.join("\n");
}
