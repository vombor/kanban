// The browser side of the Kanban GitHub App's manifest flow (src/github-app/app-manifest.ts):
//   GET /api/github/app/new?state=…        the form that posts the manifest to GitHub;
//   GET /api/github/app/callback?code&state GitHub's redirect after Create: exchange, store, on to the install page;
//   GET /api/github/app/installed           GitHub's setup_url after the install: the logo step;
//   GET /api/github/app/logo.png            the Kanban icon to upload as the app's logo.
// Served ahead of the passcode gate: GitHub's redirect is a cross-site navigation, which doesn't carry the
// SameSite=Strict session cookie. The one-time `state` (from the user's `kanban github bot create`, in server memory)
// is what authorizes the start page and the callback; the setup page and the logo show nothing secret.
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import {
	GITHUB_APP_CALLBACK_PATH,
	GITHUB_APP_LOGO_ASSET,
	GITHUB_APP_LOGO_PATH,
	GITHUB_APP_SETUP_PATH,
	GITHUB_APP_START_PATH,
	type GitHubAppCreationFlow,
	renderHtmlPage,
	renderLogoSteps,
} from "../github-app/app-manifest";
import type { GitHubAppTokenSource } from "../github-app/installation-tokens";

export interface GitHubAppRouteDependencies {
	flow: GitHubAppCreationFlow;
	tokenSource: GitHubAppTokenSource;
	/** The web UI's directory (getWebUiDir), where the logo asset is. */
	webUiDir: string;
}

function writeHtml(res: ServerResponse, status: number, html: string): void {
	res.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
	});
	res.end(html);
}

function escapeText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function getGitHubAppLogoFilePath(webUiDir: string): string {
	return join(webUiDir, GITHUB_APP_LOGO_ASSET);
}

/** Handles the routes above; false for any other path. */
export function createGitHubAppRequestHandler(
	deps: GitHubAppRouteDependencies,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
	const logoFilePath = getGitHubAppLogoFilePath(deps.webUiDir);
	return async (req, res, pathname) => {
		if (
			req.method !== "GET" ||
			![GITHUB_APP_START_PATH, GITHUB_APP_CALLBACK_PATH, GITHUB_APP_SETUP_PATH, GITHUB_APP_LOGO_PATH].includes(
				pathname,
			)
		) {
			return false;
		}
		const url = new URL(req.url ?? "/", "http://localhost");
		if (pathname === GITHUB_APP_LOGO_PATH) {
			const logo = await readFile(logoFilePath).catch(() => null);
			if (!logo) {
				res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("The Kanban icon is not in this build.");
				return true;
			}
			res.writeHead(200, {
				"Content-Type": "image/png",
				"Content-Disposition": 'attachment; filename="kanban-icon-512.png"',
				"Cache-Control": "no-store",
			});
			res.end(logo);
			return true;
		}
		if (pathname === GITHUB_APP_START_PATH) {
			const page = deps.flow.renderStartPage(url.searchParams.get("state") ?? "");
			writeHtml(
				res,
				page ? 200 : 400,
				page ??
					renderHtmlPage(
						"Link expired",
						"<p>This app creation link is unknown or expired. Run <code>kanban github bot create</code> again.</p>",
					),
			);
			return true;
		}
		if (pathname === GITHUB_APP_CALLBACK_PATH) {
			const result = await deps.flow.complete({
				state: url.searchParams.get("state"),
				code: url.searchParams.get("code"),
			});
			if (!result.ok) {
				writeHtml(
					res,
					result.status,
					renderHtmlPage("GitHub App not created", `<p>${escapeText(result.error)}</p>`),
				);
				return true;
			}
			// On to the installation: the user picks All repositories (or selected ones), then GitHub opens setup_url.
			res.writeHead(302, { Location: result.app.installUrl, "Cache-Control": "no-store" });
			res.end();
			return true;
		}
		const app = await deps.tokenSource.getApp().catch(() => null);
		writeHtml(
			res,
			200,
			renderHtmlPage(
				"Kanban GitHub App installed",
				`<h1>Kanban GitHub App installed</h1><p>Kanban's agents now file and comment on GitHub issues as <b>${escapeText(app ? `${app.slug}[bot]` : "the app")}</b>, each post naming its project. Run <code>kanban doctor</code> to see which projects' repositories it covers.</p>${
					app
						? renderLogoSteps({
								settingsUrl: app.settingsUrl,
								logoUrl: GITHUB_APP_LOGO_PATH,
								logoFilePath,
							})
						: ""
				}`,
			),
		);
		return true;
	};
}
