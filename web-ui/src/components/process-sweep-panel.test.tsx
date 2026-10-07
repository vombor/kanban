import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProcessSweepPanel } from "@/components/process-sweep-panel";
import type { RuntimeProcessSweepResponse } from "@/runtime/types";

const queryMocks = vi.hoisted(() => ({
	fetchProcessSweep: vi.fn<() => Promise<RuntimeProcessSweepResponse>>(),
	runProcessSweepNow: vi.fn<() => Promise<RuntimeProcessSweepResponse>>(),
}));

vi.mock("@/runtime/runtime-config-query", () => queryMocks);

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const MB = 1024 * 1024;

const sweptStatus: RuntimeProcessSweepResponse = {
	supported: true,
	settings: { enabled: true, intervalSec: 300, mode: "terminate" },
	lastSweep: {
		startedAt: 0,
		finishedAt: 1_000,
		mode: "terminate",
		processCount: 3,
		rssBytes: 300 * MB,
		cards: [
			{ taskId: "abc12", workspaceId: "foo", status: "active", processCount: 2, rssBytes: 200 * MB },
			{ taskId: "don01", workspaceId: "foo", status: "done", processCount: 1, rssBytes: 100 * MB },
		],
		orphans: [
			{
				pid: 4242,
				taskId: "don01",
				command: "npm run dev:servers",
				cwd: "/worktrees/don01/foo",
				rssBytes: 100 * MB,
				reason: "card_done",
				action: "terminated",
				eligible: true,
			},
		],
		zombies: [{ pid: 77, ppid: 4000, command: "[git]", parentCommand: "kanban" }],
		error: null,
	},
};

describe("ProcessSweepPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		queryMocks.fetchProcessSweep.mockReset();
		queryMocks.runProcessSweepNow.mockReset();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	async function renderPanel(): Promise<void> {
		await act(async () => {
			root.render(<ProcessSweepPanel open />);
		});
	}

	it("shows per-card totals, orphans and zombies from the last sweep", async () => {
		queryMocks.fetchProcessSweep.mockResolvedValue(sweptStatus);

		await renderPanel();

		const text = container.textContent ?? "";
		expect(text).toContain("Every 5 min, orphans of finished cards are terminated.");
		expect(text).toContain("3 processes, 300 MB in 2 task worktrees.");
		expect(text).toContain("abc12active2 proc · 200 MB");
		expect(text).toContain("terminated4242 don01npm run dev:servers");
		expect(text).toContain("77 ← 4000[git] (parent: kanban)");
	});

	it("runs a sweep on demand and shows its result", async () => {
		queryMocks.fetchProcessSweep.mockResolvedValue({ ...sweptStatus, lastSweep: null });
		queryMocks.runProcessSweepNow.mockResolvedValue(sweptStatus);
		await renderPanel();
		expect(container.textContent).toContain("No sweep has run yet.");

		const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
			candidate.textContent?.includes("Sweep now"),
		);
		await act(async () => {
			button?.click();
		});

		expect(queryMocks.runProcessSweepNow).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("3 processes, 300 MB in 2 task worktrees.");
	});

	it("says that cleanup is off on platforms without /proc", async () => {
		queryMocks.fetchProcessSweep.mockResolvedValue({ ...sweptStatus, supported: false, lastSweep: null });

		await renderPanel();

		expect(container.textContent).toContain("Process cleanup reads /proc and is off on this platform.");
		expect(container.querySelector("button")).toBeNull();
	});
});
