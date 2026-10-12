// `kanban hooks orchestrator-notices --workspace-id <ws>`: the orchestrator sidebar's Claude Code UserPromptSubmit
// hook (agent-session-adapters.ts). It takes the workspace's silent wakes from the server (tRPC
// `orchestratorInbox.take`, src/server/orchestrator-inbox.ts) and prints them as `additionalContext`, which Claude Code
// adds to the user's prompt without showing it in the input box. The workspace comes from the argument, never the
// env. Every failure (no server, a refusal, a timeout, an unreadable payload) prints nothing and exits 0: the prompt
// goes ahead and the notices stay queued, to be typed once they are due.
import { asRecord, readStringField } from "./hook-utils";

/** Below the hook's own timeout in Claude Code's settings (15 s), so an answer is printed before Claude stops waiting. */
export const ORCHESTRATOR_NOTICES_TIMEOUT_MS = 8_000;

export interface OrchestratorNoticesHookInput {
	workspaceId: string;
	/** The hook's stdin (Claude Code's JSON payload); "" when there is none. */
	payload: string;
	take: (workspaceId: string) => Promise<{ notices: string | null }>;
	write: (text: string) => void;
	timeoutMs?: number;
}

/** True when the payload is another event's (a hook wired to the wrong event must not drain the inbox). */
function isOtherHookEvent(payload: string): boolean {
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = asRecord(JSON.parse(payload));
	} catch {
		return false;
	}
	const eventName = parsed ? readStringField(parsed, "hook_event_name") : null;
	return eventName !== null && eventName !== "UserPromptSubmit";
}

export async function runOrchestratorNoticesHook(input: OrchestratorNoticesHookInput): Promise<void> {
	const workspaceId = input.workspaceId.trim();
	if (!workspaceId || isOtherHookEvent(input.payload)) {
		return;
	}
	let timer: NodeJS.Timeout | null = null;
	try {
		const timeout = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), input.timeoutMs ?? ORCHESTRATOR_NOTICES_TIMEOUT_MS);
		});
		const answer = await Promise.race([input.take(workspaceId), timeout]);
		if (!answer?.notices) {
			return;
		}
		input.write(
			`${JSON.stringify({
				hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: answer.notices },
			})}\n`,
		);
	} catch {
		// never block the prompt
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}
