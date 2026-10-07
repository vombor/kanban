// Reconnect pacing shared by the runtime state stream and the terminal sockets.
export const RECONNECT_BASE_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 5_000;

// Exponential backoff capped at RECONNECT_MAX_DELAY_MS with "equal jitter": half
// of the delay is fixed, half random. A server restart drops every socket of
// every tab at once, and the jitter keeps them from reconnecting in lockstep.
export function getReconnectDelayMs(attempt: number, random: () => number = Math.random): number {
	const exponentialDelay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt));
	const halfDelay = exponentialDelay / 2;
	return Math.round(halfDelay + random() * halfDelay);
}
