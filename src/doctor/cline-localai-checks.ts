// Doctor row: is Cline's `localai` custom provider there (models.json, plus the providers.json settings its TUI needs)
// and the way LocalAI reports its models now?
// Missing, or differing in its baseUrl, modelsSourceUrl or any model, is a warning with the command the user runs
// (`kanban cline apply-localai-provider`, src/setup/cline-localai-provider.ts); Kanban never writes it itself. A
// second row compares `models.providerCapacity.localai` with what LocalAI keeps loaded (/api/settings
// `max_active_backends`): above it, cards on different models make it reload on every request. Only where LocalAI is
// set up (models.lists.localai.url, or an entry in models.json); LocalAI down is INFO, as for Lemonade.
import type { PipelineConfig } from "../config/pipeline-config";
import { fetchLocalProviderLimit } from "../models/local-provider-limits";
import { resolveConfiguredLocalAiUrl } from "../models/localai-endpoint";
import { LOCALAI_PROVIDER_ID } from "../models/localai-models";
import { formatApplyLocalAiProviderCommand, planClineLocalAiProvider } from "../setup/cline-localai-provider";
import { getClineModelsSettingsPath, getClineProvidersSettingsPath } from "../state/kanban-home";
import type { DoctorFinding } from "./doctor-report";

const LOCALAI_TIMEOUT_MS = 1_500;

export async function checkClineLocalAiProvider(options: {
	config: Pick<PipelineConfig, "models" | "agents">;
	/** Kanban server origin, for the printed command. */
	origin: string;
	fetch?: typeof fetch;
}): Promise<DoctorFinding[]> {
	const baseUrl = await resolveConfiguredLocalAiUrl(options.config);
	if (!baseUrl) {
		return [];
	}
	const modelsPath = getClineModelsSettingsPath(options.config.agents.cline.dataDir);
	const plan = await planClineLocalAiProvider({
		modelsPath,
		providersPath: getClineProvidersSettingsPath(options.config.agents.cline.dataDir),
		baseUrl,
		origin: options.origin,
		requireCapabilities: options.config.models.lists.localai.requireCapabilities,
		fetch: options.fetch,
		timeoutMs: LOCALAI_TIMEOUT_MS,
	});
	if (plan.kind === "error") {
		// An unreadable models.json is the setup rows' finding.
		return [];
	}
	const prefix = `cline localai provider (${modelsPath})`;
	const hint = formatApplyLocalAiProviderCommand({ baseUrl, origin: options.origin });
	const findings: DoctorFinding[] = [];
	if (plan.kind === "absent") {
		findings.push({
			level: "warn",
			area: "setup",
			message: `${prefix}: missing, so Cline cards can't run on LocalAI (${baseUrl}); ${plan.details.join("; ")}`,
			hint,
		});
	} else if (plan.inSync) {
		findings.push({ level: "pass", area: "setup", message: `${prefix}: ${plan.details.join("; ")}` });
	} else if (plan.unreachable && plan.details.length === 1) {
		findings.push({ level: "info", area: "setup", message: `${prefix}: ${plan.details.join("; ")}` });
	} else {
		findings.push({ level: "warn", area: "setup", message: `${prefix}: ${plan.details.join("; ")}`, hint });
	}
	findings.push(...(await checkLocalAiCapacity(options)));
	return findings;
}

async function checkLocalAiCapacity(options: {
	config: Pick<PipelineConfig, "models" | "agents">;
	fetch?: typeof fetch;
}): Promise<DoctorFinding[]> {
	const limit = await fetchLocalProviderLimit(LOCALAI_PROVIDER_ID, options.config, {
		fetch: options.fetch,
		timeoutMs: LOCALAI_TIMEOUT_MS,
	});
	const key = `models.providerCapacity.${LOCALAI_PROVIDER_ID}.maxLoadedModels`;
	const kanban = options.config.models.providerCapacity[LOCALAI_PROVIDER_ID]?.maxLoadedModels;
	if (limit.kind === "unknown") {
		return [
			{
				level: "info",
				area: "setup",
				message: `localai capacity: ${limit.endpoint} doesn't say how many models LocalAI keeps loaded (API keys set?); Kanban runs ${kanban ?? "any number"} at a time (${key})`,
			},
		];
	}
	if (limit.kind !== "known") {
		// Unreachable or not set up: the provider row above already says so.
		return [];
	}
	const serverText = limit.maxLoaded < 0 ? "unlimited" : String(limit.maxLoaded);
	const server = limit.maxLoaded < 0 ? Number.POSITIVE_INFINITY : limit.maxLoaded;
	if ((kanban ?? Number.POSITIVE_INFINITY) > server) {
		return [
			{
				level: "warn",
				area: "setup",
				message: `localai capacity: Kanban lets ${kanban ?? "any number of"} LocalAI model(s) run at once (${key}) but LocalAI keeps ${serverText} loaded (max_active_backends): cards on different models make it reload on every request`,
				hint: `set ${key} to ${serverText} in config.json, or raise LocalAI's max_active_backends`,
			},
		];
	}
	return [
		{
			level: "pass",
			area: "setup",
			message: `localai capacity: LocalAI keeps ${serverText} model(s) loaded (max_active_backends), Kanban runs at most ${kanban ?? "any number"} at a time (${key})`,
		},
	];
}
