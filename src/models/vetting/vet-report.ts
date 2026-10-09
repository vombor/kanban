// What `kanban models vet` leaves behind: `report.md` (people) and `result.json` (the run and the proposed registry
// entry) in `<home>/data/models/vetting/<run>/`. The proposal is the combination's current entry with this role's
// vetting replaced: `vetted` after a passed run, `rejected` with the failure as the reason after a failed one (one
// failure may be bad luck; the orchestrator decides what to commit). Capabilities the run saw are merged in.
import {
	describeCombination,
	lookupVetting,
	type RoleVetting,
	type VettedEntry,
	type VettedRegistry,
	vettedEntrySchema,
} from "../vetted-registry";
import type { VetRunResult } from "./vet-runner";

export interface VetProposal {
	/** The entry as models/vetted.json should hold it after this run. */
	entry: VettedEntry;
	/** The entry it replaces, or null for a new one. */
	replaces: VettedEntry | null;
}

function isoDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function describeEvidence(result: VetRunResult): string {
	const duration = Math.round((result.finishedAt - result.startedAt) / 60_000);
	const cost = result.costUSD === null ? "cost unknown" : `$${result.costUSD.toFixed(2)}`;
	const tools = result.toolUse ? `, ${result.toolUse.native} native tool call(s)` : "";
	if (result.outcome === "passed") {
		return `kanban models vet ${result.role} smoke test passed (${result.checks.map((check) => check.name).join(", ")}) in ${duration} min, ${cost}${tools}`;
	}
	return `kanban models vet ${result.role} smoke test failed after ${duration} min (${cost}${tools}): ${result.failure?.kind}: ${result.failure?.detail}`;
}

export function buildVetProposal(
	registry: VettedRegistry,
	result: VetRunResult,
	cliVersion: string | null,
): VetProposal {
	const { combination } = result;
	const verdict = lookupVetting(registry, combination, result.role);
	// Only an entry for exactly this combination is updated; a model-wide rejection or a provider-less entry is not.
	const current =
		verdict.entry &&
		verdict.entry.agent === combination.agentId &&
		verdict.entry.provider === combination.provider &&
		verdict.entry.model === combination.model
			? verdict.entry
			: null;
	const vetting: RoleVetting = {
		status: result.outcome === "passed" ? "vetted" : "rejected",
		at: isoDay(result.finishedAt),
		cliVersion,
		evidence: { run: result.runId, summary: describeEvidence(result) },
		...(result.outcome === "passed" ? {} : { reason: `${result.failure?.kind}: ${result.failure?.detail}` }),
	};
	const capabilities = {
		...current?.capabilities,
		...(result.toolUse ? { toolUse: result.toolUse.native > 0 } : {}),
		...(result.sawImageRejection ? { images: false } : {}),
		...(result.outcome === "passed" || result.turnEnded ? { turnEnd: result.turnEnded } : {}),
	};
	const entry = vettedEntrySchema.parse({
		agent: combination.agentId,
		provider: combination.provider,
		model: combination.model,
		roles: { ...current?.roles, [result.role]: vetting },
		...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
		...(current?.note ? { note: current.note } : {}),
	});
	return { entry, replaces: current };
}

export function formatVetReport(result: VetRunResult, proposal: VetProposal, paths: { repoPath: string }): string {
	const lines = [
		`# Vetting ${result.runId}: ${describeCombination(result.combination)} for ${result.role}`,
		"",
		`Outcome: **${result.outcome.toUpperCase()}**${result.failure ? ` (${result.failure.kind}: ${result.failure.detail})` : ""}`,
		"",
		`- card: ${result.taskId ?? "none"} (discarded, never landed)`,
		`- started ${new Date(result.startedAt).toISOString()}, finished ${new Date(result.finishedAt).toISOString()}`,
		`- cost: ${result.costUSD === null ? "unknown" : `$${result.costUSD.toFixed(2)}`}`,
		`- tool calls: ${result.toolUse ? `${result.toolUse.native} native, ${result.toolUse.textual} as text, ${result.toolUse.turns} turn(s)` : "not readable for this agent"}`,
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
	lines.push(
		"## Proposed registry entry",
		"",
		proposal.replaces
			? "Replaces the combination's entry in models/vetted.json:"
			: "A new entry for models/vetted.json:",
		"",
		"```json",
		JSON.stringify(proposal.entry, null, "\t"),
		"```",
		"",
		"The registry changes only through the Kanban repo: the Kanban orchestrator commits this on fork/stack.",
		"",
	);
	return lines.join("\n");
}
