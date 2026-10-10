import { describe, expect, it } from "vitest";

import {
	CLINE_TURN_END_BOUNCE_QUIET_MS,
	CLINE_TURN_END_QUIET_MS,
	CLINE_TURN_END_REJECTED_QUIET_MS,
	type ClineSessionMessage,
	type ClineSessionSnapshot,
	type ClineTurnEndInput,
	evaluateClineTurnEnd,
	getClineImageRejection,
	getClineProviderErrorText,
	hasClineStatusLine,
	isClineNoImagesRejection,
	parseClineQaFinalLine,
	parseClineStatusLine,
} from "../../../src/terminal/cline-turn-outcome";

const NOW = 1_800_000_000_000;
const RUNNING_SINCE = NOW - 600_000;

function reply(text: string): ClineSessionMessage {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function session(overrides: Partial<ClineSessionSnapshot> = {}): ClineSessionSnapshot {
	return {
		sessionId: "1791335760135_38ara",
		status: "idle",
		startedAt: RUNNING_SINCE,
		messagesWrittenAt: NOW - CLINE_TURN_END_QUIET_MS,
		lastMessage: reply("Implemented the change.\n\nSTATUS: DONE"),
		...overrides,
	};
}

function evaluate(sessionOverrides: Partial<ClineSessionSnapshot> = {}, input: Partial<ClineTurnEndInput> = {}) {
	return evaluateClineTurnEnd({ session: session(sessionOverrides), runningSince: RUNNING_SINCE, now: NOW, ...input });
}

describe("parseClineStatusLine (ported from cline-hooks.test.cjs)", () => {
	it("reads the kind and detail from the last line", () => {
		expect(parseClineStatusLine("Done.\n\nSTATUS: BLOCKED: no write access to /etc")).toEqual({
			kind: "BLOCKED",
			detail: "no write access to /etc",
		});
		expect(parseClineStatusLine("**STATUS: DONE**")).toEqual({ kind: "DONE", detail: "" });
		expect(parseClineStatusLine("`STATUS: NEEDS_INPUT: which currency?`")).toEqual({
			kind: "NEEDS_INPUT",
			detail: "which currency?",
		});
	});

	it("only counts the last line, but also inline at the end of the last paragraph", () => {
		expect(parseClineStatusLine("STATUS: DONE\nmore text")).toBeNull();
		expect(parseClineStatusLine("The rest was left untouched. STATUS: DONE")).toEqual({ kind: "DONE", detail: "" });
		expect(parseClineStatusLine("All good.")).toBeNull();
	});
});

describe("reply classifiers", () => {
	it("finds a STATUS line at any line start or closing the reply inline (e527b)", () => {
		expect(hasClineStatusLine("STATUS: DONE\n\nNotes follow.")).toBe(true);
		expect(hasClineStatusLine("... left untouched. STATUS: DONE")).toBe(true);
		expect(hasClineStatusLine("I will now run the tests.")).toBe(false);
	});

	it("reads the QA reviewer's final line", () => {
		expect(
			parseClineQaFinalLine("Checked.\n\nQA 6e179 round 1: PASS, report in /tmp/qa-out/d70ca/verdict.json"),
		).toBe("PASS");
		expect(parseClineQaFinalLine("QA 6e179 round 2: STALLED, report in x")).toBe("STALLED");
		expect(parseClineQaFinalLine("QA notes: everything passes")).toBeNull();
	});

	it("recognizes no-images rejections and bare provider errors", () => {
		expect(isClineNoImagesRejection("This model does not support image input.")).toBe(true);
		expect(getClineImageRejection("This model does not support image input.")).toBe("unsupported");
		expect(getClineProviderErrorText("The operation timed out.")).toBe("The operation timed out.");
		expect(getClineProviderErrorText("The operation timed out. ".repeat(20))).toBeNull();
		expect(getClineProviderErrorText("Everything fine.")).toBeNull();
		// issue #26: llama.cpp's exceed_context_size_error as Cline shows it.
		expect(getClineProviderErrorText("Context size has been exceeded.")).toBe("Context size has been exceeded.");
	});
});

describe("evaluateClineTurnEnd", () => {
	it("ends an idle session after a final reply with a STATUS line and 20 s quiet (17ac0070, ebe38)", () => {
		expect(evaluate()).toMatchObject({
			ended: true,
			reason: "status_line",
			afterBounce: false,
			statusLine: { kind: "DONE", detail: "" },
			replyAt: NOW - CLINE_TURN_END_QUIET_MS,
		});
	});

	it("waits for 20 s with nothing written", () => {
		expect(evaluate({ messagesWrittenAt: NOW - CLINE_TURN_END_QUIET_MS + 1 })).toEqual({
			ended: false,
			reason: "not_quiet",
		});
	});

	it("needs a final reply: no tool call, written by the assistant", () => {
		expect(
			evaluate({
				lastMessage: {
					role: "assistant",
					content: [{ type: "text", text: "STATUS: DONE" }, { type: "tool_use" }],
				},
			}),
		).toEqual({ ended: false, reason: "no_final_reply" });
		expect(evaluate({ lastMessage: { role: "user", content: "rework round 2" } })).toEqual({
			ended: false,
			reason: "no_final_reply",
		});
		expect(evaluate({ lastMessage: null })).toEqual({ ended: false, reason: "no_final_reply" });
		expect(evaluateClineTurnEnd({ session: null, runningSince: RUNNING_SINCE, now: NOW })).toEqual({
			ended: false,
			reason: "no_session",
		});
	});

	it("accepts string message content", () => {
		expect(evaluate({ lastMessage: { role: "assistant", content: "Done.\nSTATUS: DONE" } }).ended).toBe(true);
	});

	it("does not end a dev turn that stops on an announcement without a STATUS line (9496770)", () => {
		expect(evaluate({ lastMessage: reply("Now I'll run the test suite.") })).toEqual({
			ended: false,
			reason: "no_status_line",
		});
	});

	it("counts any idle final reply with requireStatus false, for the bounce check (e3ab46fc, f496b)", () => {
		expect(evaluate({ lastMessage: reply("All finished.") }, { requireStatus: false })).toMatchObject({
			ended: true,
			reason: "final_reply",
			statusLine: null,
		});
	});

	it("ends a QA turn on its final line without a STATUS line (67a0c447)", () => {
		expect(
			evaluate({ lastMessage: reply("QA 6e179 round 1: PASS, report in /tmp/qa-out/d70ca/verdict.json") }),
		).toMatchObject({ ended: true, reason: "qa_final_line", statusLine: null });
	});

	it("does not end a turn while the session file says running", () => {
		expect(evaluate({ status: "running" })).toEqual({ ended: false, reason: "session_running" });
		expect(evaluate({ status: "completed" })).toEqual({ ended: false, reason: "session_running" });
	});

	it("ends a session left running on a no-images rejection after 2 min (922b5b8c, a2cbb)", () => {
		const rejected = { status: "running", lastMessage: reply("The model does not support image input.") };
		expect(evaluate({ ...rejected, messagesWrittenAt: NOW - CLINE_TURN_END_QUIET_MS })).toEqual({
			ended: false,
			reason: "not_quiet",
		});
		expect(evaluate({ ...rejected, messagesWrittenAt: NOW - CLINE_TURN_END_REJECTED_QUIET_MS })).toMatchObject({
			ended: true,
			reason: "no_images",
		});
	});

	it("ends a turn whose final reply is a bare provider error after 2 min (0bc63878, a2cbb)", () => {
		expect(
			evaluate({
				lastMessage: reply("The operation timed out."),
				messagesWrittenAt: NOW - CLINE_TURN_END_REJECTED_QUIET_MS,
			}),
		).toMatchObject({ ended: true, reason: "provider_error" });
	});

	it("waits after a switch back to running that no message followed, then ends the turn (9675b6ff, 10a60)", () => {
		const replyAt = NOW - 400_000;
		const bouncedAt = NOW - CLINE_TURN_END_BOUNCE_QUIET_MS + 1;
		expect(evaluate({ messagesWrittenAt: replyAt }, { runningSince: bouncedAt })).toEqual({
			ended: false,
			reason: "reply_before_running",
		});
		expect(
			evaluate({ messagesWrittenAt: replyAt }, { runningSince: NOW - CLINE_TURN_END_BOUNCE_QUIET_MS }),
		).toMatchObject({ ended: true, afterBounce: true, replyAt });
	});

	it("does not end a rework typed seconds ago that Cline hasn't written yet", () => {
		expect(evaluate({}, { runningSince: NOW - 3_000 })).toEqual({ ended: false, reason: "reply_before_running" });
	});
});

describe("image size rejections (issue #12)", () => {
	it("counts request-size image errors of Anthropic/Bedrock and OpenAI-compatible providers as image rejections", () => {
		for (const text of [
			"messages.1.content.86.image.source.base64.data: At least one of the image dimensions exceed max allowed size: 8000 pixels",
			"messages.3.content.2.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels",
			"messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 5316852 bytes > 5242880 bytes",
			"Invalid request: image is too large",
			"The image size exceeds the limit",
		]) {
			expect(getClineImageRejection(text), text).toBe("too_large");
			expect(isClineNoImagesRejection(text), text).toBe(true);
		}
	});

	it("leaves replies that only talk about images alone", () => {
		expect(getClineImageRejection("The hero image looks right on mobile; STATUS: DONE")).toBeNull();
		expect(getClineImageRejection("I resized the image to fit the card.")).toBeNull();
	});
});
