import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBadgedFaviconSvg, useFaviconBadge } from "@/hooks/use-favicon-badge";

function Harness({ active }: { active: boolean }): null {
	useFaviconBadge(active);
	return null;
}

describe("useFaviconBadge", () => {
	let container: HTMLDivElement;
	let root: Root;
	let link: HTMLLinkElement;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		link = document.createElement("link");
		link.rel = "icon";
		link.setAttribute("href", "/assets/icon.svg");
		document.head.appendChild(link);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect/></svg>')),
		);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		link.remove();
		vi.unstubAllGlobals();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	it("draws the dot into the app icon, or alone when there is no icon", () => {
		expect(buildBadgedFaviconSvg('<svg viewBox="0 0 64 64"><rect/></svg>')).toMatch(
			/<rect\/><circle [^>]+\/><\/svg>$/u,
		);
		expect(buildBadgedFaviconSvg("")).toContain("<circle");
	});

	it("badges the favicon while active and puts the original back after", async () => {
		await act(async () => {
			root.render(<Harness active />);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(link.getAttribute("href")).toMatch(/^data:image\/svg\+xml,.*circle/u);

		act(() => {
			root.render(<Harness active={false} />);
		});
		expect(link.getAttribute("href")).toBe("/assets/icon.svg");
	});
});
