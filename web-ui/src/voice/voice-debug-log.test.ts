import { beforeEach, describe, expect, it } from "vitest";

import {
	clearVoiceDebugLog,
	formatVoiceDebugEntry,
	getVoiceDebugEntries,
	logVoiceEvent,
	readVoiceDebugQuery,
	subscribeVoiceDebugLog,
	VOICE_DEBUG_LOG_LIMIT,
} from "@/voice/voice-debug-log";

describe("voice debug log", () => {
	beforeEach(() => {
		clearVoiceDebugLog();
	});

	it("starts with the page's environment, then keeps the newest entries only", () => {
		logVoiceEvent("start()", null, 1);
		expect(getVoiceDebugEntries()[0]?.event).toBe("page");
		expect(getVoiceDebugEntries()[0]?.detail).toMatch(/^browser tab; lang /);
		for (let index = 0; index < VOICE_DEBUG_LOG_LIMIT + 10; index += 1) {
			logVoiceEvent("result", String(index), 1);
		}
		const entries = getVoiceDebugEntries();
		expect(entries).toHaveLength(VOICE_DEBUG_LOG_LIMIT);
		expect(entries.at(-1)?.detail).toBe(String(VOICE_DEBUG_LOG_LIMIT + 9));
	});

	it("clips long details to one line and formats entries with UTC time and session", () => {
		logVoiceEvent("result", `a\n${"b".repeat(200)}`, 3);
		const entry = getVoiceDebugEntries().at(-1);
		expect(entry?.detail?.startsWith("a b")).toBe(true);
		expect(entry?.detail?.endsWith("…")).toBe(true);
		if (!entry) {
			throw new Error("no entry");
		}
		expect(formatVoiceDebugEntry({ ...entry, at: Date.UTC(2026, 9, 12, 7, 5, 9, 42), detail: "x" })).toBe(
			"07:05:09.042Z #3 result x",
		);
	});

	it("tells subscribers about new entries", () => {
		let calls = 0;
		const unsubscribe = subscribeVoiceDebugLog(() => {
			calls += 1;
		});
		logVoiceEvent("end", null, 1);
		unsubscribe();
		logVoiceEvent("end", null, 1);
		expect(calls).toBe(1);
	});

	it("reads ?voiceDebug=1 and ?voiceDebug=0", () => {
		expect(readVoiceDebugQuery("?voiceDebug=1")).toBe(true);
		expect(readVoiceDebugQuery("?a=b&voiceDebug=0")).toBe(false);
		expect(readVoiceDebugQuery("?voiceDebug=false")).toBe(false);
		expect(readVoiceDebugQuery("")).toBeNull();
	});
});
