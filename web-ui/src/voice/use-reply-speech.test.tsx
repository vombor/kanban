import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { createFakeSpeechSynthesis, FakeUtterance } from "@/voice/test-speech-fakes";
import {
	getSpeakRepliesStorageKey,
	REPLY_SETTLE_MS,
	type ReplySpeechControls,
	useReplySpeech,
} from "@/voice/use-reply-speech";

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/repo",
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function turnEnd(finalMessage: string, at: number, hookEventName = "Stop"): RuntimeTaskSessionSummary {
	return createSummary({
		state: "awaiting_review",
		reviewReason: "hook",
		stateChangedAt: at,
		updatedAt: at,
		latestHookActivity: {
			activityText: null,
			toolName: null,
			toolInputSummary: null,
			finalMessage,
			hookEventName,
			notificationType: null,
			source: null,
		},
	});
}

describe("useReplySpeech", () => {
	let container: HTMLDivElement;
	let root: Root;
	let synthesis: ReturnType<typeof createFakeSpeechSynthesis>;
	let latest: ReplySpeechControls | null = null;

	function Harness({ taskId, summary }: { taskId: string; summary: RuntimeTaskSessionSummary | null }) {
		latest = useReplySpeech(taskId, summary);
		return null;
	}

	function render(summary: RuntimeTaskSessionSummary | null, taskId = "task-1") {
		act(() => {
			root.render(<Harness taskId={taskId} summary={summary} />);
		});
	}

	function controls(): ReplySpeechControls {
		if (!latest) {
			throw new Error("not rendered");
		}
		return latest;
	}

	beforeEach(() => {
		(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
		vi.useFakeTimers();
		synthesis = createFakeSpeechSynthesis();
		vi.stubGlobal("speechSynthesis", synthesis);
		vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
		window.localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		delete (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
		latest = null;
	});

	it("is off by default and remembers the toggle per session in localStorage", () => {
		render(createSummary());
		expect(controls().supported).toBe(true);
		expect(controls().enabled).toBe(false);
		act(() => controls().setEnabled(true));
		expect(window.localStorage.getItem(getSpeakRepliesStorageKey("task-1"))).toBe("true");

		act(() => root.unmount());
		root = createRoot(container);
		render(createSummary());
		expect(controls().enabled).toBe(true);
		render(createSummary({ taskId: "task-2" }), "task-2");
		expect(controls().enabled).toBe(false);
	});

	it("reads the final message of a turn that ends while it is on, without markdown", () => {
		window.localStorage.setItem(getSpeakRepliesStorageKey("task-1"), "true");
		render(createSummary());
		render(turnEnd("Done. Ran `npm test`: ```txt 12 passed ``` Should I **commit**?", 10));
		expect(synthesis.spoken).toHaveLength(0);
		act(() => vi.advanceTimersByTime(REPLY_SETTLE_MS));
		expect(synthesis.spoken.map((utterance) => utterance.text)).toEqual([
			"Done. Ran npm test: (code block) Should I commit?",
		]);
		expect(controls().speaking).toBe(true);
		act(() => synthesis.spoken[0]?.onend?.());
		expect(controls().speaking).toBe(false);
	});

	it("never reads the reply that was there when the panel opened, or the same turn twice", () => {
		window.localStorage.setItem(getSpeakRepliesStorageKey("task-1"), "true");
		render(turnEnd("Old reply.", 5));
		act(() => vi.advanceTimersByTime(REPLY_SETTLE_MS * 2));
		render(turnEnd("Old reply.", 5));
		act(() => vi.advanceTimersByTime(REPLY_SETTLE_MS * 2));
		expect(synthesis.spoken).toHaveLength(0);
	});

	it("doesn't read a leftover final message under a later hook, or a Review that doesn't hold", () => {
		window.localStorage.setItem(getSpeakRepliesStorageKey("task-1"), "true");
		render(createSummary());
		render(turnEnd("Leftover.", 10, "PreToolUse"));
		act(() => vi.advanceTimersByTime(REPLY_SETTLE_MS));
		render(turnEnd("Brief flip.", 20));
		act(() => vi.advanceTimersByTime(REPLY_SETTLE_MS / 2));
		render(createSummary({ updatedAt: 21 }));
		act(() => vi.advanceTimersByTime(REPLY_SETTLE_MS));
		expect(synthesis.spoken).toHaveLength(0);
	});

	it("stays quiet while off, and stop() cancels what is being read", () => {
		const cancel = vi.spyOn(synthesis, "cancel");
		render(createSummary());
		render(turnEnd("Quiet.", 10));
		act(() => vi.advanceTimersByTime(REPLY_SETTLE_MS));
		expect(synthesis.spoken).toHaveLength(0);

		act(() => controls().setEnabled(true));
		render(turnEnd("Loud.", 20));
		act(() => vi.advanceTimersByTime(REPLY_SETTLE_MS));
		expect(synthesis.spoken).toHaveLength(1);
		act(() => controls().stop());
		expect(cancel).toHaveBeenCalled();
		expect(controls().speaking).toBe(false);
	});
});
