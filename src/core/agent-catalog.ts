import type { RuntimeAgentId } from "./api-contract";

// How an agent accepts launch-time model/effort overrides. Mechanisms only — never value lists.
export type RuntimeAgentOverrideMechanism = "flag" | "config" | "none";

export interface RuntimeAgentCapabilities {
	modelOverride: RuntimeAgentOverrideMechanism;
	effortOverride: RuntimeAgentOverrideMechanism;
	/** Whether the agent consumes `providerId` at launch (Cline `--provider`, OpenCode `provider/model`). */
	providerOverride: RuntimeAgentOverrideMechanism;
	docsUrl: string;
}

export interface RuntimeAgentCatalogEntry {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	baseArgs: string[];
	autonomousArgs: string[];
	installUrl: string;
	capabilities: RuntimeAgentCapabilities;
}

export const RUNTIME_AGENT_CATALOG: RuntimeAgentCatalogEntry[] = [
	{
		id: "claude",
		label: "Claude Code",
		binary: "claude",
		baseArgs: [],
		autonomousArgs: ["--permission-mode", "auto"],
		installUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "flag",
			providerOverride: "none",
			docsUrl: "https://code.claude.com/docs/en/cli-reference",
		},
	},
	{
		id: "codex",
		label: "OpenAI Codex",
		binary: "codex",
		baseArgs: [],
		autonomousArgs: ["--dangerously-bypass-approvals-and-sandbox"],
		installUrl: "https://github.com/openai/codex",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "config",
			providerOverride: "none",
			docsUrl: "https://developers.openai.com/codex/cli/reference",
		},
	},
	{
		id: "cline",
		label: "Cline",
		binary: "cline",
		baseArgs: [],
		autonomousArgs: ["--auto-approve", "true"],
		installUrl: "https://docs.cline.bot/cli/cli-reference",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "flag",
			providerOverride: "flag",
			docsUrl: "https://docs.cline.bot/cli/cli-reference",
		},
	},
	{
		id: "copilot",
		label: "GitHub Copilot",
		binary: "copilot",
		baseArgs: [],
		// The adapter adds --allow-all-tools/--allow-all-paths in autonomous mode (never in plan mode).
		autonomousArgs: [],
		installUrl: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "flag",
			// "github" = the Copilot subscription; other ids name BYOK profiles in copilot-providers.json.
			providerOverride: "config",
			docsUrl: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference",
		},
	},
	{
		id: "opencode",
		label: "OpenCode",
		binary: "opencode",
		baseArgs: [],
		autonomousArgs: [],
		installUrl: "https://github.com/sst/opencode",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "none",
			providerOverride: "flag",
			docsUrl: "https://opencode.ai/docs/cli/",
		},
	},
	{
		id: "droid",
		label: "Factory Droid",
		binary: "droid",
		baseArgs: [],
		autonomousArgs: ["--auto", "high"],
		installUrl: "https://docs.factory.ai/cli/getting-started/quickstart",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "flag",
			providerOverride: "none",
			docsUrl: "https://docs.factory.ai/droid-cli/cli-reference",
		},
	},
	{
		id: "kiro",
		label: "Kiro",
		binary: "kiro-cli",
		baseArgs: ["chat"],
		autonomousArgs: ["--trust-all-tools"],
		installUrl: "https://kiro.dev",
		capabilities: {
			modelOverride: "none",
			effortOverride: "none",
			providerOverride: "none",
			docsUrl: "https://kiro.dev/docs/reference/cli-commands/",
		},
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		binary: "gemini",
		baseArgs: [],
		autonomousArgs: ["--yolo"],
		installUrl: "https://github.com/google-gemini/gemini-cli",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "none",
			providerOverride: "none",
			docsUrl: "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md",
		},
	},
];

// Temporarily keep launch support scoped to the core agent set.
// Re-enable additional CLIs by uncommenting entries below when ready.
export const RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS: readonly RuntimeAgentId[] = [
	"cline",
	"claude",
	"codex",
	"copilot",
	"droid",
	"kiro",
	// "opencode",
	// "gemini",
];

const RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET = new Set<RuntimeAgentId>(RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS);

export function isRuntimeAgentLaunchSupported(agentId: RuntimeAgentId): boolean {
	return RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET.has(agentId);
}

export function getRuntimeLaunchSupportedAgentCatalog(): RuntimeAgentCatalogEntry[] {
	return RUNTIME_AGENT_CATALOG.filter((entry) => isRuntimeAgentLaunchSupported(entry.id));
}

export function getRuntimeAgentCatalogEntry(agentId: RuntimeAgentId): RuntimeAgentCatalogEntry | null {
	return RUNTIME_AGENT_CATALOG.find((entry) => entry.id === agentId) ?? null;
}
