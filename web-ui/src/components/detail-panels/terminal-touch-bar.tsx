import {
	ArrowDown,
	ArrowLeftToLine,
	ArrowRightToLine,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	Keyboard,
	Space,
} from "lucide-react";
import type { ReactElement, ReactNode, SyntheticEvent } from "react";

import { cn } from "@/components/ui/cn";
import { usePressRepeat } from "@/hooks/use-press-repeat";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { isTerminalArrowKey, type TerminalTouchKey } from "@/terminal/terminal-touch-keys";
import { useBooleanLocalStorageValue } from "@/utils/react-use";

// The bar under a terminal on a phone, in the panel's flow so it never covers
// the TUI: the key pad toggle and jump to bottom, and while the pad is open a
// second row with the keys a phone keyboard lacks to answer a TUI's pickers
// (arrows, Tab, Shift+Tab, Esc) plus Space. Enter is the keyboard's own, or the
// voice bar's Send.
//
// The bar keeps one height while jump to bottom comes and goes (scrolling must
// not refit the terminal); only the pad toggle changes it, and the terminal's
// resize observer fits once after that.
//
// No button may take focus from the terminal's textarea: the on-screen keyboard
// would close, and its dictation would end (terminal-ime-input.ts).

const BUTTON_CLASS =
	"inline-flex h-9 cursor-pointer touch-manipulation select-none items-center justify-center rounded-md border active:bg-surface-4";
const PAD_KEY_CLASS = cn(BUTTON_CLASS, "w-full min-w-0 border-border-bright bg-surface-2 text-text-primary");

function keepTerminalFocus(event: SyntheticEvent): void {
	event.preventDefault();
}

interface PadKey {
	key: TerminalTouchKey;
	label: string;
	content: ReactNode;
}

// One row: Esc, Shift+Tab, Tab, Space, then the arrows.
const PAD_KEYS: PadKey[] = [
	{ key: "escape", label: "Send Esc", content: <span className="text-xs font-medium">Esc</span> },
	{ key: "shiftTab", label: "Send Shift+Tab", content: <ArrowLeftToLine size={16} /> },
	{ key: "tab", label: "Send Tab", content: <ArrowRightToLine size={16} /> },
	{ key: "space", label: "Send Space", content: <Space size={16} /> },
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

function TerminalTouchKeyPad({ onKey }: { onKey: (key: TerminalTouchKey) => void }): ReactElement {
	return (
		<div role="toolbar" aria-label="Terminal keys" className="grid grid-cols-8 gap-1">
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

export interface TerminalTouchBarProps {
	showJumpToBottom: boolean;
	onJumpToBottom: () => void;
	// The terminal refuses a key while it takes no input (terminal-ime-input.ts).
	onKey: (key: TerminalTouchKey) => void;
}

export function TerminalTouchBar({ showJumpToBottom, onJumpToBottom, onKey }: TerminalTouchBarProps): ReactElement {
	const [isPadOpen, setIsPadOpen] = useBooleanLocalStorageValue(LocalStorageKey.TerminalTouchKeysExpanded, false);
	return (
		<div
			role="toolbar"
			aria-label="Terminal controls"
			className="flex shrink-0 flex-col gap-1 border-t border-border px-1.5 py-1"
		>
			<div className="flex items-center justify-between gap-2">
				<button
					type="button"
					onClick={() => setIsPadOpen((open) => !open)}
					onMouseDown={keepTerminalFocus}
					onPointerDown={keepTerminalFocus}
					aria-label={isPadOpen ? "Hide terminal keys" : "Show terminal keys"}
					aria-expanded={isPadOpen}
					className={cn(
						BUTTON_CLASS,
						"px-3",
						isPadOpen
							? "border-accent bg-accent/20 text-text-primary"
							: "border-border-bright bg-surface-2 text-text-secondary",
					)}
				>
					<Keyboard size={16} />
				</button>
				{showJumpToBottom ? (
					<button
						type="button"
						onClick={onJumpToBottom}
						// Keeps the terminal focused, so an open on-screen keyboard stays open.
						onMouseDown={keepTerminalFocus}
						onPointerDown={keepTerminalFocus}
						aria-label="Jump to bottom"
						className={cn(BUTTON_CLASS, "px-3 border-border-bright bg-surface-2 text-text-primary")}
					>
						<ArrowDown size={16} />
					</button>
				) : null}
			</div>
			{isPadOpen ? <TerminalTouchKeyPad onKey={onKey} /> : null}
		</div>
	);
}
