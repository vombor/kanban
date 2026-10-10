import { useCallback, useEffect, useRef, useState } from "react";

import { sendVoiceInput } from "@/voice/send-voice-input";
import { useSpeechRecognition } from "@/voice/use-speech-recognition";

function joinText(...parts: string[]): string {
	return parts
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join(" ");
}

export interface VoiceInputControls {
	supported: boolean;
	listening: boolean;
	/** What the preview shows: the draft, and while listening what is being heard. */
	previewText: string;
	/** The editable draft (final text only), set once listening stops. */
	draft: string;
	setDraft: (draft: string) => void;
	isSending: boolean;
	error: string | null;
	startListening: () => void;
	stopListening: () => void;
	discard: () => void;
	send: () => Promise<boolean>;
}

/**
 * Speech in for one session: listening appends what was said to an editable draft, and only the draft (final results,
 * never interim ones) is sent, through the same delivery as typed input.
 */
export function useVoiceInput(workspaceId: string | null, taskId: string): VoiceInputControls {
	const recognition = useSpeechRecognition();
	const [draft, setDraft] = useState("");
	const [isSending, setIsSending] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);
	// The draft as it was when listening started; what is heard is appended to it.
	const baseDraftRef = useRef("");
	const wasListeningRef = useRef(false);
	const { listening, transcript } = recognition;

	useEffect(() => {
		if (wasListeningRef.current && !listening) {
			setDraft(joinText(baseDraftRef.current, transcript.finalText));
		}
		wasListeningRef.current = listening;
	}, [listening, transcript.finalText]);

	const startListening = useCallback(() => {
		baseDraftRef.current = draft;
		setSendError(null);
		recognition.start();
	}, [draft, recognition.start]);

	const discard = useCallback(() => {
		recognition.reset();
		wasListeningRef.current = false;
		baseDraftRef.current = "";
		setDraft("");
		setSendError(null);
	}, [recognition.reset]);

	const send = useCallback(async () => {
		const text = draft.trim();
		if (!text || listening || isSending) {
			return false;
		}
		setIsSending(true);
		setSendError(null);
		const result = await sendVoiceInput(workspaceId, taskId, text);
		setIsSending(false);
		if (!result.ok) {
			setSendError(result.message);
			return false;
		}
		setDraft("");
		return true;
	}, [draft, isSending, listening, taskId, workspaceId]);

	useEffect(() => {
		discard();
	}, [discard, taskId]);

	return {
		supported: recognition.supported,
		listening,
		previewText: listening ? joinText(baseDraftRef.current, transcript.finalText, transcript.interimText) : draft,
		draft,
		setDraft,
		isSending,
		error: sendError ?? recognition.error,
		startListening,
		stopListening: recognition.stop,
		discard,
		send,
	};
}
