import type * as SerializeAddonTypes from "@xterm/addon-serialize";
import serializeAddonModule from "@xterm/addon-serialize";
import type * as HeadlessTerminalTypes from "@xterm/headless";
import headlessTerminalModule from "@xterm/headless";

import { TERMINAL_RESTORE_MAX_BYTES, TERMINAL_RESTORE_SCROLLBACK } from "../core/terminal-history";

const { SerializeAddon } = serializeAddonModule as typeof SerializeAddonTypes;
const { Terminal } = headlessTerminalModule as typeof HeadlessTerminalTypes;

/**
 * Server-side headless terminal buffer cap (1,000 lines).
 *
 * Restore serves a cached byte-bounded recent tail of this buffer, not its complete history.
 * Output and resize mark the cache dirty; connect does not serialize on every
 * keystroke. A 10,000-line buffer caused ~60s main-thread freezes (#581)
 * and RSS spikes toward OOM (#273) during long agent runs.
 */
const TERMINAL_SCROLLBACK = 1_000;

export interface TerminalRestoreSnapshot {
	snapshot: string;
	cols: number;
	rows: number;
	restoreGeneration?: number;
}

interface TerminalStateMirrorOptions {
	onInputResponse?: (data: string) => void;
}

export class TerminalStateMirror {
	private readonly terminal: InstanceType<typeof Terminal>;
	private readonly serializeAddon = new SerializeAddon();
	private operationQueue: Promise<void> = Promise.resolve();
	private snapshotDirty = true;
	private cachedSnapshot: TerminalRestoreSnapshot | null = null;

	constructor(cols: number, rows: number, options: TerminalStateMirrorOptions = {}) {
		this.terminal = new Terminal({
			allowProposedApi: true,
			cols: Math.min(500, Math.max(1, Math.floor(cols))),
			rows: Math.min(200, Math.max(1, Math.floor(rows))),
			scrollback: TERMINAL_SCROLLBACK,
		});
		this.terminal.loadAddon(this.serializeAddon);
		this.terminal.onData((data) => {
			options.onInputResponse?.(data);
		});
	}

	applyOutput(chunk: Buffer): void {
		const chunkCopy = new Uint8Array(chunk);
		this.enqueueOperation(
			() =>
				new Promise<void>((resolve) => {
					this.terminal.write(chunkCopy, () => {
						this.snapshotDirty = true;
						resolve();
					});
				}),
		);
	}

	resize(cols: number, rows: number): void {
		cols = Math.min(500, Math.max(1, Math.floor(cols)));
		rows = Math.min(200, Math.max(1, Math.floor(rows)));
		if (cols === this.terminal.cols && rows === this.terminal.rows) {
			return;
		}
		this.enqueueOperation(() => {
			this.terminal.resize(cols, rows);
			this.snapshotDirty = true;
		});
	}

	async getSnapshot(): Promise<TerminalRestoreSnapshot> {
		await this.operationQueue;
		if (!this.snapshotDirty && this.cachedSnapshot) {
			return this.cachedSnapshot;
		}
		// Serialize a recent tail first, not all retained rows. Reduce only display history until it fits the wire budget.
		let scrollback = TERMINAL_RESTORE_SCROLLBACK;
		let snapshot = this.serializeAddon.serialize({ scrollback });
		while (Buffer.byteLength(snapshot, "utf8") > TERMINAL_RESTORE_MAX_BYTES && scrollback > 0) {
			scrollback = Math.floor(scrollback / 2);
			snapshot = this.serializeAddon.serialize({ scrollback });
		}
		if (Buffer.byteLength(snapshot, "utf8") > TERMINAL_RESTORE_MAX_BYTES) snapshot = this.getPlainScreenSnapshot();
		this.cachedSnapshot = {
			snapshot,
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		};
		this.snapshotDirty = false;
		return this.cachedSnapshot;
	}

	/** Pathological per-cell styling/combining text must not bypass the byte cap. Keep screen, cursor and public modes. */
	private getPlainScreenSnapshot(): string {
		const buffer = this.terminal.buffer.active;
		const budget = Math.floor((TERMINAL_RESTORE_MAX_BYTES - 1024) / this.terminal.rows) - 2;
		const lines: string[] = [];
		for (let row = 0; row < this.terminal.rows; row += 1) {
			const bytes = Buffer.from(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "", "utf8");
			let start = Math.max(0, bytes.length - budget);
			while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
			lines.push(bytes.subarray(start).toString("utf8"));
		}
		let snapshot = `${buffer.type === "alternate" ? "\u001b[?1049h" : ""}\u001b[H${lines.join("\r\n")}`;
		snapshot += `\u001b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`;
		const modes = this.terminal.modes;
		if (modes.applicationCursorKeysMode) snapshot += "\u001b[?1h";
		if (modes.applicationKeypadMode) snapshot += "\u001b[?66h";
		if (modes.bracketedPasteMode) snapshot += "\u001b[?2004h";
		if (modes.insertMode) snapshot += "\u001b[4h";
		if (modes.originMode) snapshot += "\u001b[?6h";
		if (modes.reverseWraparoundMode) snapshot += "\u001b[?45h";
		if (modes.sendFocusMode) snapshot += "\u001b[?1004h";
		if (!modes.wraparoundMode) snapshot += "\u001b[?7l";
		const mouseMode = {
			none: "",
			x10: "\u001b[?9h",
			vt200: "\u001b[?1000h",
			drag: "\u001b[?1002h",
			any: "\u001b[?1003h",
		}[modes.mouseTrackingMode];
		return snapshot + mouseMode;
	}

	dispose(): void {
		this.terminal.dispose();
	}

	private enqueueOperation(operation: () => void | Promise<void>): void {
		this.operationQueue = this.operationQueue
			.catch(() => undefined)
			.then(async () => {
				await operation();
			});
	}
}
