import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { useTaskPlanContext } from "@/hooks/use-task-plan-context";
import { TaskReferenceAdoption } from "./task-reference-adoption";

const api = vi.hoisted(() => ({ read: vi.fn(), adopt: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		knowledge: { read: { query: api.read } },
		taskKnowledge: { adopt: { mutate: api.adopt } },
	}),
}));
const view: NonNullable<ReturnType<typeof useTaskPlanContext>["query"]["data"]> = {
	context: {
		version: 1,
		taskId: "task1",
		planTaskId: "plan1",
		attachedAt: "2026-10-18T00:00:00.000Z",
		revision: "c".repeat(64),
		bundleRevision: "b".repeat(64),
		documents: [],
	},
	drift: [{ id: "api", pinned: "a".repeat(64), current: "d".repeat(64) }],
	canAdopt: true,
	bundle: null,
	history: [],
	startReservation: null,
	authority: "pinned_reference_not_execution_approval",
};
describe("explicit reference adoption", () => {
	let container: HTMLDivElement, root: Root;
	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		api.read.mockReset().mockResolvedValue({
			document: { revision: "d".repeat(64) },
			markdown: "Reviewed replacement",
			nextOffset: null,
		});
		api.adopt.mockReset();
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});
	const button = (label: string) => {
		const result = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
		if (!result) throw new Error(`Missing ${label}`);
		return result;
	};
	const click = (label: string) => act(async () => button(label).click());
	it("requires explicit review/reason/confirm and reuses an exact-retry identity without automatic retry", async () => {
		const onAdopted = vi.fn();
		act(() =>
			root.render(<TaskReferenceAdoption workspaceId="demo" taskId="task1" view={view} onAdopted={onAdopted} />),
		);
		expect(api.read).not.toHaveBeenCalled();
		expect(api.adopt).not.toHaveBeenCalled();
		await click("Review replacement api");
		expect(api.read).toHaveBeenCalledWith({ id: "api", revision: "d".repeat(64), offset: 0, limit: 4096 });
		expect(button("Adopt reviewed reference").disabled).toBe(true);
		await act(async () => {
			const input = container.querySelector("input");
			if (!input) throw new Error("Missing reason");
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "Reviewed contract correction, acceptance unchanged");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		api.adopt.mockRejectedValueOnce(new Error("Unknown delivery outcome"));
		await click("Adopt reviewed reference");
		expect(api.adopt).toHaveBeenCalledTimes(1);
		expect(onAdopted).not.toHaveBeenCalled();
		api.adopt.mockResolvedValueOnce({ duplicate: true, context: { revision: "e".repeat(64) } });
		await click("Adopt reviewed reference");
		expect(api.adopt).toHaveBeenCalledTimes(2);
		expect(api.adopt.mock.calls[0]?.[0]).toEqual(api.adopt.mock.calls[1]?.[0]);
		expect(api.adopt.mock.calls[0]?.[0]).toMatchObject({
			expectedContextRevision: view.context?.revision,
			expectedDocumentRevision: "a".repeat(64),
			targetRevision: "d".repeat(64),
			requestId: expect.any(String),
		});
		expect(onAdopted).toHaveBeenCalledOnce();
	});
});
