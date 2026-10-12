import { useCallback, useEffect, useState } from "react";

import { CLIPBOARD_TEXT_MESSAGES, readClipboardText } from "@/terminal/clipboard-text";

// How long the touch bar shows why Paste sent nothing.
export const PASTE_MESSAGE_MS = 5000;

export const PASTE_NOT_SENT_MESSAGE = "The terminal takes no input right now, so nothing was pasted.";

// The touch bar's Paste key: reads the clipboard (call `paste` inside the tap's
// click, the user gesture iOS needs) and hands the text to the terminal, or
// says why nothing was pasted instead of failing silently.
export function useTouchPaste(onPaste: (text: string) => boolean): { paste: () => void; message: string | null } {
	const [message, setMessage] = useState<string | null>(null);

	useEffect(() => {
		if (message === null) {
			return;
		}
		const timer = setTimeout(() => setMessage(null), PASTE_MESSAGE_MS);
		return () => clearTimeout(timer);
	}, [message]);

	const paste = useCallback(() => {
		setMessage(null);
		void readClipboardText().then((result) => {
			if (!result.ok) {
				setMessage(CLIPBOARD_TEXT_MESSAGES[result.reason]);
			} else if (!onPaste(result.text)) {
				setMessage(PASTE_NOT_SENT_MESSAGE);
			}
		});
	}, [onPaste]);

	return { paste, message };
}
