// `kanban setup-provider <id>` for an OpenAI-compatible provider of config.json (`providers.openaiCompatible.<id>`,
// src/config/openai-compatible-providers-config.ts): Cline's custom provider `<id>`, computed from the config and what
// the server reports, compared with Cline's files, and written only when the user runs the
// command. Doctor's row (src/doctor/openai-compatible-provider-checks.ts) prints the same plan.
//
// Two files, as cline 3.0.70's TUI needs them for a keyless custom provider (real TUI runs, 2026-10-11 against LocalAI
// and 2026-10-12 against the user's Triton router, in throwaway CLINE_DIR/CLINE_DATA_DIR):
//   - models.json `providers.<id>`: `provider` = name, baseUrl, protocol "openai-chat", defaultModelId (and
//     capabilities ["tools"] for a new entry, as Lemonade's has); Cline's schema needs name and baseUrl, no key;
//   - providers.json `providers.<id>.settings` = provider, baseUrl, model (and apiKey from `apiKeyEnv` when the config
//     names one): without a stored baseUrl and model the TUI opens its sign-in screen and never takes the card's
//     prompt; models.json's baseUrl doesn't count.
// models.json's model list is the orchestrator's (it is Cline's allow list): the command never adds or removes a model
// and drops a `modelsSourceUrl` (Cline would offer every id it returns), as every provider write does. For each model the entry already has it fills in the metadata: the context
// window from the config (`models.<model>.contextWindow`), else the server's model list, else the window the entry
// already has, else OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW; maxTokens from the config, else a quarter of the window
// (at most 32K) unless the entry keeps its own window and maxTokens; zero prices for a local provider. Every other key
// is kept. With the server down, only the config's windows are applied. Each file is backed up into
// `<home>/backups/cline/` first and replaced atomically (cline-file-write.ts); only `providers.<id>` of each changes.
// A key is never printed.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { OpenAiCompatibleProviderSettings } from "../config/openai-compatible-providers-config";
import { quoteShellArg } from "../core/shell";
import {
	fetchOpenAiCompatibleModels,
	OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW,
	type OpenAiCompatibleModel,
	resolveProviderApiKey,
} from "../models/openai-compatible-providers";
import { readClineProvidersFile } from "./cline-bedrock-key";
import { backupClineFile, getClineBackupDir, replaceClineFileAtomically } from "./cline-file-write";
import {
	maxTokensForContextWindow,
	readStoredModels,
	type StoredModelEntry,
	type StoredModels,
	storedContextWindow,
} from "./cline-lemonade-models";
import { readClineProviderEntry } from "./cline-models-source";

/** The `version` of a models.json or providers.json the command creates (cline 3.0.70's schemas: literal 1). */
const CLINE_FILE_VERSION = 1;
const SECRET_SETTING_KEYS = ["apiKey"];

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function formatValue(key: string, value: unknown): string {
	if (value === undefined) {
		return "(unset)";
	}
	return SECRET_SETTING_KEYS.includes(key) ? "(a key)" : JSON.stringify(value);
}

function describeKeyChanges(prefix: string, current: JsonObject | null, desired: JsonObject): string[] {
	return [...new Set([...Object.keys(current ?? {}), ...Object.keys(desired)])]
		.filter((key) => !sameJson(current?.[key], desired[key]))
		.map((key) => `${prefix}.${key}: ${formatValue(key, current?.[key])} -> ${formatValue(key, desired[key])}`);
}

/** Where a model's window comes from. */
export type ContextWindowSource = "config" | "server" | "models.json" | "default";

export interface ModelMetadataUpdate {
	id: string;
	contextWindow: number;
	maxTokens: number;
	source: ContextWindowSource;
	/** The server's field, for `server`. */
	field: string | null;
}

/**
 * The window and maxTokens for one model already in models.json; null when nothing is known with the server down
 * (the entry stays as it is).
 */
export function resolveModelMetadata(input: {
	id: string;
	existing: StoredModelEntry;
	provider: OpenAiCompatibleProviderSettings;
	/** The server's list; null when it didn't answer. */
	listed: readonly OpenAiCompatibleModel[] | null;
}): ModelMetadataUpdate | null {
	const override = input.provider.models[input.id];
	const reported = input.listed?.find((model) => model.id === input.id)?.contextWindow ?? null;
	const ownWindow = storedContextWindow(input.existing);
	const ownMaxTokens = typeof input.existing.maxTokens === "number" ? input.existing.maxTokens : null;
	if (override) {
		return {
			id: input.id,
			contextWindow: override.contextWindow,
			maxTokens: override.maxTokens ?? maxTokensForContextWindow(override.contextWindow),
			source: "config",
			field: null,
		};
	}
	if (reported) {
		return {
			id: input.id,
			contextWindow: reported.tokens,
			maxTokens: maxTokensForContextWindow(reported.tokens),
			source: "server",
			field: reported.field,
		};
	}
	if (ownWindow !== null) {
		return {
			id: input.id,
			contextWindow: ownWindow,
			maxTokens: ownMaxTokens ?? maxTokensForContextWindow(ownWindow),
			source: "models.json",
			field: null,
		};
	}
	if (!input.listed) {
		return null;
	}
	return {
		id: input.id,
		contextWindow: OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW,
		maxTokens: maxTokensForContextWindow(OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW),
		source: "default",
		field: null,
	};
}

function describeSource(update: ModelMetadataUpdate, providerId: string): string {
	switch (update.source) {
		case "config":
			return `providers.openaiCompatible.${providerId}.models in config.json`;
		case "server":
			return `the server's ${update.field}`;
		case "models.json":
			return "the window models.json already has";
		case "default":
			return `the server reports none: Kanban's default ${OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW}; set providers.openaiCompatible.${providerId}.models.${update.id}.contextWindow to change it`;
	}
}

interface PlannedFile {
	path: string;
	/** The file as read; null when there is none (the command creates it). */
	raw: string | null;
	/** The whole file as it should be. */
	next: JsonObject;
}

export interface OpenAiCompatibleProviderPlan {
	/** `error`: an unreadable file; `refused`: the config names a key the environment doesn't hold. */
	kind: "ok" | "error" | "refused";
	/** Cline has neither entry yet (doctor: the provider isn't set up). */
	absent: boolean;
	/** Nothing would change in either file. */
	inSync: boolean;
	/** Why the server's models couldn't be read; null when it answered. */
	unreachable: string | null;
	/** Why Cline's TUI would still open its sign-in screen after the write (no model to store); null when it won't. */
	signInGap: string | null;
	/** What would change, then notes, one line each. */
	changes: string[];
	notes: string[];
	files: PlannedFile[];
}

export interface OpenAiCompatibleProviderOptions {
	providerId: string;
	provider: OpenAiCompatibleProviderSettings;
	modelsPath: string;
	providersPath: string;
	/** Where `apiKeyEnv` is read; never printed. */
	env: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
	timeoutMs?: number;
	now?: Date;
}

function emptyPlan(kind: "error" | "refused", notes: string[]): OpenAiCompatibleProviderPlan {
	return { kind, absent: false, inSync: false, unreachable: null, signInGap: null, changes: [], notes, files: [] };
}

/** Compares Cline's `<id>` entries (models.json, providers.json) with the config and the server. Never writes. */
export async function planClineOpenAiCompatibleProvider(
	options: OpenAiCompatibleProviderOptions,
): Promise<OpenAiCompatibleProviderPlan> {
	const { providerId, provider } = options;
	const read = await readClineProviderEntry(options.modelsPath, providerId);
	if (read.kind === "error") {
		return emptyPlan("error", [`models.json: ${read.detail}`]);
	}
	const providersRead = await readClineProvidersFile(options.providersPath);
	if (providersRead.kind === "invalid") {
		return emptyPlan("error", [`providers.json: ${providersRead.detail}`]);
	}
	const apiKey = resolveProviderApiKey(provider, options.env);
	if (provider.apiKeyEnv && !apiKey) {
		return emptyPlan("refused", [
			`providers.openaiCompatible.${providerId}.apiKeyEnv names ${provider.apiKeyEnv}, which Kanban's environment doesn't hold`,
		]);
	}

	let listed: OpenAiCompatibleModel[] | null = null;
	let unreachable: string | null = null;
	try {
		listed = await fetchOpenAiCompatibleModels(provider, {
			fetch: options.fetch,
			timeoutMs: options.timeoutMs,
			env: options.env,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		unreachable = `${provider.baseUrl}/models did not answer (${message}): only config.json's context windows are applied`;
	}

	const found = read.kind === "found" ? read : null;
	const modelsRaw = found?.raw ?? (await readFile(options.modelsPath, "utf8").catch(() => null));
	let modelsDocument: JsonObject | null = found?.document ?? null;
	if (!modelsDocument && modelsRaw !== null) {
		const parsed: unknown = JSON.parse(modelsRaw);
		modelsDocument = isObject(parsed) ? parsed : null;
	}
	const currentEntry = found?.entry ?? null;
	const currentProvider = isObject(currentEntry?.provider) ? currentEntry.provider : null;
	const stored = readStoredModels(currentEntry?.models);
	const modelIds = Object.keys(stored.models);

	const notes: string[] = [];
	const models: StoredModels = {};
	for (const id of modelIds) {
		const existing = stored.models[id] ?? {};
		const update = resolveModelMetadata({ id, existing, provider, listed });
		const next: StoredModelEntry = { ...existing, id, name: typeof existing.name === "string" ? existing.name : id };
		if (update) {
			next.contextWindow = update.contextWindow;
			next.maxTokens = update.maxTokens;
			if (!sameJson(existing.contextWindow, next.contextWindow) || !sameJson(existing.maxTokens, next.maxTokens)) {
				notes.push(`model ${id}: context ${update.contextWindow} from ${describeSource(update, providerId)}`);
			}
		}
		if (provider.local) {
			next.inputPrice ??= 0;
			next.outputPrice ??= 0;
		}
		models[id] = next;
	}

	const currentDefault = typeof currentProvider?.defaultModelId === "string" ? currentProvider.defaultModelId : null;
	// A model the file names stays while the entry has no models to choose from.
	const keeps = (id: string | null): id is string => Boolean(id && (modelIds.length === 0 || modelIds.includes(id)));
	const defaultModelId = keeps(currentDefault) ? currentDefault : (modelIds[0] ?? null);
	const { defaultModelId: _oldDefault, modelsSourceUrl: _source, ...providerRest } = currentProvider ?? {};
	const desiredProvider: JsonObject = {
		...providerRest,
		name: provider.name,
		baseUrl: provider.baseUrl,
		...(defaultModelId ? { defaultModelId } : {}),
		protocol: "openai-chat",
		// Only for a new entry: Cline's own model picker drops the key from an entry (2026-10-11), and putting it back on
		// every run would make doctor report a difference forever.
		...(currentProvider ? {} : { capabilities: ["tools"] }),
	};
	const entry: JsonObject = { ...currentEntry, provider: desiredProvider, models };

	const document = providersRead.kind === "found" ? providersRead.document : null;
	const providersEntry = isObject(document?.providers) ? document.providers[providerId] : undefined;
	const currentSettings =
		isObject(providersEntry) && isObject(providersEntry.settings) ? providersEntry.settings : null;
	const currentModel = typeof currentSettings?.model === "string" ? currentSettings.model : null;
	const model = keeps(currentModel) ? currentModel : defaultModelId;
	const { model: _oldModel, ...settingsRest } = currentSettings ?? {};
	const settings: JsonObject = {
		...settingsRest,
		provider: providerId,
		...(model ? { model } : {}),
		baseUrl: provider.baseUrl,
		...(apiKey ? { apiKey } : {}),
	};

	const modelsChanges = [
		...(stored.form === "list"
			? ["models is a list, which cline 3.x rejects (it drops the provider): rewrite as a record"]
			: []),
		...describeKeyChanges("models.json provider", currentProvider, desiredProvider),
		...modelIds.flatMap((id) =>
			describeKeyChanges(`models.json model ${id}`, stored.models[id] ?? null, models[id] ?? {}),
		),
	];
	const providersChanges = describeKeyChanges("providers.json settings", currentSettings, settings);

	const files: PlannedFile[] = [];
	if (modelsChanges.length > 0 || !found) {
		const next = modelsDocument ? { ...modelsDocument } : { version: CLINE_FILE_VERSION, providers: {} };
		next.providers = { ...(isObject(next.providers) ? next.providers : {}), [providerId]: entry };
		files.push({ path: options.modelsPath, raw: modelsRaw, next });
	}
	if (providersChanges.length > 0) {
		const next = document ? { ...document } : { version: CLINE_FILE_VERSION, modes: {}, providers: {} };
		const providers = isObject(next.providers) ? next.providers : {};
		const currentFields = isObject(providersEntry) ? providersEntry : {};
		next.providers = {
			...providers,
			[providerId]: {
				...currentFields,
				settings,
				updatedAt: (options.now ?? new Date()).toISOString(),
				tokenSource: typeof currentFields.tokenSource === "string" ? currentFields.tokenSource : "manual",
			},
		};
		files.push({
			path: options.providersPath,
			raw: providersRead.kind === "found" ? providersRead.raw : null,
			next,
		});
	}

	if (listed) {
		const listedIds = new Set(listed.map((entry) => entry.id));
		const unlisted = modelIds.filter((id) => !listedIds.has(id));
		if (unlisted.length > 0) {
			notes.push(`the server doesn't list ${unlisted.join(", ")} (kept in models.json: the orchestrator's list)`);
		}
		const notInModels = listed.map((entry) => entry.id).filter((id) => !(id in stored.models));
		if (notInModels.length > 0) {
			notes.push(
				`the server also lists ${notInModels.join(", ")}, not in models.json (the orchestrator adds the ones cards may use)`,
			);
		}
	}
	const configOnly = Object.keys(provider.models).filter((id) => !(id in stored.models));
	if (configOnly.length > 0) {
		notes.push(
			`config.json sets a window for ${configOnly.join(", ")}, which models.json's ${providerId} entry doesn't have: nothing written for it`,
		);
	}
	const signInGap = model
		? null
		: `models.json's ${providerId} entry has no models and providers.json names none, so Cline's TUI opens its sign-in screen for ${providerId} cards: the orchestrator adds a model to models.json, then the command runs again`;

	return {
		kind: "ok",
		absent: found === null && currentSettings === null,
		inSync: files.length === 0,
		unreachable,
		signInGap,
		changes: [...modelsChanges, ...providersChanges],
		notes: [...(unreachable ? [unreachable] : []), ...notes, ...(signInGap ? [signInGap] : [])],
		files,
	};
}

export interface ApplyOpenAiCompatibleProviderOptions extends OpenAiCompatibleProviderOptions {
	/** Default: `<home>/backups/cline`. */
	backupDir?: string;
	dryRun: boolean;
}

export interface ApplyOpenAiCompatibleProviderResult {
	status: "in-sync" | "written" | "would-write" | "refused" | "error";
	lines: string[];
	/** One per file replaced; a file the command created has none. */
	backupPaths: string[];
	rollback: string | null;
}

/** Writes Cline's `providers.<id>` of models.json and providers.json from the plan; nothing else changes. */
export async function applyClineOpenAiCompatibleProvider(
	options: ApplyOpenAiCompatibleProviderOptions,
): Promise<ApplyOpenAiCompatibleProviderResult> {
	const plan = await planClineOpenAiCompatibleProvider(options);
	const lines = [...plan.changes, ...plan.notes];
	if (plan.kind !== "ok") {
		return { status: plan.kind, lines, backupPaths: [], rollback: null };
	}
	if (plan.inSync) {
		return { status: "in-sync", lines: [...lines, "provider and models in sync"], backupPaths: [], rollback: null };
	}
	if (options.dryRun) {
		return { status: "would-write", lines, backupPaths: [], rollback: null };
	}
	// The server may take seconds; never overwrite an edit made meanwhile.
	for (const file of plan.files) {
		if ((await readFile(file.path, "utf8").catch(() => null)) !== file.raw) {
			return {
				status: "error",
				lines: [
					...lines,
					`${file.path} changed while the server was asked; nothing written, run the command again`,
				],
				backupPaths: [],
				rollback: null,
			};
		}
	}
	const backupPaths: string[] = [];
	const rollbacks: string[] = [];
	for (const file of plan.files) {
		const content = `${JSON.stringify(file.next, null, 2)}\n`;
		if (file.raw === null) {
			// No such file yet: Cline's settings can hold API keys, so the new file is private like Cline's own.
			await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
			await writeFile(file.path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
			rollbacks.push(`rm ${quoteShellArg(file.path)}`);
			continue;
		}
		const backupPath = await backupClineFile({
			path: file.path,
			raw: file.raw,
			backupDir: options.backupDir ?? getClineBackupDir(),
			now: options.now ?? new Date(),
		});
		backupPaths.push(backupPath);
		rollbacks.push(`cp ${quoteShellArg(backupPath)} ${quoteShellArg(file.path)}`);
		await replaceClineFileAtomically(file.path, content);
	}
	return { status: "written", lines, backupPaths, rollback: rollbacks.join(" && ") };
}
