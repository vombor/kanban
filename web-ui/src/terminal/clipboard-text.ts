// Reads the clipboard's text for the touch bar's Paste key. It must be called
// inside the tap's click: WebKit's Clipboard::readText rejects NotAllowedError
// without transient activation, then asks for paste access (iOS shows its
// "Paste" callout unless the text came from this page) and rejects
// NotAllowedError when that is refused or the pasteboard holds no items; a
// pasteboard without plain text resolves "". Outside a secure context there is
// no navigator.clipboard at all.

export type ClipboardTextResult =
	| { ok: true; text: string }
	| { ok: false; reason: "insecure" | "unsupported" | "refused" | "empty" };

export async function readClipboardText(): Promise<ClipboardTextResult> {
	if (!window.isSecureContext) {
		return { ok: false, reason: "insecure" };
	}
	if (typeof navigator.clipboard?.readText !== "function") {
		return { ok: false, reason: "unsupported" };
	}
	let text: string;
	try {
		text = await navigator.clipboard.readText();
	} catch {
		return { ok: false, reason: "refused" };
	}
	return text.length > 0 ? { ok: true, text } : { ok: false, reason: "empty" };
}

export const CLIPBOARD_TEXT_MESSAGES: Record<Exclude<ClipboardTextResult, { ok: true }>["reason"], string> = {
	insecure: "Paste needs Kanban on https or localhost: this page can't read the clipboard.",
	unsupported: "This browser can't read the clipboard.",
	refused: "The clipboard wasn't read. Tap Paste, then Paste in the bubble that appears.",
	empty: "The clipboard holds no text.",
};
