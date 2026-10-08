// One-finger vertical swipes in an agent terminal (xterm.js 6 has no touch
// scrolling of its own: it bundles VS Code's gesture code but registers no
// target, so on a phone only the scrollbar moved the viewport).
//
// What a swipe does depends on the screen the agent drew, like a mouse wheel
// on desktop (resolveTouchScrollMode):
// - "scrollback": the normal buffer; the swipe scrolls xterm's own scrollback.
// - "mouse-wheel": the app turned on mouse reporting (Claude Code's fullscreen
//   renderer, Cline 3.x --tui, Codex, Copilot: all on the alternate screen);
//   the swipe sends wheel reports, which these TUIs use to scroll their own
//   transcript (about 3 lines per notch).
// - "none": an alternate screen without mouse reporting has no scrollback, and
//   xterm's wheel fallback (arrow keys) would recall prompt history or move a
//   menu selection, so a swipe does nothing there.
//
// Taps, long-presses (selection, context menu), pinches and horizontal swipes
// are never claimed, so focus, the on-screen keyboard and the board's
// horizontal scroll keep working.

export type TouchScrollMode = "scrollback" | "mouse-wheel" | "none";

export type TerminalMouseTrackingMode = "none" | "x10" | "vt200" | "drag" | "any";

export interface TouchScrollModeInput {
	bufferType: "normal" | "alternate";
	mouseTrackingMode: TerminalMouseTrackingMode;
}

// x10 tracking reports button presses only, never the wheel; xterm then
// handles the wheel as if tracking were off, and so do we.
export function resolveTouchScrollMode({ bufferType, mouseTrackingMode }: TouchScrollModeInput): TouchScrollMode {
	if (mouseTrackingMode !== "none" && mouseTrackingMode !== "x10") {
		return "mouse-wheel";
	}
	return bufferType === "normal" ? "scrollback" : "none";
}

export interface TouchSample {
	x: number;
	y: number;
	time: number;
}

// Movement below this is still a tap (and stays one for the browser).
export const TOUCH_SCROLL_SLOP_PX = 8;
// A finger that rests this long before moving is a long-press (text
// selection, context menu), not a swipe.
export const TOUCH_SCROLL_LONG_PRESS_MS = 450;
// Velocity is measured over the last part of the swipe only.
const VELOCITY_WINDOW_MS = 100;
// A finger that stopped this long before lifting gets no momentum.
const VELOCITY_REST_MS = 60;

export type TouchMoveResult =
	| { kind: "pending" }
	| { kind: "ignored" }
	// Positive deltaPx: the finger moved up, so the content moves toward newer output.
	| { kind: "scroll"; deltaPx: number };

// Decides whether a single touch is a vertical swipe and turns its moves into
// pixel deltas. A gesture that is not a swipe is ignored until the next start.
export class TouchScrollGesture {
	private startSample: TouchSample | null = null;
	private lastY = 0;
	private state: "idle" | "pending" | "scrolling" | "ignored" = "idle";
	private samples: TouchSample[] = [];

	start(sample: TouchSample): void {
		this.startSample = sample;
		this.lastY = sample.y;
		this.state = "pending";
		this.samples = [sample];
	}

	isScrolling(): boolean {
		return this.state === "scrolling";
	}

	move(sample: TouchSample): TouchMoveResult {
		const start = this.startSample;
		if (!start || this.state === "idle" || this.state === "ignored") {
			return { kind: "ignored" };
		}
		if (this.state === "pending") {
			const dx = sample.x - start.x;
			const dy = sample.y - start.y;
			if (Math.hypot(dx, dy) < TOUCH_SCROLL_SLOP_PX) {
				return { kind: "pending" };
			}
			if (Math.abs(dy) <= Math.abs(dx) || sample.time - start.time > TOUCH_SCROLL_LONG_PRESS_MS) {
				this.state = "ignored";
				return { kind: "ignored" };
			}
			this.state = "scrolling";
		}
		const deltaPx = this.lastY - sample.y;
		this.lastY = sample.y;
		this.samples.push(sample);
		this.samples = this.samples.filter((entry) => sample.time - entry.time <= VELOCITY_WINDOW_MS);
		return { kind: "scroll", deltaPx };
	}

	// Ends the gesture and returns its release velocity in px/ms (same sign as
	// deltaPx), or 0 when it was no swipe or the finger rested before lifting.
	end(time: number): number {
		const wasScrolling = this.state === "scrolling";
		const samples = this.samples;
		this.cancel();
		if (!wasScrolling || samples.length < 2) {
			return 0;
		}
		const first = samples[0];
		const last = samples[samples.length - 1];
		if (!first || !last || time - last.time > VELOCITY_REST_MS || last.time <= first.time) {
			return 0;
		}
		return (first.y - last.y) / (last.time - first.time);
	}

	cancel(): void {
		this.startSample = null;
		this.state = "idle";
		this.samples = [];
	}
}

// Momentum decays exponentially, like a native scroll view.
const MOMENTUM_TIME_CONSTANT_MS = 325;
export const MOMENTUM_MIN_VELOCITY = 0.02;
// Slow flings get no momentum at all.
export const MOMENTUM_START_VELOCITY = 0.25;
const MOMENTUM_MAX_VELOCITY = 8;

export function clampMomentumVelocity(velocity: number): number {
	return Math.max(-MOMENTUM_MAX_VELOCITY, Math.min(MOMENTUM_MAX_VELOCITY, velocity));
}

// Advances a momentum scroll by dtMs: the distance travelled (px) and the
// velocity left. Done once the velocity falls below MOMENTUM_MIN_VELOCITY.
export function stepMomentum(velocity: number, dtMs: number): { distancePx: number; velocity: number; done: boolean } {
	const decay = Math.exp(-dtMs / MOMENTUM_TIME_CONSTANT_MS);
	const distancePx = velocity * MOMENTUM_TIME_CONSTANT_MS * (1 - decay);
	const next = velocity * decay;
	return { distancePx, velocity: next, done: Math.abs(next) < MOMENTUM_MIN_VELOCITY };
}

// Turns pixel deltas into whole steps (terminal lines, or wheel notches) and
// keeps the remainder, so slow swipes still scroll.
export class ScrollStepAccumulator {
	private remainderPx = 0;

	add(deltaPx: number, pxPerStep: number): number {
		if (!(pxPerStep > 0)) {
			return 0;
		}
		this.remainderPx += deltaPx;
		const steps = Math.trunc(this.remainderPx / pxPerStep);
		this.remainderPx -= steps * pxPerStep;
		return steps;
	}

	reset(): void {
		this.remainderPx = 0;
	}
}

// One wheel report per this many lines of finger travel: the agent TUIs scroll
// about 3 lines per notch, so the transcript roughly follows the finger.
export const MOUSE_WHEEL_LINES_PER_REPORT = 3;

export interface TouchScrollTarget {
	getMode: () => TouchScrollMode;
	getLineHeightPx: () => number;
	// Positive scrolls toward newer output, like Terminal.scrollLines.
	scrollLines: (lines: number) => void;
	// One wheel notch at the given point; positive is toward newer output.
	sendWheel: (direction: 1 | -1, point: { clientX: number; clientY: number }, target: EventTarget | null) => void;
}

interface FrameScheduler {
	request: (callback: (time: number) => void) => number;
	cancel: (handle: number) => void;
	now: () => number;
}

const defaultFrameScheduler: FrameScheduler = {
	request: (callback) => window.requestAnimationFrame(callback),
	cancel: (handle) => window.cancelAnimationFrame(handle),
	now: () => performance.now(),
};

// Binds swipe scrolling to a terminal's host element. Returns the cleanup.
export function attachTerminalTouchScroll(
	element: HTMLElement,
	target: TouchScrollTarget,
	scheduler: FrameScheduler = defaultFrameScheduler,
): () => void {
	const gesture = new TouchScrollGesture();
	const accumulator = new ScrollStepAccumulator();
	let mode: TouchScrollMode = "none";
	let point = { clientX: 0, clientY: 0 };
	let touchTarget: EventTarget | null = null;
	let momentumFrame: number | null = null;
	// A tap that stops a fling only stops it; it must not also focus or click.
	let touchStoppedMomentum = false;

	const applyDelta = (deltaPx: number): void => {
		const lineHeight = target.getLineHeightPx();
		if (mode === "scrollback") {
			const lines = accumulator.add(deltaPx, lineHeight);
			if (lines !== 0) {
				target.scrollLines(lines);
			}
			return;
		}
		if (mode === "mouse-wheel") {
			const notches = accumulator.add(deltaPx, lineHeight * MOUSE_WHEEL_LINES_PER_REPORT);
			const direction = notches > 0 ? 1 : -1;
			for (let index = 0; index < Math.abs(notches); index += 1) {
				target.sendWheel(direction, point, touchTarget);
			}
		}
	};

	const stopMomentum = (): boolean => {
		if (momentumFrame === null) {
			return false;
		}
		scheduler.cancel(momentumFrame);
		momentumFrame = null;
		return true;
	};

	const startMomentum = (initialVelocity: number): void => {
		let velocity = clampMomentumVelocity(initialVelocity);
		let lastTime = scheduler.now();
		const frame = (time: number): void => {
			const step = stepMomentum(velocity, Math.max(0, time - lastTime));
			lastTime = time;
			velocity = step.velocity;
			applyDelta(step.distancePx);
			momentumFrame = step.done ? null : scheduler.request(frame);
		};
		momentumFrame = scheduler.request(frame);
	};

	const onTouchStart = (event: TouchEvent): void => {
		touchStoppedMomentum = stopMomentum();
		const touch = event.touches.length === 1 ? event.touches[0] : undefined;
		if (!touch) {
			gesture.cancel();
			return;
		}
		mode = target.getMode();
		accumulator.reset();
		point = { clientX: touch.clientX, clientY: touch.clientY };
		touchTarget = event.target;
		gesture.start({ x: touch.clientX, y: touch.clientY, time: event.timeStamp });
	};

	const onTouchMove = (event: TouchEvent): void => {
		const touch = event.touches.length === 1 ? event.touches[0] : undefined;
		if (!touch) {
			gesture.cancel();
			return;
		}
		if (mode === "none") {
			return;
		}
		const result = gesture.move({ x: touch.clientX, y: touch.clientY, time: event.timeStamp });
		if (result.kind !== "scroll") {
			return;
		}
		if (event.cancelable) {
			event.preventDefault();
		}
		point = { clientX: touch.clientX, clientY: touch.clientY };
		applyDelta(result.deltaPx);
	};

	const onTouchEnd = (event: TouchEvent): void => {
		const wasScrolling = gesture.isScrolling();
		const velocity = gesture.end(event.timeStamp);
		if (wasScrolling && Math.abs(velocity) >= MOMENTUM_START_VELOCITY) {
			startMomentum(velocity);
		}
		if (!wasScrolling && touchStoppedMomentum && event.cancelable) {
			event.preventDefault();
		}
		touchStoppedMomentum = false;
	};

	const onTouchCancel = (): void => {
		gesture.cancel();
		touchStoppedMomentum = false;
	};

	element.addEventListener("touchstart", onTouchStart, { passive: true });
	element.addEventListener("touchmove", onTouchMove, { passive: false });
	element.addEventListener("touchend", onTouchEnd, { passive: false });
	element.addEventListener("touchcancel", onTouchCancel, { passive: true });
	return () => {
		stopMomentum();
		element.removeEventListener("touchstart", onTouchStart);
		element.removeEventListener("touchmove", onTouchMove);
		element.removeEventListener("touchend", onTouchEnd);
		element.removeEventListener("touchcancel", onTouchCancel);
	};
}

// Whether the viewport is above the newest output of the normal buffer (the
// alternate screen has no scrollback to be above).
export function isTerminalScrolledUp(buffer: {
	type: "normal" | "alternate";
	viewportY: number;
	baseY: number;
}): boolean {
	return buffer.type === "normal" && buffer.viewportY < buffer.baseY;
}
