import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	readProjectProviderConcurrency,
	readProviderConcurrency,
	setProviderConcurrency,
} from "../../../src/config/provider-concurrency-setting";
import { getDispatchProvider } from "../../../src/core/dispatch-provider";
import { mergeProviderConcurrency } from "../../../src/core/provider-concurrency";
import { createTempDir } from "../../utilities/temp-dir";

describe("opt-in restrictive provider pacing", () => {
	it("does not let an opaque agent evade its pool using an ignored provider flag", () => {
		expect(getDispatchProvider("claude", { providerId: "fake-uncapped" })).toBe("agent:claude");
		expect(getDispatchProvider("cline", { providerId: "cline-pass" })).toBe("cline-pass");
		expect(getDispatchProvider("cline", {})).toBeNull();
	});
	const temp = createTempDir("provider-concurrency-");
	afterAll(() => temp.cleanup());
	it("sets/unsets only the user-owned map, preserving unrelated settings", async () => {
		const path = join(temp.path, "config.json");
		writeFileSync(
			path,
			JSON.stringify({
				home: 1,
				workspaces: { foo: { providerConcurrency: { "cline-pass": 1 }, kit: { name: "team" } } },
				providerConcurrency: { "cline-pass": 4 },
			}),
		);
		await setProviderConcurrency("cline-pass", 2, path);
		expect(await readProviderConcurrency(path)).toEqual({ "cline-pass": 2 });
		const project = await readProjectProviderConcurrency(["foo"], path);
		expect(mergeProviderConcurrency([await readProviderConcurrency(path), ...project])).toEqual({ "cline-pass": 1 });
		await setProviderConcurrency("cline-pass", null, path);
		expect((JSON.parse(readFileSync(path, "utf8")) as { workspaces: unknown }).workspaces).toMatchObject({
			foo: { kit: { name: "team" }, providerConcurrency: { "cline-pass": 1 } },
		});
	});
	it("refuses invalid limits and damaged config instead of launching with an unlimited fallback", async () => {
		const path = join(temp.path, "invalid.json");
		writeFileSync(path, "{truncated");
		await expect(readProviderConcurrency(path)).rejects.toThrow("unreadable");
		await expect(setProviderConcurrency("cline-pass", 1, path)).rejects.toThrow("unreadable");
		expect(readFileSync(path, "utf8")).toBe("{truncated");
		writeFileSync(path, JSON.stringify({ providerConcurrency: { "cline-pass": 0 } }));
		await expect(readProviderConcurrency(path)).rejects.toThrow("invalid");
		for (const value of [0, -1, 1.1, NaN, 1025])
			await expect(setProviderConcurrency("cline-pass", value, path)).rejects.toThrow();
	});
});
