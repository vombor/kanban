import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ORCHESTRATOR_WAIT_FLASH_MS,
	type OrchestratorWaitAlerts,
	useOrchestratorWaitAlerts,
} from "@/hooks/use-orchestrator-wait-alerts";
import type { RuntimeOrchestratorWaitDetail, RuntimeProjectSummary } from "@/runtime/types";

interface ShownNotification {
	title: string;
	options: NotificationOptions;
	onclick: (() => void) | null;
	close: () => void;
}

const shown: ShownNotification[] = [];

class FakeNotification {
	static permission: NotificationPermission = "granted";
	onclick: (() => void) | null = null;
	constructor(title: string, options: NotificationOptions) {
		const entry: ShownNotification = { title, options, onclick: null, close: vi.fn() };
		shown.push(entry);
		// The hook sets onclick after construction.
		Object.defineProperty(this, "onclick", {
			set: (handler: (() => void) | null) => {
				entry.onclick = handler;
			},
			get: () => entry.onclick,
		});
	}
	close(): void {}
}

function project(
	id: string,
	orchestratorWait: RuntimeProjectSummary["orchestratorWait"] = null,
): RuntimeProjectSummary {
	return {
		id,
		name: `${id}-app`,
		path: `/projects/${id}-app`,
		taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
		orchestratorWait,
	};
}

let latest: OrchestratorWaitAlerts | null = null;

function Harness(props: {
	projects: RuntimeProjectSummary[];
	notificationsEnabled?: boolean;
	onOpenProjectSidebar?: (projectId: string) => void;
	fetchWaitDetail?: (projectId: string) => Promise<RuntimeOrchestratorWaitDetail | null>;
}): null {
	latest = useOrchestratorWaitAlerts({
		projects: props.projects,
		hasReceivedSnapshot: true,
		notificationsEnabled: props.notificationsEnabled ?? true,
		onOpenProjectSidebar: props.onOpenProjectSidebar ?? (() => {}),
		fetchWaitDetail: props.fetchWaitDetail ?? (async () => null),
	});
	return null;
}

describe("useOrchestratorWaitAlerts", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let tabInForeground = false;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.useFakeTimers();
		shown.length = 0;
		latest = null;
		tabInForeground = false;
		FakeNotification.permission = "granted";
		vi.stubGlobal("Notification", FakeNotification);
		vi.spyOn(document, "hasFocus").mockImplementation(() => tabInForeground);
		vi.spyOn(window, "focus").mockImplementation(() => {});
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	async function render(props: Parameters<typeof Harness>[0]): Promise<void> {
		await act(async () => {
			root.render(<Harness {...props} />);
			await Promise.resolve();
		});
		// The notification waits for the question's text.
		await act(async () => {
			await vi.runAllTicks();
			await Promise.resolve();
			await Promise.resolve();
		});
	}

	it("flashes a new wait once, and notifies only for waits that appear after the first project list", async () => {
		await render({ projects: [project("alpha", { kind: "question", since: 1 })] });
		expect(latest?.waitingCount).toBe(1);
		expect([...(latest?.flashingProjectIds ?? [])]).toEqual(["alpha"]);
		expect(shown).toEqual([]);

		await act(async () => {
			vi.advanceTimersByTime(ORCHESTRATOR_WAIT_FLASH_MS);
		});
		expect(latest?.flashingProjectIds.size).toBe(0);

		const fetchWaitDetail = vi.fn(async () => ({
			kind: "approval" as const,
			since: 5,
			text: "Bash: git push",
			taskId: "__home_agent__:beta:claude",
			agentId: "claude" as const,
		}));
		await render({
			projects: [project("alpha", { kind: "question", since: 1 }), project("beta", { kind: "approval", since: 5 })],
			fetchWaitDetail,
		});
		expect([...(latest?.flashingProjectIds ?? [])]).toEqual(["beta"]);
		expect(fetchWaitDetail).toHaveBeenCalledWith("beta");
		expect(shown.map((entry) => [entry.title, entry.options.body, entry.options.tag])).toEqual([
			["beta-app: the Kanban Agent needs your approval", "Bash: git push", "orchestrator-wait-beta"],
		]);

		// The same pending request in the next project list: no second flash or notification.
		await render({
			projects: [project("alpha", { kind: "question", since: 1 }), project("beta", { kind: "approval", since: 5 })],
			fetchWaitDetail,
		});
		expect(shown).toHaveLength(1);
		expect(latest?.waitingCount).toBe(2);
	});

	it("opens the project's sidebar from the notification", async () => {
		const onOpenProjectSidebar = vi.fn();
		await render({ projects: [project("alpha")], onOpenProjectSidebar });
		await render({ projects: [project("alpha", { kind: "question", since: 9 })], onOpenProjectSidebar });
		expect(shown).toHaveLength(1);
		// Without the question's text (the detail is of another request), the body is empty.
		expect(shown[0]?.options.body).toBe("");
		act(() => {
			shown[0]?.onclick?.();
		});
		expect(onOpenProjectSidebar).toHaveBeenCalledWith("alpha");
	});

	it("doesn't notify while the tab is in front, without the opt-in or without permission; the badge still counts", async () => {
		await render({ projects: [] });
		tabInForeground = true;
		await render({ projects: [project("alpha", { kind: "question", since: 1 })] });
		tabInForeground = false;
		await render({ projects: [project("beta", { kind: "question", since: 2 })], notificationsEnabled: false });
		FakeNotification.permission = "default";
		await render({ projects: [project("gamma", { kind: "question", since: 3 })] });
		expect(shown).toEqual([]);
		expect(latest?.waitingCount).toBe(1);
		expect(latest?.flashingProjectIds.has("gamma")).toBe(true);
	});
});
