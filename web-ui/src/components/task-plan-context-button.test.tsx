import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskPlanContextButton } from "./task-plan-context-button";

const api = vi.hoisted(() => ({ get: vi.fn(), read: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ taskKnowledge: { get: { query: api.get }, read: { query: api.read } } }),
}));
const context = {
	taskId: "task1",
	revision: "c".repeat(64),
	bundleRevision: "b".repeat(64),
	documents: [{ id: "api", title: "Reviewed API", revision: "a".repeat(64), pinnedByUser: true }],
};
describe("on-demand task plan context", () => {
	let container: HTMLDivElement, root: Root;
	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		api.get.mockReset().mockResolvedValue({
			context,
			bundle: null,
			drift: [{ id: "api", pinned: "a".repeat(64), current: "d".repeat(64) }],
			history: [],
			startReservation: null,
			canAdopt: false,
		});
		api.read.mockReset().mockResolvedValue({
			markdown: "<script>not HTML</script>\nReviewed spec",
			nextOffset: 4096,
			contextRevision: context.revision,
		});
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});
	const button = (text: string) => {
		const result = [...document.querySelectorAll("button")].find((item) => item.textContent === text);
		if (!result) throw new Error(`Missing ${text}`);
		return result;
	};
	const click = async (text: string) => act(async () => button(text).click());
	it("fetches only pointers on opening, labels drift, and reads only requested exact bounded slices", async () => {
		act(() => root.render(<TaskPlanContextButton taskId="task1" workspaceId="demo" />));
		expect(api.get).not.toHaveBeenCalled();
		expect(api.read).not.toHaveBeenCalled();
		await click("Plan context");
		expect(api.get).toHaveBeenCalledWith({ taskId: "task1" });
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Revision drift: api");
		expect(api.read).not.toHaveBeenCalled();
		await click("Read retained spec");
		expect(api.read).toHaveBeenLastCalledWith({
			taskId: "task1",
			part: "spec",
			contextRevision: context.revision,
			offset: 0,
			limit: 4096,
		});
		expect(document.querySelector("pre")?.textContent).toContain("<script>not HTML</script>");
		expect(document.querySelector("script")).toBeNull();
		await click("Read next slice");
		expect(api.read).toHaveBeenLastCalledWith(
			expect.objectContaining({ offset: 4096, contextRevision: context.revision }),
		);
	});
	it("shows missing/corrupt context honestly, without fallback reads", async () => {
		api.get.mockRejectedValue(new Error("Retained bundle is damaged; restore it"));
		act(() => root.render(<TaskPlanContextButton taskId="task1" workspaceId="demo" />));
		await click("Plan context");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("Retained bundle is damaged");
		expect(api.read).not.toHaveBeenCalled();
	});
});
