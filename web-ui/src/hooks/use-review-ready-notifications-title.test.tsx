import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInitialBoardData } from "@/data/board-data";
import { APP_TITLE, useReviewReadyNotifications } from "@/hooks/use-review-ready-notifications";

function TitleHarness({ workspaceId, workspacePath }: { workspaceId: string; workspacePath: string }): null {
	useReviewReadyNotifications({
		activeWorkspaceId: workspaceId,
		board: createInitialBoardData(),
		isDocumentVisible: true,
		latestTaskReadyForReview: null,
		taskSessions: {},
		readyForReviewNotificationsEnabled: false,
		workspacePath,
	});
	return null;
}

describe("useReviewReadyNotifications document title", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		document.title = "something else";
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	it("titles the tab Kanban, not the project, and keeps it on a project switch", () => {
		expect(APP_TITLE).toBe("Kanban");
		act(() => {
			root.render(<TitleHarness workspaceId="alpha" workspacePath="/projects/alpha-api" />);
		});
		expect(document.title).toBe("Kanban");

		act(() => {
			root.render(<TitleHarness workspaceId="beta" workspacePath="/projects/beta-web" />);
		});
		expect(document.title).toBe("Kanban");
	});
});
