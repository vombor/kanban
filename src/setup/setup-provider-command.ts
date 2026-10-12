// The command line of `kanban setup-provider <provider>` (src/commands/setup-provider.ts), the one command that writes
// a model provider's Cline settings. Every row, step and hint that tells someone to run it builds the line here, so
// the name lives in one place. Kept apart from the provider registry (cline-provider-setup.ts), which imports the
// provider modules that print these lines.

export const SETUP_PROVIDER_COMMAND = "kanban setup-provider";

/** The providers `kanban setup-provider` sets up: the ids Cline uses. */
export const SETUP_PROVIDER_IDS = ["lemonade", "bedrock", "cline-pass"] as const;
export type SetupProviderId = (typeof SETUP_PROVIDER_IDS)[number];

export function isSetupProviderId(value: string): value is SetupProviderId {
	return (SETUP_PROVIDER_IDS as readonly string[]).includes(value);
}

/** `kanban setup-provider <id>`, plus the provider's own options when given (e.g. `--origin <url>`). */
export function formatSetupProviderCommand(id: SetupProviderId, options?: string): string {
	return `${SETUP_PROVIDER_COMMAND} ${id}${options ? ` ${options}` : ""}`;
}
