import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { type ReplySpeechControls, useReplySpeech } from "@/voice/use-reply-speech";
import { useVoiceInput, type VoiceInputControls } from "@/voice/use-voice-input";

export interface VoiceChatControls {
	voiceInput: VoiceInputControls;
	replySpeech: ReplySpeechControls;
	/** The browser has speech in, speech out, or both. */
	supported: boolean;
	/** Listening, or the browser still starting the session: the mic stops either. */
	micActive: boolean;
	/** The preview shows: listening, or dictated text waits to be sent. */
	hasPreview: boolean;
	/** The voice message can be sent now (the send button's, and on a phone Enter's, enabled state). */
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
	const micActive = voiceInput.listening || voiceInput.starting;
	return {
		voiceInput,
		replySpeech,
		supported: voiceInput.supported || replySpeech.supported,
		micActive,
		hasPreview: voiceInput.listening || voiceInput.previewText.length > 0,
		canSend: !micActive && !voiceInput.isSending && voiceInput.draft.trim().length > 0,
		startListening: () => {
			// The user talking ends whatever is being read out.
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
