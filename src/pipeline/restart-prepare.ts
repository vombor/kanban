// The restart prepare for one workspace: tags the worktree of every running In Progress / Review dev card and writes
// its restart manifest (src/pipeline/restart-recovery.ts). `kanban restart prepare` (the image entrypoint runs it on
// a container stop) reads the live board over the runtime API; `kanban restart update` runs the same prepare inside
// the server (src/trpc/restart-update-api.ts) with the update recorded in the manifest.
import type { RuntimeWorkspaceStateResponse } from "../core/api-contract";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import {
	listRestartManifestCandidates,
	type RestartManifest,
	type RestartManifestCard,
	type RestartManifestUpdate,
	readRunningServerStart,
	writeRestartManifest,
} from "./restart-recovery";
import { nextRestartWipTag, tagRestartWip } from "./wip-tag";

export interface RestartPrepareTarget {
	workspaceId: string;
	repoPath: string;
}

export interface PrepareWorkspaceRestartInput {
	target: RestartPrepareTarget;
	/** The live board and session summaries. */
	state: RuntimeWorkspaceStateResponse;
	dryRun: boolean;
	print: (line: string) => void;
	isProcessAlive: (pid: number | null) => boolean;
	/** `kanban restart update`'s reason, recorded in the manifest. */
	update?: RestartManifestUpdate;
}

export function isProcessAlive(pid: number | null): boolean {
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

export async function prepareWorkspaceRestart(input: PrepareWorkspaceRestartInput): Promise<number> {
	const { target, state, dryRun, print } = input;
	const cards: RestartManifestCard[] = [];
	for (const { card, column, role, model, notListed } of listRestartManifestCandidates(
		state.board.columns,
		(taskId) => state.sessions[taskId],
	)) {
		if (notListed) {
			print(`${card.id} (${role}, ${column}): ${notListed}; not listed`);
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
		cards.push({ id: card.id, column, model, wipTag, kind: role });
		print(`${card.id} (${role}, ${column}, ${model ?? "default model"})${wipTag ? `: WIP tag ${wipTag}` : ""}`);
	}
	const kanbanStart = await readRunningServerStart(input.isProcessAlive);
	const manifest: RestartManifest = {
		at: new Date().toISOString(),
		kanbanStart: kanbanStart ? new Date(kanbanStart).toISOString() : null,
		source: "prepare",
		...(input.update ? { update: input.update } : {}),
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
