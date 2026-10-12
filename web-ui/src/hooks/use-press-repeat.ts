import type { MouseEvent, PointerEvent } from "react";
import { useCallback, useRef } from "react";

import { useLatest, useUnmount } from "@/utils/react-use";

// A held key repeats like a keyboard's: once on press, then after a pause at a steady rate.
export const PRESS_REPEAT_DELAY_MS = 400;
export const PRESS_REPEAT_INTERVAL_MS = 80;

export interface PressRepeatHandlers {
	onPointerDown: (event: PointerEvent<HTMLElement>) => void;
	onPointerUp: () => void;
	onPointerCancel: () => void;
	onPointerLeave: () => void;
	onClick: (event: MouseEvent<HTMLElement>) => void;
}

// Presses on pointer down and repeats while held. The click after a pointer
// press is ignored; a click without one (keyboard activation, `detail` 0) presses once.
export function usePressRepeat(onPress: () => void): PressRepeatHandlers {
	const onPressRef = useLatest(onPress);
	const delayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);

	const stop = useCallback(() => {
		if (delayTimer.current !== null) {
			clearTimeout(delayTimer.current);
			delayTimer.current = null;
		}
		if (repeatTimer.current !== null) {
			clearInterval(repeatTimer.current);
			repeatTimer.current = null;
		}
	}, []);

	useUnmount(stop);

	const onPointerDown = useCallback(
		(event: PointerEvent<HTMLElement>) => {
			if (event.button !== 0) {
				return;
			}
			stop();
			onPressRef.current();
			delayTimer.current = setTimeout(() => {
				delayTimer.current = null;
				repeatTimer.current = setInterval(() => {
					onPressRef.current();
				}, PRESS_REPEAT_INTERVAL_MS);
			}, PRESS_REPEAT_DELAY_MS);
		},
		[onPressRef, stop],
	);

	const onClick = useCallback(
		(event: MouseEvent<HTMLElement>) => {
			if (event.detail === 0) {
				onPressRef.current();
			}
		},
		[onPressRef],
	);

	return { onPointerDown, onPointerUp: stop, onPointerCancel: stop, onPointerLeave: stop, onClick };
}
