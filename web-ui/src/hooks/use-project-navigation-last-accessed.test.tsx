import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type UseProjectNavigationResult, useProjectNavigation } from "@/hooks/use-project-navigation";
import { LocalStorageKey } from "@/storage/local-storage-store";

const streamState = vi.hoisted(() => ({
	requestedProjectIds: [] as Array<string | null>,
	currentProjectId: null as string | null,
}));

vi.mock("@/runtime/use-runtime-state-stream", () => ({
	useRuntimeStateStream: (requestedProjectId: string | null) => {
		streamState.requestedProjectIds.push(requestedProjectId);
		return {
			currentProjectId: streamState.currentProjectId,
			projects: [
				{
					id: "alpha",
					name: "alpha",
					path: "/projects/alpha",
					taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
				},
				{
					id: "beta",
					name: "beta",
					path: "/projects/beta",
					taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
				},
			],
			workspaceState: null,
			workspaceMetadata: null,
			latestTaskReadyForReview: null,
			streamError: null,
			isRuntimeDisconnected: false,
			hasReceivedSnapshot: true,
		};
	},
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({}),
}));

let latest: UseProjectNavigationResult | null = null;

function HookProbe(): null {
	latest = useProjectNavigation({ onProjectSwitchStart: () => {} });
	return null;
}

describe("useProjectNavigation: most recently accessed project", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.clear();
		streamState.requestedProjectIds = [];
		streamState.currentProjectId = null;
		latest = null;
		window.history.replaceState({}, "", "/");
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		localStorage.clear();
		window.history.replaceState({}, "", "/");
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	function renderHook(): void {
		act(() => {
			root.render(<HookProbe />);
		});
	}

	it("opens the most recently accessed project when the URL names none", () => {
		localStorage.setItem(LocalStorageKey.LastAccessedProject, "beta");
		renderHook();
		expect(streamState.requestedProjectIds[0]).toBe("beta");
		expect(latest?.navigationCurrentProjectId).toBe("beta");
	});

	it("lets a project URL win over the most recently accessed project", () => {
		localStorage.setItem(LocalStorageKey.LastAccessedProject, "beta");
		window.history.replaceState({}, "", "/alpha");
		renderHook();
		expect(streamState.requestedProjectIds[0]).toBe("alpha");
	});

	it("leaves the choice to the server when nothing was accessed yet", () => {
		renderHook();
		expect(streamState.requestedProjectIds[0]).toBeNull();
	});

	it("remembers the project the board shows", () => {
		streamState.currentProjectId = "alpha";
		renderHook();
		expect(localStorage.getItem(LocalStorageKey.LastAccessedProject)).toBe("alpha");

		act(() => {
			latest?.handleSelectProject("beta");
		});
		expect(streamState.requestedProjectIds.at(-1)).toBe("beta");
		streamState.currentProjectId = "beta";
		renderHook();
		expect(localStorage.getItem(LocalStorageKey.LastAccessedProject)).toBe("beta");
	});
});
