import type { SyntheticEvent } from "react";

import { cn } from "@/components/ui/cn";

// The phone touch bar's buttons (terminal-touch-bar.tsx, and the voice preview's X in voice-chat-controls.tsx).

export const TOUCH_BUTTON_CLASS =
	"inline-flex cursor-pointer touch-manipulation select-none items-center justify-center border active:bg-surface-4";
export const TOUCH_NEUTRAL_CLASS = "border-border-bright bg-surface-2 text-text-primary";
/** The key pad toggle's closed look, also the voice preview's X. */
export const TOUCH_QUIET_CLASS = "border-border-bright bg-surface-2 text-text-secondary";
export const TOUCH_ROUND_BUTTON_CLASS = cn(TOUCH_BUTTON_CLASS, "size-11 shrink-0 rounded-full shadow-lg");
export const TOUCH_SQUARE_BUTTON_CLASS = cn(TOUCH_BUTTON_CLASS, "size-11 shrink-0 rounded-md");

// No button may take focus from the terminal's textarea: the on-screen keyboard
// would close, and its dictation would end (terminal-ime-input.ts).
export function keepTerminalFocus(event: SyntheticEvent): void {
	event.preventDefault();
}
