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
 * A fake recognizer that behaves like a phone's: abort() and stop() only ask for the end (the test sends it with
 * emitEnd(), as the browser does later), and one session at a time: a session started while another one hasn't ended
 * is `blocked`, it never starts or hears anything.
 */
export class FakeSpeechRecognition extends EventTarget implements SpeechRecognitionLike {
	static instances: FakeSpeechRecognition[] = [];
	/** The session the page's recognizer is serving, from start() until its end. */
	static live: FakeSpeechRecognition | null = null;
	continuous = false;
	interimResults = false;
	lang = "";
	onstart: ((event: Event) => void) | null = null;
	onresult: ((event: SpeechRecognitionResultEventLike) => void) | null = null;
	onerror: ((event: SpeechRecognitionErrorLike) => void) | null = null;
	onend: ((event: Event) => void) | null = null;
	started = false;
	blocked = false;
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
			this.blocked = true;
			return;
		}
		FakeSpeechRecognition.live = this;
	}

	stop(): void {
		this.stopped = true;
	}

	abort(): void {
		this.aborted = true;
	}

	/** The browser's `start`: it is listening now. A blocked session never gets one. */
	emitStart(): void {
		if (this.blocked) {
			throw new Error("A blocked session never starts.");
		}
		this.onstart?.(new Event("start"));
	}

	emitResults(results: FakeResult[]): void {
		const event = Object.assign(new Event("result"), { resultIndex: 0, results: toResultList(results) });
		this.onresult?.(event);
	}

	emitError(error: string): void {
		this.onerror?.(Object.assign(new Event("error"), { error }));
	}

	emitEnd(): void {
		this.ended = true;
		if (FakeSpeechRecognition.live === this) {
			FakeSpeechRecognition.live = null;
		}
		this.onend?.(new Event("end"));
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
	return {
		spoken,
		speak: (utterance: FakeUtterance) => {
			spoken.push(utterance);
		},
		cancel: () => {},
		resume: () => {},
	};
}
