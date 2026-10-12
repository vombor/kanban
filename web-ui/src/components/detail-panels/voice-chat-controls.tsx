import { Mic, MicOff, SendHorizontal, X } from "lucide-react";
import type { KeyboardEvent, PointerEvent, ReactElement } from "react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { VoiceChatControls } from "@/voice/use-voice-chat";

// The voice chat controls both layouts share: the desktop voice bar
// (voice-chat-bar.tsx) and the phone's touch bar (terminal-touch-bar.tsx).

/** A mouse press held at least this long is push-to-talk: releasing it stops listening. */
export const PUSH_TO_TALK_HOLD_MS = 400;

interface MicPress {
	startedAt: number;
	pointerType: string;
}

export function VoiceMicButton({ voice }: { voice: VoiceChatControls }): ReactElement {
	const micPressRef = useRef<MicPress | null>(null);
	const { micActive } = voice;

	// Tap toggles; a mouse press held past PUSH_TO_TALK_HOLD_MS listens until it is released.
	const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		if (micActive) {
			micPressRef.current = null;
			voice.stopListening();
			return;
		}
		event.currentTarget.setPointerCapture?.(event.pointerId);
		micPressRef.current = { startedAt: Date.now(), pointerType: event.pointerType };
		voice.startListening();
	};

	const handlePointerUp = () => {
		const press = micPressRef.current;
		micPressRef.current = null;
		if (press && press.pointerType !== "touch" && Date.now() - press.startedAt >= PUSH_TO_TALK_HOLD_MS) {
			voice.stopListening();
		}
	};

	const label = micActive ? "Stop listening" : "Talk to the agent";
	return (
		<Tooltip side="top" content={label}>
			<button
				type="button"
				aria-label={label}
				aria-pressed={micActive}
				onPointerDown={handlePointerDown}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerUp}
				// A tap must not take the terminal's focus (and close the phone's keyboard).
				onMouseDown={(event) => event.preventDefault()}
				// Pointer presses are handled above; a click without a pointer is the keyboard.
				onClick={(event) => {
					if (event.detail === 0) {
						if (micActive) {
							voice.stopListening();
						} else {
							voice.startListening();
						}
					}
				}}
				className={cn(
					"inline-flex size-11 shrink-0 cursor-pointer touch-none select-none items-center justify-center rounded-full border",
					micActive
						? "animate-pulse border-status-red/50 bg-status-red/15 text-status-red"
						: "border-border-bright bg-surface-2 text-text-primary hover:bg-surface-3 active:bg-surface-4",
				)}
			>
				{micActive ? <MicOff size={18} /> : <Mic size={18} />}
			</button>
		</Tooltip>
	);
}

/**
 * The editable preview of what was dictated, with its discard (X) and, on desktop, its send button. On a phone the
 * touch bar's Enter sends it instead.
 */
export function VoicePreview({
	voice,
	showSend,
}: {
	voice: VoiceChatControls;
	showSend: boolean;
}): ReactElement | null {
	const { voiceInput } = voice;
	if (!voice.hasPreview) {
		return null;
	}

	const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			voice.send();
		} else if (event.key === "Escape") {
			event.preventDefault();
			voice.discard();
		}
	};

	return (
		<div className="flex items-end gap-2">
			<textarea
				aria-label="Voice message"
				value={voiceInput.previewText}
				readOnly={voiceInput.listening}
				placeholder={voiceInput.listening ? "Listening…" : undefined}
				onChange={(event) => voiceInput.setDraft(event.target.value)}
				onKeyDown={handleKeyDown}
				rows={2}
				className={cn(
					"min-h-11 flex-1 resize-none rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none",
					voiceInput.listening && "text-text-secondary",
				)}
			/>
			<div className="flex flex-col gap-1">
				{showSend ? (
					<Button
						variant="primary"
						size="md"
						icon={voiceInput.isSending ? <Spinner size={14} /> : <SendHorizontal size={16} />}
						aria-label="Send voice message"
						disabled={!voice.canSend}
						onClick={voice.send}
					/>
				) : null}
				<Button
					variant="ghost"
					size="md"
					icon={<X size={16} />}
					aria-label="Discard voice message"
					// Keeps the focus (on a phone the terminal's, and its keyboard open).
					onMouseDown={(event) => event.preventDefault()}
					onPointerDown={(event) => event.preventDefault()}
					onClick={voice.discard}
				/>
			</div>
		</div>
	);
}

export function VoiceError({ voice }: { voice: VoiceChatControls }): ReactElement | null {
	return voice.voiceInput.error ? <div className="text-xs text-status-red">{voice.voiceInput.error}</div> : null;
}

// `showReading`: also says a reply is being read (the phone's speaker button stops it).
export function VoiceStatus({
	voice,
	showReading = false,
}: {
	voice: VoiceChatControls;
	showReading?: boolean;
}): ReactElement {
	const { voiceInput, replySpeech } = voice;
	return (
		<span className="min-w-0 flex-1 truncate text-xs text-text-tertiary">
			{voiceInput.listening
				? "Listening…"
				: voiceInput.starting
					? "Starting…"
					: showReading && replySpeech.speaking
						? "Reading the reply…"
						: null}
		</span>
	);
}
