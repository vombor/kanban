import type { RuntimeTaskAgentSettings } from "./api-contract";

// Normalized copy of a task's agent settings: trims provider/model IDs, drops
// empty fields, and never retains a caller-owned object reference.
export function cloneRuntimeTaskAgentSettings(
	settings?: RuntimeTaskAgentSettings | null,
): RuntimeTaskAgentSettings | undefined {
	if (settings === undefined || settings === null) {
		return undefined;
	}
	const providerId = settings.providerId?.trim();
	const modelId = settings.modelId?.trim();
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
	};
}
