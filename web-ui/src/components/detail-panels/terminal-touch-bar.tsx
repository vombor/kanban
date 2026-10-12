import {
	ArrowDown,
	ArrowLeftToLine,
	ArrowRightToLine,
	AudioLines,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	ClipboardPaste,
	CornerDownLeft,
	Keyboard,
	Volume2,
	VolumeX,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import {
	keepTerminalFocus,
	TOUCH_BUTTON_CLASS,
	TOUCH_NEUTRAL_CLASS,
	TOUCH_QUIET_CLASS,
	TOUCH_ROUND_BUTTON_CLASS,
	TOUCH_SQUARE_BUTTON_CLASS,
} from "@/components/detail-panels/touch-bar-buttons";
import { VoiceError, VoiceMicButton, VoicePreview, VoiceStatus } from "@/components/detail-panels/voice-chat-controls";
import { VoiceDebugPanel } from "@/components/detail-panels/voice-debug-panel";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { usePressRepeat } from "@/hooks/use-press-repeat";
import { useTouchPaste } from "@/hooks/use-touch-paste";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { isTerminalArrowKey, type TerminalTouchKey } from "@/terminal/terminal-touch-keys";
import { useBooleanLocalStorageValue } from "@/utils/react-use";
import { useVoiceChat, type VoiceChatControls } from "@/voice/use-voice-chat";

// The bar under a terminal on a phone, in the panel's flow so it never covers
// the TUI. One row: on the left, on an agent session, the mic and the speaker
// (replies read aloud; tapped while a reply is read, it stops the reading); on
// the right jump to bottom (while scrolled up), the key pad toggle and Enter,
// which stay at the row's right edge whether jump to bottom is there or not.
// Enter sends the voice message while the mic is on or the voice preview
// (above the row, with its X, which also stops the mic) holds one, and is the terminal's Enter
// otherwise. While the pad is open a row right above the controls holds the
// keys a phone keyboard lacks to answer a TUI's pickers (arrows, Tab,
// Shift+Tab, Esc) plus Paste. It is in the bar's flow, not floating over the
// terminal: a TUI's input line is its last rows and xterm can't scroll past
// them, so an overlay would hide exactly what the keys answer; the terminal
// refits once instead.
//
// The row keeps one height while jump to bottom comes and goes (scrolling must
// not refit the terminal); only the pad toggle, the voice preview and the
// voice log change the bar's height, and the terminal's resize observer fits
// once after that.
//
// No button may take focus from the terminal's textarea: the on-screen keyboard
// would close, and its dictation would end (terminal-ime-input.ts).

const PAD_KEY_CLASS = cn(TOUCH_BUTTON_CLASS, TOUCH_NEUTRAL_CLASS, "h-10 w-full min-w-0 rounded-md");

const KEEP_FOCUS_PROPS = { onMouseDown: keepTerminalFocus, onPointerDown: keepTerminalFocus };

interface PadKey {
	key: TerminalTouchKey;
	label: string;
	content: ReactNode;
}

// One row: Esc, Shift+Tab, Tab, Paste, then the arrows. No Space: the phone
// keyboard has one, and nothing else pastes into a terminal on a phone.
const PAD_KEYS: Array<PadKey | "paste"> = [
	{ key: "escape", label: "Send Esc", content: <span className="text-xs font-medium">Esc</span> },
	{ key: "shiftTab", label: "Send Shift+Tab", content: <ArrowLeftToLine size={16} /> },
	{ key: "tab", label: "Send Tab", content: <ArrowRightToLine size={16} /> },
	"paste",
	{ key: "left", label: "Send Left", content: <ChevronLeft size={18} /> },
	{ key: "up", label: "Send Up", content: <ChevronUp size={18} /> },
	{ key: "down", label: "Send Down", content: <ChevronDown size={18} /> },
	{ key: "right", label: "Send Right", content: <ChevronRight size={18} /> },
];

function RepeatingPadKey({ padKey, onKey }: { padKey: PadKey; onKey: (key: TerminalTouchKey) => void }): ReactElement {
	const repeat = usePressRepeat(() => onKey(padKey.key));
	return (
		<button
			type="button"
			aria-label={padKey.label}
			className={PAD_KEY_CLASS}
			onMouseDown={keepTerminalFocus}
			onContextMenu={keepTerminalFocus}
			{...repeat}
			onPointerDown={(event) => {
				keepTerminalFocus(event);
				repeat.onPointerDown(event);
			}}
		>
			{padKey.content}
		</button>
	);
}

function TerminalTouchKeyPad({
	onKey,
	onPaste,
}: {
	onKey: (key: TerminalTouchKey) => void;
	// Reads the clipboard, so it runs in the click: the user gesture iOS's paste access needs.
	onPaste: () => void;
}): ReactElement {
	return (
		<div role="toolbar" aria-label="Terminal keys" className="grid grid-cols-8 gap-1">
			{PAD_KEYS.map((padKey) =>
				padKey === "paste" ? (
					<button
						key="paste"
						type="button"
						aria-label="Paste"
						className={PAD_KEY_CLASS}
						{...KEEP_FOCUS_PROPS}
						onContextMenu={keepTerminalFocus}
						onClick={onPaste}
					>
						<ClipboardPaste size={16} />
					</button>
				) : isTerminalArrowKey(padKey.key) ? (
					<RepeatingPadKey key={padKey.key} padKey={padKey} onKey={onKey} />
				) : (
					<button
						key={padKey.key}
						type="button"
						aria-label={padKey.label}
						className={PAD_KEY_CLASS}
						{...KEEP_FOCUS_PROPS}
						onContextMenu={keepTerminalFocus}
						onClick={() => onKey(padKey.key)}
					>
						{padKey.content}
					</button>
				),
			)}
		</div>
	);
}

// Replies read aloud on or off; while one is being read (the icon moves), a tap stops the reading instead.
function ReplySpeechButton({ voice }: { voice: VoiceChatControls }): ReactElement {
	const { replySpeech } = voice;
	const { speaking, enabled } = replySpeech;
	const label = speaking ? "Stop reading the reply" : "Read replies aloud";
	return (
		<Tooltip
			side="top"
			content={speaking ? "Stop reading the reply" : enabled ? "Stop reading replies aloud" : "Read replies aloud"}
		>
			<button
				type="button"
				aria-label={label}
				aria-pressed={enabled}
				{...KEEP_FOCUS_PROPS}
				onClick={() => (speaking ? replySpeech.stop() : replySpeech.setEnabled(!enabled))}
				className={cn(
					TOUCH_ROUND_BUTTON_CLASS,
					speaking
						? "animate-pulse border-accent bg-accent/20 text-accent"
						: enabled
							? "border-accent/60 bg-surface-2 text-accent"
							: cn(TOUCH_NEUTRAL_CLASS, "text-text-secondary"),
				)}
			>
				{speaking ? <AudioLines size={18} /> : enabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
			</button>
		</Tooltip>
	);
}

// The voice message while the mic is on or the preview holds one (with the send button's disabled state and spinner):
// while listening it stops the mic and sends what was heard. Otherwise the terminal's Enter.
function EnterButton({
	voice,
	onKey,
}: {
	voice: VoiceChatControls | null;
	onKey: (key: TerminalTouchKey) => void;
}): ReactElement {
	const sendsVoice = (voice?.hasPreview || voice?.micActive) ?? false;
	const disabled = sendsVoice && !voice?.canSend;
	return (
		<button
			type="button"
			aria-label={sendsVoice ? "Send voice message" : "Send Enter"}
			// Not `disabled`: a tap on a disabled button would not reach the handlers that keep the keyboard's focus.
			aria-disabled={disabled}
			{...KEEP_FOCUS_PROPS}
			onClick={() => {
				if (!voice || !sendsVoice) {
					onKey("enter");
				} else if (voice.canSend) {
					voice.send();
				}
			}}
			className={cn(
				TOUCH_ROUND_BUTTON_CLASS,
				sendsVoice && voice?.canSend ? "border-accent bg-surface-2 text-accent" : TOUCH_NEUTRAL_CLASS,
				disabled && "cursor-default opacity-50",
			)}
		>
			{sendsVoice && voice?.voiceInput.isSending ? <Spinner size={16} /> : <CornerDownLeft size={20} />}
		</button>
	);
}

export interface TerminalTouchBarProps {
	showJumpToBottom: boolean;
	onJumpToBottom: () => void;
	// The terminal refuses a key while it takes no input (terminal-ime-input.ts).
	onKey: (key: TerminalTouchKey) => void;
	// The pad's Paste: a paste after any pending dictation; false while the terminal takes no input.
	onPaste: (text: string) => boolean;
	// An agent session's voice chat, where the browser has a speech API.
	voice?: VoiceChatControls | null;
}

export function TerminalTouchBar({
	showJumpToBottom,
	onJumpToBottom,
	onKey,
	onPaste,
	voice = null,
}: TerminalTouchBarProps): ReactElement {
	const [isPadOpen, setIsPadOpen] = useBooleanLocalStorageValue(LocalStorageKey.TerminalTouchKeysExpanded, false);
	const touchPaste = useTouchPaste(onPaste);
	return (
		<div className="flex shrink-0 flex-col gap-1 border-t border-border px-1.5 py-1">
			{voice ? (
				<>
					<VoiceDebugPanel voice={voice} />
					<VoicePreview voice={voice} layout="touch" />
					<VoiceError voice={voice} />
				</>
			) : null}
			{touchPaste.message ? (
				<div role="status" className="text-xs text-status-orange">
					{touchPaste.message}
				</div>
			) : null}
			{isPadOpen ? <TerminalTouchKeyPad onKey={onKey} onPaste={touchPaste.paste} /> : null}
			<div role="toolbar" aria-label="Terminal controls" className="flex items-center gap-1.5">
				{voice?.voiceInput.supported ? <VoiceMicButton voice={voice} /> : null}
				{voice?.replySpeech.supported ? <ReplySpeechButton voice={voice} /> : null}
				{voice ? <VoiceStatus voice={voice} showReading /> : <span className="flex-1" />}
				{showJumpToBottom ? (
					<button
						type="button"
						onClick={onJumpToBottom}
						// Keeps the terminal focused, so an open on-screen keyboard stays open.
						{...KEEP_FOCUS_PROPS}
						aria-label="Jump to bottom"
						className={cn(TOUCH_SQUARE_BUTTON_CLASS, TOUCH_NEUTRAL_CLASS)}
					>
						<ArrowDown size={18} />
					</button>
				) : null}
				<button
					type="button"
					onClick={() => setIsPadOpen((open) => !open)}
					{...KEEP_FOCUS_PROPS}
					aria-label={isPadOpen ? "Hide terminal keys" : "Show terminal keys"}
					aria-expanded={isPadOpen}
					className={cn(
						TOUCH_SQUARE_BUTTON_CLASS,
						isPadOpen ? "border-accent bg-accent/20 text-text-primary" : TOUCH_QUIET_CLASS,
					)}
				>
					<Keyboard size={18} />
				</button>
				<EnterButton voice={voice} onKey={onKey} />
			</div>
		</div>
	);
}

export interface VoiceTerminalTouchBarProps extends Omit<TerminalTouchBarProps, "voice"> {
	taskId: string;
	workspaceId: string | null;
	summary: RuntimeTaskSessionSummary | null;
}

// An agent session's touch bar: the voice chat bar's controls join the row (desktop keeps VoiceChatBar).
export function VoiceTerminalTouchBar({
	taskId,
	workspaceId,
	summary,
	...props
}: VoiceTerminalTouchBarProps): ReactElement {
	const voice = useVoiceChat(workspaceId, taskId, summary);
	return <TerminalTouchBar {...props} voice={voice.supported ? voice : null} />;
}
