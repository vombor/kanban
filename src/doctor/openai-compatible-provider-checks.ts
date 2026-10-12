// Doctor row: whether Cline's entries for each OpenAI-compatible provider of config.json
// (`providers.openaiCompatible.<id>`) match what `kanban setup-provider <id>` would write
// (src/setup/cline-openai-compatible-provider.ts, the same plan). Read-only, never prints a key.
import type { OpenAiCompatibleProviderSettings } from "../config/openai-compatible-providers-config";
import { planClineOpenAiCompatibleProvider } from "../setup/cline-openai-compatible-provider";
import { formatSetupProviderCommand } from "../setup/setup-provider-command";
import type { DoctorFinding } from "./doctor-report";

const AREA = "setup";

export interface OpenAiCompatibleProviderCheckOptions {
	providerId: string;
	provider: OpenAiCompatibleProviderSettings;
	modelsPath: string;
	providersPath: string;
	env: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
}

export async function checkOpenAiCompatibleProvider(
	options: OpenAiCompatibleProviderCheckOptions,
): Promise<DoctorFinding[]> {
	const label = `cline ${options.providerId} provider (${options.provider.baseUrl})`;
	const hint = formatSetupProviderCommand(options.providerId);
	const plan = await planClineOpenAiCompatibleProvider(options);
	if (plan.kind !== "ok") {
		return plan.notes.map((note) => ({ level: "warn", area: AREA, message: `${label}: ${note}` }));
	}
	const findings: DoctorFinding[] = [];
	if (plan.unreachable) {
		findings.push({ level: "info", area: AREA, message: `${label}: ${plan.unreachable}` });
	}
	if (plan.absent) {
		findings.push({
			level: "warn",
			area: AREA,
			message: `${label}: in config.json but not set up in Cline's models.json and providers.json`,
			hint,
		});
	} else if (!plan.inSync) {
		findings.push(
			...plan.changes.map(
				(change): DoctorFinding => ({ level: "warn", area: AREA, message: `${label}: ${change}`, hint }),
			),
		);
	}
	if (plan.signInGap) {
		findings.push({ level: "warn", area: AREA, message: `${label}: ${plan.signInGap}` });
	}
	if (findings.length === 0) {
		findings.push({
			level: "pass",
			area: AREA,
			message: `${label}: Cline's entries match config.json and the server`,
		});
	}
	return findings;
}
