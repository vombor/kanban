// Reads the legacy kit's autoland log (`<kit home>/logs/kanban-autoland.log`) into the decisions the shadow diff
// compares with the pipeline's decision log (plan §8.4 step 1, P4-8). Read-only, and only the lines that carry a
// decision: autoland logs one line per action, `<ISO time> <topic> <card id>: <text>`.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (its `log(...)` lines; the shapes below are
// the exact texts it writes) and lib/restart-recovery.mjs@6da71597. A line this parser doesn't know is skipped:
// the diff only claims what it can read.

export type LegacyNudgeCause = "crash" | "poisoned" | "premature" | "retry";
export type LegacyVerdict = "PASS" | "FAIL" | "STALLED";

export type LegacyAction =
	/** `snapshot <id>: <sha> on <base> (review)`: a new snapshot of a submitted card. */
	| { kind: "submitted"; snapshot: string }
	/** `qa <id>: WARNING snapshot has no changes …`: nothing to QA. */
	| { kind: "no_work" }
	/** `qa <id>: created QA card <qa> (round N) for snapshot <sha>`. */
	| { kind: "qa_created"; qaTaskId: string; round: number | null }
	/** `qa <id>: already created …` / `… already has a QA verdict …` / `<qa> (<col>) already QAs <id>`: QA'd before. */
	| { kind: "qa_existing" }
	/** `qa <id>: not a dev card (…); not creating a QA card`. */
	| { kind: "qa_skipped"; reason: string }
	/** `qaflow <id>: acting on QA <V> r<N> …`. */
	| { kind: "verdict"; verdict: LegacyVerdict; round: number }
	/** `qaflow <id>: PASS r<N> but <sha> CONFLICTS with <base> …` or `land <id>: CONFLICT merging into …`. */
	| { kind: "conflict" }
	/** `qaflow <id>: PASS r<N>, …; moved to Done (landing next)`. */
	| { kind: "pass_land" }
	/** `qaflow <id>: PASS r<N> held for runoff <name>; …`. */
	| { kind: "pass_held"; runoff: string }
	/** `land <id>: <base> -> <sha> in <repo>`. */
	| { kind: "landed"; base: string; commit: string }
	/** `qaflow <id>: REWORK round N (n/m) sent to <agent> <provider>/<model> via …`. */
	| { kind: "rework"; round: number; agent: string; model: string | null; cleared: boolean }
	/** `qaflow <id>: ESCALATED (<reason>)`. */
	| { kind: "escalated"; reason: string }
	/** `qaflow <id>: handback <at> (+N rounds): re-acting on FAIL r<N>`: a handback granted N more FAIL rounds. */
	| { kind: "handback"; extraRounds: number }
	/** Crash nudges, premature-stop continues, provider-error retries sent. */
	| { kind: "nudge"; cause: LegacyNudgeCause }
	/** A provider-error retry scheduled, or an outage hold started: the card stays in Review. */
	| { kind: "hold" }
	/** `restart <id>: orphaned (<kind>, <column>): …`. */
	| { kind: "orphan" }
	/** `restart <id>: resumed on …`. */
	| { kind: "resumed" };

export interface LegacyCardEvent {
	at: string;
	taskId: string;
	action: LegacyAction;
	/** The log text after `<topic> <id>: `, for the report. */
	text: string;
}

/** `restart <workspace>: Kanban started <iso> (autoland last saw <iso|none>): N orphaned card(s)[: id (kind), …]`. */
export interface LegacyRestartEvent {
	at: string;
	workspaceId: string;
	serverStartedAt: string;
	/** The start autoland had seen before this line; null for "none". */
	lastSeenStartedAt: string | null;
	orphans: string[];
}

/** `event <workspace>/<id>: <from> -> <to>`: autoland's board events, the only lines that name a card's workspace. */
export interface LegacyBoardEvent {
	at: string;
	workspaceId: string;
	taskId: string;
}

export interface LegacyAutolandLog {
	cards: LegacyCardEvent[];
	restarts: LegacyRestartEvent[];
	boardEvents: LegacyBoardEvent[];
}

const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (\S+) (\S+?): (.*)$/u;
const CARD_ID = /^[0-9a-f]{5}$/u;

function parseQaLine(text: string): LegacyAction | null {
	const created = /^created QA card ([0-9a-f]{5})(?: \(round (\d+)\))? for snapshot/u.exec(text);
	if (created) {
		return { kind: "qa_created", qaTaskId: created[1] as string, round: created[2] ? Number(created[2]) : null };
	}
	if (/^already created QA card |already has a QA verdict|^[0-9a-f]{5} \(\w+\) already QAs /u.test(text)) {
		return { kind: "qa_existing" };
	}
	const skipped = /^not a dev card \((.*)\); not creating a QA card/u.exec(text);
	if (skipped) {
		return { kind: "qa_skipped", reason: `not a dev card (${skipped[1]})` };
	}
	if (/^WARNING snapshot has no changes/u.test(text)) {
		return { kind: "no_work" };
	}
	return null;
}

function parseQaflowLine(text: string): LegacyAction | null {
	const acting = /^acting on QA (PASS|FAIL|STALLED) r(\d+)/u.exec(text);
	if (acting) {
		return { kind: "verdict", verdict: acting[1] as LegacyVerdict, round: Number(acting[2]) };
	}
	if (/^PASS r\d+ but \S+ CONFLICTS with /u.test(text)) {
		return { kind: "conflict" };
	}
	const held = /^PASS r\d+ held for runoff (\S+?);/u.exec(text);
	if (held) {
		return { kind: "pass_held", runoff: held[1] as string };
	}
	if (/^PASS r\d+, .*; moved to Done/u.test(text)) {
		return { kind: "pass_land" };
	}
	const rework = /^REWORK round (\d+) \([^)]*\) sent to (\S+) (\S+?) via \S+?( \(cleared\))?;/u.exec(text);
	if (rework) {
		const target = rework[3] as string;
		const slash = target.indexOf("/");
		return {
			kind: "rework",
			round: Number(rework[1]),
			agent: rework[2] as string,
			model: slash >= 0 ? target.slice(slash + 1) : target || null,
			cleared: Boolean(rework[4]),
		};
	}
	const escalated = /^ESCALATED \((.*)\)$/u.exec(text);
	if (escalated) {
		return { kind: "escalated", reason: escalated[1] as string };
	}
	const handback = /^handback \S+ \(\+(\d+) rounds\)/u.exec(text);
	if (handback) {
		return { kind: "handback", extraRounds: Number(handback[1]) };
	}
	// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (nudgeCrashed, the premature-stop and
	// provider-error paths): the texts are the only record of which recovery path ran.
	if (/^agent stopped with .*\(corrupted history: cleared \+ full prompt\); nudged /u.test(text)) {
		return { kind: "nudge", cause: "poisoned" };
	}
	if (/^agent stopped with .*; nudged /u.test(text)) {
		return { kind: "nudge", cause: "crash" };
	}
	if (/^turn ended on an? .*; (?:sent|cleared)/u.test(text)) {
		return { kind: "nudge", cause: "premature" };
	}
	if (/^sent provider-error retry /u.test(text)) {
		return { kind: "nudge", cause: "retry" };
	}
	if (
		/^provider error on .*; retrying in /u.test(text) ||
		/^provider retries used up on .*; outage hold/u.test(text)
	) {
		return { kind: "hold" };
	}
	return null;
}

function parseLandLine(text: string): LegacyAction | null {
	if (/^CONFLICT merging into /u.test(text)) {
		return { kind: "conflict" };
	}
	const landed = /^(\S+) -> ([0-9a-f]{7,40}) in /u.exec(text);
	return landed ? { kind: "landed", base: landed[1] as string, commit: landed[2] as string } : null;
}

function parseSnapshotLine(text: string): LegacyAction | null {
	const submitted = /^([0-9a-f]{8,40}) on \S+ \(review\)/u.exec(text);
	return submitted ? { kind: "submitted", snapshot: submitted[1] as string } : null;
}

function parseRestartCardLine(text: string): LegacyAction | null {
	if (/^orphaned \(dev\b/u.test(text)) {
		return { kind: "orphan" };
	}
	return /^resumed on /u.test(text) ? { kind: "resumed" } : null;
}

function parseRestartWorkspaceLine(at: string, workspaceId: string, text: string): LegacyRestartEvent | null {
	const match =
		/^Kanban started (\S+) \((?:autoland last saw ([^\s)]+))?.*?\): (\d+) orphaned card\(s\)(?:: (.*))?$/u.exec(text);
	if (!match) {
		return null;
	}
	const orphans = (match[4] ?? "")
		.split(",")
		.map((entry) => /^\s*([0-9a-f]{5}) \((\w+)\)/u.exec(entry))
		// Calibration orphans are left to the calibration runner by both sides.
		.flatMap((entry) => (entry && entry[2] !== "cal" ? [entry[1] as string] : []));
	const lastSeen = match[2] && match[2] !== "none" ? match[2] : null;
	return { at, workspaceId, serverStartedAt: match[1] as string, lastSeenStartedAt: lastSeen, orphans };
}

export function parseLegacyAutolandLog(text: string): LegacyAutolandLog {
	const log: LegacyAutolandLog = { cards: [], restarts: [], boardEvents: [] };
	for (const line of text.split("\n")) {
		const match = LINE.exec(line);
		if (!match) {
			continue;
		}
		const [, at, topic, subject, rest] = match as unknown as [string, string, string, string, string];
		if (topic === "event") {
			const slash = subject.lastIndexOf("/");
			const taskId = subject.slice(slash + 1);
			if (slash > 0 && CARD_ID.test(taskId)) {
				log.boardEvents.push({ at, workspaceId: subject.slice(0, slash), taskId });
			}
			continue;
		}
		if (topic === "restart" && !CARD_ID.test(subject)) {
			const restart = parseRestartWorkspaceLine(at, subject, rest);
			if (restart) {
				log.restarts.push(restart);
			}
			continue;
		}
		if (!CARD_ID.test(subject)) {
			continue;
		}
		const action =
			topic === "qa"
				? parseQaLine(rest)
				: topic === "qaflow"
					? parseQaflowLine(rest)
					: topic === "land"
						? parseLandLine(rest)
						: topic === "snapshot"
							? parseSnapshotLine(rest)
							: topic === "restart"
								? parseRestartCardLine(rest)
								: null;
		if (action) {
			log.cards.push({ at, taskId: subject, action, text: rest });
		}
	}
	return log;
}
