// Close codes the terminal websocket server sends when it drops a viewer on
// purpose. The browser shows them in the terminal's connection status so a user
// can tell a flaky network (heartbeat) from the background-tab rule (ack stall).
// 4000-4999 is the application range of RFC 6455.
export const TERMINAL_WS_CLOSE_HEARTBEAT_TIMEOUT = 4001;
export const TERMINAL_WS_CLOSE_ACK_STALL = 4002;
export const TERMINAL_WS_CLOSE_RESTORE_LIMIT = 4003;

export const TERMINAL_WS_CLOSE_REASONS = {
	[TERMINAL_WS_CLOSE_HEARTBEAT_TIMEOUT]: "Heartbeat timeout: no pong from the browser.",
	[TERMINAL_WS_CLOSE_ACK_STALL]: "Output not acknowledged while the terminal was paused (tab in background?).",
	[TERMINAL_WS_CLOSE_RESTORE_LIMIT]: "Terminal could not finish restoring after repeated attempts.",
} as const;

export type TerminalWsCloseCode = keyof typeof TERMINAL_WS_CLOSE_REASONS;

// Abnormal closure: the browser reports this when the connection died without a
// close frame (network loss, a terminated socket, a server restart).
const WS_CLOSE_ABNORMAL = 1006;

export function describeTerminalWsClose(code: number, reason: string): string {
	const trimmedReason = reason.trim();
	if (trimmedReason) {
		return trimmedReason;
	}
	if (code in TERMINAL_WS_CLOSE_REASONS) {
		return TERMINAL_WS_CLOSE_REASONS[code as TerminalWsCloseCode];
	}
	if (code === WS_CLOSE_ABNORMAL) {
		return "Connection lost (network or server unreachable).";
	}
	return `Connection closed (code ${code}).`;
}
