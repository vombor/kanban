import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BoardCardTokenUsage } from "@/components/board-card-token-usage";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setTaskTokenUsage } from "@/stores/task-token-usage-store";

describe("BoardCardTokenUsage", () => {
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
		setTaskTokenUsage([]);
		container.remove();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	const render = async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCardTokenUsage taskId="7ad4d" />
				</TooltipProvider>,
			);
		});
	};

	it("shows the card's total with the cache included, and follows the store", async () => {
		setTaskTokenUsage([{ taskId: "7ad4d", input: 1_000, output: 20_000, cacheRead: 1_150_000, cacheWrite: 30_000 }]);
		await render();
		const label = () => container.querySelector('[data-testid="board-card-token-usage"]')?.textContent;
		expect(label()).toBe("1.2M tokens");

		await act(async () => {
			setTaskTokenUsage([
				{ taskId: "7ad4d", input: 1_000, output: 20_000, cacheRead: 2_150_000, cacheWrite: 30_000 },
			]);
		});
		expect(label()).toBe("2.2M tokens");
	});

	it("shows nothing for a card nothing was counted for", async () => {
		setTaskTokenUsage([{ taskId: "other", input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }]);
		await render();
		expect(container.querySelector('[data-testid="board-card-token-usage"]')).toBeNull();
	});
});
