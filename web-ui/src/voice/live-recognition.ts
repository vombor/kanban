import type { SpeechRecognitionLike } from "@/voice/speech-apis";

// The page's one live recognition session, kept from its start() until the browser's `end` event. abort() and stop()
// only ask the browser to end a session: it ends (and lets go of the mic) later, and a phone's recognizer serves one
// session at a time, so a new session started before the old one's `end` can sit "started" and never hear anything
// until the page reloads. Kept per page, not per hook, because closing the voice bar unmounts the hook while its
// session is still ending, and the reopened bar is a new hook.

interface LiveRecognition {
	recognition: SpeechRecognitionLike;
	ended: Promise<void>;
	markEnded: () => void;
}

let live: LiveRecognition | null = null;

/** Records `recognition` as the page's live session until releaseRecognition() is called for it. */
export function holdRecognition(recognition: SpeechRecognitionLike): void {
	let markEnded = () => {};
	const ended = new Promise<void>((resolve) => {
		markEnded = resolve;
	});
	live = { recognition, ended, markEnded };
}

/** Called from the session's `end` event: the browser has let go of it. */
export function releaseRecognition(recognition: SpeechRecognitionLike): void {
	if (live?.recognition === recognition) {
		live.markEnded();
		live = null;
	}
}

/**
 * Null when no session is live (start at once, still inside the user's tap). Otherwise resolves once the live session
 * has ended, or after `timeoutMs`, when it is aborted once more and given up on, so a browser that never sends `end`
 * can't block every later start.
 */
export function waitForRecognitionEnd(timeoutMs: number): Promise<void> | null {
	const waitingFor = live;
	if (!waitingFor) {
		return null;
	}
	return new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			if (live === waitingFor) {
				live = null;
				waitingFor.recognition.abort();
			}
			resolve();
		}, timeoutMs);
		void waitingFor.ended.then(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}
