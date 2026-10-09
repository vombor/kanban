// `kanban task handback`: gives an escalated card back to the pipeline (plan §2.3). Append-only: the escalation
// moves into `qaflow.handbacks[]` with who, why and how many extra FAIL rounds, `qaflow.escalated` is cleared, and
// the QA log gets a HANDBACK section; nothing recorded earlier is rewritten. With extra rounds the rework stage acts
// once more on the FAIL that escalated the card (rework.ts findPendingHandback) as soon as the card is in Review.
//
// A STALLED QA round (cause `stalled`, or `qa_agent_error`: the QA agent's own runs failed) gave the work no verdict,
// so its handback re-QAs the card instead (issue #16): when it was escalated to the orchestrator, the dev card's
// `qaCreated` goes, the card goes back to Review, and the QA gate gives its current snapshot a new QA card with the
// kit's current QA model (a STALLED older than the last handback is not that snapshot's verdict, qa-gate.ts).
// `--extra-rounds` is refused there: it reworks a FAIL, and a STALLED has none. A FAIL from the new QA round that
// escalates the card again is handed back with `--extra-rounds` as usual.
//
// In-process and under the pipeline state's file lock, so the pipeline worker never sees half of it: the legacy kit
// had to stop and restart autoland around the same edit.
//
// Ported from archive/devteam-kit:bin/kit@6da71597 (cmdHandback) and services/kanban-autoland.mjs@158817d
// (maxFailsOf: each handback grants its extra rounds). Reopening a runoff decided with no winner (the team kit's
// runoffs.json, reopenRunoffWithoutWinner) and unlinking a waiting sibling are done by `kanban task handback` itself.
import type { PipelineStateStore } from "./pipeline-state";
import {
	type HandbackRecord,
	isQaRequeueEscalation,
	isStalledEscalation,
	readEscalationRecord,
	readQaflow,
	readReworks,
} from "./rework";

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
	 * Whether the rework stage acts again on its own: extra rounds were granted and the card was escalated over a FAIL
	 * or a land conflict (the rework stage re-acts on those).
	 */
	reworks: boolean;
	/**
	 * Whether QA runs again on the card's current snapshot (isQaRequeueEscalation): the caller moves the card to
	 * Review, where the QA gate queues a new QA card for it.
	 */
	requeuesQa: boolean;
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
		if (input.extraRounds > 0 && isStalledEscalation(escalated)) {
			throw new Error(
				`Task "${input.taskId}" was escalated over a STALLED QA round, not a FAIL (${escalated.reason}): QA gave its work no verdict, so --extra-rounds has no FAIL to rework. Hand it back without --extra-rounds${isQaRequeueEscalation(escalated) ? ": it goes to Review and its current snapshot is QA'd again with the kit's current QA model" : ""}. If a later QA round FAILs and the card is escalated again, hand that back with --extra-rounds.`,
			);
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
		// The QA gate makes one QA card per snapshot (`qaCreated`): a requeue asks it for another one.
		const { qaCreated: _created, ...requeued } = entry ?? {};
		state.cards[input.taskId] = { ...(isQaRequeueEscalation(escalated) ? requeued : entry), qaflow: next };
		return state;
	});
	if (!handback) {
		throw new Error(`Task "${input.taskId}" could not be handed back.`);
	}
	const recorded: HandbackRecord = handback;
	const escalated = readEscalationRecord({ escalated: recorded.escalated });
	const stalled = escalated ? isStalledEscalation(escalated) : false;
	const requeuesQa = escalated ? isQaRequeueEscalation(escalated) : false;
	const rounds = input.extraRounds > 0 ? ` (+${input.extraRounds} FAIL round${input.extraRounds > 1 ? "s" : ""})` : "";
	const stalledNote = requeuesQa
		? `- It was escalated over a STALLED QA round (${escalated?.cause === "qa_agent_error" ? "the QA agent's own runs failed" : "no verdict"}): back in Review, its current snapshot gets a new QA card with the kit's current QA model.\n`
		: stalled
			? "- It was escalated over a STALLED QA round to another model, whose card has the task: it stays in Backlog.\n"
			: "";
	return {
		handback: recorded,
		reworks: input.extraRounds > 0 && !stalled,
		requeuesQa,
		qaLogSection: `\n## HANDBACK ${input.taskId}: back to the pipeline${requeuesQa ? " for a new QA round" : rounds}\n- ${at} by ${input.by} (kanban task handback): ${note}\n- Was escalated ${escalated?.at ?? "?"}: ${escalated?.reason ?? "?"}\n${stalledNote}`,
	};
}
