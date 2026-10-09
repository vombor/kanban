// Installation tokens of the machine's Kanban GitHub App, minted by the server only. For a repository: the app's JWT
// finds its installation there (GET /repos/{owner}/{repo}/installation; 404 = the app isn't installed on it), then
// POST /app/installations/{id}/access_tokens mints a token scoped to that one repository with Issues write and
// Metadata read. Tokens are cached in memory per repository until 5 minutes before GitHub's `expires_at` (they live
// an hour), installation ids for 10 minutes. Nothing here is ever written to a file, a log or an error message.
import { z } from "zod";

import {
	describeGitHubApp,
	type GitHubAppCredentials,
	type GitHubAppInfo,
	readGitHubAppCredentials,
} from "./app-credentials";
import { createGitHubAppJwt } from "./app-jwt";
import { GITHUB_APP_PERMISSIONS } from "./app-manifest";
import { assertGitHubRepo, GitHubApiError, type GitHubHttpOptions, sendGitHubRequest } from "./github-http";

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const INSTALLATION_CACHE_MS = 10 * 60 * 1000;

export type GitHubAppRepoAccess =
	| { kind: "app"; token: string; installationId: number; app: GitHubAppInfo }
	| { kind: "no_app" }
	| { kind: "not_installed"; app: GitHubAppInfo; message: string };

export type GitHubAppInstallationLookup =
	| { kind: "installed"; installationId: number; app: GitHubAppInfo }
	| { kind: "no_app" }
	| { kind: "not_installed"; app: GitHubAppInfo; message: string };

export interface GitHubAppTokenSource {
	/** The app (without its key), or null when none was created. */
	getApp: () => Promise<GitHubAppInfo | null>;
	/** Whether the app is installed on the repository (no token minted). */
	findInstallation: (repo: string) => Promise<GitHubAppInstallationLookup>;
	/** A token for the repository's issues, or why there is none. */
	tokenForRepo: (repo: string) => Promise<GitHubAppRepoAccess>;
}

export interface GitHubAppTokenSourceDependencies extends GitHubHttpOptions {
	readCredentials?: () => Promise<GitHubAppCredentials | null>;
}

const installationSchema = z.object({ id: z.number().int().positive() }).passthrough();
const accessTokenSchema = z.object({ token: z.string().min(1), expires_at: z.string() }).passthrough();

export function describeNotInstalled(app: GitHubAppInfo, repo: string): string {
	return `The Kanban GitHub App (${app.slug}) is not installed on ${repo}. The user installs it there (or on All repositories): ${app.installUrl}`;
}

export function createGitHubAppTokenSource(deps: GitHubAppTokenSourceDependencies = {}): GitHubAppTokenSource {
	const now = deps.now ?? Date.now;
	const readCredentials = deps.readCredentials ?? (async () => await readGitHubAppCredentials());
	const installations = new Map<string, { appId: number; installationId: number; at: number }>();
	const tokens = new Map<string, { appId: number; token: string; refreshAt: number; installationId: number }>();

	const appJwt = (credentials: GitHubAppCredentials) =>
		createGitHubAppJwt({ appId: credentials.appId, privateKey: credentials.privateKey, now: now() });

	const lookup = async (
		credentials: GitHubAppCredentials,
		repo: string,
	): Promise<{ installationId: number } | null> => {
		const key = repo.toLowerCase();
		const cached = installations.get(key);
		if (cached && cached.appId === credentials.appId && now() - cached.at < INSTALLATION_CACHE_MS) {
			return { installationId: cached.installationId };
		}
		try {
			const { body } = await sendGitHubRequest(deps, {
				method: "GET",
				path: `/repos/${repo}/installation`,
				bearer: appJwt(credentials),
				what: `looking up the app's installation on ${repo}`,
			});
			const parsed = installationSchema.safeParse(body);
			if (!parsed.success) {
				throw new GitHubApiError(`GitHub's installation answer for ${repo} has no id`, 200);
			}
			installations.set(key, { appId: credentials.appId, installationId: parsed.data.id, at: now() });
			return { installationId: parsed.data.id };
		} catch (error) {
			if (error instanceof GitHubApiError && error.status === 404) {
				installations.delete(key);
				tokens.delete(key);
				return null;
			}
			throw error;
		}
	};

	return {
		getApp: async () => {
			const credentials = await readCredentials();
			return credentials ? describeGitHubApp(credentials) : null;
		},
		findInstallation: async (rawRepo) => {
			const repo = assertGitHubRepo(rawRepo);
			const credentials = await readCredentials();
			if (!credentials) {
				return { kind: "no_app" };
			}
			const app = describeGitHubApp(credentials);
			const found = await lookup(credentials, repo);
			return found
				? { kind: "installed", installationId: found.installationId, app }
				: { kind: "not_installed", app, message: describeNotInstalled(app, repo) };
		},
		tokenForRepo: async (rawRepo) => {
			const repo = assertGitHubRepo(rawRepo);
			const credentials = await readCredentials();
			if (!credentials) {
				return { kind: "no_app" };
			}
			const app = describeGitHubApp(credentials);
			const key = repo.toLowerCase();
			const cached = tokens.get(key);
			if (cached && cached.appId === credentials.appId && now() < cached.refreshAt) {
				return { kind: "app", token: cached.token, installationId: cached.installationId, app };
			}
			const found = await lookup(credentials, repo);
			if (!found) {
				return { kind: "not_installed", app, message: describeNotInstalled(app, repo) };
			}
			const { body } = await sendGitHubRequest(deps, {
				method: "POST",
				path: `/app/installations/${found.installationId}/access_tokens`,
				bearer: appJwt(credentials),
				body: { repositories: [repo.split("/")[1]], permissions: GITHUB_APP_PERMISSIONS },
				what: `minting an installation token for ${repo}`,
			});
			const parsed = accessTokenSchema.safeParse(body);
			if (!parsed.success) {
				throw new GitHubApiError(`GitHub's installation token answer for ${repo} has no token`, 201);
			}
			const expiresAt = Date.parse(parsed.data.expires_at);
			const refreshAt = Number.isFinite(expiresAt) ? expiresAt - TOKEN_REFRESH_MARGIN_MS : now();
			tokens.set(key, {
				appId: credentials.appId,
				token: parsed.data.token,
				refreshAt,
				installationId: found.installationId,
			});
			return { kind: "app", token: parsed.data.token, installationId: found.installationId, app };
		},
	};
}

let sharedTokenSource: GitHubAppTokenSource | null = null;

/** The server's one token source (so every caller shares its cache). */
export function getSharedGitHubAppTokenSource(): GitHubAppTokenSource {
	sharedTokenSource ??= createGitHubAppTokenSource();
	return sharedTokenSource;
}
