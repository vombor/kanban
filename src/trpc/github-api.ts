// The runtime side of `kanban github ...` (docs/fork/github-bots.md): GitHub issues and comments as the machine's
// Kanban GitHub App, and the user's creation of that app.
//   - `issue`: the strict caller lookup decides who posts. A card or the orchestrator of workspace X posts for X
//     (the attribution line names X and the role), only to X's own GitHub remotes and `github.sharedRepos` (Kanban
//     bug reports); a session of another workspace and an unidentified caller are refused in every isolation mode.
//     The user posts for the workspace they name, to any repository. The token is minted here and never leaves the
//     server: the answer carries the issue's number and URL only.
//   - `startAppCreation` / `appStatus`: the manifest flow (src/github-app/app-manifest.ts), the user's only.
import { z } from "zod";

import { type GitHubSettings, readPipelineConfig } from "../config/pipeline-config";
import { resolveCardRole } from "../core/card-role";
import type { GitHubAppInfo } from "../github-app/app-credentials";
import type { GitHubAppCreationFlow } from "../github-app/app-manifest";
import { describePosterRole, type GitHubPostAuthor } from "../github-app/attribution";
import { type GitHubHttpOptions, GitHubRateLimitError } from "../github-app/github-http";
import type { GitHubAppTokenSource } from "../github-app/installation-tokens";
import {
	type GitHubIssueAction,
	performGitHubIssueAction,
	resolveIssueWriteCredential,
} from "../github-app/issue-writer";
import type { IsolationService } from "../isolation/isolation-service";
import { describeCaller, type RuntimeCaller } from "../isolation/session-identity";
import type { IssueAuth } from "../issues/issue-auth";
import { type GitRemote, listGitRemotes, listProviderRepos } from "../issues/issue-repo";
import { loadWorkspaceBoardById } from "../state/workspace-state";

const repoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, "expected owner/name");
const numberSchema = z.number().int().positive();
const titleSchema = z.string().trim().min(1).max(256);
// GitHub's limit is 65 536 characters; the attribution line needs room.
const bodySchema = z.string().max(65_000);

export const githubIssueRequestSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("create"),
		repo: repoSchema,
		title: titleSchema,
		body: bodySchema,
		labels: z.array(z.string().min(1).max(50)).max(20).optional(),
	}),
	z.object({ action: z.literal("comment"), repo: repoSchema, number: numberSchema, body: bodySchema.min(1) }),
	z.object({
		action: z.literal("edit"),
		repo: repoSchema,
		number: numberSchema,
		title: titleSchema.optional(),
		body: bodySchema.optional(),
	}),
	z.object({
		action: z.literal("close"),
		repo: repoSchema,
		number: numberSchema,
		reason: z.enum(["completed", "not_planned"]).optional(),
		comment: bodySchema.min(1).optional(),
	}),
]);
export type GitHubIssueRequest = z.infer<typeof githubIssueRequestSchema>;

export const githubIssueResponseSchema = z.object({
	ok: z.boolean(),
	via: z.enum(["app", "pat"]).nullable(),
	number: z.number().nullable(),
	url: z.string().nullable(),
	commentUrl: z.string().nullable(),
	/** Who the post names (the attribution line). */
	postedAs: z.string().nullable(),
	warning: z.string().nullable(),
	error: z.string().optional(),
	installUrl: z.string().optional(),
	/** GitHub's rate limit: when to try again (ISO). */
	retryAfter: z.string().optional(),
});
export type GitHubIssueResponse = z.infer<typeof githubIssueResponseSchema>;

export const githubAppStartRequestSchema = z.object({
	name: z.string().trim().min(1).max(34),
	origin: z.string().url(),
	org: z
		.string()
		.regex(/^[A-Za-z0-9-]+$/u)
		.nullable()
		.optional(),
});

const githubAppInfoSchema = z.object({
	appId: z.number(),
	slug: z.string(),
	name: z.string(),
	ownerLogin: z.string(),
	htmlUrl: z.string(),
	createdAt: z.string(),
	installUrl: z.string(),
	settingsUrl: z.string(),
});

export const githubAppStartResponseSchema = z.object({
	ok: z.boolean(),
	startUrl: z.string().nullable(),
	expiresAt: z.string().nullable(),
	/** An app already exists (creating another replaces it). */
	existing: githubAppInfoSchema.nullable(),
	error: z.string().optional(),
});
export type GitHubAppStartResponse = z.infer<typeof githubAppStartResponseSchema>;

export const githubAppStatusResponseSchema = z.object({
	ok: z.boolean(),
	app: githubAppInfoSchema.nullable(),
	error: z.string().optional(),
});
export type GitHubAppStatusResponse = z.infer<typeof githubAppStatusResponseSchema>;

export type GitHubPosterDecision =
	| { allowed: true; author: GitHubPostAuthor; restrictRepos: boolean; taskId: string | null }
	| { allowed: false; message: string };

/** Who may post for `workspaceId`: the user, and that workspace's own sessions (orchestrator and cards). */
export function decideGitHubPoster(
	caller: RuntimeCaller,
	workspaceId: string,
	cardRole: string | null,
): GitHubPosterDecision {
	if (caller.kind === "user") {
		return { allowed: true, author: { project: workspaceId, role: "user" }, restrictRepos: false, taskId: null };
	}
	if (caller.kind === "session") {
		if (caller.session.workspaceId !== workspaceId) {
			return {
				allowed: false,
				message: `GitHub posts for ${workspaceId} come only from ${workspaceId}'s own sessions and the user, not ${describeCaller(caller)}.`,
			};
		}
		return {
			allowed: true,
			author: { project: workspaceId, role: describePosterRole(caller, cardRole) },
			restrictRepos: true,
			taskId: caller.session.taskId,
		};
	}
	return {
		allowed: false,
		message: `Kanban posts to GitHub only for an identified session or the user; ${describeCaller(caller)} can't. Run the command from your Kanban session.`,
	};
}

/** The repositories a project's sessions may post to: its own GitHub remotes and the shared ones. */
export function listAllowedIssueRepos(remotes: readonly GitRemote[], sharedRepos: readonly string[]): string[] {
	return [...new Set([...listProviderRepos("github", remotes).map((entry) => entry.repo), ...sharedRepos])];
}

export interface RuntimeGitHubApi {
	issue: (input: {
		caller: RuntimeCaller;
		workspaceId: string;
		workspacePath: string;
		request: GitHubIssueRequest;
	}) => Promise<GitHubIssueResponse>;
	startAppCreation: (input: {
		caller: RuntimeCaller;
		request: z.infer<typeof githubAppStartRequestSchema>;
	}) => Promise<GitHubAppStartResponse>;
	appStatus: (input: { caller: RuntimeCaller }) => Promise<GitHubAppStatusResponse>;
}

export interface CreateGitHubApiDependencies {
	tokenSource: GitHubAppTokenSource;
	flow: GitHubAppCreationFlow;
	log: IsolationService["log"];
	warn?: (message: string) => void;
	readSettings?: () => Promise<GitHubSettings>;
	listRemotes?: (repoPath: string) => Promise<GitRemote[]>;
	/** A card's role (resolveCardRole), or null when it isn't on the board. */
	readCardRole?: (workspaceId: string, taskId: string) => Promise<string | null>;
	resolvePat?: () => Promise<IssueAuth>;
	http?: GitHubHttpOptions;
}

async function defaultReadCardRole(workspaceId: string, taskId: string): Promise<string | null> {
	const board = await loadWorkspaceBoardById(workspaceId);
	const card = board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId);
	return card ? resolveCardRole(card) : null;
}

function failure(error: string, extra: Partial<GitHubIssueResponse> = {}): GitHubIssueResponse {
	return {
		ok: false,
		via: null,
		number: null,
		url: null,
		commentUrl: null,
		postedAs: null,
		warning: null,
		error,
		...extra,
	};
}

function toAppInfo(app: GitHubAppInfo | null): z.infer<typeof githubAppInfoSchema> | null {
	return app ? { ...app } : null;
}

export function createGitHubApi(deps: CreateGitHubApiDependencies): RuntimeGitHubApi {
	const readSettings = deps.readSettings ?? (async () => (await readPipelineConfig()).config.github);
	const readCardRole = deps.readCardRole ?? defaultReadCardRole;
	const listRemotes = deps.listRemotes ?? listGitRemotes;
	const refuseNonUser = async (caller: RuntimeCaller, action: string): Promise<string | null> => {
		if (caller.kind === "user") {
			return null;
		}
		await deps.log([caller.kind === "session" ? caller.session.workspaceId : null], {
			kind: "refused",
			taskId: caller.kind === "session" ? caller.session.taskId : null,
			from: caller.kind === "session" ? caller.session.workspaceId : null,
			to: null,
			action,
			detail: "the Kanban GitHub App is the user's to create",
		});
		return `The Kanban GitHub App is the user's to create; ${describeCaller(caller)} can't. Ask the user to run kanban github bot create.`;
	};
	return {
		issue: async ({ caller, workspaceId, workspacePath, request }) => {
			const cardRole =
				caller.kind === "session" && caller.session.role === "card"
					? await readCardRole(workspaceId, caller.session.taskId).catch(() => null)
					: null;
			const decision = decideGitHubPoster(caller, workspaceId, cardRole);
			if (!decision.allowed) {
				await deps.log([workspaceId, caller.kind === "session" ? caller.session.workspaceId : null], {
					kind: "refused",
					taskId: caller.kind === "session" ? caller.session.taskId : null,
					from: caller.kind === "session" ? caller.session.workspaceId : null,
					to: workspaceId,
					action: `github.issue.${request.action}`,
					detail: `${request.repo}: ${caller.kind === "unknown" ? caller.reason : "another workspace's session"}`,
				});
				return failure(decision.message);
			}
			const settings = await readSettings();
			if (decision.restrictRepos) {
				const allowed = listAllowedIssueRepos(await listRemotes(workspacePath), settings.sharedRepos);
				if (!allowed.some((repo) => repo.toLowerCase() === request.repo.toLowerCase())) {
					return failure(
						`${workspaceId}'s sessions post only to the project's own GitHub repositories and the shared ones (${allowed.join(", ") || "none"}), not ${request.repo}. Ask the user if another repository needs this.`,
					);
				}
			}
			let credential: Awaited<ReturnType<typeof resolveIssueWriteCredential>>;
			try {
				credential = await resolveIssueWriteCredential({
					repo: request.repo,
					tokenSource: deps.tokenSource,
					resolvePat: deps.resolvePat,
				});
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			if (!credential.ok) {
				return failure(credential.error, credential.installUrl ? { installUrl: credential.installUrl } : {});
			}
			const postedAs = [decision.author.project, decision.author.role].filter(Boolean).join(" · ");
			try {
				const result = await performGitHubIssueAction({
					action: request satisfies GitHubIssueAction,
					token: credential.credential.token,
					author: decision.author,
					attribution: settings,
					http: deps.http,
				});
				deps.warn?.(
					`github ${workspaceId}: ${request.action} ${request.repo}#${result.number} as ${postedAs} via ${credential.credential.via === "app" ? `app ${credential.credential.app.slug}` : `the PAT (${credential.credential.source})`}`,
				);
				return {
					ok: true,
					via: credential.credential.via,
					number: result.number,
					url: result.url,
					commentUrl: result.commentUrl,
					postedAs,
					warning: credential.credential.via === "pat" ? credential.credential.warning : null,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const retryAfter = error instanceof GitHubRateLimitError ? new Date(error.until).toISOString() : undefined;
				return failure(message, retryAfter ? { retryAfter } : {});
			}
		},
		startAppCreation: async ({ caller, request }) => {
			const refusal = await refuseNonUser(caller, "github.startAppCreation");
			if (refusal) {
				return { ok: false, startUrl: null, expiresAt: null, existing: null, error: refusal };
			}
			const existing = await deps.tokenSource.getApp().catch(() => null);
			const started = deps.flow.start({ name: request.name, origin: request.origin, org: request.org ?? null });
			return { ok: true, startUrl: started.startUrl, expiresAt: started.expiresAt, existing: toAppInfo(existing) };
		},
		appStatus: async ({ caller }) => {
			if (caller.kind === "unknown") {
				return { ok: false, app: null, error: `${describeCaller(caller)} can't ask about the GitHub App.` };
			}
			try {
				return { ok: true, app: toAppInfo(await deps.tokenSource.getApp()) };
			} catch (error) {
				return { ok: false, app: null, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}
