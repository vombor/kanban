export interface SendTerminalInputOptions {
	appendNewline?: boolean;
	mode?: "type" | "paste";
	preferTerminal?: boolean;
}

export type SendTaskSessionInputFn = (
	taskId: string,
	text: string,
	options?: SendTerminalInputOptions,
) => Promise<{ ok: boolean; message?: string }>;

const FOCUS_IN = "\x1b[I";
const SUBMIT_DELAY_MS = 200;

/**
 * Send text to a TUI agent and submit it. Some TUIs (GitHub Copilot) ignore input while the terminal is
 * unfocused, so a focus-in escape goes first as its own write. The text is pasted (bracketed paste, as
 * before for every terminal agent), and Enter follows as a separate write after a short delay so the TUI
 * has processed the paste.
 */
export async function sendTuiInputWithSubmit(
	sendInput: SendTaskSessionInputFn,
	taskId: string,
	text: string,
): Promise<{ ok: boolean; message?: string }> {
	await sendInput(taskId, FOCUS_IN, { appendNewline: false });
	const typed = await sendInput(taskId, text, { appendNewline: false, mode: "paste" });
	if (!typed.ok) {
		return typed;
	}
	await new Promise<void>((resolve) => {
		setTimeout(resolve, SUBMIT_DELAY_MS);
	});
	return sendInput(taskId, "\r", { appendNewline: false });
}
