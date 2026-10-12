import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VoiceTerminalTouchBar } from "@/components/detail-panels/terminal-touch-bar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { TerminalTouchKey } from "@/terminal/terminal-touch-keys";
import { createFakeSpeechSynthesis, FakeSpeechRecognition, FakeUtterance } from "@/voice/test-speech-fakes";
import { REPLY_SETTLE_MS } from "@/voice/use-reply-speech";

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
		act(() => root.unmount());
		act(() => FakeSpeechRecognition.endAll());
		container.remove();
		textarea.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		delete (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
	});

	it("puts the mic, the speaker, the key pad toggle and Enter in one row, jump to bottom last, and no send or stop button", () => {
		render();
		expect(rowLabels()).toEqual([
			"Talk to the agent",
			"Read replies aloud",
			"Show terminal keys",
			"Send Enter",
			"Jump to bottom",
		]);
		expect(container.querySelector('button[aria-label="Send voice message"]')).toBeNull();
		expect(container.querySelector('button[aria-label="Stop reading the reply"]')).toBeNull();
	});

	it("shows only the bar's own buttons where the browser has no speech API", () => {
		vi.unstubAllGlobals();
		render();
		expect(rowLabels()).toEqual(["Show terminal keys", "Send Enter", "Jump to bottom"]);
	});

	it("Enter sends the dictated text through the voice message's path, and is the terminal's Enter again after", async () => {
		render();
		const recognition = dictate("fix the login");
		// The X sits next to the text, not on the row.
		expect(rowLabels()).not.toContain("Discard voice message");
		expect(button("Discard voice message")).toBeTruthy();
		// Listening: as the send button was, Enter waits for the final text.
		expect(rowLabels()).toContain("Send voice message");
		expect(button("Send voice message").getAttribute("aria-disabled")).toBe("true");
		tap(button("Send voice message"));
		expect(deliverTaskInputMock).not.toHaveBeenCalled();
		expect(keys).toEqual([]);

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
});
