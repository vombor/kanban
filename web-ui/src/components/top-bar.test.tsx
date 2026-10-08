import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TopBar } from "@/components/top-bar";
import { TooltipProvider } from "@/components/ui/tooltip";

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
	descriptor?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TopBar script shortcut onboarding", () => {
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("opens first-shortcut dialog from Run and saves when command is provided", async () => {
		const onCreateFirstShortcut = vi.fn(async () => ({ ok: true }));
		const onRunShortcut = vi.fn();

		await act(async () => {
			root.render(
				<TooltipProvider>
					<TopBar shortcuts={[]} onRunShortcut={onRunShortcut} onCreateFirstShortcut={onCreateFirstShortcut} />
				</TooltipProvider>,
			);
		});

		const runButton = findButtonByText(container, "Run");
		expect(runButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			runButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			runButton?.click();
		});

		expect(document.body.textContent).toContain("Set up your first script shortcut");

		const commandInput = Array.from(document.body.querySelectorAll("input")).find(
			(input) => input.placeholder === "npm run dev",
		) as HTMLInputElement | undefined;
		expect(commandInput).toBeDefined();
		expect(commandInput?.value).toBe("");

		const saveButton = findButtonByText(document.body, "Save");
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);
		expect(saveButton?.disabled).toBe(true);

		await act(async () => {
			if (!commandInput) {
				return;
			}
			setInputValue(commandInput, "pnpm dev");
		});
		expect(saveButton?.disabled).toBe(false);

		await act(async () => {
			saveButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			saveButton?.click();
		});

		expect(onCreateFirstShortcut).toHaveBeenCalledWith({
			label: "Run",
			command: "pnpm dev",
			icon: "play",
		});
		expect(onRunShortcut).not.toHaveBeenCalled();
	});

	it("does not render an open-in-local-app button for the workspace path", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TopBar workspacePath="/repo/project" />
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("project");
		expect(findButtonByText(container, "Open")).toBeNull();
	});

	it("opens settings when the runtime hint is clicked", async () => {
		const onOpenSettings = vi.fn();

		await act(async () => {
			root.render(
				<TooltipProvider>
					<TopBar runtimeHint="No agent configured" onOpenSettings={onOpenSettings} />
				</TooltipProvider>,
			);
		});

		const runtimeHintButton = findButtonByText(container, "No agent configured");
		expect(runtimeHintButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			runtimeHintButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			runtimeHintButton?.click();
		});

		expect(onOpenSettings).toHaveBeenCalledTimes(1);
	});
});

describe("TopBar tips popover", () => {
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function getTipsButton(): HTMLButtonElement {
		const button = container.querySelector<HTMLButtonElement>('[data-testid="open-tips-button"]');
		if (!button) {
			throw new Error("Tips button was not rendered");
		}
		return button;
	}

	function getTipsPopover(): HTMLElement | null {
		return document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Tips & shortcuts"]');
	}

	it("puts a lightbulb button directly left of the settings cog", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TopBar onOpenSettings={() => {}} />
				</TooltipProvider>,
			);
		});
		const tipsButton = getTipsButton();
		const settingsButton = container.querySelector('[data-testid="open-settings-button"]');
		expect(tipsButton.getAttribute("aria-label")).toBe("Tips & shortcuts");
		expect(tipsButton.querySelector("svg")?.getAttribute("class")).toContain("lucide-lightbulb");
		expect(tipsButton.nextElementSibling).toBe(settingsButton);
		expect(getTipsPopover()).toBeNull();
	});

	it("opens the tips and shortcuts from the lightbulb, and Esc closes them", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TopBar showAgentHints />
				</TooltipProvider>,
			);
		});
		const tipsButton = getTipsButton();
		await act(async () => {
			tipsButton.click();
		});
		const popover = getTipsPopover();
		expect(tipsButton.getAttribute("aria-expanded")).toBe("true");
		expect(popover?.textContent).toContain("Create tasks.");
		expect(popover?.querySelector('[aria-label="Keyboard shortcuts"]')?.textContent).toContain("Start backlog tasks");

		await act(async () => {
			document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(getTipsPopover()).toBeNull();
		expect(tipsButton.getAttribute("aria-expanded")).toBe("false");
	});

	it("lists only the shortcuts when no agent is selected", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TopBar />
				</TooltipProvider>,
			);
		});
		await act(async () => {
			getTipsButton().click();
		});
		const popover = getTipsPopover();
		expect(popover?.querySelector('[aria-label="Keyboard shortcuts"]')?.textContent).toContain("New task");
		expect(popover?.textContent).not.toContain("Create tasks.");
	});
});
