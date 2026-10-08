import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	hasVisibleTerminalText,
	resolveTerminalReadiness,
	type TerminalReadinessInput,
} from "@/terminal/terminal-readiness";

function input(overrides: Partial<TerminalReadinessInput>): TerminalReadinessInput {
	return {
		connectionStatus: { state: "connected", lastClose: null },
		streamRestored: true,
		hasScreenOutput: false,
		summary: null,
		expectsSessionStart: false,
		loadingTimedOut: false,
		...overrides,
	};
}

const liveSummary = { state: "running", pid: 1 } as RuntimeTaskSessionSummary;
const deadSummary = { state: "interrupted", pid: null } as RuntimeTaskSessionSummary;

describe("hasVisibleTerminalText", () => {
	it("ignores probes, mode switches and OSC strings", () => {
		expect(hasVisibleTerminalText("")).toBe(false);
		expect(hasVisibleTerminalText("\u001b[?u\u001b[c")).toBe(false);
		expect(hasVisibleTerminalText("\u001b[?1049h\u001b[H\r\n  ")).toBe(false);
		expect(hasVisibleTerminalText("\u001b]0;title\u0007\u001b]11;?\u001b\\")).toBe(false);
	});

	it("sees drawn text", () => {
		expect(hasVisibleTerminalText("\u001b[?1049h\u001b[1;1H▐▛███▛█")).toBe(true);
		expect(hasVisibleTerminalText("$ ")).toBe(true);
	});
});

describe("resolveTerminalReadiness", () => {
	it("is connecting until the stream has restored", () => {
		expect(resolveTerminalReadiness(input({ streamRestored: false, hasScreenOutput: true }))).toEqual({
			state: "loading",
			phase: "connecting",
		});
	});

	it("is ready as soon as something is on screen, process or not", () => {
		expect(resolveTerminalReadiness(input({ hasScreenOutput: true, summary: deadSummary }))).toEqual({
			state: "ready",
		});
	});

	it("waits for a live process's first output, and for a start only where one is expected", () => {
		expect(resolveTerminalReadiness(input({ summary: liveSummary }))).toEqual({
			state: "loading",
			phase: "waiting_for_output",
		});
		expect(resolveTerminalReadiness(input({ summary: deadSummary, expectsSessionStart: true }))).toEqual({
			state: "loading",
			phase: "starting",
		});
		expect(resolveTerminalReadiness(input({ summary: deadSummary }))).toEqual({ state: "ready" });
	});

	it("gives up on a timeout or when reconnecting has given up", () => {
		expect(resolveTerminalReadiness(input({ summary: liveSummary, loadingTimedOut: true }))).toEqual({
			state: "unavailable",
			reason: "timeout",
		});
		expect(
			resolveTerminalReadiness(
				input({ connectionStatus: { state: "disconnected", lastClose: null }, streamRestored: false }),
			),
		).toEqual({ state: "unavailable", reason: "disconnected" });
	});
});
