// `kanban issues`: the issue import of one project (src/issues/, docs/team/WORKFLOW.md "Issues → cards").
//
//   sync [--dry-run]  one sync now: fetch the project's own repository's issues and, with `issues.mode: on`, import
//                     the matching ones as Backlog cards (never started) and update the Backlog ones. `--dry-run`
//                     (and mode `report`) only prints and logs what it would do.
//   list              what is imported (with its card's column), what was skipped and why, the last sync.
//
// The board is written in-process under the board lock (as `kanban task create` does), then the running server is
// told so the browser refreshes.
import type { Command } from "commander";

import { getWorkspacePipelineSettings, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeBoardColumnId } from "../core/api-contract";
import { applyIssueSync } from "../issues/issue-apply";
import { readIssueSyncState } from "../issues/issue-state";
import { type IssueSyncDependencies, type IssueSyncOutcome, runIssueSync } from "../issues/issue-sync";
import { indexIssueCards } from "../issues/issue-sync-plan";
import { resolveProjectInputPath } from "../projects/project-path";
import { getIssueWorkspacePaths } from "../state/kanban-home";
import { loadWorkspaceContext, mutateWorkspaceState } from "../state/workspace-state";
import { createRuntimeTrpcClient, notifyRuntimeWorkspaceStateUpdated } from "./runtime-trpc-client";

type JsonRecord = Record<string, unknown>;

export interface IssuesCommandDependencies {
	sync?: IssueSyncDependencies;
	/** Tells the running server the board changed (default: tRPC notifyStateUpdated, ignored when it's down). */
	notifyBoardChanged?: (workspaceId: string) => Promise<void>;
}

async function loadTarget(cwd: string, projectPath: string | undefined) {
	const path = projectPath?.trim() ? resolveProjectInputPath(projectPath.trim(), cwd) : cwd;
	return await loadWorkspaceContext(path, { autoCreateIfMissing: false });
}

async function readBoard(repoPath: string) {
	const { state } = await mutateWorkspaceState(repoPath, (current) => ({
		board: current.board,
		value: null,
		save: false,
	}));
	return state.board;
}

async function defaultNotify(workspaceId: string): Promise<void> {
	await notifyRuntimeWorkspaceStateUpdated(createRuntimeTrpcClient(workspaceId)).catch(() => {});
}

function formatOutcome(outcome: IssueSyncOutcome): string {
	const lines = [
		`Issue sync (${outcome.mode}) of ${outcome.repo ?? "?"} via ${outcome.authSource ?? "?"}: ${outcome.ok ? outcome.summary : `FAILED: ${outcome.error}`}`,
	];
	const result = outcome.result;
	if (result) {
		const verb = outcome.mode === "report" ? "would create" : "created";
		for (const card of result.created) {
			lines.push(
				`  ${verb} #${card.number}${card.taskId ? ` → ${card.taskId}` : ""}${card.plan ? " (plan card)" : ""}: ${card.title}${card.note ? ` [${card.note}]` : ""}`,
			);
		}
		for (const entry of result.updated) {
			lines.push(`  ${outcome.mode === "report" ? "would update" : "updated"}: ${entry.note}`);
		}
		for (const entry of result.notes) {
			lines.push(`  note: ${entry.note}${entry.wake ? " (for the orchestrator's next wake)" : ""}`);
		}
		for (const entry of result.skipped) {
			lines.push(`  skipped #${entry.number} (${entry.reason}): ${entry.detail}`);
		}
	}
	return lines.join("\n");
}

export async function syncIssues(
	input: { cwd: string; projectPath?: string; dryRun: boolean },
	deps: IssuesCommandDependencies = {},
): Promise<{ outcome: IssueSyncOutcome; text: string }> {
	const context = await loadTarget(input.cwd, input.projectPath);
	const settings = getWorkspacePipelineSettings((await readPipelineConfig()).config, context.workspaceId).issues;
	if (settings.mode === "off" && !input.dryRun) {
		throw new Error(
			`Issue import is off for this project (workspaces.${context.workspaceId}.issues.mode in config.json). Set it to "report" or "on", or run with --dry-run.`,
		);
	}
	const notify = deps.notifyBoardChanged ?? defaultNotify;
	const outcome = await runIssueSync(
		{
			workspaceId: context.workspaceId,
			workspacePath: context.repoPath,
			mode: input.dryRun || settings.mode !== "on" ? "report" : "on",
			readBoard: async () => await readBoard(context.repoPath),
			apply: async (applyInput) =>
				await applyIssueSync(applyInput, {
					mutateWorkspaceState,
					readConfig: deps.sync?.readConfig,
					loadCatalog: deps.sync?.loadCatalog,
					listRemotes: deps.sync?.listRemotes,
					onBoardMutated: async (scope) => await notify(scope.workspaceId),
				}),
		},
		deps.sync,
	);
	return { outcome, text: formatOutcome(outcome) };
}

export async function listIssues(input: {
	cwd: string;
	projectPath?: string;
}): Promise<{ json: JsonRecord; text: string }> {
	const context = await loadTarget(input.cwd, input.projectPath);
	const settings = getWorkspacePipelineSettings((await readPipelineConfig()).config, context.workspaceId).issues;
	const [state, board] = await Promise.all([
		readIssueSyncState(getIssueWorkspacePaths(context.workspaceId).state),
		readBoard(context.repoPath),
	]);
	const cards = indexIssueCards(board);
	const columnOf = (key: string, taskId: string): RuntimeBoardColumnId | "gone" =>
		cards.get(key)?.column ??
		board.columns.find((column) => column.cards.some((card) => card.id === taskId))?.id ??
		"gone";
	const imported = Object.entries(state.issues)
		.map(([key, record]) => ({ ...record, key, column: columnOf(key, record.taskId) }))
		.sort((left, right) => left.number - right.number);
	const skipped = Object.entries(state.skipped)
		.map(([key, entry]) => ({ ...entry, key }))
		.sort((left, right) => left.number - right.number);
	const last = state.lastSync;
	const text = [
		`Issue import: mode ${settings.mode}, provider ${settings.provider}, repo ${settings.repo ?? "(from origin)"}, every ${settings.pollMin} min`,
		`Last sync: ${last ? `${last.at} ${last.ok ? "ok" : "FAILED"} (${last.mode}) ${last.repo ?? ""} via ${last.authSource ?? "?"}: ${last.error ?? last.summary}` : "never"}`,
		...(state.backoff.until ? [`Rate limited: next request after ${state.backoff.until}`] : []),
		"",
		`Imported (${imported.length}):`,
		...imported.map(
			(entry) =>
				`  #${entry.number} → ${entry.taskId} (${entry.column})${entry.plan ? " plan" : ""}${entry.closed ? " closed upstream" : ""}: ${entry.title}`,
		),
		"",
		`Skipped (${skipped.length}):`,
		...skipped.map((entry) => `  #${entry.number} (${entry.reason}): ${entry.title} — ${entry.detail}`),
		...(state.wakeNotes.length > 0
			? ["", "For the orchestrator's next wake:", ...state.wakeNotes.map((note) => `  ${note}`)]
			: []),
	].join("\n");
	return {
		text,
		json: {
			ok: true,
			workspaceId: context.workspaceId,
			settings,
			lastSync: last,
			backoff: state.backoff,
			imported,
			skipped,
			wakeNotes: state.wakeNotes,
		},
	};
}

export function registerIssuesCommand(program: Command): void {
	const issues = program
		.command("issues")
		.description(
			"Issue import: the project's own GitHub issues become Backlog cards (workspaces.<id>.issues in config.json).",
		);

	issues
		.command("sync")
		.description(
			"Sync now: import matching issues as Backlog cards (never started) and update Backlog cards whose issue changed. Mode report (or --dry-run) only prints what it would do.",
		)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--dry-run", "Fetch and print what would change; write nothing to the board.")
		.option("--json", "Print as JSON.")
		.action(async (options: { projectPath?: string; dryRun?: boolean; json?: boolean }) => {
			try {
				const { outcome, text } = await syncIssues({
					cwd: process.cwd(),
					projectPath: options.projectPath,
					dryRun: options.dryRun === true,
				});
				process.stdout.write(options.json ? `${JSON.stringify(outcome, null, 2)}\n` : `${text}\n`);
				if (!outcome.ok) {
					process.exitCode = 1;
				}
			} catch (error) {
				process.stderr.write(`kanban issues sync: ${error instanceof Error ? error.message : String(error)}\n`);
				process.exitCode = 1;
			}
		});

	issues
		.command("list")
		.description("What is imported (and its card's column), what was skipped and why, and the last sync.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--json", "Print as JSON.")
		.action(async (options: { projectPath?: string; json?: boolean }) => {
			try {
				const listed = await listIssues({ cwd: process.cwd(), projectPath: options.projectPath });
				process.stdout.write(options.json ? `${JSON.stringify(listed.json, null, 2)}\n` : `${listed.text}\n`);
			} catch (error) {
				process.stderr.write(`kanban issues list: ${error instanceof Error ? error.message : String(error)}\n`);
				process.exitCode = 1;
			}
		});
}
