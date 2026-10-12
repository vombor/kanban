import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSpeechRecognition } from "@/voice/test-speech-fakes";
import {
	RECOGNITION_RELEASE_TIMEOUT_MS,
	RECOGNITION_START_TIMEOUT_MS,
	RECOGNITION_STOP_TIMEOUT_MS,
	type SpeechRecognitionControls,
	useSpeechRecognition,
} from "@/voice/use-speech-recognition";

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("useSpeechRecognition", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latest: SpeechRecognitionControls | null = null;

	function Harness() {
		latest = useSpeechRecognition();
		return null;
	}

	function mount() {
		act(() => {
			root.render(<Harness />);
		});
	}

	// Closing the voice bar: the hook unmounts while its session may still be running.
	function unmount() {
		act(() => root.unmount());
		latest = null;
		root = createRoot(container);
	}

	function controls(): SpeechRecognitionControls {
		if (!latest) {
			throw new Error("not rendered");
		}
		return latest;
	}

	// Lets a start that waits for the previous session's end go on.
	async function flush() {
		await act(async () => {});
	}

	function startListening(): FakeSpeechRecognition {
		act(() => controls().start());
		const recognition = FakeSpeechRecognition.latest();
		expect(recognition.blocked).toBe(false);
		act(() => recognition.emitStart());
		return recognition;
	}

	beforeEach(() => {
		(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
		vi.useFakeTimers();
		FakeSpeechRecognition.reset();
		vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		act(() => FakeSpeechRecognition.endAll());
		container.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		delete (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
		latest = null;
	});

	it("is listening only between the session's start and end events", () => {
		mount();
		act(() => controls().start());
		const recognition = FakeSpeechRecognition.latest();
		expect(recognition.started).toBe(true);
		expect(controls().starting).toBe(true);
		expect(controls().listening).toBe(false);

		act(() => recognition.emitStart());
		expect(controls().starting).toBe(false);
		expect(controls().listening).toBe(true);

		act(() =>
			recognition.emitResults([
				{ transcript: "hello", isFinal: true },
				{ transcript: "wor", isFinal: false },
			]),
		);
		expect(controls().transcript).toEqual({ finalText: "hello", interimText: "wor" });

		act(() => controls().stop());
		expect(recognition.stopped).toBe(true);
		// Stopped, but the browser hasn't ended the session: what it still hears is final text to keep.
		expect(controls().listening).toBe(true);
		act(() => recognition.emitEnd());
		expect(controls().listening).toBe(false);
		expect(controls().transcript).toEqual({ finalText: "hello", interimText: "" });
		expect(controls().error).toBeNull();
	});

	it("gives up on a session the browser never starts, with a message", () => {
		mount();
		act(() => controls().start());
		const recognition = FakeSpeechRecognition.latest();
		act(() => vi.advanceTimersByTime(RECOGNITION_START_TIMEOUT_MS));
		expect(recognition.aborted).toBe(true);
		expect(controls().starting).toBe(false);
		expect(controls().listening).toBe(false);
		expect(controls().error).toBe("Speech recognition didn't start. Tap the mic to try again.");
	});

	it("aborts a stopped session that never ends", () => {
		mount();
		const recognition = startListening();
		act(() => recognition.emitResults([{ transcript: "kept", isFinal: true }]));
		act(() => controls().stop());
		act(() => vi.advanceTimersByTime(RECOGNITION_STOP_TIMEOUT_MS));
		expect(recognition.aborted).toBe(true);
		expect(controls().listening).toBe(false);
		expect(controls().transcript.finalText).toBe("kept");
		expect(controls().error).toBeNull();
	});

	it.each([
		["no-speech", "No speech was heard. Tap the mic to try again."],
		["aborted", "Speech recognition was interrupted. Tap the mic to try again."],
		["network", "Speech recognition needs a network connection in this browser."],
		["not-allowed", "Microphone access was denied."],
	])("ends listening on a %s error with a message, before the end event", (code, message) => {
		mount();
		const recognition = startListening();
		act(() => recognition.emitError(code));
		expect(controls().listening).toBe(false);
		expect(controls().error).toBe(message);
		act(() => recognition.emitEnd());
		expect(controls().error).toBe(message);
	});

	it("says nothing about no-speech after the user's own stop", () => {
		mount();
		const recognition = startListening();
		act(() => controls().stop());
		act(() => recognition.emitError("no-speech"));
		act(() => recognition.emitEnd());
		expect(controls().listening).toBe(false);
		expect(controls().error).toBeNull();
	});

	it("clear while listening aborts the session, and the next start waits for its end", async () => {
		mount();
		const first = startListening();
		act(() => first.emitResults([{ transcript: "drop me", isFinal: false }]));

		act(() => controls().reset());
		expect(first.aborted).toBe(true);
		expect(controls().listening).toBe(false);
		expect(controls().transcript).toEqual({ finalText: "", interimText: "" });
		// The aborted session's last words never reach the state.
		act(() => first.emitResults([{ transcript: "late", isFinal: true }]));
		expect(controls().transcript.finalText).toBe("");

		act(() => controls().start());
		expect(FakeSpeechRecognition.instances).toHaveLength(1);
		expect(controls().starting).toBe(true);

		act(() => first.emitEnd());
		await flush();
		const second = FakeSpeechRecognition.latest();
		expect(second).not.toBe(first);
		expect(second.blocked).toBe(false);
		act(() => second.emitStart());
		act(() => second.emitResults([{ transcript: "heard again", isFinal: true }]));
		expect(controls().listening).toBe(true);
		expect(controls().transcript.finalText).toBe("heard again");
	});

	it("close while listening, then reopen and record again", async () => {
		mount();
		const first = startListening();
		act(() => first.emitResults([{ transcript: "hello", isFinal: true }]));
		unmount();
		expect(first.aborted).toBe(true);

		mount();
		expect(controls().listening).toBe(false);
		act(() => controls().start());
		// Still the page's live session: the reopened bar doesn't start on top of it.
		expect(FakeSpeechRecognition.instances).toHaveLength(1);
		act(() => first.emitEnd());
		await flush();

		const second = FakeSpeechRecognition.latest();
		expect(second.blocked).toBe(false);
		expect(controls().listening).toBe(false);
		act(() => second.emitStart());
		act(() => second.emitResults([{ transcript: "second time", isFinal: true }]));
		expect(controls().listening).toBe(true);
		expect(controls().transcript.finalText).toBe("second time");
	});

	it("starts anyway once the previous session hasn't ended within the release timeout", async () => {
		mount();
		const first = startListening();
		unmount();
		mount();
		act(() => controls().start());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(RECOGNITION_RELEASE_TIMEOUT_MS);
		});
		expect(FakeSpeechRecognition.instances).toHaveLength(2);
		expect(first.aborted).toBe(true);
		// On a phone that recognizer may still be stuck: it shows "starting", then the start timeout's message.
		expect(controls().listening).toBe(false);
		act(() => vi.advanceTimersByTime(RECOGNITION_START_TIMEOUT_MS));
		expect(controls().error).toBe("Speech recognition didn't start. Tap the mic to try again.");
	});

	it("stop before the browser started the session cancels it", async () => {
		mount();
		const first = startListening();
		act(() => controls().reset());
		act(() => controls().start());
		act(() => controls().stop());
		expect(controls().starting).toBe(false);
		act(() => first.emitEnd());
		await flush();
		// The cancelled start never creates its session.
		expect(FakeSpeechRecognition.instances).toHaveLength(1);
		expect(controls().listening).toBe(false);
	});
});
