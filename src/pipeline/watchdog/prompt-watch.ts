// Stuck-on-prompt detection (plan §7.1, d84bc part 2): terminal agent cards waiting on a dialog nobody sees. It is
// LLM-free and reads only Kanban's session summaries. Nothing is typed into the card: the trust dialog's default is
// "No, exit", and approvals are a human call. Each item's text is stable across ticks (no minute counts), so the
// wake cooldown applies to it.
//
//   trust/startup: the session is running since `startedAt` with no hook since then. Agents that hook their prompt
//                  submit (Claude Code, Codex) fire one within seconds of a normal start, so none after
//                  `watchdog.stall.promptMin` means the agent never took its prompt: the trust dialog when the folder
//                  isn't trusted (bc84c/3c292 10/06), else another startup dialog or a hang.
//   approval:      the newest hook is a permission request (src/terminal/user-input-wait.ts, the one reader of what
//                  a session waits for the user on) and nothing happened since for `promptMin`.
//
// Ported from archive/devteam-kit:lib/prompt-watch.cjs@0782636. Which agents hook their prompt submit and how their
// folder trust is read are adapter facts (src/terminal/orchestrator-agents.ts), so nothing here names an agent.
import type { RuntimeAgentId, RuntimeBoardCard, RuntimeBoardColumnId } from "../../core/api-contract";
import { resolveEffectiveAgent } from "../../core/effective-agent";
import { isPermissionRequestActivity } from "../../terminal/user-input-wait";
import type { PipelineSessionView } from "../engine";

export type PromptWaitKind = "trust" | "startup" | "approval";

export interface PromptWait {
	taskId: string;
	kind: PromptWaitKind;
	text: string;
}

export interface PromptWatchInput {
	cards: ReadonlyArray<{ column: RuntimeBoardColumnId; card: RuntimeBoardCard }>;
	sessions: ReadonlyMap<string, PipelineSessionView>;
	selectedAgentId: RuntimeAgentId;
	now: number;
	stuckMs: number;
	hooksOnPromptSubmit: (agentId: RuntimeAgentId) => boolean;
	/** Pre-resolved trust of a session's folder for its agent: true/false, null = unknown. */
	trusted: (agentId: RuntimeAgentId, workspacePath: string) => boolean | null;
	agentLabel: (agentId: RuntimeAgentId) => string;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/u, "Z");

/** Cards whose session agent waits on a startup dialog (trust or other) or a permission answer. */
export function findPromptWaits(input: PromptWatchInput): PromptWait[] {
	const waits: PromptWait[] = [];
	for (const { column, card } of input.cards) {
		if (column !== "in_progress" && column !== "review") {
			continue;
		}
		const session = input.sessions.get(card.id);
		if (!session) {
			continue;
		}
		const agentId = resolveEffectiveAgent(card, session, { selectedAgentId: input.selectedAgentId });
		if (!input.hooksOnPromptSubmit(agentId)) {
			continue;
		}
		const lastHookAt = session.lastHookAt ?? 0;
		const startedAt = session.startedAt ?? null;
		if (
			column === "in_progress" &&
			session.state === "running" &&
			startedAt !== null &&
			lastHookAt < startedAt &&
			input.now - startedAt > input.stuckMs
		) {
			const workspacePath = session.workspacePath ?? null;
			const trusted = workspacePath ? input.trusted(agentId, workspacePath) : null;
			const label = input.agentLabel(agentId);
			waits.push(
				trusted === false
					? {
							taskId: card.id,
							kind: "trust",
							text: `${agentId} card is waiting on ${label}'s "trust this folder?" dialog since ${iso(startedAt)} (${workspacePath} is not trusted; no hook since start). kanban doctor --fix trusts the repo for new cards; this one needs "Yes, I trust this folder" picked in its terminal (default is "No, exit") or a restart`,
						}
					: {
							taskId: card.id,
							kind: "startup",
							text: `${agentId} card started ${iso(startedAt)} but never took its prompt (no hook since start): a startup dialog or a hang; open its terminal`,
						},
			);
			continue;
		}
		if (
			isPermissionRequestActivity(session.latestHookActivity) &&
			lastHookAt > 0 &&
			input.now - lastHookAt > input.stuckMs &&
			session.state !== "interrupted" &&
			session.state !== "failed"
		) {
			const activity = session.latestHookActivity;
			waits.push({
				taskId: card.id,
				kind: "approval",
				text: `${agentId} card is waiting for a permission answer since ${iso(lastHookAt)}: ${(activity?.activityText || activity?.toolName || "permission prompt").slice(0, 120)}`,
			});
		}
	}
	return waits;
}
