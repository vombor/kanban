import { useCallback, useEffect, useRef, useState } from "react";

import { abortLiveRecognition, holdRecognition, releaseRecognition } from "@/voice/live-recognition";
import {
	getSpeechRecognitionConstructor,
	RepeatedFinalFilter,
	readSpeechTranscript,
	type SpeechRecognitionConstructor,
	type SpeechRecognitionErrorLike,
	type SpeechRecognitionLike,
	type SpeechRecognitionResultEventLike,
	type SpeechTranscript,
} from "@/voice/speech-apis";
import { logVoiceEvent } from "@/voice/voice-debug-log";

const EMPTY_TRANSCRIPT: SpeechTranscript = { finalText: "", interimText: "" };

/** A session the browser hasn't started by then is given up on (long enough for the first microphone prompt). */
export const RECOGNITION_START_TIMEOUT_MS = 15_000;
/**
 * A started session whose capture source hasn't started by then (`audiostart`) is aborted with a message: the
 * browser's `start` only says the recognizer is set up. `audiostart` itself is no proof of audio: in WebKit it is the
 * capture source's `sourceStarted`, sent also for a capture that never delivers a sample (docs/fork/voice-chat.md).
 */
export const RECOGNITION_AUDIO_TIMEOUT_MS = 4_000;
/** A stopped session that hasn't ended by then is aborted, so it can't stay "listening". */
export const RECOGNITION_STOP_TIMEOUT_MS = 3_000;

// Events logged for the diagnostic log only (the hook acts on start, audiostart, result, error and end).
const LOGGED_EVENTS = [
	"start",
	"audiostart",
	"soundstart",
	"speechstart",
	"speechend",
	"soundend",
	"audioend",
	"nomatch",
	"end",
];

// After the user's own stop these only mean "nothing more was said".
const QUIET_AFTER_STOP_ERRORS = new Set(["no-speech", "aborted"]);

function describeRecognitionError(error: string): string {
	if (error === "not-allowed" || error === "service-not-allowed") {
		return "Microphone access was denied.";
	}
	if (error === "audio-capture") {
		return "The microphone isn't available (none found, or something else is using it).";
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

// Safari's capture source failed while running: WebKit's capture unit got no audio from the microphone for 20 s
// (CoreAudioCaptureUnit::verifyIsCapturing), and the next session sets the microphone up anew.
const CAPTURE_STOPPED_MESSAGE = "The microphone delivered no audio. Tap the mic to try again.";
// After the user's own stop with nothing recognised: Safari's "No speech detected" is the Speech framework's own error
// for a task that got no speech, which is also what a microphone delivering no audio looks like.
const NOTHING_HEARD_MESSAGE = "Nothing was heard. Tap the mic to try again.";

function describeSessionError(code: string, message: string | undefined): string {
	if (code === "audio-capture" && message === "Source is stopped") {
		return CAPTURE_STOPPED_MESSAGE;
	}
	return describeRecognitionError(code);
}

const START_TIMEOUT_MESSAGE = "Speech recognition didn't start. Tap the mic to try again.";
const NO_AUDIO_MESSAGE = "The microphone didn't open, so nothing was heard. Tap the mic to try again.";

// "opening": the recognizer has started, its microphone hasn't delivered audio yet.
type RecognitionStatus = "idle" | "starting" | "opening" | "listening";

let nextSessionNumber = 1;

interface RecognitionSession {
	recognition: SpeechRecognitionLike;
	/** Its number in the diagnostic log. */
	number: number;
	/** The browser's `start` event came. */
	started: boolean;
	/** The capture source started (`audiostart`, or a first result from a browser without that event). */
	hearing: boolean;
	stopRequested: boolean;
	/** Length of the session's result list at its last result event. */
	resultCount: number;
	/** Results before this index were cleared (clear()): they are never shown or kept. */
	clearedBefore: number;
	/** Finals that only repeat the final before them (Safari on a stop), left out of the transcript. */
	repeatedFinals: RepeatedFinalFilter;
	/** Something was recognised (a result with text). */
	heardSomething: boolean;
	/** When start() was called, for the log's start and audiostart lines. */
	startCalledAt: number;
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
	/** True only between the session's `audiostart` and its `end` (or error): the microphone really delivers audio. */
	listening: boolean;
	/** start() was called and the microphone doesn't deliver audio yet. */
	starting: boolean;
	transcript: SpeechTranscript;
	error: string | null;
	/**
	 * Starts a new recognition at once, so call it from the user's tap; the previous transcript is dropped, and a
	 * session still live on the page is aborted first.
	 */
	start: () => void;
	/** Stops listening; the recognizer still delivers the final text of what was already heard. */
	stop: () => void;
	/**
	 * Clears the transcript and the error only: a session keeps listening, and what it hears from now on fills the
	 * empty transcript. Ending the session here would make the next start wait for the browser to end it.
	 */
	clear: () => void;
	/** Ends the session without its results and clears the transcript. */
	reset: () => void;
}

/**
 * Speech in through the browser's SpeechRecognition (continuous, with interim results for the preview). The state
 * follows the session's own events: "listening" only once its microphone delivers audio. A session this hook drops
 * (reset, unmount, a new start) is aborted and stays the page's live session until its `end` (live-recognition.ts),
 * so a reopened bar can abort it too. Every event goes to the diagnostic log (voice-debug-log.ts).
 */
export function useSpeechRecognition(): SpeechRecognitionControls {
	const [supported] = useState(() => getSpeechRecognitionConstructor() !== null);
	const [status, setStatus] = useState<RecognitionStatus>("idle");
	const [transcript, setTranscript] = useState<SpeechTranscript>(EMPTY_TRANSCRIPT);
	const [error, setError] = useState<string | null>(null);
	const sessionRef = useRef<RecognitionSession | null>(null);

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
			logVoiceEvent("gave up", message ?? "stopped session didn't end", session.number);
			finish(session, message);
			session.recognition.abort();
		},
		[finish],
	);

	// Ends this hook's session without its results.
	const dropSession = useCallback((reason: string) => {
		const session = sessionRef.current;
		if (session) {
			sessionRef.current = null;
			clearSessionTimer(session);
			logVoiceEvent("abort()", reason, session.number);
			session.recognition.abort();
		}
	}, []);

	const launch = useCallback(
		(Recognition: SpeechRecognitionConstructor) => {
			const recognition = new Recognition();
			const session: RecognitionSession = {
				recognition,
				number: nextSessionNumber++,
				started: false,
				hearing: false,
				stopRequested: false,
				resultCount: 0,
				clearedBefore: 0,
				repeatedFinals: new RepeatedFinalFilter(),
				heardSomething: false,
				startCalledAt: Date.now(),
				timer: null,
			};
			const isCurrent = () => sessionRef.current === session;
			// Listeners, not the on* handlers: they keep logging after the hook dropped the session.
			// start and audiostart carry the time since start(): on iOS a capture that worked took about 200 ms or
			// more to start, one that never delivered audio about 50 ms (user's log, 2026-10-12).
			for (const type of LOGGED_EVENTS) {
				recognition.addEventListener(type, () => {
					const sinceStart =
						type === "start" || type === "audiostart" ? `+${Date.now() - session.startCalledAt} ms` : null;
					logVoiceEvent(type, sinceStart, session.number);
				});
			}
			recognition.addEventListener("result", (event) => {
				const { results } = event as SpeechRecognitionResultEventLike;
				const all = Array.from({ length: results.length }, (_, index) => results[index]);
				const finals = all.filter((result) => result?.isFinal).length;
				const last = all.at(-1)?.[0]?.transcript ?? "";
				logVoiceEvent("result", `${results.length} (${finals} final) "${last}"`, session.number);
			});
			recognition.addEventListener("error", (event) => {
				const { error: code, message } = event as SpeechRecognitionErrorLike;
				logVoiceEvent("error", message ? `${code}: ${message}` : code, session.number);
			});
			// From the browser's `start` until its microphone delivers audio.
			const hear = () => {
				if (session.hearing) {
					return;
				}
				session.hearing = true;
				clearSessionTimer(session);
				setStatus("listening");
			};
			recognition.continuous = true;
			recognition.interimResults = true;
			recognition.lang = typeof navigator === "undefined" ? "" : navigator.language;
			recognition.onstart = () => {
				if (!isCurrent()) {
					return;
				}
				session.started = true;
				clearSessionTimer(session);
				if (session.hearing) {
					return;
				}
				setStatus("opening");
				session.timer = setTimeout(() => giveUp(session, NO_AUDIO_MESSAGE), RECOGNITION_AUDIO_TIMEOUT_MS);
			};
			recognition.onaudiostart = () => {
				if (isCurrent()) {
					hear();
				}
			};
			recognition.onresult = (event) => {
				if (!isCurrent()) {
					return;
				}
				hear();
				session.resultCount = event.results.length;
				session.repeatedFinals.observe(event.results);
				// A list shorter than the cleared part is a new one: the browser didn't keep the session's results.
				if (session.resultCount < session.clearedBefore) {
					session.clearedBefore = 0;
				}
				const next = readSpeechTranscript(event.results, session.clearedBefore, session.repeatedFinals.skipped);
				if (next.finalText || next.interimText) {
					session.heardSomething = true;
				}
				setTranscript(next);
			};
			recognition.onerror = (event) => {
				if (!isCurrent()) {
					return;
				}
				// The browser ends the session after an error; the state doesn't wait for that `end`.
				if (session.stopRequested && QUIET_AFTER_STOP_ERRORS.has(event.error)) {
					finish(session, session.heardSomething ? null : NOTHING_HEARD_MESSAGE);
					return;
				}
				finish(session, describeSessionError(event.error, event.message));
			};
			recognition.onend = () => {
				releaseRecognition(recognition);
				finish(session, null);
			};
			sessionRef.current = session;
			holdRecognition(recognition);
			session.timer = setTimeout(() => giveUp(session, START_TIMEOUT_MESSAGE), RECOGNITION_START_TIMEOUT_MS);
			logVoiceEvent("start()", `lang ${recognition.lang || "(none)"}`, session.number);
			try {
				recognition.start();
			} catch (startError) {
				const text = startError instanceof Error ? `${startError.name}: ${startError.message}` : String(startError);
				logVoiceEvent("start() threw", text, session.number);
				releaseRecognition(recognition);
				finish(session, describeRecognitionError(text));
			}
		},
		[finish, giveUp],
	);

	const start = useCallback(() => {
		const Recognition = getSpeechRecognitionConstructor();
		if (!Recognition) {
			return;
		}
		dropSession("a new start");
		// A session an earlier bar left (closed while it was ending): the browser would end it for the new one anyway.
		if (abortLiveRecognition()) {
			logVoiceEvent("abort()", "the page's previous session, for a new start");
		}
		setTranscript(EMPTY_TRANSCRIPT);
		setError(null);
		setStatus("starting");
		// Still inside the user's tap: nothing may wait before the browser's start().
		launch(Recognition);
	}, [dropSession, launch]);

	const stop = useCallback(() => {
		const session = sessionRef.current;
		if (!session?.started) {
			// Not started yet: cancel the start.
			dropSession("stopped before the browser started it");
			setStatus("idle");
			return;
		}
		if (session.stopRequested) {
			return;
		}
		session.stopRequested = true;
		clearSessionTimer(session);
		logVoiceEvent("stop()", null, session.number);
		session.recognition.stop();
		session.timer = setTimeout(() => giveUp(session, null), RECOGNITION_STOP_TIMEOUT_MS);
	}, [dropSession, giveUp]);

	const clear = useCallback(() => {
		const session = sessionRef.current;
		if (session) {
			session.clearedBefore = session.resultCount;
		}
		setTranscript(EMPTY_TRANSCRIPT);
		setError(null);
	}, []);

	const reset = useCallback(() => {
		dropSession("reset");
		setStatus("idle");
		setTranscript(EMPTY_TRANSCRIPT);
		setError(null);
	}, [dropSession]);

	useEffect(() => () => dropSession("the voice bar closed"), [dropSession]);

	return {
		supported,
		listening: status === "listening",
		starting: status === "starting" || status === "opening",
		transcript,
		error,
		start,
		stop,
		clear,
		reset,
	};
}
