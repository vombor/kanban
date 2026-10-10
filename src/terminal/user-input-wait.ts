// Whether an agent session waits for the user: the one reader of "the agent asked the user something and nobody has
// answered yet" (issue #10). It reads only Kanban's session summary (the state and the latest hook activity the
// agent's hooks reported), never the PTY, so it means the same for every agent whose adapter hooks report it:
//
//   approval: the latest hook is a permission request. Claude Code's PermissionRequest hook and its Notification
//             hook with notification_type permission_prompt, Codex's PermissionRequest hook (and its session-log
//             `*_approval_request` events), Copilot's permissionRequest hook, OpenCode's permission.asked.
//   question: the latest hook is the start of a tool that asks the user (Claude Code's AskUserQuestion, Cline's ask
//             tools, which also move the session to Review), or the turn ended (Stop, TaskComplete, agentStop) with a
//             final message whose last line is a question.
//
// The hook fields of a summary are merged (session-manager.ts applyHookActivity keeps a field the newest hook didn't
// send), so a field is read only together with the hook event that sends it: a notification type only for a
// Notification hook (or a hook without an event name), a tool name only for a pre-tool event, a final message only
// for a turn end in Review (readTurnFinalMessage, src/core/turn-final-message.ts). Clearing follows from the same summary: the user's answer (PostToolUse, UserPromptSubmit)
// changes the latest hook or the state, a stopped or failed session never waits, and `answeredAt` (the viewer's last
// Enter in the session's terminal, session-manager.ts) clears a wait for agents that report no hook on the answer.
//
// The watchdog's prompt watch (src/pipeline/watchdog/prompt-watch.ts) reads approvals through
// isPermissionRequestActivity(); the browser's orchestrator badge gets this reader's answer through the project
// summaries (src/server/orchestrator-wait.ts).
import type {
	RuntimeTaskHookActivity,
	RuntimeTaskSessionSummary,
	RuntimeUserInputWaitKind,
} from "../core/api-contract";
import { readTurnFinalMessage } from "../core/turn-final-message";
import { CLINE_CLI_ASK_TOOL_PATTERN } from "./agent-session-adapters";

export interface UserInputWait {
	kind: RuntimeUserInputWaitKind;
	/** When the wait began (the hook that reported it); a new wait has a new `since`. */
	since: number;
	/** The question or the permission asked, one line, for the user (never sent to other projects' sessions). */
	text: string;
}

export interface UserInputWaitOptions {
	/** When the user last pressed Enter in the session's terminal, or null. */
	answeredAt?: number | null;
}

export type UserInputWaitSession = Pick<RuntimeTaskSessionSummary, "state"> &
	Partial<
		Pick<
			RuntimeTaskSessionSummary,
			"reviewReason" | "lastHookAt" | "stateChangedAt" | "updatedAt" | "latestHookActivity"
		>
	>;

const PERMISSION_NOTIFICATION_TYPES = new Set(["permission_prompt", "permission.asked"]);
const PERMISSION_HOOK_EVENTS = new Set(["permissionrequest"]);
const PRE_TOOL_HOOK_EVENTS = new Set(["pretooluse", "beforetool", "permissionrequest"]);
const USER_QUESTION_TOOL = new RegExp(`^(?:AskUserQuestion|${CLINE_CLI_ASK_TOOL_PATTERN})$`, "iu");
const MAX_TEXT_LENGTH = 200;

type HookActivity = RuntimeTaskHookActivity | null | undefined;

function hookEvent(activity: HookActivity): string {
	return activity?.hookEventName?.trim().toLowerCase() ?? "";
}

/** The newest hook of the session asked the user for a permission. */
export function isPermissionRequestActivity(activity: HookActivity): boolean {
	const event = hookEvent(activity);
	if (PERMISSION_HOOK_EVENTS.has(event) || event.endsWith("_approval_request")) {
		return true;
	}
	return (
		(event === "" || event === "notification") && PERMISSION_NOTIFICATION_TYPES.has(activity?.notificationType ?? "")
	);
}

function isUserQuestionToolActivity(activity: HookActivity): boolean {
	return PRE_TOOL_HOOK_EVENTS.has(hookEvent(activity)) && USER_QUESTION_TOOL.test(activity?.toolName?.trim() ?? "");
}

/**
 * The closing question of a final message (hook ingest joins its lines into one): the last sentence, when it ends with
 * a question mark (markdown emphasis or a closing quote after it allowed).
 */
function readClosingQuestion(finalMessage: string | null | undefined): string | null {
	const message = (finalMessage ?? "").replace(/\s+/gu, " ").trim();
	if (!/\?["')*_\]]*$/u.test(message)) {
		return null;
	}
	const sentences = message.split(/(?<=[.!:])\s+/u);
	return sentences.at(-1) ?? message;
}

function oneLine(text: string): string {
	const line = text.replace(/\s+/gu, " ").trim();
	return line.length > MAX_TEXT_LENGTH ? `${line.slice(0, MAX_TEXT_LENGTH - 1).trimEnd()}…` : line;
}

/**
 * What the hook's activity text says without hook ingest's prefixes: "Waiting for approval: Bash: rm -rf x" is
 * "Bash: rm -rf x", and for a question tool "Using AskUserQuestion: Which one?" is "Which one?".
 */
function readActivityDetail(activity: HookActivity, options: { dropToolName: boolean }): string {
	const tool = activity?.toolName?.trim() ?? "";
	let text = activity?.activityText?.trim() ?? "";
	for (const prefix of ["Waiting for approval", "Using", ...(options.dropToolName && tool ? [tool] : [])]) {
		if (text === prefix) {
			return "";
		}
		if (text.startsWith(`${prefix}: `) || (prefix === "Using" && text.startsWith(`${prefix} `))) {
			text = text.slice(prefix.length + 1).replace(/^\s+/u, "");
		}
	}
	return text === tool && options.dropToolName ? "" : text;
}

/** What the session waits for the user on, or null when it doesn't (see the rules above). */
export function describeUserInputWait(
	session: UserInputWaitSession | null | undefined,
	options: UserInputWaitOptions = {},
): UserInputWait | null {
	if (!session || (session.state !== "running" && session.state !== "awaiting_review")) {
		return null;
	}
	const activity = session.latestHookActivity;
	const since = session.lastHookAt ?? session.stateChangedAt ?? session.updatedAt ?? 0;
	if (typeof options.answeredAt === "number" && options.answeredAt >= since) {
		return null;
	}
	// A tool that asks the user may need a permission first (Claude Code's AskUserQuestion): it is still a question.
	if (isUserQuestionToolActivity(activity)) {
		return {
			kind: "question",
			since,
			text: oneLine(readActivityDetail(activity, { dropToolName: true }) || "The agent asked a question"),
		};
	}
	if (isPermissionRequestActivity(activity)) {
		return {
			kind: "approval",
			since,
			text: oneLine(readActivityDetail(activity, { dropToolName: false }) || "Permission request"),
		};
	}
	const question = readClosingQuestion(readTurnFinalMessage(session));
	if (question) {
		return { kind: "question", since, text: oneLine(question) };
	}
	return null;
}
