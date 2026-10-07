// Stall detection for one workspace the pipeline runs on (landing mode `qa`): cards that the automation should have
// moved on but didn't. It is LLM-free; what it finds goes to the orchestrator (a wake item) or gets one LLM-free
// "continue". Decisions use the card's role (legacy cards without `role` get one from the kit's markers,
// src/core/card-role.ts) and the kit's QA answer, never the card's literal agent id: the legacy watchdog looked only
// at Cline-family cards (`isClineFamily(card.agentId)`), the incident pattern of 2026-10-06.
//
//   dev card in Review, the kit QA-gates it, no QA card, no verdict acted on since its last move, not escalated,
//     not on outage hold, not an open user item, no runoff PASS parked for its snapshot, > stall.reviewMin  → item
//   QA/TRIAGE card in progress with its session not running > stall.qaMin                                  → item
//   dev card in progress whose session is not running > stall.resumeIdleMin: one continue per dead session
//     (not during a PID brownout), then > stall.idleMin                                                     → item
//   calibration cards: never (their runner times them out and moves them itself)
//
// Ported from archive/devteam-kit:services/review-watch.mjs@6da71597 (tick) with the rules indexed in
// docs/team/HISTORY.md "Watchdog": 4237849 (one continue first), a5a5cce/d6c88c2 (pressure holds QA, not the continue;
// a QA card held by pressure counts), b52a684 (open user items), 6f6f826 (runoff PASS), 22f8068 and 8a4f437 (idle heads).
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskRole,
} from "../../core/api-contract";
import { resolveCardRole } from "../../core/card-role";
import type { PipelineSessionView } from "../engine";
import { readPipelineHold } from "../hold";
import type { PipelineCardState } from "../pipeline-state";
import { readQaPassEntry } from "../qa-gate";

const MIN = 60_000;
// The dev card a legacy QA card reviews, from its prompt (archive/devteam-kit:services/review-watch.mjs@6da71597
// QA_FOR). A Kanban QA card (P4-3) is linked through pipeline-state's `qaCard` instead.
const LEGACY_QA_FOR = /QA reviewer \(round \d+\) for Kanban dev card ([0-9a-f]{5})/u;

/** A card's role as the watchdog sees it, and for a QA card the dev card it reviews. */
export interface WatchdogCardRole {
	role: RuntimeTaskRole;
	reviewsTaskId: string | null;
}

/**
 * The role from resolveCardRole() (`role`, else the legacy kit's markers). A role-less card that is a run of a
 * calibration (a `state.json` under `data/<ws>/calibration/<name>/`) is a calibration card even when retitled
 * (archive/devteam-kit:lib/calibration.cjs@6da71597).
 */
export function resolveWatchdogCardRole(
	card: RuntimeBoardCard,
	calibrationIds: ReadonlySet<string> = new Set(),
): WatchdogCardRole {
	const role = !card.role && calibrationIds.has(card.id) ? "calibration" : resolveCardRole(card);
	return { role, reviewsTaskId: role === "qa" ? (LEGACY_QA_FOR.exec(card.prompt)?.[1] ?? null) : null };
}

export interface StallSettings {
	reviewMin: number;
	qaMin: number;
	idleMin: number;
	resumeIdleMin: number;
	newCardGraceMin: number;
}

export interface StallItem {
	/** Cooldown key (`<taskId>:<kind>`). */
	key: string;
	taskId: string;
	issue: string;
}

export interface ContinueAction {
	taskId: string;
	/** `<taskId>:<session updatedAt>`: one continue per dead session. */
	resumeKey: string;
	minutes: number;
}

export interface StallInput {
	board: RuntimeBoardData;
	sessions: ReadonlyMap<string, PipelineSessionView>;
	roles: ReadonlyMap<string, WatchdogCardRole>;
	pipelineCards: Readonly<Record<string, PipelineCardState>>;
	/** The kit QA-gates this dev card (qaPolicy answers `qa`); a card the kit doesn't gate waits for Approve & land. */
	qaGated: (card: RuntimeBoardCard) => boolean;
	userItemIds: ReadonlySet<string>;
	/** Cards of runoffs that are still open (runoffs.json): only their held PASS is parked on purpose. */
	openRunoffCardIds: ReadonlySet<string>;
	resumed: Readonly<Record<string, string>>;
	pidPressure: boolean;
	pidBrownout: boolean;
	settings: StallSettings;
	now: number;
}

export interface StallResult {
	items: StallItem[];
	continues: ContinueAction[];
}

export const CONTINUE_TEXT =
	"Your last turn ended (agent error or interruption), not because the task is finished. Continue the task from where you left off.";

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The newest verdict time the pipeline acted on, from `qaflow.handled[]` keys `r<round>|<VERDICT>|<iso>`. */
export function readNewestHandledVerdictAt(entry: PipelineCardState | undefined): number | null {
	const handled = asRecord(entry?.qaflow).handled;
	let newest: number | null = null;
	for (const key of Array.isArray(handled) ? handled : []) {
		const at = typeof key === "string" ? Date.parse(key.split("|")[2] ?? "") : Number.NaN;
		if (Number.isFinite(at) && (newest === null || at > newest)) {
			newest = at;
		}
	}
	return newest;
}

export interface EscalationInfo {
	at: string;
	reason: string;
}

export function readEscalation(entry: PipelineCardState | undefined): EscalationInfo | null {
	const escalated = asRecord(entry?.qaflow).escalated;
	if (!escalated) {
		return null;
	}
	const record = asRecord(escalated);
	return {
		at: typeof record.at === "string" ? record.at : "?",
		reason: typeof record.reason === "string" ? record.reason : "escalated",
	};
}

/** `qaflow.stopped`: the kit answered `stop` after a FAIL (src/pipeline/rework.ts); the card waits in Review. */
export function readStop(entry: PipelineCardState | undefined): EscalationInfo | null {
	const stopped = asRecord(entry?.qaflow).stopped;
	if (!stopped) {
		return null;
	}
	const record = asRecord(stopped);
	return {
		at: typeof record.at === "string" ? record.at : "?",
		reason: typeof record.reason === "string" ? record.reason : "stopped",
	};
}

function cardsByColumn(board: RuntimeBoardData): Array<{ column: RuntimeBoardColumnId; card: RuntimeBoardCard }> {
	return board.columns.flatMap((column) => column.cards.map((card) => ({ column: column.id, card })));
}

export function detectStalls(input: StallInput): StallResult {
	const { now, settings } = input;
	const items: StallItem[] = [];
	const continues: ContinueAction[] = [];
	const cards = cardsByColumn(input.board);
	const columnOf = new Map(cards.map(({ column, card }) => [card.id, column]));

	// Dev card id → a QA card working on it. A QA card idling in Backlog doesn't count (c1e30 10/05), unless PID
	// pressure holds it (bfb20 10/05).
	const hasQaCard = new Set<string>();
	const qaCardCounts = (column: RuntimeBoardColumnId | undefined) =>
		column === "in_progress" || (column === "backlog" && input.pidPressure);
	for (const { column, card } of cards) {
		const role = input.roles.get(card.id);
		if (role?.role === "qa" && role.reviewsTaskId && qaCardCounts(column)) {
			hasQaCard.add(role.reviewsTaskId);
		}
	}
	for (const [devId, entry] of Object.entries(input.pipelineCards)) {
		const qaCard = typeof entry.qaCard === "string" ? entry.qaCard : null;
		if (qaCard && qaCardCounts(columnOf.get(qaCard))) {
			hasQaCard.add(devId);
		}
	}

	for (const { column, card } of cards) {
		const role = input.roles.get(card.id)?.role ?? "dev";
		if (role === "calibration") {
			continue;
		}
		const session = input.sessions.get(card.id);
		const since = Math.max(card.updatedAt ?? 0, session?.updatedAt ?? 0);
		const minutes = Math.round((now - since) / MIN);
		if (role === "qa" || role === "triage") {
			if (column === "in_progress" && now - since > settings.qaMin * MIN && session?.state !== "running") {
				items.push({
					key: `${card.id}:qa-stall`,
					taskId: card.id,
					issue: `QA/TRIAGE card ${card.id} has been in progress ${minutes} min with its session ${session?.state ?? "missing"}`,
				});
			}
			continue;
		}
		if (column === "review") {
			const entry = input.pipelineCards[card.id];
			const qaflow = asRecord(entry?.qaflow);
			if (
				!input.qaGated(card) ||
				qaflow.escalated ||
				qaflow.stopped ||
				qaflow.outage ||
				hasQaCard.has(card.id) ||
				now - since < settings.reviewMin * MIN ||
				input.userItemIds.has(card.id)
			) {
				continue;
			}
			const verdictAt = readNewestHandledVerdictAt(entry);
			if (verdictAt !== null && verdictAt > (card.updatedAt ?? 0)) {
				continue; // the pipeline is acting on a fresh verdict
			}
			const runoffSnapshot = asRecord(qaflow.runoffPass).snapshot;
			if (runoffSnapshot && runoffSnapshot === entry?.snapshot) {
				continue; // a runoff PASS parked until the other runoff cards finish
			}
			// The same for the core hold (the team kit's runoffs feature), only while its runoff is open: a card still held
			// for a decided or closed runoff is stuck and must show up.
			const heldPass =
				readPipelineHold(entry) && input.openRunoffCardIds.has(card.id) ? readQaPassEntry(entry) : null;
			if (heldPass && heldPass.snapshot === entry?.snapshot) {
				continue;
			}
			items.push({
				key: `${card.id}:review-stall`,
				taskId: card.id,
				issue: `dev card has been in Review ${minutes} min with no QA card and no verdict newer than its last move (session ${session?.state ?? "missing"}, reviewReason ${session?.reviewReason ?? "none"}, snapshot ${typeof entry?.snapshot === "string" ? entry.snapshot : "none"})`,
			});
			continue;
		}
		if (column !== "in_progress" || !session || session.state === "running") {
			continue;
		}
		const resumeKey = `${card.id}:${session.updatedAt ?? 0}`;
		if (
			session.state !== "awaiting_review" &&
			now - since > settings.resumeIdleMin * MIN &&
			!input.pidBrownout &&
			input.resumed[resumeKey] === undefined
		) {
			continues.push({ taskId: card.id, resumeKey, minutes });
		} else if (now - since > settings.idleMin * MIN) {
			items.push({
				key: `${card.id}:idle`,
				taskId: card.id,
				issue: `dev card is In Progress but its session has been ${session.state} for ${minutes} min (reviewReason ${session.reviewReason ?? "none"}, warning ${session.warningMessage ?? "none"})`,
			});
		}
	}
	return { items, continues };
}

/**
 * "pipeline idle": no dev card in progress or in Review, but dev cards wait in Backlog with no prerequisite, not
 * `BLOCKED:` (escalated cards are listed already) and not created in the last `newCardGraceMin` (their creator
 * usually starts them next). Null when not idle.
 */
export function detectPipelineIdle(input: {
	board: RuntimeBoardData;
	roles: ReadonlyMap<string, WatchdogCardRole>;
	now: number;
	newCardGraceMin: number;
}): string | null {
	const cards = cardsByColumn(input.board).filter(({ card }) => (input.roles.get(card.id)?.role ?? "dev") === "dev");
	if (cards.some(({ column }) => column === "in_progress" || column === "review")) {
		return null;
	}
	// A dependency's fromTaskId waits on its toTaskId.
	const waiting = new Set(input.board.dependencies.map((dependency) => dependency.fromTaskId));
	const heads = cards.filter(
		({ column, card }) =>
			column === "backlog" &&
			!waiting.has(card.id) &&
			!(card.title ?? "").startsWith("BLOCKED: ") &&
			!(card.createdAt && input.now - card.createdAt < input.newCardGraceMin * MIN),
	);
	if (heads.length === 0) {
		return null;
	}
	return `- **pipeline idle**: nothing in progress or review; backlog dev card(s) with no prerequisite waiting to be started: ${heads.map(({ card }) => card.id).join(", ")}`;
}

/** True when any card is in progress or in Review. */
export function isBoardBusy(board: RuntimeBoardData): boolean {
	return board.columns.some(
		(column) => (column.id === "in_progress" || column.id === "review") && column.cards.length > 0,
	);
}
