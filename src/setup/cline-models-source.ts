// `kanban setup` step: point the Lemonade provider in Cline's models.json at Kanban's model-lists route.
//
// Cline offers every id the provider's `modelsSourceUrl` returns. The legacy kit pointed it at its own
// model-lists service (http://127.0.0.1:13306/lemonade/models), which the route in
// src/server/model-lists-route.ts replaces. This step rewrites that URL (or sets a missing one) and leaves a
// URL the user chose for something else alone. The provider entry itself is never created: without a
// Lemonade provider in Cline there is nothing to point.
import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { z } from "zod";

import { LEMONADE_MODEL_LIST_PATH } from "../server/model-lists-route";

export const CLINE_LEMONADE_PROVIDER_ID = "lemonade";

// The kit's service: loopback, port 13306, path /lemonade/models (or /lemonade/v1/models).
// Ported from archive/devteam-kit:services/model-lists.mjs@6a2ba0e (its route regex and port).
const LEGACY_MODEL_LISTS_URL_PATTERN =
	/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):13306\/lemonade\/(?:v1\/)?models\/?$/u;

const clineModelsFileSchema = z
	.object({
		providers: z.record(
			z.string(),
			z.looseObject({ provider: z.looseObject({ modelsSourceUrl: z.string().optional() }).optional() }),
		),
	})
	.loose();

export type ClineModelsSourceAction =
	/** No models.json, or no Lemonade provider in it. */
	| "skip"
	| "up-to-date"
	| "update"
	/** The URL points somewhere else on purpose; left alone. */
	| "custom"
	| "error";

export interface ClineModelsSourcePlan {
	action: ClineModelsSourceAction;
	modelsPath: string;
	currentUrl: string | null;
	targetUrl: string;
	detail: string;
}

export interface ClineModelsSourceResult extends ClineModelsSourcePlan {
	applied: boolean;
	backupPath: string | null;
}

/** The route's URL on a Kanban server origin such as http://127.0.0.1:3484. */
export function buildLemonadeModelListUrl(origin: string): string {
	return `${new URL(origin).origin}${LEMONADE_MODEL_LIST_PATH}`;
}

/** True for the legacy kit's model-lists service URL. */
export function isLegacyModelListsServiceUrl(url: string): boolean {
	return LEGACY_MODEL_LISTS_URL_PATTERN.test(url);
}

/** True for a URL this step manages: the legacy kit service, or the route on any Kanban origin. */
export function isManagedModelsSourceUrl(url: string): boolean {
	if (isLegacyModelListsServiceUrl(url)) {
		return true;
	}
	try {
		return new URL(url).pathname.replace(/\/+$/u, "") === LEMONADE_MODEL_LIST_PATH;
	} catch {
		return false;
	}
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

interface ReadModelsFile {
	plan: ClineModelsSourcePlan;
	document: Record<string, unknown> | null;
	/** The file as read, kept for the backup. */
	raw: string | null;
}

async function readAndPlan(modelsPath: string, targetUrl: string): Promise<ReadModelsFile> {
	const plan = (
		action: ClineModelsSourceAction,
		detail: string,
		currentUrl: string | null = null,
	): ClineModelsSourcePlan => ({ action, modelsPath, currentUrl, targetUrl, detail });
	let raw: string;
	try {
		raw = await readFile(modelsPath, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) {
			return { plan: plan("skip", "Cline has no models.json (no custom providers)."), document: null, raw: null };
		}
		return { plan: plan("error", `Could not read it: ${String(error)}`), document: null, raw: null };
	}
	let document: unknown;
	try {
		document = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { plan: plan("error", `Not valid JSON (${message}); left alone.`), document: null, raw: null };
	}
	const parsed = clineModelsFileSchema.safeParse(document);
	if (!parsed.success) {
		return {
			plan: plan("error", "Not a Cline models file (no providers object); left alone."),
			document: null,
			raw: null,
		};
	}
	const entry = parsed.data.providers[CLINE_LEMONADE_PROVIDER_ID];
	if (!entry) {
		return { plan: plan("skip", `No "${CLINE_LEMONADE_PROVIDER_ID}" provider in it.`), document: null, raw: null };
	}
	const currentUrl = entry.provider?.modelsSourceUrl?.trim() || null;
	const records = document as Record<string, unknown>;
	if (currentUrl === targetUrl) {
		return {
			plan: plan("up-to-date", "Already points at the model-lists route.", currentUrl),
			document: records,
			raw,
		};
	}
	if (currentUrl === null) {
		return { plan: plan("update", "No modelsSourceUrl yet.", currentUrl), document: records, raw };
	}
	if (isManagedModelsSourceUrl(currentUrl)) {
		return {
			plan: plan("update", "Points at the legacy model-lists service or another Kanban origin.", currentUrl),
			document: records,
			raw,
		};
	}
	return {
		plan: plan("custom", "Points at a URL Kanban doesn't manage; left alone.", currentUrl),
		document: records,
		raw,
	};
}

export async function planClineModelsSource(modelsPath: string, targetUrl: string): Promise<ClineModelsSourcePlan> {
	return (await readAndPlan(modelsPath, targetUrl)).plan;
}

function backupTimestamp(now: Date): string {
	return now
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d+Z$/u, "Z");
}

/**
 * Applies the plan unless `dryRun`. Writes a timestamped backup next to models.json first, then replaces the
 * file atomically with the same mode. Only `providers.lemonade.provider.modelsSourceUrl` changes.
 */
export async function applyClineModelsSource(options: {
	modelsPath: string;
	targetUrl: string;
	dryRun: boolean;
	now?: Date;
}): Promise<ClineModelsSourceResult> {
	const { plan, document, raw } = await readAndPlan(options.modelsPath, options.targetUrl);
	if (plan.action !== "update" || options.dryRun || !document || raw === null) {
		return { ...plan, applied: false, backupPath: null };
	}
	const providers = document.providers as Record<string, Record<string, unknown>>;
	const lemonade = providers[CLINE_LEMONADE_PROVIDER_ID] as Record<string, unknown>;
	const provider = (lemonade.provider as Record<string, unknown> | undefined) ?? {};
	lemonade.provider = { ...provider, modelsSourceUrl: options.targetUrl };

	const mode = (await stat(options.modelsPath)).mode & 0o7777;
	const backupPath = `${options.modelsPath}.bak-before-kanban-setup-${backupTimestamp(options.now ?? new Date())}`;
	await writeFile(backupPath, raw, { encoding: "utf8", mode, flag: "wx" });
	const tempPath = `${options.modelsPath}.tmp.${process.pid}.${Date.now()}`;
	await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode });
	// writeFile's mode is masked by the umask; the replacement keeps the original's mode exactly.
	await chmod(tempPath, mode);
	await rename(tempPath, options.modelsPath);
	return { ...plan, applied: true, backupPath };
}
