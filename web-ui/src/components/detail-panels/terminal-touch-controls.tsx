import {
	ArrowDown,
	ArrowLeftToLine,
	ArrowRightToLine,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	CornerDownLeft,
	Keyboard,
	Space,
} from "lucide-react";
import type { ReactElement, ReactNode, SyntheticEvent } from "react";

import { cn } from "@/components/ui/cn";
import { usePressRepeat } from "@/hooks/use-press-repeat";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { isTerminalArrowKey, type TerminalTouchKey } from "@/terminal/terminal-touch-keys";
import { useBooleanLocalStorageValue } from "@/utils/react-use";

// The floating buttons over an agent terminal on a phone: jump to bottom, Enter,
// and the keys a phone keyboard lacks to answer a TUI's pickers (arrows, Tab,
// Shift+Tab, Esc) plus Space, behind a toggle so the pad covers the TUI only
// while it is wanted.
//
// No button may take focus from the terminal's textarea: the on-screen keyboard
// would close, and its dictation would end (terminal-ime-input.ts).

const ROUND_BUTTON_CLASS =
	"inline-flex size-11 cursor-pointer touch-manipulation select-none items-center justify-center rounded-full border border-border-bright bg-surface-2 text-text-primary shadow-lg active:bg-surface-4";
const PAD_KEY_CLASS =
	"inline-flex size-10 cursor-pointer touch-manipulation select-none items-center justify-center rounded-md border border-border-bright bg-surface-2 text-text-primary shadow-lg active:bg-surface-4";

function keepTerminalFocus(event: SyntheticEvent): void {
	event.preventDefault();
}

interface PadKey {
	key: TerminalTouchKey;
	label: string;
	content: ReactNode;
}

// Two rows: the arrows as an inverted T on the right, Esc/Shift+Tab/Tab/Space around them.
const PAD_KEYS: PadKey[] = [
	{ key: "escape", label: "Send Esc", content: <span className="text-xs font-medium">Esc</span> },
	{ key: "shiftTab", label: "Send Shift+Tab", content: <ArrowLeftToLine size={16} /> },
	{ key: "up", label: "Send Up", content: <ChevronUp size={18} /> },
	{ key: "tab", label: "Send Tab", content: <ArrowRightToLine size={16} /> },
	{ key: "space", label: "Send Space", content: <Space size={16} /> },
	{ key: "left", label: "Send Left", content: <ChevronLeft size={18} /> },
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

function TerminalTouchKeyPad({ onKey }: { onKey: (key: TerminalTouchKey) => void }): ReactElement {
	return (
		<div role="toolbar" aria-label="Terminal keys" className="grid grid-cols-4 gap-1.5">
			{PAD_KEYS.map((padKey) =>
				isTerminalArrowKey(padKey.key) ? (
					<RepeatingPadKey key={padKey.key} padKey={padKey} onKey={onKey} />
				) : (
					<button
						key={padKey.key}
						type="button"
						aria-label={padKey.label}
						className={PAD_KEY_CLASS}
						onMouseDown={keepTerminalFocus}
						onPointerDown={keepTerminalFocus}
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

export interface TerminalTouchControlsProps {
	showJumpToBottom: boolean;
	// Enter and the key pad, while the terminal takes input.
	showKeys: boolean;
	onJumpToBottom: () => void;
	onKey: (key: TerminalTouchKey) => void;
}

export function TerminalTouchControls({
	showJumpToBottom,
	showKeys,
	onJumpToBottom,
	onKey,
}: TerminalTouchControlsProps): ReactElement | null {
	const [isPadOpen, setIsPadOpen] = useBooleanLocalStorageValue(LocalStorageKey.TerminalTouchKeysExpanded, false);
	if (!showJumpToBottom && !showKeys) {
		return null;
	}
	return (
		<div className="absolute right-4 bottom-4 z-20 flex items-end gap-2">
			{showKeys && isPadOpen ? <TerminalTouchKeyPad onKey={onKey} /> : null}
			<div className="flex flex-col items-center gap-2">
				{showJumpToBottom ? (
					<button
						type="button"
						onClick={onJumpToBottom}
						// Keeps the terminal focused, so an open on-screen keyboard stays open.
						onMouseDown={keepTerminalFocus}
						aria-label="Jump to bottom"
						className={ROUND_BUTTON_CLASS}
					>
						<ArrowDown size={20} />
					</button>
				) : null}
				{showKeys ? (
					<>
						<button
							type="button"
							onClick={() => setIsPadOpen((open) => !open)}
							onMouseDown={keepTerminalFocus}
							onPointerDown={keepTerminalFocus}
							aria-label={isPadOpen ? "Hide terminal keys" : "Show terminal keys"}
							aria-expanded={isPadOpen}
							className={cn(
								"inline-flex size-9 cursor-pointer touch-manipulation select-none items-center justify-center rounded-full border shadow-lg active:bg-surface-4",
								isPadOpen
									? "border-accent bg-accent/20 text-text-primary"
									: "border-border-bright bg-surface-2 text-text-secondary",
							)}
						>
							<Keyboard size={16} />
						</button>
						<button
							type="button"
							onClick={() => onKey("enter")}
							// Keeps the terminal focused, so the keyboard and its dictation keep going.
							onMouseDown={keepTerminalFocus}
							onPointerDown={keepTerminalFocus}
							aria-label="Send Enter"
							className={ROUND_BUTTON_CLASS}
						>
							<CornerDownLeft size={20} />
						</button>
					</>
				) : null}
			</div>
		</div>
	);
}
