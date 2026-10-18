import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDocument } from "../../../../src/trpc/knowledge-contract";
import { ProjectKnowledgeDialog } from "./project-knowledge-dialog";

const api = vi.hoisted(() => ({
	list: vi.fn(),
	permissions: vi.fn(),
	read: vi.fn(),
	search: vi.fn(),
	history: vi.fn(),
	proposals: vi.fn(),
	proposalRead: vi.fn(),
	mutate: vi.fn(),
	scopes: [] as string[],
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: (workspaceId: string) => {
		api.scopes.push(workspaceId);
		return {
			knowledge: {
				list: { query: api.list },
				permissions: { query: api.permissions },
				read: { query: api.read },
				search: { query: api.search },
				history: { query: api.history },
				proposals: { query: api.proposals },
				proposalRead: { query: api.proposalRead },
				mutate: { mutate: api.mutate },
			},
		};
	},
}));
const document: KnowledgeDocument = {
	id: "api",
	kind: "contract",
	title: "Owned API reference",
	summary: "Shape",
	tags: ["api"],
	sources: [],
	revision: "a".repeat(64),
	contentHash: "b".repeat(64),
	contentBytes: 5000,
	sectionCount: 1,
	pinnedByUser: false,
	publishedAt: "2026-10-18T10:00:00.000Z",
	publishedBy: { kind: "user" },
};
describe("project Knowledge view", () => {
	let container: HTMLDivElement, root: Root;
	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = globalThis.document.createElement("div");
		globalThis.document.body.appendChild(container);
		root = createRoot(container);
		api.scopes = [];
		for (const method of [
			api.list,
			api.permissions,
			api.read,
			api.search,
			api.history,
			api.proposals,
			api.proposalRead,
			api.mutate,
		])
			method.mockReset();
		api.list.mockResolvedValue({ documents: [document], total: 21, nextOffset: 20 });
		api.permissions.mockResolvedValue({ canPropose: true, canPublish: true, canPin: true });
		api.read.mockResolvedValue({
			document,
			markdown: "# Owned exact reference\n",
			sections: [{ id: "shape", title: "Shape", start: 0, end: 25, depth: 1 }],
			offset: 0,
			nextOffset: 4096,
			truncated: true,
		});
		api.history.mockResolvedValue({ revisions: [document], total: 1, nextOffset: null });
		api.proposals.mockResolvedValue({ proposals: [], total: 0, nextOffset: null });
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});
	const render = (workspaceId = "demo") =>
		act(async () =>
			root.render(<ProjectKnowledgeDialog workspaceId={workspaceId} projectName={workspaceId} onClose={() => {}} />),
		);
	const button = (text: string) => {
		const element = [...documentGlobal().querySelectorAll("button")].find(
			(item) => item.textContent?.trim() === text,
		);
		if (!element) throw new Error(`Missing ${text}`);
		return element;
	};
	const click = (text: string) => act(async () => button(text).click());
	it("loads only metadata before selection, reads exact bounded slices and requires explicit pin confirmation", async () => {
		await render();
		expect(api.read).not.toHaveBeenCalled();
		expect(api.mutate).not.toHaveBeenCalled();
		await click("Owned API referencecontract · api");
		expect(api.read).toHaveBeenCalledWith({
			id: "api",
			revision: document.revision,
			section: undefined,
			offset: 0,
			limit: 4096,
		});
		await click("Next document slice");
		expect(api.read).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 4096, revision: document.revision }));
		await click("Pin decision");
		expect(api.mutate).not.toHaveBeenCalled();
		api.mutate.mockRejectedValueOnce(new Error("uncertain receipt"));
		await click("Confirm pin decision");
		expect(api.mutate).toHaveBeenCalledTimes(1);
		expect(documentGlobal().querySelector('[role="alert"]')?.textContent).toContain("could not be confirmed");
		api.mutate.mockResolvedValueOnce({ kind: "document", document: { ...document, pinnedByUser: true } });
		await click("Retry exact curation change");
		expect(api.mutate.mock.calls[0]?.[0]).toEqual(api.mutate.mock.calls[1]?.[0]);
		expect(api.mutate.mock.calls[0]?.[0]).toMatchObject({
			action: "pin",
			id: "api",
			expectedRevision: document.revision,
		});
	});
	it("does not show curation controls when strict permission readout denies them", async () => {
		api.permissions.mockResolvedValue({ canPropose: true, canPublish: false, canPin: false });
		await render();
		await click("Owned API referencecontract · api");
		expect([...documentGlobal().querySelectorAll("button")].some((item) => item.textContent === "Pin decision")).toBe(
			false,
		);
	});
	it("fences late private responses and selections across project changes", async () => {
		let release!: (value: unknown) => void;
		api.list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		await render("first");
		api.list.mockResolvedValue({ documents: [], total: 0, nextOffset: null });
		await render("second");
		await act(async () =>
			release({ documents: [{ ...document, title: "FIRST PRIVATE TITLE" }], total: 1, nextOffset: null }),
		);
		expect(documentGlobal().body.textContent).not.toContain("FIRST PRIVATE TITLE");
		expect(api.read).not.toHaveBeenCalled();
		expect(api.mutate).not.toHaveBeenCalled();
	});
	it("does not redirect or refresh another project when an old curation response arrives", async () => {
		let release!: (value: unknown) => void;
		api.mutate.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		await render("first");
		await click("Owned API referencecontract · api");
		await click("Pin decision");
		await click("Confirm pin decision");
		api.list.mockResolvedValue({ documents: [], total: 0, nextOffset: null });
		await render("second");
		const count = api.list.mock.calls.length;
		await act(async () => release({ kind: "document", document: { ...document, pinnedByUser: true } }));
		expect(api.mutate).toHaveBeenCalledTimes(1);
		expect(api.list).toHaveBeenCalledTimes(count);
		expect(documentGlobal().body.textContent).not.toContain("Curation confirmed");
		expect(documentGlobal().body.textContent).not.toContain("Owned API reference");
	});
});
// Avoid shadowing the browser Document with the fixture metadata above.
function documentGlobal() {
	return globalThis.document;
}
