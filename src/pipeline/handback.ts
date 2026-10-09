// `kanban task handback`: gives an escalated card back to the pipeline (plan §2.3). Append-only: the escalation
// moves into `qaflow.handbacks[]` with who, why and how many extra FAIL rounds, `qaflow.escalated` is cleared, and
// the QA log gets a HANDBACK section; nothing recorded earlier is rewritten. With extra rounds the rework stage acts
// once more on the FAIL that escalated the card (rework.ts findPendingHandback) as soon as the card is in Review.
//
// In-process and under the pipeline state's file lock, so the pipeline worker never sees half of it: the legacy kit
// had to stop and restart autoland around the same edit.
//
// Ported from archive/devteam-kit:bin/kit@6da71597 (cmdHandback) and services/kanban-autoland.mjs@158817d
// (maxFailsOf: each handback grants its extra rounds). Reopening a runoff decided with no winner (the team kit's
// runoffs.json, reopenRunoffWithoutWinner) and unlinking a waiting sibling are done by `kanban task handback` itself.
import type { PipelineStateStore } from "./pipeline-state";
import { type HandbackRecord, readEscalationRecord, readQaflow, readReworks } from "./rework";

export interface HandBackInput {
	workspaceId: string;
	taskId: string;
	note: string;
	extraRounds: number;
	by: string;
	/** Epoch ms. */
	now: number;
}

export interface HandBackResult {
	handback: HandbackRecord;
	/**
	 * Whether the pipeline acts again on its own: extra rounds were granted and the card was escalated over a FAIL or
	 * a land conflict (the rework stage re-acts on those). A STALLED QA round is not reworked: QA of that snapshot
	 * already has its verdict, so the card needs a restart, or a change that makes a new snapshot, from a human. A
	 * STALLED from the QA agent's own errors (`qa_agent_error`) is QA'd again: that verdict stops counting.
	 */
	reworks: boolean;
	/** The QA log section to append. */
	qaLogSection: string;
}

export async function handBackTask(store: PipelineStateStore, input: HandBackInput): Promise<HandBackResult> {
	const note = input.note.trim();
	if (!note) {
		throw new Error("task handback needs a --note saying why.");
	}
	if (!Number.isInteger(input.extraRounds) || input.extraRounds < 0) {
		throw new Error("--extra-rounds must be a whole number of 0 or more.");
	}
	const at = new Date(input.now).toISOString();
	let handback: HandbackRecord | null = null;
	await store.update(input.workspaceId, (state) => {
		const entry = state.cards[input.taskId];
		const qaflow = readQaflow(entry);
		const escalated = readEscalationRecord(qaflow);
		if (!escalated) {
			throw new Error(`Task "${input.taskId}" is not escalated in the pipeline state of ${input.workspaceId}.`);
		}
		handback = { at, by: input.by, note, extraRounds: input.extraRounds, escalated };
		// The rework the escalation came from (never started, not started, impossible) is over: the started-check
		// would otherwise escalate it again on the next tick.
		const reworks = readReworks(qaflow);
		const open = reworks.at(-1);
		const closed =
			open && !open.returned && !open.closedBy
				? [...reworks.slice(0, -1), { ...open, closedBy: "handback" as const, closedAt: at }]
				: reworks;
		const next: Record<string, unknown> = {
			...qaflow,
			...(closed.length > 0 ? { reworks: closed } : {}),
			handbacks: [...(Array.isArray(qaflow.handbacks) ? qaflow.handbacks : []), handback],
		};
		delete next.escalated;
		state.cards[input.taskId] = { ...entry, qaflow: next };
		return state;
	});
	if (!handback) {
		throw new Error(`Task "${input.taskId}" could not be handed back.`);
	}
	const recorded: HandbackRecord = handback;
	const escalated = readEscalationRecord({ escalated: recorded.escalated });
	const rounds = input.extraRounds > 0 ? ` (+${input.extraRounds} FAIL round${input.extraRounds > 1 ? "s" : ""})` : "";
	const qaAgentError = escalated?.cause === "qa_agent_error";
	const reworks = input.extraRounds > 0 && escalated?.cause !== "stalled" && !qaAgentError;
	const stalledNote = qaAgentError
		? "- It was escalated because the QA agent's own runs failed: once it is back in Review, the QA gate gives the same snapshot a new QA card.\n"
		: input.extraRounds > 0 && !reworks
			? "- It was escalated over a STALLED QA round, which the pipeline does not rework: restart or change the card for a new QA round; the extra rounds count for later FAILs.\n"
			: "";
	return {
		handback: recorded,
		reworks,
		qaLogSection: `\n## HANDBACK ${input.taskId}: back to the pipeline${rounds}\n- ${at} by ${input.by} (kanban task handback): ${note}\n- Was escalated ${escalated?.at ?? "?"}: ${escalated?.reason ?? "?"}\n${stalledNote}`,
	};
}
