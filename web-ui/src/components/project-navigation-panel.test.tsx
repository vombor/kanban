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
function SwitchingPanel({
	initialAgentOpen,
	onSelectProject,
}: {
	initialAgentOpen: boolean;
	onSelectProject?: (projectId: string) => void;
}): React.ReactElement {
	const [currentProjectId, setCurrentProjectId] = useState("alpha");
	const [isAgentOpen, setIsAgentOpen] = useState(initialAgentOpen);
	return (
		<TooltipProvider>
			<PanelWithLayout
				projects={TWO_PROJECTS}
				currentProjectId={currentProjectId}
				removingProjectId={null}
				isAgentOpen={isAgentOpen}
				onAgentOpenChange={setIsAgentOpen}
				canShowAgentSection
				agentSectionContent={<div data-testid="agent-session">{`agent session of ${currentProjectId}`}</div>}
				selectedAgentId={null}
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

function getButtonContaining(container: HTMLElement, text: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.includes(text),
	);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Button containing "${text}" was not rendered`);
	}
	return button;
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
						isAgentOpen={false}
						onAgentOpenChange={() => {}}
						canShowAgentSection
						selectedAgentId={null}
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
						isAgentOpen={false}
						onAgentOpenChange={() => {}}
						canShowAgentSection
						selectedAgentId={null}
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

	it("starts with the tips collapsed and remembers the open state; the shortcuts are inside", () => {
		renderPanel({ isAgentOpen: true, selectedAgentId: "droid" });
		const tipsToggle = getButtonByText(container, "Tips");
		expect(tipsToggle.getAttribute("aria-expanded")).toBe("false");
		expect(container.textContent).not.toContain("Create tasks.");
		expect(container.textContent).not.toContain("Start backlog tasks");
		expect(localStorage.getItem(LocalStorageKey.SidebarTipsExpanded)).toBeNull();

		act(() => {
			tipsToggle.click();
		});
		expect(tipsToggle.getAttribute("aria-expanded")).toBe("true");
		const tipsContent = document.getElementById(tipsToggle.getAttribute("aria-controls") ?? "");
		expect(tipsContent?.textContent).toContain("Create tasks.");
		expect(tipsContent?.querySelector('[aria-label="Keyboard shortcuts"]')?.textContent).toContain(
			"Start backlog tasks",
		);
		expect(localStorage.getItem(LocalStorageKey.SidebarTipsExpanded)).toBe("true");

		act(() => {
			root.unmount();
		});
		root = createRoot(container);
		renderPanel({ isAgentOpen: true, selectedAgentId: "droid" });
		expect(getButtonByText(container, "Tips").getAttribute("aria-expanded")).toBe("true");

		act(() => {
			getButtonByText(container, "Tips").click();
		});
		expect(getButtonByText(container, "Tips").getAttribute("aria-expanded")).toBe("false");
		expect(localStorage.getItem(LocalStorageKey.SidebarTipsExpanded)).toBe("false");
	});

	it("keeps the shortcuts reachable before the agent is opened", () => {
		renderPanel();
		act(() => {
			getButtonByText(container, "Tips").click();
		});
		expect(container.querySelector('[aria-label="Keyboard shortcuts"]')?.textContent).toContain("New task");
		expect(container.textContent).not.toContain("Create tasks.");
	});

	it("shows the selected project's Kanban Agent pill below the dropdown: full width, agent name on the right", () => {
		act(() => {
			root.render(<SwitchingPanel initialAgentOpen={false} />);
		});
		const pill = getButtonContaining(container, "Kanban Agent");
		const dropdown = container.querySelector('button[aria-label="Project"]');
		expect(dropdown?.compareDocumentPosition(pill)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(pill.className).toContain("w-full");
		expect(pill.getAttribute("aria-pressed")).toBe("false");
		const agentName = pill.querySelector('[data-testid="kanban-agent-name"]');
		expect(agentName?.textContent).toBe("Claude Code");
		expect(agentName?.className).toContain("ml-auto");
		expect(pill.lastElementChild).toBe(agentName);
		expect(container.querySelector('[data-testid="agent-session"]')).toBeNull();

		act(() => {
			pill.click();
		});
		expect(pill.getAttribute("aria-pressed")).toBe("true");
		expect(container.querySelector('[data-testid="agent-session"]')?.textContent).toBe("agent session of alpha");
	});

	it("toggles the tips on the pill's second click while the agent stays open", () => {
		act(() => {
			root.render(<SwitchingPanel initialAgentOpen={false} />);
		});
		const pill = getButtonContaining(container, "Kanban Agent");
		const tipsToggle = getButtonByText(container, "Tips");
		act(() => {
			pill.click();
		});
		expect(tipsToggle.getAttribute("aria-expanded")).toBe("false");
		expect(pill.getAttribute("title")).toBe("Show tips");

		act(() => {
			pill.click();
		});
		expect(tipsToggle.getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelector('[aria-label="Keyboard shortcuts"]')).not.toBeNull();
		expect(pill.getAttribute("aria-pressed")).toBe("true");
		expect(container.querySelector('[data-testid="agent-session"]')?.textContent).toBe("agent session of alpha");
		expect(pill.getAttribute("title")).toBe("Hide tips");

		act(() => {
			pill.click();
		});
		expect(tipsToggle.getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector('[data-testid="agent-session"]')).not.toBeNull();
	});

	it("switches the board and the Kanban Agent together when another project is picked", async () => {
		const onSelectProject = vi.fn();
		act(() => {
			root.render(<SwitchingPanel initialAgentOpen onSelectProject={onSelectProject} />);
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
