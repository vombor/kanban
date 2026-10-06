import { describe, expect, it } from "vitest";

import {
	clampTextWithInlineSuffix,
	getTaskPromptDescription,
	normalizePromptForDisplay,
	truncateTaskPromptLabel,
} from "@/utils/task-prompt";

describe("truncateTaskPromptLabel", () => {
	it("normalizes whitespace and truncates when needed", () => {
		expect(truncateTaskPromptLabel("hello\nworld", 20)).toBe("hello world");
		expect(truncateTaskPromptLabel("abcdefghijklmnopqrstuvwxyz", 5)).toBe("abcde…");
	});
});

describe("normalizePromptForDisplay", () => {
	it("collapses whitespace and trims", () => {
		expect(normalizePromptForDisplay("  hello\n\tworld  ")).toBe("hello world");
	});
});

describe("getTaskPromptDescription", () => {
	it("returns the suffix after a leading title", () => {
		expect(getTaskPromptDescription("Fix bugs: update tests", "Fix bugs")).toBe("update tests");
	});

	it("returns empty when prompt equals title", () => {
		expect(getTaskPromptDescription("Fix bugs", "Fix bugs")).toBe("");
	});

	it("strips XML wrapper tags from the prompt before comparing with the title", () => {
		expect(getTaskPromptDescription('<user_input mode="act">Fix the bug</user_input>', "Fix the bug")).toBe("");
	});
});

describe("clampTextWithInlineSuffix", () => {
	it("returns the full text when it fits within the available lines", () => {
		const measured = clampTextWithInlineSuffix("short description", {
			maxWidthPx: 20,
			maxLines: 3,
			suffix: "… See more",
			measureText: (value) => value.length,
		});
		expect(measured).toEqual({
			text: "short description",
			isTruncated: false,
		});
	});

	it("truncates text to leave room for the inline suffix", () => {
		const measured = clampTextWithInlineSuffix(
			"alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron",
			{
				maxWidthPx: 18,
				maxLines: 3,
				suffix: "… See more",
				measureText: (value) => value.length,
			},
		);
		expect(measured).toEqual({
			text: "alpha beta gamma delta epsilon zeta",
			isTruncated: true,
		});
	});
});

// The pre-optimization algorithm (wrap the whole text, binary-search the whole length), kept as a
// reference: the bounded version must produce the same result while measuring far less text.
function referenceWrap(text: string, maxWidth: number, measure: (value: string) => number): string[] {
	const normalized = normalizePromptForDisplay(text);
	const lines: string[] = [];
	let start = 0;
	while (start < normalized.length) {
		let low = start + 1;
		let high = normalized.length;
		let fit = start + 1;
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			if (measure(normalized.slice(start, middle)) <= maxWidth) {
				fit = middle;
				low = middle + 1;
			} else {
				high = middle - 1;
			}
		}
		let end = fit;
		if (end < normalized.length) {
			const lastSpace = normalized.lastIndexOf(" ", end - 1);
			if (lastSpace >= start) {
				end = lastSpace;
			}
		}
		const line = normalized.slice(start, end).trim();
		if (!line) {
			start += 1;
			continue;
		}
		lines.push(line);
		start = end;
		while (normalized[start] === " ") {
			start += 1;
		}
	}
	return lines;
}

function referenceClamp(
	text: string,
	maxWidth: number,
	maxLines: number,
	suffix: string,
	measure: (v: string) => number,
) {
	const normalized = normalizePromptForDisplay(text);
	if (referenceWrap(normalized, maxWidth, measure).length <= maxLines) {
		return { text: normalized, isTruncated: false };
	}
	let low = 0;
	let high = normalized.length;
	let best = 0;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		if (referenceWrap(`${normalized.slice(0, middle).trimEnd()}${suffix}`, maxWidth, measure).length <= maxLines) {
			best = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	let truncated = normalized.slice(0, best).trimEnd();
	if (best < normalized.length && normalized[best] !== " ") {
		const lastSpace = truncated.lastIndexOf(" ");
		if (lastSpace > 0) {
			truncated = truncated.slice(0, lastSpace).trimEnd();
		}
	}
	return { text: truncated, isTruncated: true };
}

describe("clampTextWithInlineSuffix performance bounds", () => {
	const proportional = (value: string) => {
		let width = 0;
		for (const char of value) {
			width += char === "m" || char === "w" ? 12 : char === "i" || char === "l" || char === " " ? 4 : 8;
		}
		return width;
	};
	const words = [
		"alpha",
		"beta",
		"mm",
		"iii",
		"gamma-delta",
		"w",
		"lorem",
		"ipsum",
		"dolor",
		"sit",
		"amet",
		"consectetur",
	];
	const makeText = (count: number, seed: number) =>
		Array.from({ length: count }, (_, index) => words[(index * 7 + seed) % words.length]).join(" ");

	it("matches the unbounded reference algorithm", () => {
		for (const seed of [1, 2, 3]) {
			for (const length of [5, 40, 400]) {
				for (const width of [60, 180, 240]) {
					for (const maxLines of [1, 3, 10]) {
						const text = makeText(length, seed);
						const options = { maxWidthPx: width, maxLines, suffix: "… See more", measureText: proportional };
						expect(clampTextWithInlineSuffix(text, options)).toEqual(
							referenceClamp(text, width, maxLines, "… See more", proportional),
						);
					}
				}
			}
		}
	});

	it("only measures text near the visible lines of a long prompt", () => {
		let measuredChars = 0;
		const counting = (value: string) => {
			measuredChars += value.length;
			return proportional(value);
		};
		const text = makeText(1200, 5); // about 7 KB, like a long QA prompt
		const result = clampTextWithInlineSuffix(text, {
			maxWidthPx: 240,
			maxLines: 3,
			suffix: "… See more",
			measureText: counting,
		});
		expect(result.isTruncated).toBe(true);
		// The unbounded algorithm measured millions of characters here.
		expect(measuredChars).toBeLessThan(20_000);
	});

	it("memoizes results per cache key", () => {
		let calls = 0;
		const counting = (value: string) => {
			calls += 1;
			return proportional(value);
		};
		const text = makeText(300, 9);
		const options = {
			maxWidthPx: 200,
			maxLines: 3,
			suffix: "… See more",
			measureText: counting,
			cacheKey: "test-font-a",
		};
		const first = clampTextWithInlineSuffix(text, options);
		const callsAfterFirst = calls;
		expect(clampTextWithInlineSuffix(text, options)).toEqual(first);
		expect(calls).toBe(callsAfterFirst);
		clampTextWithInlineSuffix(text, { ...options, maxWidthPx: 150 });
		expect(calls).toBeGreaterThan(callsAfterFirst);
	});
});
