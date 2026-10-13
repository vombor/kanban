import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSpeechRecognition } from "@/voice/test-speech-fakes";
import {
	RECOGNITION_AUDIO_TIMEOUT_MS,
	RECOGNITION_START_TIMEOUT_MS,
	RECOGNITION_STOP_TIMEOUT_MS,
	type SpeechRecognitionControls,
	useSpeechRecognition,
} from "@/voice/use-speech-recognition";
import { clearVoiceDebugLog, formatVoiceDebugLog, getVoiceDebugEntries } from "@/voice/voice-debug-log";

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

	function startListening(): FakeSpeechRecognition {
		act(() => controls().start());
		const recognition = FakeSpeechRecognition.latest();
		act(() => recognition.emitStart());
		return recognition;
	}

	beforeEach(() => {
		(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
		vi.useFakeTimers();
		FakeSpeechRecognition.reset();
		clearVoiceDebugLog();
		vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		act(() => root.unmount());
		act(() => FakeSpeechRecognition.endAll());
		container.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		delete (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
		latest = null;
	});

	it("is listening only between the session's audiostart and end events", () => {
		mount();
		act(() => controls().start());
		const recognition = FakeSpeechRecognition.latest();
		expect(recognition.started).toBe(true);
		expect(controls().starting).toBe(true);
		expect(controls().listening).toBe(false);

		act(() => recognition.emitStart({ audio: false }));
		// The recognizer is set up; its microphone doesn't deliver audio yet.
		expect(controls().starting).toBe(true);
		expect(controls().listening).toBe(false);
		act(() => recognition.emitAudioStart());
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

	it("says nothing about no-speech after the user's own stop once something was heard", () => {
		mount();
		const recognition = startListening();
		act(() => recognition.emitHypothesis("hello"));
		act(() => controls().stop());
		act(() => recognition.emitError("no-speech"));
		act(() => recognition.emitEnd());
		expect(controls().listening).toBe(false);
		expect(controls().error).toBeNull();
		expect(controls().transcript.finalText).toBe("");
	});

	// Safari after a first session (user's log, 2026-10-12): start and audiostart at once, never a result, and on the
	// user's stop the Speech framework's "No speech detected". The bar says so instead of staying silent.
	it("says nothing was heard when a stopped session heard nothing", () => {
		mount();
		const recognition = startListening();
		expect(controls().listening).toBe(true);
		act(() => vi.advanceTimersByTime(8_000));
		act(() => controls().stop());
		act(() => recognition.emitNoSpeechAfterStop());
		expect(controls().listening).toBe(false);
		expect(controls().starting).toBe(false);
		expect(controls().error).toBe("Nothing was heard. Tap the mic to try again.");
	});

	it("says the microphone delivered no audio when Safari's capture source stopped", () => {
		mount();
		const recognition = startListening();
		// WebKit's capture unit fails a capture that got no samples for 20 s.
		act(() => vi.advanceTimersByTime(20_000));
		act(() => recognition.emitError("audio-capture", "Source is stopped"));
		expect(controls().listening).toBe(false);
		expect(controls().error).toBe("The microphone delivered no audio. Tap the mic to try again.");
		act(() => recognition.emitNoSpeechAfterStop());
		expect(controls().error).toBe("The microphone delivered no audio. Tap the mic to try again.");
		const next = startListening();
		act(() => next.emitHypothesis("hello microphone"));
		expect(controls().error).toBeNull();
		expect(controls().transcript.interimText).toBe("hello microphone");
	});

	// User's log, 2026-10-12: on #7's stop Safari sent "Hello hello hello" final at index 0, then again final at
	// index 1, and the terminal got "Hello hello hello Hello hello hello".
	it("keeps a final once when Safari repeats it at a new index on stop", () => {
		mount();
		const recognition = startListening();
		act(() => recognition.emitHypothesis("Hello"));
		act(() => recognition.emitHypothesis("Hello hello hello"));
		act(() => controls().stop());
		act(() => recognition.emitFinal("Hello hello hello"));
		act(() => recognition.emitFinal("Hello hello hello"));
		act(() => recognition.emitEnd());
		expect(controls().transcript).toEqual({ finalText: "Hello hello hello", interimText: "" });
		expect(controls().error).toBeNull();
	});

	it("keeps a real second utterance with the same words, which Safari hypothesizes first", () => {
		mount();
		const recognition = startListening();
		act(() => recognition.emitHypothesis("yes"));
		act(() => recognition.emitFinal("yes"));
		act(() => recognition.emitHypothesis("yes"));
		act(() => recognition.emitFinal("yes"));
		expect(controls().transcript.finalText).toBe("yes yes");
	});

	it("keeps a different final that arrives final at once", () => {
		mount();
		const recognition = startListening();
		act(() => recognition.emitFinal("first part"));
		act(() => recognition.emitFinal("second part"));
		expect(controls().transcript.finalText).toBe("first part second part");
	});

	it("logs how long start and audiostart took after start()", () => {
		mount();
		act(() => controls().start());
		const recognition = FakeSpeechRecognition.latest();
		act(() => vi.advanceTimersByTime(212));
		act(() => recognition.emitStart());
		const lines = getVoiceDebugEntries()
			.filter((entry) => entry.session !== null)
			.map((entry) => `${entry.event}${entry.detail ? ` ${entry.detail}` : ""}`);
		expect(lines).toContain("start +212 ms");
		expect(lines).toContain("audiostart +212 ms");
	});

	it("clear while listening keeps the session, and what it hears next fills the empty transcript", () => {
		mount();
		const recognition = startListening();
		act(() =>
			recognition.emitResults([
				{ transcript: "drop me", isFinal: true },
				{ transcript: "and m", isFinal: false },
			]),
		);

		act(() => controls().clear());
		expect(recognition.aborted).toBe(false);
		expect(recognition.stopped).toBe(false);
		expect(controls().listening).toBe(true);
		expect(controls().transcript).toEqual({ finalText: "", interimText: "" });

		// What was being said at the clear is cleared too, even once it becomes final.
		act(() =>
			recognition.emitResults([
				{ transcript: "drop me", isFinal: true },
				{ transcript: "and me", isFinal: true },
				{ transcript: "new wor", isFinal: false },
			]),
		);
		expect(controls().transcript).toEqual({ finalText: "", interimText: "new wor" });
		act(() =>
			recognition.emitResults([
				{ transcript: "drop me", isFinal: true },
				{ transcript: "and me", isFinal: true },
				{ transcript: "new words", isFinal: true },
			]),
		);
		act(() => controls().stop());
		act(() => recognition.emitEnd());
		expect(controls().listening).toBe(false);
		expect(controls().transcript).toEqual({ finalText: "new words", interimText: "" });

		// The next start is at once, inside the tap.
		act(() => controls().start());
		const next = FakeSpeechRecognition.latest();
		expect(next).not.toBe(recognition);
		act(() => next.emitStart());
		act(() => next.emitResults([{ transcript: "third", isFinal: true }]));
		expect(controls().transcript.finalText).toBe("third");
	});

	it("clear twice in one session skips everything heard before the last clear", () => {
		mount();
		const recognition = startListening();
		act(() => recognition.emitResults([{ transcript: "one", isFinal: true }]));
		act(() => controls().clear());
		act(() =>
			recognition.emitResults([
				{ transcript: "one", isFinal: true },
				{ transcript: "two", isFinal: true },
			]),
		);
		expect(controls().transcript.finalText).toBe("two");
		act(() => controls().clear());
		act(() =>
			recognition.emitResults([
				{ transcript: "one", isFinal: true },
				{ transcript: "two", isFinal: true },
				{ transcript: "three", isFinal: true },
			]),
		);
		expect(controls().transcript.finalText).toBe("three");
	});

	it("reads a result list shorter than the cleared part as a new one", () => {
		mount();
		const recognition = startListening();
		act(() =>
			recognition.emitResults([
				{ transcript: "a", isFinal: true },
				{ transcript: "b", isFinal: true },
			]),
		);
		act(() => controls().clear());
		act(() => recognition.emitResults([{ transcript: "fresh", isFinal: true }]));
		expect(controls().transcript.finalText).toBe("fresh");
	});

	it("clear after the session ended, then record again", () => {
		mount();
		const first = startListening();
		act(() => first.emitResults([{ transcript: "said", isFinal: true }]));
		act(() => controls().stop());
		act(() => first.emitEnd());
		act(() => controls().clear());
		expect(controls().transcript).toEqual({ finalText: "", interimText: "" });

		act(() => controls().start());
		const second = FakeSpeechRecognition.latest();
		expect(second).not.toBe(first);
		act(() => second.emitStart());
		act(() => second.emitResults([{ transcript: "again", isFinal: true }]));
		expect(controls().listening).toBe(true);
		expect(controls().transcript.finalText).toBe("again");
	});

	it("clear while a stopped session is ending keeps only what it finalises after the clear", () => {
		mount();
		const recognition = startListening();
		act(() => recognition.emitResults([{ transcript: "gone", isFinal: false }]));
		act(() => controls().stop());
		act(() => controls().clear());
		expect(recognition.aborted).toBe(false);
		act(() => recognition.emitResults([{ transcript: "gone now", isFinal: true }]));
		act(() => recognition.emitEnd());
		expect(controls().listening).toBe(false);
		expect(controls().transcript).toEqual({ finalText: "", interimText: "" });
		expect(controls().error).toBeNull();
	});

	it("clear while starting lets the session start and listen", () => {
		mount();
		act(() => controls().start());
		const recognition = FakeSpeechRecognition.latest();
		act(() => controls().clear());
		expect(controls().starting).toBe(true);
		act(() => recognition.emitStart());
		act(() => recognition.emitResults([{ transcript: "heard", isFinal: true }]));
		expect(controls().listening).toBe(true);
		expect(controls().transcript.finalText).toBe("heard");
	});

	it("clear also clears the error", () => {
		mount();
		const recognition = startListening();
		act(() => recognition.emitError("no-speech"));
		expect(controls().error).not.toBeNull();
		act(() => controls().clear());
		expect(controls().error).toBeNull();
	});

	it("reset while listening aborts the session, and the next start starts at once, inside the tap", () => {
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

		// The browser hasn't ended the aborted session yet: the new one starts anyway, and the browser ends the old one.
		act(() => controls().start());
		const second = FakeSpeechRecognition.latest();
		expect(second).not.toBe(first);
		expect(second.started).toBe(true);
		expect(first.ended).toBe(true);
		act(() => second.emitStart());
		act(() => second.emitResults([{ transcript: "heard again", isFinal: true }]));
		expect(controls().listening).toBe(true);
		expect(controls().transcript.finalText).toBe("heard again");
		expect(controls().error).toBeNull();
	});

	it("close while listening, then reopen and record again at once", () => {
		mount();
		const first = startListening();
		act(() => first.emitResults([{ transcript: "hello", isFinal: true }]));
		unmount();
		expect(first.aborted).toBe(true);

		mount();
		expect(controls().listening).toBe(false);
		act(() => controls().start());
		const second = FakeSpeechRecognition.latest();
		expect(second).not.toBe(first);
		expect(second.started).toBe(true);
		act(() => second.emitStart());
		act(() => second.emitResults([{ transcript: "second time", isFinal: true }]));
		expect(controls().listening).toBe(true);
		expect(controls().transcript.finalText).toBe("second time");
	});

	it("aborts the page's previous session before a reopened bar starts its own", () => {
		mount();
		const first = startListening();
		// A session an earlier bar left: dropped by its hook, never ended by the browser.
		act(() => controls().clear());
		unmount();
		first.aborted = false;
		mount();
		act(() => controls().start());
		expect(first.aborted).toBe(true);
		expect(FakeSpeechRecognition.latest()).not.toBe(first);
	});

	it("a new start while the previous session is still stopping starts at once", () => {
		mount();
		const first = startListening();
		act(() => first.emitResults([{ transcript: "first", isFinal: true }]));
		act(() => controls().stop());
		act(() => controls().start());
		const second = FakeSpeechRecognition.latest();
		expect(second).not.toBe(first);
		expect(second.started).toBe(true);
		expect(controls().transcript.finalText).toBe("");
		act(() => second.emitStart());
		expect(controls().listening).toBe(true);
	});

	it("is not listening until the microphone delivers audio (the browser's audiostart)", () => {
		mount();
		act(() => controls().start());
		const recognition = FakeSpeechRecognition.latest();
		act(() => recognition.emitStart({ audio: false }));
		expect(controls().starting).toBe(true);
		expect(controls().listening).toBe(false);
		act(() => recognition.emitAudioStart());
		expect(controls().starting).toBe(false);
		expect(controls().listening).toBe(true);
	});

	it("gives up with a message when the microphone never delivers audio (Safari's start and then nothing)", () => {
		mount();
		act(() => controls().start());
		const recognition = FakeSpeechRecognition.latest();
		act(() => recognition.emitStart({ audio: false }));
		act(() => vi.advanceTimersByTime(RECOGNITION_AUDIO_TIMEOUT_MS - 1));
		expect(controls().starting).toBe(true);
		act(() => vi.advanceTimersByTime(1));
		expect(recognition.aborted).toBe(true);
		expect(controls().starting).toBe(false);
		expect(controls().listening).toBe(false);
		expect(controls().error).toBe("The microphone didn't open, so nothing was heard. Tap the mic to try again.");
	});

	it("counts a first result as hearing, for a browser without audiostart", () => {
		mount();
		act(() => controls().start());
		const recognition = FakeSpeechRecognition.latest();
		act(() => recognition.emitStart({ audio: false }));
		act(() => recognition.emitResults([{ transcript: "hi", isFinal: false }]));
		expect(controls().listening).toBe(true);
		act(() => vi.advanceTimersByTime(RECOGNITION_AUDIO_TIMEOUT_MS));
		expect(recognition.aborted).toBe(false);
	});

	it("reports a start() the browser refuses", () => {
		mount();
		vi.spyOn(FakeSpeechRecognition.prototype, "start").mockImplementationOnce(() => {
			throw Object.assign(new Error("recognition has already started."), { name: "InvalidStateError" });
		});
		act(() => controls().start());
		expect(controls().starting).toBe(false);
		expect(controls().error).toBe("Speech recognition failed (InvalidStateError: recognition has already started.).");
		expect(getVoiceDebugEntries().map((entry) => entry.event)).toContain("start() threw");
	});

	it("stop before the browser started the session cancels it", () => {
		mount();
		act(() => controls().start());
		const recognition = FakeSpeechRecognition.latest();
		act(() => controls().stop());
		expect(recognition.aborted).toBe(true);
		expect(controls().starting).toBe(false);
		expect(controls().listening).toBe(false);
	});

	it("logs the session's events, with the error's message, for the diagnostic log", () => {
		mount();
		const recognition = startListening();
		act(() => recognition.emitResults([{ transcript: "hello there", isFinal: true }]));
		act(() => controls().stop());
		act(() => recognition.emitError("audio-capture", "Source is muted"));
		act(() => recognition.emitEnd());
		const lines = getVoiceDebugEntries()
			.filter((entry) => entry.session !== null)
			.map((entry) => `${entry.event}${entry.detail ? ` ${entry.detail}` : ""}`);
		expect(lines).toEqual([
			expect.stringMatching(/^start\(\) lang /),
			"start +0 ms",
			"audiostart +0 ms",
			'result 1 (1 final) "hello there"',
			"stop()",
			"error audio-capture: Source is muted",
			"end",
		]);
		expect(getVoiceDebugEntries()[0]?.event).toBe("page");
		expect(formatVoiceDebugLog()).toMatch(/^\d\d:\d\d:\d\d\.\d{3}Z page /);
	});
});
