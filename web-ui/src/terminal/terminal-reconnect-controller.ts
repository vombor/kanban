import { getReconnectDelayMs } from "@/runtime/reconnect-backoff";

// After this many failed attempts in a row the terminal shows "disconnected"
// with a retry button instead of retrying forever. With the shared backoff cap
// that is roughly half a minute of trying. A visible tab, a network that comes
// back or the retry button starts a new round.
export const TERMINAL_RECONNECT_MAX_ATTEMPTS = 8;

export type TerminalSocketKind = "stream" | "control";

export interface TerminalCloseInfo {
	socket: TerminalSocketKind;
	code: number;
	reason: string;
	description: string;
	at: number;
}

export type TerminalReconnectWait = "visibility" | "network";

export type TerminalConnectionStatus =
	| { state: "connecting"; lastClose: TerminalCloseInfo | null }
	| { state: "connected"; lastClose: TerminalCloseInfo | null }
	| {
			state: "reconnecting";
			attempt: number;
			waitingFor: TerminalReconnectWait | null;
			lastClose: TerminalCloseInfo | null;
	  }
	| { state: "disconnected"; lastClose: TerminalCloseInfo | null };

interface TerminalReconnectControllerOptions {
	// Opens fresh sockets. A failed attempt comes back through handleDrop().
	connect: () => void;
	onStatus: (status: TerminalConnectionStatus) => void;
	maxAttempts?: number;
	random?: () => number;
}

function isDocumentHidden(): boolean {
	return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function isNetworkOffline(): boolean {
	return typeof navigator !== "undefined" && navigator.onLine === false;
}

// Decides when a dropped terminal reconnects. The terminal owns the sockets and
// reports drops and successful connects; this class owns backoff, attempt
// counting and the waits.
//
// A hidden tab never reconnects in the background: the server drops viewers that
// stop acknowledging output (ack stall), and a backgrounded tab would just be
// dropped again, over and over. It reconnects as soon as the tab is visible.
export class TerminalReconnectController {
	private readonly maxAttempts: number;
	private readonly random: () => number;
	private attempt = 0;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private status: TerminalConnectionStatus = { state: "connecting", lastClose: null };
	private lastClose: TerminalCloseInfo | null = null;
	private disposed = false;

	constructor(private readonly options: TerminalReconnectControllerOptions) {
		this.maxAttempts = options.maxAttempts ?? TERMINAL_RECONNECT_MAX_ATTEMPTS;
		this.random = options.random ?? Math.random;
		document.addEventListener("visibilitychange", this.handleVisibilityChange);
		window.addEventListener("online", this.handleOnline);
	}

	getStatus(): TerminalConnectionStatus {
		return this.status;
	}

	markConnected(): void {
		if (this.disposed) {
			return;
		}
		this.attempt = 0;
		this.setStatus({ state: "connected", lastClose: this.lastClose });
	}

	handleDrop(close: TerminalCloseInfo): void {
		if (this.disposed) {
			return;
		}
		this.lastClose = close;
		this.scheduleAttempt();
	}

	// The retry button and a remount: try now, even if the browser reports offline.
	retryNow(): void {
		if (this.disposed || this.status.state === "connected") {
			return;
		}
		this.clearRetryTimer();
		this.attempt = 0;
		this.startAttempt();
	}

	isDisconnected(): boolean {
		return this.status.state === "disconnected";
	}

	dispose(): void {
		this.disposed = true;
		this.clearRetryTimer();
		document.removeEventListener("visibilitychange", this.handleVisibilityChange);
		window.removeEventListener("online", this.handleOnline);
	}

	private readonly handleVisibilityChange = (): void => {
		if (!isDocumentHidden()) {
			this.reconnectIfWaiting();
		}
	};

	private readonly handleOnline = (): void => {
		this.reconnectIfWaiting();
	};

	// Skips the remaining backoff (or the wait) when the reason for waiting is
	// gone. An attempt that is already in flight is left alone.
	private reconnectIfWaiting(): void {
		if (this.disposed) {
			return;
		}
		const status = this.status;
		const isWaiting =
			status.state === "disconnected" ||
			(status.state === "reconnecting" && (status.waitingFor !== null || this.retryTimer !== null));
		if (!isWaiting) {
			return;
		}
		this.clearRetryTimer();
		this.attempt = 0;
		this.scheduleAttempt({ immediate: true });
	}

	private scheduleAttempt({ immediate = false }: { immediate?: boolean } = {}): void {
		if (this.retryTimer !== null) {
			return;
		}
		if (isDocumentHidden()) {
			this.setWaiting("visibility");
			return;
		}
		if (isNetworkOffline()) {
			this.setWaiting("network");
			return;
		}
		if (this.attempt >= this.maxAttempts) {
			this.setStatus({ state: "disconnected", lastClose: this.lastClose });
			return;
		}
		if (immediate) {
			this.startAttempt();
			return;
		}
		const delayMs = getReconnectDelayMs(this.attempt, this.random);
		this.attempt += 1;
		this.setStatus({ state: "reconnecting", attempt: this.attempt, waitingFor: null, lastClose: this.lastClose });
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			if (!this.disposed) {
				this.options.connect();
			}
		}, delayMs);
	}

	private startAttempt(): void {
		this.attempt += 1;
		this.setStatus({ state: "reconnecting", attempt: this.attempt, waitingFor: null, lastClose: this.lastClose });
		this.options.connect();
	}

	private setWaiting(waitingFor: TerminalReconnectWait): void {
		this.setStatus({
			state: "reconnecting",
			attempt: this.attempt,
			waitingFor,
			lastClose: this.lastClose,
		});
	}

	private clearRetryTimer(): void {
		if (this.retryTimer !== null) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
	}

	private setStatus(status: TerminalConnectionStatus): void {
		this.status = status;
		this.options.onStatus(status);
	}
}
