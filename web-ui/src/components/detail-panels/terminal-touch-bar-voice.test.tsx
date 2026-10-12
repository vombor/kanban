import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VoiceTerminalTouchBar } from "@/components/detail-panels/terminal-touch-bar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { TerminalTouchKey } from "@/terminal/terminal-touch-keys";
import { createFakeSpeechSynthesis, FakeSpeechRecognition, FakeUtterance } from "@/voice/test-speech-fakes";
import { REPLY_SETTLE_MS } from "@/voice/use-reply-speech";
import { SEND_FINAL_WAIT_MS } from "@/voice/use-voice-input";
import { clearVoiceDebugLog } from "@/voice/voice-debug-log";
import { VOICE_DEBUG_HOLD_MS } from "./voice-chat-controls";

const deliverTaskInputMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: (workspaceId: string | null) => ({
		runtime: {
			deliverTaskInput: {
				mutate: (input: object) => deliverTaskInputMock({ workspaceId, ...input }),
			},
		},
	}),
}));

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const DELIVERED = { ok: true, status: "delivered", evidence: "hook", enterAttempts: 1, summary: null };

const RUNNING = {
	taskId: "task-1",
	state: "running",
	agentId: "claude",
	workspacePath: "/tmp/repo",
	pid: 1,
	startedAt: 1,
	updatedAt: 1,
	lastOutputAt: 1,
	reviewReason: null,
	exitCode: null,
	lastHookAt: null,
	latestHookActivity: null,
} as RuntimeTaskSessionSummary;

const REPLIED = {
	...RUNNING,
	state: "awaiting_review",
	reviewReason: "hook",
	stateChangedAt: 2,
	updatedAt: 2,
	latestHookActivity: {
		activityText: null,
		toolName: null,
		toolInputSummary: null,
		finalMessage: "I fixed it. Anything else?",
		hookEventName: "Stop",
		notificationType: null,
		source: null,
	},
	lastTurnEnd: { at: 2, finalMessage: "I fixed it. Anything else?" },
} as RuntimeTaskSessionSummary;

// jsdom has no PointerEvent: a mouse event with the pointer fields is what React reads.
function pointerEvent(type: string): MouseEvent {
	return Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }), {
		pointerType: "touch",
		pointerId: 1,
	});
}

// The phone's touch bar on an agent session: the voice controls join the row.
describe("VoiceTerminalTouchBar", () => {
	let container: HTMLDivElement;
	let root: Root;
	let textarea: HTMLTextAreaElement;
	let keys: TerminalTouchKey[];

	function render(summary: RuntimeTaskSessionSummary | null = null) {
		act(() => {
			root.render(
				<TooltipProvider>
					<VoiceTerminalTouchBar
						taskId="task-1"
						workspaceId="ws-1"
						summary={summary}
						showJumpToBottom
						onJumpToBottom={() => {}}
						onKey={(key) => keys.push(key)}
					/>
				</TooltipProvider>,
			);
		});
	}

	function button(label: string): HTMLButtonElement {
		const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
		if (!found) {
			throw new Error(`No button "${label}"`);
		}
		return found;
	}

	function rowLabels(): Array<string | null> {
		const row = container.querySelector('[role="toolbar"][aria-label="Terminal controls"]');
		return Array.from(row?.querySelectorAll("button") ?? []).map((found) => found.getAttribute("aria-label"));
	}

	function preview(): HTMLTextAreaElement | null {
		return container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Voice message"]');
	}

	// A tap: pointer down, mouse down, pointer up, click (detail 1, as a real tap).
	function tap(target: HTMLButtonElement): { pointerDown: MouseEvent; mouseDown: MouseEvent } {
		const pointerDown = pointerEvent("pointerdown");
		const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
		act(() => {
			target.dispatchEvent(pointerDown);
			target.dispatchEvent(mouseDown);
			target.dispatchEvent(pointerEvent("pointerup"));
			target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
		});
		return { pointerDown, mouseDown };
	}

	function dictate(words: string) {
		tap(button("Talk to the agent"));
		const recognition = FakeSpeechRecognition.latest();
		act(() => recognition.emitStart());
		act(() => recognition.emitResults([{ transcript: words, isFinal: true }]));
		return recognition;
	}

	beforeEach(() => {
		(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
		FakeSpeechRecognition.reset();
		deliverTaskInputMock.mockReset();
		deliverTaskInputMock.mockResolvedValue(DELIVERED);
		window.localStorage.clear();
		vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
		vi.stubGlobal("speechSynthesis", createFakeSpeechSynthesis());
		vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
		container = document.createElement("div");
		document.body.appendChild(container);
		// Stands in for xterm's textarea, which holds the keyboard's focus.
		textarea = document.createElement("textarea");
		document.body.appendChild(textarea);
		textarea.focus();
		root = createRoot(container);
		keys = [];
	});

	afterEach(() => {
		vi.restoreAllMocks();
		act(() => root.unmount());
		act(() => FakeSpeechRecognition.endAll());
		container.remove();
		textarea.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		delete (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
	});

	it("puts the mic and the speaker on the left of one row, jump to bottom, the key pad toggle and Enter on the right, and no send or stop button", () => {
		render();
		expect(rowLabels()).toEqual([
			"Talk to the agent",
			"Read replies aloud",
			"Jump to bottom",
			"Show terminal keys",
			"Send Enter",
		]);
		expect(container.querySelector('button[aria-label="Send voice message"]')).toBeNull();
		expect(container.querySelector('button[aria-label="Stop reading the reply"]')).toBeNull();
	});

	it("shows only the bar's own buttons where the browser has no speech API", () => {
		vi.unstubAllGlobals();
		render();
		expect(rowLabels()).toEqual(["Jump to bottom", "Show terminal keys", "Send Enter"]);
	});

	it("Enter sends the dictated text through the voice message's path, and is the terminal's Enter again after", async () => {
		render();
		const recognition = dictate("fix the login");
		// The X sits next to the text, not on the row.
		expect(rowLabels()).not.toContain("Discard voice message");
		expect(button("Discard voice message")).toBeTruthy();
		expect(rowLabels()).toContain("Send voice message");

		tap(button("Stop listening"));
		act(() => recognition.emitEnd());
		expect(preview()?.value).toBe("fix the login");
		expect(button("Send voice message").getAttribute("aria-disabled")).toBe("false");

		let resolveDelivery: (value: typeof DELIVERED) => void = () => {};
		deliverTaskInputMock.mockReturnValue(
			new Promise((resolve) => {
				resolveDelivery = resolve;
			}),
		);
		const { pointerDown, mouseDown } = tap(button("Send voice message"));
		expect(pointerDown.defaultPrevented).toBe(true);
		expect(mouseDown.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(textarea);
		expect(deliverTaskInputMock).toHaveBeenCalledWith({
			workspaceId: "ws-1",
			taskId: "task-1",
			text: "fix the login",
		});
		// Sending: the spinner, and a second tap sends nothing.
		const enter = button("Send voice message");
		expect(enter.getAttribute("aria-disabled")).toBe("true");
		expect(enter.querySelector(".animate-spin")).toBeTruthy();
		tap(enter);
		expect(deliverTaskInputMock).toHaveBeenCalledTimes(1);

		await act(async () => resolveDelivery(DELIVERED));
		expect(preview()).toBeNull();
		tap(button("Send Enter"));
		expect(keys).toEqual(["enter"]);
		expect(deliverTaskInputMock).toHaveBeenCalledTimes(1);
	});

	it("X clears the dictated text without sending, and Enter goes to the terminal again", () => {
		render();
		const recognition = dictate("never mind");
		tap(button("Stop listening"));
		act(() => recognition.emitEnd());
		const { mouseDown } = tap(button("Discard voice message"));
		expect(mouseDown.defaultPrevented).toBe(true);
		expect(preview()).toBeNull();
		tap(button("Send Enter"));
		expect(keys).toEqual(["enter"]);
		expect(deliverTaskInputMock).not.toHaveBeenCalled();
	});

	it("the speaker toggles reading replies aloud, and while a reply is read a tap stops the reading only", () => {
		vi.useFakeTimers();
		const synthesis = createFakeSpeechSynthesis();
		const cancel = vi.spyOn(synthesis, "cancel");
		vi.stubGlobal("speechSynthesis", synthesis);
		render(RUNNING);
		const speaker = button("Read replies aloud");
		expect(speaker.getAttribute("aria-pressed")).toBe("false");
		const { pointerDown, mouseDown } = tap(speaker);
		expect(pointerDown.defaultPrevented).toBe(true);
		expect(mouseDown.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(textarea);
		expect(button("Read replies aloud").getAttribute("aria-pressed")).toBe("true");

		render(REPLIED);
		act(() => vi.advanceTimersByTime(REPLY_SETTLE_MS));
		// The silent utterance from the tap that turned the speaker on, then the reply.
		expect(synthesis.spoken.map((utterance) => utterance.text)).toEqual(["", "I fixed it. Anything else?"]);
		// Reading: the speaker says so, and the row says it too.
		const reading = button("Stop reading the reply");
		expect(reading.className).toContain("animate-pulse");
		expect(reading.getAttribute("aria-pressed")).toBe("true");
		expect(container.textContent).toContain("Reading the reply…");

		cancel.mockClear();
		tap(reading);
		expect(cancel).toHaveBeenCalled();
		// The reading stopped; replies are still read aloud.
		const speakerAfter = button("Read replies aloud");
		expect(speakerAfter.getAttribute("aria-pressed")).toBe("true");
		expect(speakerAfter.className).not.toContain("animate-pulse");
		expect(window.localStorage.getItem("kanban.voice-chat.speak-replies:task-1")).toBe("true");

		tap(speakerAfter);
		expect(button("Read replies aloud").getAttribute("aria-pressed")).toBe("false");
	});

	it("Enter while listening stops the mic, waits for the final text and sends it", async () => {
		render();
		tap(button("Talk to the agent"));
		const recognition = FakeSpeechRecognition.latest();
		act(() => recognition.emitStart());
		act(() =>
			recognition.emitResults([
				{ transcript: "run the", isFinal: true },
				{ transcript: "test", isFinal: false },
			]),
		);
		const enter = button("Send voice message");
		expect(enter.getAttribute("aria-disabled")).toBe("false");
		const { mouseDown } = tap(enter);
		expect(mouseDown.defaultPrevented).toBe(true);
		expect(recognition.stopped).toBe(true);
		expect(deliverTaskInputMock).not.toHaveBeenCalled();
		// Waiting for the final text: the spinner, and a second tap sends nothing more.
		expect(button("Send voice message").querySelector(".animate-spin")).toBeTruthy();
		tap(button("Send voice message"));

		act(() =>
			recognition.emitResults([
				{ transcript: "run the", isFinal: true },
				{ transcript: "tests", isFinal: true },
			]),
		);
		await act(async () => recognition.emitEnd());
		expect(deliverTaskInputMock).toHaveBeenCalledTimes(1);
		expect(deliverTaskInputMock).toHaveBeenCalledWith({
			workspaceId: "ws-1",
			taskId: "task-1",
			text: "run the tests",
		});
		expect(preview()).toBeNull();
		expect(keys).toEqual([]);
		expect(document.activeElement).toBe(textarea);
	});

	it("Enter while listening sends what the preview shows when the final text doesn't come in time", async () => {
		vi.useFakeTimers();
		render();
		tap(button("Talk to the agent"));
		const recognition = FakeSpeechRecognition.latest();
		act(() => recognition.emitStart());
		act(() =>
			recognition.emitResults([
				{ transcript: "deploy", isFinal: true },
				{ transcript: "it now", isFinal: false },
			]),
		);
		tap(button("Send voice message"));
		act(() => vi.advanceTimersByTime(SEND_FINAL_WAIT_MS - 1));
		expect(deliverTaskInputMock).not.toHaveBeenCalled();
		await act(async () => vi.advanceTimersByTime(1));
		expect(recognition.aborted).toBe(true);
		expect(deliverTaskInputMock).toHaveBeenCalledWith({
			workspaceId: "ws-1",
			taskId: "task-1",
			text: "deploy it now",
		});
		// The dropped session's late end changes nothing.
		await act(async () => recognition.emitEnd());
		expect(deliverTaskInputMock).toHaveBeenCalledTimes(1);
		expect(preview()).toBeNull();
	});

	it("Enter while listening with nothing heard only stops listening", async () => {
		render();
		tap(button("Talk to the agent"));
		const recognition = FakeSpeechRecognition.latest();
		act(() => recognition.emitStart());
		tap(button("Send voice message"));
		expect(recognition.stopped).toBe(true);
		await act(async () => recognition.emitEnd());
		expect(deliverTaskInputMock).not.toHaveBeenCalled();
		expect(keys).toEqual([]);
		expect(button("Talk to the agent").getAttribute("aria-pressed")).toBe("false");
		tap(button("Send Enter"));
		expect(keys).toEqual(["enter"]);
	});

	it("Enter while the mic is still opening stops it and sends nothing", () => {
		render();
		tap(button("Talk to the agent"));
		const recognition = FakeSpeechRecognition.latest();
		act(() => recognition.emitStart({ audio: false }));
		expect(container.textContent).toContain("Starting…");
		tap(button("Send voice message"));
		expect(recognition.stopped).toBe(true);
		expect(deliverTaskInputMock).not.toHaveBeenCalled();
		expect(keys).toEqual([]);
	});

	it("records again right after a send: the new session starts inside the mic's tap and hears", async () => {
		render();
		const first = dictate("first message");
		tap(button("Send voice message"));
		// The phone's order: the result is final, the end comes later; the user taps the mic again before it does.
		act(() => first.emitResults([{ transcript: "first message", isFinal: true }]));
		await act(async () => first.emitEnd());
		expect(deliverTaskInputMock).toHaveBeenCalledWith({
			workspaceId: "ws-1",
			taskId: "task-1",
			text: "first message",
		});

		const created = FakeSpeechRecognition.instances.length;
		tap(button("Talk to the agent"));
		// Started inside the tap, not from a timer or a promise.
		expect(FakeSpeechRecognition.instances).toHaveLength(created + 1);
		const second = FakeSpeechRecognition.latest();
		expect(second.started).toBe(true);
		act(() => second.emitStart());
		act(() => second.emitResults([{ transcript: "second message", isFinal: true }]));
		expect(preview()?.value).toBe("second message");
		tap(button("Send voice message"));
		await act(async () => second.emitEnd());
		expect(deliverTaskInputMock).toHaveBeenLastCalledWith({
			workspaceId: "ws-1",
			taskId: "task-1",
			text: "second message",
		});
	});

	it("records again while the sent session hasn't ended yet: the browser ends it, the new one hears", () => {
		render();
		const first = dictate("first");
		tap(button("Stop listening"));
		// No end from the browser yet; the stop timeout hasn't run either.
		tap(button("Stop listening"));
		expect(first.ended).toBe(false);
		act(() => first.emitEnd());
		tap(button("Talk to the agent"));
		const second = FakeSpeechRecognition.latest();
		expect(second).not.toBe(first);
		act(() => second.emitStart());
		expect(container.textContent).toContain("Listening…");
	});

	it("a mic tap while a reply is read stops the reading before the recognizer starts", () => {
		vi.useFakeTimers();
		const synthesis = createFakeSpeechSynthesis();
		const order: string[] = [];
		vi.spyOn(synthesis, "cancel").mockImplementation(() => {
			synthesis.speaking = false;
			order.push("speech cancel");
		});
		vi.stubGlobal("speechSynthesis", synthesis);
		vi.spyOn(FakeSpeechRecognition.prototype, "start").mockImplementation(function (this: FakeSpeechRecognition) {
			order.push("recognition start");
			this.started = true;
			FakeSpeechRecognition.live = this;
		});
		render(RUNNING);
		tap(button("Read replies aloud"));
		render(REPLIED);
		act(() => vi.advanceTimersByTime(REPLY_SETTLE_MS));
		expect(synthesis.speaking).toBe(true);
		order.length = 0;

		tap(button("Talk to the agent"));
		expect(order).toEqual(["speech cancel", "recognition start"]);
		act(() => FakeSpeechRecognition.latest().emitStart());
		expect(container.textContent).toContain("Listening…");
	});

	it("a mic tap cancels a synthesizer that still speaks without a reply of ours (the primer, a lost end)", () => {
		const synthesis = createFakeSpeechSynthesis();
		const cancel = vi.spyOn(synthesis, "cancel");
		vi.stubGlobal("speechSynthesis", synthesis);
		render();
		tap(button("Read replies aloud"));
		// The silent primer from that tap is still "speaking".
		expect(synthesis.speaking).toBe(true);
		tap(button("Talk to the agent"));
		expect(cancel).toHaveBeenCalled();
	});

	it("holding the mic shows the voice log with the recognizer's events, and holding it again hides it", () => {
		vi.useFakeTimers();
		clearVoiceDebugLog();
		render();
		const first = dictate("hello");
		tap(button("Stop listening"));
		act(() => first.emitEnd());
		expect(container.querySelector('[aria-label="Voice diagnostic log"]')).toBeNull();

		const mic = button("Talk to the agent");
		act(() => {
			mic.dispatchEvent(pointerEvent("pointerdown"));
		});
		act(() => vi.advanceTimersByTime(VOICE_DEBUG_HOLD_MS));
		act(() => {
			mic.dispatchEvent(pointerEvent("pointerup"));
		});
		const log = container.querySelector('[aria-label="Voice diagnostic log"]');
		expect(log).toBeTruthy();
		const lines = Array.from(log?.querySelectorAll('[role="log"] > div') ?? []).map((line) =>
			(line.textContent ?? "").replace(/^\S+Z (#\d+ )?/, ""),
		);
		expect(lines[0]).toMatch(/^page browser tab; lang /);
		expect(lines.slice(1)).toEqual([
			expect.stringMatching(/^start\(\) lang /),
			"start",
			"audiostart",
			'result 1 (1 final) "hello"',
			"stop()",
			"end",
			// The press that opened the log started a session, as any tap.
			expect.stringMatching(/^start\(\) lang /),
			"log shown",
		]);
		expect(window.localStorage.getItem("kanban.voice-debug-log")).toBe("true");

		// A short tap doesn't toggle it.
		tap(button("Stop listening"));
		expect(container.querySelector('[aria-label="Voice diagnostic log"]')).toBeTruthy();
		tap(button("Hide the voice log"));
		expect(container.querySelector('[aria-label="Voice diagnostic log"]')).toBeNull();
	});
});
