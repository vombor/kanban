import { afterEach, describe, expect, it, vi } from "vitest";

import { getSpeechRecognitionConstructor, getSpeechSynthesis, readSpeechTranscript } from "@/voice/speech-apis";
import { createFakeSpeechSynthesis, FakeSpeechRecognition, FakeUtterance } from "@/voice/test-speech-fakes";

function resultList(results: Array<{ transcript: string; isFinal: boolean }>): SpeechRecognitionResultList {
	return results.map((result) =>
		Object.assign([{ transcript: result.transcript, confidence: 1 }], { isFinal: result.isFinal }),
	) as unknown as SpeechRecognitionResultList;
}

describe("speech API detection", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("finds no recognizer or synthesis where the browser has none (Firefox, jsdom)", () => {
		expect(getSpeechRecognitionConstructor()).toBeNull();
		expect(getSpeechSynthesis()).toBeNull();
	});

	it("takes the standard recognizer, else the webkit-prefixed one", () => {
		vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
		expect(getSpeechRecognitionConstructor()).toBe(FakeSpeechRecognition);
		class StandardRecognition extends FakeSpeechRecognition {}
		vi.stubGlobal("SpeechRecognition", StandardRecognition);
		expect(getSpeechRecognitionConstructor()).toBe(StandardRecognition);
	});

	it("needs both speechSynthesis and SpeechSynthesisUtterance for speech out", () => {
		const synthesis = createFakeSpeechSynthesis();
		vi.stubGlobal("speechSynthesis", synthesis);
		expect(getSpeechSynthesis()).toBeNull();
		vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
		expect(getSpeechSynthesis()).toBe(synthesis);
	});
});

describe("readSpeechTranscript", () => {
	it("keeps final and interim results apart", () => {
		expect(
			readSpeechTranscript(
				resultList([
					{ transcript: "run the tests", isFinal: true },
					{ transcript: " and then", isFinal: true },
					{ transcript: "commit it", isFinal: false },
				]),
			),
		).toEqual({ finalText: "run the tests and then", interimText: "commit it" });
	});

	it("is empty for no results", () => {
		expect(readSpeechTranscript(resultList([]))).toEqual({ finalText: "", interimText: "" });
	});
});
