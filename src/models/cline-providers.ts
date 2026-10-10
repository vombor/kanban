// The one-provider policy for Cline models (`models.providers` in config.json) and the deprecated provider
// workarounds left in Cline's and Codex's settings. `kanban models providers` reports them (Kanban never edits Cline's
// files: it writes nothing under ~/.cline, user rule 2026-10-07);
// card creation (P3-5) asks `providerForModel` which provider a new card's model gets.
//
// Ported from archive/devteam-kit:lib/providers.cjs@6b61bfe and bin/providers.mjs@6b61bfe. Since the fork switch
// (10/06) every Cline model runs on native "bedrock" (Converse via cline 3.x); `fallback` lists models proven not
// to work there. The legacy kit's upstream-0.1.70 mapping (`legacyUpstream`) is gone: in-process there is only
// this Kanban. What counts as deprecated:
//   - a providers.json entry named in `models.providers.deprecated`, or one whose baseUrl is a Bedrock
//     OpenAI-compatible endpoint (Mantle): cline 3.x on openai-native fails against it (it sends OpenAI's
//     image_generation tool, 10/06);
//   - `lastUsedProvider` other than the default provider (the CLI's provider when a card names none);
//   - a models.json custom provider at a Mantle URL (or named `models.json:<id>` in `deprecated`);
//   - a Codex `[model_providers.*]` at a Mantle URL: reported only (it goes with the Codex retirement).
// Custom providers that point anywhere else (e.g. `lemonade`, the local Lemonade server) are normal providers.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PipelineConfig } from "../config/pipeline-config";
import { type EffectiveModelConfig, readClineDefaultModel } from "../core/effective-agent";
import { getClineModelsSettingsPath, getClineProvidersSettingsPath } from "../state/kanban-home";
import { getCodexConfigFilePath } from "../terminal/codex-workspace-trust";

export type ProvidersPolicy = PipelineConfig["models"]["providers"];

/** Bedrock's OpenAI-compatible endpoints ("Mantle"). */
export const BEDROCK_OPENAI_COMPAT_URL_PATTERN =
	/bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com\/openai\/v1|bedrock-mantle\.[a-z0-9-]+\.api\.aws/u;

const MODELS_JSON_DEPRECATED_PREFIX = "models.json:";
const MANTLE_NOTE =
	"points at a Bedrock OpenAI-compatible endpoint (Mantle); cline 3.x fails against it (it sends OpenAI's image_generation tool, 10/06)";

/** The provider a Cline card on `modelId` should use: its `fallback` entry, else the default provider. */
export function providerForModel(modelId: string | null | undefined, policy: ProvidersPolicy): string {
	const model = modelId?.trim();
	return (model ? policy.fallback[model] : undefined) ?? policy.default;
}

/** Plain provider ids in `deprecated` (keys like `models.json:x` or `codex:x` name other files). */
export function deprecatedProviderIds(policy: ProvidersPolicy): Set<string> {
	return new Set(Object.keys(policy.deprecated).filter((key) => !key.includes(":") && !key.includes(" ")));
}

export interface ProviderSettingsPaths {
	providersPath: string;
	modelsPath: string;
	codexConfigPath: string;
}

/** Cline's and Codex's settings files, honouring `agents.cline.dataDir` and `agents.codex.home`. */
export function getProviderSettingsPaths(config: PipelineConfig): ProviderSettingsPaths {
	const clineDataDir = config.agents.cline.dataDir;
	return {
		providersPath: getClineProvidersSettingsPath(clineDataDir),
		modelsPath: getClineModelsSettingsPath(clineDataDir),
		codexConfigPath: config.agents.codex.home
			? join(config.agents.codex.home, "config.toml")
			: getCodexConfigFilePath(),
	};
}

export interface DeprecatedProviderEntry {
	/** Provider id (`lastUsedProvider` for the default-provider setting, `codex:<id>` for Codex). */
	id: string;
	file: string;
	what: string;
	note: string;
	/** What to use instead; null when there is nothing to move to. */
	replacement: string | null;
	/** Reported only: cleanup never touches it. */
	keep: boolean;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readStringKey(value: unknown, key: string): string | null {
	const entry = isObject(value) ? value[key] : undefined;
	return typeof entry === "string" && entry.trim() ? entry.trim() : null;
}

interface ReadJsonFile {
	document: JsonObject | null;
	raw: string | null;
	/** Set when the file exists but is not a JSON object. */
	error: string | null;
}

async function readJsonFile(path: string): Promise<ReadJsonFile> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		const missing = isObject(error) && error.code === "ENOENT";
		return { document: null, raw: null, error: missing ? null : String(error) };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return isObject(parsed)
			? { document: parsed, raw, error: null }
			: { document: null, raw: null, error: "not a JSON object" };
	} catch (error) {
		return { document: null, raw: null, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Cline's providers.json as a parsed object, or null when it is missing or unreadable. */
export async function readClineProvidersFile(providersPath: string): Promise<JsonObject | null> {
	return (await readJsonFile(providersPath)).document;
}

/** Each agent's own default model where Kanban can read it: Cline's `lastUsedProvider` model (providers.json). */
export async function readAgentDefaultModels(
	clineDataDir: string | null,
): Promise<EffectiveModelConfig["agentDefaultModels"]> {
	const providers = await readClineProvidersFile(getClineProvidersSettingsPath(clineDataDir));
	return providers ? { cline: readClineDefaultModel(providers) } : {};
}

function providersOf(document: JsonObject | null): JsonObject {
	return isObject(document?.providers) ? document.providers : {};
}

function isDeprecatedClineProvider(id: string, entry: unknown, policy: ProvidersPolicy): boolean {
	const baseUrl = readStringKey(isObject(entry) ? entry.settings : undefined, "baseUrl") ?? "";
	return deprecatedProviderIds(policy).has(id) || BEDROCK_OPENAI_COMPAT_URL_PATTERN.test(baseUrl);
}

function isDeprecatedCustomProvider(id: string, entry: unknown, policy: ProvidersPolicy): boolean {
	const baseUrl = readStringKey(isObject(entry) ? entry.provider : undefined, "baseUrl") ?? "";
	return (
		Object.hasOwn(policy.deprecated, `${MODELS_JSON_DEPRECATED_PREFIX}${id}`) ||
		BEDROCK_OPENAI_COMPAT_URL_PATTERN.test(baseUrl)
	);
}

/** `[model_providers.<id>]` sections of Codex's config.toml whose base_url is a Mantle URL. */
export function findCodexMantleProviders(configToml: string): string[] {
	const found: string[] = [];
	let section: string | null = null;
	for (const line of configToml.split(/\r?\n/u)) {
		const header = /^\s*\[model_providers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/u.exec(line);
		if (header) {
			section = header[1] ?? header[2] ?? null;
			continue;
		}
		if (/^\s*\[/u.test(line)) {
			section = null;
			continue;
		}
		const baseUrl = /^\s*base_url\s*=\s*["']([^"']*)["']/u.exec(line)?.[1];
		if (section && baseUrl && BEDROCK_OPENAI_COMPAT_URL_PATTERN.test(baseUrl) && !found.includes(section)) {
			found.push(section);
		}
	}
	return found;
}

export async function findDeprecatedProviderEntries(
	paths: ProviderSettingsPaths,
	policy: ProvidersPolicy,
): Promise<DeprecatedProviderEntry[]> {
	const entries: DeprecatedProviderEntry[] = [];
	const providersFile = (await readJsonFile(paths.providersPath)).document;
	for (const [id, entry] of Object.entries(providersOf(providersFile))) {
		if (!isDeprecatedClineProvider(id, entry, policy)) {
			continue;
		}
		const settings = isObject(entry) ? entry.settings : undefined;
		entries.push({
			id,
			file: paths.providersPath,
			what: `providers.${id} (${readStringKey(settings, "provider") ?? "-"}, baseUrl ${readStringKey(settings, "baseUrl") ?? "-"})`,
			note: policy.deprecated[id] ?? MANTLE_NOTE,
			replacement: policy.default,
			keep: false,
		});
	}
	const lastUsedProvider = readStringKey(providersFile, "lastUsedProvider");
	if (lastUsedProvider && lastUsedProvider !== policy.default) {
		entries.push({
			id: "lastUsedProvider",
			file: paths.providersPath,
			what: `lastUsedProvider = ${lastUsedProvider}`,
			note: "the Cline CLI's provider when a card names none",
			replacement: policy.default,
			keep: false,
		});
	}
	const modelsFile = (await readJsonFile(paths.modelsPath)).document;
	for (const [id, entry] of Object.entries(providersOf(modelsFile))) {
		if (!isDeprecatedCustomProvider(id, entry, policy)) {
			continue;
		}
		const provider = isObject(entry) ? entry.provider : undefined;
		const protocol = readStringKey(provider, "protocol");
		entries.push({
			id,
			file: paths.modelsPath,
			what: `custom provider ${id} (baseUrl ${readStringKey(provider, "baseUrl") ?? "-"}${protocol ? `, ${protocol}` : ""})`,
			note: policy.deprecated[`${MODELS_JSON_DEPRECATED_PREFIX}${id}`] ?? MANTLE_NOTE,
			replacement: policy.default,
			keep: false,
		});
	}
	const codexToml = await readFile(paths.codexConfigPath, "utf8").catch(() => null);
	for (const id of codexToml ? findCodexMantleProviders(codexToml) : []) {
		entries.push({
			id: `codex:${id}`,
			file: paths.codexConfigPath,
			what: `Codex model_providers.${id} (Bedrock OpenAI-compatible endpoint)`,
			note:
				policy.deprecated[`codex:${id}`] ??
				"Codex's own provider setting; left alone (it goes with the Codex retirement)",
			replacement: null,
			keep: true,
		});
	}
	return entries;
}

export interface ProviderCleanupEdit {
	file: string;
	description: string;
}

export interface ProviderCleanupResult {
	/** The edits to make by hand: Kanban writes nothing under ~/.cline (user rule, 2026-10-07). */
	edits: ProviderCleanupEdit[];
	/** Entries reported but never to be edited (Codex). */
	kept: DeprecatedProviderEntry[];
	/** Files that could not be read as JSON. */
	errors: string[];
}

/**
 * Lists the edits that remove the deprecated Cline providers, point `lastUsedProvider` at the default provider and
 * remove the Mantle custom providers from models.json. Read-only: the files are Cline's, so the user makes the edits
 * (or uses `cline auth`); Codex's config is only reported.
 */
export async function planDeprecatedProviderCleanup(options: {
	paths: ProviderSettingsPaths;
	policy: ProvidersPolicy;
}): Promise<ProviderCleanupResult> {
	const { paths, policy } = options;
	const providersRead = await readJsonFile(paths.providersPath);
	const modelsRead = await readJsonFile(paths.modelsPath);
	const errors = [
		...(providersRead.error ? [`${paths.providersPath}: ${providersRead.error}`] : []),
		...(modelsRead.error ? [`${paths.modelsPath}: ${modelsRead.error}`] : []),
	];
	const edits: ProviderCleanupEdit[] = [];
	if (providersRead.document) {
		for (const [id, entry] of Object.entries(providersOf(providersRead.document))) {
			if (isDeprecatedClineProvider(id, entry, policy)) {
				edits.push({ file: paths.providersPath, description: `delete providers.${id}` });
			}
		}
		const lastUsedProvider = readStringKey(providersRead.document, "lastUsedProvider");
		if (lastUsedProvider && lastUsedProvider !== policy.default) {
			edits.push({
				file: paths.providersPath,
				description: `lastUsedProvider: ${lastUsedProvider} -> ${policy.default}`,
			});
		}
	}
	if (modelsRead.document) {
		for (const [id, entry] of Object.entries(providersOf(modelsRead.document))) {
			if (isDeprecatedCustomProvider(id, entry, policy)) {
				const baseUrl = readStringKey(isObject(entry) ? entry.provider : undefined, "baseUrl") ?? "-";
				edits.push({ file: paths.modelsPath, description: `delete custom provider ${id} (${baseUrl})` });
			}
		}
	}
	const kept = (await findDeprecatedProviderEntries(paths, policy)).filter((entry) => entry.keep);
	return { edits, kept, errors };
}
