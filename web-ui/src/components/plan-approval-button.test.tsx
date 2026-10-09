import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { showAppToast } from "@/components/app-toaster";
import { PlanApprovalButton } from "@/components/plan-approval-button";
import { setCurrentWorkspaceId } from "@/stores/current-workspace-store";

const trpc = vi.hoisted(() => ({
	workspaceIds: [] as Array<string | null>,
	preview: vi.fn(),
	approve: vi.fn(),
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: (workspaceId: string | null) => {
		trpc.workspaceIds.push(workspaceId);
		return {
			plans: { preview: { query: trpc.preview }, approve: { mutate: trpc.approve } },
		};
	},
}));

vi.mock("@/components/app-toaster", () => ({ showAppToast: vi.fn() }));

const PLAN = {
	taskId: "p1",
	title: "Coupons",
	slug: "coupons",
	specPath: "docs/specs/coupons.md",
	specTitle: "Coupons at checkout",
	cards: 3,
	breakdownSha256: "abc123",
	approval: null,
};
const APPROVAL = { at: "2026-10-07T12:00:00.000Z", via: "approve", breakdownSha256: "abc123" };

describe("PlanApprovalButton", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		trpc.workspaceIds = [];
		for (const mock of [trpc.preview, trpc.approve]) {
			mock.mockReset();
		}
		vi.mocked(showAppToast).mockReset();
		trpc.preview.mockResolvedValue({ ok: true, plan: PLAN });
		setCurrentWorkspaceId("ws-1");
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		setCurrentWorkspaceId(null);
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});

	function button(text: string): HTMLButtonElement {
		const found = Array.from(document.body.querySelectorAll("button")).find(
			(item) => item.textContent?.trim() === text,
		);
		if (!found) {
			throw new Error(`No button ${text}`);
		}
		return found;
	}

	function dialogButton(text: string): HTMLButtonElement {
		const dialog = document.body.querySelector('[role="alertdialog"]');
		const found = Array.from(dialog?.querySelectorAll("button") ?? []).find(
			(item) => item.textContent?.trim() === text,
		);
		if (!found) {
			throw new Error(`No dialog button ${text}`);
		}
		return found;
	}

	async function click(element: HTMLElement): Promise<void> {
		await act(async () => {
			element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
	}

	async function openDialog(): Promise<void> {
		act(() => {
			root.render(<PlanApprovalButton taskId="p1" taskTitle="Coupons" />);
		});
		await click(button("Approve plan"));
	}

	it("shows the spec title, card count and breakdown, then approves at once on confirm", async () => {
		trpc.approve.mockResolvedValue({ ok: true, approval: APPROVAL, plan: PLAN });
		await openDialog();
		const dialog = document.body.querySelector('[role="alertdialog"]');
		expect(dialog?.textContent).toContain("Coupons at checkout: 3 cards");
		expect(dialog?.textContent).toContain("breakdown abc123");
		expect(trpc.preview).toHaveBeenCalledWith({ taskId: "p1" });
		expect(trpc.workspaceIds).toContain("ws-1");
		// Opening the dialog approves nothing: the user confirms.
		expect(trpc.approve).not.toHaveBeenCalled();

		await click(dialogButton("Approve plan"));
		expect(trpc.approve).toHaveBeenCalledWith({ taskId: "p1", via: "approve", breakdownSha256: "abc123" });
		expect(document.body.querySelector('[aria-label="Approval code"]')).toBeNull();
		expect(showAppToast).toHaveBeenCalledWith(expect.objectContaining({ intent: "success" }), "plan-p1");
		expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
	});

	it("a refusal is shown in the dialog, and Cancel approves nothing", async () => {
		trpc.approve.mockResolvedValueOnce({
			ok: false,
			approval: null,
			plan: null,
			error: "The breakdown of plan p1 changed since it was shown; review it again.",
		});
		await openDialog();
		await click(dialogButton("Approve plan"));
		expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain("changed since it was shown");
		expect(showAppToast).not.toHaveBeenCalled();

		await click(dialogButton("Cancel"));
		expect(trpc.approve).toHaveBeenCalledTimes(1);
		expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
	});

	it("an already approved breakdown can't be approved twice", async () => {
		trpc.preview.mockResolvedValue({ ok: true, plan: { ...PLAN, approval: { ...APPROVAL, state: "approved" } } });
		await openDialog();
		expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain("Already approved");
		expect(dialogButton("Approve plan").disabled).toBe(true);
	});
});
