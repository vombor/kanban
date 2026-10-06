import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardColumn, DONE_COLUMN_PAGE_SIZE } from "@/components/board-column";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BoardCard, BoardColumn as BoardColumnModel } from "@/types";

const snapshotSubscriptions: Array<string | null | undefined> = [];

vi.mock("@hello-pangea/dnd", () => ({
	Droppable: ({
		children,
	}: {
		children: (provided: { innerRef: () => void; droppableProps: object; placeholder: ReactNode }) => ReactNode;
	}): React.ReactElement => <>{children({ innerRef: () => {}, droppableProps: {}, placeholder: null })}</>,
	Draggable: ({
		children,
	}: {
		children: (
			provided: { innerRef: () => void; draggableProps: object; dragHandleProps: object },
			snapshot: { isDragging: boolean },
		) => ReactNode;
	}): React.ReactElement => (
		<>{children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false })}</>
	),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: (taskId: string | null | undefined) => {
		snapshotSubscriptions.push(taskId);
		return null;
	},
}));

function createCards(count: number): BoardCard[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `t${index}`,
		title: `Task ${index}`,
		prompt: `Task ${index}: ${"a long description ".repeat(40)}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: index,
		updatedAt: index,
	}));
}

describe("BoardColumn Done column", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		snapshotSubscriptions.length = 0;
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function render(column: BoardColumnModel) {
		act(() => {
			root.render(
				<TooltipProvider>
					<BoardColumn column={column} taskSessions={{}} />
				</TooltipProvider>,
			);
		});
	}

	it("renders the newest page of Done cards and reveals the rest on demand", () => {
		const hidden = 10;
		render({ id: "trash", title: "Done", cards: createCards(DONE_COLUMN_PAGE_SIZE + hidden) });
		expect(container.querySelectorAll("[data-task-id]")).toHaveLength(DONE_COLUMN_PAGE_SIZE);
		const button = Array.from(container.querySelectorAll("button")).find((element) =>
			element.textContent?.startsWith(`Show ${hidden} more`),
		);
		expect(button?.textContent).toBe(`Show ${hidden} more (${hidden} hidden)`);
		act(() => button?.click());
		expect(container.querySelectorAll("[data-task-id]")).toHaveLength(DONE_COLUMN_PAGE_SIZE + hidden);
		expect(
			Array.from(container.querySelectorAll("button")).some((element) => element.textContent?.startsWith("Show ")),
		).toBe(false);
	});

	it("does not page other columns", () => {
		render({ id: "review", title: "Review", cards: createCards(DONE_COLUMN_PAGE_SIZE + 5) });
		expect(container.querySelectorAll("[data-task-id]")).toHaveLength(DONE_COLUMN_PAGE_SIZE + 5);
	});

	it("does not subscribe Done cards to workspace metadata", () => {
		render({ id: "trash", title: "Done", cards: createCards(3) });
		expect(snapshotSubscriptions.length).toBeGreaterThan(0);
		expect(snapshotSubscriptions.every((taskId) => taskId === null)).toBe(true);
	});
});
