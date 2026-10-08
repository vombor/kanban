// Cline's Bedrock key: from Kanban's environment (AWS_BEARER_TOKEN_BEDROCK, a podman secret in the container), not
// stored in plain text in Cline's providers.json. Read by `kanban setup`'s cline-providers step and doctor's row, and
// `kanban cline remove-bedrock-key` (the user's command, the only path that changes providers.json) removes the stored
// key. Never prints or returns a key value: only whether one is there and whether it equals the env's.
//
// What cline 3.0.69 does (checked in @cline/llms's Bedrock client, and with real runs in a throwaway
// CLINE_DIR/CLINE_DATA_DIR, 2026-10-08): `settings.apiKey` in providers.json wins; without it the client takes
// AWS_BEARER_TOKEN_BEDROCK from its own process env, a direct run and a hub daemon session alike. It doesn't fall back
// to the env when `aws.authentication` is `iam`/`profile` (the key is unused then) or when an access-key pair
// (`aws.accessKey` + `aws.secretKey`) is stored without `aws.authentication: "api-key"` (the access keys are used).
// The hub daemon keeps the env of the card that started it, so a daemon started before the variable existed has no
// key once the stored one is gone: the command refuses while one runs (or the server lacks it).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { quoteShellArg } from "../core/shell";
import { backupClineFile, getClineBackupDir, replaceClineFileAtomically } from "./cline-file-write";

export const CLINE_BEDROCK_KEY_ENV = "AWS_BEARER_TOKEN_BEDROCK";
export const REMOVE_BEDROCK_KEY_COMMAND = "kanban cline remove-bedrock-key";
export const CLINE_BEDROCK_AUTH_DOC = "docs/fork/cline-bedrock-auth.md";
/** The podman quadlet line that hands Kanban the key (docs/fork/cline-bedrock-auth.md). */
export const BEDROCK_PODMAN_SECRET_LINE = `Secret=<secret name>,type=env,target=${CLINE_BEDROCK_KEY_ENV}`;

const CLINE_HUB_DAEMON_FLAG = "--cline-hub-daemon";
const PROC_ROOT = "/proc";

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
	 * What Cline uses without a stored key: `env` (AWS_BEARER_TOKEN_BEDROCK), `iam` (aws.authentication iam/profile:
	 * a stored key is unused too) or `access-keys` (a stored access-key pair, which wins over the env).
	 */
	withoutStoredKey: "env" | "iam" | "access-keys";
	/** `settings.aws.region`, else AWS_REGION. */
	region: string | null;
}

export function describeClineBedrockKey(settings: JsonObject | null, env: NodeJS.ProcessEnv): ClineBedrockKeyFacts {
	const aws = settings && isJsonObject(settings.aws) ? settings.aws : {};
	const stored = readNonEmptyString(settings?.apiKey);
	const envValue = readNonEmptyString(env[CLINE_BEDROCK_KEY_ENV]);
	const authentication = readNonEmptyString(aws.authentication);
	const withoutStoredKey =
		authentication === "iam" || authentication === "profile"
			? "iam"
			: authentication !== "api-key" &&
					authentication !== "apikey" &&
					readNonEmptyString(aws.accessKey) &&
					readNonEmptyString(aws.secretKey)
				? "access-keys"
				: "env";
	return {
		storedKey: stored === null ? "none" : stored === envValue ? "same" : "different",
		envKey: envValue !== null,
		withoutStoredKey,
		region: readNonEmptyString(aws.region) ?? readNonEmptyString(env.AWS_REGION),
	};
}

/** One line about the stored key, for setup and doctor (they add the command); null when nothing is stored. Never the key. */
export function describeStoredBedrockKey(facts: ClineBedrockKeyFacts, providersPath: string): string | null {
	if (facts.storedKey === "none") {
		return null;
	}
	if (facts.withoutStoredKey === "iam") {
		return `Cline stores a Bedrock API key in ${providersPath} that it doesn't use (aws.authentication is iam/profile)`;
	}
	if (facts.withoutStoredKey === "access-keys") {
		return `Cline stores a Bedrock API key and AWS access keys in ${providersPath}: without the API key it uses the access keys, not ${CLINE_BEDROCK_KEY_ENV}`;
	}
	if (!facts.envKey) {
		return `Cline stores a Bedrock API key in plain text in ${providersPath}; provide it as ${CLINE_BEDROCK_KEY_ENV} in Kanban's environment instead (podman: ${BEDROCK_PODMAN_SECRET_LINE}), then remove the stored one`;
	}
	return `Cline stores a Bedrock API key in ${providersPath}; the environment already provides it (${
		facts.storedKey === "same"
			? `the same value as ${CLINE_BEDROCK_KEY_ENV}`
			: `a different value than ${CLINE_BEDROCK_KEY_ENV}; Cline uses the stored one`
	})`;
}

export interface ClineKeyLauncher {
	pid: number;
	role: "kanban server" | "Cline hub daemon";
	/** Its env compared with this process's AWS_BEARER_TOKEN_BEDROCK. */
	env: "same" | "missing" | "different" | "unreadable";
}

export interface ClineKeyLauncherDeps {
	/** Default /proc. Tests point it at a fake one. */
	procRoot?: string;
	/** The live Kanban server's pid (its cards inherit its env), if one runs. */
	serverPid?: number | null;
}

async function readProcessEnvValue(procRoot: string, pid: number, name: string): Promise<string | null | undefined> {
	try {
		const environ = await readFile(join(procRoot, String(pid), "environ"), "utf8");
		const prefix = `${name}=`;
		const line = environ.split("\0").find((entry) => entry.startsWith(prefix));
		return line === undefined ? null : line.slice(prefix.length);
	} catch {
		return undefined;
	}
}

async function listClineHubDaemonPids(procRoot: string): Promise<number[]> {
	const names = await readdir(procRoot).catch(() => []);
	const pids: number[] = [];
	for (const name of names) {
		if (!/^\d+$/u.test(name)) {
			continue;
		}
		const cmdline = await readFile(join(procRoot, name, "cmdline"), "utf8").catch(() => "");
		if (cmdline.split("\0").includes(CLINE_HUB_DAEMON_FLAG)) {
			pids.push(Number(name));
		}
	}
	return pids;
}

/**
 * The processes Cline cards get their env from: the Kanban server and every running Cline hub daemon, each with
 * whether its AWS_BEARER_TOKEN_BEDROCK equals `envValue`. Compares only; never returns a value.
 */
export async function listClineKeyLaunchers(
	envValue: string | null,
	deps: ClineKeyLauncherDeps = {},
): Promise<ClineKeyLauncher[]> {
	const procRoot = deps.procRoot ?? PROC_ROOT;
	const targets: Array<Pick<ClineKeyLauncher, "pid" | "role">> = [
		...(deps.serverPid ? [{ pid: deps.serverPid, role: "kanban server" as const }] : []),
		...(await listClineHubDaemonPids(procRoot)).map((pid) => ({ pid, role: "Cline hub daemon" as const })),
	];
	const launchers: ClineKeyLauncher[] = [];
	for (const target of targets) {
		const value = await readProcessEnvValue(procRoot, target.pid, CLINE_BEDROCK_KEY_ENV);
		const current = value === undefined ? undefined : readNonEmptyString(value);
		const env =
			current === undefined
				? "unreadable"
				: current === null
					? "missing"
					: current === envValue
						? "same"
						: "different";
		launchers.push({ ...target, env });
	}
	return launchers;
}

const LAUNCHER_ENV_TEXT: Record<Exclude<ClineKeyLauncher["env"], "same">, string> = {
	missing: `has no ${CLINE_BEDROCK_KEY_ENV}`,
	different: `has a different ${CLINE_BEDROCK_KEY_ENV}`,
	unreadable: "has an environment this user can't read",
};

export function describeClineKeyLauncher(launcher: ClineKeyLauncher): string {
	const state = launcher.env === "same" ? `has the same ${CLINE_BEDROCK_KEY_ENV}` : LAUNCHER_ENV_TEXT[launcher.env];
	return `${launcher.role} pid ${launcher.pid} ${state}`;
}

export interface RemoveClineBedrockKeyOptions {
	providersPath: string;
	env: NodeJS.ProcessEnv;
	dryRun: boolean;
	/** Default: `<home>/backups/cline`. */
	backupDir?: string;
	now?: Date;
	launcherDeps?: ClineKeyLauncherDeps;
}

export interface RemoveClineBedrockKeyResult {
	/** `refused`: a precondition failed and nothing was written; `error`: providers.json can't be used. */
	status: "nothing-to-do" | "would-write" | "written" | "refused" | "error";
	lines: string[];
	backupPath: string | null;
	/** The command that puts the backup back. */
	rollback: string | null;
}

/**
 * `kanban cline remove-bedrock-key`: deletes `providers.bedrock.settings.apiKey` from Cline's providers.json, leaving
 * the region, model and every other provider alone, once the environment provides the key. Backs the file up into
 * the Kanban home first and writes atomically.
 */
export async function removeClineBedrockKey(
	options: RemoveClineBedrockKeyOptions,
): Promise<RemoveClineBedrockKeyResult> {
	const refused = (lines: string[]): RemoveClineBedrockKeyResult => ({
		status: "refused",
		lines,
		backupPath: null,
		rollback: null,
	});
	const envValue = readNonEmptyString(options.env[CLINE_BEDROCK_KEY_ENV]);
	if (envValue === null) {
		return refused([
			`${CLINE_BEDROCK_KEY_ENV} is not set here: without it Cline would have no Bedrock key. Set it in Kanban's environment (podman: ${BEDROCK_PODMAN_SECRET_LINE}) and run this from that environment`,
		]);
	}
	const read = await readClineBedrockSettings(options.providersPath);
	if (read.kind === "absent") {
		return { status: "nothing-to-do", lines: ["no providers.json"], backupPath: null, rollback: null };
	}
	if (read.kind === "invalid") {
		return { status: "error", lines: [read.detail], backupPath: null, rollback: null };
	}
	const facts = describeClineBedrockKey(read.settings, options.env);
	if (facts.storedKey === "none") {
		return {
			status: "nothing-to-do",
			lines: [`no Bedrock API key stored; Cline uses ${CLINE_BEDROCK_KEY_ENV}`],
			backupPath: null,
			rollback: null,
		};
	}
	if (facts.withoutStoredKey === "access-keys") {
		return refused([
			`providers.json also stores AWS access keys for Bedrock: without the API key Cline would use those, not ${CLINE_BEDROCK_KEY_ENV}. Change it with \`cline auth bedrock\` instead`,
		]);
	}
	const blocking = (await listClineKeyLaunchers(envValue, options.launcherDeps)).filter(
		(launcher) => launcher.env !== "same",
	);
	if (blocking.length > 0) {
		return refused([
			...blocking.map(
				(launcher) =>
					`${describeClineKeyLauncher(launcher)}: it uses the stored key now and would have no key (or another one) without it`,
			),
			`restart it from an environment with ${CLINE_BEDROCK_KEY_ENV} first (a hub daemon serves every Cline card: stop it while they are idle, the next Cline card starts a new one from the server's environment)`,
		]);
	}

	const lines = [
		`remove providers.bedrock.settings.apiKey (${facts.storedKey === "same" ? `the same value as ${CLINE_BEDROCK_KEY_ENV}` : `a different value than ${CLINE_BEDROCK_KEY_ENV}: Cline uses the env's from now on`})`,
		"region, model and the other providers stay as they are",
	];
	if (options.dryRun) {
		return { status: "would-write", lines, backupPath: null, rollback: null };
	}
	// The checks above read /proc; never overwrite an edit made meanwhile.
	if ((await readFile(options.providersPath, "utf8")) !== read.raw) {
		return {
			status: "error",
			lines: [...lines, "providers.json changed meanwhile; nothing written, run the command again"],
			backupPath: null,
			rollback: null,
		};
	}
	const settings = read.settings as JsonObject;
	delete settings.apiKey;
	const backupPath = await backupClineFile({
		path: options.providersPath,
		raw: read.raw,
		backupDir: options.backupDir ?? getClineBackupDir(),
		now: options.now ?? new Date(),
	});
	await replaceClineFileAtomically(options.providersPath, `${JSON.stringify(read.document, null, 2)}\n`);
	return {
		status: "written",
		lines,
		backupPath,
		rollback: `cp ${quoteShellArg(backupPath)} ${quoteShellArg(options.providersPath)}`,
	};
}
