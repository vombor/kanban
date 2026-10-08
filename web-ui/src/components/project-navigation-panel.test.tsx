import { act, type ComponentProps, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AddProjectDialog } from "@/components/add-project-dialog";
import { ProjectNavigationPanel } from "@/components/project-navigation-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProjectNavigationLayout } from "@/resize/use-project-navigation-layout";
import type { RuntimeProjectSummary } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";

vi.mock("@/resize/layout-customizations", () => ({
	useLayoutResetEffect: () => {},
}));

// Only the add-project dialog talks to the runtime here.
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		projects: {
			roots: { query: async () => ({ roots: ["/projects"] }) },
			listDirectoryContents: {
				query: async () => ({ ok: true, currentPath: "/projects", parentPath: null, rootPath: "/", entries: [] }),
			},
		},
	}),
}));

/** Wrapper that owns the sidebar layout state via the hook and passes it as props. */
function PanelWithLayout(
	props: Omit<
		ComponentProps<typeof ProjectNavigationPanel>,
		"sidebarWidth" | "setExpandedSidebarWidth" | "isCollapsed" | "setSidebarCollapsed"
	>,
): React.ReactElement {
	const layout = useProjectNavigationLayout();
	return <ProjectNavigationPanel {...props} {...layout} />;
}

/** The panel wired to the add-project dialog the way App.tsx does it. */
function PanelWithAddProjectDialog(
	props: Omit<ComponentProps<typeof PanelWithLayout>, "onAddProject">,
): React.ReactElement {
	const [isAddProjectDialogOpen, setIsAddProjectDialogOpen] = useState(false);
	return (
		<>
			<PanelWithLayout {...props} onAddProject={() => setIsAddProjectDialogOpen(true)} />
			<AddProjectDialog
				open={isAddProjectDialogOpen}
				onOpenChange={setIsAddProjectDialogOpen}
				onProjectAdded={() => {}}
				currentProjectId={null}
			/>
		</>
	);
}

const SIDEBAR_MIN_EXPANDED_WIDTH = 200;
const SIDEBAR_MAX_EXPANDED_WIDTH = 600;
const BOARD_SURFACE_HORIZONTAL_CHROME_PX = 40;

const PROJECTS: RuntimeProjectSummary[] = [
	{
		id: "project-1",
		name: "Kanban",
		path: "/tmp/kanban",
		taskCounts: {
			backlog: 0,
			in_progress: 0,
			review: 0,
			trash: 0,
		},
	},
];

const TWO_PROJECTS: RuntimeProjectSummary[] = [
	{
		id: "alpha",
		name: "alpha-api",
		path: "/projects/alpha-api",
		taskCounts: { backlog: 2, in_progress: 0, review: 0, trash: 0 },
	},
	{
		id: "beta",
		name: "beta-web",
		path: "/projects/beta-web",
		taskCounts: { backlog: 0, in_progress: 1, review: 0, trash: 0 },
	},
];
const AGENT_LABELS: Record<string, string> = { alpha: "Claude Code", beta: "Codex" };

/** The panel with App.tsx's project and agent state: one board and one Kanban Agent per project. */
function SwitchingPanel({ onSelectProject }: { onSelectProject?: (projectId: string) => void }): React.ReactElement {
	const [currentProjectId, setCurrentProjectId] = useState("alpha");
	return (
		<TooltipProvider>
			<PanelWithLayout
				projects={TWO_PROJECTS}
				currentProjectId={currentProjectId}
				removingProjectId={null}
				agentSectionContent={<div data-testid="agent-session">{`agent session of ${currentProjectId}`}</div>}
				agentLabel={AGENT_LABELS[currentProjectId]}
				onSelectProject={(projectId) => {
					setCurrentProjectId(projectId);
					onSelectProject?.(projectId);
				}}
				onRemoveProject={async () => true}
				onAddProject={() => {}}
			/>
			<div data-testid="board">{`board of ${currentProjectId}`}</div>
		</TooltipProvider>
	);
}

function getSidebar(container: HTMLElement): HTMLElement {
	const sidebar = container.querySelector("aside");
	if (!sidebar) {
		throw new Error("Sidebar was not rendered");
	}
	return sidebar;
}

function getResizeHandle(container: HTMLElement): HTMLElement {
	const handle = container.querySelector('[aria-label="Resize sidebar"]');
	if (!handle) {
		throw new Error("Resize handle was not rendered");
	}
	return handle as HTMLElement;
}

function getButtonByTextOrNull(container: HTMLElement, text: string): HTMLButtonElement | null {
	return Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === text) ?? null;
}

function getButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === text);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Button with text "${text}" was not rendered`);
	}
	return button;
}

describe("ProjectNavigationPanel width persistence", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let previousAppVersion: unknown;
	let previousInnerWidth: number;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		previousAppVersion = (globalThis as typeof globalThis & { __APP_VERSION__?: unknown }).__APP_VERSION__;
		(globalThis as typeof globalThis & { __APP_VERSION__?: string }).__APP_VERSION__ = "test";
		previousInnerWidth = window.innerWidth;
		Object.defineProperty(window, "innerWidth", {
			value: 1600,
			configurable: true,
			writable: true,
		});
		localStorage.clear();
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		if (typeof previousAppVersion === "undefined") {
			delete (globalThis as typeof globalThis & { __APP_VERSION__?: unknown }).__APP_VERSION__;
		} else {
			(globalThis as typeof globalThis & { __APP_VERSION__?: unknown }).__APP_VERSION__ = previousAppVersion;
		}
		Object.defineProperty(window, "innerWidth", {
			value: previousInnerWidth,
			configurable: true,
			writable: true,
		});
	});

	function renderPanel(overrides: Partial<ComponentProps<typeof PanelWithLayout>> = {}): void {
		act(() => {
			root.render(
				<TooltipProvider>
					<PanelWithLayout
						projects={PROJECTS}
						currentProjectId="project-1"
						removingProjectId={null}
						onSelectProject={() => {}}
						onRemoveProject={async () => true}
						onAddProject={() => {}}
						{...overrides}
					/>
				</TooltipProvider>,
			);
		});
	}

	function getExpectedDefaultWidthPx(viewportWidth: number): number {
		const proportionalWidth = Math.round((viewportWidth - BOARD_SURFACE_HORIZONTAL_CHROME_PX) / 5);
		return Math.max(SIDEBAR_MIN_EXPANDED_WIDTH, Math.min(SIDEBAR_MAX_EXPANDED_WIDTH, proportionalWidth));
	}

	function clampExpandedWidth(width: number): number {
		return Math.max(SIDEBAR_MIN_EXPANDED_WIDTH, Math.min(SIDEBAR_MAX_EXPANDED_WIDTH, width));
	}

	it("shows Add project as a + icon button right of the project dropdown, and it opens the add-project dialog", async () => {
		act(() => {
			root.render(
				<TooltipProvider>
					<PanelWithAddProjectDialog
						projects={PROJECTS}
						currentProjectId="project-1"
						removingProjectId={null}
						onSelectProject={() => {}}
						onRemoveProject={async () => true}
					/>
				</TooltipProvider>,
			);
		});
		const button = container.querySelector<HTMLButtonElement>('button[aria-label="Add project"]');
		expect(button?.textContent).toBe("");
		expect(button?.firstElementChild?.tagName.toLowerCase()).toBe("svg");
		expect(button?.firstElementChild?.getAttribute("class")).toContain("lucide-plus");
		const projectDropdown = container.querySelector('button[aria-label="Project"]');
		expect(projectDropdown?.parentElement).toBe(button?.parentElement);
		expect(projectDropdown?.compareDocumentPosition(button as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(getButtonByTextOrNull(container, "Add project")).toBeNull();
		expect(document.body.textContent).not.toContain("Clone from URL");

		await act(async () => {
			button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Add Project");
		expect(document.body.textContent).toContain("Clone from URL");
		expect(document.body.textContent).toContain("New project");
	});

	it("uses a proportional one-fifth default width when no value is persisted", () => {
		renderPanel();
		const sidebar = getSidebar(container);
		expect(sidebar.style.width).toBe(`${getExpectedDefaultWidthPx(window.innerWidth)}px`);
	});

	it("persists resized width and restores it on remount", () => {
		renderPanel();
		const initialWidth = getExpectedDefaultWidthPx(window.innerWidth);
		const expectedResizedWidth = clampExpandedWidth(initialWidth + 160);
		const resizeHandle = getResizeHandle(container);
		act(() => {
			resizeHandle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 300 }));
		});
		act(() => {
			window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 460 }));
		});
		act(() => {
			window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		});

		expect(localStorage.getItem(LocalStorageKey.ProjectNavigationPanelWidth)).toBe(String(expectedResizedWidth));

		act(() => {
			root.unmount();
		});
		root = createRoot(container);

		renderPanel();
		const sidebar = getSidebar(container);
		expect(sidebar.style.width).toBe(`${expectedResizedWidth}px`);
	});

	it("keeps the beta notice out of the sidebar (it is the app footer now)", () => {
		renderPanel();
		expect(container.textContent).not.toContain("Kanban is in beta");
		expect(container.textContent).not.toContain("Report issue");
	});

	it("has no Kanban wordmark or version: the Project row is the top of the sidebar, at the top bar's height", () => {
		renderPanel();
		const sidebar = getSidebar(container);
		expect(sidebar.textContent).not.toContain("vtest");
		expect(sidebar.textContent?.startsWith("Project:")).toBe(true);
		const row = container.querySelector('button[aria-label="Project"]')?.parentElement;
		expect(row?.className).toContain("h-10");
		const firstRow = Array.from(sidebar.children).find((child) => child.getAttribute("role") !== "separator");
		expect(firstRow).toBe(row);
		expect(row?.nextElementSibling?.getAttribute("data-testid")).toBe("kanban-agent-header");
	});

	it("labels the project dropdown with Project: on the same row; the dropdown truncates, not the label", () => {
		renderPanel();
		const dropdown = container.querySelector<HTMLButtonElement>('button[aria-label="Project"]');
		const row = dropdown?.parentElement;
		const label = row?.firstElementChild;
		expect(label?.textContent).toBe("Project:");
		expect(label?.className).toContain("shrink-0");
		expect(label?.className).toContain("text-text-secondary");
		expect(label?.compareDocumentPosition(dropdown as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(dropdown?.className).toContain("min-w-0");
		expect(dropdown?.querySelector(".truncate")?.textContent).toBe("Kanban");
		const actions = row?.querySelector('button[aria-label="Project actions"]');
		const add = row?.querySelector('button[aria-label="Add project"]');
		expect(dropdown?.compareDocumentPosition(actions as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(actions?.compareDocumentPosition(add as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
	});

	it("keeps the tips and shortcuts out of the sidebar (they are the top bar's lightbulb now)", () => {
		renderPanel();
		expect(getButtonByTextOrNull(container, "Tips")).toBeNull();
		expect(container.querySelector('[aria-label="Keyboard shortcuts"]')).toBeNull();
		expect(container.textContent).not.toContain("Start backlog tasks");
	});

	it("shows a plain Kanban Agent header above the selected project's agent: not a toggle, agent name on the right", () => {
		act(() => {
			root.render(<SwitchingPanel />);
		});
		const header = container.querySelector<HTMLElement>('[data-testid="kanban-agent-header"]');
		expect(header?.tagName.toLowerCase()).toBe("div");
		expect(header?.textContent).toContain("Kanban Agent");
		expect(header?.querySelector("button")).toBeNull();
		expect(header?.hasAttribute("aria-pressed")).toBe(false);
		expect(header?.className).toContain("border-b");
		expect(header?.className).not.toMatch(/\bbg-/);
		expect(
			Array.from(container.querySelectorAll("button")).some((button) =>
				button.textContent?.includes("Kanban Agent"),
			),
		).toBe(false);
		const agentName = header?.querySelector('[data-testid="kanban-agent-name"]');
		expect(agentName?.textContent).toBe("Claude Code");
		expect(agentName?.className).toContain("ml-auto");
		expect(agentName?.className).toContain("text-text-secondary");
		expect(header?.lastElementChild).toBe(agentName);

		const dropdown = container.querySelector('button[aria-label="Project"]');
		const session = container.querySelector('[data-testid="agent-session"]');
		expect(dropdown?.compareDocumentPosition(header as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(header?.compareDocumentPosition(session as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(session?.textContent).toBe("agent session of alpha");

		act(() => {
			header?.click();
		});
		expect(container.querySelector('[data-testid="agent-session"]')?.textContent).toBe("agent session of alpha");
	});

	it("asks for a project in the agent panel when there is no agent session", () => {
		renderPanel({ currentProjectId: null });
		expect(container.querySelector('[data-testid="kanban-agent-header"]')).not.toBeNull();
		expect(container.textContent).toContain("Select a project to use the agent.");
	});

	it("switches the board and the Kanban Agent together when another project is picked", async () => {
		const onSelectProject = vi.fn();
		act(() => {
			root.render(<SwitchingPanel onSelectProject={onSelectProject} />);
		});
		expect(container.querySelector('[data-testid="agent-session"]')?.textContent).toBe("agent session of alpha");

		// Two clicks: open the dropdown, pick beta-web.
		const dropdown = container.querySelector<HTMLButtonElement>('button[aria-label="Project"]');
		await act(async () => {
			dropdown?.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const betaOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) =>
			option.textContent?.includes("beta-web"),
		);
		act(() => {
			betaOption?.click();
		});

		expect(onSelectProject).toHaveBeenCalledWith("beta");
		expect(container.querySelector('[data-testid="board"]')?.textContent).toBe("board of beta");
		expect(container.querySelector('[data-testid="agent-session"]')?.textContent).toBe("agent session of beta");
		expect(container.querySelector('[data-testid="kanban-agent-name"]')?.textContent).toBe("Codex");
		expect(dropdown?.textContent).toContain("beta-web");
	});

	it("removes the selected project from the project actions menu", async () => {
		const onRemoveProject = vi.fn(async () => true);
		renderPanel({ onRemoveProject });
		const actions = container.querySelector<HTMLButtonElement>('button[aria-label="Project actions"]');
		await act(async () => {
			actions?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		const deleteItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
			(item) => item.textContent === "Delete",
		);
		await act(async () => {
			deleteItem?.click();
		});
		expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain("Kanban");
		await act(async () => {
			getButtonByText(document.body, "Remove Project").click();
		});
		expect(onRemoveProject).toHaveBeenCalledWith("project-1");
	});
});
