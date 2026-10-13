// The browser's built-in Web Speech APIs, feature-detected (docs/fork/voice-chat.md). TypeScript's DOM lib has the
// result types but not the recognizer itself (Chrome and Safari ship it as webkitSpeechRecognition, Firefox not at all),
// so the slice voice chat uses is declared here.

export interface SpeechRecognitionErrorLike extends Event {
	readonly error: string;
	/** Safari says why ("Source is muted", "Another request is started"); Chrome sends an empty string. */
	readonly message?: string;
}

export interface SpeechRecognitionResultEventLike extends Event {
	readonly resultIndex: number;
	readonly results: SpeechRecognitionResultList;
}

export interface SpeechRecognitionLike extends EventTarget {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onstart: ((event: Event) => void) | null;
	/**
	 * The capture source started. In WebKit that is the source's `sourceStarted`, which says nothing about samples:
	 * a capture that never delivers audio still sends it (docs/fork/voice-chat.md).
	 */
	onaudiostart: ((event: Event) => void) | null;
	onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
	onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
	onend: ((event: Event) => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechWindow {
	SpeechRecognition?: SpeechRecognitionConstructor;
	webkitSpeechRecognition?: SpeechRecognitionConstructor;
	speechSynthesis?: SpeechSynthesis;
}

function getSpeechWindow(): SpeechWindow | null {
	return typeof window === "undefined" ? null : (window as unknown as SpeechWindow);
}

export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
	const speechWindow = getSpeechWindow();
	return speechWindow?.SpeechRecognition ?? speechWindow?.webkitSpeechRecognition ?? null;
}

export function getSpeechSynthesis(): SpeechSynthesis | null {
	const synthesis = getSpeechWindow()?.speechSynthesis;
	return synthesis && typeof SpeechSynthesisUtterance !== "undefined" ? synthesis : null;
}

export interface SpeechTranscript {
	/** Text the recognizer has settled on: the only text that is ever sent. */
	finalText: string;
	/** Text still being recognized, shown in the preview only. */
	interimText: string;
}

function joinWords(parts: string[]): string {
	return parts
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join(" ");
}

function normalizeTranscript(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Follows one session's result list across its result events and marks the finals that only repeat the final before
 * them. On iOS, Safari forwards every final the Speech framework reports as a new final result
 * (`WebSpeechRecognizerTask`'s `didFinishRecognition`, appended by `SpeechRecognition::didReceiveResult`), and on a
 * stop the framework can report the last utterance's final twice: "Hello hello hello" at index 0, then again at index
 * 1 (user's log, 2026-10-12). A real second utterance is told apart by its interim results: the recognizer
 * hypothesizes it (an interim result at its index) before it settles, while the repeat arrives final at once.
 */
export class RepeatedFinalFilter {
	private readonly interimSeen = new Set<number>();
	private readonly repeated = new Set<number>();

	/** Reads a result event's list; call it for every result event of the session, in order. */
	observe(results: SpeechRecognitionResultList): void {
		for (let index = 0; index < results.length; index += 1) {
			const result = results[index];
			if (!result) {
				continue;
			}
			if (!result.isFinal) {
				this.interimSeen.add(index);
				this.repeated.delete(index);
				continue;
			}
			if (this.interimSeen.has(index) || this.repeated.has(index)) {
				continue;
			}
			const previous = index > 0 ? results[index - 1] : undefined;
			const text = normalizeTranscript(result[0]?.transcript ?? "");
			if (previous?.isFinal && text !== "" && text === normalizeTranscript(previous[0]?.transcript ?? "")) {
				this.repeated.add(index);
			}
		}
	}

	/** Indexes of finals that repeat the final before them, to leave out of the transcript. */
	get skipped(): ReadonlySet<number> {
		return this.repeated;
	}
}

/**
 * Splits a result list into its final and interim text (best alternative of each result), from `fromIndex` on: the
 * results before it were cleared by the user while the session kept listening. Results in `skip` are left out
 * (RepeatedFinalFilter).
 */
export function readSpeechTranscript(
	results: SpeechRecognitionResultList,
	fromIndex = 0,
	skip: ReadonlySet<number> = new Set(),
): SpeechTranscript {
	const finalParts: string[] = [];
	const interimParts: string[] = [];
	for (let index = fromIndex; index < results.length; index += 1) {
		if (skip.has(index)) {
			continue;
		}
		const result = results[index];
		const transcript = result?.[0]?.transcript ?? "";
		(result?.isFinal ? finalParts : interimParts).push(transcript);
	}
	return { finalText: joinWords(finalParts), interimText: joinWords(interimParts) };
}
