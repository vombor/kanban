// `kanban doctor`'s guardrail rows: per installed agent, how its CLI enforces a task card's guardrails
// (src/terminal/agent-guardrails.ts). `pass` when commands and writes are enforced natively, `warn` when one of them
// is prompt-only or not enforced, `info` when partial. The orchestrator is exempt by design.
import type { PipelineConfig } from "../config/pipeline-config";
import { RUNTIME_AGENT_CATALOG } from "../core/agent-catalog";
import type { RuntimeAgentId } from "../core/api-contract";
import { parseDeniedCommandPatterns } from "../guardrails/command-patterns";
import { type AgentGuardrailReport, describeAgentGuardrails, probeAgentSandbox } from "../terminal/agent-guardrails";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";
import type { DoctorFinding, DoctorLevel } from "./doctor-report";

export interface GuardrailCheckDeps {
	isInstalled: (binary: string) => boolean;
	/** probeAgentSandbox: whether the agent's own sandbox runs here (null: it has none). */
	sandboxAvailable: (agentId: RuntimeAgentId, binary: string) => Promise<boolean | null>;
}

export const defaultGuardrailCheckDeps: GuardrailCheckDeps = {
	isInstalled: isBinaryAvailableOnPath,
	sandboxAvailable: probeAgentSandbox,
};

function levelOf(report: AgentGuardrailReport, confineWrites: boolean): DoctorLevel {
	const levels = [report.commands.level, ...(confineWrites ? [report.writes.level] : [])];
	if (levels.some((level) => level === "prompt" || level === "none")) {
		return "warn";
	}
	return levels.every((level) => level === "native") ? "pass" : "info";
}

function describe(part: { level: string; mechanism: string }): string {
	return `${part.level} (${part.mechanism})`;
}

export async function checkGuardrails(
	config: PipelineConfig,
	deps: GuardrailCheckDeps = defaultGuardrailCheckDeps,
): Promise<DoctorFinding[]> {
	const settings = config.guardrails;
	const findings: DoctorFinding[] = [
		{
			level: "info",
			area: "guardrails",
			message:
				"the orchestrator is exempt by design: the home-agent sidebar session (also when the watchdog starts it) and its headless wakes get no guardrails, because it works in the project and all of its task worktrees",
		},
	];
	if (!settings.enabled) {
		findings.push({
			level: "warn",
			area: "guardrails",
			message: "task-card guardrails are off (guardrails.enabled: false)",
			hint: 'set "guardrails": { "enabled": true } in config.json',
		});
		return findings;
	}
	// The shared branches here are the configured ones; each card adds its base branch.
	const deniedCommands = parseDeniedCommandPatterns(settings.denyCommands, settings.sharedBranches);
	for (const entry of RUNTIME_AGENT_CATALOG) {
		if (!deps.isInstalled(entry.binary)) {
			continue;
		}
		const report = describeAgentGuardrails(entry.id, {
			deniedCommands,
			confineWrites: settings.confineWrites,
			codexSandbox: await deps.sandboxAvailable(entry.id, entry.binary),
		});
		findings.push({
			level: levelOf(report, settings.confineWrites),
			area: "guardrails",
			message: `${entry.label}: commands ${describe(report.commands)}; writes ${describe(report.writes)}; reads ${describe(report.reads)}${
				report.unenforced.length > 0 ? `; launch prompt note for: ${report.unenforced.join(", ")}` : ""
			}`,
		});
	}
	return findings;
}
