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

export class FakeSpeechRecognition extends EventTarget implements SpeechRecognitionLike {
	static instances: FakeSpeechRecognition[] = [];
	continuous = false;
	interimResults = false;
	lang = "";
	onresult: ((event: SpeechRecognitionResultEventLike) => void) | null = null;
	onerror: ((event: SpeechRecognitionErrorLike) => void) | null = null;
	onend: ((event: Event) => void) | null = null;
	started = false;
	stopped = false;
	aborted = false;

	constructor() {
		super();
		FakeSpeechRecognition.instances.push(this);
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
	}

	stop(): void {
		this.stopped = true;
	}

	abort(): void {
		this.aborted = true;
	}

	emitResults(results: FakeResult[]): void {
		const event = Object.assign(new Event("result"), { resultIndex: 0, results: toResultList(results) });
		this.onresult?.(event);
	}

	emitError(error: string): void {
		this.onerror?.(Object.assign(new Event("error"), { error }));
	}

	emitEnd(): void {
		this.onend?.(new Event("end"));
	}
}

export class FakeUtterance {
	lang = "";
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
	};
}
