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
 * `start` and `audiostart` are separate events: emitStart() sends both unless told the microphone stays silent.
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
	 * The browser's `start` (the recognizer is set up) and, unless `audio` is false, its `audiostart` (the
	 * microphone delivers audio). Safari's capture that gets no audio sends `start` and nothing after it.
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
