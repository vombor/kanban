// Doctor rows for a project's kit:
//   - project settings (`workspaces.<id>.kit.overrides`) that are not project settings any more: legacy model keys
//     (`dev.agent` = `roles.dev.agent`) and team keys (onFail, escalate, onOutage, qa.routes, tiers, ...). Both still
//     apply; the hint is the user's `kanban kit migrate-overrides`, never a --fix (it changes the project's team).
// and for what it needs from the machine:
//   - every `recommends.settings` entry the config doesn't meet (team-local: the Cline turn detector on, recovery on,
//     ), as a warning with the key to set. Never fixed by --fix: they are machine-wide
//     or user settings, and a kit never applies mechanics.
//   - every local (Lemonade) model the kit routes to that Lemonade doesn't list, hasn't downloaded or doesn't mark
//     tool-calling (Cline's Lemonade list only offers tool-calling models), so a card never starts on a model the
//     server can't run. Lemonade being down is INFO, as in the models.json row.
//   - whether Lemonade keeps the kit's dev, QA and fallback models loaded side by side (/api/v1/health
//     `max_models.llm`) and Kanban's `models.providerCapacity.lemonade` matches it (src/kits/local-residency.ts).
//   - the same two for LocalAI: every model the kit routes to on `localai` is one LocalAI lists as a chat model, and
//     its `max_active_backends` holds the kit's working set. LocalAI down or not set up is INFO.
import type { LemonadeModelListSettings } from "../config/model-lists-config";
import type { PipelineConfig } from "../config/pipeline-config";
import { describeRecommendedValue, evaluateKitRecommendedSettings } from "../kits/kit-recommendations";
import { listKitRoles } from "../kits/kit-roles";
import type { KitDocument } from "../kits/kit-schema";
import { getUsableTierEntries } from "../kits/kit-schema";
import { assessLocalResidency, listKitLocalWorkingSet } from "../kits/local-residency";
import { describeProjectSettings } from "../kits/project-settings";
import { DEFAULT_KIT_NAME, type KitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import {
	fetchLemonadeMaxLoadedLlms,
	fetchLemonadeModels,
	type LemonadeModel,
	lemonadeApiBaseUrl,
} from "../models/lemonade-models";
import { fetchLocalProviderLimit } from "../models/local-provider-limits";
import { resolveConfiguredLocalAiUrl } from "../models/localai-endpoint";
import {
	fetchLocalAiModels,
	isListedLocalAiModel,
	LOCALAI_PROVIDER_ID,
	type LocalAiModel,
} from "../models/localai-models";
import { LEMONADE_PROVIDER_ID } from "../models/model-probe";
import { APPLY_LOCALAI_PROVIDER_COMMAND } from "../setup/cline-localai-provider";
import type { DoctorFinding } from "./doctor-report";

const LOCAL_PROVIDER_TIMEOUT_MS = 1_500;
const TOOL_CALLING_LABEL = "tool-calling";

export interface KitSettingsCheckContext {
	config: PipelineConfig;
	catalog: KitCatalog;
	entries: ReadonlyArray<{ workspaceId: string }>;
}

/** The resolved kits of registered projects that aren't on `default` (which recommends nothing). */
function listProjectKits(
	context: KitSettingsCheckContext,
): Array<{ workspaceId: string; kitName: string; kit: KitDocument }> {
	return context.entries.flatMap(({ workspaceId }) => {
		const resolution = resolveWorkspaceKit(context.config, workspaceId, context.catalog);
		return resolution.kitName === DEFAULT_KIT_NAME
			? []
			: [{ workspaceId, kitName: resolution.kitName, kit: resolution.kit }];
	});
}

export function checkKitProjectSettings(context: KitSettingsCheckContext): DoctorFinding[] {
	const findings: DoctorFinding[] = [];
	for (const { workspaceId } of context.entries) {
		const resolution = resolveWorkspaceKit(context.config, workspaceId, context.catalog);
		if (Object.keys(resolution.overrides).length === 0) {
			continue;
		}
		const classified = describeProjectSettings(context.catalog, resolution.kitName, resolution.overrides);
		if (!classified) {
			continue;
		}
		const hint = `kanban kit migrate-overrides --project ${workspaceId} --dry-run shows where each goes; the user runs it without --dry-run`;
		const teamKeys = Object.keys(classified.team).sort();
		if (teamKeys.length > 0) {
			findings.push({
				level: "warn",
				area: "project",
				message: `${workspaceId}: ${teamKeys.length} override(s) change kit ${resolution.kitName}'s team definition (${teamKeys.join(", ")}): they still apply, but a project only sets role models and project facts; pick or make a kit that has them`,
				hint,
			});
		}
		if (classified.legacy.length > 0) {
			findings.push({
				level: "warn",
				area: "project",
				message: `${workspaceId}: legacy override key(s) ${classified.legacy.map(({ from, to }) => `${from} (= ${to.join(", ")})`).join("; ")}`,
				hint,
			});
		}
		for (const issue of classified.invalid) {
			findings.push({
				level: "warn",
				area: "project",
				message: `${workspaceId}: override ${issue.key}: ${issue.message}`,
				hint,
			});
		}
		if (teamKeys.length === 0 && classified.legacy.length === 0 && classified.invalid.length === 0) {
			findings.push({
				level: "pass",
				area: "project",
				message: `${workspaceId}: its ${Object.keys(classified.project).length} override(s) are project settings (role models, project facts)`,
			});
		}
	}
	return findings;
}

function formatConfigValue(value: unknown): string {
	return JSON.stringify(value) ?? "(none)";
}

export function checkKitRecommendedSettings(context: KitSettingsCheckContext): DoctorFinding[] {
	const findings: DoctorFinding[] = [];
	for (const { workspaceId, kitName, kit } of listProjectKits(context)) {
		const statuses = evaluateKitRecommendedSettings(kit, context.config, workspaceId);
		if (statuses.length === 0) {
			continue;
		}
		const open = statuses.filter((status) => status.status !== "met");
		for (const { setting, configKey, current, status } of open) {
			findings.push({
				level: "warn",
				area: "project",
				message:
					status === "unknown"
						? `${workspaceId}: kit ${kitName} recommends ${configKey}, which is not a setting of this Kanban build`
						: `${workspaceId}: kit ${kitName} needs ${configKey} = ${describeRecommendedValue(setting)} (now ${formatConfigValue(current)}): ${setting.why}`,
				hint:
					status === "unknown"
						? `kanban kit show --project ${workspaceId}`
						: `set ${configKey} to ${formatConfigValue(setting.value)} in config.json (the kit never applies it)`,
			});
		}
		if (open.length === 0) {
			findings.push({
				level: "pass",
				area: "project",
				message: `${workspaceId}: the ${statuses.length} setting(s) kit ${kitName} needs are set`,
			});
		}
	}
	return findings;
}

/** Every model a kit sends work to on the Lemonade provider (every role, QA routes, tier candidates). */
export function listKitLemonadeModels(kit: KitDocument): string[] {
	return listKitProviderModels(kit, LEMONADE_PROVIDER_ID);
}

/** Every model a kit sends work to on `providerId` (every role, QA routes, tier candidates). */
export function listKitProviderModels(kit: KitDocument, providerId: string): string[] {
	const models = new Set<string>();
	const add = (provider: string | null | undefined, model: string | undefined) => {
		if (provider === providerId && model) {
			models.add(model);
		}
	};
	for (const role of listKitRoles(kit)) {
		add(role.model?.provider, role.model?.model);
	}
	for (const route of kit.qa?.routes ?? []) {
		add(route.provider, route.model);
	}
	for (const tier of Object.keys(kit.tiers ?? {})) {
		for (const entry of getUsableTierEntries(kit, tier)) {
			add(entry.provider, entry.model);
		}
	}
	return [...models];
}

function describeUnusable(model: string, listed: LemonadeModel | undefined): string | null {
	if (!listed) {
		return `${model} is not listed by Lemonade`;
	}
	if (!listed.downloaded) {
		return `${model} is listed but not downloaded`;
	}
	if (!listed.labels.includes(TOOL_CALLING_LABEL)) {
		return `${model} has no ${TOOL_CALLING_LABEL} label (Cline's Lemonade list leaves it out)`;
	}
	return null;
}

export async function checkKitLemonadeModels(
	context: KitSettingsCheckContext & { lemonadeModelList: LemonadeModelListSettings; fetch?: typeof fetch },
): Promise<DoctorFinding[]> {
	const kits = listProjectKits(context)
		.map((project) => ({ ...project, models: listKitLemonadeModels(project.kit) }))
		.filter((project) => project.models.length > 0);
	if (kits.length === 0) {
		return [];
	}
	const apiBaseUrl = lemonadeApiBaseUrl(context.lemonadeModelList.url);
	let listed: LemonadeModel[];
	try {
		listed = await fetchLemonadeModels(apiBaseUrl, context.fetch ?? fetch, LOCAL_PROVIDER_TIMEOUT_MS);
	} catch (error) {
		return [
			{
				level: "info",
				area: "project",
				message: `${kits.map(({ workspaceId }) => workspaceId).join(", ")}: kit models on Lemonade not checked, ${apiBaseUrl} did not answer (${error instanceof Error ? error.message : String(error)}); its cards wait in an outage hold while it is down`,
			},
		];
	}
	const byId = new Map(listed.map((model) => [model.id, model]));
	const maxLlm = await fetchLemonadeMaxLoadedLlms(apiBaseUrl, context.fetch ?? fetch, LOCAL_PROVIDER_TIMEOUT_MS).catch(
		() => null,
	);
	const findings: DoctorFinding[] = [];
	for (const { workspaceId, kitName, kit, models } of kits) {
		if (maxLlm !== null) {
			for (const finding of assessLocalResidency({
				kitName,
				workingSet: listKitLocalWorkingSet(kit),
				providerMaxLoaded: maxLlm,
				kanbanCapacity: context.config.models.providerCapacity[LEMONADE_PROVIDER_ID]?.maxLoadedModels,
			})) {
				findings.push({ ...finding, area: "project", message: `${workspaceId}: ${finding.message}` });
			}
		}
		const problems = models.flatMap((model) => describeUnusable(model, byId.get(model)) ?? []);
		findings.push(
			problems.length > 0
				? {
						level: "warn",
						area: "project",
						message: `${workspaceId}: kit ${kitName} routes to Lemonade models it can't run: ${problems.join("; ")}`,
						hint: `pull the model in Lemonade, or override the kit's model (kanban kit apply ${kitName} --project ${workspaceId} --set <key>=<model>)`,
					}
				: {
						level: "pass",
						area: "project",
						message: `${workspaceId}: Lemonade lists every model kit ${kitName} routes to (${models.length})`,
					},
		);
	}
	return findings;
}

export async function checkKitLocalAiModels(
	context: KitSettingsCheckContext & { fetch?: typeof fetch },
): Promise<DoctorFinding[]> {
	const kits = listProjectKits(context)
		.map((project) => ({ ...project, models: listKitProviderModels(project.kit, LOCALAI_PROVIDER_ID) }))
		.filter((project) => project.models.length > 0);
	if (kits.length === 0) {
		return [];
	}
	const workspaces = kits.map(({ workspaceId }) => workspaceId).join(", ");
	const url = await resolveConfiguredLocalAiUrl(context.config);
	if (!url) {
		return [
			{
				level: "warn",
				area: "project",
				message: `${workspaces}: kit models on LocalAI, but Kanban doesn't know LocalAI's URL (models.lists.localai.url, or Cline's localai provider), so Cline has no localai provider either`,
				hint: `${APPLY_LOCALAI_PROVIDER_COMMAND} --base-url <LocalAI URL>`,
			},
		];
	}
	let listed: LocalAiModel[];
	try {
		listed = await fetchLocalAiModels(url, context.fetch ?? fetch, LOCAL_PROVIDER_TIMEOUT_MS);
	} catch (error) {
		return [
			{
				level: "info",
				area: "project",
				message: `${workspaces}: kit models on LocalAI not checked, ${url} did not answer (${error instanceof Error ? error.message : String(error)}); its cards wait in an outage hold while it is down`,
			},
		];
	}
	const byId = new Map(listed.map((model) => [model.id, model]));
	const limit = await fetchLocalProviderLimit(LOCALAI_PROVIDER_ID, context.config, {
		fetch: context.fetch,
		timeoutMs: LOCAL_PROVIDER_TIMEOUT_MS,
	});
	const requireCapabilities = context.config.models.lists.localai.requireCapabilities;
	const findings: DoctorFinding[] = [];
	for (const { workspaceId, kitName, kit, models } of kits) {
		if (limit.kind === "known") {
			for (const finding of assessLocalResidency({
				kitName,
				provider: LOCALAI_PROVIDER_ID,
				workingSet: listKitLocalWorkingSet(kit, LOCALAI_PROVIDER_ID),
				providerMaxLoaded: limit.maxLoaded,
				kanbanCapacity: context.config.models.providerCapacity[LOCALAI_PROVIDER_ID]?.maxLoadedModels,
			})) {
				findings.push({ ...finding, area: "project", message: `${workspaceId}: ${finding.message}` });
			}
		}
		const problems = models.flatMap((model) => {
			const entry = byId.get(model);
			if (!entry) {
				return [`${model} is not listed by LocalAI`];
			}
			return isListedLocalAiModel(entry, requireCapabilities)
				? []
				: [`${model} lacks capability ${requireCapabilities.join(", ")} (Cline's LocalAI list leaves it out)`];
		});
		findings.push(
			problems.length > 0
				? {
						level: "warn",
						area: "project",
						message: `${workspaceId}: kit ${kitName} routes to LocalAI models it can't run: ${problems.join("; ")}`,
						hint: `install the model in LocalAI, or override the kit's model (kanban kit apply ${kitName} --project ${workspaceId} --set <key>=<model>)`,
					}
				: {
						level: "pass",
						area: "project",
						message: `${workspaceId}: LocalAI lists every model kit ${kitName} routes to (${models.length})`,
					},
		);
	}
	return findings;
}
