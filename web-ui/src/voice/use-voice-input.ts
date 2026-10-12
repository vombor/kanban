import { useCallback, useEffect, useRef, useState } from "react";

import { useLatest } from "@/utils/react-use";
import { sendVoiceInput } from "@/voice/send-voice-input";
import { useSpeechRecognition } from "@/voice/use-speech-recognition";
import { logVoiceEvent } from "@/voice/voice-debug-log";

/**
 * Send while listening stops the mic and waits this long for the final text of what is being said; then it sends
 * what the preview shows (the words not yet final included) and drops the session.
 */
export const SEND_FINAL_WAIT_MS = 1_500;

function joinText(...parts: string[]): string {
	return parts
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join(" ");
}

export interface VoiceInputControls {
	supported: boolean;
	listening: boolean;
	/** The browser is starting the session (the mic button stops that too). */
	starting: boolean;
	/** What the preview shows: the draft, and while listening what is being heard. */
	previewText: string;
	/** The editable draft (final text only), set once listening stops. */
	draft: string;
	setDraft: (draft: string) => void;
	/** Sending, or waiting for the final text of a send while listening. */
	isSending: boolean;
	error: string | null;
	startListening: () => void;
	stopListening: () => void;
	discard: () => void;
	/** Discards and stops listening (the session is aborted, nothing it heard is kept). */
	cancel: () => void;
	/**
	 * Sends the draft. While listening it first stops the mic and sends once the final text is in (at most
	 * SEND_FINAL_WAIT_MS); with nothing heard it only stops listening. False when nothing was sent.
	 */
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
	// A send while listening: it goes out when the session ends (or its wait runs out).
	const pendingSendRef = useRef<((sent: boolean) => void) | null>(null);
	const [finishing, setFinishing] = useState(false);
	// The draft as it was when listening started; what is heard is appended to it.
	const baseDraftRef = useRef("");
	const wasListeningRef = useRef(false);
	const { listening, starting, transcript } = recognition;
	const transcriptRef = useLatest(transcript);

	const deliver = useCallback(
		async (text: string) => {
			setIsSending(true);
			setSendError(null);
			const result = await sendVoiceInput(workspaceId, taskId, text);
			setIsSending(false);
			if (!result.ok) {
				setDraft(text);
				setSendError(result.message);
				return false;
			}
			setDraft("");
			return true;
		},
		[taskId, workspaceId],
	);

	// Sends the pending send's text; with no text the mic only stopped. `text` null: the send is cancelled.
	const settlePendingSend = useCallback(
		(text: string | null) => {
			const resolve = pendingSendRef.current;
			pendingSendRef.current = null;
			setFinishing(false);
			if (!resolve) {
				return;
			}
			if (!text) {
				resolve(false);
				return;
			}
			void deliver(text).then(resolve);
		},
		[deliver],
	);

	useEffect(() => {
		if (wasListeningRef.current && !listening) {
			const text = joinText(baseDraftRef.current, transcript.finalText);
			setDraft(text);
			settlePendingSend(text);
		}
		wasListeningRef.current = listening;
	}, [listening, settlePendingSend, transcript.finalText]);

	// The final text didn't come in time: send what the preview shows, and drop the session.
	useEffect(() => {
		if (!finishing) {
			return;
		}
		const timer = setTimeout(() => {
			const { finalText, interimText } = transcriptRef.current;
			const text = joinText(baseDraftRef.current, finalText, interimText);
			logVoiceEvent("send", "the final text didn't come in time, sending the preview");
			wasListeningRef.current = false;
			recognition.reset();
			settlePendingSend(text);
		}, SEND_FINAL_WAIT_MS);
		return () => clearTimeout(timer);
	}, [finishing, recognition.reset, settlePendingSend, transcriptRef]);

	const startListening = useCallback(() => {
		baseDraftRef.current = draft;
		setSendError(null);
		recognition.start();
	}, [draft, recognition.start]);

	// X and Escape: the text goes, and a session still listening goes on into the empty draft.
	const discard = useCallback(() => {
		settlePendingSend(null);
		recognition.clear();
		baseDraftRef.current = "";
		setDraft("");
		setSendError(null);
	}, [recognition.clear, settlePendingSend]);

	// The phone's X: the text goes and the mic stops, without what it heard. On iOS a session can't go on into an empty
	// preview: its one hypothesis grows at the same index until the utterance ends, so clear() would hide everything
	// said after the X too.
	const cancel = useCallback(() => {
		recognition.reset();
		discard();
	}, [discard, recognition.reset]);

	const send = useCallback(async () => {
		if (isSending || pendingSendRef.current) {
			return false;
		}
		if (starting && !listening) {
			// The mic hasn't heard anything yet: stop it, and send what an earlier recording left.
			recognition.stop();
		}
		if (listening) {
			logVoiceEvent("send", "while listening: stop, then send the final text");
			const sent = new Promise<boolean>((resolve) => {
				pendingSendRef.current = resolve;
			});
			setFinishing(true);
			recognition.stop();
			return sent;
		}
		const text = draft.trim();
		return text ? deliver(text) : false;
	}, [deliver, draft, isSending, listening, recognition.stop, starting]);

	// Another session's bar: nothing heard for the previous one may reach it.
	useEffect(() => {
		recognition.reset();
		pendingSendRef.current?.(false);
		pendingSendRef.current = null;
		setFinishing(false);
		wasListeningRef.current = false;
		baseDraftRef.current = "";
		setDraft("");
		setSendError(null);
	}, [recognition.reset, taskId]);

	return {
		supported: recognition.supported,
		listening,
		starting,
		previewText: listening ? joinText(baseDraftRef.current, transcript.finalText, transcript.interimText) : draft,
		draft,
		setDraft,
		isSending: isSending || finishing,
		error: sendError ?? recognition.error,
		startListening,
		stopListening: recognition.stop,
		discard,
		cancel,
		send,
	};
}
