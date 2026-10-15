import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectEditDialog } from "@/components/project-edit-dialog";
import type { RuntimeProjectSummary } from "@/runtime/types";

const mocks = vi.hoisted(() => ({
	name: vi.fn(),
	scripts: vi.fn(),
	listScripts: vi.fn(),
	secrets: vi.fn(),
	listSecrets: vi.fn(),
	remove: vi.fn(),
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		projectName: { set: { mutate: mocks.name } },
		shortcuts: { list: { query: mocks.listScripts }, replace: { mutate: mocks.scripts } },
		projectSecrets: {
			list: { query: mocks.listSecrets },
			set: { mutate: mocks.secrets },
			remove: { mutate: mocks.remove },
		},
	}),
}));
const project: RuntimeProjectSummary = {
	id: "alpha",
	name: "Alpha",
	path: "/projects/alpha",
	taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
};
describe("Edit Project", () => {
	let root: Root, container: HTMLDivElement;
	const close = vi.fn();
	beforeEach(() => {
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		for (const mock of Object.values(mocks)) mock.mockReset();
		close.mockReset();
		mocks.listScripts.mockResolvedValue({ shortcuts: [{ label: "Run", command: "npm run dev", icon: "play" }] });
		mocks.listSecrets.mockResolvedValue({
			secrets: [{ name: "DATABASE_URL", configured: true, updatedAt: "2026-10-14T08:00:00Z" }],
		});
		mocks.name.mockResolvedValue({ ok: true });
		mocks.scripts.mockResolvedValue({ ok: true, shortcuts: [] });
		mocks.secrets.mockResolvedValue({ secrets: [] });
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});
	async function render(value: RuntimeProjectSummary | null = project) {
		await act(async () => root.render(<ProjectEditDialog project={value} onClose={close} />));
	}
	function button(text: string) {
		const el = Array.from(document.body.querySelectorAll("button")).find((el) => el.textContent?.trim() === text);
		if (!el) throw new Error(`Missing ${text}`);
		return el;
	}
	async function click(el: HTMLElement) {
		await act(async () => el.click());
	}
	async function type(selector: string, value: string) {
		const input = document.body.querySelector<HTMLInputElement>(selector);
		if (!input) throw new Error(selector);
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}
	it("loads metadata, edits scripts through their route and sets a masked replacement", async () => {
		await render();
		expect(document.body.textContent).toContain("Edit Project");
		expect(document.body.textContent).toContain("Configured");
		await type("#edit-project-name-input", "Renamed");
		await type('[aria-label="Script 1 command"]', "npm start");
		await click(button("Add secret"));
		await type('[aria-label="Secret 1 name"]', "DATABASE_URL");
		await type('[aria-label="Secret 1 value"]', "private-sentinel");
		expect(document.body.querySelector<HTMLInputElement>('[aria-label="Secret 1 value"]')?.type).toBe("password");
		await click(button("Save"));
		expect(mocks.name).toHaveBeenCalledWith({ name: "Renamed" });
		expect(mocks.scripts).toHaveBeenCalledWith({ shortcuts: [{ label: "Run", command: "npm start", icon: "play" }] });
		expect(mocks.secrets).toHaveBeenCalledWith({ secrets: [{ name: "DATABASE_URL", value: "private-sentinel" }] });
		expect(close).toHaveBeenCalledOnce();
		await render(null);
		expect(document.body.textContent).not.toContain("private-sentinel");
	});
	it("preserves a draft during project-list updates, sanitizes save errors and supports retry", async () => {
		await render();
		await click(button("Add secret"));
		await type('[aria-label="Secret 1 name"]', "KEY");
		await type('[aria-label="Secret 1 value"]', "private-sentinel");
		await render({ ...project, name: "Broadcast rename" });
		expect(document.body.querySelector<HTMLInputElement>('[aria-label="Secret 1 value"]')?.value).toBe(
			"private-sentinel",
		);
		mocks.secrets.mockRejectedValueOnce(new Error("private-sentinel"));
		await click(button("Save"));
		expect(close).not.toHaveBeenCalled();
		expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("can retry");
		expect(document.body.textContent).not.toContain("private-sentinel");
		await click(button("Save"));
		expect(close).toHaveBeenCalledOnce();
	});
	it("does not write credentials when a display name is refused or loading fails", async () => {
		await render();
		mocks.name.mockResolvedValueOnce({ ok: false, error: "Invalid name" });
		await click(button("Save"));
		expect(mocks.scripts).not.toHaveBeenCalled();
		expect(mocks.secrets).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Invalid name");
		await render(null);
		mocks.listSecrets.mockRejectedValueOnce(new Error("unavailable"));
		await render();
		expect(button("Save").disabled).toBe(true);
	});
});
