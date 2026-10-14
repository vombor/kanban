import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentSettingsOptions } from "../../core/agent-settings-options";

const execute = promisify(execFile);

/** Factory advertises its current model IDs and per-model effort lists in exec --help. */
export function parseDroidHelp(help: string): AgentSettingsOptions {
	const catalog = help.split("Available Models:")[1]?.split("Model details:")[0] ?? "";
	const details = help.split("Model details:")[1]?.split("Pinning the Latest Model:")[0] ?? "";
	const effortsByLabel = new Map<string, string[]>();
	for (const line of details.split("\n")) {
		const match = /^\s*- (.+?): supports reasoning: .*?supported: \[([^\]]*)\]/u.exec(line);
		if (match?.[1] && match[2] !== undefined)
			effortsByLabel.set(
				match[1],
				match[2]
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean),
			);
	}
	const models: AgentSettingsOptions["models"] = [];
	for (const line of catalog.split("\n")) {
		const match = /^\s+(\S+)\s{2,}(.+)$/u.exec(line);
		if (!match?.[1] || !match[2]) continue;
		const label = match[2].trim().replace(/ \(default\)$/u, "");
		models.push({ modelId: match[1], label, reasoningEfforts: effortsByLabel.get(label) ?? [] });
	}
	return {
		models,
		providers: [],
		efforts: [...new Set(models.flatMap((model) => model.reasoningEfforts))].map((value) => ({
			value,
			label: value,
		})),
		source: "Factory Droid's advertised models and effort levels",
		...(models.length === 0 ? { error: "Droid did not advertise a model catalog; its stored default is kept." } : {}),
	};
}

export async function readDroidOptions(): Promise<AgentSettingsOptions> {
	const { stdout } = await execute("droid", ["exec", "--help"], {
		timeout: 10_000,
		maxBuffer: 512_000,
		env: { ...process.env, FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
	});
	return parseDroidHelp(stdout);
}
