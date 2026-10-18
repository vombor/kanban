import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeProposalView } from "./knowledge-proposal-view";

const read = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-knowledge-proposal", () => ({ useKnowledgeProposal: (...args: unknown[]) => read(...args) }));
const data = {
	proposal: {
		id: "00000000-0000-4000-8000-000000000001",
		document: { id: "api", title: "Proposal", kind: "contract", summary: "", tags: [], sources: [] },
		status: "pending",
		baseRevision: "a".repeat(64),
		reason: "Shorten the reference",
		submittedAt: "2026-10-18T10:00:00.000Z",
		submittedBy: { kind: "user" },
		reviewedAt: null,
	},
	markdown: "Short replacement",
	nextOffset: null,
	base: {
		markdown: "First slice of a longer base",
		nextOffset: 4096,
		document: { title: "Base", kind: "contract", summary: "", tags: [], sources: [] },
	},
	current: {
		markdown: "First slice of current",
		nextOffset: 4096,
		document: { revision: "a".repeat(64), pinnedByUser: false },
	},
};
describe("bounded proposal comparison", () => {
	let container: HTMLDivElement, root: Root;
	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		read.mockReset().mockReturnValue({ data, isError: false });
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});
	const render = (canPin = true) =>
		act(() =>
			root.render(
				<KnowledgeProposalView
					workspaceId="demo"
					proposalId={data.proposal.id}
					canPublish
					canPin={canPin}
					onChanged={() => {}}
				/>,
			),
		);
	it("allows the remaining base tail to be read even when the replacement has no continuation", () => {
		render();
		const next = [...container.querySelectorAll("button")].find((item) => item.textContent === "Next proposal slice");
		expect(next).toBeTruthy();
		act(() => next?.click());
		expect(read).toHaveBeenLastCalledWith("demo", data.proposal.id, 4096);
	});
	it("does not offer publication for stale comparison or an orchestrator's protected decision", () => {
		read.mockReturnValue({
			data: { ...data, current: { ...data.current, document: { revision: "b".repeat(64), pinnedByUser: false } } },
			isError: false,
		});
		render();
		expect(container.textContent).toContain("Stale proposal");
		expect([...container.querySelectorAll("button")].some((item) => item.textContent === "Publish proposal")).toBe(
			false,
		);
		read.mockReturnValue({
			data: {
				...data,
				current: { ...data.current, document: { revision: data.proposal.baseRevision, pinnedByUser: true } },
			},
			isError: false,
		});
		render(false);
		expect(
			[...container.querySelectorAll("button")].some(
				(item) => item.textContent === "Publish proposal" || item.textContent === "Reject proposal",
			),
		).toBe(false);
	});
});
