// Whether Cline's interactive TUI starts a card's prompt or opens its sign-in screen ("Welcome to Cline / Connect a
// model provider to get started"). There it takes no prompt, writes no session file and turns typed input into a
// Cline account sign-in (`user.auth_started`), while Kanban sees a "running" session (issue #9, foo QA card ab61f,
// 2026-10-08). Kanban passes no `-k`, so the TUI decides on providers.json alone.
//
// cline 3.0.69's TUI check (`ps`/`Cp` in the bundled CLI, verified with real TUI runs in a throwaway
// CLINE_DIR/CLINE_DATA_DIR, 2026-10-08): the provider's stored settings must name the provider (`settings.provider`)
// and, for bedrock, hold a key (`apiKey`, `auth.apiKey` or `auth.accessToken`) or AWS credentials (`aws.authentication`
// iam/profile, `aws.profile`, or `aws.accessKey` + `aws.secretKey`), plus a region (`aws.region` or `region`). The
// environment never counts there: with only AWS_BEARER_TOKEN_BEDROCK and AWS_REGION set, the TUI opens the sign-in
// screen, although Cline's Bedrock client (headless runs) would use them. A custom provider from models.json (Lemonade,
// LocalAI) needs no key, but without one its stored settings must hold both `baseUrl` and `model` (cline 3.0.70, `jp`
// in the bundle, real TUI runs against LocalAI 2026-10-11: `{provider, model}` alone opened the sign-in screen, and
// models.json's baseUrl doesn't count). ClinePass (`cline-pass`; cline 3.0.70, real TUI runs against a fake
// OpenAI-compatible server, 2026-10-12) is an OAuth provider whose credentials Cline stores under `cline`
// (`storageProviderId`): its settings are `providers.cline.settings`' `auth`, `apiKey` and `baseUrl` under
// `providers["cline-pass"].settings`, and they must hold a key (a Cline account sign-in's `auth.accessToken` first,
// then `apiKey`, then `auth.apiKey`); CLINE_API_KEY in the env never counts. For other providers only "no stored
// entry" is certain; the rest depends on Cline's provider catalog, so it is not judged here.
// Read by doctor and setup (src/setup/cline-bedrock-key.ts) and by the silent-stall reason (cline-turn-check.ts).
import { readFile } from "node:fs/promises";

import { getClineProvidersSettingsPath } from "../state/kanban-home";

type JsonObject = Record<string, unknown>;

/** The custom (models.json) providers Kanban sets up for Cline cards: Lemonade and LocalAI. */
const CLINE_CUSTOM_PROVIDER_IDS: readonly string[] = ["lemonade", "localai"];

export const CLINE_PASS_PROVIDER_ID = "cline-pass";
/** Providers whose credentials Cline keeps under another provider's entry (`storageProviderId` in the bundle). */
const CLINE_STORAGE_PROVIDER_IDS: Readonly<Record<string, string>> = { [CLINE_PASS_PROVIDER_ID]: "cline" };

function isJsonObject(value: unknown): value is JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function readObject(value: unknown): JsonObject {
	return isJsonObject(value) ? value : {};
}

/** `providers.<id>.settings` of a parsed providers.json, or null. */
export function getClineProviderSettings(document: unknown, providerId: string): JsonObject | null {
	const entry = readObject(readObject(readObject(document).providers)[providerId]);
	return isJsonObject(entry.settings) ? entry.settings : null;
}

/**
 * A provider's settings as Cline resolves them (`resolveProviderSettings` in the bundle): for a provider stored under
 * another one (ClinePass under `cline`), that entry's `auth`, `apiKey` and `baseUrl` with the provider's own settings
 * on top, named after the provider. Null when neither entry has settings.
 */
export function resolveClineProviderSettings(document: unknown, providerId: string): JsonObject | null {
	const own = getClineProviderSettings(document, providerId);
	const storageId = CLINE_STORAGE_PROVIDER_IDS[providerId];
	const stored = storageId ? getClineProviderSettings(document, storageId) : null;
	if (!stored) {
		return own;
	}
	return {
		...(stored.auth === undefined ? {} : { auth: stored.auth }),
		...(stored.apiKey === undefined ? {} : { apiKey: stored.apiKey }),
		...(stored.baseUrl === undefined ? {} : { baseUrl: stored.baseUrl }),
		...own,
		provider: providerId,
	};
}

/**
 * The stored credential Cline sends, in its order (`getApiKey` in the bundle): a sign-in's `auth.accessToken`, then
 * `apiKey`, then `auth.apiKey`. Null when none is stored.
 */
export function getClineStoredCredential(
	settings: JsonObject,
): { kind: "access-token" | "api-key"; value: string } | null {
	const auth = readObject(settings.auth);
	for (const [kind, value] of [
		["access-token", auth.accessToken],
		["api-key", settings.apiKey],
		["api-key", auth.apiKey],
	] as const) {
		if (typeof value === "string" && value.trim()) {
			return { kind, value: value.trim() };
		}
	}
	return null;
}

/** A key Cline's TUI counts as stored credentials (`rn` in the bundle). */
export function hasClineStoredKey(settings: JsonObject): boolean {
	return getClineStoredCredential(settings) !== null;
}

function hasStoredAwsCredentials(settings: JsonObject): boolean {
	const aws = readObject(settings.aws);
	return (
		aws.authentication === "iam" ||
		aws.authentication === "profile" ||
		hasText(aws.profile) ||
		(hasText(aws.accessKey) && hasText(aws.secretKey))
	);
}

export function hasClineStoredBedrockRegion(settings: JsonObject): boolean {
	return hasText(readObject(settings.aws).region) || hasText(settings.region);
}

/**
 * Why Cline's TUI would open its sign-in screen for `providerId` with this providers.json (parsed, or null when
 * there is none), or null when it starts the prompt or this can't tell (a provider other than bedrock that has an
 * entry).
 */
export function describeClineTuiSignInGap(document: unknown, providerId: string): string | null {
	const settings = resolveClineProviderSettings(document, providerId);
	if (!settings) {
		return `providers.json has no ${providerId} entry`;
	}
	if (settings.provider !== providerId) {
		return `providers.json's ${providerId} entry doesn't name its provider (settings.provider)`;
	}
	if (CLINE_CUSTOM_PROVIDER_IDS.includes(providerId)) {
		if (hasClineStoredKey(settings) || (hasText(settings.baseUrl) && hasText(settings.model))) {
			return null;
		}
		return `providers.json's ${providerId} entry has no baseUrl and model (Cline's TUI needs both for a provider without a key)`;
	}
	if (providerId === CLINE_PASS_PROVIDER_ID) {
		return hasClineStoredKey(settings)
			? null
			: "providers.json stores no ClinePass key (Cline's TUI doesn't count CLINE_API_KEY)";
	}
	if (providerId !== "bedrock") {
		return null;
	}
	if (!hasClineStoredKey(settings) && !hasStoredAwsCredentials(settings)) {
		return "providers.json stores no Bedrock key (Cline's TUI doesn't count AWS_BEARER_TOKEN_BEDROCK)";
	}
	if (!hasClineStoredBedrockRegion(settings)) {
		return "providers.json stores no Bedrock region (Cline's TUI doesn't count AWS_REGION)";
	}
	return null;
}

/** describeClineTuiSignInGap on `<dataDir>/settings/providers.json`; null when unknown or unreadable. */
export async function readClineTuiSignInGap(dataDir: string, providerId: string | null): Promise<string | null> {
	if (!providerId) {
		return null;
	}
	let document: unknown = null;
	try {
		document = JSON.parse(await readFile(getClineProvidersSettingsPath(dataDir), "utf8"));
	} catch (error) {
		const missing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
		if (!missing) {
			return null;
		}
	}
	return describeClineTuiSignInGap(document, providerId);
}
