import { Mic, MicOff, SendHorizontal, X } from "lucide-react";
import type { KeyboardEvent, PointerEvent, ReactElement } from "react";
import { useEffect, useRef } from "react";

import {
	keepTerminalFocus,
	TOUCH_QUIET_CLASS,
	TOUCH_SQUARE_BUTTON_CLASS,
} from "@/components/detail-panels/touch-bar-buttons";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { usePointerTap } from "@/hooks/use-pointer-tap";
import type { VoiceChatControls } from "@/voice/use-voice-chat";

// The voice chat controls both layouts share: the desktop voice bar
// (voice-chat-bar.tsx) and the phone's touch bar (terminal-touch-bar.tsx).

/** A mouse press held at least this long is push-to-talk: releasing it stops listening. */
export const PUSH_TO_TALK_HOLD_MS = 400;
/** A touch on the mic held this long shows or hides the voice diagnostic log (voice-debug-panel.tsx). */
export const VOICE_DEBUG_HOLD_MS = 1_000;

interface MicPress {
	startedAt: number;
	pointerType: string;
}

export function VoiceMicButton({ voice }: { voice: VoiceChatControls }): ReactElement {
	const micPressRef = useRef<MicPress | null>(null);
	const debugHoldRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const { micActive } = voice;

	const cancelDebugHold = () => {
		if (debugHoldRef.current !== null) {
			clearTimeout(debugHoldRef.current);
			debugHoldRef.current = null;
		}
	};
	useEffect(() => cancelDebugHold, []);

	// Tap toggles; a mouse press held past PUSH_TO_TALK_HOLD_MS listens until it is released; a touch held past
	// VOICE_DEBUG_HOLD_MS also shows or hides the diagnostic log. The start itself stays inside the tap.
	const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		cancelDebugHold();
		if (event.pointerType === "touch") {
			debugHoldRef.current = setTimeout(() => {
				debugHoldRef.current = null;
				voice.debugLog.toggle();
			}, VOICE_DEBUG_HOLD_MS);
		}
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
		cancelDebugHold();
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
				// A long press is the log's, not the browser's menu.
				onContextMenu={(event) => event.preventDefault()}
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
					"inline-flex size-11 shrink-0 cursor-pointer touch-none select-none items-center [-webkit-touch-callout:none] justify-center rounded-full border",
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

// The phone's X: the key pad toggle's size and look, acting on the touch itself (use-pointer-tap.ts), and it stops
// the mic as well as clearing the text.
function TouchDiscardButton({ voice }: { voice: VoiceChatControls }): ReactElement {
	const tap = usePointerTap(voice.cancel);
	return (
		<button
			type="button"
			aria-label="Discard voice message"
			{...tap}
			onContextMenu={keepTerminalFocus}
			className={cn(TOUCH_SQUARE_BUTTON_CLASS, TOUCH_QUIET_CLASS)}
		>
			<X size={18} />
		</button>
	);
}

/**
 * The editable preview of what was dictated, with its discard (X) and, in the desktop's bar, its send button. On a
 * phone (`touch`) it spans the touch bar edge to edge, the touch bar's Enter sends it, and the X inside it is a touch bar
 * button that also stops the mic.
 */
export function VoicePreview({
	voice,
	layout,
}: {
	voice: VoiceChatControls;
	layout: "bar" | "touch";
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

	const textarea = (
		<textarea
			aria-label="Voice message"
			value={voiceInput.previewText}
			readOnly={voiceInput.listening}
			placeholder={voiceInput.listening ? "Listening…" : undefined}
			onChange={(event) => voiceInput.setDraft(event.target.value)}
			onKeyDown={handleKeyDown}
			rows={2}
			className={cn(
				layout === "touch"
					? "min-h-11 min-w-0 flex-1 resize-none bg-transparent px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
					: "min-h-11 flex-1 resize-none rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none",
				voiceInput.listening && "text-text-secondary",
			)}
		/>
	);

	if (layout === "touch") {
		// Full bleed across the touch bar (its px-1.5 undone), the X inside the box at its right edge and centered
		// however many lines the text takes. The X is the box's own flex item beside the textarea, never laid over it,
		// so no text sits under the finger that taps it.
		return (
			<div className="-mx-1.5 flex items-center gap-1 border-y border-border bg-surface-2 py-1 pr-1.5 focus-within:border-border-focus">
				{textarea}
				<TouchDiscardButton voice={voice} />
			</div>
		);
	}

	return (
		<div className="flex items-end gap-2">
			{textarea}
			<div className="flex flex-col gap-1">
				<Button
					variant="primary"
					size="md"
					icon={voiceInput.isSending ? <Spinner size={14} /> : <SendHorizontal size={16} />}
					aria-label="Send voice message"
					disabled={!voice.canSend}
					onClick={voice.send}
				/>
				<Button
					variant="ghost"
					size="md"
					icon={<X size={16} />}
					aria-label="Discard voice message"
					// Keeps the focus.
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
