import { describe, expect, it } from "vitest";

import { formatTokenCount } from "@/utils/format-token-count";

describe("formatTokenCount", () => {
	it("keeps small counts as they are", () => {
		expect(formatTokenCount(0)).toBe("0");
		expect(formatTokenCount(950)).toBe("950");
		expect(formatTokenCount(999)).toBe("999");
	});

	it("shortens to k, M and B with one decimal below 100", () => {
		expect(formatTokenCount(1_000)).toBe("1k");
		expect(formatTokenCount(12_345)).toBe("12.3k");
		expect(formatTokenCount(123_456)).toBe("123k");
		expect(formatTokenCount(4_120_000)).toBe("4.1M");
		expect(formatTokenCount(2_500_000_000)).toBe("2.5B");
	});

	it("moves a count that rounds up to 1000 into the next unit", () => {
		expect(formatTokenCount(999_960)).toBe("1M");
		expect(formatTokenCount(999_999_999)).toBe("1B");
	});
});
