// Fakes of the browser's Web Speech APIs for the voice chat tests (jsdom has neither).
import type {
	SpeechRecognitionErrorLike,
	SpeechRecognitionLike,
	SpeechRecognitionResultEventLike,
} from "@/voice/speech-apis";

export interface FakeResult {
	transcript: string;
	isFinal: boolean;
}

function toResultList(results: FakeResult[]): SpeechRecognitionResultList {
	const list = results.map((result) => {
		const alternative = { transcript: result.transcript, confidence: 0.9 };
		return Object.assign([alternative], { isFinal: result.isFinal, item: () => alternative });
	});
	return Object.assign(list, { item: (index: number) => list[index] }) as unknown as SpeechRecognitionResultList;
}

/**
 * A fake recognizer that behaves as Chromium's and WebKit's do (docs/fork/voice-chat.md): abort() and stop() only ask
 * for the end (the test sends it with emitEnd(), as the browser does later), and one session at a time: start() while
 * another session hasn't ended ends that one first, with an `aborted` error and its `end` ("Another request is
 * started" in WebKit). Every event goes to the on* handler and to addEventListener listeners, as in a browser.
 * `start` and `audiostart` are separate events: emitStart() sends both unless told the capture source doesn't start.
 * `audiostart` is WebKit's capture source `sourceStarted`, not proof of audio: a session whose capture delivers
 * nothing still gets it, then no result, and Safari ends it with emitNoSpeechAfterStop() on the user's stop.
 * emitHypothesis()/emitFinal() build the result list as WebKit's SpeechRecognition::didReceiveResult does: every
 * final is appended at a new index and the current hypothesis sits after the finals, so a final the Speech framework
 * reports twice (Safari on a stop) is two final results with the same text.
 */
export class FakeSpeechRecognition extends EventTarget implements SpeechRecognitionLike {
	static instances: FakeSpeechRecognition[] = [];
	/** The session the page's recognizer is serving, from start() until its end. */
	static live: FakeSpeechRecognition | null = null;
	continuous = false;
	interimResults = false;
	lang = "";
	onstart: ((event: Event) => void) | null = null;
	onaudiostart: ((event: Event) => void) | null = null;
	onresult: ((event: SpeechRecognitionResultEventLike) => void) | null = null;
	onerror: ((event: SpeechRecognitionErrorLike) => void) | null = null;
	onend: ((event: Event) => void) | null = null;
	started = false;
	stopped = false;
	aborted = false;
	ended = false;
	/** The finals so far, as WebKit keeps them (m_finalResults). */
	private finals: string[] = [];

	constructor() {
		super();
		FakeSpeechRecognition.instances.push(this);
	}

	static reset(): void {
		FakeSpeechRecognition.instances = [];
		FakeSpeechRecognition.live = null;
	}

	/** Ends every session that hasn't ended, so no test leaves the page's live session to the next one. */
	static endAll(): void {
		for (const instance of FakeSpeechRecognition.instances) {
			if (!instance.ended) {
				instance.emitEnd();
			}
		}
	}

	static latest(): FakeSpeechRecognition {
		const instance = FakeSpeechRecognition.instances.at(-1);
		if (!instance) {
			throw new Error("No SpeechRecognition was created.");
		}
		return instance;
	}

	start(): void {
		this.started = true;
		const live = FakeSpeechRecognition.live;
		if (live && live !== this && !live.ended) {
			live.emitError("aborted", "Another request is started");
			live.emitEnd();
		}
		FakeSpeechRecognition.live = this;
	}

	stop(): void {
		this.stopped = true;
	}

	abort(): void {
		this.aborted = true;
	}

	private fire<E extends Event>(event: E, handler: ((event: E) => void) | null): void {
		this.dispatchEvent(event);
		handler?.(event);
	}

	/**
	 * The browser's `start` (the recognizer is set up) and, unless `audio` is false, its `audiostart` (the capture
	 * source started, whether or not it ever delivers audio).
	 */
	emitStart({ audio = true }: { audio?: boolean } = {}): void {
		if (FakeSpeechRecognition.live !== this) {
			throw new Error("Only the page's live session starts.");
		}
		this.fire(new Event("start"), this.onstart);
		if (audio) {
			this.emitAudioStart();
		}
	}

	emitAudioStart(): void {
		this.fire(new Event("audiostart"), this.onaudiostart);
	}

	emitResults(results: FakeResult[]): void {
		const event = Object.assign(new Event("result"), { resultIndex: 0, results: toResultList(results) });
		this.fire(event, this.onresult);
	}

	/** WebKit's interim result: the finals so far plus the hypothesis after them. */
	emitHypothesis(transcript: string): void {
		this.emitResults([
			...this.finals.map((text) => ({ transcript: text, isFinal: true })),
			{ transcript, isFinal: false },
		]);
	}

	/** WebKit's final result: appended at a new index, the hypothesis gone. */
	emitFinal(transcript: string): void {
		this.finals.push(transcript);
		this.emitResults(this.finals.map((text) => ({ transcript: text, isFinal: true })));
	}

	/**
	 * Safari's end of a stopped session whose Speech framework task got no speech: `didFinishSuccessfully:NO` with the
	 * framework's "No speech detected", sent as an `aborted` error, then `end`. A capture that delivered no audio
	 * ends this way too, though the user spoke (user's log, 2026-10-12).
	 */
	emitNoSpeechAfterStop(): void {
		this.emitError("aborted", "No speech detected");
		this.emitEnd();
	}

	emitError(error: string, message = ""): void {
		this.fire(Object.assign(new Event("error"), { error, message }), this.onerror);
	}

	emitEnd(): void {
		if (this.ended) {
			return;
		}
		this.ended = true;
		if (FakeSpeechRecognition.live === this) {
			FakeSpeechRecognition.live = null;
		}
		this.fire(new Event("end"), this.onend);
	}
}

export class FakeUtterance {
	lang = "";
	volume = 1;
	onstart: (() => void) | null = null;
	onend: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(readonly text: string) {}
}

export function createFakeSpeechSynthesis() {
	const spoken: FakeUtterance[] = [];
	const synthesis = {
		spoken,
		/** As the browser's: true from speak() until the queue is done or cancel(). */
		speaking: false,
		pending: false,
		speak: (utterance: FakeUtterance) => {
			spoken.push(utterance);
			synthesis.speaking = true;
		},
		cancel: () => {
			synthesis.speaking = false;
		},
		resume: () => {},
	};
	return synthesis;
}
