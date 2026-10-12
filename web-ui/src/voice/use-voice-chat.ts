import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { type ReplySpeechControls, useReplySpeech } from "@/voice/use-reply-speech";
import { useVoiceDebugLog, type VoiceDebugLogControls } from "@/voice/use-voice-debug-log";
import { useVoiceInput, type VoiceInputControls } from "@/voice/use-voice-input";

export interface VoiceChatControls {
	voiceInput: VoiceInputControls;
	replySpeech: ReplySpeechControls;
	/** The diagnostic log panel (a long press on the mic, or `?voiceDebug=1`). */
	debugLog: VoiceDebugLogControls;
	/** The browser has speech in, speech out, or both. */
	supported: boolean;
	/** Listening, or the browser still starting the session: the mic stops either. */
	micActive: boolean;
	/** The preview shows: listening, or dictated text waits to be sent. */
	hasPreview: boolean;
	/**
	 * Send (and on a phone Enter) does something now: sends the dictated text, or while the mic is on stops it and sends
	 * what it heard (or only stops it when it heard nothing).
	 */
	canSend: boolean;
	startListening: () => void;
	stopListening: () => void;
	send: () => void;
	discard: () => void;
}

/**
 * Voice chat for an agent session (docs/fork/voice-chat.md): speech in through an editable preview, replies read
 * aloud. Shared by the desktop voice bar and the phone's touch bar, which lay the same controls out differently.
 */
export function useVoiceChat(
	workspaceId: string | null,
	taskId: string,
	summary: RuntimeTaskSessionSummary | null,
): VoiceChatControls {
	const voiceInput = useVoiceInput(workspaceId, taskId);
	const replySpeech = useReplySpeech(taskId, summary);
	const debugLog = useVoiceDebugLog();
	const micActive = voiceInput.listening || voiceInput.starting;
	return {
		voiceInput,
		replySpeech,
		debugLog,
		supported: voiceInput.supported || replySpeech.supported,
		micActive,
		hasPreview: voiceInput.listening || voiceInput.previewText.length > 0,
		canSend: !voiceInput.isSending && (micActive || voiceInput.draft.trim().length > 0),
		// Called from the mic's tap: everything up to the recognizer's start() runs inside it.
		startListening: () => {
			// The user talking ends whatever is being read out, before the microphone opens (on iOS a synthesizer that
			// speaks can keep the audio session).
			replySpeech.stop();
			voiceInput.startListening();
		},
		stopListening: voiceInput.stopListening,
		send: () => {
			replySpeech.stop();
			void voiceInput.send();
		},
		discard: voiceInput.discard,
	};
}
