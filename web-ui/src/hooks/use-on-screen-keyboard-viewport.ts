import { useCallback, useEffect, useRef } from "react";

import {
	applyKeyboardViewportFrame,
	computeKeyboardViewportFrame,
	isKeyboardViewportOffsetOnlyChange,
	isSameKeyboardViewportFrame,
	type KeyboardViewportFrame,
	readViewportMetrics,
} from "@/resize/on-screen-keyboard-viewport";
import { useUnmount, useVisualViewportEvent } from "@/utils/react-use";

// The keyboard animates for ~250 ms and the visual viewport resizes on every
// frame of it: the layout follows only the settled size, so each terminal
// refits and resizes its PTY once per open or close.
export const KEYBOARD_SETTLE_MS = 150;

// Keeps the app inside the part of the screen an on-screen keyboard leaves
// visible (on-screen-keyboard-viewport.ts). Only CSS variables on <html> change:
// no focus, no re-render, no re-created terminal, so the keyboard and its
// dictation keep going (terminal-ime-input.ts).
export function useOnScreenKeyboardViewport(enabled: boolean): void {
	const appliedRef = useRef<KeyboardViewportFrame | null>(null);
	const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearSettleTimer = useCallback(() => {
		if (settleTimerRef.current !== null) {
			clearTimeout(settleTimerRef.current);
			settleTimerRef.current = null;
		}
	}, []);

	const apply = useCallback((frame: KeyboardViewportFrame | null) => {
		if (isSameKeyboardViewportFrame(appliedRef.current, frame)) {
			return;
		}
		appliedRef.current = frame;
		applyKeyboardViewportFrame(document.documentElement, frame);
	}, []);

	const handleViewportChange = useCallback(() => {
		const next = computeKeyboardViewportFrame(readViewportMetrics(window));
		if (isKeyboardViewportOffsetOnlyChange(appliedRef.current, next)) {
			clearSettleTimer();
			apply(next);
			return;
		}
		clearSettleTimer();
		settleTimerRef.current = setTimeout(() => {
			settleTimerRef.current = null;
			// Read again: the last event may predate the end of the animation.
			apply(computeKeyboardViewportFrame(readViewportMetrics(window)));
		}, KEYBOARD_SETTLE_MS);
	}, [apply, clearSettleTimer]);

	useVisualViewportEvent("resize", enabled ? handleViewportChange : null);
	useVisualViewportEvent("scroll", enabled ? handleViewportChange : null);

	useEffect(() => {
		if (enabled) {
			handleViewportChange();
			return;
		}
		clearSettleTimer();
		apply(null);
	}, [apply, clearSettleTimer, enabled, handleViewportChange]);

	useUnmount(() => {
		clearSettleTimer();
		apply(null);
	});
}
