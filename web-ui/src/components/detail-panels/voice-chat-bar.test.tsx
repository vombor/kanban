import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VoiceChatBar } from "@/components/detail-panels/voice-chat-bar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
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

describe("VoiceChatBar", () => {
	let container: HTMLDivElement;
	let root: Root;

	function render(summary: RuntimeTaskSessionSummary | null = null) {
		act(() => {
			root.render(
				<TooltipProvider>
					<VoiceChatBar taskId="task-1" workspaceId="ws-1" summary={summary} />
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

	function preview(): HTMLTextAreaElement | null {
		return container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Voice message"]');
	}

	// jsdom has no PointerEvent: a mouse event with the pointer fields is what React reads.
	function pointerEvent(type: string): MouseEvent {
		return Object.assign(new MouseEvent(type, { bubbles: true, button: 0 }), { pointerType: "touch", pointerId: 1 });
	}

	function tapMic(label: string) {
		const mic = button(label);
		act(() => {
			mic.dispatchEvent(pointerEvent("pointerdown"));
			mic.dispatchEvent(pointerEvent("pointerup"));
		});
	}

	beforeEach(() => {
		(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
		FakeSpeechRecognition.reset();
		deliverTaskInputMock.mockReset();
		deliverTaskInputMock.mockResolvedValue({
			ok: true,
			status: "delivered",
			evidence: "hook",
			enterAttempts: 1,
			summary: null,
		});
		window.localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		act(() => FakeSpeechRecognition.endAll());
		container.remove();
		vi.unstubAllGlobals();
		delete (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
	});

	it("renders nothing where the browser has no speech APIs (Firefox has no recognition)", () => {
		render();
		expect(container.innerHTML).toBe("");
	});

	it("shows only the speaker toggle where only speech out is supported", () => {
		vi.stubGlobal("speechSynthesis", createFakeSpeechSynthesis());
		vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
		render();
		expect(container.querySelector('button[aria-label="Talk to the agent"]')).toBeNull();
		expect(button("Read replies aloud").getAttribute("aria-pressed")).toBe("false");
	});

	it("previews interim results but sends only the final text, with Enter, through deliverTaskInput", async () => {
		vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
		render();
		tapMic("Talk to the agent");
		const recognition = FakeSpeechRecognition.latest();
		expect(recognition.started).toBe(true);
		expect(recognition.continuous).toBe(true);
		expect(recognition.interimResults).toBe(true);
		expect(container.textContent).toContain("Starting…");
		act(() => recognition.emitStart());
		expect(container.textContent).toContain("Listening…");

		act(() =>
			recognition.emitResults([
				{ transcript: "fix the login", isFinal: true },
				{ transcript: "bug ple", isFinal: false },
			]),
		);
		expect(preview()?.value).toBe("fix the login bug ple");
		expect(preview()?.readOnly).toBe(true);
		expect(button("Send voice message").disabled).toBe(true);

		tapMic("Stop listening");
		expect(recognition.stopped).toBe(true);
		// The interim "bug ple" never became final before the recognizer ended.
		act(() => recognition.emitEnd());
		expect(preview()?.value).toBe("fix the login");
		expect(preview()?.readOnly).toBe(false);
		expect(deliverTaskInputMock).not.toHaveBeenCalled();

		await act(async () => {
			preview()?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
		});
		expect(deliverTaskInputMock).toHaveBeenCalledTimes(1);
		expect(deliverTaskInputMock).toHaveBeenCalledWith({
			workspaceId: "ws-1",
			taskId: "task-1",
			text: "fix the login",
		});
		expect(preview()).toBeNull();
	});

	it("appends a second recording to the edited draft and keeps the draft when delivery fails", async () => {
		vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
		deliverTaskInputMock.mockResolvedValue({
			ok: false,
			status: "no_session",
			evidence: null,
			enterAttempts: 0,
			summary: null,
		});
		render();
		tapMic("Talk to the agent");
		act(() => FakeSpeechRecognition.latest().emitStart());
		act(() => FakeSpeechRecognition.latest().emitResults([{ transcript: "first part", isFinal: true }]));
		tapMic("Stop listening");
		act(() => FakeSpeechRecognition.latest().emitEnd());

		tapMic("Talk to the agent");
		act(() => FakeSpeechRecognition.latest().emitStart());
		act(() => FakeSpeechRecognition.latest().emitResults([{ transcript: "second part", isFinal: true }]));
		act(() => FakeSpeechRecognition.latest().emitEnd());
		expect(preview()?.value).toBe("first part second part");

		await act(async () => {
			button("Send voice message").click();
		});
		expect(deliverTaskInputMock).toHaveBeenCalledWith({
			workspaceId: "ws-1",
			taskId: "task-1",
			text: "first part second part",
		});
		expect(container.textContent).toContain("The session isn't running.");
		expect(preview()?.value).toBe("first part second part");

		act(() => button("Discard voice message").click());
		expect(preview()).toBeNull();
	});

	it("stops reading a reply aloud when the user starts talking", () => {
		vi.useFakeTimers();
		vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
		const synthesis = createFakeSpeechSynthesis();
		const cancel = vi.spyOn(synthesis, "cancel");
		vi.stubGlobal("speechSynthesis", synthesis);
		vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
		const running = {
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
		render(running);
		act(() => button("Read replies aloud").click());
		expect(window.localStorage.getItem("kanban.voice-chat.speak-replies:task-1")).toBe("true");

		render({
			...running,
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
		});
		act(() => vi.advanceTimersByTime(REPLY_SETTLE_MS));
		// The silent utterance from the click that turned the speaker on, then the reply.
		expect(synthesis.spoken.map((utterance) => utterance.text)).toEqual(["", "I fixed it. Anything else?"]);
		expect(button("Stop reading the reply")).toBeTruthy();

		tapMic("Talk to the agent");
		expect(cancel).toHaveBeenCalled();
		expect(FakeSpeechRecognition.latest().started).toBe(true);
		expect(container.querySelector('button[aria-label="Stop reading the reply"]')).toBeNull();
		vi.useRealTimers();
	});

	it("X while listening clears the text and keeps listening, without sending (phone report, 2026-10-12 night)", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
		render();
		tapMic("Talk to the agent");
		const first = FakeSpeechRecognition.latest();
		act(() => first.emitStart());
		act(() => first.emitResults([{ transcript: "fix the bug", isFinal: true }]));
		expect(preview()?.value).toBe("fix the bug");

		act(() => button("Discard voice message").click());
		// The session goes on: no abort the next start would have to wait for.
		expect(first.aborted).toBe(false);
		expect(preview()?.value).toBe("");
		expect(container.textContent).toContain("Listening…");
		expect(button("Stop listening").getAttribute("aria-pressed")).toBe("true");
		// Even a browser that takes long to end an aborted session changes nothing here.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});

		act(() =>
			first.emitResults([
				{ transcript: "fix the bug", isFinal: true },
				{ transcript: "add a test", isFinal: true },
			]),
		);
		expect(preview()?.value).toBe("add a test");
		tapMic("Stop listening");
		act(() => first.emitEnd());
		expect(preview()?.value).toBe("add a test");
		expect(deliverTaskInputMock).not.toHaveBeenCalled();

		// Recording again starts a fresh session at once, which hears and appends.
		tapMic("Talk to the agent");
		const second = FakeSpeechRecognition.latest();
		expect(second).not.toBe(first);
		expect(second.blocked).toBe(false);
		act(() => second.emitStart());
		act(() => second.emitResults([{ transcript: "please", isFinal: true }]));
		expect(container.textContent).toContain("Listening…");
		act(() => second.emitEnd());
		await act(async () => {
			button("Send voice message").click();
		});
		expect(deliverTaskInputMock).toHaveBeenCalledWith({
			workspaceId: "ws-1",
			taskId: "task-1",
			text: "add a test please",
		});
		vi.useRealTimers();
	});

	it("X after listening stopped, then record again, hears the new speech", () => {
		vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
		render();
		tapMic("Talk to the agent");
		const first = FakeSpeechRecognition.latest();
		act(() => first.emitStart());
		act(() => first.emitResults([{ transcript: "never mind", isFinal: true }]));
		tapMic("Stop listening");
		act(() => first.emitEnd());
		expect(preview()?.value).toBe("never mind");

		act(() => button("Discard voice message").click());
		expect(preview()).toBeNull();

		tapMic("Talk to the agent");
		const second = FakeSpeechRecognition.latest();
		expect(second).not.toBe(first);
		expect(second.blocked).toBe(false);
		act(() => second.emitStart());
		act(() => second.emitResults([{ transcript: "the real request", isFinal: true }]));
		expect(container.textContent).toContain("Listening…");
		expect(preview()?.value).toBe("the real request");
	});

	it("Escape while listening clears like X", () => {
		vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
		render();
		tapMic("Talk to the agent");
		const recognition = FakeSpeechRecognition.latest();
		act(() => recognition.emitStart());
		act(() => recognition.emitResults([{ transcript: "oops", isFinal: true }]));
		act(() => {
			preview()?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
		});
		expect(recognition.aborted).toBe(false);
		expect(preview()?.value).toBe("");
		act(() =>
			recognition.emitResults([
				{ transcript: "oops", isFinal: true },
				{ transcript: "okay", isFinal: true },
			]),
		);
		expect(preview()?.value).toBe("okay");
	});

	it("records again after X and closing the bar while listening (phone report, 2026-10-12)", async () => {
		vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
		render();
		tapMic("Talk to the agent");
		const first = FakeSpeechRecognition.latest();
		act(() => first.emitStart());
		act(() => first.emitResults([{ transcript: "fix the bug", isFinal: false }]));
		expect(preview()?.value).toBe("fix the bug");

		act(() => button("Discard voice message").click());
		expect(preview()?.value).toBe("");

		// Close the bar while still listening: that aborts, and the browser ends the session later. Then open it again.
		act(() => root.render(<TooltipProvider>{null}</TooltipProvider>));
		expect(first.aborted).toBe(true);
		render();
		expect(preview()).toBeNull();
		tapMic("Talk to the agent");
		expect(container.textContent).toContain("Starting…");
		expect(container.textContent).not.toContain("Listening…");

		act(() => first.emitEnd());
		await act(async () => {});
		const second = FakeSpeechRecognition.latest();
		expect(second).not.toBe(first);
		expect(second.blocked).toBe(false);
		act(() => second.emitStart());
		act(() => second.emitResults([{ transcript: "heard this time", isFinal: true }]));
		expect(container.textContent).toContain("Listening…");
		expect(preview()?.value).toBe("heard this time");
	});

	it("ends the session when the bar switches to another task", () => {
		vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
		render();
		tapMic("Talk to the agent");
		const recognition = FakeSpeechRecognition.latest();
		act(() => recognition.emitStart());
		act(() => recognition.emitResults([{ transcript: "for task one", isFinal: true }]));
		act(() => {
			root.render(
				<TooltipProvider>
					<VoiceChatBar taskId="task-2" workspaceId="ws-1" summary={null} />
				</TooltipProvider>,
			);
		});
		expect(recognition.aborted).toBe(true);
		expect(preview()).toBeNull();
		expect(container.textContent).not.toContain("Listening…");
	});

	it("shows why listening ended when the recognizer stops on its own", () => {
		vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
		render();
		tapMic("Talk to the agent");
		act(() => FakeSpeechRecognition.latest().emitStart());
		act(() => FakeSpeechRecognition.latest().emitError("no-speech"));
		expect(container.textContent).not.toContain("Listening…");
		expect(container.textContent).toContain("No speech was heard. Tap the mic to try again.");
		expect(button("Talk to the agent").getAttribute("aria-pressed")).toBe("false");
	});

	it("reports a denied microphone", () => {
		vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
		render();
		tapMic("Talk to the agent");
		act(() => FakeSpeechRecognition.latest().emitError("not-allowed"));
		act(() => FakeSpeechRecognition.latest().emitEnd());
		expect(container.textContent).toContain("Microphone access was denied.");
	});
});
