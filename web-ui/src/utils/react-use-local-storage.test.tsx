import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useBooleanLocalStorageValue, useRawLocalStorageValue } from "@/utils/react-use";

type Setter<T> = (next: T | ((current: T) => T)) => void;

let booleanValue: boolean | null = null;
let setBoolean: Setter<boolean> | null = null;
let rawValue: string | null = null;
let setRaw: Setter<"a" | "b"> | null = null;

const normalize = (value: string): "a" | "b" | null => (value === "a" || value === "b" ? value : null);

function Probe(): null {
	[booleanValue, setBoolean] = useBooleanLocalStorageValue("test.boolean", false);
	[rawValue, setRaw] = useRawLocalStorageValue<"a" | "b">("test.raw", "a", normalize);
	return null;
}

describe("local storage value hooks", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => {
			root.render(<Probe />);
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		localStorage.clear();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	it("resolves every function update against the latest value, not the first render's", () => {
		for (const expected of [true, false, true]) {
			act(() => {
				setBoolean?.((current) => !current);
			});
			expect(booleanValue).toBe(expected);
			expect(localStorage.getItem("test.boolean")).toBe(String(expected));
		}
		for (const expected of ["b", "a", "b"]) {
			act(() => {
				setRaw?.((current) => (current === "a" ? "b" : "a"));
			});
			expect(rawValue).toBe(expected);
		}
	});
});
