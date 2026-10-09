// `kanban task send|resume|restart-fresh`: recovery by hand, through the running Kanban server.
//
//   send          types a message into a card's agent with delivery confirmation (deliverTaskInput, P1-5).
//                 Ported from archive/devteam-kit:bin/chat-card.mjs@6da71597.
//   resume        restarts cards whose session died (a Kanban/container restart): a new WIP tag
//                 (preserve/<id>-wip-<stamp>-restart), a new session with the card prompt (+ the WIP note only when
//                 the worktree has tracked changes), In Progress, same agent and model. An agent whose resume
//                 continues its conversation (Claude: `--continue`) continues it with the resume note as its launch
//                 prompt instead (buildRestartResumeLaunch). Restart recovery does the same by itself with
//                 `pipeline.recovery.mode: "on"`.
//                 Ported from archive/devteam-kit:lib/resume.mjs@6da71597, kit main a2b4695 lib/resume.mjs
//                 (resumeClaude) and bin/resume-card.mjs.
//   restart-fresh starts a card over, possibly on another model: preserve the worktree as preserve/<id>-<label>,
//                 stop the session and park the card in Backlog, reset the worktree to the base tip, drop the
//                 REWORK sections and the BLOCKED prefix, set the model, reset the card's pipeline history, then
//                 start it (unless --hold). Ported from archive/devteam-kit:tools/restart-fresh.mjs@6da71597; the
//                 legacy "never stopTaskSession" was for the embedded Cline chat, which this fork removed: a PTY
//                 agent's old TUI has to stop before a fresh session starts.
import { readFile } from "node:fs/promises";

import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { resolveEffectiveAgent } from "../core/effective-agent";
import { addTaskDependency, getTaskColumnId, moveTaskToColumn, updateTask } from "../core/task-board-mutations";
import { buildRestartResumeLaunch } from "../pipeline/recovery-prompts";
import { updateTrackedPipelineCardFlow } from "../pipeline/recovery-runtime";
import { hasTrackedChanges, nextRestartWipTag, preserveWorktree, tagRestartWip } from "../pipeline/wip-tag";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceContext, mutateWorkspaceState } from "../state/workspace-state";
import { runGit } from "../workspace/git-utils";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import {
	createRuntimeTrpcClient,
	notifyRuntimeWorkspaceStateUpdated,
	type RuntimeTrpcClient,
} from "./runtime-trpc-client";

type JsonRecord = Record<string, unknown>;

const BLOCKED_TITLE = /^BLOCKED: /;
// The sections the rework loop appends to a card prompt, and the QA gate's final step that follows them.
const REWORK_SECTION = /\n\nREWORK round \d+ \(/;
const FINAL_STEP_SECTION = /\n\nFINAL STEP/;

interface TaskWorkspace {
	workspaceId: string;
	repoPath: string;
	client: RuntimeTrpcClient;
	state: RuntimeWorkspaceStateResponse;
}

async function openTaskWorkspace(projectPath: string | undefined, cwd: string): Promise<TaskWorkspace> {
	const trimmed = (projectPath ?? "").trim();
	const workspace = await loadWorkspaceContext(trimmed ? resolveProjectInputPath(trimmed, cwd) : cwd, {
		autoCreateIfMissing: false,
	});
	const client = createRuntimeTrpcClient(workspace.workspaceId);
	return {
		workspaceId: workspace.workspaceId,
		repoPath: workspace.repoPath,
		client,
		state: await client.workspace.getState.query(),
	};
}

function findCard(
	state: RuntimeWorkspaceStateResponse,
	taskId: string,
): { card: RuntimeBoardCard; column: RuntimeBoardColumnId } | null {
	for (const column of state.board.columns) {
		const card = column.cards.find((entry) => entry.id === taskId);
		if (card) {
			return { card, column: column.id };
		}
	}
	return null;
}

async function locateWorktree(repoPath: string, card: RuntimeBoardCard): Promise<string | null> {
	try {
		const info = await getTaskWorkspacePathInfo({ cwd: repoPath, taskId: card.id, baseRef: card.baseRef });
		return info.exists ? info.path : null;
	} catch {
		return null;
	}
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

async function moveCard(workspace: TaskWorkspace, taskId: string, to: RuntimeBoardColumnId): Promise<boolean> {
	const result = await mutateWorkspaceState(workspace.repoPath, (latest) => {
		const movement = moveTaskToColumn(latest.board, taskId, to);
		return { board: movement.moved ? movement.board : latest.board, value: movement.moved, save: movement.moved };
	});
	if (result.saved) {
		await notifyRuntimeWorkspaceStateUpdated(workspace.client);
	}
	return result.value;
}

/** The card's effective agent (plan §4.0): the agent its session ran on, else the card's, else the selected one. */
async function resolveCardAgent(workspace: TaskWorkspace, card: RuntimeBoardCard): Promise<RuntimeAgentId> {
	const config = await workspace.client.runtime.getConfig.query();
	return resolveEffectiveAgent(card, workspace.state.sessions[card.id] ?? null, config);
}

/**
 * Starts a session with `prompt` (ensuring the worktree) and moves the card to In Progress. `resumeFromTrash`
 * continues the agent's last conversation with `prompt` as its next turn.
 */
async function startCardSession(
	workspace: TaskWorkspace,
	card: RuntimeBoardCard,
	prompt: string,
	options: { agentId?: RuntimeAgentId; resumeFromTrash?: boolean; requireNewTurn?: boolean } = {},
): Promise<{ state: string }> {
	const ensured = await workspace.client.workspace.ensureWorktree.mutate({ taskId: card.id, baseRef: card.baseRef });
	if (!ensured.ok) {
		throw new Error(ensured.error ?? "Could not ensure task worktree.");
	}
	// The agent the session ran on wins over the card's (plan §4.0); the server falls back to the selected agent.
	const agentId = options.agentId ?? workspace.state.sessions[card.id]?.agentId ?? card.agentId ?? undefined;
	const started = await workspace.client.runtime.startTaskSession.mutate({
		taskId: card.id,
		prompt,
		taskTitle: card.title,
		startInPlanMode: false,
		baseRef: card.baseRef,
		agentId,
		agentSettings: card.agentSettings,
		...(options.resumeFromTrash ? { resumeFromTrash: true } : {}),
		...(options.requireNewTurn ? { requireNewTurn: true } : {}),
	});
	if (!started.ok || !started.summary) {
		throw new Error(started.error ?? "Could not start task session.");
	}
	await moveCard(workspace, card.id, "in_progress");
	return { state: started.summary.state };
}

export async function sendTaskMessage(input: {
	cwd: string;
	taskId: string;
	text: string;
	enter: boolean;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspace = await openTaskWorkspace(input.projectPath, input.cwd);
	const text = input.text.startsWith("@") ? await readFile(input.text.slice(1), "utf8") : input.text;
	const result = await workspace.client.runtime.deliverTaskInput.mutate({
		taskId: input.taskId,
		text,
		enter: input.enter,
	});
	return {
		ok: result.ok,
		taskId: input.taskId,
		status: result.status,
		// "output" only means the TUI printed something after Enter; a busy TUI does that without taking the text.
		confirmed: result.evidence === "state" || result.evidence === "hook",
		evidence: result.evidence,
		enterAttempts: result.enterAttempts,
		sessionState: result.summary?.state ?? null,
		...(result.error ? { error: result.error } : {}),
	};
}

async function resumeOne(workspace: TaskWorkspace, taskId: string, dryRun: boolean): Promise<JsonRecord> {
	const found = findCard(workspace.state, taskId);
	if (!found) {
		return { taskId, ok: false, error: "not on the board" };
	}
	const { card, column } = found;
	if (column === "trash") {
		return { taskId, ok: false, error: "the card is Done" };
	}
	if (BLOCKED_TITLE.test(card.title ?? "")) {
		return { taskId, ok: false, error: "BLOCKED (escalated): hand it back first" };
	}
	const summary = workspace.state.sessions[taskId] ?? null;
	if (summary?.state === "running" && isProcessAlive(summary.pid)) {
		return { taskId, ok: false, error: "its session is still running; use kanban task send" };
	}
	const worktree = await locateWorktree(workspace.repoPath, card);
	const hasWip = worktree ? await hasTrackedChanges(worktree) : false;
	const wipTag = worktree
		? dryRun
			? await nextRestartWipTag(worktree, taskId, new Date())
			: await tagRestartWip(worktree, taskId)
		: null;
	const agentId = await resolveCardAgent(workspace, card);
	const launch = buildRestartResumeLaunch(agentId, card.prompt, hasWip);
	const result: JsonRecord = {
		taskId,
		column,
		role: resolveCardRole(card),
		agentId,
		model: card.agentSettings?.modelId ?? summary?.modelId ?? null,
		wipTag,
		workInProgress: hasWip,
		continuesConversation: launch.continueConversation,
		worktree,
	};
	if (dryRun) {
		return { ...result, ok: true, dryRun: true };
	}
	// A live session that finished its turn is refused rather than reattached as "resumed" (issue #16).
	const started = await startCardSession(workspace, card, launch.prompt, {
		agentId,
		resumeFromTrash: launch.continueConversation,
		requireNewTurn: true,
	});
	// A card restart recovery marked as orphaned is no longer one, and a resume by hand ends a recovery escalation.
	await updateTrackedPipelineCardFlow(workspace.workspaceId, taskId, (qaflow) => ({
		...qaflow,
		orphan: null,
		escalated: null,
		liveHold: null,
		retryAt: null,
	}));
	return { ...result, ok: true, sessionState: started.state };
}

export async function resumeTasks(input: {
	cwd: string;
	taskIds: string[];
	dryRun: boolean;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspace = await openTaskWorkspace(input.projectPath, input.cwd);
	const results: JsonRecord[] = [];
	for (const taskId of input.taskIds) {
		try {
			results.push(await resumeOne(workspace, taskId, input.dryRun));
		} catch (error) {
			results.push({ taskId, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { ok: results.every((entry) => entry.ok === true), workspacePath: workspace.repoPath, results };
}

/** The card prompt without the REWORK sections, keeping a FINAL STEP that follows them. */
export function stripReworkSections(prompt: string): string {
	const reworkAt = prompt.search(REWORK_SECTION);
	if (reworkAt < 0) {
		return prompt;
	}
	const finalAt = prompt.search(FINAL_STEP_SECTION);
	return prompt.slice(0, reworkAt) + (finalAt > reworkAt ? prompt.slice(finalAt) : "");
}

export async function restartTaskFresh(input: {
	cwd: string;
	taskId: string;
	provider?: string;
	model: string;
	label: string;
	hold: boolean;
	after?: string;
	note?: string;
	dryRun: boolean;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspace = await openTaskWorkspace(input.projectPath, input.cwd);
	const found = findCard(workspace.state, input.taskId);
	if (!found) {
		throw new Error(`Task "${input.taskId}" was not found in workspace ${workspace.repoPath}.`);
	}
	const { card, column } = found;
	const steps: string[] = [];
	const say = (step: string) => steps.push(input.dryRun ? `[dry-run] ${step}` : step);
	const worktree = await locateWorktree(workspace.repoPath, card);
	const tag = `preserve/${card.id}-${input.label}`;
	const modelLabel = `${input.provider ? `${input.provider}/` : ""}${input.model}`;

	// 1. preserve
	if (worktree) {
		if (!input.dryRun) {
			const kept = await preserveWorktree(worktree, tag, `WIP ${card.id} before a fresh restart on ${modelLabel}`, {
				force: true,
			});
			if (!kept) {
				throw new Error(`Could not preserve the worktree as ${tag}; nothing was changed.`);
			}
		}
		say(`preserved the worktree as ${tag}`);
	} else {
		say("no worktree: nothing to preserve");
	}

	// 2. stop the session, park the card
	if (!input.dryRun) {
		await workspace.client.runtime.stopTaskSession.mutate({ taskId: card.id }).catch(() => null);
		if (column !== "backlog") {
			await moveCard(workspace, card.id, "backlog");
		}
	}
	say(`stopped the session${column !== "backlog" ? `; moved ${column} → backlog` : ""}`);

	// 3. worktree → base tip
	if (worktree) {
		const tip = await runGit(workspace.repoPath, ["rev-parse", card.baseRef]);
		if (!tip.ok) {
			throw new Error(`Could not resolve base ${card.baseRef}: ${tip.error ?? ""}`);
		}
		if (!input.dryRun) {
			const reset = await runGit(worktree, ["reset", "--hard", tip.stdout]);
			const clean = reset.ok ? await runGit(worktree, ["clean", "-fd"]) : reset;
			if (!clean.ok) {
				throw new Error(`Could not reset the worktree to ${card.baseRef}: ${clean.error ?? ""}`);
			}
		}
		say(`reset the worktree to ${card.baseRef} ${tip.stdout.slice(0, 8)}`);
	}

	// 4. prompt, title, model
	const prompt = stripReworkSections(card.prompt);
	const title = (card.title ?? "").replace(BLOCKED_TITLE, "");
	if (!input.dryRun) {
		const updated = await mutateWorkspaceState(workspace.repoPath, (latest) => {
			const current = findCard(latest, card.id)?.card;
			if (!current) {
				return { board: latest.board, value: false, save: false };
			}
			const result = updateTask(latest.board, card.id, {
				title: title || undefined,
				prompt,
				baseRef: current.baseRef,
				startInPlanMode: current.startInPlanMode,
				autoReviewEnabled: current.autoReviewEnabled,
				autoReviewMode: current.autoReviewMode,
				images: current.images,
				agentId: current.agentId,
				agentSettings: {
					...current.agentSettings,
					...(input.provider ? { providerId: input.provider } : {}),
					modelId: input.model,
				},
			});
			return { board: result.board, value: result.updated, save: result.updated };
		});
		if (updated.saved) {
			await notifyRuntimeWorkspaceStateUpdated(workspace.client);
		}
	}
	say(
		`card updated: ${modelLabel}; prompt ${card.prompt.length} → ${prompt.length} chars${title !== (card.title ?? "") ? "; BLOCKED prefix dropped" : ""}`,
	);

	// 5. pipeline history: a fresh start, keeping `handled` so old verdicts are never acted on again
	const resetAt = new Date().toISOString();
	const note = input.note ?? `restarted fresh on ${modelLabel} (WIP: ${tag})`;
	if (!input.dryRun) {
		const wrote = await updateTrackedPipelineCardFlow(workspace.workspaceId, card.id, (qaflow) => ({
			resetAt,
			note,
			handled: Array.isArray(qaflow.handled) ? qaflow.handled : [],
		}));
		say(wrote ? `pipeline history reset (resetAt ${resetAt})` : "no pipeline state for this workspace");
	} else {
		say(`pipeline history reset (resetAt ${resetAt})`);
	}

	// 6. link, then start or hold
	if (input.after) {
		if (!input.dryRun) {
			const linked = await mutateWorkspaceState(workspace.repoPath, (latest) => {
				const result = addTaskDependency(latest.board, card.id, input.after ?? "");
				return { board: result.board, value: result.added, save: result.added };
			});
			if (linked.saved) {
				await notifyRuntimeWorkspaceStateUpdated(workspace.client);
			}
		}
		say(`linked: ${card.id} waits on ${input.after}`);
	}
	if (input.hold || input.after) {
		say("held in backlog (not started)");
	} else if (!input.dryRun) {
		const latest = await workspace.client.workspace.getState.query();
		const fresh = findCard(latest, card.id)?.card ?? card;
		if (getTaskColumnId(latest.board, card.id) !== "backlog") {
			throw new Error(`Task "${card.id}" left Backlog during the restart; not started.`);
		}
		const started = await startCardSession({ ...workspace, state: latest }, fresh, fresh.prompt);
		say(`started (${started.state})`);
	} else {
		say("started");
	}
	return { ok: true, taskId: card.id, tag, model: modelLabel, dryRun: input.dryRun, steps };
}
