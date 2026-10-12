// How a kit choice's role reads (`kanban project create|add`'s kit prompt and the add-project dialog's picker), one
// wording for both. The facts come from src/kits/kit-choices.ts.
import type { RuntimeProjectKitChoiceRole } from "./api-contract";

/** One role as a short phrase: its agent and model, or what runs without the role. */
export function describeKitChoiceRole(role: RuntimeProjectKitChoiceRole): string {
	if (!role.defined) {
		return role.role === "qa" ? "none (no QA)" : role.role === "fallback" ? "none" : "the selected agent";
	}
	const agent = role.agentId ?? (role.role === "fallback" ? "the dev agent" : "the selected agent");
	if (!role.model) {
		return `${agent}, its default model`;
	}
	const showProvider = role.provider !== null && !role.model.startsWith(`${role.provider}/`);
	return `${agent}, ${role.model}${showProvider ? ` (${role.provider})` : ""}`;
}
