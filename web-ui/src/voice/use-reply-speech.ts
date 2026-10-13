import { readTurnEnd } from "@runtime-turn-final-message";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useBooleanLocalStorageValue, useLatest } from "@/utils/react-use";
import { toSpeakableText } from "@/voice/speakable-text";
import { getSpeechSynthesis } from "@/voice/speech-apis";
import { logVoiceEvent } from "@/voice/voice-debug-log";

/** A turn end must hold this long before it is read (some agents flip to Review for a moment mid-turn). */
export const REPLY_SETTLE_MS = 1500;

const SPEAK_REPLIES_KEY_PREFIX = "kanban.voice-chat.speak-replies:";

export function getSpeakRepliesStorageKey(taskId: string): string {
	return `${SPEAK_REPLIES_KEY_PREFIX}${taskId}`;
}

/**
 * Some browsers (Safari, Chrome on some Android builds) speak only after a speak() from a user gesture: an empty
 * utterance from the click that turns the speaker on unlocks the later replies.
 */
function primeSpeechSynthesis(synthesis: SpeechSynthesis): void {
	const utterance = new SpeechSynthesisUtterance("");
	utterance.volume = 0;
	synthesis.speak(utterance);
}

export interface ReplySpeechControls {
	supported: boolean;
	enabled: boolean;
	setEnabled: (enabled: boolean) => void;
	speaking: boolean;
	stop: () => void;
}

/**
 * Speech out: reads the session's final message aloud when a turn ends, while the session's toggle is on. Only turns
 * that end while the panel is open are read, never the reply that was there when it opened.
 */
export function useReplySpeech(taskId: string, summary: RuntimeTaskSessionSummary | null): ReplySpeechControls {
	const [supported] = useState(() => getSpeechSynthesis() !== null);
	const [enabled, setEnabled] = useBooleanLocalStorageValue(getSpeakRepliesStorageKey(taskId), false);
	const [speaking, setSpeaking] = useState(false);
	const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
	// The last turn end seen per session; the first one seen is the reply that was there when the panel opened.
	const handledRef = useRef<{ taskId: string; key: number | null } | null>(null);
	const enabledRef = useLatest(enabled);

	// Also cancels what the synthesizer still says without an utterance of ours (the silent primer, or a reply whose
	// `end` never came): on iOS a synthesizer that speaks can keep the audio session from the microphone.
	const stop = useCallback(() => {
		const synthesis = getSpeechSynthesis();
		if (utteranceRef.current || synthesis?.speaking || synthesis?.pending) {
			utteranceRef.current = null;
			logVoiceEvent("speech cancel()", synthesis?.speaking ? "was speaking" : null);
			synthesis?.cancel();
		}
		setSpeaking(false);
	}, []);

	const speak = useCallback(
		(text: string) => {
			const synthesis = getSpeechSynthesis();
			if (!synthesis || !text) {
				return;
			}
			stop();
			const utterance = new SpeechSynthesisUtterance(text);
			utterance.lang = typeof navigator === "undefined" ? "" : navigator.language;
			const finish = (event?: Event) => {
				const code = (event as (Event & { error?: string }) | undefined)?.error;
				logVoiceEvent(event?.type === "error" ? "speech error" : "speech end", code ?? null);
				if (utteranceRef.current === utterance) {
					utteranceRef.current = null;
					setSpeaking(false);
				}
			};
			// speak() only queues: `start` is when audio really plays, which on iOS changes the audio session.
			utterance.onstart = () => logVoiceEvent("speech start");
			utterance.onend = finish;
			utterance.onerror = finish;
			utteranceRef.current = utterance;
			setSpeaking(true);
			// Chrome can leave the synthesizer paused (a backgrounded tab), and then speak() only queues.
			synthesis.resume();
			logVoiceEvent("speech speak()", `${text.length} chars`);
			synthesis.speak(utterance);
		},
		[stop],
	);

	// Called from the toggle's click, so turning the speaker on is the user gesture that unlocks speech.
	const setSpeakReplies = useCallback(
		(next: boolean) => {
			const synthesis = getSpeechSynthesis();
			if (next && synthesis) {
				primeSpeechSynthesis(synthesis);
			}
			setEnabled(next);
		},
		[setEnabled],
	);

	const turnEnd = readTurnEnd(summary);
	// One key per ended turn (when it ended): the same message in a later turn is read again.
	const turnEndKey = turnEnd?.at ?? null;
	const turnEndMessage = turnEnd?.finalMessage ?? null;
	const hasSummary = summary !== null;

	useEffect(() => {
		if (!hasSummary) {
			return;
		}
		if (handledRef.current?.taskId !== taskId) {
			handledRef.current = { taskId, key: turnEndKey };
			return;
		}
		if (turnEndKey === null || !turnEndMessage || turnEndKey === handledRef.current.key) {
			return;
		}
		const timer = setTimeout(() => {
			handledRef.current = { taskId, key: turnEndKey };
			if (enabledRef.current) {
				speak(toSpeakableText(turnEndMessage));
			}
		}, REPLY_SETTLE_MS);
		return () => clearTimeout(timer);
	}, [enabledRef, hasSummary, speak, taskId, turnEndKey, turnEndMessage]);

	useEffect(() => {
		if (!enabled) {
			stop();
		}
	}, [enabled, stop]);

	// Another session in the same panel, or the panel closing, ends what this one was saying.
	useEffect(() => stop, [stop, taskId]);

	return { supported, enabled, setEnabled: setSpeakReplies, speaking, stop };
}
