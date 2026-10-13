import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApproveAndLandWarningDialog } from "@/components/approve-and-land-warning-dialog";
import { useApproveAndLandConfirmation } from "@/hooks/use-approve-and-land-confirmation";
import type { RuntimePipelineCardStage } from "@/runtime/types";
import { setPipelineCardStages } from "@/stores/pipeline-card-stage-store";
import type { BoardCard } from "@/types";

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const CARD: BoardCard = {
	id: "8c28e",
	title: "Fix the cart",
	prompt: "Fix the cart",
	startInPlanMode: false,
	autoReviewEnabled: false,
	autoReviewMode: "commit",
	baseRef: "main",
	createdAt: 0,
	updatedAt: 0,
};

function stage(overrides: Partial<RuntimePipelineCardStage> = {}): RuntimePipelineCardStage {
	return {
		taskId: CARD.id,
		kind: "checks_running",
		label: "Checks running (test)",
		next: "QA next",
		qaTaskId: null,
		deadline: null,
		detail: null,
		detailTimes: [],
		inFlight: true,
		...overrides,
	};
}

/** Approve & land as App wires it: the hook, and its dialog. */
function Harness({ approveAndLandTask }: { approveAndLandTask: (taskId: string) => Promise<void> }): ReactElement {
	const { pendingApproveAndLand, requestApproveAndLand, resolveApproveAndLand } =
		useApproveAndLandConfirmation(approveAndLandTask);
	return (
		<>
			<button type="button" onClick={() => requestApproveAndLand(CARD)}>
				Approve & land
			</button>
			<ApproveAndLandWarningDialog
				open={pendingApproveAndLand !== null}
				taskTitle={pendingApproveAndLand?.taskTitle ?? ""}
				stage={pendingApproveAndLand?.stage ?? null}
				onResolve={resolveApproveAndLand}
			/>
		</>
	);
}

describe("Approve & land while the pipeline works on the card (issue #30)", () => {
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

	function render(approveAndLandTask: (taskId: string) => Promise<void>): void {
		act(() => {
			root.render(<Harness approveAndLandTask={approveAndLandTask} />);
		});
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

	it("lands at once when nothing is in flight", () => {
		const approveAndLandTask = vi.fn(async () => {});
		setPipelineCardStages([stage({ kind: "no_qa", label: "No QA", next: "Approve & land", inFlight: false })]);
		render(approveAndLandTask);
		clickButton("Approve & land");
		expect(approveAndLandTask).toHaveBeenCalledWith(CARD.id);
		expect(document.body.textContent).not.toContain("Land before the pipeline is done?");
	});

	it("asks first while checks run, with the stage, and lands only on Land anyway", () => {
		const approveAndLandTask = vi.fn(async () => {});
		setPipelineCardStages([stage()]);
		render(approveAndLandTask);

		clickButton("Approve & land");
		expect(approveAndLandTask).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Land before the pipeline is done?");
		expect(document.body.textContent).toContain("Fix the cart");
		expect(document.body.textContent).toContain("Checks running (test) · QA next");

		clickButton("Wait for the pipeline");
		expect(approveAndLandTask).not.toHaveBeenCalled();
		expect(document.body.textContent).not.toContain("Land before the pipeline is done?");

		clickButton("Approve & land");
		clickButton("Land anyway");
		expect(approveAndLandTask).toHaveBeenCalledTimes(1);
		expect(approveAndLandTask).toHaveBeenCalledWith(CARD.id);
	});

	it("names a running QA card in the warning", () => {
		const approveAndLandTask = vi.fn(async () => {});
		setPipelineCardStages([stage({ kind: "qa_running", label: "QA r2 running", next: null, qaTaskId: "12ab6" })]);
		render(approveAndLandTask);
		clickButton("Approve & land");
		expect(document.body.textContent).toContain("QA r2 running (12ab6)");
	});
});
