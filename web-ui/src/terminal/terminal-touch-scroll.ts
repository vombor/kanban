// Touch scrolling for xterm terminals.
//
// xterm 6 draws its own scrollbar and only scrolls on wheel events, so on a phone the only way
// to scroll a terminal was to grab the thin scroll handle. This turns a vertical one-finger
// drag into line scrolling, with momentum after a flick. It listens to touch events only, so
// mouse selection on desktop is untouched. A drag that starts out horizontal is left to the
// browser (page and panel gestures), and a tap without movement still focuses the terminal.

export interface TouchScrollTarget {
	/** Scroll by whole lines; positive scrolls down (towards newer output). */
	scrollLines(lines: number): void;
	/** Current row height in CSS pixels. */
	getLineHeight(): number;
}

export interface TouchScrollOptions {
	/** Movement in px before the gesture picks an axis. */
	slopPx?: number;
	/** Momentum decay per 16 ms frame. */
	friction?: number;
	/** Flick speed (px/ms) below which no momentum starts. */
	minFlickVelocity?: number;
	requestFrame?: (callback: (time: number) => void) => number;
	cancelFrame?: (handle: number) => void;
	now?: () => number;
}

const VELOCITY_WINDOW_MS = 100;

export function attachTerminalTouchScroll(
	element: HTMLElement,
	target: TouchScrollTarget,
	options: TouchScrollOptions = {},
): () => void {
	const slopPx = options.slopPx ?? 8;
	const friction = options.friction ?? 0.95;
	const minFlickVelocity = options.minFlickVelocity ?? 0.3;
	const requestFrame = options.requestFrame ?? ((callback) => window.requestAnimationFrame(callback));
	const cancelFrame = options.cancelFrame ?? ((handle) => window.cancelAnimationFrame(handle));
	const now = options.now ?? (() => performance.now());

	let touchId: number | null = null;
	let startX = 0;
	let startY = 0;
	let lastY = 0;
	let axis: "none" | "vertical" | "horizontal" = "none";
	let pendingPx = 0;
	let samples: Array<{ time: number; y: number }> = [];
	let momentumFrame: number | null = null;

	// Finger moving up (negative dy) scrolls towards newer output, like native scrolling.
	const scrollByPixels = (dyPx: number) => {
		const lineHeight = Math.max(1, target.getLineHeight());
		pendingPx -= dyPx;
		const lines = Math.trunc(pendingPx / lineHeight);
		if (lines !== 0) {
			pendingPx -= lines * lineHeight;
			target.scrollLines(lines);
		}
	};

	const stopMomentum = () => {
		if (momentumFrame !== null) {
			cancelFrame(momentumFrame);
			momentumFrame = null;
		}
	};

	const startMomentum = (velocityPxPerMs: number) => {
		let velocity = velocityPxPerMs;
		let lastTime = now();
		const step = (time: number) => {
			const elapsed = Math.max(1, time - lastTime);
			lastTime = time;
			scrollByPixels(velocity * elapsed);
			velocity *= friction ** (elapsed / 16);
			if (Math.abs(velocity) < 0.02) {
				momentumFrame = null;
				return;
			}
			momentumFrame = requestFrame(step);
		};
		momentumFrame = requestFrame(step);
	};

	const findTouch = (list: TouchList): Touch | null => {
		for (let index = 0; index < list.length; index += 1) {
			const touch = list[index];
			if (touch && touch.identifier === touchId) {
				return touch;
			}
		}
		return null;
	};

	const onTouchStart = (event: TouchEvent) => {
		stopMomentum();
		const touch = event.touches[0];
		if (event.touches.length !== 1 || !touch) {
			// Pinch or multi-finger gestures belong to the browser.
			touchId = null;
			return;
		}
		touchId = touch.identifier;
		startX = touch.clientX;
		startY = touch.clientY;
		lastY = touch.clientY;
		axis = "none";
		pendingPx = 0;
		samples = [{ time: now(), y: touch.clientY }];
	};

	const onTouchMove = (event: TouchEvent) => {
		if (touchId === null) {
			return;
		}
		const touch = findTouch(event.changedTouches);
		if (!touch) {
			return;
		}
		if (axis === "none") {
			const dx = Math.abs(touch.clientX - startX);
			const dy = Math.abs(touch.clientY - startY);
			if (dx < slopPx && dy < slopPx) {
				return;
			}
			// lastY is still the start point, so the slop distance counts towards the scroll.
			axis = dy >= dx ? "vertical" : "horizontal";
		}
		if (axis !== "vertical") {
			return;
		}
		if (event.cancelable) {
			event.preventDefault();
		}
		const time = now();
		scrollByPixels(touch.clientY - lastY);
		lastY = touch.clientY;
		samples.push({ time, y: touch.clientY });
		samples = samples.filter((sample) => time - sample.time <= VELOCITY_WINDOW_MS);
	};

	const onTouchEnd = (event: TouchEvent) => {
		if (touchId === null || !findTouch(event.changedTouches)) {
			return;
		}
		touchId = null;
		if (axis !== "vertical") {
			return;
		}
		const first = samples[0];
		const last = samples[samples.length - 1];
		if (!first || !last || last.time === first.time || now() - last.time > VELOCITY_WINDOW_MS) {
			return;
		}
		const velocity = (last.y - first.y) / (last.time - first.time);
		if (Math.abs(velocity) >= minFlickVelocity) {
			startMomentum(velocity);
		}
	};

	const onTouchCancel = () => {
		touchId = null;
		stopMomentum();
	};

	// Let the browser keep horizontal panning and pinch zoom; vertical drags are ours.
	const previousTouchAction = element.style.touchAction;
	element.style.touchAction = "pan-x pinch-zoom";
	element.addEventListener("touchstart", onTouchStart, { passive: true });
	element.addEventListener("touchmove", onTouchMove, { passive: false });
	element.addEventListener("touchend", onTouchEnd, { passive: true });
	element.addEventListener("touchcancel", onTouchCancel, { passive: true });

	return () => {
		stopMomentum();
		element.style.touchAction = previousTouchAction;
		element.removeEventListener("touchstart", onTouchStart);
		element.removeEventListener("touchmove", onTouchMove);
		element.removeEventListener("touchend", onTouchEnd);
		element.removeEventListener("touchcancel", onTouchCancel);
	};
}
