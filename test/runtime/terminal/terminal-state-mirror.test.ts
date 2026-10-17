import { afterEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_RESTORE_MAX_BYTES } from "../../../src/core/terminal-history";
import { TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";

const mirrors: TerminalStateMirror[] = [];

function createMirror(cols = 80, rows = 24): TerminalStateMirror {
	const mirror = new TerminalStateMirror(cols, rows);
	mirrors.push(mirror);
	return mirror;
}

afterEach(() => {
	while (mirrors.length > 0) {
		mirrors.pop()?.dispose();
	}
});

describe("TerminalStateMirror", () => {
	it("serves only a byte-bounded recent tail for large resumed/repainted output", async () => {
		const mirror = createMirror(120, 40);
		mirror.applyOutput(
			Buffer.from(Array.from({ length: 20000 }, (_, i) => `row-${i} ${"wide🙂".repeat(30)}\r\n`).join("")),
		);
		const snapshot = await mirror.getSnapshot();
		expect(Buffer.byteLength(snapshot.snapshot)).toBeLessThanOrEqual(TERMINAL_RESTORE_MAX_BYTES);
		expect(snapshot.snapshot).toContain("row-19999");
		expect(snapshot.snapshot).not.toContain("row-0 ");
	});
	it("bounds pathological cell styling while retaining alternate screen and input modes", async () => {
		const mirror = createMirror(200, 80);
		let output = "\u001b[?1049h\u001b[?2004h";
		for (let i = 0; i < 16000; i += 1) output += `\u001b[38;2;${i % 255};${(i + 1) % 255};${(i + 2) % 255}mX`;
		mirror.applyOutput(Buffer.from(output));
		const snapshot = await mirror.getSnapshot();
		expect(Buffer.byteLength(snapshot.snapshot)).toBeLessThanOrEqual(TERMINAL_RESTORE_MAX_BYTES);
		expect(snapshot.snapshot).toContain("\u001b[?1049h");
		expect(snapshot.snapshot).toContain("\u001b[?2004h");
	});
	it("serializes inline terminal content and dimensions", async () => {
		const mirror = createMirror(100, 30);

		mirror.applyOutput(Buffer.from("hello\r\nworld", "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot.cols).toBe(100);
		expect(snapshot.rows).toBe(30);
		expect(snapshot.snapshot).toContain("hello");
		expect(snapshot.snapshot).toContain("world");
	});

	it("preserves alternate-screen state when the active buffer is alternate", async () => {
		const mirror = createMirror();

		mirror.applyOutput(Buffer.from("\u001b[?1049h\u001b[Hfullscreen", "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot.snapshot).toContain("\u001b[?1049h");
		expect(snapshot.snapshot).toContain("fullscreen");
	});

	it("applies queued resizes before generating a snapshot", async () => {
		const mirror = createMirror(80, 24);

		mirror.applyOutput(Buffer.from("before resize", "utf8"));
		mirror.resize(120, 40);
		mirror.applyOutput(Buffer.from("\r\nafter resize", "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot.cols).toBe(120);
		expect(snapshot.rows).toBe(40);
		expect(snapshot.snapshot).toContain("after resize");
	});

	it("emits terminal query responses through the optional callback", async () => {
		const onInputResponse = vi.fn();
		const mirror = new TerminalStateMirror(80, 24, {
			onInputResponse,
		});
		mirrors.push(mirror);

		mirror.applyOutput(Buffer.from("\u001b[6n", "utf8"));
		await mirror.getSnapshot();

		expect(onInputResponse).toHaveBeenCalledWith("\u001b[1;1R");
	});

	it("keeps lines above the viewport in the restore snapshot", async () => {
		const rows = 8;
		const mirror = createMirror(40, rows);
		const lines = Array.from({ length: rows + 12 }, (_, i) => `line-${i}`);
		mirror.applyOutput(Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot.snapshot).toContain("line-0");
		expect(snapshot.snapshot).toContain(`line-${rows + 11}`);
	});

	it("reuses the restore snapshot when nothing has been written or resized", async () => {
		const mirror = createMirror();
		mirror.applyOutput(Buffer.from("stable-output\r\n", "utf8"));

		const first = await mirror.getSnapshot();
		const second = await mirror.getSnapshot();

		expect(second).toBe(first);
		expect(second.snapshot).toContain("stable-output");
	});

	it("rebuilds the restore snapshot after new output", async () => {
		const mirror = createMirror();
		mirror.applyOutput(Buffer.from("before-output\r\n", "utf8"));
		const first = await mirror.getSnapshot();

		mirror.applyOutput(Buffer.from("after-output\r\n", "utf8"));
		const second = await mirror.getSnapshot();

		expect(second).not.toBe(first);
		expect(second.snapshot).toContain("before-output");
		expect(second.snapshot).toContain("after-output");
	});

	it("rebuilds the restore snapshot after a resize", async () => {
		const mirror = createMirror(80, 24);
		mirror.applyOutput(Buffer.from("before-resize\r\n", "utf8"));
		const first = await mirror.getSnapshot();

		mirror.resize(120, 40);
		const second = await mirror.getSnapshot();

		expect(second).not.toBe(first);
		expect(second.cols).toBe(120);
		expect(second.rows).toBe(40);
	});
});
