import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DebugDialog } from "@/components/debug-dialog";
import { setKanbanPaths } from "@/stores/kanban-paths-store";

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("DebugDialog", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		setKanbanPaths(null);
		(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	function renderDialog(debugResetTargetPaths: string[] | null): void {
		setKanbanPaths(
			debugResetTargetPaths
				? {
						homePath: "/home/dev/.kanban",
						homeSource: "default",
						worktreesRootPath: "/home/dev/.kanban/worktrees",
						legacyWorktreeRootPaths: [],
						debugResetTargetPaths,
						projectConfigDisplayPath: "<project>/.cline/kanban/config.json",
					}
				: null,
		);
		act(() => {
			root.render(
				<DebugDialog
					open
					onOpenChange={() => {}}
					isResetAllStatePending={false}
					onShowStartupOnboardingDialog={() => {}}
					onResetAllState={() => {}}
				/>,
			);
		});
	}

	it("lists the reset targets reported by the runtime", () => {
		renderDialog(["/home/dev/.cline/data", "/home/dev/.kanban", "/home/dev/.kanban/worktrees"]);
		expect(document.body.textContent).toContain(
			"removes ~/.cline/data, ~/.kanban, and ~/.kanban/worktrees. Kanban reloads",
		);
	});

	it("falls back to a generic description before the runtime config loads", () => {
		renderDialog(null);
		expect(document.body.textContent).toContain("removes Kanban's state directories.");
	});
});
