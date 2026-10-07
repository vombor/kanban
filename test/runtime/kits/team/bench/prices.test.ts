import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	createPriceTable,
	getSeedPriceTableFile,
	loadPriceTable,
	turnCost,
} from "../../../../../src/kits/team/bench/prices";
import { withTemporaryKanbanHome } from "../../../../utilities/kanban-home";
import { createTempDir } from "../../../../utilities/temp-dir";

describe("price table", () => {
	it("ships a seed that parses and prices the team kit's models", () => {
		const seed = createPriceTable(getSeedPriceTableFile(), "seed");
		expect(seed.priceFor("us.anthropic.claude-haiku-4-5-20251001-v1:0")?.pattern).toBe("claude-haiku-4-5");
		// Specific patterns come first: a global.* profile gets the global entry.
		expect(seed.priceFor("global.anthropic.claude-opus-5-5")?.tier).toBe("global");
		expect(seed.priceFor("us.anthropic.claude-opus-5-5")?.tier).toBe("standard");
		expect(seed.priceFor("not-a-model")).toBeNull();
	});

	it("prices cache reads and writes apart from plain input, and long-context turns at the long rate", () => {
		const entry = { pattern: "x", in: 1, cacheRead: 0.1, cacheWrite: 2, out: 10 };
		// 600 plain + 300 read + 100 written input, 50 output.
		expect(turnCost(entry, { input: 1000, cacheRead: 300, cacheWrite: 100, output: 50 })).toBeCloseTo(
			(600 * 1 + 300 * 0.1 + 100 * 2 + 50 * 10) / 1e6,
		);
		const long = { ...entry, longOver: 500, long: { in: 5, cacheRead: 5, cacheWrite: 5, out: 5 } };
		expect(turnCost(long, { input: 501, cacheRead: 0, cacheWrite: 0, output: 1 })).toBeCloseTo((501 * 5 + 5) / 1e6);
		expect(turnCost(long, { input: 500, cacheRead: 0, cacheWrite: 0, output: 1 })).toBeCloseTo((500 + 10) / 1e6);
	});

	it("reads the home's table first, then the legacy kit's, then the seed; an invalid file is skipped", async () => {
		const dir = createTempDir("prices-");
		try {
			const own = join(dir.path, "own.json");
			const legacy = join(dir.path, "legacy.json");
			writeFileSync(
				legacy,
				JSON.stringify({ prices: [{ pattern: "legacy", in: 1, cacheRead: 1, cacheWrite: 1, out: 1 }] }),
			);
			expect((await loadPriceTable([own, legacy])).source).toBe(legacy);
			writeFileSync(own, JSON.stringify({ prices: [{ pattern: "own" }] })); // invalid: no rates
			expect((await loadPriceTable([own, legacy])).source).toBe(legacy);
			writeFileSync(
				own,
				JSON.stringify({ prices: [{ pattern: "own", in: 1, cacheRead: 1, cacheWrite: 1, out: 1 }] }),
			);
			expect((await loadPriceTable([own, legacy])).priceFor("own-model")?.pattern).toBe("own");
			expect((await loadPriceTable([join(dir.path, "missing.json")])).source).toBe("seed");
		} finally {
			dir.cleanup();
		}
	});

	it("resolves its default candidates inside the Kanban home", async () => {
		await withTemporaryKanbanHome(async (home) => {
			const pricesDir = join(home.homePath, "data", "prices");
			mkdirSync(pricesDir, { recursive: true });
			writeFileSync(
				join(pricesDir, "prices.json"),
				JSON.stringify({ prices: [{ pattern: "home", in: 1, cacheRead: 1, cacheWrite: 1, out: 1 }] }),
			);
			expect((await loadPriceTable()).source).toBe(join(pricesDir, "prices.json"));
		});
	});
});
