// `kanban cline apply-localai-provider`: Cline's `localai` custom provider in models.json, computed from what LocalAI
// reports now, compared with what the file has, and written only when the user runs the command (Kanban writes
// nothing under ~/.cline on its own, user rule 2026-10-07; doctor prints the differences and this command line).
//
// Two files, verified with real TUI runs of cline 3.0.70 against LocalAI in a throwaway CLINE_DIR (2026-10-11):
//   - models.json `providers.localai` declares the provider (schema: `provider.name` and `baseUrl` required; no key
//     needed, Cline sends no Authorization header without one);
//   - providers.json `providers.localai.settings` = { provider, model, baseUrl }: without a stored baseUrl and model
//     Cline's TUI opens its sign-in screen and never takes the card's prompt (models.json's baseUrl doesn't count;
//     `cline auth` can't store a provider without an API key, so the command writes it). Only those three settings
//     are Kanban's; `lastUsedProvider` and every other provider stay.
// The models.json entry is the Lemonade entry's shape (see src/setup/cline-lemonade-models.ts for the schema facts):
//   provider: name, baseUrl (LocalAI's /v1), modelsSourceUrl (Kanban's /api/model-lists/localai), defaultModelId,
//             protocol "openai-chat", capabilities ["tools"];
//   models:   a record by id with contextWindow (LocalAI's `context_size`), maxTokens, supportsVision ("vision"),
//             supportsReasoning ("thinking"/"reasoning") and zero prices, for every model LocalAI lists as a chat
//             model; other keys of a model are kept, models LocalAI no longer lists are dropped.
// Keys of the provider the user added (headers, an apiKey, ...) are kept; a modelsSourceUrl pointing somewhere Kanban
// doesn't manage is left alone, as for Lemonade. With LocalAI down nothing about its models changes. Unlike the
// Lemonade command it creates the entry (and models.json) when there is none: that is how LocalAI is set up.
// Cline's model picker rewrites the entry when it opens (adds `client`, `discoveredModelIds`, drops
// `capabilities`): keys Kanban doesn't set are kept, so that is no difference. Only `providers.localai` of each file
// changes; each file is backed up into `<home>/backups/cline/` first and replaced atomically (cline-file-write.ts). No context sync: LocalAI's `context_size` is the configured one, not read back from the
// loaded backend, so the user's command is the only writer.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
	fetchLocalAiModels,
	isListedLocalAiModel,
	type LocalAiModel,
	localAiApiBaseUrl,
	localAiRootUrl,
} from "../models/localai-models";
import { LOCALAI_MODEL_LIST_PATH } from "../server/model-lists-route";
import { backupClineFile, getClineBackupDir, replaceClineFileAtomically } from "./cline-file-write";
import {
	diffLemonadeModels,
	type LemonadeModelsDiff,
	maxTokensForContextWindow,
	readStoredModels,
	type StoredModelEntry,
	type StoredModels,
} from "./cline-lemonade-models";
import { readClineProviderEntry } from "./cline-models-source";

export const CLINE_LOCALAI_PROVIDER_ID = "localai";
export const APPLY_LOCALAI_PROVIDER_COMMAND = "kanban cline apply-localai-provider";
export const DEFAULT_LOCALAI_PROVIDER_NAME = "LocalAI";

/** The `version` of a models.json or providers.json the command creates (cline 3.0.70's schemas: literal 1). */
const CLINE_FILE_VERSION = 1;
const LOCALAI_TIMEOUT_MS = 4_000;
const REASONING_CAPABILITIES = ["thinking", "reasoning"];

/** The exact command line doctor prints: the user's to run. */
export function formatApplyLocalAiProviderCommand(input: { baseUrl: string; origin: string }): string {
	return `${APPLY_LOCALAI_PROVIDER_COMMAND} --base-url ${localAiRootUrl(input.baseUrl)} --origin ${new URL(input.origin).origin}`;
}

/** The model-lists route's URL on a Kanban server origin. */
export function buildLocalAiModelListUrl(origin: string): string {
	return `${new URL(origin).origin}${LOCALAI_MODEL_LIST_PATH}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isManagedLocalAiSourceUrl(url: string): boolean {
	try {
		return new URL(url).pathname.replace(/\/+$/u, "") === LOCALAI_MODEL_LIST_PATH;
	} catch {
		return false;
	}
}

/** The wanted models record: `current` with LocalAI's metadata for every listed model; with no list, `current`. */
export function buildDesiredLocalAiModels(current: StoredModels, listed: readonly LocalAiModel[] | null): StoredModels {
	if (!listed) {
		return { ...current };
	}
	const models: StoredModels = {};
	for (const model of listed) {
		const existing = current[model.id];
		const next: StoredModelEntry = {
			...existing,
			id: model.id,
			name: typeof existing?.name === "string" ? existing.name : model.id,
		};
		if (model.contextSize !== null) {
			next.contextWindow = model.contextSize;
			next.maxTokens = maxTokensForContextWindow(model.contextSize);
		}
		if (model.capabilities !== null) {
			next.supportsVision = model.capabilities.includes("vision");
			next.supportsReasoning = REASONING_CAPABILITIES.some((name) => model.capabilities?.includes(name));
		}
		next.inputPrice ??= 0;
		next.outputPrice ??= 0;
		models[model.id] = next;
	}
	return models;
}

/** The wanted `provider` object: the file's own keys plus Kanban's. */
export function buildDesiredLocalAiProvider(input: {
	current: Record<string, unknown> | null;
	baseUrl: string;
	modelListUrl: string;
	name?: string;
	modelIds: readonly string[];
}): Record<string, unknown> {
	const current = input.current ?? {};
	const currentSource = typeof current.modelsSourceUrl === "string" ? current.modelsSourceUrl.trim() : "";
	const currentDefault = typeof current.defaultModelId === "string" ? current.defaultModelId : null;
	const defaultModelId =
		currentDefault && (input.modelIds.length === 0 || input.modelIds.includes(currentDefault))
			? currentDefault
			: (input.modelIds[0] ?? currentDefault);
	return {
		...current,
		name: input.name ?? (typeof current.name === "string" ? current.name : DEFAULT_LOCALAI_PROVIDER_NAME),
		baseUrl: localAiApiBaseUrl(input.baseUrl),
		modelsSourceUrl: currentSource && !isManagedLocalAiSourceUrl(currentSource) ? currentSource : input.modelListUrl,
		...(defaultModelId ? { defaultModelId } : {}),
		protocol: "openai-chat",
		// Only for a new provider: Cline's own model picker drops the key from an entry (2026-10-11), and putting it back
		// on every run would make doctor report a difference forever.
		...(input.current ? {} : { capabilities: ["tools"] }),
	};
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function formatValue(value: unknown): string {
	return value === undefined ? "(unset)" : JSON.stringify(value);
}

function describeModelsDiff(diff: LemonadeModelsDiff, desired: StoredModels): string[] {
	const describeAdded = (id: string) => {
		const entry = desired[id] ?? {};
		const features = [entry.supportsVision ? "vision" : null, entry.supportsReasoning ? "reasoning" : null].filter(
			Boolean,
		);
		const context =
			typeof entry.contextWindow === "number"
				? `context ${entry.contextWindow} (LocalAI context_size), maxTokens ${entry.maxTokens}`
				: "no context_size from LocalAI; Cline's 128000 default";
		return `model ${id}: add, ${context}${features.length > 0 ? `, ${features.join(", ")}` : ""}`;
	};
	return [
		...(diff.listForm
			? ["models is a list, which cline 3.x rejects (it drops the provider): rewrite as a record"]
			: []),
		...diff.added.map(describeAdded),
		...diff.changed.map(
			({ id, fields }) =>
				`model ${id}: ${fields.map((field) => `${field.key} ${formatValue(field.from)} -> ${formatValue(field.to)}`).join(", ")}`,
		),
		...diff.removed.map((id) => `model ${id}: remove (LocalAI no longer lists it)`),
	];
}

/** Cline's providers.json as read: the file, and the `localai` settings in it. */
type ProvidersFileRead =
	| { kind: "error"; detail: string }
	| {
			kind: "ok";
			raw: string | null;
			document: Record<string, unknown> | null;
			settings: Record<string, unknown> | null;
	  };

async function readProvidersFile(providersPath: string): Promise<ProvidersFileRead> {
	const raw = await readFile(providersPath, "utf8").catch((error: unknown) =>
		error && typeof error === "object" && "code" in error && error.code === "ENOENT" ? null : error,
	);
	if (raw !== null && typeof raw !== "string") {
		return { kind: "error", detail: `providers.json: could not read it: ${String(raw)}` };
	}
	if (raw === null) {
		return { kind: "ok", raw: null, document: null, settings: null };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { kind: "error", detail: `providers.json: not valid JSON (${message}); left alone.` };
	}
	if (!isObject(parsed)) {
		return { kind: "error", detail: "providers.json: not a JSON object; left alone." };
	}
	const providers = isObject(parsed.providers) ? parsed.providers : {};
	const entry = providers[CLINE_LOCALAI_PROVIDER_ID];
	const settings = isObject(entry) && isObject(entry.settings) ? entry.settings : null;
	return { kind: "ok", raw, document: parsed, settings };
}

/** The settings Cline's TUI needs: the file's own plus provider, baseUrl and a model LocalAI still lists. */
export function buildDesiredLocalAiSettings(input: {
	current: Record<string, unknown> | null;
	baseUrl: string;
	defaultModelId: string | null;
	modelIds: readonly string[];
}): Record<string, unknown> {
	const current = input.current ?? {};
	const currentModel = typeof current.model === "string" && current.model.trim() ? current.model : null;
	const model =
		currentModel && (input.modelIds.length === 0 || input.modelIds.includes(currentModel))
			? currentModel
			: input.defaultModelId;
	return {
		...current,
		provider: CLINE_LOCALAI_PROVIDER_ID,
		...(model ? { model } : {}),
		baseUrl: localAiApiBaseUrl(input.baseUrl),
	};
}

function describeKeyChanges(
	prefix: string,
	current: Record<string, unknown> | null,
	desired: Record<string, unknown>,
): string[] {
	return [...new Set([...Object.keys(current ?? {}), ...Object.keys(desired)])]
		.filter((key) => !sameJson(current?.[key], desired[key]))
		.map((key) => `${prefix}.${key}: ${formatValue(current?.[key])} -> ${formatValue(desired[key])}`);
}

interface PlannedFile {
	path: string;
	/** The file as read; null when there is none (the command creates it). */
	raw: string | null;
	/** The whole file as it should be, when it changes; null when it stays as is. */
	next: Record<string, unknown> | null;
}

export interface LocalAiProviderPlan {
	/** `absent`: no localai provider in models.json yet (the command adds it). `error`: an unreadable file. */
	kind: "absent" | "found" | "error";
	/** Nothing would change in either file, and LocalAI answered. */
	inSync: boolean;
	/** Why LocalAI's models couldn't be compared; null when it answered. */
	unreachable: string | null;
	/** The wanted models.json `providers.localai`; null for `error`. */
	entry: Record<string, unknown> | null;
	/** The wanted providers.json `providers.localai.settings`; null for `error`. */
	settings: Record<string, unknown> | null;
	/** What would change (or is in sync, or why nothing can be compared), one line each. */
	details: string[];
	files: PlannedFile[];
}

export interface LocalAiProviderOptions {
	modelsPath: string;
	providersPath: string;
	/** LocalAI's URL (root or /v1); where Cline sends requests and the metadata comes from. */
	baseUrl: string;
	/** Kanban server origin the model-lists route is on. */
	origin: string;
	/** The provider's display name; default: the entry's own, else "LocalAI". */
	name?: string;
	/** `models.lists.localai.requireCapabilities`, so models.json and the route offer the same models. */
	requireCapabilities: readonly string[];
	fetch?: typeof fetch;
	timeoutMs?: number;
	now?: Date;
}

function errorPlan(details: string[]): LocalAiProviderPlan {
	return { kind: "error", inSync: false, unreachable: null, entry: null, settings: null, details, files: [] };
}

/** Compares Cline's localai entries (models.json, providers.json) with what LocalAI reports now. Never writes. */
export async function planClineLocalAiProvider(options: LocalAiProviderOptions): Promise<LocalAiProviderPlan> {
	const read = await readClineProviderEntry(options.modelsPath, CLINE_LOCALAI_PROVIDER_ID);
	if (read.kind === "error") {
		return errorPlan([`models.json: ${read.detail}`]);
	}
	const providersRead = await readProvidersFile(options.providersPath);
	if (providersRead.kind === "error") {
		return errorPlan([providersRead.detail]);
	}
	const found = read.kind === "found" ? read : null;
	const modelsRaw = found?.raw ?? (await readFile(options.modelsPath, "utf8").catch(() => null));
	let modelsDocument = found?.document ?? null;
	if (!modelsDocument && modelsRaw !== null) {
		const parsed: unknown = JSON.parse(modelsRaw);
		modelsDocument = isObject(parsed) ? parsed : null;
	}

	let listed: LocalAiModel[] | null = null;
	let unreachable: string | null = null;
	try {
		listed = (
			await fetchLocalAiModels(options.baseUrl, options.fetch, options.timeoutMs ?? LOCALAI_TIMEOUT_MS)
		).filter((model) => isListedLocalAiModel(model, options.requireCapabilities));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		unreachable = `LocalAI at ${localAiApiBaseUrl(options.baseUrl)} did not answer (${message}); its models can't be compared`;
	}

	const currentEntry = found?.entry ?? null;
	const currentProvider = isObject(currentEntry?.provider) ? currentEntry.provider : null;
	const stored = readStoredModels(currentEntry?.models);
	const models = buildDesiredLocalAiModels(stored.models, listed);
	const modelIds = Object.keys(models);
	const provider = buildDesiredLocalAiProvider({
		current: currentProvider,
		baseUrl: options.baseUrl,
		modelListUrl: buildLocalAiModelListUrl(options.origin),
		name: options.name,
		modelIds,
	});
	const entry = { ...currentEntry, provider, models };
	const settings = buildDesiredLocalAiSettings({
		current: providersRead.settings,
		baseUrl: options.baseUrl,
		defaultModelId: typeof provider.defaultModelId === "string" ? provider.defaultModelId : null,
		modelIds,
	});

	const modelsChanges = [
		...describeKeyChanges("models.json provider", currentProvider, provider),
		...describeModelsDiff(diffLemonadeModels(stored, models), models),
	];
	const providersChanges = describeKeyChanges("providers.json settings", providersRead.settings, settings);

	const files: PlannedFile[] = [];
	if (modelsChanges.length > 0 || !found) {
		const document = modelsDocument ? { ...modelsDocument } : { version: CLINE_FILE_VERSION, providers: {} };
		const providers = isObject(document.providers) ? document.providers : {};
		document.providers = { ...providers, [CLINE_LOCALAI_PROVIDER_ID]: entry };
		files.push({ path: options.modelsPath, raw: modelsRaw, next: document });
	}
	if (providersChanges.length > 0) {
		const document = providersRead.document
			? { ...providersRead.document }
			: { version: CLINE_FILE_VERSION, modes: {}, providers: {} };
		const providers = isObject(document.providers) ? document.providers : {};
		const current = providers[CLINE_LOCALAI_PROVIDER_ID];
		const currentFields = isObject(current) ? current : {};
		document.providers = {
			...providers,
			[CLINE_LOCALAI_PROVIDER_ID]: {
				...currentFields,
				settings,
				updatedAt: (options.now ?? new Date()).toISOString(),
				tokenSource: typeof currentFields.tokenSource === "string" ? currentFields.tokenSource : "manual",
			},
		};
		files.push({ path: options.providersPath, raw: providersRead.raw, next: document });
	}

	const inSync = found !== null && listed !== null && files.length === 0;
	const details = [
		...(read.kind === "absent"
			? [`models.json: ${read.detail} The command adds the "${CLINE_LOCALAI_PROVIDER_ID}" provider.`]
			: []),
		...(unreachable ? [unreachable] : []),
		...modelsChanges,
		...providersChanges,
		...(listed && listed.length === 0
			? [`LocalAI lists no model with capabilities ${options.requireCapabilities.join(", ") || "(none)"}`]
			: []),
		...(inSync ? [`provider and ${modelIds.length} model(s) in sync`] : []),
	];
	return { kind: found ? "found" : "absent", inSync, unreachable, entry, settings, details, files };
}

export interface ApplyClineLocalAiOptions extends LocalAiProviderOptions {
	/** Default: `<home>/backups/cline`. */
	backupDir?: string;
	dryRun: boolean;
}

export interface ApplyClineLocalAiResult {
	status: "in-sync" | "written" | "would-write" | "error";
	lines: string[];
	/** One per file replaced; a file the command created has none. */
	backupPaths: string[];
}

/** Writes Cline's `providers.localai` of models.json and providers.json from the plan; nothing else changes. */
export async function applyClineLocalAiProvider(options: ApplyClineLocalAiOptions): Promise<ApplyClineLocalAiResult> {
	const plan = await planClineLocalAiProvider(options);
	if (plan.kind === "error") {
		return { status: "error", lines: plan.details, backupPaths: [] };
	}
	if (plan.inSync || plan.files.length === 0) {
		return { status: "in-sync", lines: plan.details, backupPaths: [] };
	}
	if (plan.unreachable && plan.kind === "absent") {
		// An entry with no models would offer Cline nothing to run; the user's URL may well be wrong.
		return {
			status: "error",
			lines: [...plan.details, "nothing written: LocalAI must answer before its provider is added"],
			backupPaths: [],
		};
	}
	if (options.dryRun) {
		return { status: "would-write", lines: plan.details, backupPaths: [] };
	}
	// LocalAI may take seconds; never overwrite an edit made meanwhile.
	for (const file of plan.files) {
		if ((await readFile(file.path, "utf8").catch(() => null)) !== file.raw) {
			return {
				status: "error",
				lines: [
					...plan.details,
					`${file.path} changed while LocalAI was asked; nothing written, run the command again`,
				],
				backupPaths: [],
			};
		}
	}
	const backupPaths: string[] = [];
	for (const file of plan.files) {
		const content = `${JSON.stringify(file.next, null, 2)}\n`;
		if (file.raw === null) {
			// No such file yet: Cline's settings can hold API keys, so the new file is private like Cline's own.
			await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
			await writeFile(file.path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
			continue;
		}
		backupPaths.push(
			await backupClineFile({
				path: file.path,
				raw: file.raw,
				backupDir: options.backupDir ?? getClineBackupDir(),
				now: options.now ?? new Date(),
			}),
		);
		await replaceClineFileAtomically(file.path, content);
	}
	return { status: "written", lines: plan.details, backupPaths };
}
