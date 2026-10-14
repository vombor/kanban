import { readFile } from "node:fs/promises";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import type { AgentSettingsOptions } from "../../core/agent-settings-options";
import { getCopilotProvidersPath } from "../../terminal/agent-session-adapters";
import { resolveBinaryOnPath } from "../../terminal/command-discovery";

export async function readCopilotOptions(): Promise<AgentSettingsOptions> {
	const binary = resolveBinaryOnPath("copilot");
	if (!binary) throw new Error("Copilot is not installed");
	const client = new CopilotClient({
		connection: RuntimeConnection.forStdio({ path: binary, args: ["--no-auto-update"] }),
		logLevel: "error",
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const models = await Promise.race([
			client.start().then(async () => await client.listModels()),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Copilot model discovery timed out")), 10_000);
			}),
		]);
		const providers = [{ value: "github", label: "GitHub Copilot" }];
		try {
			const document: unknown = JSON.parse(await readFile(getCopilotProvidersPath(), "utf8"));
			if (
				document &&
				typeof document === "object" &&
				"providers" in document &&
				document.providers &&
				typeof document.providers === "object"
			) {
				providers.push(
					...Object.keys(document.providers)
						.filter((id) => id !== "github")
						.map((value) => ({ value, label: value })),
				);
			}
		} catch {
			/* Profiles are optional; never expose their credentials/settings. */
		}
		return {
			models: models.map((model) => ({
				modelId: model.id,
				label: model.name,
				reasoningEfforts: model.supportedReasoningEfforts ?? [],
			})),
			providers,
			efforts: [...new Set(models.flatMap((model) => model.supportedReasoningEfforts ?? []))].map((value) => ({
				value,
				label: value,
			})),
			source: "GitHub Copilot's model catalog",
		};
	} finally {
		clearTimeout(timer);
		// This reader creates no sessions: close only its own metadata connection/process.
		await client.forceStop();
	}
}
