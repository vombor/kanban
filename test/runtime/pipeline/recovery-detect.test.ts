import { describe, expect, it } from "vitest";

import {
	detectFinalProviderError,
	detectHungRequest,
	detectPrematureStop,
	detectRunError,
	findOverflowCulprit,
	isContextOverflowError,
	isPoisonedHistoryError,
	isTransientProviderError,
} from "../../../src/pipeline/recovery-detect";
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
		expect(detectFinalProviderError([text("assistant", "The operation timed out.")])).toBe(
			"The operation timed out.",
		);
		expect(detectFinalProviderError([text("assistant", "Done. STATUS: DONE")])).toBeNull();
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
