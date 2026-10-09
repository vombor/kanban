// The machine's Kanban GitHub App (docs/fork/github-bots.md): one app for every project, created once by the user
// (`kanban github bot create`, the manifest flow in app-manifest.ts). Its id, slug and private key live in one file
// under the Kanban home, `<home>/secrets/github-app.json`, written atomically with mode 0600 in a 0700 dir. The key
// is only ever read by the server process to sign app JWTs (app-jwt.ts): never logged, never in config.json, a
// project repo, an error message or an agent's env or prompt. `describeGitHubApp` is the key-free view everything
// else gets.
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { getGitHubAppCredentialsPath } from "../state/kanban-home";

export const GITHUB_APP_CREDENTIALS_VERSION = 1;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const githubAppCredentialsSchema = z
	.object({
		version: z.literal(GITHUB_APP_CREDENTIALS_VERSION),
		appId: z.number().int().positive(),
		slug: z.string().min(1),
		name: z.string().min(1),
		ownerLogin: z.string().min(1),
		/** An organization owns it (its settings page is under the org). */
		ownerIsOrg: z.boolean(),
		htmlUrl: z.string().min(1),
		clientId: z.string().nullable(),
		privateKey: z.string().min(1),
		createdAt: z.string(),
	})
	.strict();
export type GitHubAppCredentials = z.infer<typeof githubAppCredentialsSchema>;

/** The app without its key: what the CLI, doctor and the logs may see. */
export interface GitHubAppInfo {
	appId: number;
	slug: string;
	name: string;
	ownerLogin: string;
	htmlUrl: string;
	createdAt: string;
	/** Where the user installs it (or changes which repositories it covers). */
	installUrl: string;
	/** The app's settings page (Display information: the logo). */
	settingsUrl: string;
}

export function getGitHubAppInstallUrl(slug: string): string {
	return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

export function getGitHubAppSettingsUrl(slug: string, ownerLogin: string | null, ownerIsOrg = false): string {
	return ownerIsOrg && ownerLogin
		? `https://github.com/organizations/${encodeURIComponent(ownerLogin)}/settings/apps/${encodeURIComponent(slug)}`
		: `https://github.com/settings/apps/${encodeURIComponent(slug)}`;
}

export function describeGitHubApp(credentials: GitHubAppCredentials): GitHubAppInfo {
	return {
		appId: credentials.appId,
		slug: credentials.slug,
		name: credentials.name,
		ownerLogin: credentials.ownerLogin,
		htmlUrl: credentials.htmlUrl,
		createdAt: credentials.createdAt,
		installUrl: getGitHubAppInstallUrl(credentials.slug),
		settingsUrl: getGitHubAppSettingsUrl(credentials.slug, credentials.ownerLogin, credentials.ownerIsOrg),
	};
}

export class GitHubAppCredentialsError extends Error {}

function isMissingFile(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/** The app's credentials, or null when no app was created yet. Throws (without the file's content) when unreadable. */
export async function readGitHubAppCredentials(
	path: string = getGitHubAppCredentialsPath(),
): Promise<GitHubAppCredentials | null> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) {
			return null;
		}
		throw new GitHubAppCredentialsError(`${path} can't be read`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new GitHubAppCredentialsError(`${path} is not valid JSON`);
	}
	const result = githubAppCredentialsSchema.safeParse(parsed);
	if (!result.success) {
		// The issue paths only, never a value: the file holds the private key.
		throw new GitHubAppCredentialsError(
			`${path} is not a Kanban GitHub App file (${result.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ")})`,
		);
	}
	return result.data;
}

/** Writes the credentials atomically: 0700 dir, 0600 file (created with that mode, so it is never readable). */
export async function writeGitHubAppCredentials(
	credentials: GitHubAppCredentials,
	path: string = getGitHubAppCredentialsPath(),
): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true, mode: DIR_MODE });
	await chmod(dir, DIR_MODE);
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temp, `${JSON.stringify(githubAppCredentialsSchema.parse(credentials), null, "\t")}\n`, {
		mode: FILE_MODE,
		flag: "wx",
	});
	await chmod(temp, FILE_MODE);
	await rename(temp, path);
}

export interface GitHubAppFileModes {
	path: string;
	exists: boolean;
	/** Permission bits (e.g. 0o600), or null when missing. */
	fileMode: number | null;
	dirMode: number | null;
}

export async function readGitHubAppFileModes(
	path: string = getGitHubAppCredentialsPath(),
): Promise<GitHubAppFileModes> {
	const [file, dir] = await Promise.all([stat(path).catch(() => null), stat(dirname(path)).catch(() => null)]);
	return {
		path,
		exists: file !== null,
		fileMode: file ? file.mode & 0o777 : null,
		dirMode: dir ? dir.mode & 0o777 : null,
	};
}

/** True when the group or others may read or write it. */
export function isModeTooOpen(mode: number | null): boolean {
	return mode !== null && (mode & 0o077) !== 0;
}

export { DIR_MODE as GITHUB_APP_DIR_MODE, FILE_MODE as GITHUB_APP_FILE_MODE };
