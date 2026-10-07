import { describeTerminalWsClose } from "@runtime-terminal-ws-close";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { getTerminalThemeColors, type ThemeTerminalColors } from "@/hooks/use-theme";
import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskSessionSummary,
	RuntimeTerminalWsClientMessage,
	RuntimeTerminalWsServerMessage,
} from "@/runtime/types";
import { type AppliedRestore, shouldSkipWarmRestore } from "@/terminal/restore-generation";
import { splitRestoreSnapshot } from "@/terminal/restore-snapshot-chunks";
import { clearTerminalGeometry, reportTerminalGeometry } from "@/terminal/terminal-geometry-registry";
import { createKanbanTerminalOptions } from "@/terminal/terminal-options";
import {
	appendTerminalHeuristicText,
	hasInterruptAcknowledgement,
	hasLikelyShellPrompt,
} from "@/terminal/terminal-prompt-heuristics";
import {
	type TerminalCloseInfo,
	type TerminalConnectionStatus,
	TerminalReconnectController,
	type TerminalSocketKind,
} from "@/terminal/terminal-reconnect-controller";
import { isMacPlatform } from "@/utils/platform";

const SHIFT_ENTER_SEQUENCE = "\n";
const RESIZE_DEBOUNCE_MS = 50;
const INTERRUPT_IDLE_SETTLE_MS = 250;
const PARKING_ROOT_ID = "kb-persistent-terminal-parking-root";

interface PersistentTerminalAppearance {
	cursorColor: string;
	terminalBackgroundColor: string;
	themeColors?: ThemeTerminalColors;
}

interface PersistentTerminalSubscriber {
	onConnectionReady?: (taskId: string) => void;
	onConnectionStatus?: (status: TerminalConnectionStatus) => void;
	onLastError?: (message: string | null) => void;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onOutputText?: (text: string) => void;
}

interface MountPersistentTerminalOptions {
	autoFocus?: boolean;
	isVisible?: boolean;
}

interface EnsurePersistentTerminalInput extends PersistentTerminalAppearance {
	taskId: string;
	workspaceId: string;
}

function generateTerminalClientId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `terminal-${Math.random().toString(36).slice(2, 10)}`;
}

function getTerminalIoWebSocketUrl(taskId: string, workspaceId: string, clientId: string): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/terminal/io`);
	url.searchParams.set("taskId", taskId);
	url.searchParams.set("workspaceId", workspaceId);
	url.searchParams.set("clientId", clientId);
	return url.toString();
}

function getTerminalControlWebSocketUrl(taskId: string, workspaceId: string, clientId: string): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/terminal/control`);
	url.searchParams.set("taskId", taskId);
	url.searchParams.set("workspaceId", workspaceId);
	url.searchParams.set("clientId", clientId);
	return url.toString();
}

function decodeTerminalSocketChunk(decoder: TextDecoder, data: string | ArrayBuffer | Blob): string {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return decoder.decode(new Uint8Array(data), { stream: true });
	}
	return "";
}

function getTerminalSocketWriteData(data: string | ArrayBuffer | Blob): string | Uint8Array | null {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data);
	}
	return null;
}

function getTerminalSocketChunkByteLength(data: string | ArrayBuffer | Blob): number {
	if (typeof data === "string") {
		return new TextEncoder().encode(data).byteLength;
	}
	if (data instanceof ArrayBuffer) {
		return data.byteLength;
	}
	return 0;
}

function isCopyShortcut(event: KeyboardEvent): boolean {
	return (
		event.type === "keydown" &&
		((isMacPlatform && event.metaKey && !event.shiftKey && event.key.toLowerCase() === "c") ||
			(!isMacPlatform && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "c"))
	);
}

function getParkingRoot(): HTMLDivElement {
	const existingRoot = document.getElementById(PARKING_ROOT_ID);
	if (existingRoot instanceof HTMLDivElement) {
		return existingRoot;
	}
	const root = document.createElement("div");
	root.id = PARKING_ROOT_ID;
	root.setAttribute("aria-hidden", "true");
	Object.assign(root.style, {
		position: "fixed",
		left: "-10000px",
		top: "-10000px",
		width: "1px",
		height: "1px",
		overflow: "hidden",
		opacity: "0",
		pointerEvents: "none",
	});
	document.body.appendChild(root);
	return root;
}

function buildKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}:${taskId}`;
}

class PersistentTerminal {
	private readonly terminal: Terminal;
	private readonly fitAddon = new FitAddon();
	private readonly hostElement: HTMLDivElement;
	private readonly subscribers = new Set<PersistentTerminalSubscriber>();
	private readonly parkingRoot: HTMLDivElement;
	private readonly unicode11Addon = new Unicode11Addon();
	// This identifies one browser viewer, not the PTY session itself.
	// The server uses it to keep per-tab restore and socket state while all tabs
	// still share the same taskId backed PTY.
	private readonly clientId = generateTerminalClientId();
	private appearance: PersistentTerminalAppearance;
	private latestSummary: RuntimeTaskSessionSummary | null = null;
	private lastError: string | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private visibleContainer: HTMLDivElement | null = null;
	private ioSocket: WebSocket | null = null;
	private controlSocket: WebSocket | null = null;
	// Bumped for every stream socket. Writes queued from an older stream
	// must not acknowledge their bytes on the newer control socket.
	private connectionGeneration = 0;
	private readonly reconnect: TerminalReconnectController;
	private connectionReady = false;
	private restoreCompleted = false;
	private outputTextDecoder = new TextDecoder();
	private terminalWriteQueue: Promise<void> = Promise.resolve();
	private lastRestore: AppliedRestore | null = null;
	private disposed = false;

	constructor(
		private readonly taskId: string,
		private readonly workspaceId: string,
		appearance: PersistentTerminalAppearance,
	) {
		this.appearance = appearance;
		this.parkingRoot = getParkingRoot();
		this.hostElement = document.createElement("div");
		Object.assign(this.hostElement.style, {
			width: "100%",
			height: "100%",
		});
		this.parkingRoot.appendChild(this.hostElement);
		const initialGeometry = estimateTaskSessionGeometry(window.innerWidth, window.innerHeight);

		this.terminal = new Terminal({
			...createKanbanTerminalOptions({
				cursorColor: this.appearance.cursorColor,
				isMacPlatform,
				terminalBackgroundColor: this.appearance.terminalBackgroundColor,
				themeColors: this.appearance.themeColors ?? getTerminalThemeColors(),
			}),
			cols: initialGeometry.cols,
			rows: initialGeometry.rows,
		});
		this.terminal.loadAddon(this.fitAddon);
		this.terminal.loadAddon(new ClipboardAddon());
		this.terminal.loadAddon(new WebLinksAddon());
		this.terminal.loadAddon(this.unicode11Addon);
		this.terminal.unicode.activeVersion = "11";
		this.terminal.open(this.hostElement);
		this.terminal.onData((data) => {
			this.sendIoData(data);
		});
		this.terminal.onBinary((data) => {
			const bytes = new Uint8Array(data.length);
			for (let index = 0; index < data.length; index += 1) {
				bytes[index] = data.charCodeAt(index) & 0xff;
			}
			this.sendIoData(bytes);
		});
		this.terminal.attachCustomKeyEventHandler((event) => {
			if (event.key === "Enter" && event.shiftKey) {
				if (event.type === "keydown") {
					this.terminal.input(SHIFT_ENTER_SEQUENCE);
				}
				return false;
			}
			if (isCopyShortcut(event) && this.terminal.hasSelection()) {
				void navigator.clipboard.writeText(this.terminal.getSelection()).catch(() => {
					// Ignore clipboard failures.
				});
				return false;
			}
			return true;
		});

		try {
			const webglAddon = new WebglAddon();
			webglAddon.onContextLoss(() => {
				webglAddon.dispose();
			});
			this.terminal.loadAddon(webglAddon);
		} catch {
			// Fall back to the default renderer when WebGL is unavailable.
		}

		this.reconnect = new TerminalReconnectController({
			connect: () => {
				this.openSockets();
			},
			onStatus: (status) => {
				this.notifyConnectionStatus(status);
			},
		});
		this.setInputEnabled(false);
		this.openSockets();
	}

	private notifyLastError(): void {
		for (const subscriber of this.subscribers) {
			subscriber.onLastError?.(this.lastError);
		}
	}

	private notifySummary(summary: RuntimeTaskSessionSummary): void {
		this.latestSummary = summary;
		for (const subscriber of this.subscribers) {
			subscriber.onSummary?.(summary);
		}
	}

	private notifyOutputText(text: string): void {
		for (const subscriber of this.subscribers) {
			subscriber.onOutputText?.(text);
		}
	}

	private notifyConnectionReady(): void {
		this.connectionReady = true;
		this.reconnect.markConnected();
		for (const subscriber of this.subscribers) {
			subscriber.onConnectionReady?.(this.taskId);
		}
	}

	private notifyConnectionStatus(status: TerminalConnectionStatus): void {
		for (const subscriber of this.subscribers) {
			subscriber.onConnectionStatus?.(status);
		}
	}

	// Typed input is blocked, not queued, while the stream socket is down: keys
	// replayed after a reconnect would land on a screen the user has not seen yet
	// (an Enter confirming a prompt that changed meanwhile). The header shows
	// "reconnecting" so the user knows why keys do nothing.
	private setInputEnabled(enabled: boolean): void {
		this.terminal.options.disableStdin = !enabled;
	}

	private isIoOpen(): boolean {
		return this.ioSocket !== null && this.ioSocket.readyState === WebSocket.OPEN;
	}

	private markReadyIfConnected(): void {
		if (!this.restoreCompleted || !this.isIoOpen()) {
			return;
		}
		if (this.lastError !== null) {
			this.lastError = null;
			this.notifyLastError();
		}
		this.notifyConnectionReady();
	}

	private sendControlMessage(message: RuntimeTerminalWsClientMessage): void {
		if (!this.controlSocket || this.controlSocket.readyState !== WebSocket.OPEN) {
			return;
		}
		this.controlSocket.send(JSON.stringify(message));
	}

	private sendIoData(data: string | Uint8Array): boolean {
		if (!this.ioSocket || !this.isIoOpen()) {
			return false;
		}
		this.ioSocket.send(data);
		return true;
	}

	private enqueueTerminalWrite(
		data: string | Uint8Array,
		options: {
			ackBytes?: number;
			notifyText?: string | null;
		} = {},
	): Promise<void> {
		const ackBytes = options.ackBytes ?? 0;
		const notifyText = options.notifyText ?? null;
		const ackGeneration = this.connectionGeneration;
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(
				async () =>
					await new Promise<void>((resolve) => {
						if (this.disposed) {
							resolve();
							return;
						}
						this.terminal.write(data, () => {
							if (notifyText) {
								this.notifyOutputText(notifyText);
							}
							if (ackBytes > 0 && ackGeneration === this.connectionGeneration) {
								this.sendControlMessage({
									type: "output_ack",
									bytes: ackBytes,
								});
							}
							resolve();
						});
					}),
			);
		return this.terminalWriteQueue;
	}

	private async applyRestore(
		snapshot: string,
		cols: number | null | undefined,
		rows: number | null | undefined,
		restoreGeneration?: number,
	): Promise<void> {
		if (shouldSkipWarmRestore(this.lastRestore, { restoreGeneration, cols, rows })) {
			return;
		}
		await this.terminalWriteQueue.catch(() => undefined);
		this.terminal.reset();
		if (cols && rows && (this.terminal.cols !== cols || this.terminal.rows !== rows)) {
			this.terminal.resize(cols, rows);
		}
		if (snapshot) {
			for (const chunk of splitRestoreSnapshot(snapshot)) {
				await this.enqueueTerminalWrite(chunk);
			}
		}
		this.lastRestore =
			restoreGeneration !== undefined && cols && rows ? { generation: restoreGeneration, cols, rows } : null;
	}

	private requestResize(): void {
		if (!this.visibleContainer) {
			return;
		}
		this.fitAddon.fit();
		const bounds = this.visibleContainer.getBoundingClientRect();
		const pixelWidth = Math.round(bounds.width);
		const pixelHeight = Math.round(bounds.height);
		reportTerminalGeometry(this.taskId, {
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		});
		this.sendControlMessage({
			type: "resize",
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			pixelWidth: pixelWidth > 0 ? pixelWidth : undefined,
			pixelHeight: pixelHeight > 0 ? pixelHeight : undefined,
		});
	}

	private connectIo(): void {
		const ioSocket = new WebSocket(getTerminalIoWebSocketUrl(this.taskId, this.workspaceId, this.clientId));
		ioSocket.binaryType = "arraybuffer";
		ioSocket.addEventListener("message", (event) => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			const writeData = getTerminalSocketWriteData(event.data);
			if (!writeData) {
				return;
			}
			const decoded = decodeTerminalSocketChunk(this.outputTextDecoder, event.data);
			void this.enqueueTerminalWrite(writeData, {
				ackBytes: getTerminalSocketChunkByteLength(event.data),
				notifyText: decoded || null,
			});
		});
		this.ioSocket = ioSocket;
		ioSocket.onopen = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.setInputEnabled(true);
			if (this.restoreCompleted && this.visibleContainer) {
				this.requestResize();
			}
			this.markReadyIfConnected();
		};
		// An error is always followed by a close event, which handles the drop.
		ioSocket.onclose = (event) => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.handleSocketDrop("stream", event);
		};
	}

	private connectControl(): void {
		const controlSocket = new WebSocket(getTerminalControlWebSocketUrl(this.taskId, this.workspaceId, this.clientId));
		this.controlSocket = controlSocket;
		controlSocket.onmessage = (event) => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			let payload: RuntimeTerminalWsServerMessage;
			try {
				payload = JSON.parse(String(event.data)) as RuntimeTerminalWsServerMessage;
			} catch {
				// Ignore malformed control frames.
				return;
			}

			if (payload.type === "restore") {
				this.restoreCompleted = false;
				void this.applyRestore(payload.snapshot, payload.cols, payload.rows, payload.restoreGeneration)
					.then(() => {
						if (this.disposed || this.controlSocket !== controlSocket) {
							return;
						}
						this.restoreCompleted = true;
						this.sendControlMessage({ type: "restore_complete" });
						if (this.isIoOpen() && this.visibleContainer) {
							this.requestResize();
						}
						this.markReadyIfConnected();
					})
					.catch(() => {
						if (this.disposed || this.controlSocket !== controlSocket) {
							return;
						}
						this.lastError = "Terminal restore failed.";
						this.notifyLastError();
					});
				return;
			}
			if (payload.type === "state") {
				this.notifySummary(payload.summary);
				return;
			}
			if (payload.type === "exit") {
				const label = payload.code == null ? "session exited" : `session exited with code ${payload.code}`;
				void this.enqueueTerminalWrite(`\r\n[kanban] ${label}\r\n`);
				return;
			}
			if (payload.type === "error") {
				this.lastError = payload.message;
				this.notifyLastError();
				void this.enqueueTerminalWrite(`\r\n[kanban] ${payload.message}\r\n`);
			}
		};
		controlSocket.onclose = (event) => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.handleSocketDrop("control", event);
		};
	}

	// A dropped stream socket ends the whole connection: output printed while it
	// was down never reached this viewer, so the control socket is closed too and
	// both reconnect into a fresh restore. That restore must be applied even when
	// its generation and size match the last one (applyRestore resets first, so
	// nothing is duplicated). A dropped control socket alone reconnects by itself:
	// the server holds this viewer's output until the new restore completes, so
	// the warm restore may skip the reset.
	private handleSocketDrop(socket: TerminalSocketKind, event: CloseEvent): void {
		const close: TerminalCloseInfo = {
			socket,
			code: event.code,
			reason: event.reason,
			description: describeTerminalWsClose(event.code, event.reason),
			at: Date.now(),
		};
		console.warn(
			`[kanban][terminal] ${socket} socket closed for ${this.taskId} (code ${close.code}): ${close.description}`,
		);
		if (socket === "stream") {
			this.closeSockets();
			this.lastRestore = null;
		} else {
			this.closeSocket("control");
		}
		this.reconnect.handleDrop(close);
	}

	private closeSockets(): void {
		this.closeSocket("stream");
		this.closeSocket("control");
	}

	private closeSocket(kind: TerminalSocketKind): void {
		const socket = kind === "stream" ? this.ioSocket : this.controlSocket;
		// Clear the reference first: the socket's own handlers then see it is stale
		// and ignore its close event.
		if (kind === "stream") {
			this.ioSocket = null;
			this.outputTextDecoder = new TextDecoder();
			this.setInputEnabled(false);
		} else {
			this.controlSocket = null;
		}
		this.connectionReady = false;
		this.restoreCompleted = false;
		if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
			socket.close();
		}
	}

	// Opens whichever socket is missing; a stream reconnect starts a new
	// connection generation for output acks.
	private openSockets(): void {
		if (this.disposed) {
			return;
		}
		if (!this.ioSocket) {
			this.connectionGeneration += 1;
			this.connectIo();
		}
		if (!this.controlSocket) {
			this.connectControl();
		}
	}

	// A remount (the user opens the terminal again) retries a terminal that gave up.
	private ensureConnected(): void {
		if (this.disposed) {
			return;
		}
		if (this.reconnect.isDisconnected()) {
			this.reconnect.retryNow();
		}
	}

	private updateAppearance(appearance: PersistentTerminalAppearance): void {
		this.appearance = appearance;
		this.terminal.options.theme = {
			...this.terminal.options.theme,
			...createKanbanTerminalOptions({
				cursorColor: appearance.cursorColor,
				isMacPlatform,
				terminalBackgroundColor: appearance.terminalBackgroundColor,
				themeColors: appearance.themeColors ?? getTerminalThemeColors(),
			}).theme,
		};
	}

	setAppearance(appearance: PersistentTerminalAppearance): void {
		this.updateAppearance(appearance);
	}

	subscribe(subscriber: PersistentTerminalSubscriber): () => void {
		this.subscribers.add(subscriber);
		subscriber.onLastError?.(this.lastError);
		subscriber.onConnectionStatus?.(this.reconnect.getStatus());
		if (this.latestSummary) {
			subscriber.onSummary?.(this.latestSummary);
		}
		if (this.connectionReady) {
			subscriber.onConnectionReady?.(this.taskId);
		}
		return () => {
			this.subscribers.delete(subscriber);
		};
	}

	mount(
		container: HTMLDivElement,
		appearance: PersistentTerminalAppearance,
		options: MountPersistentTerminalOptions,
	): void {
		if (this.disposed) {
			return;
		}
		this.ensureConnected();
		this.updateAppearance(appearance);
		if (this.visibleContainer !== container) {
			this.visibleContainer = container;
			container.appendChild(this.hostElement);
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
		}
		this.resizeObserver = new ResizeObserver(() => {
			if (this.resizeTimer !== null) {
				clearTimeout(this.resizeTimer);
			}
			this.resizeTimer = setTimeout(() => {
				this.resizeTimer = null;
				this.requestResize();
			}, RESIZE_DEBOUNCE_MS);
		});
		this.resizeObserver.observe(container);
		if (options.isVisible !== false) {
			window.requestAnimationFrame(() => {
				this.requestResize();
				if (options.autoFocus) {
					this.terminal.focus();
				}
			});
		}
	}

	unmount(container: HTMLDivElement | null): void {
		if (this.disposed && this.visibleContainer === null) {
			return;
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.resizeTimer !== null) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		if (container && this.visibleContainer !== container) {
			return;
		}
		this.visibleContainer = null;
		clearTerminalGeometry(this.taskId);
		this.parkingRoot.appendChild(this.hostElement);
	}

	focus(): void {
		this.terminal.focus();
	}

	retryConnection(): void {
		this.reconnect.retryNow();
	}

	input(text: string): boolean {
		if (!this.isIoOpen()) {
			return false;
		}
		this.terminal.input(text);
		return true;
	}

	paste(text: string): boolean {
		if (!this.isIoOpen()) {
			return false;
		}
		this.terminal.paste(text);
		return true;
	}

	clear(): void {
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(() => {
				if (this.disposed) {
					return;
				}
				this.terminal.clear();
			});
	}

	reset(): void {
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(() => {
				if (this.disposed) {
					return;
				}
				this.terminal.reset();
			});
	}

	waitForLikelyPrompt(timeoutMs: number): Promise<boolean> {
		if (timeoutMs <= 0) {
			return Promise.resolve(false);
		}

		return new Promise((resolve) => {
			let buffer = "";
			let sawInterruptAcknowledgement = false;
			let settled = false;
			let idleTimer: number | null = null;

			const cleanup = (result: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				window.clearTimeout(timeoutId);
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				unsubscribe();
				resolve(result);
			};

			const scheduleIdleCompletion = () => {
				if (!sawInterruptAcknowledgement) {
					return;
				}
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				idleTimer = window.setTimeout(() => {
					cleanup(true);
				}, INTERRUPT_IDLE_SETTLE_MS);
			};

			const unsubscribe = this.subscribe({
				onOutputText: (text) => {
					buffer = appendTerminalHeuristicText(buffer, text);
					if (hasLikelyShellPrompt(buffer)) {
						cleanup(true);
						return;
					}
					if (hasInterruptAcknowledgement(buffer)) {
						sawInterruptAcknowledgement = true;
					}
					scheduleIdleCompletion();
				},
			});

			const timeoutId = window.setTimeout(() => {
				cleanup(false);
			}, timeoutMs);
		});
	}

	async stop(): Promise<void> {
		this.sendControlMessage({ type: "stop" });
		const trpcClient = getRuntimeTrpcClient(this.workspaceId);
		await trpcClient.runtime.stopTaskSession.mutate({ taskId: this.taskId });
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.reconnect.dispose();
		this.unmount(this.visibleContainer);
		this.closeSockets();
		this.subscribers.clear();
		this.lastRestore = null;
		this.terminal.dispose();
		this.hostElement.remove();
	}
}

const terminals = new Map<string, PersistentTerminal>();

export function ensurePersistentTerminal(input: EnsurePersistentTerminalInput): PersistentTerminal {
	const key = buildKey(input.workspaceId, input.taskId);
	let terminal = terminals.get(key);
	if (!terminal) {
		terminal = new PersistentTerminal(input.taskId, input.workspaceId, {
			cursorColor: input.cursorColor,
			terminalBackgroundColor: input.terminalBackgroundColor,
			themeColors: input.themeColors,
		});
		terminals.set(key, terminal);
		return terminal;
	}
	terminal.setAppearance({
		cursorColor: input.cursorColor,
		terminalBackgroundColor: input.terminalBackgroundColor,
		themeColors: input.themeColors,
	});
	return terminal;
}

export function disposePersistentTerminal(workspaceId: string, taskId: string): void {
	const key = buildKey(workspaceId, taskId);
	const terminal = terminals.get(key);
	if (!terminal) {
		return;
	}
	terminal.dispose();
	terminals.delete(key);
}

export function disposeAllPersistentTerminalsForWorkspace(workspaceId: string): void {
	for (const [key, terminal] of terminals.entries()) {
		if (!key.startsWith(`${workspaceId}:`)) {
			continue;
		}
		terminal.dispose();
		terminals.delete(key);
	}
}
