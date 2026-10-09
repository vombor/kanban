// `kanban github`: GitHub issues and comments as the machine's Kanban GitHub App (docs/fork/github-bots.md).
//
//   bot create   the user's, once per machine (USER_ONLY_COMMANDS): starts the App Manifest flow on the running
//                server and prints the page to open; the app gets Issues read/write and Metadata read, no webhook.
//   bot status   whether the app exists, its install and settings pages.
//   issue create|comment|edit|close   what agents use instead of `gh issue ...`: the server decides who calls
//                (a card or orchestrator posts for its own project, the attribution line names it) and posts with an
//                installation token it mints itself, or the user's PAT until the app exists.
//
// Every command goes through the running server: the app's key and its tokens never leave it.
import { readFile } from "node:fs/promises";

import type { Command } from "commander";

import { getKanbanRuntimePort, isKanbanRuntimeHttps } from "../core/runtime-endpoint";
import { DEFAULT_GITHUB_APP_NAME, GITHUB_APP_LOGO_PATH } from "../github-app/app-manifest";
import { getWebUiDir } from "../server/assets";
import { getGitHubAppLogoFilePath } from "../server/github-app-route";
import type { GitHubAppStatusResponse, GitHubIssueRequest, GitHubIssueResponse } from "../trpc/github-api";
import { createRuntimeTrpcClient } from "./runtime-trpc-client";
import { resolveWorkspaceTarget } from "./workspace-target";

const WAIT_POLL_MS = 3_000;
const WAIT_LIMIT_MS = 30 * 60 * 1000;

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fail(label: string, error: unknown): void {
	process.stderr.write(`kanban github ${label}: ${toErrorMessage(error)}\n`);
	process.exitCode = 1;
}

/** The origin the user's browser reaches Kanban on: the runtime's port on localhost (the pod publishes it). */
export function getDefaultBrowserOrigin(): string {
	return `${isKanbanRuntimeHttps() ? "https" : "http"}://localhost:${getKanbanRuntimePort()}`;
}

async function readBodyFile(path: string): Promise<string> {
	if (path === "-") {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) {
			chunks.push(Buffer.from(chunk));
		}
		return Buffer.concat(chunks).toString("utf8");
	}
	return await readFile(path, "utf8");
}

function parseIssueNumber(value: string): number {
	const number = Number(value.replace(/^#/u, ""));
	if (!Number.isInteger(number) || number <= 0) {
		throw new Error(`"${value}" is not an issue number.`);
	}
	return number;
}

/** The workspace header: --project, else the project of the cwd; null lets the server use the session's own. */
async function resolveIssueWorkspaceId(project: string | undefined): Promise<string | null> {
	if (project?.trim()) {
		return (await resolveWorkspaceTarget(project, { allowUnregistered: false })).workspaceId;
	}
	return await resolveWorkspaceTarget(undefined, { allowUnregistered: false })
		.then((target) => target.workspaceId)
		.catch(() => null);
}

export function formatIssueResponse(request: GitHubIssueRequest, response: GitHubIssueResponse): string[] {
	if (!response.ok) {
		return [];
	}
	const verb = { create: "Created", comment: "Commented on", edit: "Edited", close: "Closed" }[request.action];
	return [
		`${verb} ${request.repo}#${response.number}: ${response.commentUrl ?? response.url}`,
		`  posted ${response.via === "app" ? "as the Kanban GitHub App" : "with the user's PAT"}, signed ${response.postedAs}`,
	];
}

async function runIssueCommand(
	label: string,
	options: { project?: string; json?: boolean },
	buildRequest: () => Promise<GitHubIssueRequest>,
): Promise<void> {
	try {
		const request = await buildRequest();
		const workspaceId = await resolveIssueWorkspaceId(options.project);
		let response: GitHubIssueResponse;
		try {
			response = await createRuntimeTrpcClient(workspaceId).github.issue.mutate(request);
		} catch (error) {
			const message = toErrorMessage(error);
			throw new Error(
				/Missing workspace scope/u.test(message)
					? "no project: run it inside a registered project or pass --project <workspace id or path>"
					: `the running Kanban server didn't answer (${message}); GitHub posts go only through it, because it holds the app's key`,
			);
		}
		if (options.json) {
			process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
		}
		if (response.warning) {
			process.stderr.write(`warning: ${response.warning}\n`);
		}
		if (!response.ok) {
			const extra = [
				response.installUrl ? `install: ${response.installUrl}` : null,
				response.retryAfter ? `retry after ${response.retryAfter}` : null,
			].filter(Boolean);
			throw new Error(`${response.error ?? "refused"}${extra.length > 0 ? ` (${extra.join("; ")})` : ""}`);
		}
		if (!options.json) {
			process.stdout.write(`${formatIssueResponse(request, response).join("\n")}\n`);
		}
	} catch (error) {
		fail(label, error);
	}
}

export function formatAppSetupSteps(app: NonNullable<GitHubAppStatusResponse["app"]>, origin: string): string[] {
	return [
		`Kanban GitHub App: ${app.slug} (id ${app.appId}, owner ${app.ownerLogin}); agents post as ${app.slug}[bot].`,
		`  Install it (pick "All repositories", so every project is covered): ${app.installUrl}`,
		`  Logo: GitHub sets an app's logo only on its settings page. Save the Kanban icon (512x512 PNG, 6 KB) from ${origin}${GITHUB_APP_LOGO_PATH}`,
		`        (on this machine: ${getGitHubAppLogoFilePath(getWebUiDir())}),`,
		`        then upload it at ${app.settingsUrl} > Display information.`,
		"  Then: kanban doctor shows which projects' repositories the installation covers.",
	];
}

async function waitForApp(
	client: ReturnType<typeof createRuntimeTrpcClient>,
	since: number,
): Promise<NonNullable<GitHubAppStatusResponse["app"]> | null> {
	const deadline = Date.now() + WAIT_LIMIT_MS;
	while (Date.now() < deadline) {
		const status = await client.github.appStatus.query().catch(() => null);
		if (status?.app && Date.parse(status.app.createdAt) >= since) {
			return status.app;
		}
		await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
	}
	return null;
}

export function registerGitHubCommand(program: Command): void {
	const github = program
		.command("github")
		.description("GitHub issues and comments as the machine's Kanban GitHub App (docs/fork/github-bots.md).");

	const bot = github.command("bot").description("The machine's Kanban GitHub App (one for every project).");
	bot.command("create")
		.description(
			"Create the Kanban GitHub App (the user's, once per machine): opens GitHub's app manifest flow through the running server. Issues read/write, Metadata read, no webhook.",
		)
		.option("--name <name>", "The app's name on GitHub (unique on GitHub; you can still change it there).")
		.option("--org <org>", "Create it under this organization instead of your own account.")
		.option(
			"--origin <url>",
			"Where your browser reaches this Kanban server (GitHub redirects there). Default: http://localhost:<runtime port>.",
		)
		.option("--no-wait", "Print the link and return; don't wait for the app to be created.")
		.action(async (options: { name?: string; org?: string; origin?: string; wait: boolean }) => {
			try {
				const origin = (options.origin?.trim() || getDefaultBrowserOrigin()).replace(/\/+$/u, "");
				const client = createRuntimeTrpcClient(null);
				const since = Date.now();
				const started = await client.github.startAppCreation
					.mutate({ name: options.name?.trim() || DEFAULT_GITHUB_APP_NAME, origin, org: options.org ?? null })
					.catch((error: unknown) => {
						throw new Error(
							`the running Kanban server didn't answer (${toErrorMessage(error)}); start Kanban first, GitHub sends the app back to it`,
						);
					});
				if (!started.ok || !started.startUrl) {
					throw new Error(started.error ?? "refused");
				}
				const lines = [
					...(started.existing
						? [
								`Note: this machine already has the app ${started.existing.slug}; creating another one replaces it in Kanban (delete the old one on GitHub: ${started.existing.settingsUrl}).`,
							]
						: []),
					`Open this link in your browser (valid until ${started.expiresAt}):`,
					`  ${started.startUrl}`,
					"GitHub shows the new app filled in; click Create GitHub App. Kanban then sends you on to install it.",
				];
				process.stdout.write(`${lines.join("\n")}\n`);
				if (!options.wait) {
					return;
				}
				process.stdout.write(
					"Waiting for GitHub (Ctrl-C to stop waiting; kanban github bot status checks later)...\n",
				);
				const app = await waitForApp(client, since);
				if (!app) {
					throw new Error("no app was created within 30 minutes; run kanban github bot create again");
				}
				process.stdout.write(`${formatAppSetupSteps(app, origin).join("\n")}\n`);
			} catch (error) {
				fail("bot create", error);
			}
		});
	bot.command("status")
		.description("Whether the machine's Kanban GitHub App exists, and its install and settings pages.")
		.option("--origin <url>", "Where your browser reaches this Kanban server (for the logo link).")
		.option("--json", "Print as JSON.")
		.action(async (options: { origin?: string; json?: boolean }) => {
			try {
				const status = await createRuntimeTrpcClient(null).github.appStatus.query();
				if (options.json) {
					process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
					return;
				}
				if (!status.ok) {
					throw new Error(status.error ?? "unknown");
				}
				const origin = (options.origin?.trim() || getDefaultBrowserOrigin()).replace(/\/+$/u, "");
				process.stdout.write(
					`${(status.app ? formatAppSetupSteps(status.app, origin) : ["No Kanban GitHub App on this machine yet: agents' issues and comments go out with the user's PAT. Create it with kanban github bot create."]).join("\n")}\n`,
				);
			} catch (error) {
				fail("bot status", error);
			}
		});

	const issue = github
		.command("issue")
		.description(
			"File, comment on, edit or close a GitHub issue as the Kanban GitHub App, signed with this project (use it instead of gh issue ...).",
		);
	const common = (command: Command): Command =>
		command
			.requiredOption("--repo <owner/name>", "The repository.")
			.option("--project <id or path>", "The project to post for (default: this session's or the cwd's).")
			.option("--json", "Print the answer as JSON.");

	common(issue.command("create").description("Open an issue."))
		.requiredOption("--title <title>", "The issue's title.")
		.requiredOption("--body-file <file>", "The issue's body (a file; - for stdin).")
		.option("--label <label...>", "Labels (the repository's existing ones).")
		.action(
			async (options: {
				repo: string;
				title: string;
				bodyFile: string;
				label?: string[];
				project?: string;
				json?: boolean;
			}) =>
				await runIssueCommand("issue create", options, async () => ({
					action: "create",
					repo: options.repo,
					title: options.title,
					body: await readBodyFile(options.bodyFile),
					...(options.label ? { labels: options.label } : {}),
				})),
		);
	common(issue.command("comment").description("Comment on an issue."))
		.requiredOption("--number <n>", "The issue's number.")
		.requiredOption("--body-file <file>", "The comment (a file; - for stdin).")
		.action(
			async (options: { repo: string; number: string; bodyFile: string; project?: string; json?: boolean }) =>
				await runIssueCommand("issue comment", options, async () => ({
					action: "comment",
					repo: options.repo,
					number: parseIssueNumber(options.number),
					body: await readBodyFile(options.bodyFile),
				})),
		);
	common(issue.command("edit").description("Change an issue's title or body."))
		.requiredOption("--number <n>", "The issue's number.")
		.option("--title <title>", "The new title.")
		.option("--body-file <file>", "The new body (a file; - for stdin).")
		.action(
			async (options: {
				repo: string;
				number: string;
				title?: string;
				bodyFile?: string;
				project?: string;
				json?: boolean;
			}) =>
				await runIssueCommand("issue edit", options, async () => ({
					action: "edit",
					repo: options.repo,
					number: parseIssueNumber(options.number),
					...(options.title !== undefined ? { title: options.title } : {}),
					...(options.bodyFile !== undefined ? { body: await readBodyFile(options.bodyFile) } : {}),
				})),
		);
	common(issue.command("close").description("Close an issue, optionally with a comment."))
		.requiredOption("--number <n>", "The issue's number.")
		.option("--reason <reason>", "completed (default) or not_planned.")
		.option("--comment-file <file>", "A comment posted before closing (a file; - for stdin).")
		.action(
			async (options: {
				repo: string;
				number: string;
				reason?: string;
				commentFile?: string;
				project?: string;
				json?: boolean;
			}) =>
				await runIssueCommand("issue close", options, async () => {
					if (options.reason !== undefined && options.reason !== "completed" && options.reason !== "not_planned") {
						throw new Error(`--reason must be completed or not_planned, not "${options.reason}".`);
					}
					return {
						action: "close",
						repo: options.repo,
						number: parseIssueNumber(options.number),
						...(options.reason ? { reason: options.reason } : {}),
						...(options.commentFile !== undefined ? { comment: await readBodyFile(options.commentFile) } : {}),
					};
				}),
		);
}
