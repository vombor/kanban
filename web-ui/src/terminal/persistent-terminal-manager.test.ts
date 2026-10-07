import {
	TERMINAL_WS_CLOSE_ACK_STALL,
	TERMINAL_WS_CLOSE_HEARTBEAT_TIMEOUT,
	TERMINAL_WS_CLOSE_REASONS,
} from "@runtime-terminal-ws-close";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { disposePersistentTerminal, ensurePersistentTerminal } from "@/terminal/persistent-terminal-manager";
import {
	TERMINAL_RECONNECT_MAX_ATTEMPTS,
	type TerminalConnectionStatus,
} from "@/terminal/terminal-reconnect-controller";

const fakeTerminals = vi.hoisted(() => {
	class FakeTerminal {
		static instances: FakeTerminal[] = [];
		options: Record<string, unknown>;
		cols: number;
		rows: number;
		// What the screen shows: everything written since the last reset.
		screen = "";
		resetCount = 0;
		// When set, write callbacks wait for releaseWrites(), like a busy renderer.
		deferWrites = false;
		unicode = { activeVersion: "" };
		private deferredCallbacks: Array<() => void> = [];
		private readonly dataListeners: Array<(data: string) => void> = [];

		constructor(options: Record<string, unknown>) {
			this.options = { ...options };
			this.cols = Number(options.cols ?? 80);
			this.rows = Number(options.rows ?? 24);
			FakeTerminal.instances.push(this);
		}

		loadAddon(): void {}
		open(): void {}
		attachCustomKeyEventHandler(): void {}
		onBinary(): { dispose: () => void } {
			return { dispose: () => {} };
		}
		onData(listener: (data: string) => void): { dispose: () => void } {
			this.dataListeners.push(listener);
			return { dispose: () => {} };
		}
		write(data: string | Uint8Array, callback?: () => void): void {
			this.screen += typeof data === "string" ? data : new TextDecoder().decode(data);
			if (this.deferWrites) {
				this.deferredCallbacks.push(() => callback?.());
				return;
			}
			callback?.();
		}
		releaseWrites(): void {
			this.deferWrites = false;
			const callbacks = this.deferredCallbacks;
			this.deferredCallbacks = [];
			for (const callback of callbacks) {
				callback();
			}
		}
		reset(): void {
			this.resetCount += 1;
			this.screen = "";
		}
		resize(cols: number, rows: number): void {
			this.cols = cols;
			this.rows = rows;
		}
		// Like xterm: a keystroke (or input()) only reaches onData while stdin is enabled.
		input(data: string): void {
			if (this.options.disableStdin === true) {
				return;
			}
			for (const listener of this.dataListeners) {
				listener(data);
			}
		}
		paste(data: string): void {
			this.input(data);
		}
		hasSelection(): boolean {
			return false;
		}
		getSelection(): string {
			return "";
		}
		focus(): void {}
		clear(): void {}
		dispose(): void {}
	}
	return { FakeTerminal };
});

vi.mock("@xterm/xterm", () => ({ Terminal: fakeTerminals.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit(): void {}
	},
}));
vi.mock("@xterm/addon-clipboard", () => ({ ClipboardAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({
	WebglAddon: class {
		onContextLoss(): void {}
		dispose(): void {}
	},
}));
vi.mock("@/runtime/trpc-client", () => ({ getRuntimeTrpcClient: vi.fn() }));

interface FakeCloseEvent {
	code: number;
	reason: string;
}

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readyState = FakeWebSocket.CONNECTING;
	binaryType = "blob";
	readonly sent: Array<string | Uint8Array> = [];
	onopen: ((event: Event) => void) | null = null;
	onclose: ((event: FakeCloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	private readonly messageListeners: Array<(event: { data: unknown }) => void> = [];

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	get kind(): "stream" | "control" {
		return this.url.includes("/api/terminal/io") ? "stream" : "control";
	}

	addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
		if (type === "message") {
			this.messageListeners.push(listener);
		}
	}

	send(data: string | Uint8Array): void {
		this.sent.push(data);
	}

	close(code = 1000, reason = ""): void {
		if (this.readyState === FakeWebSocket.CLOSED) {
			return;
		}
		this.readyState = FakeWebSocket.CLOSED;
		queueMicrotask(() => {
			this.onclose?.({ code, reason });
		});
	}

	serverOpen(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	serverSend(data: string | ArrayBuffer): void {
		const event = { data };
		this.onmessage?.(event);
		for (const listener of this.messageListeners) {
			listener(event);
		}
	}

	serverClose(code: number, reason = ""): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}

	controlMessages(): Array<{ type: string }> {
		return this.sent.filter((data): data is string => typeof data === "string").map((data) => JSON.parse(data));
	}
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 30; index += 1) {
		await Promise.resolve();
	}
}

function socketsOf(kind: "stream" | "control"): FakeWebSocket[] {
	return FakeWebSocket.instances.filter((socket) => socket.kind === kind);
}

function latestSocket(kind: "stream" | "control"): FakeWebSocket {
	const sockets = socketsOf(kind);
	const socket = sockets[sockets.length - 1];
	if (!socket) {
		throw new Error(`No ${kind} socket was opened.`);
	}
	return socket;
}

function latestTerminal(): InstanceType<typeof fakeTerminals.FakeTerminal> {
	const terminal = fakeTerminals.FakeTerminal.instances[fakeTerminals.FakeTerminal.instances.length - 1];
	if (!terminal) {
		throw new Error("No terminal was created.");
	}
	return terminal;
}

function encode(text: string): ArrayBuffer {
	// Built from the global ArrayBuffer: TextEncoder's buffer can come from
	// another realm under jsdom and then fails the manager's instanceof check.
	const bytes = new TextEncoder().encode(text);
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

async function completeConnection({
	snapshot,
	restoreGeneration = 1,
	openStream = true,
}: {
	snapshot: string;
	restoreGeneration?: number;
	openStream?: boolean;
}): Promise<void> {
	if (openStream) {
		latestSocket("stream").serverOpen();
	}
	const control = latestSocket("control");
	control.serverOpen();
	control.serverSend(JSON.stringify({ type: "restore", snapshot, cols: 80, rows: 24, restoreGeneration }));
	await flushMicrotasks();
}

let visibilityState: DocumentVisibilityState = "visible";
let online = true;
let nextTaskNumber = 0;

describe("persistent terminal reconnect", () => {
	const workspaceId = "workspace-1";
	let taskId: string;
	let statuses: TerminalConnectionStatus[];
	let warnSpy: ReturnType<typeof vi.spyOn>;

	function createTerminal() {
		const terminal = ensurePersistentTerminal({
			taskId,
			workspaceId,
			cursorColor: "#fff",
			terminalBackgroundColor: "#000",
		});
		terminal.subscribe({
			onConnectionStatus: (status) => {
				statuses.push(status);
			},
		});
		return terminal;
	}

	function latestStatus(): TerminalConnectionStatus | undefined {
		return statuses[statuses.length - 1];
	}

	beforeEach(() => {
		vi.useFakeTimers();
		nextTaskNumber += 1;
		taskId = `task-${nextTaskNumber}`;
		statuses = [];
		FakeWebSocket.instances = [];
		fakeTerminals.FakeTerminal.instances = [];
		visibilityState = "visible";
		online = true;
		vi.stubGlobal("WebSocket", FakeWebSocket);
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibilityState });
		Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
		// No jitter: every delay is exactly half of the exponential step.
		vi.spyOn(Math, "random").mockReturnValue(0);
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		disposePersistentTerminal(workspaceId, taskId);
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("reconnects with backoff after the stream drops and restores the current screen once", async () => {
		createTerminal();
		await completeConnection({ snapshot: "hello " });
		expect(latestStatus()).toMatchObject({ state: "connected" });

		latestSocket("stream").serverSend(encode("world"));
		await flushMicrotasks();
		const terminal = latestTerminal();
		expect(terminal.screen).toBe("hello world");

		const firstControl = latestSocket("control");
		latestSocket("stream").serverClose(
			TERMINAL_WS_CLOSE_HEARTBEAT_TIMEOUT,
			TERMINAL_WS_CLOSE_REASONS[TERMINAL_WS_CLOSE_HEARTBEAT_TIMEOUT],
		);
		// The control socket goes down with the stream so both reconnect together.
		expect(firstControl.readyState).toBe(FakeWebSocket.CLOSED);
		expect(latestStatus()).toMatchObject({ state: "reconnecting", attempt: 1, waitingFor: null });

		// First retry after half of the 500 ms base step.
		await vi.advanceTimersByTimeAsync(249);
		expect(FakeWebSocket.instances).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(socketsOf("stream")).toHaveLength(2);
		expect(socketsOf("control")).toHaveLength(2);

		// That attempt fails before opening: the next one waits twice as long.
		latestSocket("stream").serverClose(1006);
		expect(latestStatus()).toMatchObject({ state: "reconnecting", attempt: 2 });
		await vi.advanceTimersByTimeAsync(499);
		expect(socketsOf("stream")).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(socketsOf("stream")).toHaveLength(3);

		// Output printed while disconnected is in the server's snapshot. The same
		// session generation must still be applied (reset + rewrite), so the
		// screen is the snapshot exactly: nothing lost, nothing doubled.
		const resetsBefore = terminal.resetCount;
		await completeConnection({ snapshot: "hello world, more output" });
		expect(terminal.resetCount).toBe(resetsBefore + 1);
		expect(terminal.screen).toBe("hello world, more output");
		expect(latestSocket("control").controlMessages()).toContainEqual({ type: "restore_complete" });
		expect(latestStatus()).toMatchObject({
			state: "connected",
			lastClose: { socket: "stream", code: 1006 },
		});
	});

	it("reconnects only the control socket and keeps the warm restore when the stream stays up", async () => {
		createTerminal();
		await completeConnection({ snapshot: "screen" });
		const terminal = latestTerminal();
		const stream = latestSocket("stream");

		latestSocket("control").serverClose(1006);
		expect(stream.readyState).toBe(FakeWebSocket.OPEN);
		await vi.advanceTimersByTimeAsync(250);
		expect(socketsOf("stream")).toHaveLength(1);
		expect(socketsOf("control")).toHaveLength(2);

		const resetsBefore = terminal.resetCount;
		await completeConnection({ snapshot: "screen", openStream: false });
		expect(terminal.resetCount).toBe(resetsBefore);
		expect(latestSocket("control").controlMessages()).toContainEqual({ type: "restore_complete" });
		expect(latestStatus()).toMatchObject({ state: "connected" });
	});

	it("waits for the tab to become visible instead of reconnecting in the background", async () => {
		createTerminal();
		await completeConnection({ snapshot: "" });

		visibilityState = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		latestSocket("stream").serverClose(
			TERMINAL_WS_CLOSE_ACK_STALL,
			TERMINAL_WS_CLOSE_REASONS[TERMINAL_WS_CLOSE_ACK_STALL],
		);
		expect(latestStatus()).toMatchObject({ state: "reconnecting", waitingFor: "visibility" });

		await vi.advanceTimersByTimeAsync(120_000);
		expect(socketsOf("stream")).toHaveLength(1);

		visibilityState = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		// Immediately, without waiting for a backoff step.
		expect(socketsOf("stream")).toHaveLength(2);
		expect(socketsOf("control")).toHaveLength(2);
		await completeConnection({ snapshot: "" });
		expect(latestStatus()).toMatchObject({ state: "connected" });
	});

	it("waits for the network and reconnects as soon as it is back", async () => {
		createTerminal();
		await completeConnection({ snapshot: "" });

		online = false;
		latestSocket("stream").serverClose(1006);
		expect(latestStatus()).toMatchObject({ state: "reconnecting", waitingFor: "network" });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(socketsOf("stream")).toHaveLength(1);

		online = true;
		window.dispatchEvent(new Event("online"));
		expect(socketsOf("stream")).toHaveLength(2);
	});

	it("skips the remaining backoff when the tab becomes visible during it", async () => {
		createTerminal();
		await completeConnection({ snapshot: "" });
		latestSocket("stream").serverClose(1006);
		expect(socketsOf("stream")).toHaveLength(1);

		document.dispatchEvent(new Event("visibilitychange"));
		expect(socketsOf("stream")).toHaveLength(2);
		// The pending timer was cleared: no extra attempt fires later.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(socketsOf("stream")).toHaveLength(2);
	});

	it("blocks typed input while the stream is down instead of queueing it", async () => {
		const persistentTerminal = createTerminal();
		await completeConnection({ snapshot: "" });
		const terminal = latestTerminal();
		const firstStream = latestSocket("stream");

		terminal.input("a");
		expect(firstStream.sent).toEqual(["a"]);

		firstStream.serverClose(1006);
		expect(terminal.options.disableStdin).toBe(true);
		terminal.input("b");
		expect(persistentTerminal.input("typed by a shortcut")).toBe(false);
		expect(persistentTerminal.paste("pasted")).toBe(false);

		await vi.advanceTimersByTimeAsync(250);
		await completeConnection({ snapshot: "" });
		expect(terminal.options.disableStdin).toBe(false);
		terminal.input("c");
		// "b" was never sent anywhere, not even after the reconnect.
		expect(latestSocket("stream").sent).toEqual(["c"]);
		expect(firstStream.sent).toEqual(["a"]);
	});

	it("gives up after the attempt limit and reconnects from the retry button", async () => {
		const persistentTerminal = createTerminal();
		await completeConnection({ snapshot: "" });

		latestSocket("stream").serverClose(1006);
		for (let attempt = 1; attempt <= TERMINAL_RECONNECT_MAX_ATTEMPTS; attempt += 1) {
			await vi.advanceTimersByTimeAsync(5_000);
			latestSocket("stream").serverClose(1006);
		}
		expect(latestStatus()).toMatchObject({ state: "disconnected" });
		const socketCount = FakeWebSocket.instances.length;
		await vi.advanceTimersByTimeAsync(120_000);
		expect(FakeWebSocket.instances).toHaveLength(socketCount);

		persistentTerminal.retryConnection();
		expect(FakeWebSocket.instances).toHaveLength(socketCount + 2);
		expect(latestStatus()).toMatchObject({ state: "reconnecting", attempt: 1 });
		await completeConnection({ snapshot: "" });
		expect(latestStatus()).toMatchObject({ state: "connected" });
	});

	it("logs the server's close code and reason and keeps them for the status tooltip", async () => {
		createTerminal();
		await completeConnection({ snapshot: "" });

		const reason = TERMINAL_WS_CLOSE_REASONS[TERMINAL_WS_CLOSE_ACK_STALL];
		latestSocket("stream").serverClose(TERMINAL_WS_CLOSE_ACK_STALL, reason);

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`(code ${TERMINAL_WS_CLOSE_ACK_STALL}): ${reason}`));
		expect(latestStatus()).toMatchObject({
			lastClose: { socket: "stream", code: TERMINAL_WS_CLOSE_ACK_STALL, reason, description: reason },
		});
	});

	it("does not acknowledge output from a dropped stream on the new control socket", async () => {
		createTerminal();
		await completeConnection({ snapshot: "" });
		const terminal = latestTerminal();

		// The renderer is still busy with output from the old stream when it drops.
		terminal.deferWrites = true;
		latestSocket("stream").serverSend(encode("before"));
		latestSocket("stream").serverClose(1006);
		await vi.advanceTimersByTimeAsync(250);
		latestSocket("stream").serverOpen();
		latestSocket("control").serverOpen();
		terminal.releaseWrites();
		await flushMicrotasks();

		latestSocket("control").serverSend(
			JSON.stringify({ type: "restore", snapshot: "", cols: 80, rows: 24, restoreGeneration: 1 }),
		);
		await flushMicrotasks();
		latestSocket("stream").serverSend(encode("after!!"));
		await flushMicrotasks();
		const acks = latestSocket("control")
			.controlMessages()
			.filter((message) => message.type === "output_ack");
		// The new server viewer never sent the old 6 bytes; only its own are acked.
		expect(acks).toEqual([{ type: "output_ack", bytes: 7 }]);
	});
});
