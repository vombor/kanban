import { query } from "@anthropic-ai/claude-agent-sdk/core";
import type { AgentSettingsOptions } from "../../core/agent-settings-options";
import { resolveBinaryOnPath } from "../../terminal/command-discovery";

// An initialization-only SDK query: no user messages, model turn, or saved session.
async function* noMessages() {}

export async function readClaudeOptions(): Promise<AgentSettingsOptions> {
	const binary = resolveBinaryOnPath("claude");
	if (!binary) throw new Error("Claude Code is not installed");
	const abortController = new AbortController();
	const timer = setTimeout(() => abortController.abort(), 10_000);
	const session = query({
		prompt: noMessages(),
		options: {
			pathToClaudeCodeExecutable: binary,
			persistSession: false,
			abortController,
			settingSources: ["user"],
		},
	});
	try {
		const models = await session.supportedModels();
		return {
			models: models.map((model) => ({
				modelId: model.value,
				label: model.displayName,
				reasoningEfforts: model.supportedEffortLevels ?? [],
			})),
			providers: [],
			efforts: [...new Set(models.flatMap((model) => model.supportedEffortLevels ?? []))].map((value) => ({
				value,
				label: value,
			})),
			source: "Claude Code's model catalog",
		};
	} finally {
		clearTimeout(timer);
		session.close();
	}
}
