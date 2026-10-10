import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export type SendVoiceInputResult = { ok: true } | { ok: false; message: string };

const FAILURE_MESSAGES: Record<string, string> = {
	no_session: "The session isn't running.",
	session_ended: "The session ended before the message was delivered.",
	undelivered: "The agent didn't take the message. Check the terminal.",
	aborted: "Sending was cancelled.",
};

/**
 * Sends the final transcript the way typed input is delivered: runtime.deliverTaskInput types it into the agent's TUI,
 * presses Enter and confirms the agent picked it up (src/terminal/deliver-task-input.ts).
 */
export async function sendVoiceInput(
	workspaceId: string | null,
	taskId: string,
	text: string,
): Promise<SendVoiceInputResult> {
	const trimmed = text.trim();
	if (!trimmed) {
		return { ok: false, message: "Nothing to send." };
	}
	if (!workspaceId) {
		return { ok: false, message: "No project selected." };
	}
	try {
		const response = await getRuntimeTrpcClient(workspaceId).runtime.deliverTaskInput.mutate({
			taskId,
			text: trimmed,
		});
		if (response.ok) {
			return { ok: true };
		}
		return {
			ok: false,
			message: response.error ?? FAILURE_MESSAGES[response.status] ?? "The message could not be sent.",
		};
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}
