import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardCardRunStats } from "@/components/board-card-run-stats";
import { describeRunningTime } from "@/components/board-card-running-time";
import { describeTokenUsage, getTokenUsageInOut } from "@/components/board-card-token-usage";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { mergeTaskTokenUsage, setTaskTokenUsage } from "@/stores/task-token-usage-store";

const NOW = Date.parse("2026-10-12T12:00:00Z");

function summary(overrides: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	return {
		taskId: "7ad4d",
		state: "awaiting_review",
		agentId: "claude",
		workspacePath: "/tmp/wt",
		pid: null,
		startedAt: null,
		updatedAt: NOW,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
		...overrides,
	};
}

describe("BoardCardRunStats", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
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
		setTaskTokenUsage([]);
		container.remove();
		vi.useRealTimers();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	const render = async (sessionSummary: RuntimeTaskSessionSummary | undefined) => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCardRunStats taskId="7ad4d" sessionSummary={sessionSummary} />
				</TooltipProvider>,
			);
		});
	};
	const text = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

	it("shows tokens in (cache included) and out apart, with an accessible label, and follows pushed counts", async () => {
		setTaskTokenUsage([
			{ taskId: "7ad4d", input: 1_000, output: 48_000, cacheRead: 1_150_000, cacheWrite: 30_000, models: [] },
		]);
		await render(undefined);
		expect(text("board-card-token-usage")).toBe("1.2M↓ 48k↑");
		expect(text("board-card-tokens-in")).toBe("1.2M↓");
		expect(text("board-card-tokens-out")).toBe("48k↑");
		const usage = container.querySelector('[data-testid="board-card-token-usage"]');
		expect(usage?.getAttribute("aria-label")).toBe("1.2M tokens in, 48k tokens out");
		expect(usage?.textContent).not.toMatch(/tok/u);
		expect(text("board-card-running-time")).toBeNull();

		await act(async () => {
			mergeTaskTokenUsage([
				{ taskId: "7ad4d", input: 1_000, output: 52_000, cacheRead: 2_150_000, cacheWrite: 30_000, models: [] },
			]);
		});
		expect(text("board-card-token-usage")).toBe("2.2M↓ 52k↑");
	});

	it("keeps the full split in the tooltip and says that in includes the cache", () => {
		const usage = {
			taskId: "7ad4d",
			input: 1_000,
			output: 48_000,
			cacheRead: 1_150_000,
			cacheWrite: 30_000,
			models: [],
		};
		expect(getTokenUsageInOut(usage)).toEqual({ in: 1_181_000, out: 48_000 });
		expect(describeTokenUsage(usage, getTokenUsageInOut(usage))).toBe(
			[
				"1,181,000 tokens in · 48,000 tokens out over this card's agent sessions",
				"In includes the cache: input 1,000 · cache read 1,150,000 · cache write 30,000",
				"Out: output 48,000",
			].join("\n"),
		);
	});

	it("ticks a running card's time and holds a finished one", async () => {
		await render(summary({ state: "running", startedAt: NOW - 30_000, stateChangedAt: NOW - 30_000, runCount: 1 }));
		expect(text("board-card-run-stats")).toBe("30s");
		await act(async () => {
			vi.advanceTimersByTime(15_000);
		});
		expect(text("board-card-running-time")).toBe("45s");

		await render(summary({ runningMs: 45_000, runCount: 1 }));
		await act(async () => {
			vi.advanceTimersByTime(60_000);
		});
		expect(text("board-card-running-time")).toBe("45s");
	});

	it("renders nothing before a token or a running second is known", async () => {
		await render(summary({ state: "idle" }));
		expect(container.querySelector('[data-testid="board-card-run-stats"]')).toBeNull();

		// A Copilot session names its model before it writes any token total: still no count.
		setTaskTokenUsage([
			{ taskId: "7ad4d", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, models: ["claude-sonnet-5.5"] },
		]);
		await render(summary({ state: "idle" }));
		expect(container.querySelector('[data-testid="board-card-run-stats"]')).toBeNull();
		await render(summary({ runningMs: 45_000, runCount: 1 }));
		expect(text("board-card-run-stats")).toBe("45s");
	});
});

describe("describeRunningTime", () => {
	it("says what is counted: the runs, the first start and whether it runs now", () => {
		const firstRunStartedAt = NOW - 3_600_000;
		const finished = describeRunningTime({
			totalMs: 65 * 60_000,
			runningSince: null,
			runCount: 3,
			firstRunStartedAt,
		});
		expect(finished).toContain("Agent running time 1h 05m over 3 runs");
		expect(finished).toContain("First run started ");
		expect(finished).toContain("Review, idle and waiting time not counted");
		expect(describeRunningTime({ totalMs: 1_000, runningSince: NOW, runCount: 1, firstRunStartedAt: null })).toBe(
			"Agent running time 1s over 1 run\nRunning now",
		);
		expect(
			describeRunningTime({ totalMs: 1_000, runningSince: NOW, runCount: 0, firstRunStartedAt: null }),
		).toContain("(runs not counted)");
	});
});
