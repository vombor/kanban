import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObsidianConnectorSettingsSection } from "@/components/obsidian-connector-settings-section";

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), test: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		obsidianConnector: { get: { query: mocks.get }, save: { mutate: mocks.save }, test: { mutate: mocks.test } },
	}),
}));
const settings = { enabled: false, baseUrl: "http://obsidian.example:27123", caCertificate: "" };
const view = { settings, apiKeyConfigured: true, revision: "revision-1" };

describe("Obsidian connector settings", () => {
	let container: HTMLDivElement, root: Root;
	beforeEach(() => {
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		for (const mock of Object.values(mocks)) mock.mockReset();
		mocks.get.mockResolvedValue(view);
		mocks.save.mockResolvedValue({ ...view, revision: "revision-2" });
		mocks.test.mockResolvedValue({
			ok: true,
			message: "Authenticated",
			version: "5.4.0",
			capabilities: { graph: true, search: true, documentMap: true },
			indexing: "recent_activity",
		});
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});
	async function render(active = true) {
		await act(async () => root.render(<ObsidianConnectorSettingsSection active={active} />));
	}
	function field() {
		const input = container.querySelector<HTMLInputElement>('[aria-label="Obsidian API key"]');
		if (!input) throw new Error("Missing key field");
		return input;
	}
	async function enterKey(value: string) {
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field(), value);
			field().dispatchEvent(new Event("input", { bubbles: true }));
		});
	}
	async function click(label: string) {
		const button = [...container.querySelectorAll("button")].find((el) => el.textContent === label);
		if (!button) throw new Error(label);
		await act(async () => button.click());
	}
	it("loads only while active and never pre-fills a stored key", async () => {
		await render(false);
		expect(mocks.get).not.toHaveBeenCalled();
		await render();
		expect(field().type).toBe("password");
		expect(field().value).toBe("");
		expect(container.textContent).toContain("stored; leave empty to keep");
		expect(container.textContent).toContain("HTTP sends the API key");
	});
	it("tests a private draft without saving, reports graph capabilities and clears it on save/close", async () => {
		await render();
		await enterKey("private-test-sentinel");
		await click("Test connection");
		expect(mocks.test).toHaveBeenCalledWith({
			settings,
			apiKey: "private-test-sentinel",
			expectedRevision: "revision-1",
		});
		expect(mocks.save).not.toHaveBeenCalled();
		expect(container.textContent).toContain("Native graph: available");
		expect(container.textContent).toContain("graph may be incomplete");
		await click("Save connector");
		expect(field().value).toBe("");
		expect(container.textContent).toContain("settings saved");
		await enterKey("another-private-draft");
		await render(false);
		expect(field().value).toBe("");
	});
	it("omits an empty key so ordinary edits preserve the saved credential and supports removal", async () => {
		await render();
		await click("Save connector");
		expect(mocks.save).toHaveBeenLastCalledWith({ settings, expectedRevision: "revision-1" });
		const remove = [...container.querySelectorAll("label")]
			.find((el) => el.textContent?.includes("Remove stored API key"))
			?.querySelector("input");
		if (!remove) throw new Error("Missing removal field");
		await act(async () => remove.click());
		await click("Save connector");
		expect(mocks.save).toHaveBeenLastCalledWith({ settings, expectedRevision: "revision-2", apiKey: null });
	});
	it("does not show exception contents and ignores stale requests after the section closes", async () => {
		await render();
		mocks.test.mockRejectedValueOnce(new Error("private-test-sentinel"));
		await click("Test connection");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not finish");
		expect(container.textContent).not.toContain("private-test-sentinel");
		let complete: (value: typeof view) => void = () => {};
		mocks.get.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		);
		await render(false);
		await render();
		await render(false);
		await act(async () => complete(view));
		expect(container.textContent).not.toContain("stored; leave empty to keep");
	});
});
