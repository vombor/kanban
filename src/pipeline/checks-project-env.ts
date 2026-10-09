// The project's environment for a scripted checks run (kit project facts `checks.*`, kit-schema.ts `kitChecksSchema`).
// A snapshot export has no git-ignored files, so a database project's tests failed there on every run ("Environment
// variable not found: DATABASE_URL", notes f423d, issue #16, 2026-10-09). The project names what the run needs:
//
// - `envFile`: a file in the card's worktree (`.env`), copied into the export at the same path and loaded into every
//   step's env. Its `KANBAN_*` and secret-token variables are not loaded (checks.ts strips both).
// - `databaseUrlVar`: the variable in that file holding the database URL. The run then gets its own database: the URL
//   with its database name replaced by `CHECKS_DB` (`checks_<workspace>_<card>`), in the step env and in the copied
//   file, so the checks never touch the card's own data. `CHECKS_SOURCE_DATABASE_URL` keeps the card's URL for a
//   setup or teardown that must connect elsewhere to create or drop it.
// - `setup`/`teardown`: shell commands run in the export (checks.ts).
//
// The values are secrets: they never reach the logs, the stored result, the QA log or the QA prompt (every step's
// output and log file go through `redact`), and the copied file is deleted when the run ends.
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { parseEnv } from "node:util";

import type { KitChecks } from "../kits/kit-schema";

/** The run's own database name (the checks run one card at a time, so a leftover is the same card's next run's). */
export function buildChecksDatabaseName(workspaceId: string, taskId: string): string {
	return `checks_${workspaceId}_${taskId}`
		.toLowerCase()
		.replace(/[^a-z0-9_]/gu, "_")
		.slice(0, 63);
}

export interface ChecksProjectEnv {
	/** Variables for every step (on top of the checker's base env). */
	env: Record<string, string>;
	/** The copied file in the export; deleted by `cleanup`. */
	exportedFile: string | null;
	/** Replaces every secret value in a step's output. */
	redact: (text: string) => string;
	cleanup: () => Promise<void>;
}

/** A failure preparing the env: the message names keys and paths, never a value. */
export class ChecksProjectEnvError extends Error {}

const REDACTED = "[redacted]";
/** Shorter values (ports, flags, `development`) are not worth mangling the output for; URL passwords always are. */
const MIN_REDACTED_LENGTH = 8;
const NOT_SECRET = /^(?:true|false|\d+)$/iu;

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep);
}

async function readEnvFile(worktreePath: string, envFile: string): Promise<string> {
	let root: string;
	let source: string;
	try {
		root = await realpath(worktreePath);
		source = await realpath(join(worktreePath, envFile));
	} catch {
		throw new ChecksProjectEnvError(`checks.envFile ${envFile} is not in the card's worktree`);
	}
	// A card can make the file a symlink; only a file of its own worktree is copied.
	if (!isInside(root, source)) {
		throw new ChecksProjectEnvError(`checks.envFile ${envFile} points outside the card's worktree`);
	}
	try {
		return await readFile(source, "utf8");
	} catch {
		throw new ChecksProjectEnvError(`checks.envFile ${envFile} could not be read`);
	}
}

function replaceDatabaseName(url: string, databaseName: string, variable: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new ChecksProjectEnvError(`checks.databaseUrlVar ${variable} is not a URL`);
	}
	if (!parsed.host || !/^\/[^/]+$/u.test(parsed.pathname)) {
		throw new ChecksProjectEnvError(`checks.databaseUrlVar ${variable} is not a URL with a host and a database name`);
	}
	parsed.pathname = `/${databaseName}`;
	return parsed;
}

/** The file's text with `variable`'s assignment (the last one, as parseEnv reads it) set to `value`. */
function rewriteAssignment(text: string, variable: string, value: string): string {
	const lines = text.split("\n");
	const pattern = new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=`, "u");
	const index = lines.map((line) => pattern.test(line)).lastIndexOf(true);
	const assignment = `${variable}=${JSON.stringify(value)}`;
	if (index < 0) {
		return `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}${assignment}\n`;
	}
	lines[index] = assignment;
	return lines.join("\n");
}

function createRedactor(values: Iterable<string>): (text: string) => string {
	const secrets = [...new Set(values)].filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
	return (text) => secrets.reduce((current, secret) => current.split(secret).join(REDACTED), text);
}

function secretValuesOf(value: string): string[] {
	const found = value.length >= MIN_REDACTED_LENGTH && !NOT_SECRET.test(value) ? [value] : [];
	try {
		const { password } = new URL(value);
		if (password) {
			found.push(password, decodeURIComponent(password));
		}
	} catch {
		// Not a URL.
	}
	return found;
}

export interface PrepareChecksProjectEnvInput {
	facts: KitChecks | undefined;
	/** The card's worktree; null when it is gone. */
	worktreePath: string | null;
	/** The snapshot export. */
	exportDir: string;
	workspaceId: string;
	taskId: string;
	/** Variable names the step env never takes from the file (`KANBAN_*` is always dropped). */
	excludedNames: readonly string[];
}

/** Copies the env file into the export and builds the steps' variables. A project without `checks.*` gets nothing. */
export async function prepareChecksProjectEnv(input: PrepareChecksProjectEnvInput): Promise<ChecksProjectEnv> {
	const { facts } = input;
	const databaseName = buildChecksDatabaseName(input.workspaceId, input.taskId);
	const env: Record<string, string> = facts?.setup || facts?.teardown ? { CHECKS_DB: databaseName } : {};
	if (!facts?.envFile) {
		if (facts?.databaseUrlVar) {
			throw new ChecksProjectEnvError("checks.databaseUrlVar needs checks.envFile");
		}
		return { env, exportedFile: null, redact: (text) => text, cleanup: async () => {} };
	}
	if (!input.worktreePath) {
		throw new ChecksProjectEnvError(`checks.envFile ${facts.envFile}: the card has no worktree`);
	}
	let text = await readEnvFile(input.worktreePath, facts.envFile);
	let parsed: Record<string, string>;
	try {
		parsed = parseEnv(text) as Record<string, string>;
	} catch {
		throw new ChecksProjectEnvError(`checks.envFile ${facts.envFile} could not be parsed`);
	}
	const secrets = Object.values(parsed).flatMap(secretValuesOf);
	const loaded = Object.fromEntries(
		Object.entries(parsed).filter(([name]) => !name.startsWith("KANBAN_") && !input.excludedNames.includes(name)),
	);
	if (facts.databaseUrlVar) {
		const variable = facts.databaseUrlVar;
		const source = parsed[variable];
		if (!source) {
			throw new ChecksProjectEnvError(
				`checks.databaseUrlVar ${variable} is not set in checks.envFile ${facts.envFile}`,
			);
		}
		const url = replaceDatabaseName(source, databaseName, variable).toString();
		text = rewriteAssignment(text, variable, url);
		loaded[variable] = url;
		secrets.push(url, ...secretValuesOf(url));
		Object.assign(env, { CHECKS_DB: databaseName, CHECKS_SOURCE_DATABASE_URL: source });
	}
	const exportedFile = join(input.exportDir, facts.envFile);
	await mkdir(dirname(exportedFile), { recursive: true });
	// A committed file of the same name is replaced; removed first so the mode applies.
	await rm(exportedFile, { force: true });
	await writeFile(exportedFile, text, { mode: 0o600 });
	return {
		env: { ...loaded, ...env },
		exportedFile,
		redact: createRedactor(secrets),
		cleanup: async () => {
			await rm(exportedFile, { force: true });
		},
	};
}
