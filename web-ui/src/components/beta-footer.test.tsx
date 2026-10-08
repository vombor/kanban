import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BetaFooter } from "@/components/beta-footer";

describe("BetaFooter", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	it("renders a thin full-width bar with the beta notice and the Report issue link", () => {
		act(() => {
			root.render(<BetaFooter />);
		});
		const footer = container.querySelector("footer");
		expect(footer?.textContent).toContain("Kanban is in beta. Help us improve by sharing your experience.");
		// A fixed-height flex item, so the layout reserves its height instead of overlaying the board.
		expect(footer?.className).toContain("h-7");
		expect(footer?.className).toContain("shrink-0");
		expect(footer?.className).not.toContain("fixed");
		const link = footer?.querySelector("a");
		expect(link?.textContent).toBe("Report issue ");
		expect(link?.getAttribute("href")).toBe("https://github.com/vombor/kanban/issues");
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toBe("noreferrer");
	});
});
