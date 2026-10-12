// The command line of `kanban setup-provider <provider>` (src/commands/setup-provider.ts), the one command that writes
// a model provider's Cline settings. Every row, step and hint that tells someone to run it builds the line here, so
// the name lives in one place. Kept apart from the provider registry (cline-provider-setup.ts), which imports the
// provider modules that print these lines.
import { getConfiguredOpenAiCompatibleProvider } from "../models/openai-compatible-providers";

export const SETUP_PROVIDER_COMMAND = "kanban setup-provider";

/**
 * The providers with their own code in `kanban setup-provider`: the ids Cline uses. Every OpenAI-compatible provider of
 * config.json (`providers.openaiCompatible.<id>`) is set up by the command too.
 */
export const SETUP_PROVIDER_IDS = ["lemonade", "bedrock", "cline-pass"] as const;
export type BuiltInSetupProviderId = (typeof SETUP_PROVIDER_IDS)[number];
/** A built-in id or a configured OpenAI-compatible provider's. */
export type SetupProviderId = string;

/** Whether `kanban setup-provider <value>` sets the provider up (a built-in one or one in config.json). */
export function isSetupProviderId(value: string): boolean {
	return (
		(SETUP_PROVIDER_IDS as readonly string[]).includes(value) || getConfiguredOpenAiCompatibleProvider(value) !== null
	);
}

/** `kanban setup-provider <id>`, plus the provider's own options when given. */
export function formatSetupProviderCommand(id: SetupProviderId, options?: string): string {
	return `${SETUP_PROVIDER_COMMAND} ${id}${options ? ` ${options}` : ""}`;
}
