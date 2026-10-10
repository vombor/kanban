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
		FakeSpeechRecognition.instances = [];
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
		act(() => FakeSpeechRecognition.latest().emitResults([{ transcript: "first part", isFinal: true }]));
		tapMic("Stop listening");
		act(() => FakeSpeechRecognition.latest().emitEnd());

		tapMic("Talk to the agent");
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
		});
		act(() => vi.advanceTimersByTime(REPLY_SETTLE_MS));
		expect(synthesis.spoken.map((utterance) => utterance.text)).toEqual(["I fixed it. Anything else?"]);
		expect(button("Stop reading the reply")).toBeTruthy();

		tapMic("Talk to the agent");
		expect(cancel).toHaveBeenCalled();
		expect(FakeSpeechRecognition.latest().started).toBe(true);
		expect(container.querySelector('button[aria-label="Stop reading the reply"]')).toBeNull();
		vi.useRealTimers();
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
