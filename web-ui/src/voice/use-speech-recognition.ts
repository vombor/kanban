import { useCallback, useEffect, useRef, useState } from "react";

import { holdRecognition, releaseRecognition, waitForRecognitionEnd } from "@/voice/live-recognition";
import {
	getSpeechRecognitionConstructor,
	readSpeechTranscript,
	type SpeechRecognitionConstructor,
	type SpeechRecognitionLike,
	type SpeechTranscript,
} from "@/voice/speech-apis";

const EMPTY_TRANSCRIPT: SpeechTranscript = { finalText: "", interimText: "" };

/** A session the browser hasn't started by then is given up on (long enough for the first microphone prompt). */
export const RECOGNITION_START_TIMEOUT_MS = 15_000;
/** A stopped session that hasn't ended by then is aborted, so it can't stay "listening". */
export const RECOGNITION_STOP_TIMEOUT_MS = 3_000;
/** How long a new start waits for the page's previous session to end before it gives up on that one. */
export const RECOGNITION_RELEASE_TIMEOUT_MS = 2_000;

// After the user's own stop these only mean "nothing more was said".
const QUIET_AFTER_STOP_ERRORS = new Set(["no-speech", "aborted"]);

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
	if (error === "no-speech") {
		return "No speech was heard. Tap the mic to try again.";
	}
	if (error === "aborted") {
		return "Speech recognition was interrupted. Tap the mic to try again.";
	}
	return `Speech recognition failed (${error}).`;
}

const START_TIMEOUT_MESSAGE = "Speech recognition didn't start. Tap the mic to try again.";

type RecognitionStatus = "idle" | "starting" | "listening";

interface RecognitionSession {
	recognition: SpeechRecognitionLike;
	started: boolean;
	stopRequested: boolean;
	timer: ReturnType<typeof setTimeout> | null;
}

function clearSessionTimer(session: RecognitionSession): void {
	if (session.timer !== null) {
		clearTimeout(session.timer);
		session.timer = null;
	}
}

export interface SpeechRecognitionControls {
	supported: boolean;
	/** True only between the session's `start` and its `end` (or error): the browser is really listening. */
	listening: boolean;
	/** start() was called and the browser hasn't started the session yet. */
	starting: boolean;
	transcript: SpeechTranscript;
	error: string | null;
	/** Starts a new recognition; the previous transcript is dropped. */
	start: () => void;
	/** Stops listening; the recognizer still delivers the final text of what was already heard. */
	stop: () => void;
	/** Ends the session without its results and clears the transcript. */
	reset: () => void;
}

/**
 * Speech in through the browser's SpeechRecognition (continuous, with interim results for the preview). The state
 * follows the session's own events, and a session this hook drops (reset, unmount, a new start) is aborted but stays
 * the page's live session until its `end` (live-recognition.ts), so a new one never starts on top of it.
 */
export function useSpeechRecognition(): SpeechRecognitionControls {
	const [supported] = useState(() => getSpeechRecognitionConstructor() !== null);
	const [status, setStatus] = useState<RecognitionStatus>("idle");
	const [transcript, setTranscript] = useState<SpeechTranscript>(EMPTY_TRANSCRIPT);
	const [error, setError] = useState<string | null>(null);
	const sessionRef = useRef<RecognitionSession | null>(null);
	// Bumped by every start and drop, so a start still waiting for the previous session's end can tell it was replaced.
	const attemptRef = useRef(0);
	const mountedRef = useRef(false);

	// The session is over for this hook (its end, an error, or given up on); what it sends later is ignored.
	const finish = useCallback((session: RecognitionSession, message: string | null) => {
		if (sessionRef.current !== session) {
			return;
		}
		sessionRef.current = null;
		clearSessionTimer(session);
		setStatus("idle");
		if (message) {
			setError(message);
		}
		// What never became final is not text the user said.
		setTranscript((current) => ({ finalText: current.finalText, interimText: "" }));
	}, []);

	const giveUp = useCallback(
		(session: RecognitionSession, message: string | null) => {
			if (sessionRef.current !== session) {
				return;
			}
			finish(session, message);
			session.recognition.abort();
		},
		[finish],
	);

	// Ends this hook's session without its results, and cancels a start that is still waiting.
	const dropSession = useCallback(() => {
		attemptRef.current += 1;
		const session = sessionRef.current;
		if (session) {
			sessionRef.current = null;
			clearSessionTimer(session);
			session.recognition.abort();
		}
	}, []);

	const launch = useCallback(
		(Recognition: SpeechRecognitionConstructor) => {
			const recognition = new Recognition();
			const session: RecognitionSession = { recognition, started: false, stopRequested: false, timer: null };
			const isCurrent = () => sessionRef.current === session;
			recognition.continuous = true;
			recognition.interimResults = true;
			recognition.lang = typeof navigator === "undefined" ? "" : navigator.language;
			recognition.onstart = () => {
				if (!isCurrent()) {
					return;
				}
				session.started = true;
				clearSessionTimer(session);
				setStatus("listening");
			};
			recognition.onresult = (event) => {
				if (isCurrent()) {
					setTranscript(readSpeechTranscript(event.results));
				}
			};
			recognition.onerror = (event) => {
				if (!isCurrent()) {
					return;
				}
				const quiet = session.stopRequested && QUIET_AFTER_STOP_ERRORS.has(event.error);
				// The browser ends the session after an error; the state doesn't wait for that `end`.
				finish(session, quiet ? null : describeRecognitionError(event.error));
			};
			recognition.onend = () => {
				releaseRecognition(recognition);
				finish(session, null);
			};
			sessionRef.current = session;
			holdRecognition(recognition);
			session.timer = setTimeout(() => giveUp(session, START_TIMEOUT_MESSAGE), RECOGNITION_START_TIMEOUT_MS);
			try {
				recognition.start();
			} catch (startError) {
				releaseRecognition(recognition);
				finish(
					session,
					describeRecognitionError(startError instanceof Error ? startError.message : String(startError)),
				);
			}
		},
		[finish, giveUp],
	);

	const start = useCallback(() => {
		const Recognition = getSpeechRecognitionConstructor();
		if (!Recognition) {
			return;
		}
		dropSession();
		setTranscript(EMPTY_TRANSCRIPT);
		setError(null);
		setStatus("starting");
		const previousEnd = waitForRecognitionEnd(RECOGNITION_RELEASE_TIMEOUT_MS);
		if (!previousEnd) {
			launch(Recognition);
			return;
		}
		const attempt = attemptRef.current;
		void previousEnd.then(() => {
			if (mountedRef.current && attemptRef.current === attempt) {
				launch(Recognition);
			}
		});
	}, [dropSession, launch]);

	const stop = useCallback(() => {
		const session = sessionRef.current;
		if (!session?.started) {
			// Not listening yet: cancel the start.
			dropSession();
			setStatus("idle");
			return;
		}
		if (session.stopRequested) {
			return;
		}
		session.stopRequested = true;
		session.recognition.stop();
		session.timer = setTimeout(() => giveUp(session, null), RECOGNITION_STOP_TIMEOUT_MS);
	}, [dropSession, giveUp]);

	const reset = useCallback(() => {
		dropSession();
		setStatus("idle");
		setTranscript(EMPTY_TRANSCRIPT);
		setError(null);
	}, [dropSession]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			dropSession();
		};
	}, [dropSession]);

	return {
		supported,
		listening: status === "listening",
		starting: status === "starting",
		transcript,
		error,
		start,
		stop,
		reset,
	};
}
