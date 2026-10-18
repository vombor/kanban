export interface SendTerminalInputOptions {
	appendNewline?: boolean;
	mode?: "type" | "paste";
	preferTerminal?: boolean;
	/** Browser-generated model prompt: ordinary server delivery/admission owns paste, focus and Enter. */
	verifiedSubmit?: boolean;
}

export type SendTaskSessionInputFn = (
	taskId: string,
	text: string,
	options?: SendTerminalInputOptions,
) => Promise<{ ok: boolean; message?: string }>;

/**
 * Submit a browser-generated agent prompt through the runtime's verified delivery and admission owner.
 * Focus, paste boundaries, Enter timing and proof of delivery follow the shared installed-agent profile,
 * rather than bypassing controls as viewer WebSocket keystrokes.
 */
export async function sendTuiInputWithSubmit(
	sendInput: SendTaskSessionInputFn,
	taskId: string,
	text: string,
): Promise<{ ok: boolean; message?: string }> {
	return sendInput(taskId, text, { verifiedSubmit: true, preferTerminal: false });
}
