import { readPipelineConfig } from "../config/pipeline-config";
import { resolveCardRole } from "../core/card-role";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { withDevCompletionContract } from "../kits/dev-completion";
import { loadKitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import { loadWorkspaceBoardById } from "../state/workspace-state";

/** Read the native card role/kit at dispatch, not a caller-supplied role or an agent-id heuristic. */
export async function prepareKitDevPrompt(workspaceId: string, taskId: string, prompt: string): Promise<string> {
	if (!prompt.trim() || isHomeAgentSessionId(taskId)) return prompt;
	const board = await loadWorkspaceBoardById(workspaceId),
		card = board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId) ?? null;
	if (!card || resolveCardRole(card) !== "dev") return prompt;
	const parsed = await readPipelineConfig(),
		resolution = resolveWorkspaceKit(parsed.config, workspaceId, await loadKitCatalog());
	if (resolution.issues.length)
		throw new Error("Task kit instructions unavailable; no incomplete dispatch was performed.");
	return withDevCompletionContract(prompt, resolution.kit, card);
}
