import { describe, expect, it } from "vitest";

import { toSpeakableText } from "@/voice/speakable-text";

describe("toSpeakableText", () => {
	it("leaves plain prose alone", () => {
		expect(toSpeakableText("All tests pass. Should I commit?")).toBe("All tests pass. Should I commit?");
	});

	it("drops fenced code blocks, also when hook ingest joined them into one line", () => {
		expect(toSpeakableText("Run this: ```bash npm test ``` and tell me.")).toBe(
			"Run this: (code block) and tell me.",
		);
		expect(toSpeakableText("Here:\n```ts\nconst a = 1;\n```\nDone.")).toBe("Here: (code block) Done.");
		expect(toSpeakableText("Cut off: ```ts const a")).toBe("Cut off: (code block)");
	});

	it("keeps the text of inline code, links and emphasis, and drops URLs", () => {
		expect(
			toSpeakableText(
				"Fixed `parseConfig` in **src/config.ts**, see [the issue](https://github.com/x/y/issues/1) and https://example.com/a.",
			),
		).toBe("Fixed parseConfig in src/config.ts, see the issue and link");
	});

	it("drops headings, quotes and bullets", () => {
		expect(toSpeakableText("## Summary - first thing * second thing > quoted")).toBe(
			"Summary - first thing second thing quoted",
		);
		expect(toSpeakableText("- one\n- two")).toBe("one - two");
	});

	it("reads a table's cells, not its pipes", () => {
		expect(toSpeakableText("| File | Status | |---|---| | a.ts | done |")).toBe("File, Status, a.ts, done");
	});

	it("cuts a long reply at a sentence and says where the rest is", () => {
		const reply = `${"This sentence is long enough. ".repeat(10)}End.`;
		const spoken = toSpeakableText(reply, 100);
		expect(spoken.endsWith("enough. The rest is in the terminal.")).toBe(true);
		expect(spoken.length).toBeLessThan(140);
	});
});
