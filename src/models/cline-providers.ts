// The one-provider policy for Cline models (`models.providers` in config.json) and the deprecated provider
// workarounds left in Cline's and Codex's settings. `kanban models providers` reports and cleans them up;
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
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { PipelineConfig } from "../config/pipeline-config";

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
	edits: ProviderCleanupEdit[];
	/** Entries reported but never edited (Codex). */
	kept: DeprecatedProviderEntry[];
	applied: boolean;
	backupDir: string | null;
	/** Files that could not be read as JSON; nothing in them is edited. */
	errors: string[];
}

function backupTimestamp(now: Date): string {
	return now.toISOString().replace(/[-:.]/gu, "");
}

async function writeJsonKeepingMode(path: string, document: JsonObject, fallbackMode: number): Promise<void> {
	const mode = await stat(path).then(
		(info) => info.mode & 0o7777,
		() => fallbackMode,
	);
	const tempPath = `${path}.tmp.${process.pid}.${Date.now()}`;
	await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode });
	await chmod(tempPath, mode);
	await rename(tempPath, path);
}

/**
 * Removes the deprecated Cline providers, points `lastUsedProvider` at the default provider and removes the Mantle
 * custom providers from models.json. Dry run unless `apply`; `apply` copies both files to
 * `<backupsRoot>/cline-settings-<ts>/` first. Codex's config is never edited.
 */
export async function cleanupDeprecatedProviders(options: {
	paths: ProviderSettingsPaths;
	policy: ProvidersPolicy;
	apply: boolean;
	backupsRoot: string;
	now?: Date;
}): Promise<ProviderCleanupResult> {
	const { paths, policy } = options;
	const providersRead = await readJsonFile(paths.providersPath);
	const modelsRead = await readJsonFile(paths.modelsPath);
	const errors = [
		...(providersRead.error ? [`${paths.providersPath}: ${providersRead.error}`] : []),
		...(modelsRead.error ? [`${paths.modelsPath}: ${modelsRead.error}`] : []),
	];
	const edits: ProviderCleanupEdit[] = [];
	const providersDocument = providersRead.document ? structuredClone(providersRead.document) : null;
	const modelsDocument = modelsRead.document ? structuredClone(modelsRead.document) : null;

	if (providersDocument) {
		const providers = providersOf(providersDocument);
		for (const [id, entry] of Object.entries(providers)) {
			if (isDeprecatedClineProvider(id, entry, policy)) {
				delete providers[id];
				edits.push({ file: paths.providersPath, description: `delete providers.${id}` });
			}
		}
		const lastUsedProvider = readStringKey(providersDocument, "lastUsedProvider");
		if (lastUsedProvider && lastUsedProvider !== policy.default) {
			providersDocument.lastUsedProvider = policy.default;
			edits.push({
				file: paths.providersPath,
				description: `lastUsedProvider: ${lastUsedProvider} -> ${policy.default}`,
			});
		}
	}
	if (modelsDocument) {
		const providers = providersOf(modelsDocument);
		for (const [id, entry] of Object.entries(providers)) {
			if (isDeprecatedCustomProvider(id, entry, policy)) {
				const baseUrl = readStringKey(isObject(entry) ? entry.provider : undefined, "baseUrl") ?? "-";
				delete providers[id];
				edits.push({ file: paths.modelsPath, description: `delete custom provider ${id} (${baseUrl})` });
			}
		}
	}
	const kept = (await findDeprecatedProviderEntries(paths, policy)).filter((entry) => entry.keep);
	if (!options.apply || edits.length === 0) {
		return { edits, kept, applied: false, backupDir: null, errors };
	}

	const backupDir = join(options.backupsRoot, `cline-settings-${backupTimestamp(options.now ?? new Date())}`);
	await mkdir(backupDir, { recursive: true, mode: 0o700 });
	const touched = new Set(edits.map((edit) => edit.file));
	for (const file of touched) {
		await copyFile(file, join(backupDir, basename(file)));
	}
	if (providersDocument && touched.has(paths.providersPath)) {
		await writeJsonKeepingMode(paths.providersPath, providersDocument, 0o600);
	}
	if (modelsDocument && touched.has(paths.modelsPath)) {
		await writeJsonKeepingMode(paths.modelsPath, modelsDocument, 0o644);
	}
	return { edits, kept, applied: true, backupDir, errors };
}
