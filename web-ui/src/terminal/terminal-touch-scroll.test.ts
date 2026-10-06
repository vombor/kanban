import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachTerminalTouchScroll } from "@/terminal/terminal-touch-scroll";

function touchEvent(type: string, x: number, y: number, identifier = 1): TouchEvent {
	const touch = { identifier, clientX: x, clientY: y } as Touch;
	const list = (type === "touchend" ? [] : [touch]) as unknown as TouchList;
	const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
	Object.defineProperty(event, "touches", { value: list });
	Object.defineProperty(event, "changedTouches", { value: [touch] as unknown as TouchList });
	return event;
}

describe("attachTerminalTouchScroll", () => {
	let element: HTMLDivElement;
	let scrolled: number[];
	let clock: number;
	let frames: Array<(time: number) => void>;
	let detach: () => void;

	beforeEach(() => {
		element = document.createElement("div");
		document.body.appendChild(element);
		scrolled = [];
		clock = 0;
		frames = [];
		detach = attachTerminalTouchScroll(
			element,
			{ scrollLines: (lines) => scrolled.push(lines), getLineHeight: () => 10 },
			{
				now: () => clock,
				requestFrame: (callback) => {
					frames.push(callback);
					return frames.length;
				},
				cancelFrame: () => {
					frames = [];
				},
			},
		);
	});

	afterEach(() => {
		detach();
		element.remove();
	});

	const drag = (points: Array<[number, number]>, msPerStep: number) => {
		const [first, ...rest] = points;
		element.dispatchEvent(touchEvent("touchstart", first?.[0] ?? 0, first?.[1] ?? 0));
		const moves: TouchEvent[] = [];
		for (const [x, y] of rest) {
			clock += msPerStep;
			const move = touchEvent("touchmove", x, y);
			element.dispatchEvent(move);
			moves.push(move);
		}
		const last = rest[rest.length - 1] ?? first ?? [0, 0];
		element.dispatchEvent(touchEvent("touchend", last[0], last[1]));
		return moves;
	};

	const runFrames = () => {
		for (let guard = 0; frames.length > 0 && guard < 1000; guard += 1) {
			const callback = frames.shift();
			clock += 16;
			callback?.(clock);
		}
	};

	const total = () => scrolled.reduce((sum, lines) => sum + lines, 0);

	it("scrolls one line per row height of vertical drag, finger up = towards newer output", () => {
		const moves = drag(
			[
				[50, 200],
				[50, 190],
				[50, 170],
				[50, 150],
			],
			200,
		);
		expect(total()).toBe(5);
		expect(moves.at(-1)?.defaultPrevented).toBe(true);
		runFrames();
		// Slow drag: no momentum.
		expect(total()).toBe(5);
	});

	it("keeps scrolling after a flick and slows to a stop", () => {
		drag(
			[
				[50, 100],
				[50, 120],
				[50, 160],
				[50, 200],
			],
			10,
		);
		const afterDrag = total();
		expect(afterDrag).toBeLessThan(0);
		runFrames();
		expect(total()).toBeLessThan(afterDrag);
		expect(frames).toHaveLength(0);
	});

	it("leaves horizontal drags and taps to the browser", () => {
		const moves = drag(
			[
				[50, 100],
				[90, 104],
				[140, 108],
			],
			20,
		);
		expect(scrolled).toEqual([]);
		expect(moves.some((move) => move.defaultPrevented)).toBe(false);

		drag([[50, 100]], 20);
		expect(scrolled).toEqual([]);
	});

	it("does not react to mouse events, so desktop selection is unchanged", () => {
		element.dispatchEvent(new MouseEvent("mousedown", { clientX: 10, clientY: 100, bubbles: true }));
		element.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 10, bubbles: true }));
		element.dispatchEvent(new MouseEvent("mouseup", { clientX: 10, clientY: 10, bubbles: true }));
		expect(scrolled).toEqual([]);
	});

	it("a new touch stops momentum", () => {
		drag(
			[
				[50, 100],
				[50, 140],
				[50, 200],
			],
			10,
		);
		expect(frames.length).toBe(1);
		element.dispatchEvent(touchEvent("touchstart", 50, 100));
		expect(frames).toHaveLength(0);
	});
});
