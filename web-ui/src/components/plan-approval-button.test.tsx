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
	isolationApprove: vi.fn(),
	approvalStatus: vi.fn(),
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: (workspaceId: string | null) => {
		trpc.workspaceIds.push(workspaceId);
		return {
			plans: { preview: { query: trpc.preview }, approve: { mutate: trpc.approve } },
			isolation: { approve: { mutate: trpc.isolationApprove }, approvalStatus: { query: trpc.approvalStatus } },
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
		for (const mock of [trpc.preview, trpc.approve, trpc.isolationApprove, trpc.approvalStatus]) {
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

	async function type(input: HTMLInputElement, value: string): Promise<void> {
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	async function openDialog(): Promise<void> {
		act(() => {
			root.render(<PlanApprovalButton taskId="p1" taskTitle="Coupons" />);
		});
		await click(button("Approve plan"));
	}

	it("shows the spec title and card count, then approves with the console code", async () => {
		trpc.approve.mockResolvedValue({ ok: true, approval: null, approvalId: "a-1", plan: PLAN });
		trpc.isolationApprove.mockResolvedValueOnce({ ok: false, result: null, error: "Wrong code for approval a-1." });
		trpc.approvalStatus.mockResolvedValue({ approval: { status: "pending" } });
		await openDialog();
		const dialog = document.body.querySelector('[role="alertdialog"]');
		expect(dialog?.textContent).toContain("Coupons at checkout: 3 cards");
		expect(trpc.preview).toHaveBeenCalledWith({ taskId: "p1" });
		expect(trpc.workspaceIds).toContain("ws-1");

		await click(dialogButton("Approve plan"));
		expect(trpc.approve).toHaveBeenCalledWith({ taskId: "p1", via: "approve", breakdownSha256: "abc123" });
		const input = document.body.querySelector<HTMLInputElement>('[aria-label="Approval code"]');
		expect(input).not.toBeNull();
		expect(dialog?.textContent).toContain("a-1");

		await type(input as HTMLInputElement, "WRONG");
		await click(dialogButton("Approve"));
		expect(dialog?.textContent).toContain("Wrong code for approval a-1.");

		trpc.isolationApprove.mockResolvedValueOnce({ ok: true, result: "plan p1 approved (3 cards)" });
		await type(input as HTMLInputElement, " K7QX2M9P ");
		await click(dialogButton("Approve"));
		expect(trpc.isolationApprove).toHaveBeenLastCalledWith({ id: "a-1", code: "K7QX2M9P" });
		expect(showAppToast).toHaveBeenCalledWith(expect.objectContaining({ intent: "success" }), "plan-p1");
		expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
	});

	it("a passcode browser is approved at once; a refusal is shown in the dialog", async () => {
		trpc.approve.mockResolvedValueOnce({
			ok: false,
			approval: null,
			approvalId: null,
			plan: null,
			error: "The breakdown of plan p1 changed since it was shown; review it again.",
		});
		await openDialog();
		await click(dialogButton("Approve plan"));
		expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain("changed since it was shown");
		expect(document.body.querySelector('[aria-label="Approval code"]')).toBeNull();

		trpc.approve.mockResolvedValueOnce({ ok: true, approval: APPROVAL, approvalId: null, plan: PLAN });
		await click(dialogButton("Approve plan"));
		expect(showAppToast).toHaveBeenCalledWith(expect.objectContaining({ intent: "success" }), "plan-p1");
		expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
	});

	it("an already approved breakdown can't be approved twice", async () => {
		trpc.preview.mockResolvedValue({ ok: true, plan: { ...PLAN, approval: { ...APPROVAL, state: "approved" } } });
		await openDialog();
		expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain("Already approved");
		expect(dialogButton("Approve plan").disabled).toBe(true);
	});
});
