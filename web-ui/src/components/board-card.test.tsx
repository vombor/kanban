import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardCard } from "@/components/board-card";
import { formatPipelineStageDeadline } from "@/components/board-card-pipeline-stage";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { setKanbanPaths } from "@/stores/kanban-paths-store";
import { setLandingMode } from "@/stores/landing-mode-store";
import { setPipelineCardStages } from "@/stores/pipeline-card-stage-store";
import { setSelectedAgentId } from "@/stores/selected-agent-store";
import { setTaskTokenUsage } from "@/stores/task-token-usage-store";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";
import type * as ReactUse from "@/utils/react-use";

let mockWorkspaceSnapshot: ReviewTaskWorkspaceSnapshot | undefined;
let mockMeasureWidths = [240, 240, 240];
let mockMeasureCallCount = 0;

vi.mock("@hello-pangea/dnd", () => ({
	Draggable: ({
		children,
	}: {
		children: (
			provided: {
				innerRef: (element: HTMLDivElement | null) => void;
				draggableProps: object;
				dragHandleProps: object;
			},
			snapshot: { isDragging: boolean },
		) => ReactNode;
	}): React.ReactElement => (
		<>{children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false })}</>
	),
}));

const mockShowAppToast = vi.hoisted(() => vi.fn());

vi.mock("@/components/app-toaster", () => ({
	showAppToast: mockShowAppToast,
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => mockWorkspaceSnapshot,
}));

vi.mock("@/utils/react-use", async (importOriginal) => ({
	useInterval: (await importOriginal<typeof ReactUse>()).useInterval,
	useMedia: () => false,
	useMeasure: () => {
		mockMeasureCallCount += 1;
		const width = mockMeasureWidths[(mockMeasureCallCount - 1) % mockMeasureWidths.length] ?? 240;
		return [
			() => {},
			{
				width,
				height: 0,
				top: 0,
				left: 0,
				bottom: 0,
				right: 0,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			},
		];
	},
}));

vi.mock("@/utils/text-measure", () => ({
	DEFAULT_TEXT_MEASURE_FONT: "400 14px sans-serif",
	measureTextWidth: (value: string) => value.length * 8,
	readElementFontShorthand: () => "400 14px sans-serif",
}));

vi.mock("@/utils/task-prompt", async () => {
	const actual = await vi.importActual<typeof import("@/utils/task-prompt")>("@/utils/task-prompt");
	return {
		...actual,
		truncateTaskPromptLabel: (prompt: string) => prompt.split("||")[0]?.trim() ?? "",
		normalizePromptForDisplay: (value: string) => value.split("||")[0]?.trim() ?? value.trim(),
		getTaskPromptDescription: (prompt: string, title: string) => {
			const normalized = prompt.trim();
			if (!normalized.startsWith(title)) {
				return normalized;
			}
			return normalized.slice(title.length).replace(/^\|\|/, "").trim();
		},
	};
});

function createCard(overrides?: Partial<Parameters<typeof BoardCard>[0]["card"]>) {
	return {
		id: "task-1",
		title: "Review API changes",
		prompt: "Review API changes",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit" as const,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createSummary(
	state: RuntimeTaskSessionSummary["state"],
	overrides?: Partial<RuntimeTaskSessionSummary>,
): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state,
		agentId: "cline",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: 1,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function Harness(): React.ReactElement {
	const [card, setCard] = useState(
		createCard({
			autoReviewEnabled: true,
			autoReviewMode: "pr",
		}),
	);

	return (
		<BoardCard
			card={card}
			index={0}
			columnId="backlog"
			onCancelAutomaticAction={() => {
				setCard((currentCard) => ({
					...currentCard,
					autoReviewEnabled: false,
				}));
			}}
		/>
	);
}

describe("BoardCard", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	const renderWithTooltips = (node: ReactNode) => {
		root.render(<TooltipProvider>{node}</TooltipProvider>);
	};

	beforeEach(() => {
		mockShowAppToast.mockClear();
		mockWorkspaceSnapshot = undefined;
		mockMeasureWidths = [240, 240, 240];
		mockMeasureCallCount = 0;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			width: 240,
			height: 32,
			right: 240,
			bottom: 32,
			toJSON: () => ({}),
		}));
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		setKanbanPaths(null);
		setLandingMode(null);
		setPipelineCardStages([]);
		setSelectedAgentId(null);
		setTaskTokenUsage([]);
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("settles fallback description measurements under fractional scaling", async () => {
		mockMeasureWidths = [0, 0, 0];
		let measurements = 0;
		vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(() => {
			const width = measurements++ % 2 === 0 ? 240.49 : 240.51;
			return { x: 0, y: 0, left: 0, top: 0, width, height: 32, right: width, bottom: 32, toJSON: () => ({}) };
		});
		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard({ prompt: "Review API changes||Description at fractional scale" })}
					index={0}
					columnId="backlog"
				/>,
			);
		});
		expect(container.textContent).toContain("Description at");
		expect(measurements).toBeLessThan(5);
	});

	it("updates truncation on a width-only observer resize", async () => {
		mockMeasureWidths = [0, 0, 0];
		const description = "This description contains enough words to wrap and truncate in a narrow card.";
		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard({ prompt: `Review API changes||${description}` })}
					index={0}
					columnId="backlog"
				/>,
			);
		});
		const wideText = container.textContent;
		mockMeasureWidths = [80.25, 80.25, 80.25];
		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard({ prompt: `Review API changes||${description}` })}
					index={0}
					columnId="backlog"
				/>,
			);
		});
		expect(container.textContent).not.toBe(wideText);
		expect(container.textContent).toContain("This");
		expect(container.textContent).not.toContain("contains enough words");
	});

	it("shows a mode-specific cancel button and hides it after canceling auto review", async () => {
		await act(async () => {
			renderWithTooltips(<Harness />);
		});

		const cancelButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Cancel Auto-PR",
		);
		expect(cancelButton).toBeDefined();

		await act(async () => {
			cancelButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			cancelButton?.click();
		});

		const nextCancelButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Cancel Auto-"),
		);
		expect(nextCancelButton).toBeUndefined();
	});

	it("shows a loading state on the review done button while moving to done", async () => {
		await act(async () => {
			renderWithTooltips(<BoardCard card={createCard()} index={0} columnId="review" isMoveToTrashLoading />);
		});

		const trashButton = container.querySelector('button[aria-label="Move task to done"]');
		expect(trashButton).toBeInstanceOf(HTMLButtonElement);
		expect((trashButton as HTMLButtonElement | null)?.disabled).toBe(true);
		expect(trashButton?.querySelector("svg.animate-spin")).toBeTruthy();
	});

	it("shows inline see more and less controls for long descriptions", async () => {
		const description =
			"Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau final hidden segment";

		await act(async () => {
			renderWithTooltips(
				<BoardCard card={createCard({ prompt: `Task title||${description}` })} index={0} columnId="backlog" />,
			);
		});

		const findButton = (label: string) =>
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

		const seeMoreButton = findButton("See more");
		expect(seeMoreButton).toBeDefined();
		expect(container.textContent).not.toContain("final hidden segment");

		await act(async () => {
			seeMoreButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			seeMoreButton?.click();
		});

		expect(findButton("See more")).toBeUndefined();
		expect(findButton("Less")).toBeDefined();
		expect(container.textContent).toContain(description);

		const lessButton = findButton("Less");
		await act(async () => {
			lessButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			lessButton?.click();
		});

		expect(findButton("See more")).toBeDefined();
		expect(container.textContent).not.toContain("final hidden segment");
	});

	it("reconstructs and shows trashed worktree path when workspace metadata is not tracked", async () => {
		setKanbanPaths({
			homePath: "/Users/alice/.kanban",
			homeSource: "default",
			worktreesRootPath: "/Users/alice/.kanban/worktrees",
			legacyWorktreeRootPaths: [],
			debugResetTargetPaths: [],
			projectConfigDisplayPath: "<project>/.cline/kanban/config.json",
		});
		await act(async () => {
			renderWithTooltips(
				<TooltipProvider>
					<BoardCard
						card={createCard({ id: "trash-task-1" })}
						index={0}
						columnId="trash"
						workspacePath="/Users/alice/projects/kanban"
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("~/.kanban/worktrees/trash-task-1/kanban");
	});

	it("does not guess a trashed worktree path before the runtime reports the worktrees root", async () => {
		await act(async () => {
			renderWithTooltips(
				<TooltipProvider>
					<BoardCard
						card={createCard({ id: "trash-task-1" })}
						index={0}
						columnId="trash"
						workspacePath="/Users/alice/projects/kanban"
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).not.toContain("trash-task-1/kanban");
	});

	it("shows Approve & land instead of Commit / Open PR on a card Kanban lands (landing mode qa)", async () => {
		mockWorkspaceSnapshot = {
			taskId: "task-1",
			path: "/tmp/worktree",
			branch: null,
			isDetached: true,
			headCommit: "abc",
			changedFiles: 2,
			additions: 3,
			deletions: 1,
		};
		const onCommit = vi.fn();
		const buttonLabels = () =>
			Array.from(container.querySelectorAll("button")).map((button) => button.textContent?.trim());
		const render = async (card: ReturnType<typeof createCard>) => {
			await act(async () => {
				root.render(
					<TooltipProvider>
						<BoardCard card={card} index={0} columnId="review" onCommit={onCommit} />
					</TooltipProvider>,
				);
			});
		};

		await render(createCard());
		expect(buttonLabels()).toEqual(expect.arrayContaining(["Commit", "Open PR"]));

		await act(async () => {
			setLandingMode("qa");
		});
		await render(createCard());
		expect(buttonLabels()).toContain("Approve & land");
		expect(buttonLabels()).not.toContain("Commit");
		const approve = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Approve & land",
		);
		await act(async () => {
			approve?.click();
		});
		expect(onCommit).toHaveBeenCalledWith("task-1");

		// A commit-mode auto-review card and a legacy QA card keep the upstream buttons.
		await render(createCard({ autoReviewEnabled: true, autoReviewMode: "commit" }));
		expect(buttonLabels()).toContain("Commit");
		await render(createCard({ title: "QA1 bbbbb: check the form" }));
		expect(buttonLabels()).not.toContain("Approve & land");
	});

	it("shows the card's pipeline stage on Review and In Progress cards (issue #30)", async () => {
		const deadline = Date.parse("2026-10-11T07:03:23.000Z");
		const stageBadge = () => container.querySelector('[data-testid="board-card-pipeline-stage"]');
		const render = async (columnId: "backlog" | "in_progress" | "review") => {
			await act(async () => {
				renderWithTooltips(<BoardCard card={createCard()} index={0} columnId={columnId} />);
			});
		};

		await render("review");
		expect(stageBadge()).toBeNull();

		await act(async () => {
			setPipelineCardStages([
				{
					taskId: "task-1",
					kind: "checks_running",
					label: "Checks running (test)",
					next: "QA next",
					qaTaskId: null,
					deadline,
					detail: null,
					inFlight: true,
				},
			]);
		});
		expect(stageBadge()?.textContent).toBe(
			`Checks running (test) · QA next · until ${formatPipelineStageDeadline(deadline)}`,
		);
		expect(stageBadge()?.getAttribute("data-stage-kind")).toBe("checks_running");

		await act(async () => {
			setPipelineCardStages([
				{
					taskId: "task-1",
					kind: "qa_running",
					label: "QA r2 running",
					next: null,
					qaTaskId: "12ab6",
					deadline: null,
					detail: null,
					inFlight: true,
				},
			]);
		});
		expect(stageBadge()?.textContent).toBe("QA r2 running (12ab6)");
		await render("in_progress");
		expect(stageBadge()?.textContent).toBe("QA r2 running (12ab6)");
		await render("backlog");
		expect(stageBadge()).toBeNull();

		await render("review");
		await act(async () => {
			setPipelineCardStages([]);
		});
		expect(stageBadge()).toBeNull();
	});

	it("shows a role badge on QA, TRIAGE and calibration cards and none on dev cards", async () => {
		await act(async () => {
			renderWithTooltips(<BoardCard card={createCard({ role: "qa" })} index={0} columnId="review" />);
		});
		expect(container.querySelector('[data-testid="board-card-role-badge"]')?.textContent).toBe("QA");

		await act(async () => {
			renderWithTooltips(<BoardCard card={createCard({})} index={0} columnId="review" />);
		});
		expect(container.querySelector('[data-testid="board-card-role-badge"]')).toBeNull();
	});

	it("shows Approve plan only on a plan card in Review", async () => {
		const hasApprovePlan = () =>
			Array.from(container.querySelectorAll("button")).some(
				(button) => button.textContent?.trim() === "Approve plan",
			);
		await act(async () => {
			renderWithTooltips(<BoardCard card={createCard({ role: "plan" })} index={0} columnId="review" />);
		});
		expect(hasApprovePlan()).toBe(true);
		await act(async () => {
			renderWithTooltips(<BoardCard card={createCard({ role: "plan" })} index={0} columnId="in_progress" />);
		});
		expect(hasApprovePlan()).toBe(false);
		await act(async () => {
			renderWithTooltips(<BoardCard card={createCard({})} index={0} columnId="review" />);
		});
		expect(hasApprovePlan()).toBe(false);
	});

	it("shows agent override details with the model and effort verbatim", async () => {
		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard({
						agentId: "cline",
						agentSettings: {
							modelId: "us.openai.gpt-6.1-sol",
							reasoningEffort: "low",
						},
					})}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(container.textContent).toContain("Cline · us.openai.gpt-6.1-sol (low)");
	});

	it("shows reasoning-only overrides against the default model", async () => {
		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard({
						agentSettings: {
							reasoningEffort: "low",
						},
					})}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(container.textContent).toContain("Default model (low)");
	});

	it("does not mislabel provider-only overrides as the global default model", async () => {
		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard({
						agentSettings: {
							providerId: "groq",
						},
					})}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(container.textContent).toContain("Provider: groq");
		expect(container.textContent).not.toContain("GPT-5.5");
	});

	it("shows tool input details in the session preview text", async () => {
		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={{
						taskId: "task-1",
						state: "running",
						agentId: "cline",
						workspacePath: "/tmp/worktree",
						pid: null,
						startedAt: Date.now(),
						updatedAt: Date.now(),
						lastOutputAt: Date.now(),
						reviewReason: null,
						exitCode: null,
						lastHookAt: Date.now(),
						latestHookActivity: {
							activityText: "Using Read",
							toolName: "Read",
							toolInputSummary: "src/index.ts",
							finalMessage: null,
							hookEventName: "tool_call",
							notificationType: null,
							source: "cline-sdk",
						},
						modelId: null,
						reasoningEffort: null,
						latestTurnCheckpoint: null,
						previousTurnCheckpoint: null,
					}}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Using Read");
	});

	it("shows non-cline tool activity in the compact tool label format", async () => {
		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "claude",
						latestHookActivity: {
							activityText: "Completed Read: src/index.ts",
							toolName: "Read",
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "tool_result",
							notificationType: null,
							source: "claude",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Completed Read");
	});

	it("keeps canonical tool names in the session preview label", async () => {
		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "kiro",
						latestHookActivity: {
							activityText: "Using fs_write: src/index.ts",
							toolName: "fs_write",
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "preToolUse",
							notificationType: null,
							source: "kiro",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("fs_write(src/index.ts)");
	});

	it("parses codex tool activity into the compact tool label format", async () => {
		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "codex",
						latestHookActivity: {
							activityText: "Calling Read: src/index.ts",
							toolName: null,
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "raw_response_item",
							notificationType: null,
							source: "codex",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Calling Read");
	});

	it("does not show a stale bare tool name for non-tool review updates", async () => {
		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="review"
					sessionSummary={createSummary("awaiting_review", {
						agentId: "kiro",
						latestHookActivity: {
							activityText: "Waiting for review",
							toolName: "fs_write",
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "stop",
							notificationType: null,
							source: "kiro",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Waiting for review");
		expect(container.textContent).not.toContain("fs_write");
	});

	it("keeps showing the last cline tool label during assistant streaming", async () => {
		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={{
						taskId: "task-1",
						state: "running",
						agentId: "cline",
						workspacePath: "/tmp/worktree",
						pid: null,
						startedAt: Date.now(),
						updatedAt: Date.now(),
						lastOutputAt: Date.now(),
						reviewReason: null,
						exitCode: null,
						lastHookAt: Date.now(),
						latestHookActivity: {
							activityText: "Agent active",
							toolName: "Read",
							toolInputSummary: "src/index.ts",
							finalMessage: "Looking at the file now",
							hookEventName: "assistant_delta",
							notificationType: null,
							source: "cline-sdk",
						},
						modelId: null,
						reasoningEffort: null,
						latestTurnCheckpoint: null,
						previousTurnCheckpoint: null,
					}}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Thinking...");
	});

	it("renders a new card description before the async measure observer reports width", async () => {
		mockMeasureWidths = [0, 0, 0];

		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard({ prompt: "Task title||Freshly created task description" })}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(container.textContent).toContain("Freshly created task description");
	});

	it("renders session activity as single-line truncated text on trash cards", async () => {
		const preview =
			"Reviewing the archived implementation details and collecting the final notes for the handoff before cleanup hidden tail";

		await act(async () => {
			renderWithTooltips(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="trash"
						sessionSummary={createSummary("awaiting_review", {
							latestHookActivity: {
								activityText: null,
								toolName: null,
								toolInputSummary: null,
								finalMessage: preview,
								hookEventName: "assistant_delta",
								notificationType: null,
								source: "cline-sdk",
							},
						})}
					/>
				</TooltipProvider>,
			);
		});

		const findButton = (label: string) =>
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

		// Session activity uses CSS truncation with no See more / Less buttons
		expect(findButton("See more")).toBeUndefined();
		expect(findButton("Less")).toBeUndefined();

		// The full text is in the DOM (CSS handles visual truncation)
		expect(container.textContent).toContain(preview);
	});

	it("renders session activity as single-line truncated text for running tasks", async () => {
		const preview =
			"Reviewing the archived implementation details and collecting the final notes for the handoff before cleanup hidden tail";

		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						latestHookActivity: {
							activityText: null,
							toolName: null,
							toolInputSummary: null,
							finalMessage: preview,
							hookEventName: "assistant_delta",
							notificationType: null,
							source: "cline-sdk",
						},
					})}
				/>,
			);
		});

		const findButton = (label: string) =>
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

		// Session activity uses CSS truncation with no See more / Less buttons
		expect(findButton("See more")).toBeUndefined();
		expect(findButton("Less")).toBeUndefined();

		// The full text is in the DOM (CSS handles visual truncation)
		expect(container.textContent).toContain(preview);
	});

	it("shows the latest assistant preview on active task cards", async () => {
		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						latestHookActivity: {
							activityText: "Reviewing the final diff",
							toolName: null,
							toolInputSummary: null,
							finalMessage: "Reviewing the final diff",
							hookEventName: "assistant_delta",
							notificationType: null,
							source: "cline-sdk",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Reviewing the final diff");
		expect(container.textContent).not.toContain("Thinking...");
	});

	it("shows normal agent messages without the agent prefix", async () => {
		await act(async () => {
			renderWithTooltips(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "codex",
						latestHookActivity: {
							activityText: "Agent: checking the next file",
							toolName: null,
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "agent_message",
							notificationType: null,
							source: "codex",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("checking the next file");
		expect(container.textContent).not.toContain("Agent:");
	});

	const renderCard = async (node: ReactNode) => {
		await act(async () => {
			renderWithTooltips(node);
		});
	};
	const agentPill = (taskId: string) =>
		container.querySelector(`[data-task-id="${taskId}"] [data-testid="board-card-agent"]`);

	const headerOf = (taskId: string) =>
		container.querySelector(`[data-task-id="${taskId}"] [data-testid="board-card-header"]`);
	const metaRowOf = (taskId: string) =>
		container.querySelector(`[data-task-id="${taskId}"] [data-testid="board-card-meta-row"]`);
	const runStatsOf = (taskId: string) =>
		container.querySelector(`[data-task-id="${taskId}"] [data-testid="board-card-run-stats"]`);

	it("puts the task id alone in a header strip across the top of the card", async () => {
		setSelectedAgentId("claude");
		await renderCard(<BoardCard card={createCard({ id: "7ad4d" })} index={0} columnId="review" />);

		const header = headerOf("7ad4d");
		const taskId = header?.querySelector('[data-testid="board-card-task-id"]');
		expect(taskId?.textContent).toBe("7ad4d");
		expect(Array.from(header?.children ?? [])).toEqual([taskId]);
		// Flush with the card's top: the card's first child, set apart by its own surface and a bottom border.
		const card = header?.parentElement;
		expect(card?.firstElementChild).toBe(header);
		expect(card?.className.split(" ")).toEqual(expect.arrayContaining(["overflow-hidden", "rounded-md"]));
		expect(card?.className.split(" ")).not.toContain("p-2.5");
		expect(header?.className.split(" ")).toEqual(
			expect.arrayContaining(["bg-surface-1", "border-b", "border-border"]),
		);
		expect(metaRowOf("7ad4d")?.querySelector('[data-testid="board-card-task-id"]')).toBeNull();
	});

	it("puts the agent pill on the left of the agent row and the run stats right-justified on the same row", async () => {
		setSelectedAgentId("claude");
		setTaskTokenUsage([{ taskId: "7ad4d", input: 1_000, output: 20_000, cacheRead: 1_150_000, cacheWrite: 30_000 }]);
		await renderCard(
			<BoardCard
				card={createCard({ id: "7ad4d", agentId: "cline", agentSettings: { modelId: "gpt-x" } })}
				index={0}
				columnId="review"
			/>,
		);

		const row = metaRowOf("7ad4d");
		const pill = row?.querySelector('[data-testid="board-card-agent"]');
		const stats = runStatsOf("7ad4d");
		expect(pill?.textContent).toBe("Cline · gpt-x");
		expect(pill?.getAttribute("title")).toBe("Cline · gpt-x");
		expect(Array.from(row?.children ?? [])).toEqual([pill, stats]);
		expect(stats?.textContent).toBe("1.2M tok");
		expect(row?.className).toContain("items-center");
		expect(row?.className).not.toContain("flex-wrap");
		// The stats stay on one line at the right end; only the pill truncates.
		expect(stats?.className.split(" ")).toEqual(expect.arrayContaining(["ml-auto", "shrink-0", "whitespace-nowrap"]));
		expect(pill?.className).toContain("min-w-[26px]");
		// The model gives way first: the agent name doesn't shrink and is capped to the pill beside its icon.
		const [agentName, model] = Array.from(pill?.querySelectorAll(".truncate") ?? []);
		expect(agentName?.textContent).toBe("Cline");
		expect(agentName?.className.split(" ")).toEqual(expect.arrayContaining(["shrink-0", "max-w-[calc(100%-16px)]"]));
		expect(model?.textContent).toBe("· gpt-x");
		expect(model?.className.split(" ")).toContain("min-w-0");
	});

	it("puts the task id in a bordered pill shaped like the agent pill", async () => {
		setSelectedAgentId("claude");
		await renderCard(<BoardCard card={createCard({ id: "7ad4d" })} index={0} columnId="backlog" />);

		const taskId = headerOf("7ad4d")?.querySelector('[data-testid="board-card-task-id"]');
		expect(taskId?.className).toContain("whitespace-nowrap");
		for (const name of ["rounded-md", "border", "border-border", "px-1.5", "py-0.5", "text-xs"]) {
			expect(taskId?.className.split(" ")).toContain(name);
			expect(agentPill("7ad4d")?.className.split(" ")).toContain(name === "border-border" ? "border" : name);
		}
	});

	const prerequisites = { total: 2, done: 1, waitingOnTaskIds: ["aaaa1"], missingTaskIds: [] };

	it("shows a Backlog card's prerequisites right-justified on the agent row", async () => {
		setSelectedAgentId("claude");
		await renderCard(
			<BoardCard
				card={createCard({ id: "b31c9" })}
				prerequisiteStatus={prerequisites}
				index={0}
				columnId="backlog"
			/>,
		);

		const row = metaRowOf("b31c9");
		const waiting = row?.querySelector('[data-testid="board-card-prerequisites"]');
		expect(waiting?.textContent).toBe("Waiting on 1 of 2");
		expect(Array.from(row?.children ?? [])).toEqual([agentPill("b31c9"), waiting]);
		// One line at the right end; it truncates only once the pill is down to its icon (26 px, plus the 8-px gap).
		expect(waiting?.className.split(" ")).toEqual(
			expect.arrayContaining(["ml-auto", "shrink-0", "whitespace-nowrap", "max-w-[calc(100%-34px)]"]),
		);
		expect(agentPill("b31c9")?.className.split(" ")).toContain("min-w-[26px]");
		expect(runStatsOf("b31c9")).toBeNull();
	});

	it("shows nothing right of the pill on Backlog cards without prerequisites, nor on later cards with nothing counted", async () => {
		setSelectedAgentId("claude");
		await renderCard(
			<>
				<BoardCard card={createCard({ id: "b31c9" })} index={0} columnId="backlog" />
				<BoardCard
					card={createCard({ id: "c41d0" })}
					prerequisiteStatus={prerequisites}
					index={1}
					columnId="in_progress"
				/>
				<BoardCard
					card={createCard({ id: "d51e1" })}
					prerequisiteStatus={prerequisites}
					index={2}
					columnId="review"
				/>
			</>,
		);

		expect(container.querySelector('[data-testid="board-card-run-stats"]')).toBeNull();
		expect(container.querySelector('[data-testid="board-card-prerequisites"]')).toBeNull();
		for (const id of ["b31c9", "c41d0", "d51e1"]) {
			expect(Array.from(metaRowOf(id)?.children ?? [])).toEqual([agentPill(id)]);
		}
	});

	it("shows a running card's tokens and live running time on the agent row, never a cost", async () => {
		vi.useFakeTimers();
		try {
			const now = Date.parse("2026-10-12T12:00:00Z");
			vi.setSystemTime(now);
			setSelectedAgentId("claude");
			setTaskTokenUsage([{ taskId: "c41d0", input: 2_000, output: 6_000, cacheRead: 40_000, cacheWrite: 0 }]);
			await renderCard(
				<BoardCard
					card={createCard({ id: "c41d0" })}
					sessionSummary={createSummary("running", {
						taskId: "c41d0",
						startedAt: now - 2 * 60_000,
						stateChangedAt: now - 2 * 60_000,
						runningMs: 10 * 60_000,
						runCount: 2,
						firstRunStartedAt: now - 3_600_000,
					})}
					index={0}
					columnId="in_progress"
				/>,
			);

			const stats = runStatsOf("c41d0");
			expect(stats?.parentElement).toBe(metaRowOf("c41d0"));
			expect(stats?.textContent).toBe("48k tok·12m");
			expect(stats?.textContent).not.toMatch(/\$|cost/iu);

			// The time follows the running agent.
			await act(async () => {
				vi.advanceTimersByTime(60_000);
			});
			expect(stats?.querySelector('[data-testid="board-card-running-time"]')?.textContent).toBe("13m");
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows the totals of Review and Done cards, and just the time before any token is counted", async () => {
		setSelectedAgentId("claude");
		setTaskTokenUsage([{ taskId: "d51e1", input: 1_000, output: 2_000, cacheRead: 1_150_000, cacheWrite: 0 }]);
		await renderCard(
			<>
				<BoardCard
					card={createCard({ id: "d51e1" })}
					sessionSummary={createSummary("awaiting_review", {
						taskId: "d51e1",
						runningMs: 65 * 60_000,
						runCount: 1,
					})}
					index={0}
					columnId="trash"
				/>
				<BoardCard
					card={createCard({ id: "e61f2" })}
					sessionSummary={createSummary("awaiting_review", { taskId: "e61f2", runningMs: 45_000, runCount: 1 })}
					index={1}
					columnId="review"
				/>
				<BoardCard
					card={createCard({ id: "f71a3" })}
					sessionSummary={createSummary("awaiting_review", { taskId: "f71a3", runningMs: 45_000 })}
					prerequisiteStatus={prerequisites}
					index={2}
					columnId="backlog"
				/>
			</>,
		);

		expect(runStatsOf("d51e1")?.textContent).toBe("1.2M tok·1h 05m");
		expect(runStatsOf("e61f2")?.textContent).toBe("45s");
		expect(runStatsOf("e61f2")?.querySelector('[data-testid="board-card-token-usage"]')).toBeNull();
		// Never on a Backlog card: its agent row keeps the prerequisites only.
		expect(runStatsOf("f71a3")).toBeNull();
		expect(metaRowOf("f71a3")?.querySelector('[data-testid="board-card-prerequisites"]')?.textContent).toBe(
			"Waiting on 1 of 2",
		);
	});

	it("shows the selected agent on a card with no agent of its own (default kit)", async () => {
		setSelectedAgentId("claude");
		await renderCard(<BoardCard card={createCard({ id: "b31c9" })} index={0} columnId="backlog" />);

		expect(agentPill("b31c9")?.textContent).toBe("Claude Code");
	});

	it("shows the agent on every card of a board where all cards use the same agent", async () => {
		setSelectedAgentId("codex");
		await renderCard(
			<>
				<BoardCard card={createCard({ id: "aaaa1" })} index={0} columnId="backlog" />
				<BoardCard card={createCard({ id: "aaaa2" })} index={1} columnId="in_progress" />
				<BoardCard card={createCard({ id: "aaaa3", agentId: "codex" })} index={2} columnId="review" />
			</>,
		);

		expect(["aaaa1", "aaaa2", "aaaa3"].map((id) => agentPill(id)?.textContent)).toEqual([
			"OpenAI Codex",
			"OpenAI Codex",
			"OpenAI Codex",
		]);
	});

	it("shows the card's own agent and model over the selected agent, and the session's agent over both", async () => {
		setSelectedAgentId("claude");
		await renderCard(
			<>
				<BoardCard
					card={createCard({ id: "own01", agentId: "copilot", agentSettings: { modelId: "mai-code-1.1-flash" } })}
					index={0}
					columnId="backlog"
				/>
				<BoardCard
					card={createCard({ id: "ses01", agentId: "copilot" })}
					sessionSummary={createSummary("running", { taskId: "ses01", agentId: "cline" })}
					index={1}
					columnId="in_progress"
				/>
			</>,
		);

		expect(agentPill("own01")?.textContent).toBe("GitHub Copilot · mai-code-1.1-flash");
		expect(agentPill("ses01")?.textContent).toBe("Cline");
	});

	it("shows only a named agent before the config has loaded", async () => {
		await renderCard(
			<>
				<BoardCard card={createCard({ id: "b31c9" })} index={0} columnId="backlog" />
				<BoardCard card={createCard({ id: "c41d0", agentId: "cline" })} index={1} columnId="backlog" />
			</>,
		);

		expect(metaRowOf("b31c9")?.textContent).toBe("");
		expect(headerOf("b31c9")?.textContent).toBe("b31c9");
		expect(agentPill("c41d0")?.textContent).toBe("Cline");
	});

	it("copies the task id without opening or dragging the card", async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const onClick = vi.fn();
		await act(async () => {
			renderWithTooltips(
				<BoardCard card={createCard({ id: "7ad4d" })} index={0} columnId="backlog" onClick={onClick} />,
			);
		});

		const taskId = container.querySelector<HTMLButtonElement>('[data-testid="board-card-task-id"]');
		const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
		await act(async () => {
			taskId?.dispatchEvent(mouseDown);
			taskId?.click();
		});

		expect(mouseDown.defaultPrevented).toBe(true);
		expect(writeText).toHaveBeenCalledWith("7ad4d");
		expect(mockShowAppToast).toHaveBeenCalledWith(
			expect.objectContaining({ intent: "success", message: "Copied 7ad4d" }),
			expect.any(String),
		);
		expect(onClick).not.toHaveBeenCalled();

		container.querySelector<HTMLElement>('[data-task-id="7ad4d"]')?.click();
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});
