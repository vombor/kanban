import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	attachTerminalTouchScroll,
	isTerminalScrolledUp,
	MOMENTUM_MIN_VELOCITY,
	MOUSE_WHEEL_LINES_PER_REPORT,
	resolveTouchScrollMode,
	ScrollStepAccumulator,
	stepMomentum,
	TOUCH_SCROLL_LONG_PRESS_MS,
	TouchScrollGesture,
	type TouchScrollMode,
} from "@/terminal/terminal-touch-scroll";

describe("resolveTouchScrollMode", () => {
	it("scrolls the scrollback of the normal buffer", () => {
		expect(resolveTouchScrollMode({ bufferType: "normal", mouseTrackingMode: "none" })).toBe("scrollback");
	});

	it("sends wheel reports wherever the app reports the wheel", () => {
		for (const mouseTrackingMode of ["vt200", "drag", "any"] as const) {
			expect(resolveTouchScrollMode({ bufferType: "alternate", mouseTrackingMode })).toBe("mouse-wheel");
			expect(resolveTouchScrollMode({ bufferType: "normal", mouseTrackingMode })).toBe("mouse-wheel");
		}
	});

	it("does nothing on an alternate screen that reports no wheel (no arrow keys typed for the user)", () => {
		expect(resolveTouchScrollMode({ bufferType: "alternate", mouseTrackingMode: "none" })).toBe("none");
		expect(resolveTouchScrollMode({ bufferType: "alternate", mouseTrackingMode: "x10" })).toBe("none");
		expect(resolveTouchScrollMode({ bufferType: "normal", mouseTrackingMode: "x10" })).toBe("scrollback");
	});
});

describe("TouchScrollGesture", () => {
	it("stays a tap below the slop and then follows a vertical finger", () => {
		const gesture = new TouchScrollGesture();
		gesture.start({ x: 100, y: 300, time: 0 });
		expect(gesture.move({ x: 101, y: 296, time: 10 })).toEqual({ kind: "pending" });
		// Finger moves down: older output, negative delta from the start point.
		expect(gesture.move({ x: 102, y: 320, time: 20 })).toEqual({ kind: "scroll", deltaPx: -20 });
		expect(gesture.isScrolling()).toBe(true);
		expect(gesture.move({ x: 102, y: 310, time: 30 })).toEqual({ kind: "scroll", deltaPx: 10 });
	});

	it("leaves horizontal swipes (the board) alone for the whole gesture", () => {
		const gesture = new TouchScrollGesture();
		gesture.start({ x: 100, y: 300, time: 0 });
		expect(gesture.move({ x: 130, y: 310, time: 20 })).toEqual({ kind: "ignored" });
		expect(gesture.move({ x: 130, y: 400, time: 40 })).toEqual({ kind: "ignored" });
		expect(gesture.end(50)).toBe(0);
	});

	it("leaves a long-press (selection, context menu) alone even when the finger moves afterwards", () => {
		const gesture = new TouchScrollGesture();
		gesture.start({ x: 100, y: 300, time: 0 });
		expect(gesture.move({ x: 100, y: 302, time: 200 })).toEqual({ kind: "pending" });
		expect(gesture.move({ x: 100, y: 360, time: TOUCH_SCROLL_LONG_PRESS_MS + 1 })).toEqual({ kind: "ignored" });
	});

	it("measures the release velocity over the end of the swipe", () => {
		const gesture = new TouchScrollGesture();
		gesture.start({ x: 0, y: 500, time: 0 });
		gesture.move({ x: 0, y: 480, time: 10 });
		for (let time = 20; time <= 200; time += 10) {
			gesture.move({ x: 0, y: 500 - time * 2, time });
		}
		expect(gesture.end(205)).toBeCloseTo(2, 5);
	});

	it("gives no momentum when the finger rested before lifting", () => {
		const gesture = new TouchScrollGesture();
		gesture.start({ x: 0, y: 500, time: 0 });
		gesture.move({ x: 0, y: 400, time: 50 });
		gesture.move({ x: 0, y: 300, time: 100 });
		expect(gesture.end(400)).toBe(0);
	});
});

describe("stepMomentum", () => {
	it("travels in the fling's direction, decays and stops", () => {
		let velocity = 3;
		let travelled = 0;
		let frames = 0;
		let done = false;
		while (!done && frames < 1_000) {
			const step = stepMomentum(velocity, 16);
			expect(Math.abs(step.velocity)).toBeLessThan(Math.abs(velocity));
			travelled += step.distancePx;
			velocity = step.velocity;
			done = step.done;
			frames += 1;
		}
		expect(done).toBe(true);
		expect(Math.abs(velocity)).toBeLessThan(MOMENTUM_MIN_VELOCITY);
		// Total distance approaches v0 * time constant (325 ms).
		expect(travelled).toBeGreaterThan(900);
		expect(travelled).toBeLessThan(3 * 325);
		expect(stepMomentum(-3, 16).distancePx).toBeLessThan(0);
	});
});

describe("ScrollStepAccumulator", () => {
	it("keeps the remainder so slow swipes still scroll, in both directions", () => {
		const accumulator = new ScrollStepAccumulator();
		expect(accumulator.add(6, 15)).toBe(0);
		expect(accumulator.add(6, 15)).toBe(0);
		expect(accumulator.add(6, 15)).toBe(1);
		expect(accumulator.add(-40, 15)).toBe(-2);
		expect(accumulator.add(5, 0)).toBe(0);
	});
});

describe("isTerminalScrolledUp", () => {
	it("is scrolled up only above the newest output of the normal buffer", () => {
		expect(isTerminalScrolledUp({ type: "normal", viewportY: 10, baseY: 50 })).toBe(true);
		expect(isTerminalScrolledUp({ type: "normal", viewportY: 50, baseY: 50 })).toBe(false);
		expect(isTerminalScrolledUp({ type: "alternate", viewportY: 0, baseY: 50 })).toBe(false);
	});
});

interface FakeTouch {
	clientX: number;
	clientY: number;
}

function dispatchTouch(
	element: HTMLElement,
	type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
	touches: FakeTouch[],
	timeStamp: number,
): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "touches", { value: touches });
	Object.defineProperty(event, "timeStamp", { value: timeStamp });
	element.dispatchEvent(event);
	return event;
}

describe("attachTerminalTouchScroll", () => {
	const LINE_HEIGHT = 15;
	let element: HTMLElement;
	let mode: TouchScrollMode;
	let scrolled: number[];
	let wheels: number[];
	let frames: Array<(time: number) => void>;
	let detach: () => void;

	beforeEach(() => {
		element = document.createElement("div");
		document.body.appendChild(element);
		mode = "scrollback";
		scrolled = [];
		wheels = [];
		frames = [];
		detach = attachTerminalTouchScroll(
			element,
			{
				getMode: () => mode,
				getLineHeightPx: () => LINE_HEIGHT,
				scrollLines: (lines) => {
					scrolled.push(lines);
				},
				sendWheel: (direction) => {
					wheels.push(direction);
				},
			},
			{
				request: (callback) => frames.push(callback),
				cancel: (handle) => {
					frames[handle - 1] = () => {};
				},
				now: () => 0,
			},
		);
	});

	afterEach(() => {
		detach();
		element.remove();
	});

	it("scrolls the scrollback by whole lines as the finger moves, and stops the page from scrolling", () => {
		dispatchTouch(element, "touchstart", [{ clientX: 50, clientY: 300 }], 0);
		const move = dispatchTouch(element, "touchmove", [{ clientX: 50, clientY: 330 }], 20);
		dispatchTouch(element, "touchmove", [{ clientX: 50, clientY: 340 }], 40);
		expect(move.defaultPrevented).toBe(true);
		// 40 px down = 2 lines toward older output (the 8 px slop is part of the swipe).
		expect(scrolled.reduce((sum, lines) => sum + lines, 0)).toBe(-2);
		dispatchTouch(element, "touchend", [], 400);
		expect(frames).toHaveLength(0);
	});

	it("keeps scrolling with momentum after a fling, and a tap stops it without clicking", () => {
		dispatchTouch(element, "touchstart", [{ clientX: 50, clientY: 500 }], 0);
		for (let time = 10; time <= 100; time += 10) {
			dispatchTouch(element, "touchmove", [{ clientX: 50, clientY: 500 - time * 2 }], time);
		}
		const linesDuringSwipe = scrolled.reduce((sum, lines) => sum + lines, 0);
		dispatchTouch(element, "touchend", [], 105);
		expect(frames.length).toBe(1);
		frames[0]?.(16);
		frames[1]?.(32);
		expect(scrolled.reduce((sum, lines) => sum + lines, 0)).toBeGreaterThan(linesDuringSwipe);

		dispatchTouch(element, "touchstart", [{ clientX: 50, clientY: 200 }], 200);
		const tapEnd = dispatchTouch(element, "touchend", [], 260);
		expect(tapEnd.defaultPrevented).toBe(true);
		// The frame the fling had asked for is cancelled and asks for no more.
		const linesAfterStop = scrolled.reduce((sum, lines) => sum + lines, 0);
		const frameCount = frames.length;
		frames[frameCount - 1]?.(48);
		expect(frames).toHaveLength(frameCount);
		expect(scrolled.reduce((sum, lines) => sum + lines, 0)).toBe(linesAfterStop);
	});

	it("leaves taps alone so they still focus the terminal and open the keyboard", () => {
		dispatchTouch(element, "touchstart", [{ clientX: 50, clientY: 300 }], 0);
		const move = dispatchTouch(element, "touchmove", [{ clientX: 52, clientY: 302 }], 30);
		const end = dispatchTouch(element, "touchend", [], 80);
		expect(move.defaultPrevented).toBe(false);
		expect(end.defaultPrevented).toBe(false);
		expect(scrolled).toEqual([]);
	});

	it("leaves two-finger gestures (pinch zoom) and horizontal swipes to the browser", () => {
		dispatchTouch(
			element,
			"touchstart",
			[
				{ clientX: 50, clientY: 300 },
				{ clientX: 150, clientY: 300 },
			],
			0,
		);
		const pinch = dispatchTouch(
			element,
			"touchmove",
			[
				{ clientX: 40, clientY: 260 },
				{ clientX: 160, clientY: 340 },
			],
			20,
		);
		expect(pinch.defaultPrevented).toBe(false);

		dispatchTouch(element, "touchstart", [{ clientX: 200, clientY: 300 }], 100);
		const swipe = dispatchTouch(element, "touchmove", [{ clientX: 120, clientY: 305 }], 120);
		expect(swipe.defaultPrevented).toBe(false);
		expect(scrolled).toEqual([]);
	});

	it("sends one wheel notch per few lines when the app reports the wheel", () => {
		mode = "mouse-wheel";
		dispatchTouch(element, "touchstart", [{ clientX: 50, clientY: 300 }], 0);
		dispatchTouch(
			element,
			"touchmove",
			[{ clientX: 50, clientY: 300 + LINE_HEIGHT * MOUSE_WHEEL_LINES_PER_REPORT * 2 }],
			30,
		);
		expect(wheels).toEqual([-1, -1]);
		expect(scrolled).toEqual([]);
	});

	it("does nothing on a screen without scrollback or wheel reports", () => {
		mode = "none";
		dispatchTouch(element, "touchstart", [{ clientX: 50, clientY: 300 }], 0);
		const move = dispatchTouch(element, "touchmove", [{ clientX: 50, clientY: 400 }], 30);
		expect(move.defaultPrevented).toBe(false);
		expect(scrolled).toEqual([]);
		expect(wheels).toEqual([]);
	});

	it("stops listening once detached", () => {
		detach();
		dispatchTouch(element, "touchstart", [{ clientX: 50, clientY: 300 }], 0);
		dispatchTouch(element, "touchmove", [{ clientX: 50, clientY: 400 }], 30);
		expect(scrolled).toEqual([]);
	});
});
