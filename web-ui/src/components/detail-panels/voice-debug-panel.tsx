import { Copy, Trash2, X } from "lucide-react";
import type { ReactElement, SyntheticEvent } from "react";
import { useEffect, useRef, useState } from "react";

import type { VoiceChatControls } from "@/voice/use-voice-chat";
import { clearVoiceDebugLog, formatVoiceDebugEntry, formatVoiceDebugLog } from "@/voice/voice-debug-log";

const ICON_BUTTON_CLASS =
	"inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm text-text-secondary hover:bg-surface-3 active:bg-surface-4";

// Keeps the focus where it is (on a phone the terminal's, and its keyboard open).
function keepFocus(event: SyntheticEvent): void {
	event.preventDefault();
}

/**
 * The voice chat's diagnostic log (docs/fork/voice-chat.md, "Diagnostic log"): the recognizer's and the speech
 * synthesizer's events with UTC times, newest last, for a report from a real phone. Copy puts the whole log on the
 * clipboard.
 */
export function VoiceDebugPanel({ voice }: { voice: VoiceChatControls }): ReactElement | null {
	const { debugLog } = voice;
	const listRef = useRef<HTMLDivElement | null>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		const list = listRef.current;
		if (list && debugLog.entries.length > 0) {
			list.scrollTop = list.scrollHeight;
		}
	}, [debugLog.entries]);

	if (!debugLog.visible) {
		return null;
	}

	const copy = () => {
		void navigator.clipboard?.writeText(formatVoiceDebugLog(debugLog.entries)).then(
			() => setCopied(true),
			() => setCopied(false),
		);
	};

	return (
		<section aria-label="Voice diagnostic log" className="rounded-md border border-border bg-surface-1">
			<div className="flex items-center gap-1 border-b border-border px-1.5 py-0.5">
				<span className="flex-1 text-[11px] text-text-tertiary">Voice log, UTC{copied ? " (copied)" : ""}</span>
				<button
					type="button"
					aria-label="Copy the voice log"
					className={ICON_BUTTON_CLASS}
					onPointerDown={keepFocus}
					onMouseDown={keepFocus}
					onClick={copy}
				>
					<Copy size={14} />
				</button>
				<button
					type="button"
					aria-label="Clear the voice log"
					className={ICON_BUTTON_CLASS}
					onPointerDown={keepFocus}
					onMouseDown={keepFocus}
					onClick={() => {
						setCopied(false);
						clearVoiceDebugLog();
					}}
				>
					<Trash2 size={14} />
				</button>
				<button
					type="button"
					aria-label="Hide the voice log"
					className={ICON_BUTTON_CLASS}
					onPointerDown={keepFocus}
					onMouseDown={keepFocus}
					onClick={debugLog.toggle}
				>
					<X size={14} />
				</button>
			</div>
			<div
				ref={listRef}
				role="log"
				className="max-h-32 overflow-y-auto px-1.5 py-1 font-mono text-[10px] leading-snug text-text-secondary"
			>
				{debugLog.entries.length === 0 ? (
					<div className="text-text-tertiary">Nothing yet. Tap the mic.</div>
				) : (
					debugLog.entries.map((entry, index) => (
						<div key={`${entry.at}-${index}`} className="break-all">
							{formatVoiceDebugEntry(entry)}
						</div>
					))
				)}
			</div>
		</section>
	);
}
