// Where the Lemonade provider in Cline's models.json should get its model list: Kanban's model-lists route.
//
// Cline offers every id the provider's `modelsSourceUrl` returns. The legacy kit pointed it at its own
// model-lists service (http://127.0.0.1:13306/lemonade/models), which the route in
// src/server/model-lists-route.ts replaces. That URL (or a missing one) should be the route; a URL the user chose
// for something else is left alone. Read-only: Kanban writes nothing under ~/.cline (user rule, 2026-10-07), so
// `kanban setup` and doctor only report the drift, and the user's `kanban cline apply-lemonade-models`
// (src/setup/cline-lemonade-apply.ts) is the one thing that changes the file. The provider entry is never created.
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

/** Where the Lemonade provider's `modelsSourceUrl` should point, given what it points at now. */
export function planModelsSourceUrl(
	currentUrl: string | null,
	targetUrl: string,
): { action: "up-to-date" | "update" | "custom"; detail: string } {
	if (currentUrl === targetUrl) {
		return { action: "up-to-date", detail: "Already points at the model-lists route." };
	}
	if (currentUrl === null) {
		return { action: "update", detail: "No modelsSourceUrl yet." };
	}
	if (isManagedModelsSourceUrl(currentUrl)) {
		return { action: "update", detail: "Points at the legacy model-lists service or another Kanban origin." };
	}
	return { action: "custom", detail: "Points at a URL Kanban doesn't manage; left alone." };
}

/** Reads models.json and says whether its Lemonade `modelsSourceUrl` should change. Never writes. */
export async function planClineModelsSource(modelsPath: string, targetUrl: string): Promise<ClineModelsSourcePlan> {
	const read = await readClineLemonadeEntry(modelsPath);
	if (read.kind !== "found") {
		const action = read.kind === "absent" ? "skip" : "error";
		return { action, modelsPath, currentUrl: null, targetUrl, detail: read.detail };
	}
	const plan = planModelsSourceUrl(read.modelsSourceUrl, targetUrl);
	return { ...plan, modelsPath, currentUrl: read.modelsSourceUrl, targetUrl };
}
