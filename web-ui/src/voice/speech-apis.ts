// The browser's built-in Web Speech APIs, feature-detected (docs/fork/voice-chat.md). TypeScript's DOM lib has the
// result types but not the recognizer itself (Chrome and Safari ship it as webkitSpeechRecognition, Firefox not at all),
// so the slice voice chat uses is declared here.

export interface SpeechRecognitionErrorLike extends Event {
	readonly error: string;
}

export interface SpeechRecognitionResultEventLike extends Event {
	readonly resultIndex: number;
	readonly results: SpeechRecognitionResultList;
}

export interface SpeechRecognitionLike extends EventTarget {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
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

/** Splits a result list into its final and interim text (best alternative of each result). */
export function readSpeechTranscript(results: SpeechRecognitionResultList): SpeechTranscript {
	const finalParts: string[] = [];
	const interimParts: string[] = [];
	for (let index = 0; index < results.length; index += 1) {
		const result = results[index];
		const transcript = result?.[0]?.transcript ?? "";
		(result?.isFinal ? finalParts : interimParts).push(transcript);
	}
	return { finalText: joinWords(finalParts), interimText: joinWords(interimParts) };
}
