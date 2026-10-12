import { useCallback, useEffect, useSyncExternalStore } from "react";

import { LocalStorageKey } from "@/storage/local-storage-store";
import { useBooleanLocalStorageValue } from "@/utils/react-use";
import {
	getVoiceDebugEntries,
	logVoiceEvent,
	readVoiceDebugQuery,
	subscribeVoiceDebugLog,
	type VoiceDebugEntry,
} from "@/voice/voice-debug-log";

export interface VoiceDebugLogControls {
	/** The panel is shown (off by default; remembered in localStorage). */
	visible: boolean;
	toggle: () => void;
	entries: VoiceDebugEntry[];
}

/**
 * The voice chat's diagnostic log panel: shown after a long press on the mic, or with `?voiceDebug=1` in the URL
 * (`?voiceDebug=0` hides it). The log itself records whether or not the panel is shown.
 */
export function useVoiceDebugLog(): VoiceDebugLogControls {
	const [visible, setVisible] = useBooleanLocalStorageValue(LocalStorageKey.VoiceDebugLog, false);
	const entries = useSyncExternalStore(subscribeVoiceDebugLog, getVoiceDebugEntries, getVoiceDebugEntries);

	useEffect(() => {
		const fromQuery = typeof window === "undefined" ? null : readVoiceDebugQuery(window.location.search);
		if (fromQuery !== null) {
			setVisible(fromQuery);
		}
	}, [setVisible]);

	const toggle = useCallback(() => {
		setVisible((current) => {
			logVoiceEvent(current ? "log hidden" : "log shown");
			return !current;
		});
	}, [setVisible]);

	return { visible, toggle, entries };
}
