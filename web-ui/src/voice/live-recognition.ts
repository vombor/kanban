import type { SpeechRecognitionLike } from "@/voice/speech-apis";

// The page's one live recognition session, kept from its start() until the browser's `end` event. Kept per page, not
// per hook, because closing the voice bar unmounts the hook while its session is still ending, and the reopened bar is
// a new hook that must end it before it starts its own.
//
// A new start never waits for the old session's end: both engines end the previous session themselves when a new
// one starts (Chromium's SpeechRecognitionManagerImpl::StartSession aborts the other microphone session, WebKit's
// SpeechRecognitionServer::handleRequest aborts its recognizer with "Another request is started"), and a start that
// waited ran from a timer, outside the user's tap (docs/fork/voice-chat.md).

let live: SpeechRecognitionLike | null = null;

/** Records `recognition` as the page's live session until releaseRecognition() is called for it. */
export function holdRecognition(recognition: SpeechRecognitionLike): void {
	live = recognition;
}

/** Called from the session's `end` event: the browser has let go of it. */
export function releaseRecognition(recognition: SpeechRecognitionLike): void {
	if (live === recognition) {
		live = null;
	}
}

/** Aborts the page's live session, if any, and forgets it. True when there was one. */
export function abortLiveRecognition(): boolean {
	const previous = live;
	if (!previous) {
		return false;
	}
	live = null;
	previous.abort();
	return true;
}
