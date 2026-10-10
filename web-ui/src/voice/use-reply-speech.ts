import { readTurnFinalMessage } from "@runtime-turn-final-message";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useBooleanLocalStorageValue, useLatest } from "@/utils/react-use";
import { toSpeakableText } from "@/voice/speakable-text";
import { getSpeechSynthesis } from "@/voice/speech-apis";

/** A turn end must hold this long before it is read (some agents flip to Review for a moment mid-turn). */
export const REPLY_SETTLE_MS = 1500;

const SPEAK_REPLIES_KEY_PREFIX = "kanban.voice-chat.speak-replies:";

export function getSpeakRepliesStorageKey(taskId: string): string {
	return `${SPEAK_REPLIES_KEY_PREFIX}${taskId}`;
}

/** Identifies one ended turn: the same message in a later turn is read again. */
function readTurnEnd(summary: RuntimeTaskSessionSummary | null): { key: string; message: string } | null {
	const message = readTurnFinalMessage(summary);
	if (!summary || !message) {
		return null;
	}
	return { key: `${summary.stateChangedAt ?? summary.updatedAt}:${message}`, message };
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
	const handledRef = useRef<{ taskId: string; key: string | null } | null>(null);
	const enabledRef = useLatest(enabled);

	const stop = useCallback(() => {
		if (utteranceRef.current) {
			utteranceRef.current = null;
			getSpeechSynthesis()?.cancel();
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
			const finish = () => {
				if (utteranceRef.current === utterance) {
					utteranceRef.current = null;
					setSpeaking(false);
				}
			};
			utterance.onend = finish;
			utterance.onerror = finish;
			utteranceRef.current = utterance;
			setSpeaking(true);
			synthesis.speak(utterance);
		},
		[stop],
	);

	const turnEnd = readTurnEnd(summary);
	const turnEndKey = turnEnd?.key ?? null;
	const turnEndMessage = turnEnd?.message ?? null;
	const hasSummary = summary !== null;

	useEffect(() => {
		if (!hasSummary) {
			return;
		}
		if (handledRef.current?.taskId !== taskId) {
			handledRef.current = { taskId, key: turnEndKey };
			return;
		}
		if (!turnEndKey || !turnEndMessage || turnEndKey === handledRef.current.key) {
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

	return { supported, enabled, setEnabled, speaking, stop };
}
