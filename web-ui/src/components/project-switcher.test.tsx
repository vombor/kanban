import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectSwitcher } from "@/components/project-switcher";
import type { RuntimeProjectSummary } from "@/runtime/types";

const PROJECTS: RuntimeProjectSummary[] = [
	{
		id: "alpha",
		name: "alpha-api",
		path: "/projects/alpha-api",
		taskCounts: { backlog: 3, in_progress: 1, review: 0, trash: 2 },
	},
	{
		id: "beta",
		name: "beta-web",
		path: "/projects/beta-web",
		taskCounts: { backlog: 0, in_progress: 0, review: 4, trash: 0 },
	},
	{
		id: "gamma",
		name: "gamma-docs",
		path: "/projects/gamma-docs",
		taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
	},
];

function ControlledSwitcher({
	initialProjectId,
	onSelectProject,
}: {
	initialProjectId: string;
	onSelectProject: (projectId: string) => void;
}): React.ReactElement {
	const [currentProjectId, setCurrentProjectId] = useState(initialProjectId);
	return (
		<ProjectSwitcher
			projects={PROJECTS}
			currentProjectId={currentProjectId}
			isLoading={false}
			onSelectProject={(projectId) => {
				setCurrentProjectId(projectId);
				onSelectProject(projectId);
			}}
		/>
	);
}

async function flushTimers(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function pressKey(target: Element | null, key: string): void {
	if (!target) {
		throw new Error(`No target for key ${key}`);
	}
	act(() => {
		target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	});
}

function getTrigger(): HTMLButtonElement {
	const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Project"]');
	if (!trigger) {
		throw new Error("Project dropdown trigger was not rendered");
	}
	return trigger;
}

function getOptions(): HTMLElement[] {
	return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

function getOption(name: string): HTMLElement {
	const option = getOptions().find((candidate) => candidate.textContent?.includes(name));
	if (!option) {
		throw new Error(`Option ${name} was not rendered`);
	}
	return option;
}

describe("ProjectSwitcher", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

	function renderSwitcher(onSelectProject: (projectId: string) => void = () => {}): void {
		act(() => {
			root.render(<ControlledSwitcher initialProjectId="alpha" onSelectProject={onSelectProject} />);
		});
	}

	it("badges each project whose orchestrator waits, and counts the other projects on the trigger", async () => {
		const projects = PROJECTS.map((project) =>
			project.id === "alpha"
				? { ...project, orchestratorWait: { kind: "question" as const, since: 1 } }
				: project.id === "beta"
					? { ...project, orchestratorWait: { kind: "approval" as const, since: 2 } }
					: project,
		);
		act(() => {
			root.render(
				<ProjectSwitcher
					projects={projects}
					currentProjectId="alpha"
					isLoading={false}
					flashingProjectIds={new Set(["beta"])}
					onSelectProject={() => {}}
				/>,
			);
		});
		// The current project's own wait shows in the Kanban Agent header, so the trigger counts only beta.
		const triggerBadge = getTrigger().querySelector('[data-testid="orchestrator-wait-badge"]');
		expect(triggerBadge?.getAttribute("aria-label")).toBe("1 project's Kanban Agent waiting for you");
		expect(triggerBadge?.getAttribute("data-flashing")).toBe("true");

		pressKey(getTrigger(), "Enter");
		await flushTimers();
		expect(
			getOption("alpha-api").querySelector('[data-testid="orchestrator-wait-badge"]')?.getAttribute("aria-label"),
		).toBe("Kanban Agent has a question for you");
		expect(
			getOption("beta-web").querySelector('[data-testid="orchestrator-wait-badge"]')?.getAttribute("aria-label"),
		).toBe("Kanban Agent needs your approval");
		expect(getOption("gamma-docs").querySelector('[data-testid="orchestrator-wait-badge"]')).toBeNull();
	});

	it("tags a project whose QA pipeline is paused, and only in the list", async () => {
		const projects = PROJECTS.map((project) =>
			project.id === "beta" ? { ...project, pipelinePaused: true } : project,
		);
		act(() => {
			root.render(
				<ProjectSwitcher
					projects={projects}
					currentProjectId="beta"
					isLoading={false}
					onSelectProject={() => {}}
				/>,
			);
		});
		expect(getTrigger().textContent).toBe("beta-web");

		pressKey(getTrigger(), "Enter");
		await flushTimers();
		expect(getOption("beta-web").querySelector('[data-testid="qa-paused-tag"]')?.textContent).toBe("QA paused");
		expect(getOption("alpha-api").querySelector('[data-testid="qa-paused-tag"]')).toBeNull();
	});

	it("shows the selected project's name on the trigger", () => {
		renderSwitcher();
		expect(getTrigger().textContent).toContain("alpha-api");
		expect(getOptions()).toHaveLength(0);
	});

	it("shows every project as an option card with its board stats", async () => {
		renderSwitcher();
		pressKey(getTrigger(), "Enter");
		await flushTimers();

		expect(getOptions().map((option) => option.querySelector("span")?.textContent)).toEqual([
			"alpha-api",
			"beta-web",
			"gamma-docs",
		]);
		const alpha = getOption("alpha-api");
		expect(alpha.textContent).toContain("/projects/alpha-api");
		expect(alpha.querySelector('[data-column="backlog"]')?.textContent).toBe("Backlog: B|3");
		expect(alpha.querySelector('[data-column="in_progress"]')?.textContent).toBe("In Progress: IP|1");
		expect(alpha.querySelector('[data-column="trash"]')?.textContent).toBe("Done: D|2");
		expect(alpha.querySelector('[data-column="review"]')).toBeNull();
		expect(getOption("beta-web").querySelector('[data-column="review"]')?.textContent).toBe("Review: R|4");
		expect(getOption("gamma-docs").querySelectorAll("[data-column]")).toHaveLength(0);
		expect(alpha.getAttribute("aria-selected")).toBe("true");
		expect(alpha.getAttribute("data-state")).toBe("checked");
		expect(document.activeElement).toBe(alpha);
	});

	it("selects a project with a click", async () => {
		const onSelectProject = vi.fn();
		renderSwitcher(onSelectProject);
		pressKey(getTrigger(), "Enter");
		await flushTimers();

		act(() => {
			getOption("beta-web").click();
		});
		expect(onSelectProject).toHaveBeenCalledWith("beta");
		expect(getOptions()).toHaveLength(0);
		expect(getTrigger().textContent).toContain("beta-web");
	});

	it("is keyboard accessible: arrow keys, Enter, type-ahead and Esc", async () => {
		const onSelectProject = vi.fn();
		renderSwitcher(onSelectProject);

		// Arrow down opens on the selected project; another moves to the next one; Enter picks it.
		pressKey(getTrigger(), "ArrowDown");
		await flushTimers();
		expect(document.activeElement).toBe(getOption("alpha-api"));
		pressKey(document.activeElement, "ArrowDown");
		await flushTimers();
		expect(document.activeElement).toBe(getOption("beta-web"));
		expect(getOption("beta-web").hasAttribute("data-highlighted")).toBe(true);
		pressKey(document.activeElement, "Enter");
		await flushTimers();
		expect(onSelectProject).toHaveBeenLastCalledWith("beta");
		expect(getTrigger().textContent).toContain("beta-web");

		// Type-ahead jumps to the project whose name starts with the typed letter.
		pressKey(getTrigger(), "Enter");
		await flushTimers();
		pressKey(document.activeElement, "g");
		await flushTimers();
		expect(document.activeElement).toBe(getOption("gamma-docs"));
		pressKey(document.activeElement, "Enter");
		await flushTimers();
		expect(onSelectProject).toHaveBeenLastCalledWith("gamma");

		// Esc closes without changing the project.
		pressKey(getTrigger(), "Enter");
		await flushTimers();
		pressKey(document.activeElement, "ArrowUp");
		await flushTimers();
		pressKey(document.activeElement, "Escape");
		await flushTimers();
		expect(getOptions()).toHaveLength(0);
		expect(onSelectProject).toHaveBeenCalledTimes(2);
		expect(getTrigger().textContent).toContain("gamma-docs");
	});

	it("shows a skeleton while the project list loads", () => {
		act(() => {
			root.render(<ProjectSwitcher projects={[]} currentProjectId={null} isLoading onSelectProject={() => {}} />);
		});
		expect(container.querySelector('[data-testid="project-switcher-skeleton"]')).not.toBeNull();
	});
});
