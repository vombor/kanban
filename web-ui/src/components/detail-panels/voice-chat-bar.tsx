import { Mic, MicOff, SendHorizontal, Square, Volume2, VolumeX, X } from "lucide-react";
import type { KeyboardEvent, PointerEvent, ReactElement } from "react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useReplySpeech } from "@/voice/use-reply-speech";
import { useVoiceInput } from "@/voice/use-voice-input";

/** A mouse press held at least this long is push-to-talk: releasing it stops listening. */
export const PUSH_TO_TALK_HOLD_MS = 400;

interface MicPress {
	startedAt: number;
	pointerType: string;
}

export interface VoiceChatBarProps {
	taskId: string;
	workspaceId: string | null;
	summary: RuntimeTaskSessionSummary | null;
}

/**
 * Voice chat for an agent session, built on the browser's Web Speech APIs only (docs/fork/voice-chat.md): a mic that
 * fills an editable preview and sends its final text like typed input, and a per-session toggle that reads the
 * agent's reply aloud when its turn ends. Renders nothing where the browser has neither API.
 */
export function VoiceChatBar({ taskId, workspaceId, summary }: VoiceChatBarProps): ReactElement | null {
	const voiceInput = useVoiceInput(workspaceId, taskId);
	const replySpeech = useReplySpeech(taskId, summary);
	const micPressRef = useRef<MicPress | null>(null);

	if (!voiceInput.supported && !replySpeech.supported) {
		return null;
	}

	const startListening = () => {
		// The user talking ends whatever is being read out.
		replySpeech.stop();
		voiceInput.startListening();
	};

	const toggleListening = () => {
		if (voiceInput.listening) {
			voiceInput.stopListening();
		} else {
			startListening();
		}
	};

	// Tap toggles; a mouse press held past PUSH_TO_TALK_HOLD_MS listens until it is released.
	const handleMicPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		if (voiceInput.listening) {
			micPressRef.current = null;
			voiceInput.stopListening();
			return;
		}
		event.currentTarget.setPointerCapture?.(event.pointerId);
		micPressRef.current = { startedAt: Date.now(), pointerType: event.pointerType };
		startListening();
	};

	const handleMicPointerUp = () => {
		const press = micPressRef.current;
		micPressRef.current = null;
		if (press && press.pointerType !== "touch" && Date.now() - press.startedAt >= PUSH_TO_TALK_HOLD_MS) {
			voiceInput.stopListening();
		}
	};

	const handlePreviewKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			replySpeech.stop();
			void voiceInput.send();
		} else if (event.key === "Escape") {
			event.preventDefault();
			voiceInput.discard();
		}
	};

	const hasPreview = voiceInput.listening || voiceInput.previewText.length > 0;
	const micLabel = voiceInput.listening ? "Stop listening" : "Talk to the agent";

	return (
		<div className="flex flex-col gap-2 border-t border-border px-2 py-2">
			{hasPreview ? (
				<div className="flex items-end gap-2">
					<textarea
						aria-label="Voice message"
						value={voiceInput.previewText}
						readOnly={voiceInput.listening}
						placeholder={voiceInput.listening ? "Listening…" : undefined}
						onChange={(event) => voiceInput.setDraft(event.target.value)}
						onKeyDown={handlePreviewKeyDown}
						rows={2}
						className={cn(
							"min-h-11 flex-1 resize-none rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none",
							voiceInput.listening && "text-text-secondary",
						)}
					/>
					<div className="flex flex-col gap-1">
						<Button
							variant="primary"
							size="md"
							icon={voiceInput.isSending ? <Spinner size={14} /> : <SendHorizontal size={16} />}
							aria-label="Send voice message"
							disabled={voiceInput.listening || voiceInput.isSending || voiceInput.draft.trim().length === 0}
							onClick={() => {
								replySpeech.stop();
								void voiceInput.send();
							}}
						/>
						<Button
							variant="ghost"
							size="md"
							icon={<X size={16} />}
							aria-label="Discard voice message"
							onClick={voiceInput.discard}
						/>
					</div>
				</div>
			) : null}
			{voiceInput.error ? <div className="text-xs text-status-red">{voiceInput.error}</div> : null}
			<div className="flex items-center gap-2">
				{voiceInput.supported ? (
					<Tooltip side="top" content={micLabel}>
						<button
							type="button"
							aria-label={micLabel}
							aria-pressed={voiceInput.listening}
							onPointerDown={handleMicPointerDown}
							onPointerUp={handleMicPointerUp}
							onPointerCancel={handleMicPointerUp}
							// Pointer presses are handled above; a click without a pointer is the keyboard.
							onClick={(event) => {
								if (event.detail === 0) {
									toggleListening();
								}
							}}
							className={cn(
								"inline-flex size-11 shrink-0 cursor-pointer touch-none select-none items-center justify-center rounded-full border",
								voiceInput.listening
									? "animate-pulse border-status-red/50 bg-status-red/15 text-status-red"
									: "border-border-bright bg-surface-2 text-text-primary hover:bg-surface-3 active:bg-surface-4",
							)}
						>
							{voiceInput.listening ? <MicOff size={18} /> : <Mic size={18} />}
						</button>
					</Tooltip>
				) : null}
				<span className="min-w-0 flex-1 truncate text-xs text-text-tertiary">
					{voiceInput.listening ? "Listening…" : null}
				</span>
				{replySpeech.supported && replySpeech.speaking ? (
					<Button
						variant="ghost"
						size="md"
						icon={<Square size={14} />}
						aria-label="Stop reading the reply"
						onClick={replySpeech.stop}
					/>
				) : null}
				{replySpeech.supported ? (
					<Tooltip side="top" content={replySpeech.enabled ? "Stop reading replies aloud" : "Read replies aloud"}>
						<Button
							variant="ghost"
							size="md"
							icon={replySpeech.enabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
							aria-label="Read replies aloud"
							aria-pressed={replySpeech.enabled}
							className={cn(replySpeech.enabled && "text-accent")}
							onClick={() => replySpeech.setEnabled(!replySpeech.enabled)}
						/>
					</Tooltip>
				) : null}
			</div>
		</div>
	);
}
