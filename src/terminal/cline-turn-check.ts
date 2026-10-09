// Reads a live card session's Cline CLI session files and asks evaluateClineTurnEnd whether its turn is over.
// Shared by the turn monitor (cline-turn-monitor.ts: ends turns Cline's TaskComplete hook missed) and session
// sync (session-column-sync.ts: keeps an idle Cline TUI's card in Review), so both find the session file the same
// way: the newest cline 3.x session whose cwd / workspace root is the summary's `workspacePath`, not the task id.
// The silent-stall reader (evaluateClineSilentStall) is shared the same way by recovery (which nudges) and the
// watchdog (which only reports).
import type { ClineTurnDetectorSettings } from "../config/cline-turn-detector-config";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { CLINE_CLI_ASK_TOOL_PATTERN } from "./agent-session-adapters";
import {
	type ClineSessionDetail,
	type ClineSessionDetailMessage,
	type ClineSessionDetailReader,
	type ClineSessionFileReader,
	getClineSessionsPath,
} from "./cline-session-files";
import { readClineTuiSignInGap } from "./cline-tui-sign-in";
import {
	type ClineTurnEndDecision,
	evaluateClineTurnEnd,
	getClineProviderErrorText,
	hasClineStatusLine,
	isClineNoImagesRejection,
	parseClineQaFinalLine,
} from "./cline-turn-outcome";

export type EndedClineTurn = Extract<ClineTurnEndDecision, { ended: true }>;

export interface ClineTurnCheckSessions {
	/** When the Kanban session entered its current state (for "running": when the turn started). */
	getStateEnteredAt: (taskId: string) => number | null;
}

export type LiveCardSessionSummary = RuntimeTaskSessionSummary & { workspacePath: string };

/** A card's (not the home agent's) session that Kanban reports running, with a process and a worktree. */
export function isLiveRunningCardSession(summary: RuntimeTaskSessionSummary): summary is LiveCardSessionSummary {
	return (
		summary.state === "running" &&
		summary.pid !== null &&
		summary.workspacePath !== null &&
		!isHomeAgentSessionId(summary.taskId)
	);
}

export interface ReadClineTurnEndInput {
	reader: ClineSessionFileReader;
	settings: Pick<ClineTurnDetectorSettings, "dataDir">;
	sessions: ClineTurnCheckSessions;
	summary: LiveCardSessionSummary;
	now: number;
	/** Passed to evaluateClineTurnEnd (default true). */
	requireStatus?: boolean;
}

export async function readClineTurnEnd(input: ReadClineTurnEndInput): Promise<ClineTurnEndDecision> {
	return evaluateClineTurnEnd({
		session: await input.reader.readLatestSession(
			getClineSessionsPath(input.settings.dataDir),
			input.summary.workspacePath,
		),
		runningSince: input.sessions.getStateEnteredAt(input.summary.taskId),
		now: input.now,
		requireStatus: input.requireStatus,
	});
}

/** For logs: "status_line STATUS: DONE", "final_reply after a bounce to running", … */
export function describeClineTurnEnd(decision: EndedClineTurn): string {
	const status = decision.statusLine ? ` STATUS: ${decision.statusLine.kind}` : "";
	return `${decision.reason}${status}${decision.afterBounce ? " after a bounce to running" : ""}`;
}

/**
 * Why a card whose Kanban session is "running" makes no progress in its Cline session file (foo 2026-10-07 22:15Z:
 * four cards sat 15 min on a tool_use whose result never came, while their TUIs repainted):
 *   - `interrupted_tool`: the last message is the agent's tool call and no result followed (the step was cut off);
 *   - `no_status_reply`: the last message is a final reply with no STATUS line (nor any other turn end);
 *   - `untouched`: the agent owes the reply (the last message is the prompt or a tool result, or there is none);
 *   - `no_session`: Cline wrote no session file for this run at all: its TUI never took the prompt, e.g. it sits on
 *     Cline's sign-in screen (issue #9, foo QA card ab61f 2026-10-08: no Bedrock key stored in providers.json).
 *     Typing into it doesn't help: the sign-in screen takes the text as input and starts a Cline account sign-in.
 * A pending question to the user (an ask tool) is no stall. `status` is the session file's own (`running` / `idle`): an `untouched` session still "running" is a model
 * request in flight, which recovery's hung-request check (Esc, `hungMin`) owns.
 */
export type ClineSilentStallKind = "interrupted_tool" | "no_status_reply" | "untouched" | "no_session";

export interface ClineSilentStall {
	kind: ClineSilentStallKind;
	/** Null for `no_session`. */
	sessionId: string | null;
	status: string | null;
	/** The newest progress: a message, a write in the session dir, or the Kanban turn's start, whichever is newest. */
	lastProgressAt: number;
	/** Quiet time since `lastProgressAt`, minus the first-reply allowance while the model owes its first reply. */
	idleMs: number;
	/** The interrupted tool calls' names. */
	tools: string[];
	/** `no_session` only: why Cline's TUI would open its sign-in screen (cline-tui-sign-in.ts), when that is known. */
	signInGap?: string | null;
}

export interface ClineSilentStallInput {
	detail: ClineSessionDetail | null;
	/**
	 * Kanban's own newest sign of the run (getSessionProgressAt: its start, last switch to "running", last hook; plus,
	 * for recovery, its last nudge): the stall clock never starts before it.
	 */
	kanbanProgressAt: number | null;
	/**
	 * When the Kanban session's process started (its `startedAt`). With it, a run with no Cline session file of its
	 * own (isClineSessionOfRun) is a `no_session` stall; without it such a run is never judged.
	 */
	runStartedAt?: number | null;
	/**
	 * Extra quiet time an `untouched` session gets while it has no reply from the model yet: a local provider loads
	 * the model on the first request (Lemonade with three models loading at once took minutes, 2026-10-09). Callers
	 * pass CLINE_FIRST_REPLY_LOAD_ALLOWANCE_MS for a slow-first-call provider, else nothing.
	 */
	firstReplyAllowanceMs?: number;
	/** The provider says the run's model is still loading: the model owes the reply, so `untouched` is no stall. */
	modelLoading?: boolean;
	now: number;
}

/** The first-reply allowance (firstReplyAllowanceMs) for a provider that loads the model on the first request. */
export const CLINE_FIRST_REPLY_LOAD_ALLOWANCE_MS = 10 * 60_000;

/**
 * Whether `detail` (a worktree's newest Cline session) belongs to the Kanban run that started at `runStartedAt`: it
 * started then or later, or it has been written since (a session that outlived an earlier run is not this one's
 * until it moves). True when the run's start is unknown.
 */
export function isClineSessionOfRun(detail: ClineSessionDetail | null, runStartedAt: number | null): boolean {
	if (!detail) {
		return false;
	}
	if (runStartedAt === null) {
		return true;
	}
	const writtenAt = Math.max(detail.lastWriteAt ?? 0, detail.snapshot.messagesWrittenAt ?? 0);
	return (detail.snapshot.startedAt ?? 0) >= runStartedAt || writtenAt >= runStartedAt;
}

const ASK_TOOL_PATTERN = new RegExp(`^(?:${CLINE_CLI_ASK_TOOL_PATTERN})$`, "u");
/** Cline's shell tool: its command runs as a child process, and nothing is written to the session while it runs. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["run_commands"]);

/** Whether a pending tool call runs a shell command (a child process to look for, see findAgentToolProcess). */
export function isClineShellTool(name: string): boolean {
	return SHELL_TOOLS.has(name);
}

/** Whether the session's last message is a shell tool call still waiting for its result. */
export function isClineShellToolPending(detail: ClineSessionDetail | null): boolean {
	const last = detail?.messages.at(-1);
	return (
		last?.role === "assistant" &&
		last.content.some((block) => block.type === "tool_use" && isClineShellTool(block.name ?? ""))
	);
}

function isTurnEndReply(text: string): boolean {
	return (
		hasClineStatusLine(text) ||
		parseClineQaFinalLine(text) !== null ||
		isClineNoImagesRejection(text) ||
		getClineProviderErrorText(text) !== null
	);
}

function classifyLastMessage(
	last: ClineSessionDetailMessage | undefined,
): { kind: ClineSilentStallKind; tools: string[] } | null {
	if (last?.role !== "assistant") {
		return { kind: "untouched", tools: [] };
	}
	const tools = last.content.filter((block) => block.type === "tool_use");
	if (tools.length > 0) {
		const names = tools.map((block) => block.name ?? "tool");
		// A question to the user (or plan mode's reply) waits on a person, not on a tool: not a stall.
		return names.every((name) => ASK_TOOL_PATTERN.test(name)) ? null : { kind: "interrupted_tool", tools: names };
	}
	const text = last.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	// A STATUS line, a QA final line or a provider rejection ends the turn: the turn detector's, not a stall.
	return isTurnEndReply(text) ? null : { kind: "no_status_reply", tools: [] };
}

/**
 * The silent stall of a card's newest Cline session, however long it has been quiet (the caller compares `idleMs`
 * with its limit), or null when the session shows no stall: no session, a finished or failed session file, or a
 * final reply that ends the turn. Progress is a new message or a write in the session dir (a teammate's messages
 * included); Kanban's PTY output never counts, since an idle TUI repaints. Given `runStartedAt`, a run without a
 * session file of its own is `no_session`, its clock starting at the run's start (or Kanban's later progress).
 * A model the provider is still loading (`modelLoading`) owes the reply, and its first reply gets
 * `firstReplyAllowanceMs` on top of the caller's limit: neither is the agent's silence.
 */
export function evaluateClineSilentStall(input: ClineSilentStallInput): ClineSilentStall | null {
	const { detail, now } = input;
	const runStartedAt = input.runStartedAt ?? null;
	if (runStartedAt !== null && !isClineSessionOfRun(detail, runStartedAt)) {
		const lastProgressAt = Math.max(runStartedAt, input.kanbanProgressAt ?? 0);
		return {
			kind: "no_session",
			sessionId: null,
			status: null,
			lastProgressAt,
			idleMs: Math.max(0, now - lastProgressAt),
			tools: [],
		};
	}
	if (!detail || (detail.snapshot.status !== "running" && detail.snapshot.status !== "idle")) {
		return null;
	}
	const last = detail.messages.at(-1);
	const classified = classifyLastMessage(last);
	if (!classified) {
		return null;
	}
	const awaitingFirstReply =
		classified.kind === "untouched" && !detail.messages.some((message) => message.role === "assistant");
	if (classified.kind === "untouched" && input.modelLoading === true) {
		return null;
	}
	const lastProgressAt = Math.max(
		detail.lastWriteAt ?? 0,
		detail.snapshot.messagesWrittenAt ?? 0,
		last?.ts ?? 0,
		input.kanbanProgressAt ?? 0,
	);
	if (lastProgressAt <= 0) {
		return null;
	}
	return {
		...classified,
		sessionId: detail.snapshot.sessionId,
		status: detail.snapshot.status,
		lastProgressAt,
		idleMs: Math.max(0, now - lastProgressAt - (awaitingFirstReply ? (input.firstReplyAllowanceMs ?? 0) : 0)),
	};
}

export interface ReadClineSilentStallInput {
	reader: ClineSessionDetailReader;
	settings: Pick<ClineTurnDetectorSettings, "dataDir">;
	workspacePath: string;
	kanbanProgressAt: number | null;
	/** See ClineSilentStallInput. */
	runStartedAt?: number | null;
	/** The card's provider (`-P`), for the sign-in reason of a `no_session` stall. */
	providerId?: string | null;
	/** See ClineSilentStallInput. */
	firstReplyAllowanceMs?: number;
	now: number;
}

/** evaluateClineSilentStall on the newest session of `workspacePath` (a card's worktree). */
export async function readClineSilentStall(input: ReadClineSilentStallInput): Promise<ClineSilentStall | null> {
	const stall = evaluateClineSilentStall({
		detail: await input.reader.readLatestSessionDetail(
			getClineSessionsPath(input.settings.dataDir),
			input.workspacePath,
		),
		kanbanProgressAt: input.kanbanProgressAt,
		runStartedAt: input.runStartedAt,
		firstReplyAllowanceMs: input.firstReplyAllowanceMs,
		now: input.now,
	});
	return stall?.kind === "no_session"
		? { ...stall, signInGap: await readClineTuiSignInGap(input.settings.dataDir, input.providerId ?? null) }
		: stall;
}

/**
 * Kanban's newest sign of a session's run, for the stall clock: its start, its last switch to "running" or its last
 * hook (a hook is the agent acting; PTY output is not, since an idle TUI repaints).
 */
export function getSessionProgressAt(
	session: Partial<Pick<RuntimeTaskSessionSummary, "startedAt" | "stateChangedAt" | "lastHookAt">> | null,
): number | null {
	const times = [session?.startedAt, session?.stateChangedAt, session?.lastHookAt].filter(
		(time): time is number => typeof time === "number" && Number.isFinite(time),
	);
	return times.length > 0 ? Math.max(...times) : null;
}

/** For logs: "a tool call (apply_patch) with no result, silent since <iso> (session 1791…, idle)". Stable while it lasts. */
export function describeClineSilentStall(stall: ClineSilentStall): string {
	if (stall.kind === "no_session") {
		const since = new Date(stall.lastProgressAt).toISOString();
		return stall.signInGap
			? `Cline is asking for sign-in: no Cline session file since ${since}, and ${stall.signInGap} (kanban doctor)`
			: `Cline never took the prompt: no Cline session file since ${since} (a sign-in or setup screen in its TUI?)`;
	}
	const what =
		stall.kind === "interrupted_tool"
			? `a tool call (${stall.tools.join(", ")}) with no result`
			: stall.kind === "no_status_reply"
				? "a reply with no STATUS line"
				: "no reply to the last message";
	return `${what}, silent since ${new Date(stall.lastProgressAt).toISOString()} (session ${stall.sessionId}, ${stall.status ?? "no status"})`;
}
