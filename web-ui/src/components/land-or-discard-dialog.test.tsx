import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LandOrDiscardDialog } from "@/components/land-or-discard-dialog";
import type { RuntimeTaskLandingChoice } from "@/runtime/types";

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("LandOrDiscardDialog", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	function renderDialog(canLand: boolean, onChoose: (choice: RuntimeTaskLandingChoice | null) => void): void {
		act(() => {
			root.render(
				<LandOrDiscardDialog open taskTitle="Fix the cart" baseRef="main" canLand={canLand} onChoose={onChoose} />,
			);
		});
	}

	function buttonLabels(): string[] {
		return Array.from(document.body.querySelectorAll("button")).map((button) => button.textContent ?? "");
	}

	it("offers land and discard where Kanban lands the card", () => {
		renderDialog(true, () => {});

		expect(document.body.textContent).toContain("Land or discard?");
		expect(buttonLabels()).toEqual(["Cancel", "Discard", "Land on main"]);
	});

	it("offers only a discard where Kanban lands nothing, and points at Commit / Open PR", () => {
		const onChoose = vi.fn();
		renderDialog(false, onChoose);

		expect(document.body.textContent).toContain("Discard uncommitted work?");
		expect(document.body.textContent).toContain("use Commit or Open PR first");
		expect(buttonLabels()).toEqual(["Cancel", "Discard"]);

		const discard = Array.from(document.body.querySelectorAll("button")).find(
			(button) => button.textContent === "Discard",
		);
		act(() => {
			discard?.click();
		});
		expect(onChoose).toHaveBeenCalledWith("discard");
	});
});
