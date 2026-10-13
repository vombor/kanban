import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandOrDiscardDialog } from "@/components/land-or-discard-dialog";
import type { RuntimePipelineCardStage, RuntimeTaskLandingChoice } from "@/runtime/types";
import { setPipelineCardStages } from "@/stores/pipeline-card-stage-store";
import { formatLocalTime } from "@/utils/format-local-time";

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const TASK_ID = "8c28e";
const DEADLINE = Date.UTC(2026, 9, 11, 7, 3);

function stage(overrides: Partial<RuntimePipelineCardStage> = {}): RuntimePipelineCardStage {
	return {
		taskId: TASK_ID,
		kind: "checks_running",
		label: "Checks running (test)",
		next: "QA next",
		qaTaskId: null,
		deadline: DEADLINE,
		detail: null,
		detailTimes: [],
		inFlight: true,
		...overrides,
	};
}

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
		setPipelineCardStages([]);
		container.remove();
		(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	function renderDialog(canLand: boolean, onChoose: (choice: RuntimeTaskLandingChoice | null) => void): void {
		act(() => {
			root.render(
				<LandOrDiscardDialog
					open
					taskId={TASK_ID}
					taskTitle="Fix the cart"
					baseRef="main"
					canLand={canLand}
					onChoose={onChoose}
				/>,
			);
		});
	}

	function buttonLabels(): string[] {
		return Array.from(document.body.querySelectorAll("button")).map((button) => button.textContent ?? "");
	}

	function clickButton(label: string): void {
		const button = Array.from(document.body.querySelectorAll("button")).find(
			(candidate) => candidate.textContent === label,
		);
		expect(button, `button "${label}"`).toBeDefined();
		act(() => {
			button?.click();
		});
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

	describe("while the pipeline works on the card (issue #30)", () => {
		it("shows the stage with its deadline and marks Land, which still lands", () => {
			const onChoose = vi.fn();
			setPipelineCardStages([stage()]);
			renderDialog(true, onChoose);

			expect(document.body.textContent).toContain("The pipeline is still working on it:");
			expect(document.body.textContent).toContain(
				`Checks running (test) · QA next · until ${formatLocalTime(DEADLINE)}`,
			);
			expect(document.body.textContent).toContain(
				"Land squash-lands it now and skips the rest of its checks and QA.",
			);
			expect(buttonLabels()).toEqual(["Cancel", "Discard", "Land anyway on main"]);

			clickButton("Land anyway on main");
			expect(onChoose).toHaveBeenCalledWith("land");
		});

		it("leaves Discard as it is", () => {
			const onChoose = vi.fn();
			setPipelineCardStages([stage({ kind: "qa_running", label: "QA r2 running", next: null, qaTaskId: "12ab6" })]);
			renderDialog(true, onChoose);

			expect(document.body.textContent).toContain("QA r2 running (12ab6)");
			clickButton("Discard");
			expect(onChoose).toHaveBeenCalledWith("discard");
		});

		it("updates when the stage changes while the dialog is open", () => {
			renderDialog(true, () => {});
			expect(document.body.textContent).not.toContain("The pipeline is still working on it:");

			act(() => {
				setPipelineCardStages([stage()]);
			});
			expect(buttonLabels()).toEqual(["Cancel", "Discard", "Land anyway on main"]);

			act(() => {
				setPipelineCardStages([stage({ kind: "qa_verdict", label: "QA r1 PASS", next: null, inFlight: false })]);
			});
			expect(document.body.textContent).not.toContain("The pipeline is still working on it:");
			expect(buttonLabels()).toEqual(["Cancel", "Discard", "Land on main"]);
		});

		it("shows no warning when nothing is in flight", () => {
			setPipelineCardStages([stage({ kind: "no_qa", label: "No QA", next: null, deadline: null, inFlight: false })]);
			renderDialog(true, () => {});

			expect(document.body.textContent).not.toContain("The pipeline is still working on it:");
			expect(buttonLabels()).toEqual(["Cancel", "Discard", "Land on main"]);
		});

		it("shows no warning for another card's stage", () => {
			setPipelineCardStages([stage({ taskId: "other" })]);
			renderDialog(true, () => {});

			expect(document.body.textContent).not.toContain("The pipeline is still working on it:");
		});

		it("shows no warning where Kanban doesn't land the card (not landing qa)", () => {
			setPipelineCardStages([stage()]);
			renderDialog(false, () => {});

			expect(document.body.textContent).not.toContain("The pipeline is still working on it:");
			expect(buttonLabels()).toEqual(["Cancel", "Discard"]);
		});
	});
});
