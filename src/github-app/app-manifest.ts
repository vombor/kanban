// Creating the machine's Kanban GitHub App through GitHub's App Manifest flow (GitHub has no API that creates an
// app with a PAT). `kanban github bot create` (the user's) asks the running server to start a flow:
//   1. the server keeps a one-time `state` (in memory, 1 h) and answers the URL of its own start page;
//   2. the user opens it; the page POSTs the manifest to github.com/settings/apps/new?state=… (or the org's page);
//   3. the user clicks Create; GitHub redirects to the manifest's `redirect_url` (the server's callback) with a code;
//   4. the server checks the state, exchanges the code (POST /app-manifests/{code}/conversions, no auth), writes the
//      app's id, slug and private key to the secrets file (app-credentials.ts) and redirects the browser to the app's
//      installation page, where the user picks "All repositories" (or selected ones);
//   5. GitHub sends the browser to `setup_url` after the install, which shows the last step: the logo.
// The URLs point at the origin the user's browser reaches Kanban on (the published port, not the pod's 127.0.0.1),
// which the CLI passes. GitHub's manifest has no logo field and no API sets an app's logo, so the user uploads the
// Kanban icon on the app's settings page (Display information); the server serves it at GITHUB_APP_LOGO_PATH.
import { randomBytes } from "node:crypto";

import { z } from "zod";

import { KANBAN_BUG_REPORT_REPO } from "../config/pipeline-config";
import {
	describeGitHubApp,
	GITHUB_APP_CREDENTIALS_VERSION,
	type GitHubAppCredentials,
	type GitHubAppInfo,
} from "./app-credentials";
import { type GitHubHttpOptions, sendGitHubRequest } from "./github-http";

export const GITHUB_APP_ROUTE_PREFIX = "/api/github/app";
export const GITHUB_APP_START_PATH = `${GITHUB_APP_ROUTE_PREFIX}/new`;
export const GITHUB_APP_CALLBACK_PATH = `${GITHUB_APP_ROUTE_PREFIX}/callback`;
export const GITHUB_APP_SETUP_PATH = `${GITHUB_APP_ROUTE_PREFIX}/installed`;
export const GITHUB_APP_LOGO_PATH = `${GITHUB_APP_ROUTE_PREFIX}/logo.png`;
/** The logo file in the web UI's assets (512×512 PNG, 6 KB: square and well under GitHub's 1 MB). */
export const GITHUB_APP_LOGO_ASSET = "assets/icon-512.png";

export const DEFAULT_GITHUB_APP_NAME = "Kanban agents";
const STATE_TTL_MS = 60 * 60 * 1000;
const MAX_PENDING = 20;

/** Issues read/write and Metadata read: what the app may do in a repository it is installed on, nothing else. */
export const GITHUB_APP_PERMISSIONS = { issues: "write", metadata: "read" } as const;

export interface GitHubAppManifest {
	name: string;
	url: string;
	description: string;
	public: false;
	redirect_url: string;
	setup_url: string;
	setup_on_update: true;
	hook_attributes: { url: string; active: false };
	default_permissions: typeof GITHUB_APP_PERMISSIONS;
	default_events: [];
}

/** The manifest: no webhook (inactive, GitHub requires its url), no events, Issues + Metadata only. */
export function buildGitHubAppManifest(input: { name: string; origin: string }): GitHubAppManifest {
	const origin = input.origin.replace(/\/+$/u, "");
	return {
		name: input.name,
		url: `https://github.com/${KANBAN_BUG_REPORT_REPO}`,
		description:
			"Kanban's agents file and comment on GitHub issues as this app; each post names the Kanban project it comes from.",
		public: false,
		redirect_url: `${origin}${GITHUB_APP_CALLBACK_PATH}`,
		setup_url: `${origin}${GITHUB_APP_SETUP_PATH}`,
		setup_on_update: true,
		hook_attributes: { url: `${origin}${GITHUB_APP_ROUTE_PREFIX}/webhook`, active: false },
		default_permissions: GITHUB_APP_PERMISSIONS,
		default_events: [],
	};
}

/** Where the manifest is posted: the user's own apps, or an organization's. */
export function getGitHubAppCreationUrl(state: string, org: string | null): string {
	const base = org
		? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
		: "https://github.com/settings/apps/new";
	return `${base}?state=${encodeURIComponent(state)}`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export function renderHtmlPage(title: string, bodyHtml: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;background:#1F2428;color:#E6EDF3;max-width:44rem;margin:3rem auto;padding:0 1rem;line-height:1.5}a{color:#4C9AFF}code{background:#2D3339;padding:0 .3em;border-radius:4px}button{background:#0084FF;color:#fff;border:0;border-radius:6px;padding:.5rem 1rem;font-size:1rem;cursor:pointer}</style></head><body>${bodyHtml}</body></html>`;
}

/** The start page: a form that posts the manifest to GitHub (submitted at once; the button is the fallback). */
export function renderManifestFormPage(input: { manifest: GitHubAppManifest; actionUrl: string }): string {
	return renderHtmlPage(
		"Create the Kanban GitHub App",
		`<h1>Create the Kanban GitHub App</h1><p>GitHub opens with the app filled in (Issues read/write, Metadata read, no webhook). Check the name, then click <b>Create GitHub App</b>.</p><form id="manifest" method="post" action="${escapeHtml(input.actionUrl)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(input.manifest))}"><button type="submit">Continue to GitHub</button></form><script>document.getElementById("manifest").submit();</script>`,
	);
}

export function renderLogoSteps(input: { settingsUrl: string; logoUrl: string; logoFilePath: string }): string {
	return `<p>Last step, the avatar: GitHub sets an app's logo only on its settings page. Save <a href="${escapeHtml(input.logoUrl)}" download="kanban-icon-512.png">the Kanban icon</a> (512×512 PNG, 6 KB; on the server: <code>${escapeHtml(input.logoFilePath)}</code>), open <a href="${escapeHtml(input.settingsUrl)}">the app's settings</a>, and upload it under <b>Display information</b>.</p>`;
}

const conversionSchema = z
	.object({
		id: z.number().int().positive(),
		slug: z.string().min(1),
		name: z.string().min(1),
		html_url: z.string().min(1),
		client_id: z.string().nullable().optional(),
		pem: z.string().min(1),
		owner: z.object({ login: z.string().min(1), type: z.string().optional() }).passthrough(),
	})
	.passthrough();

/**
 * Exchanges the manifest code for the app's credentials. Only the id, slug, owner and private key are kept: the
 * client and webhook secrets aren't needed (no OAuth, no webhook), so they are never stored.
 */
export async function exchangeGitHubAppManifestCode(
	code: string,
	options: GitHubHttpOptions = {},
): Promise<GitHubAppCredentials> {
	if (!/^[A-Za-z0-9_-]{1,200}$/u.test(code)) {
		throw new Error("GitHub's manifest code is not in the expected form.");
	}
	const { body } = await sendGitHubRequest(options, {
		method: "POST",
		path: `/app-manifests/${code}/conversions`,
		what: "creating the app from its manifest",
	});
	const parsed = conversionSchema.safeParse(body);
	if (!parsed.success) {
		throw new Error("GitHub's manifest conversion answer has no app id, slug or private key.");
	}
	return {
		version: GITHUB_APP_CREDENTIALS_VERSION,
		appId: parsed.data.id,
		slug: parsed.data.slug,
		name: parsed.data.name,
		ownerLogin: parsed.data.owner.login,
		ownerIsOrg: parsed.data.owner.type === "Organization",
		htmlUrl: parsed.data.html_url,
		clientId: parsed.data.client_id ?? null,
		privateKey: parsed.data.pem,
		createdAt: new Date((options.now ?? Date.now)()).toISOString(),
	};
}

export interface GitHubAppCreationFlowStart {
	state: string;
	/** The server's start page, on the origin the user's browser reaches. */
	startUrl: string;
	manifest: GitHubAppManifest;
	expiresAt: string;
}

export type GitHubAppCallbackResult = { ok: true; app: GitHubAppInfo } | { ok: false; status: number; error: string };

export interface GitHubAppCreationFlow {
	start: (input: { name: string; origin: string; org: string | null }) => GitHubAppCreationFlowStart;
	/** The start page's form, or null for an unknown or expired state. */
	renderStartPage: (state: string) => string | null;
	/** GitHub's redirect: checks and spends the state, exchanges the code, stores the app. */
	complete: (input: { state: string | null; code: string | null }) => Promise<GitHubAppCallbackResult>;
	/** The last app this server created (the CLI waits for it). */
	lastCreated: () => GitHubAppInfo | null;
}

export interface GitHubAppCreationFlowDependencies extends GitHubHttpOptions {
	writeCredentials: (credentials: GitHubAppCredentials) => Promise<void>;
	log?: (message: string) => void;
}

interface PendingFlow {
	manifest: GitHubAppManifest;
	org: string | null;
	expiresAt: number;
}

export function createGitHubAppCreationFlow(deps: GitHubAppCreationFlowDependencies): GitHubAppCreationFlow {
	const now = deps.now ?? Date.now;
	const pending = new Map<string, PendingFlow>();
	let created: GitHubAppInfo | null = null;
	const prune = () => {
		for (const [state, flow] of pending) {
			if (flow.expiresAt <= now()) {
				pending.delete(state);
			}
		}
	};
	return {
		start: ({ name, origin, org }) => {
			prune();
			while (pending.size >= MAX_PENDING) {
				const oldest = pending.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				pending.delete(oldest);
			}
			const state = randomBytes(24).toString("base64url");
			const manifest = buildGitHubAppManifest({ name, origin });
			const expiresAt = now() + STATE_TTL_MS;
			pending.set(state, { manifest, org, expiresAt });
			return {
				state,
				startUrl: `${origin.replace(/\/+$/u, "")}${GITHUB_APP_START_PATH}?state=${encodeURIComponent(state)}`,
				manifest,
				expiresAt: new Date(expiresAt).toISOString(),
			};
		},
		renderStartPage: (state) => {
			prune();
			const flow = pending.get(state);
			return flow
				? renderManifestFormPage({ manifest: flow.manifest, actionUrl: getGitHubAppCreationUrl(state, flow.org) })
				: null;
		},
		complete: async ({ state, code }) => {
			prune();
			if (!state || !pending.has(state)) {
				return {
					ok: false,
					status: 400,
					error: "This app creation link is unknown or expired. Run kanban github bot create again.",
				};
			}
			pending.delete(state);
			if (!code) {
				return { ok: false, status: 400, error: "GitHub sent no code. Run kanban github bot create again." };
			}
			try {
				const credentials = await exchangeGitHubAppManifestCode(code, deps);
				await deps.writeCredentials(credentials);
				created = describeGitHubApp(credentials);
				deps.log?.(
					`github app: created ${credentials.slug} (id ${credentials.appId}, owner ${credentials.ownerLogin})`,
				);
				return { ok: true, app: created };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				deps.log?.(`github app: creating the app failed: ${message}`);
				return { ok: false, status: 502, error: message };
			}
		},
		lastCreated: () => created,
	};
}
