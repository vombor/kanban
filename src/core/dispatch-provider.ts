import { getRuntimeAgentCatalogEntry } from "./agent-catalog";
import type { RuntimeAgentId, RuntimeTaskAgentSettings } from "./api-contract";

/** A provider field an opaque CLI ignores cannot be used to evade its agent pool. */
export function getDispatchProvider(
	agentId: RuntimeAgentId | null | undefined,
	settings: RuntimeTaskAgentSettings | null | undefined,
): string | null {
	if (!agentId) return null;
	return getRuntimeAgentCatalogEntry(agentId)?.capabilities.providerOverride === "flag"
		? (settings?.providerId ?? null)
		: `agent:${agentId}`;
}
