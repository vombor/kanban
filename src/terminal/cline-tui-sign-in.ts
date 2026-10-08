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
// screen, although Cline's Bedrock client (headless runs) would use them. For other providers only "no stored entry"
// is certain; the rest depends on Cline's provider catalog, so it is not judged here.
// Read by doctor and setup (src/setup/cline-bedrock-key.ts) and by the silent-stall reason (cline-turn-check.ts).
import { readFile } from "node:fs/promises";

import { getClineProvidersSettingsPath } from "../state/kanban-home";

type JsonObject = Record<string, unknown>;

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

/** A key Cline's TUI counts as stored credentials (`rn` in the bundle). */
export function hasClineStoredKey(settings: JsonObject): boolean {
	const auth = readObject(settings.auth);
	return hasText(settings.apiKey) || hasText(auth.apiKey) || hasText(auth.accessToken);
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
	const settings = getClineProviderSettings(document, providerId);
	if (!settings) {
		return `providers.json has no ${providerId} entry`;
	}
	if (settings.provider !== providerId) {
		return `providers.json's ${providerId} entry doesn't name its provider (settings.provider)`;
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
