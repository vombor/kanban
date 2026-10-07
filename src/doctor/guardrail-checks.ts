// `kanban doctor`'s guardrail rows: per installed agent, how its CLI enforces a task card's guardrails
// (src/terminal/agent-guardrails.ts). `pass` when commands and writes are enforced natively, `warn` when one of them
// is prompt-only or not enforced, `info` when partial. The orchestrator is exempt by design. Workspaces that override
// the machine-wide settings (`workspaces.<id>.guardrails`) get a row each, and the agent rows are there whenever
// some workspace has the guardrails on. Two rows say what the guardrails mean for the stock git actions: the PR
// action pushes (allowed for the card's own branch only where Kanban's matcher guards the shell), and the Commit
// action resolves conflicts in the base worktree (a write outside the card's worktree).
import type { PipelineConfig, WorkspacePipelineSettings } from "../config/pipeline-config";
import { RUNTIME_AGENT_CATALOG } from "../core/agent-catalog";
import type { RuntimeAgentId } from "../core/api-contract";
import { parseDeniedCommandPatterns } from "../guardrails/command-patterns";
import {
	type AgentGuardrailReport,
	describeAgentGuardrails,
	probeAgentSandbox,
	usesKanbanCommandMatcher,
} from "../terminal/agent-guardrails";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";
import type { DoctorFinding, DoctorLevel } from "./doctor-report";

export interface GuardrailCheckDeps {
	isInstalled: (binary: string) => boolean;
	/** probeAgentSandbox: whether the agent's own sandbox runs here (null: it has none, or the probe timed out). */
	sandboxAvailable: (agentId: RuntimeAgentId, binary: string) => Promise<boolean | null>;
}

// The doctor reports; it doesn't wait on a hung sandbox the way a launch may (the result is cached per process).
const DOCTOR_SANDBOX_PROBE_TIMEOUT_MS = 5_000;

export const defaultGuardrailCheckDeps: GuardrailCheckDeps = {
	isInstalled: isBinaryAvailableOnPath,
	sandboxAvailable: async (agentId, binary) =>
		await probeAgentSandbox(agentId, binary, { timeoutMs: DOCTOR_SANDBOX_PROBE_TIMEOUT_MS }),
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

function describeWorkspace(id: string, workspace: WorkspacePipelineSettings): string {
	return workspace.name ? `workspace ${workspace.name} (${id})` : `workspace ${id}`;
}

/** The rows of the workspaces whose `guardrails` entry changes anything. */
function checkWorkspaceOverrides(config: PipelineConfig): DoctorFinding[] {
	const findings: DoctorFinding[] = [];
	for (const [id, workspace] of Object.entries(config.workspaces)) {
		const override = workspace.guardrails;
		const label = describeWorkspace(id, workspace);
		const enabled = override.enabled ?? config.guardrails.enabled;
		if (override.enabled === false && config.guardrails.enabled) {
			findings.push({
				level: "warn",
				area: "guardrails",
				message: `${label}: task-card guardrails are off (workspaces.${id}.guardrails.enabled: false)`,
				hint: `remove workspaces.${id}.guardrails.enabled or set it to true in config.json`,
			});
			continue;
		}
		if (!enabled) {
			continue;
		}
		const changes = [
			...(override.enabled === true && !config.guardrails.enabled
				? ["on although guardrails.enabled is false"]
				: []),
			...(override.extraDenyCommands.length > 0 ? [`also denies ${override.extraDenyCommands.join("; ")}`] : []),
			...(override.extraWritableDirs.length > 0 ? [`may also write ${override.extraWritableDirs.join(", ")}`] : []),
		];
		if (changes.length > 0) {
			findings.push({ level: "info", area: "guardrails", message: `${label}: guardrails ${changes.join("; ")}` });
		}
	}
	return findings;
}

/** What the guardrails mean for the stock Open PR / auto-review `pr` and Commit actions. */
function checkGitActions(config: PipelineConfig, installed: readonly RuntimeAgentId[]): DoctorFinding[] {
	const settings = config.guardrails;
	const findings: DoctorFinding[] = [];
	if (settings.denyCommands.some((pattern) => pattern.trim() === "git push")) {
		const nativeOnly = installed.filter((agentId) => !usesKanbanCommandMatcher(agentId));
		const labels = (ids: readonly RuntimeAgentId[]) =>
			ids.map((id) => RUNTIME_AGENT_CATALOG.find((entry) => entry.id === id)?.label ?? id).join(", ");
		if (settings.prCardPush === "deny") {
			findings.push({
				level: "warn",
				area: "guardrails",
				message:
					'PR git action (Open PR, auto-review pr): no card may push (guardrails.prCardPush: deny), so the stock Open PR prompt stops at "PR creation is blocked" and the orchestrator has to push',
				hint: 'set "guardrails": { "prCardPush": "own-branch" } to let PR cards push their own branch',
			});
		} else {
			findings.push({
				level: nativeOnly.length > 0 ? "warn" : "info",
				area: "guardrails",
				message: `PR git action (Open PR, auto-review pr): a card whose git action is PR when it starts may push its own branch, named explicitly, never a shared one (guardrails.prCardPush: own-branch, enforced by Kanban's matcher on Claude Code and Cline). Changing a running card's git action takes effect at its next start.${
					nativeOnly.length > 0
						? ` ${labels(nativeOnly)} can't tell the target branch, so their cards keep the push deny and their Open PR stops at "PR creation is blocked".`
						: ""
				}`,
			});
		}
	}
	if (settings.confineWrites) {
		findings.push({
			level: "info",
			area: "guardrails",
			message:
				"Commit git action: a card may cherry-pick into the base worktree, but resolving a conflict there is a write outside its worktree, which the guardrails deny where the agent's CLI enforces them; landing mode qa lands without the card touching the base worktree",
		});
	}
	return findings;
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
				"the orchestrator is exempt by design from the card guardrails: the home-agent sidebar session (also when the watchdog starts it) and its headless wakes get no command or write limits, because it works in the project and all of its task worktrees; under project isolation enforce it gets the isolation limits (area isolation)",
		},
	];
	if (!settings.enabled) {
		findings.push({
			level: "warn",
			area: "guardrails",
			message: "task-card guardrails are off (guardrails.enabled: false)",
			hint: 'set "guardrails": { "enabled": true } in config.json',
		});
	}
	const workspaceFindings = checkWorkspaceOverrides(config);
	const anyEnabled =
		settings.enabled || Object.values(config.workspaces).some((workspace) => workspace.guardrails.enabled === true);
	if (!anyEnabled) {
		return [...findings, ...workspaceFindings];
	}
	// The shared branches here are the configured ones; each card adds its base branch.
	const deniedCommands = parseDeniedCommandPatterns(settings.denyCommands, settings.sharedBranches);
	const installed: RuntimeAgentId[] = [];
	for (const entry of RUNTIME_AGENT_CATALOG) {
		if (!deps.isInstalled(entry.binary)) {
			continue;
		}
		installed.push(entry.id);
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
	return [...findings, ...workspaceFindings, ...checkGitActions(config, installed)];
}
