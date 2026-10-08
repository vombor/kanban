// Cline's Bedrock key: Kanban's environment holds it (AWS_BEARER_TOKEN_BEDROCK, a podman secret in the container),
// and Cline's providers.json must store it too, because Cline's interactive TUI only counts stored credentials
// (src/terminal/cline-tui-sign-in.ts): every card runs in that TUI, and without a stored key it opens Cline's
// sign-in screen and never takes the prompt (issue #9, 2026-10-08: after `remove-bedrock-key` every Cline card did).
// Read by `kanban setup`'s cline-providers step and doctor's row; `kanban cline store-bedrock-key` (the user's command,
// the only path that changes providers.json) copies the env's key and region in. `remove-bedrock-key` is kept only
// to refuse. Never prints or returns a key value: only whether one is there and whether it equals the env's.
//
// What cline 3.0.69 does (checked in the bundled CLI, with real TUI runs in a throwaway CLINE_DIR/CLINE_DATA_DIR,
// 2026-10-08): the TUI's sign-in check needs a stored key (or stored AWS credentials) and a stored region; the env
// doesn't count. Its Bedrock client then takes the stored `settings.apiKey` over AWS_BEARER_TOKEN_BEDROCK, so a rotated
// secret reaches Cline only once it is stored again. With `aws.authentication` iam/profile the stored key is unused.
import { readFile } from "node:fs/promises";

import { quoteShellArg } from "../core/shell";
import { backupClineFile, getClineBackupDir, replaceClineFileAtomically } from "./cline-file-write";

export const CLINE_BEDROCK_KEY_ENV = "AWS_BEARER_TOKEN_BEDROCK";
export const STORE_BEDROCK_KEY_COMMAND = "kanban cline store-bedrock-key";
export const CLINE_BEDROCK_AUTH_DOC = "docs/fork/cline-bedrock-auth.md";
/** The podman quadlet line that hands Kanban the key (docs/fork/cline-bedrock-auth.md). */
export const BEDROCK_PODMAN_SECRET_LINE = `Secret=<secret name>,type=env,target=${CLINE_BEDROCK_KEY_ENV}`;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export type ClineBedrockRead =
	| { kind: "absent" }
	| { kind: "invalid"; detail: string }
	/** `settings`: `providers.bedrock.settings`, null when providers.json has no Bedrock entry. */
	| { kind: "found"; raw: string; document: JsonObject; settings: JsonObject | null };

export async function readClineBedrockSettings(providersPath: string): Promise<ClineBedrockRead> {
	let raw: string;
	try {
		raw = await readFile(providersPath, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return { kind: "absent" };
		}
		return { kind: "invalid", detail: `can't read it: ${error instanceof Error ? error.message : String(error)}` };
	}
	let document: unknown;
	try {
		document = JSON.parse(raw);
	} catch {
		return { kind: "invalid", detail: "not valid JSON (Kanban never edits it)" };
	}
	if (!isJsonObject(document)) {
		return { kind: "invalid", detail: "not a JSON object (Kanban never edits it)" };
	}
	const entry = isJsonObject(document.providers) ? document.providers.bedrock : null;
	const settings = isJsonObject(entry) && isJsonObject(entry.settings) ? entry.settings : null;
	return { kind: "found", raw, document, settings };
}

export interface ClineBedrockKeyFacts {
	/** The key stored in providers.json (`settings.apiKey`), compared with the env's. */
	storedKey: "none" | "same" | "different";
	envKey: boolean;
	/**
	 * How Cline authenticates besides a stored key: `iam` (aws.authentication iam/profile, or a stored profile: the
	 * stored key is unused), `access-keys` (a stored access-key pair) or `key` (only the stored key).
	 */
	credentials: "key" | "iam" | "access-keys";
	/** `settings.aws.region` (or `settings.region`): the one Cline's TUI counts. */
	storedRegion: string | null;
	envRegion: string | null;
}

export function describeClineBedrockKey(settings: JsonObject | null, env: NodeJS.ProcessEnv): ClineBedrockKeyFacts {
	const aws = settings && isJsonObject(settings.aws) ? settings.aws : {};
	const stored = readNonEmptyString(settings?.apiKey);
	const envValue = readNonEmptyString(env[CLINE_BEDROCK_KEY_ENV]);
	const authentication = readNonEmptyString(aws.authentication);
	const credentials =
		authentication === "iam" || authentication === "profile" || readNonEmptyString(aws.profile)
			? "iam"
			: readNonEmptyString(aws.accessKey) && readNonEmptyString(aws.secretKey)
				? "access-keys"
				: "key";
	return {
		storedKey: stored === null ? "none" : stored === envValue ? "same" : "different",
		envKey: envValue !== null,
		credentials,
		storedRegion: settings ? readStoredRegion(settings) : null,
		envRegion: readNonEmptyString(env.AWS_REGION),
	};
}

function readStoredRegion(settings: JsonObject): string | null {
	const aws = isJsonObject(settings.aws) ? settings.aws : {};
	return readNonEmptyString(aws.region) ?? readNonEmptyString(settings.region);
}

/**
 * What is wrong with Cline's Bedrock key for its TUI cards, one line each, for setup and doctor (they add the
 * command); empty when the stored key and region are in place. Never the key.
 */
export function describeBedrockKeyProblems(
	facts: ClineBedrockKeyFacts,
	providersPath: string,
): Array<{ level: "warn" | "info"; message: string }> {
	if (facts.credentials === "iam") {
		return facts.storedKey === "none"
			? []
			: [
					{
						level: "info",
						message: `Cline stores a Bedrock API key in ${providersPath} that it doesn't use (aws.authentication is iam/profile)`,
					},
				];
	}
	const problems: Array<{ level: "warn" | "info"; message: string }> = [];
	if (facts.storedKey === "none" && facts.credentials === "key") {
		problems.push({
			level: "warn",
			message: facts.envKey
				? `${providersPath} stores no Bedrock key: Cline's Bedrock cards open on Cline's sign-in screen and never start (its TUI doesn't read ${CLINE_BEDROCK_KEY_ENV}, though Kanban's environment has it)`
				: `${CLINE_BEDROCK_KEY_ENV} is not set and ${providersPath} stores no Bedrock key: Cline's Bedrock cards have no key and open on Cline's sign-in screen (podman: ${BEDROCK_PODMAN_SECRET_LINE})`,
		});
	} else if (facts.storedKey === "different" && facts.envKey) {
		problems.push({
			level: "warn",
			message: `${providersPath} stores a different Bedrock key than ${CLINE_BEDROCK_KEY_ENV}: Cline uses the stored one, so a rotated key hasn't reached it`,
		});
	}
	if (!facts.storedRegion) {
		problems.push({
			level: "warn",
			message: `${providersPath} stores no Bedrock region: Cline's TUI needs one there${facts.envRegion ? ` (it doesn't count AWS_REGION=${facts.envRegion})` : ""}`,
		});
	}
	return problems;
}

export interface StoreClineBedrockKeyOptions {
	providersPath: string;
	env: NodeJS.ProcessEnv;
	/** Stored when providers.json has no Bedrock region: AWS_REGION, else this (`models.bedrockRegion`). */
	defaultRegion: string;
	dryRun: boolean;
	/** Default: `<home>/backups/cline`. */
	backupDir?: string;
	now?: Date;
}

export interface ClineBedrockKeyCommandResult {
	/** `refused`: a precondition failed and nothing was written; `error`: providers.json can't be used. */
	status: "nothing-to-do" | "would-write" | "written" | "refused" | "error";
	lines: string[];
	backupPath: string | null;
	/** The command that puts the backup back. */
	rollback: string | null;
}

function result(
	status: ClineBedrockKeyCommandResult["status"],
	lines: string[],
	backup: { backupPath: string; rollback: string } | null = null,
): ClineBedrockKeyCommandResult {
	return { status, lines, backupPath: backup?.backupPath ?? null, rollback: backup?.rollback ?? null };
}

/** A new providers.json entry in the shape Cline writes (without `updatedAt`/`tokenSource` it drops stored fields). */
function newBedrockEntry(settings: JsonObject, now: Date): JsonObject {
	return { settings, updatedAt: now.toISOString(), tokenSource: "manual" };
}

/**
 * `kanban cline store-bedrock-key`: stores this environment's AWS_BEARER_TOKEN_BEDROCK as
 * `providers.bedrock.settings.apiKey` in Cline's providers.json, and a region (`aws.region`) when none is stored,
 * leaving the model and every other provider alone. Backs the file up into the Kanban home first and writes
 * atomically. The key comes from the env, never the command line (argv is readable in /proc and lands in history).
 */
export async function storeClineBedrockKey(
	options: StoreClineBedrockKeyOptions,
): Promise<ClineBedrockKeyCommandResult> {
	const envValue = readNonEmptyString(options.env[CLINE_BEDROCK_KEY_ENV]);
	if (envValue === null) {
		return result("refused", [
			`${CLINE_BEDROCK_KEY_ENV} is not set here. Set it in Kanban's environment (podman: ${BEDROCK_PODMAN_SECRET_LINE}) and run this from that environment`,
		]);
	}
	const read = await readClineBedrockSettings(options.providersPath);
	if (read.kind === "invalid") {
		return result("error", [read.detail]);
	}
	if (read.kind === "absent") {
		return result("refused", [
			"no providers.json yet: start one Cline card on Bedrock (Cline writes the file), then run this again",
		]);
	}
	const now = options.now ?? new Date();
	const { document, settings } = read;
	const facts = describeClineBedrockKey(settings, options.env);
	if (facts.credentials === "iam") {
		return result("refused", [
			`providers.json has Bedrock use AWS credentials (aws.authentication iam/profile): a stored key would be unused. Change it with \`cline auth bedrock\` instead`,
		]);
	}
	if (facts.credentials === "access-keys") {
		return result("refused", [
			"providers.json stores AWS access keys for Bedrock; Kanban doesn't change how it authenticates. Change it with `cline auth bedrock` instead",
		]);
	}
	const region = facts.storedRegion ? null : (facts.envRegion ?? readNonEmptyString(options.defaultRegion));
	const lines: string[] = [];
	if (facts.storedKey !== "same") {
		lines.push(
			facts.storedKey === "none"
				? `store providers.bedrock.settings.apiKey from ${CLINE_BEDROCK_KEY_ENV}`
				: `replace providers.bedrock.settings.apiKey (a different value) with ${CLINE_BEDROCK_KEY_ENV}`,
		);
	}
	if (region) {
		lines.push(`store providers.bedrock.settings.aws.region = ${region}`);
	}
	if (!facts.storedRegion && !region) {
		return result("refused", ["no Bedrock region: set AWS_REGION or models.bedrockRegion"]);
	}
	if (lines.length === 0) {
		return result("nothing-to-do", [
			`providers.json already stores ${CLINE_BEDROCK_KEY_ENV}'s key and region ${facts.storedRegion}`,
		]);
	}
	lines.push("the model and the other providers stay as they are");
	if (options.dryRun) {
		return result("would-write", lines);
	}

	const providers = isJsonObject(document.providers) ? document.providers : {};
	document.providers = providers;
	const target: JsonObject = settings ?? { provider: "bedrock" };
	if (!settings) {
		providers.bedrock = newBedrockEntry(target, now);
	}
	target.provider ??= "bedrock";
	target.apiKey = envValue;
	if (region) {
		target.aws = { ...(isJsonObject(target.aws) ? target.aws : {}), region };
	}
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

/**
 * `kanban cline remove-bedrock-key` always refuses now: without a stored key Cline's TUI opens its sign-in screen and
 * no Cline card on Bedrock starts (issue #9). Kept so the old command, printed by earlier doctors, explains itself.
 */
export function refuseRemoveClineBedrockKey(): ClineBedrockKeyCommandResult {
	return result("refused", [
		`Cline's TUI (cline 3.0.69) needs the Bedrock key stored in providers.json: with only ${CLINE_BEDROCK_KEY_ENV} it opens Cline's sign-in screen and Bedrock cards never start`,
		`to store the environment's key (again): ${STORE_BEDROCK_KEY_COMMAND}`,
	]);
}
