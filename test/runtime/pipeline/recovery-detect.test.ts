import { describe, expect, it } from "vitest";

import {
	detectFinalProviderError,
	detectHungRequest,
	detectPrematureStop,
	detectRunError,
	findOverflowCulprit,
	getProviderAccountError,
	isContextOverflowError,
	isModelNotLoadedError,
	isPoisonedHistoryError,
	isRetryableProviderError,
	isTransientProviderError,
	readProviderUsageLimit,
} from "../../../src/pipeline/recovery-detect";
import { KANBAN_CLINE_HUB_ABORT_REASONS } from "../../../src/terminal/cline-hub-abort-reason";
import type { ClineSessionDetail, ClineSessionDetailMessage } from "../../../src/terminal/cline-session-files";

const text = (
	role: string,
	value: string,
	extra: Partial<ClineSessionDetailMessage> = {},
): ClineSessionDetailMessage => ({
	role,
	content: [{ type: "text", text: value }],
	outputTokens: null,
	ts: null,
	...extra,
});
const toolCall: ClineSessionDetailMessage = {
	role: "assistant",
	content: [{ type: "text", text: "Reading it." }, { type: "tool_use" }],
	outputTokens: null,
	ts: null,
};
const toolResult = (size: number, query?: string): ClineSessionDetailMessage => ({
	role: "user",
	content: [{ type: "tool_result", size, ...(query ? { query } : {}) }],
	outputTokens: null,
	ts: null,
});

const ISSUE_12_IMAGE_ERROR =
	"messages.1.content.86.image.source.base64.data: At least one of the image dimensions exceed max allowed size: 8000 pixels";

const detailOf = (messages: ClineSessionDetailMessage[], status = "idle"): ClineSessionDetail => ({
	snapshot: { sessionId: "s1", status, startedAt: 1, messagesWrittenAt: 2, lastMessage: null },
	messages,
	lastWriteAt: 2,
});

describe("detectRunError", () => {
	it("calls a run whose last turn is the agent's own error a run error", () => {
		expect(detectRunError(detailOf([text("user", "go"), toolCall, text("assistant", ISSUE_12_IMAGE_ERROR)]))).toEqual(
			{
				kind: "image_rejected",
				tooLarge: true,
				text: ISSUE_12_IMAGE_ERROR.slice(-160),
			},
		);
		expect(detectRunError(detailOf([text("assistant", "The operation timed out.")]))).toEqual({
			kind: "provider_error",
			text: "The operation timed out.",
		});
		expect(detectRunError(detailOf([text("assistant", " ")]))?.kind).toBe("empty_reply");
		expect(detectRunError(detailOf([text("user", "go"), toolCall], "failed"))?.kind).toBe("session_failed");
	});

	it("leaves a finished run alone", () => {
		expect(
			detectRunError(detailOf([text("assistant", "QA abc12 round 1: PASS, report in /tmp/out/verdict.json")])),
		).toBeNull();
		expect(detectRunError(detailOf([text("user", "go"), toolCall]))).toBeNull();
	});
});

describe("detectPrematureStop", () => {
	it("calls an announcement without a tool call a premature stop (9496770)", () => {
		expect(detectPrematureStop([text("user", "go"), text("assistant", "Now let me examine the files:")])).toEqual({
			kind: "announcement",
			text: "Now let me examine the files:",
		});
	});

	it("finds an empty final reply, and one at the output cap (fc270f0, 8590bad)", () => {
		expect(detectPrematureStop([text("user", "go"), text("assistant", "  ")])).toEqual({
			kind: "empty",
			outputCap: false,
		});
		expect(detectPrematureStop([text("assistant", "", { outputTokens: 4096 })])).toEqual({
			kind: "empty",
			outputCap: true,
		});
	});

	it("finds a 'model doesn't support images' reply (0f713ad)", () => {
		expect(detectPrematureStop([text("assistant", "Error: this model does not support image input")])?.kind).toBe(
			"no_images",
		);
	});

	it("finds an image over the provider's size limits as an image rejection (issue #12)", () => {
		expect(detectPrematureStop([text("assistant", `${ISSUE_12_IMAGE_ERROR}`)])).toMatchObject({
			kind: "no_images",
			tooLarge: true,
		});
		expect(detectPrematureStop([text("assistant", "this model does not support image input")])).toMatchObject({
			kind: "no_images",
			tooLarge: false,
		});
	});

	it("leaves finished replies and tool calls alone", () => {
		expect(detectPrematureStop([text("assistant", "All done, tests pass. STATUS: DONE")])).toBeNull();
		expect(detectPrematureStop([text("user", "go"), toolCall])).toBeNull();
		expect(detectPrematureStop([])).toBeNull();
	});
});

describe("provider error classes", () => {
	it("sorts poisoned history, overflows and transient errors (c09cd4b, daf86a5)", () => {
		expect(isPoisonedHistoryError("ValidationException: The content field in messages.39 is empty")).toBe(true);
		expect(isContextOverflowError("prompt is too long: 140000 tokens")).toBe(true);
		expect(isTransientProviderError("503 Service Unavailable")).toBe(true);
		expect(isTransientProviderError("stream timeout after 300000")).toBe(true);
		expect(isTransientProviderError("connect ECONNREFUSED 127.0.0.1:13305")).toBe(true);
		// A poisoned history is never retried as transient, even when it mentions a timeout.
		expect(isTransientProviderError("ValidationException: request timed out")).toBe(false);
		expect(isTransientProviderError("you used the wrong tool")).toBe(false);
	});

	it("reads a bare provider error as the final reply (0bc6387)", () => {
		expect(detectFinalProviderError([text("assistant", "The operation timed out.")])).toEqual({
			text: "The operation timed out.",
			notice: false,
		});
		expect(detectFinalProviderError([text("assistant", "Done. STATUS: DONE")])).toBeNull();
	});

	it("reads Cline's error notices as provider errors, whatever their text (issue #32)", () => {
		const notice = { displayError: true };
		for (const error of [
			"No model loaded: Devstral-Small-2-24B-Instruct-2512-GGUF-Q4_K_M",
			"decode() failed: vk::Queue::submit: ErrorDeviceLost",
			"Response stream ended without a finish reason.",
		]) {
			const found = detectFinalProviderError([text("user", "REWORK round 2"), text("assistant", error, notice)]);
			expect(found).toEqual({ text: error, notice: true });
			expect(found && isRetryableProviderError(found)).toBe(true);
			expect(detectRunError(detailOf([text("user", "go"), text("assistant", error, notice)]))).toEqual({
				kind: "provider_error",
				text: error,
			});
		}
		// The same text written by the model is its reply, not an error.
		expect(
			detectFinalProviderError([text("assistant", "decode() failed: vk::Queue::submit: ErrorDeviceLost")]),
		).toBeNull();
		// A notice that poisons the history stays the /clear path, and an overflow notice stays an overflow.
		const validation = detectFinalProviderError([text("assistant", "ValidationException: messages.3", notice)]);
		expect(validation && isRetryableProviderError(validation)).toBe(false);
		expect(detectRunError(detailOf([text("assistant", "Context size has been exceeded.", notice)]))?.kind).toBe(
			"context_overflow",
		);
		expect(isModelNotLoadedError("No model loaded: GLM-4.7-Flash-GGUF")).toBe(true);
		expect(isModelNotLoadedError("decode() failed: vk::Queue::submit: ErrorDeviceLost")).toBe(false);
	});

	it("tells ClinePass's account answers apart, as Cline writes them and as its server sends them", () => {
		const notice = { displayError: true };
		for (const [error, kind] of [
			[
				"No access to ClinePass subscription models yet. Subscribe to ClinePass, the low cost open weights model coding plan: https://app.cline.bot/dashboard/subscription?personal=true",
				"no_subscription",
			],
			["the user is not subscribed to required model plan", "no_subscription"],
			[
				"Organization accounts cannot use ClinePass subscriptions. Go to /account -> change account to switch to your personal account for ClinePass",
				"organization_account",
			],
			["organization accounts cannot use individual model inference subscriptions", "organization_account"],
			["You have reached your ClinePass limit for this period. Please try again later.", "limit"],
		] as const) {
			expect(getProviderAccountError(error)).toBe(kind);
			const found = detectFinalProviderError([text("user", "go"), text("assistant", error, notice)]);
			expect(found).toEqual({ text: error, notice: true });
			// A QA card on an account the provider refuses gets no replacement on it (qa-gate.ts); a limit is a provider error.
			expect(detectRunError(detailOf([text("user", "go"), text("assistant", error, notice)]))?.kind).toBe(
				kind === "limit" ? "provider_error" : "provider_account",
			);
		}
		expect(getProviderAccountError("You have reached your free limit. Please try again later.")).toBeNull();
		expect(getProviderAccountError("503 Service Unavailable")).toBeNull();
	});

	it("reads when a provider usage limit resets from its own text (issue #49)", () => {
		const SEEN = Date.parse("2026-10-13T16:31:17.000Z");
		const H = 3_600_000;
		const M = 60_000;
		// The text cline-pass-test's QA cards ended on, 2026-10-13.
		const ISSUE_49 =
			"You have reached your 5-hour Clinepass limit. The limit resets in 4h 13m, please try again later.";
		expect(readProviderUsageLimit(ISSUE_49, SEEN)).toEqual({ resetAt: SEEN + 4 * H + 13 * M, text: ISSUE_49 });
		for (const [reset, ms] of [
			["45m", 45 * M],
			["2 hours and 5 minutes", 2 * H + 5 * M],
			["1d 3h", 27 * H],
			["30s", 30_000],
		] as const) {
			const text = `You have reached your weekly ClinePass limit. The limit resets in ${reset}, please try again later.`;
			expect(readProviderUsageLimit(text, SEEN)?.resetAt, reset).toBe(SEEN + ms);
		}
		// A limit that names no reset, or a misread one, keeps the provider-retry path.
		expect(
			readProviderUsageLimit("You have reached your ClinePass limit for this period. Please try again later.", SEEN),
		).toBeNull();
		expect(
			readProviderUsageLimit(
				"You have reached your ClinePass limit. The limit resets in 30d, please try again later.",
				SEEN,
			),
		).toBeNull();
		// Only the provider's usage limit: other texts with "resets in" aren't one.
		expect(readProviderUsageLimit("The connection resets in 5m. Please try again later.", SEEN)).toBeNull();
		expect(readProviderUsageLimit(ISSUE_49, null)).toBeNull();

		// A run that ended on it is a usage limit, counted from the notice's own time, else the session's last write.
		const notice = { displayError: true };
		expect(
			detectRunError(detailOf([text("user", "go"), text("assistant", ISSUE_49, { ...notice, ts: SEEN })])),
		).toEqual({
			kind: "usage_limit",
			text: ISSUE_49,
			resetAt: SEEN + 4 * H + 13 * M,
		});
		expect(detectRunError(detailOf([text("user", "go"), text("assistant", ISSUE_49, notice)]))).toEqual({
			kind: "usage_limit",
			text: ISSUE_49,
			resetAt: 2 + 4 * H + 13 * M,
		});
	});

	it("never reads the reason of a run Kanban ended through the Cline hub as a provider error (issues #28, #32)", () => {
		const notice = { displayError: true };
		// Every reason Kanban sends today, as Cline writes it into the session (verbatim, as an error notice).
		const reasons = [
			KANBAN_CLINE_HUB_ABORT_REASONS.tuiExited(0),
			KANBAN_CLINE_HUB_ABORT_REASONS.tuiExited(null),
			KANBAN_CLINE_HUB_ABORT_REASONS.orphaned,
			KANBAN_CLINE_HUB_ABORT_REASONS.doneOrDeleted,
		];
		expect(reasons).toEqual([
			"Kanban ended this run: its card's Cline TUI exited (code 0)",
			"Kanban ended this run: its card's Cline TUI exited",
			"Kanban ended this run: its card's Cline TUI died with the previous Kanban server",
			"Kanban ended this run: its card is done or deleted",
		]);
		for (const reason of reasons) {
			const messages = [text("user", "REWORK round 2"), text("assistant", reason, notice)];
			expect(detectFinalProviderError(messages)).toBeNull();
			expect(detectRunError(detailOf(messages))).toBeNull();
		}
		// Even one that reads like a provider error: the marker decides.
		expect(
			detectFinalProviderError([text("assistant", "Kanban ended this run: the operation timed out", notice)]),
		).toBeNull();
	});

	it("names the oversized tool call of an overflow (0a3d1fc)", () => {
		expect(findOverflowCulprit([toolResult(2_000), toolResult(250_000, "ls -R"), toolResult(120_000)])).toEqual({
			size: 250_000,
			query: "ls -R",
		});
		expect(findOverflowCulprit([toolResult(50_000)])).toBeNull();
	});
});

describe("detectHungRequest (0261b20)", () => {
	const now = Date.parse("2026-10-07T12:00:00Z");
	const detail = (
		messages: ClineSessionDetailMessage[],
		minutesAgo: number,
		status = "running",
	): ClineSessionDetail => ({
		snapshot: {
			sessionId: "1700_abc",
			status,
			startedAt: now - 3_600_000,
			messagesWrittenAt: now - minutesAgo * 60_000,
			lastMessage: null,
		},
		messages,
		lastWriteAt: now - minutesAgo * 60_000,
	});
	const options = { now, hungMin: 15, hungFirstMin: 30, slowFirstCall: false };

	it("flags a running session that owes a reply and wrote nothing for hungMin", () => {
		expect(detectHungRequest(detail([text("user", "go"), toolCall, toolResult(10)], 16), options)).toMatchObject({
			sessionId: "1700_abc",
			idleMin: 16,
			firstCall: false,
		});
		expect(detectHungRequest(detail([text("user", "go"), toolCall, toolResult(10)], 10), options)).toBeNull();
	});

	it("never flags a long tool run or an ended session", () => {
		expect(detectHungRequest(detail([text("user", "go"), toolCall], 40), options)).toBeNull();
		expect(detectHungRequest(detail([text("user", "go")], 40, "idle"), options)).toBeNull();
	});

	it("gives a slow provider's first call hungFirstMin", () => {
		const first = detail([text("user", "go")], 20);
		expect(detectHungRequest(first, { ...options, slowFirstCall: true })).toBeNull();
		expect(detectHungRequest(first, options)).not.toBeNull();
		expect(detectHungRequest(detail([text("user", "go")], 31), { ...options, slowFirstCall: true })?.firstCall).toBe(
			true,
		);
	});
});

describe("context overflow from a local server (issue #26)", () => {
	const CLINE_OVERFLOW = "Context size has been exceeded.";

	it("reads Cline's and llama.cpp's overflow texts as a poisoned overflow, never as transient", () => {
		for (const error of [
			CLINE_OVERFLOW,
			"the request exceeds the available context size, try increasing it",
			'{"type":"exceed_context_size_error","n_prompt_tokens":70112,"n_ctx":65536}',
		]) {
			expect(isContextOverflowError(error)).toBe(true);
			expect(isPoisonedHistoryError(error)).toBe(true);
			expect(isTransientProviderError(error)).toBe(false);
		}
		expect(isContextOverflowError("I checked the context size setting in the config.")).toBe(false);
	});

	it("calls a QA run that ended on the overflow a context_overflow run error (notes c92da, 9e059)", () => {
		expect(detectFinalProviderError([text("user", "go"), toolCall, text("assistant", CLINE_OVERFLOW)])).toEqual({
			text: CLINE_OVERFLOW,
			notice: false,
		});
		expect(detectRunError(detailOf([text("user", "go"), toolCall, text("assistant", CLINE_OVERFLOW)]))).toEqual({
			kind: "context_overflow",
			text: CLINE_OVERFLOW,
		});
		expect(detectRunError(detailOf([text("assistant", "prompt is too long: 140000 tokens")]))?.kind).toBe(
			"context_overflow",
		);
	});
});
