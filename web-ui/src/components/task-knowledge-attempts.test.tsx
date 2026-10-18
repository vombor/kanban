import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskKnowledgeAttempts } from "./task-knowledge-attempts";

const query = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/trpc-client", () => ({ getRuntimeTrpcClient: () => ({ taskKnowledge: { attempts: { query } } }) }));
describe("retained task knowledge attempts", () => {
	let container: HTMLDivElement, root: Root;
	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		query.mockReset().mockResolvedValue({
			attempts: [
				{
					id: "a".repeat(64),
					kind: "rework_handoff",
					outcome: "reserved",
					reservedAt: "2026-10-18T10:00:00.000Z",
					contextRevision: "b".repeat(64),
					snapshot: "c".repeat(40),
				},
			],
			total: 11,
			nextOffset: 10,
		});
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});
	const click = async (label: string) =>
		act(async () => {
			const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
			if (!button) throw new Error("Missing attempt control");
			button.click();
		});
	it("fetches only on inspection, labels reserved handoffs honestly and reads exact attempt identities", async () => {
		const onRead = vi.fn();
		act(() => root.render(<TaskKnowledgeAttempts workspaceId="demo" taskId="dev1" onRead={onRead} />));
		expect(query).not.toHaveBeenCalled();
		await click("Inspect retained attempts");
		expect(query).toHaveBeenCalledWith({ taskId: "dev1", offset: 0, limit: 10 });
		expect(container.textContent).toContain("Prepared rework handoff · reserved");
		expect(container.textContent).toContain("not proof of execution");
		await click("Read attempt spec");
		expect(onRead).toHaveBeenCalledWith("a".repeat(64));
		await click("Next attempts");
		expect(query).toHaveBeenLastCalledWith({ taskId: "dev1", offset: 10, limit: 10 });
	});
});
