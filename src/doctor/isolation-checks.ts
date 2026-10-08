// `kanban doctor`'s project isolation rows (docs/fork/project-isolation.md): each workspace's mode and message
// switch with, per installed agent, how its launch enforces isolation (native / partial / prompt-only, from
// describeAgentIsolation in src/terminal/agent-guardrails.ts), the mechanisms once per agent, and the settings that
// conflict with isolation (headless wakes under enforce). The removed cross-project `orchestrator.wake.target` is
// checkLegacyConfigKeys's row (doctor-checks.ts).
import { type PipelineConfig, resolveWorkspaceWakeSettings } from "../config/pipeline-config";
import { RUNTIME_AGENT_CATALOG } from "../core/agent-catalog";
import { resolveIsolationMode } from "../isolation/isolation-settings";
import type { RuntimeWorkspaceIndexEntry } from "../state/workspace-state";
import { describeAgentIsolation, usesKanbanCommandMatcher } from "../terminal/agent-guardrails";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";
import type { DoctorFinding } from "./doctor-report";

export interface IsolationCheckDeps {
	isInstalled: (binary: string) => boolean;
}

const AREA = "isolation" as const;

export function checkIsolation(
	config: PipelineConfig,
	entries: readonly RuntimeWorkspaceIndexEntry[],
	deps: IsolationCheckDeps = { isInstalled: isBinaryAvailableOnPath },
): DoctorFinding[] {
	const findings: DoctorFinding[] = [
		{
			level: "info",
			area: AREA,
			message:
				"creating, registering and removing projects is the user's: the runtime API and the Kanban CLI refuse it from every agent session, whatever the isolation mode (re-registering its own project is a no-op and allowed)",
		},
	];
	const installed = RUNTIME_AGENT_CATALOG.filter((entry) => deps.isInstalled(entry.binary));
	const modes = entries.map((entry) => ({ entry, mode: resolveIsolationMode(config, entry.workspaceId) }));
	const anyOn = config.isolation.mode !== "off" || modes.some(({ mode }) => mode !== "off");
	if (!anyOn) {
		findings.push({
			level: "info",
			area: AREA,
			message:
				"project isolation is off (isolation.mode: off): agent sessions are identified, but nothing outside their project is refused or logged",
			hint: 'set "isolation": { "mode": "report" } in config.json to log what enforce would refuse, then "enforce"',
		});
	}
	for (const { entry, mode } of modes) {
		const settings = config.workspaces[entry.workspaceId];
		const label = settings?.name
			? `workspace ${settings.name} (${entry.workspaceId})`
			: `workspace ${entry.workspaceId}`;
		const messages = settings?.isolation.messages ?? "deny";
		if (mode === "off") {
			if (anyOn) {
				findings.push({
					level: "info",
					area: AREA,
					message: `${label}: isolation off (its sessions are still refused projects that are in enforce); orchestrator messages ${messages}`,
				});
			}
			continue;
		}
		const agents = installed.map((agent) => `${agent.label} ${describeAgentIsolation(agent.id).overall}`);
		const promptOnly = installed.filter((agent) => describeAgentIsolation(agent.id).overall === "prompt-only");
		findings.push({
			level: mode === "enforce" && promptOnly.length > 0 ? "warn" : "info",
			area: AREA,
			message: `${label}: isolation ${mode}${mode === "report" ? " (logged to data/<ws>/isolation.jsonl, nothing refused)" : ""}; orchestrator messages ${messages}; per agent: ${agents.join(", ") || "no agent installed"}`,
			...(mode === "enforce" && promptOnly.length > 0
				? {
						hint: `${promptOnly.map((agent) => agent.label).join(", ")} only get the launch prompt for reads and writes of other projects; their runtime API and Kanban CLI access is still checked`,
					}
				: {}),
		});
	}
	if (anyOn) {
		for (const agent of installed) {
			const report = describeAgentIsolation(agent.id);
			findings.push({
				level: "info",
				area: AREA,
				message: `${agent.label}: ${report.overall}: runtime API ${report.api.level} (${report.api.mechanism}); reads ${report.reads.level} (${report.reads.mechanism}); writes ${report.writes.level} (${report.writes.mechanism})`,
			});
		}
		if (modes.some(({ mode }) => mode === "enforce")) {
			const matcher = installed.filter((agent) => usesKanbanCommandMatcher(agent.id));
			const others = installed.filter((agent) => !usesKanbanCommandMatcher(agent.id));
			findings.push({
				level: others.length > 0 ? "warn" : "info",
				area: AREA,
				message: `shell writes to the machine-wide config (config.json, kits, the agents' config) are refused by command form for ${matcher.map((agent) => agent.label).join(", ") || "no installed agent"}${others.length > 0 ? `; ${others.map((agent) => agent.label).join(", ")} only get the launch prompt for them (file-tool writes are denied where the agent supports it)` : ""}`,
				...(others.length > 0
					? {
							hint: 'isolation mode changes are logged to every workspace\'s isolation.jsonl ("mode_changed") when the server sees them',
						}
					: {}),
			});
		}
		if (
			modes.some(
				({ entry, mode }) =>
					mode === "enforce" && resolveWorkspaceWakeSettings(config, entry.workspaceId).mode === "headless",
			)
		) {
			findings.push({
				level: "info",
				area: AREA,
				message:
					"workspaces in enforce get their orchestrator wakes in the sidebar session, not headless: a headless run carries its workspace's session credential but no isolation guardrails",
			});
		}
	}
	return findings;
}
