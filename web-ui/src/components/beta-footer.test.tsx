import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BetaFooter } from "@/components/beta-footer";

describe("BetaFooter", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let previousAppVersion: unknown;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		previousAppVersion = (globalThis as typeof globalThis & { __APP_VERSION__?: unknown }).__APP_VERSION__;
		(globalThis as typeof globalThis & { __APP_VERSION__?: string }).__APP_VERSION__ = "0.1.70-fork.6";
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
		if (typeof previousAppVersion === "undefined") {
			delete (globalThis as typeof globalThis & { __APP_VERSION__?: unknown }).__APP_VERSION__;
		} else {
			(globalThis as typeof globalThis & { __APP_VERSION__?: unknown }).__APP_VERSION__ = previousAppVersion;
		}
	});

	function renderFooter(): HTMLElement {
		act(() => {
			root.render(<BetaFooter />);
		});
		const footer = container.querySelector("footer");
		if (!footer) {
			throw new Error("Footer was not rendered");
		}
		return footer;
	}

	it("renders a thin full-width bar with the beta notice and the Report issue link", () => {
		const footer = renderFooter();
		expect(footer.textContent).toContain("Kanban is in beta. Help us improve by sharing your experience.");
		// A fixed-height flex item, so the layout reserves its height instead of overlaying the board.
		expect(footer.className).toContain("h-7");
		expect(footer.className).toContain("shrink-0");
		expect(footer.className).not.toContain("fixed");
		const link = footer.querySelector("a");
		expect(link?.textContent).toBe("Report issue ");
		expect(link?.getAttribute("href")).toBe("https://github.com/vombor/kanban/issues");
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toBe("noreferrer");
	});

	it("puts Report issue right after the beta notice on the left, and the version on the right", () => {
		const footer = renderFooter();
		const notice = footer.querySelector("p");
		const link = footer.querySelector("a");
		const version = footer.querySelector('[data-testid="app-version"]');
		expect(notice?.nextElementSibling).toBe(link);
		// The notice doesn't grow, so the link sits right after its text; the version takes the free space on its left.
		expect(notice?.className).not.toContain("flex-1");
		expect(link?.className).not.toContain("ml-auto");
		expect(link?.nextElementSibling).toBe(version);
		expect(footer.lastElementChild).toBe(version);
		expect(version?.textContent).toBe("v0.1.70-fork.6");
		expect(version?.className).toContain("ml-auto");
		expect(version?.className).toContain("text-text-tertiary");
	});

	it("truncates the beta notice first on a narrow screen, so the link and the version stay visible", () => {
		const footer = renderFooter();
		expect(footer.querySelector("p")?.className).toContain("truncate");
		expect(footer.querySelector("p")?.className).toContain("min-w-0");
		expect(footer.querySelector("a")?.className).toContain("shrink-0");
		expect(footer.querySelector('[data-testid="app-version"]')?.className).toContain("shrink-0");
	});
});
