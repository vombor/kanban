// Cline's ClinePass key (`cline-pass`, Cline's subscription provider): Kanban's environment holds it (CLINE_API_KEY, a
// podman secret in the container, docs/fork/cline-pass-auth.md), and Cline's providers.json must store it too, because
// Cline's interactive TUI only counts stored credentials (src/terminal/cline-tui-sign-in.ts), as for Bedrock (issue #9).
// Read by doctor's row (src/doctor/cline-pass-key-checks.ts); `kanban setup-provider cline-pass` (the user's, the
// only path that changes providers.json for it) copies the env's key in. Never prints or returns a key value: only
// whether one is stored and whether it equals the env's.
//
// What cline 3.0.70 does (checked in the bundled CLI and with real TUI runs in a throwaway CLINE_DIR/CLINE_DATA_DIR
// against a fake OpenAI-compatible server, 2026-10-12): with CLINE_API_KEY only in the env, or with `baseUrl` and
// `model` stored but no key, the TUI opens its sign-in screen; with `providers["cline-pass"].settings.apiKey` stored
// it runs, sends that key (also when CLINE_API_KEY holds another one) and honours a stored `baseUrl`. ClinePass's
// credentials are stored under `cline` too: a key in `providers.cline.settings.apiKey` works, and a Cline account
// sign-in there (`auth.accessToken`) is sent before any stored key.
import { readFile } from "node:fs/promises";

import { quoteShellArg } from "../core/shell";
import {
	CLINE_PASS_PROVIDER_ID,
	getClineProviderSettings,
	getClineStoredCredential,
	resolveClineProviderSettings,
} from "../terminal/cline-tui-sign-in";
import { readClineProvidersFile } from "./cline-bedrock-key";
import { backupClineFile, getClineBackupDir, replaceClineFileAtomically } from "./cline-file-write";
import { formatSetupProviderCommand } from "./setup-provider-command";

export const CLINE_PASS_KEY_ENV = "CLINE_API_KEY";
export const STORE_CLINE_PASS_KEY_COMMAND = formatSetupProviderCommand("cline-pass");
export const CLINE_PASS_AUTH_DOC = "docs/fork/cline-pass-auth.md";
/** The podman quadlet line that hands Kanban the key (docs/fork/cline-pass-auth.md). */
export const CLINE_PASS_PODMAN_SECRET_LINE = `Secret=<secret name>,type=env,target=${CLINE_PASS_KEY_ENV}`;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export interface ClinePassKeyFacts {
	/**
	 * What Cline sends for ClinePass: `sign-in` (a Cline account's `auth.accessToken`, which comes before any stored
	 * key), `key` (a stored API key) or `none` (its TUI opens the sign-in screen).
	 */
	credential: "none" | "sign-in" | "key";
	/** The stored key compared with the env's; `none` unless `credential` is `key`. */
	storedKey: "none" | "same" | "different";
	envKey: boolean;
	/** Whether providers.json has a `cline-pass` entry or a `cline` one (where ClinePass's credentials live too). */
	hasEntry: boolean;
}

export function describeClinePassKey(document: unknown, env: NodeJS.ProcessEnv): ClinePassKeyFacts {
	const settings = resolveClineProviderSettings(document, CLINE_PASS_PROVIDER_ID);
	const credential = settings ? getClineStoredCredential(settings) : null;
	const envValue = readNonEmptyString(env[CLINE_PASS_KEY_ENV]);
	return {
		credential: credential === null ? "none" : credential.kind === "access-token" ? "sign-in" : "key",
		storedKey: credential?.kind !== "api-key" ? "none" : credential.value === envValue ? "same" : "different",
		envKey: envValue !== null,
		hasEntry: settings !== null,
	};
}

/**
 * What is wrong with Cline's ClinePass key for its TUI cards, one line each, for doctor (it adds the command); empty
 * when a usable key is stored. Never the key.
 */
export function describeClinePassKeyProblems(
	facts: ClinePassKeyFacts,
	providersPath: string,
): Array<{ level: "warn" | "info"; message: string }> {
	if (facts.credential === "sign-in") {
		return facts.envKey
			? [
					{
						level: "info",
						message: `Cline uses the Cline account sign-in stored in ${providersPath} (providers.cline) for ClinePass, not ${CLINE_PASS_KEY_ENV}: a sign-in comes before any stored key`,
					},
				]
			: [];
	}
	if (facts.credential === "none") {
		return [
			{
				level: "warn",
				message: facts.envKey
					? `${providersPath} stores no ClinePass key: Cline's cline-pass cards open on Cline's sign-in screen and never start (its TUI doesn't read ${CLINE_PASS_KEY_ENV}, though Kanban's environment has it)`
					: `${CLINE_PASS_KEY_ENV} is not set and ${providersPath} stores no ClinePass key: Cline's cline-pass cards have no key and open on Cline's sign-in screen (podman: ${CLINE_PASS_PODMAN_SECRET_LINE})`,
			},
		];
	}
	if (facts.storedKey === "different" && facts.envKey) {
		return [
			{
				level: "warn",
				message: `${providersPath} stores a different ClinePass key than ${CLINE_PASS_KEY_ENV}: Cline uses the stored one, so a rotated key hasn't reached it`,
			},
		];
	}
	return [];
}

export interface StoreClinePassKeyOptions {
	providersPath: string;
	env: NodeJS.ProcessEnv;
	dryRun: boolean;
	/** Default: `<home>/backups/cline`. */
	backupDir?: string;
	now?: Date;
}

export interface ClinePassKeyCommandResult {
	/** `refused`: a precondition failed and nothing was written; `error`: providers.json can't be used. */
	status: "nothing-to-do" | "would-write" | "written" | "refused" | "error";
	lines: string[];
	backupPath: string | null;
	/** The command that puts the backup back. */
	rollback: string | null;
}

function result(
	status: ClinePassKeyCommandResult["status"],
	lines: string[],
	backup: { backupPath: string; rollback: string } | null = null,
): ClinePassKeyCommandResult {
	return { status, lines, backupPath: backup?.backupPath ?? null, rollback: backup?.rollback ?? null };
}

/**
 * `kanban setup-provider cline-pass`: stores this environment's CLINE_API_KEY as
 * `providers["cline-pass"].settings.apiKey` in Cline's providers.json, leaving the model, the `cline` entry and every
 * other provider alone. Backs the file up into the Kanban home first and writes atomically. The key comes from the
 * env, never the command line (argv is readable in /proc and lands in history; `cline auth -k` would put it there).
 */
export async function storeClinePassKey(options: StoreClinePassKeyOptions): Promise<ClinePassKeyCommandResult> {
	const envValue = readNonEmptyString(options.env[CLINE_PASS_KEY_ENV]);
	if (envValue === null) {
		return result("refused", [
			`${CLINE_PASS_KEY_ENV} is not set here. Set it in Kanban's environment (podman: ${CLINE_PASS_PODMAN_SECRET_LINE}) and run this from that environment`,
		]);
	}
	const read = await readClineProvidersFile(options.providersPath);
	if (read.kind === "invalid") {
		return result("error", [read.detail]);
	}
	if (read.kind === "absent") {
		return result("refused", [
			"no providers.json yet: start one Cline card (Cline writes the file, even on its sign-in screen), then run this again",
		]);
	}
	const { document } = read;
	const facts = describeClinePassKey(document, options.env);
	if (facts.credential === "sign-in") {
		return result("refused", [
			`providers.json has a Cline account sign-in (providers.cline auth.accessToken), which Cline sends for ClinePass before any stored key: a stored ${CLINE_PASS_KEY_ENV} would be unused. ClinePass cards already run on that account`,
		]);
	}
	if (facts.storedKey === "same") {
		return result("nothing-to-do", [`providers.json already stores ${CLINE_PASS_KEY_ENV}'s key for ClinePass`]);
	}
	const lines = [
		facts.storedKey === "none"
			? `store providers.cline-pass.settings.apiKey from ${CLINE_PASS_KEY_ENV}`
			: `replace the stored ClinePass key (a different value) with ${CLINE_PASS_KEY_ENV} in providers.cline-pass.settings.apiKey`,
		"the model, the cline entry and the other providers stay as they are",
	];
	if (options.dryRun) {
		return result("would-write", lines);
	}

	const now = options.now ?? new Date();
	const providers = isJsonObject(document.providers) ? document.providers : {};
	document.providers = providers;
	const settings = getClineProviderSettings(document, CLINE_PASS_PROVIDER_ID);
	const target: JsonObject = settings ?? {};
	if (!settings) {
		// The shape Cline writes (without `updatedAt`/`tokenSource` it drops stored fields).
		providers[CLINE_PASS_PROVIDER_ID] = { settings: target, updatedAt: now.toISOString(), tokenSource: "manual" };
	}
	// Cline's TUI counts the entry only when it names its own provider.
	target.provider = CLINE_PASS_PROVIDER_ID;
	target.apiKey = envValue;
	// Never overwrite an edit made meanwhile (a card launch rewrites providers.json).
	if ((await readFile(options.providersPath, "utf8")) !== read.raw) {
		return result("error", [...lines, "providers.json changed meanwhile; nothing written, run the command again"]);
	}
	const backupPath = await backupClineFile({
		path: options.providersPath,
		raw: read.raw,
		backupDir: options.backupDir ?? getClineBackupDir(),
		now,
	});
	await replaceClineFileAtomically(options.providersPath, `${JSON.stringify(document, null, 2)}\n`);
	return result("written", lines, {
		backupPath,
		rollback: `cp ${quoteShellArg(backupPath)} ${quoteShellArg(options.providersPath)}`,
	});
}
