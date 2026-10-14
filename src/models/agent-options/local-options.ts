import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentSettingsOptions } from "../../core/agent-settings-options";
import { getClineModelsSettingsPath } from "../../state/kanban-home";
import { readClineModelRecords } from "../cline-model-records";

const execute = promisify(execFile);

/** Reasoning values advertised by a CLI flag, never a locally maintained effort union. */
export function readHelpEfforts(help: string, flag: string): string[] {
	const section = help.slice(help.indexOf(flag));
	const match = /(?:none|low|medium|high)[a-z]*(?:\|[a-z]+)+/u.exec(section.slice(0, 700));
	return match?.[0].split("|") ?? [];
}

export async function readClineOptions(modelsPath = getClineModelsSettingsPath()): Promise<AgentSettingsOptions> {
	const [records, help] = await Promise.all([
		readClineModelRecords(modelsPath),
		execute("cline", ["--help"], { timeout: 5000, maxBuffer: 128_000 })
			.then(({ stdout }) => stdout)
			.catch(() => ""),
	]);
	const efforts = readHelpEfforts(help, "--thinking");
	return {
		models: [...(records ?? new Map<string, Set<string>>())].flatMap(([providerId, models]) =>
			[...models].map((modelId) => ({ modelId, providerId, label: modelId, reasoningEfforts: efforts })),
		),
		providers: [...(records?.keys() ?? [])].map((value) => ({ value, label: value })),
		efforts: efforts.map((value) => ({ value, label: value })),
		source: "Cline's models.json and CLI thinking levels",
	};
}
