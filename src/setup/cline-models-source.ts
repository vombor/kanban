// The Lemonade provider in Cline's models.json must not have a `modelsSourceUrl`.
//
// Cline offers every id the provider's `modelsSourceUrl` returns, so a dynamic list (the legacy kit's model-lists
// service at http://127.0.0.1:13306/lemonade/models, or Kanban's route in src/server/model-lists-route.ts) would offer
// every model Lemonade has, vetted or not. The provider's `models` record is the allow list (docs/team/MODELS.md),
// curated by the Kanban orchestrator, so any `modelsSourceUrl` is to be dropped. Read-only: Kanban writes nothing
// under ~/.cline (user rule, 2026-10-07; the Lemonade context windows are the one exception, issue #31), so
// `kanban setup` and doctor only report it, and `kanban setup-provider lemonade` (run by the user or the Kanban
// orchestrator, src/setup/cline-lemonade-apply.ts) is the one thing that changes the file. The provider entry is never
// created.
import { readFile } from "node:fs/promises";
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
	/** No `modelsSourceUrl`: Cline offers only the `models` record. */
	| "up-to-date"
	/** A `modelsSourceUrl` is set: to be dropped. */
	| "remove"
	| "error";

export interface ClineModelsSourcePlan {
	action: ClineModelsSourceAction;
	modelsPath: string;
	currentUrl: string | null;
	detail: string;
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

/** Cline's models.json as read, down to the Lemonade provider entry. Every non-`found` kind says why in `detail`. */
export type ClineLemonadeEntryRead =
	/** No models.json, or no Lemonade provider in it. */
	| { kind: "absent"; detail: string }
	| { kind: "error"; detail: string }
	| {
			kind: "found";
			/** The file as read, kept for the backup. */
			raw: string;
			document: Record<string, unknown>;
			/** `document.providers.lemonade`, the same object. */
			entry: Record<string, unknown>;
			modelsSourceUrl: string | null;
	  };

export async function readClineLemonadeEntry(modelsPath: string): Promise<ClineLemonadeEntryRead> {
	let raw: string;
	try {
		raw = await readFile(modelsPath, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) {
			return { kind: "absent", detail: "Cline has no models.json (no custom providers)." };
		}
		return { kind: "error", detail: `Could not read it: ${String(error)}` };
	}
	let document: unknown;
	try {
		document = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { kind: "error", detail: `Not valid JSON (${message}); left alone.` };
	}
	const parsed = clineModelsFileSchema.safeParse(document);
	if (!parsed.success) {
		return { kind: "error", detail: "Not a Cline models file (no providers object); left alone." };
	}
	const entry = parsed.data.providers[CLINE_LEMONADE_PROVIDER_ID];
	if (!entry) {
		return { kind: "absent", detail: `No "${CLINE_LEMONADE_PROVIDER_ID}" provider in it.` };
	}
	const records = document as Record<string, Record<string, Record<string, unknown>>>;
	return {
		kind: "found",
		raw,
		document: records,
		entry: records.providers[CLINE_LEMONADE_PROVIDER_ID] as Record<string, unknown>,
		modelsSourceUrl: entry.provider?.modelsSourceUrl?.trim() || null,
	};
}

/** Whether the Lemonade provider's `modelsSourceUrl` must go, given what it is now. */
export function planModelsSourceUrl(currentUrl: string | null): { action: "up-to-date" | "remove"; detail: string } {
	if (currentUrl === null) {
		return { action: "up-to-date", detail: "No modelsSourceUrl: Cline offers only the models record." };
	}
	return {
		action: "remove",
		detail: "Cline would offer every model this URL lists, not only the models record (the allow list); drop it",
	};
}

/** Reads models.json and says whether its Lemonade `modelsSourceUrl` must be dropped. Never writes. */
export async function planClineModelsSource(modelsPath: string): Promise<ClineModelsSourcePlan> {
	const read = await readClineLemonadeEntry(modelsPath);
	if (read.kind !== "found") {
		const action = read.kind === "absent" ? "skip" : "error";
		return { action, modelsPath, currentUrl: null, detail: read.detail };
	}
	return { ...planModelsSourceUrl(read.modelsSourceUrl), modelsPath, currentUrl: read.modelsSourceUrl };
}
