import { useCallback, useEffect, useRef, useState } from "react";

import {
	getSpeechRecognitionConstructor,
	readSpeechTranscript,
	type SpeechRecognitionLike,
	type SpeechTranscript,
} from "@/voice/speech-apis";

const EMPTY_TRANSCRIPT: SpeechTranscript = { finalText: "", interimText: "" };

// Errors that only mean "nothing was said" or "we stopped it".
const SILENT_ERRORS = new Set(["no-speech", "aborted"]);

function describeRecognitionError(error: string): string {
	if (error === "not-allowed" || error === "service-not-allowed") {
		return "Microphone access was denied.";
	}
	if (error === "audio-capture") {
		return "No microphone was found.";
	}
	if (error === "network") {
		return "Speech recognition needs a network connection in this browser.";
	}
	return `Speech recognition failed (${error}).`;
}

export interface SpeechRecognitionControls {
	supported: boolean;
	listening: boolean;
	transcript: SpeechTranscript;
	error: string | null;
	/** Starts a new recognition; the previous transcript is dropped. */
	start: () => void;
	/** Stops listening; the recognizer still delivers the final text of what was already heard. */
	stop: () => void;
	reset: () => void;
}

/** Speech in through the browser's SpeechRecognition (continuous, with interim results for the preview). */
export function useSpeechRecognition(): SpeechRecognitionControls {
	const [supported] = useState(() => getSpeechRecognitionConstructor() !== null);
	const [listening, setListening] = useState(false);
	const [transcript, setTranscript] = useState<SpeechTranscript>(EMPTY_TRANSCRIPT);
	const [error, setError] = useState<string | null>(null);
	const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

	const detach = useCallback((recognition: SpeechRecognitionLike) => {
		recognition.onresult = null;
		recognition.onerror = null;
		recognition.onend = null;
		if (recognitionRef.current === recognition) {
			recognitionRef.current = null;
		}
	}, []);

	const start = useCallback(() => {
		const Recognition = getSpeechRecognitionConstructor();
		if (!Recognition) {
			return;
		}
		const previous = recognitionRef.current;
		if (previous) {
			detach(previous);
			previous.abort();
		}
		const recognition = new Recognition();
		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.lang = typeof navigator === "undefined" ? "" : navigator.language;
		recognition.onresult = (event) => {
			setTranscript(readSpeechTranscript(event.results));
		};
		recognition.onerror = (event) => {
			if (!SILENT_ERRORS.has(event.error)) {
				setError(describeRecognitionError(event.error));
			}
		};
		recognition.onend = () => {
			detach(recognition);
			setListening(false);
			// What never became final is not text the user said.
			setTranscript((current) => ({ finalText: current.finalText, interimText: "" }));
		};
		recognitionRef.current = recognition;
		setTranscript(EMPTY_TRANSCRIPT);
		setError(null);
		try {
			recognition.start();
			setListening(true);
		} catch (startError) {
			detach(recognition);
			setError(describeRecognitionError(startError instanceof Error ? startError.message : String(startError)));
		}
	}, [detach]);

	const stop = useCallback(() => {
		recognitionRef.current?.stop();
	}, []);

	const reset = useCallback(() => {
		const recognition = recognitionRef.current;
		if (recognition) {
			detach(recognition);
			recognition.abort();
		}
		setListening(false);
		setTranscript(EMPTY_TRANSCRIPT);
		setError(null);
	}, [detach]);

	useEffect(() => {
		return () => {
			const recognition = recognitionRef.current;
			if (recognition) {
				detach(recognition);
				recognition.abort();
			}
		};
	}, [detach]);

	return { supported, listening, transcript, error, start, stop, reset };
}
