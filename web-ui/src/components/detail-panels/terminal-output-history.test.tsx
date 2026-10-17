import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalOutputHistory } from "@/components/detail-panels/terminal-output-history";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ workspace: { getTerminalHistory: { query: mocks.query } } }),
}));

function button(text: string): HTMLButtonElement {
	const value = [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === text);
	if (!value) throw new Error(`Missing button ${text}`);
	return value;
}

describe("bounded output history", () => {
	let root: Root;
	let container: HTMLDivElement;
	beforeEach(() => {
		mocks.query.mockReset();
		mocks.query.mockImplementation(async ({ end }: { end: number | null }) => ({
			available: true,
			text: end === null ? "\u001b[31mNEWEST\u001b[0m" : "OLDER",
			start: end === null ? 100 : 0,
			end: end ?? 200,
			totalBytes: 200,
			recordingError: false,
		}));
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});
	it("does not fetch on card opening; explicit navigation replaces rather than accumulates pages", async () => {
		await act(async () => root.render(<TerminalOutputHistory workspaceId="own-project" taskId="task" />));
		expect(mocks.query).not.toHaveBeenCalled();
		await act(async () => button("Output history").click());
		expect(document.querySelector("pre")?.textContent).toBe("NEWEST");
		expect(mocks.query).toHaveBeenLastCalledWith({ taskId: "task", end: null });
		await act(async () => button("Older output").click());
		expect(document.querySelector("pre")?.textContent).toBe("OLDER");
		expect(document.querySelector("pre")?.textContent).not.toContain("NEWEST");
		expect(mocks.query).toHaveBeenLastCalledWith({ taskId: "task", end: 100 });
		await act(async () => button("Newest").click());
		expect(document.querySelector("pre")?.textContent).toBe("NEWEST");
		const calls = mocks.query.mock.calls.length;
		await act(async () => button("Newest").click());
		expect(mocks.query.mock.calls.length).toBe(calls + 1);
	});
});
