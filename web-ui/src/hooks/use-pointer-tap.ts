import type { MouseEvent, PointerEvent } from "react";
import { useCallback, useRef } from "react";

import { useLatest } from "@/utils/react-use";

export interface PointerTapHandlers {
	onPointerDown: (event: PointerEvent<HTMLElement>) => void;
	onPointerUp: (event: PointerEvent<HTMLElement>) => void;
	onPointerCancel: () => void;
	onMouseDown: (event: MouseEvent<HTMLElement>) => void;
	onClick: (event: MouseEvent<HTMLElement>) => void;
}

// A tap that acts on the pointer's own release over the button, never on the
// browser's click, and keeps the focus where it is (the terminal's, so the
// phone's keyboard stays open). iOS only makes a click of a touch when its
// tap commits on the same element its touch-down found, with fat-finger
// targeting that prefers whichever element covers most of the finger
// (WebKit's WebPage::commitPotentialTap, LocalFrame::qualifyingNodeAtViewportLocation),
// so a small button next to a large field misses its clicks. A click without
// a pointer (keyboard activation, `detail` 0) still taps.
export function usePointerTap(onTap: () => void): PointerTapHandlers {
	const onTapRef = useLatest(onTap);
	const pressRef = useRef<number | null>(null);

	const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
		event.preventDefault();
		pressRef.current = event.button === 0 ? event.pointerId : null;
	}, []);

	const onPointerUp = useCallback(
		(event: PointerEvent<HTMLElement>) => {
			if (pressRef.current !== event.pointerId) {
				return;
			}
			pressRef.current = null;
			// A touch's pointer is captured by the button it went down on: only a release over it is a tap.
			const box = event.currentTarget.getBoundingClientRect();
			const inside =
				event.clientX >= box.left &&
				event.clientX <= box.right &&
				event.clientY >= box.top &&
				event.clientY <= box.bottom;
			if (inside) {
				onTapRef.current();
			}
		},
		[onTapRef],
	);

	const onPointerCancel = useCallback(() => {
		pressRef.current = null;
	}, []);

	const onMouseDown = useCallback((event: MouseEvent<HTMLElement>) => event.preventDefault(), []);

	const onClick = useCallback(
		(event: MouseEvent<HTMLElement>) => {
			if (event.detail === 0) {
				onTapRef.current();
			}
		},
		[onTapRef],
	);

	return { onPointerDown, onPointerUp, onPointerCancel, onMouseDown, onClick };
}
