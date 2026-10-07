// `kanban restart prepare|recover`: around a planned Kanban or container restart.
//
//   prepare  run just before the restart (the image entrypoint can run it on container stop): tags the worktree of
//            every In Progress / Review dev card whose session is running (preserve/<id>-wip-<stamp>-restart,
//            untracked files included) and writes data/<workspace>/restart-manifest.json. After the restart,
//            restart recovery treats the listed cards as orphaned without guessing, reuses the tags, and deletes
//            the manifest.
//   recover  asks the pipeline worker to check a workspace for orphaned cards now; --dry-run prints what restart
//            recovery would do with the live board instead.
//
// Ported from archive/devteam-kit:bin/prepare-restart.mjs@6da71597 and bin/recover-restart.mjs@6da71597. Restart
// recovery acts only with `pipeline.recovery.mode: "on"` (src/pipeline/recovery-stage.ts); until the cutover the
// legacy kit's `kit prepare-restart` / autoland keep doing it.
import type { Command } from "commander";

import { getWorkspacePipelineSettings, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeWorkspaceStateResponse } from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { getRecoveryScope, type PipelineSessionView } from "../pipeline/engine";
import {
	planRestartRecovery,
	type RestartManifestCard,
	readRestartManifest,
	readRunningServerStart,
	requestRestartRecovery,
	writeRestartManifest,
} from "../pipeline/restart-recovery";
import { nextRestartWipTag, tagRestartWip } from "../pipeline/wip-tag";
import { listWorkspaceIndexEntries } from "../state/workspace-state";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import { createRuntimeTrpcClient } from "./runtime-trpc-client";
import { resolveWorkspaceTarget, type WorkspaceTarget } from "./workspace-target";

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() ? error.message : String(error);
}

async function listTargets(workspace: string | undefined): Promise<Array<WorkspaceTarget & { repoPath: string }>> {
	if (workspace) {
		const target = await resolveWorkspaceTarget(workspace, { allowUnregistered: false });
		return target.repoPath ? [{ ...target, repoPath: target.repoPath }] : [];
	}
	return (await listWorkspaceIndexEntries()).map((entry) => ({
		workspaceId: entry.workspaceId,
		repoPath: entry.repoPath,
	}));
}

function isProcessAlive(pid: number | null): boolean {
	if (!pid) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function readLiveState(workspaceId: string): Promise<RuntimeWorkspaceStateResponse> {
	return await createRuntimeTrpcClient(workspaceId).workspace.getState.query();
}

async function prepareWorkspace(
	target: WorkspaceTarget & { repoPath: string },
	dryRun: boolean,
	print: (line: string) => void,
): Promise<number> {
	const state = await readLiveState(target.workspaceId);
	const cards: RestartManifestCard[] = [];
	for (const column of state.board.columns) {
		if (column.id !== "in_progress" && column.id !== "review") {
			continue;
		}
		for (const card of column.cards) {
			const role = resolveCardRole(card);
			const session = state.sessions[card.id];
			// Only cards whose agent is mid-work: a Review card whose turn ended waits for QA, nothing to resume. An In
			// Progress card without a summary was already left without a process (a restart before this one).
			if (session ? session.state !== "running" : column.id !== "in_progress") {
				print(`${card.id} (${role}, ${column.id}): session ${session?.state ?? "none"}, not running; not listed`);
				continue;
			}
			if (role === "calibration" || role === "triage" || role === "plan") {
				print(
					`${card.id} (${role}, ${column.id}): ${role === "plan" ? "a plan card is resumed by hand (kanban task resume)" : "left to its own runner"}; not listed`,
				);
				continue;
			}
			let wipTag: string | null = null;
			if (role === "dev") {
				const info = await getTaskWorkspacePathInfo({
					cwd: target.repoPath,
					taskId: card.id,
					baseRef: card.baseRef,
				}).catch(() => null);
				if (info?.exists) {
					wipTag = dryRun
						? await nextRestartWipTag(info.path, card.id, new Date())
						: await tagRestartWip(info.path, card.id);
				}
			}
			const model = card.agentSettings?.modelId ?? session?.modelId ?? null;
			cards.push({ id: card.id, column: column.id, model, wipTag, kind: role });
			print(`${card.id} (${role}, ${column.id}, ${model ?? "default model"})${wipTag ? `: WIP tag ${wipTag}` : ""}`);
		}
	}
	const kanbanStart = await readRunningServerStart(isProcessAlive);
	const manifest = {
		at: new Date().toISOString(),
		kanbanStart: kanbanStart ? new Date(kanbanStart).toISOString() : null,
		cards,
	};
	if (dryRun) {
		print(`${target.workspaceId}: would write the restart manifest with ${cards.length} card(s) [dry-run]`);
		return 0;
	}
	const path = await writeRestartManifest(target.workspaceId, manifest);
	print(`${target.workspaceId}: wrote ${path}: ${cards.length} card(s)`);
	return 0;
}

async function recoverWorkspace(
	target: WorkspaceTarget & { repoPath: string },
	dryRun: boolean,
	print: (line: string) => void,
): Promise<number> {
	const { config } = await readPipelineConfig();
	const scope = getRecoveryScope(config, getWorkspacePipelineSettings(config, target.workspaceId));
	const mode = config.pipeline.recovery.mode;
	const who = scope.act
		? "restart recovery resumes them"
		: scope.evaluate
			? `restart recovery only logs them (pipeline.recovery.mode ${mode}${mode === "on" ? ", pipeline.shadow" : ""})`
			: `restart recovery does not run for this workspace (pipeline.recovery.mode ${mode}, landing ${getWorkspacePipelineSettings(config, target.workspaceId).landing.mode})`;
	if (!dryRun) {
		const path = await requestRestartRecovery(target.workspaceId);
		print(`${target.workspaceId}: asked the pipeline worker to check now (${path}); ${who}`);
		return 0;
	}
	const state = await readLiveState(target.workspaceId);
	// The CLI can't see the server's PTYs: a session counts as live when its pid is still alive.
	const sessions = new Map<string, PipelineSessionView>(
		Object.values(state.sessions).map((summary) => [
			summary.taskId,
			{ ...summary, live: isProcessAlive(summary.pid) },
		]),
	);
	const plan = planRestartRecovery({
		cards: state.board.columns.flatMap((column) => column.cards.map((card) => ({ card, column: column.id }))),
		sessions,
		serverStartedAt: Date.now(),
		// A manifest is for the start after the server that wrote it: as if the running server restarted now.
		previousServerStartedAt: await readRunningServerStart(isProcessAlive),
		manifest: await readRestartManifest(target.workspaceId),
		// Without the session files' turn check, every running session without a process counts.
		turnEnded: () => false,
	});
	print(`${target.workspaceId}: ${who}`);
	if (plan.manifestAt) {
		print(`restart manifest from ${plan.manifestAt} would be used`);
	}
	for (const orphan of plan.orphans) {
		const action =
			orphan.role === "dev"
				? `resume${orphan.wipTag ? ` (WIP tag ${orphan.wipTag})` : ""}`
				: "recreate its QA for the same snapshot";
		print(`ORPHAN ${orphan.taskId} (${orphan.role}, ${orphan.column}): ${orphan.reason} → ${action} [dry-run]`);
	}
	for (const skipped of plan.skipped) {
		print(`skipped ${skipped.taskId}: ${skipped.why}`);
	}
	if (plan.orphans.length === 0) {
		print("no orphans: nothing to recover");
	}
	return 0;
}

export function registerRestartCommand(program: Command): void {
	const restart = program
		.command("restart")
		.description("Before and after a planned Kanban or container restart: keep running cards' work and resume them.");

	const run = async (
		workspace: string | undefined,
		handler: (target: WorkspaceTarget & { repoPath: string }, print: (line: string) => void) => Promise<number>,
	): Promise<void> => {
		const print = (line: string) => process.stdout.write(`${line}\n`);
		let exitCode = 0;
		try {
			const targets = await listTargets(workspace);
			if (targets.length === 0) {
				print("no registered workspaces");
			}
			for (const target of targets) {
				try {
					exitCode = Math.max(exitCode, await handler(target, print));
				} catch (error) {
					process.stderr.write(`${target.workspaceId}: ${toErrorMessage(error)}\n`);
					exitCode = 1;
				}
			}
		} catch (error) {
			process.stderr.write(`${toErrorMessage(error)}\n`);
			exitCode = 1;
		}
		process.exitCode = exitCode;
	};

	restart
		.command("prepare")
		.description(
			"Tag the work of every running In Progress / Review card and write data/<workspace>/restart-manifest.json (every workspace unless --workspace).",
		)
		.option("--workspace <workspace>", "Only this workspace (workspace id or project path).")
		.option("--dry-run", "Print what would be tagged and listed; write nothing.")
		.action(async (options: { workspace?: string; dryRun?: boolean }) => {
			await run(
				options.workspace,
				async (target, print) => await prepareWorkspace(target, options.dryRun === true, print),
			);
		});

	restart
		.command("recover")
		.description(
			"Ask the pipeline worker to check for cards a restart orphaned now (every workspace unless --workspace); --dry-run prints the plan.",
		)
		.option("--workspace <workspace>", "Only this workspace (workspace id or project path).")
		.option("--dry-run", "Print what restart recovery would do with the live board.")
		.action(async (options: { workspace?: string; dryRun?: boolean }) => {
			await run(
				options.workspace,
				async (target, print) => await recoverWorkspace(target, options.dryRun === true, print),
			);
		});
}
