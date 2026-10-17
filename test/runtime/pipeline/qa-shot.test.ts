import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type QaShotDependencies, type QaShotOptions, runQaShot } from "../../../src/pipeline/qa-shot";
import { parseQaShotScript } from "../../../src/pipeline/qa-shot-script";
import { createTempDir } from "../../utilities/temp-dir";

describe("scripted QA screenshots (#58)", () => {
	let temp: ReturnType<typeof createTempDir>;
	beforeEach(() => {
		temp = createTempDir("qa-shot-");
	});
	afterEach(() => temp.cleanup());
	function harness(script: unknown, viewports = ["mobile", "desktop"]) {
		const path = join(temp.path, "flow.json");
		writeFileSync(path, JSON.stringify(script));
		const sizes: Array<{ width: number; height: number }> = [];
		const wait = vi.fn(async () => undefined);
		type Browser = Awaited<ReturnType<NonNullable<QaShotDependencies["openBrowser"]>>>;
		type Context = Awaited<ReturnType<Browser["newContext"]>>;
		type Page = Awaited<ReturnType<Context["newPage"]>>;
		type Locator = ReturnType<Page["getByText"]>;
		const locator: Locator = { first: () => locator, waitFor: wait, getByText: () => locator };
		const text = vi.fn(() => locator);
		const scoped = vi.fn(() => ({ ...locator, getByText: text }));
		const globalText = vi.fn(() => locator);
		const close = vi.fn(async () => undefined);
		const browserClose = vi.fn(async () => undefined);
		const options: QaShotOptions = {
			base: "http://example.test",
			out: temp.path,
			scratch: temp.path,
			routes: [],
			viewports,
			waitFor: null,
			fullPage: false,
			scripts: [path],
			chromiumLibs: null,
		};
		const openBrowser = vi.fn<NonNullable<QaShotDependencies["openBrowser"]>>(async () => ({
			close: browserClose,
			newContext: async ({ viewport }) => {
				sizes.push(viewport);
				return {
					close,
					newPage: async () => ({
						on: vi.fn(),
						goto: async () => ({
							status: () => 200,
							request: () => ({ method: () => "GET", url: () => options.base, failure: () => null }),
						}),
						waitForSelector: vi.fn(async () => undefined),
						title: async () => "QA test",
						url: () => options.base,
						evaluate: async <T>() => [] as T,
						screenshot: async ({ path: file }) => {
							writeFileSync(file, "fake screenshot");
						},
						fill: vi.fn(async () => undefined),
						click: vi.fn(async () => undefined),
						press: vi.fn(async () => undefined),
						selectOption: vi.fn(async () => []),
						waitForTimeout: vi.fn(async () => undefined),
						getByText: globalText,
						locator: scoped,
					}),
				};
			},
		}));
		return { options, openBrowser, sizes, text, scoped, globalText, close, browserClose };
	}

	it("runs an array's complete journey at each CLI viewport without overwriting mobile evidence", async () => {
		const test = harness([
			{ type: "goto", url: "/" },
			{ type: "fill", selector: "#title", value: "Saved" },
			{ type: "click", selector: "button" },
			{ type: "expectText", selector: "main", text: "Saved" },
			{ type: "screenshot", path: "result.png" },
		]);
		expect(await runQaShot(test.options, { openBrowser: test.openBrowser })).toMatchObject({ exitCode: 0 });
		expect(test.sizes).toEqual([
			{ width: 375, height: 667 },
			{ width: 1280, height: 720 },
		]);
		const report = JSON.parse(readFileSync(join(temp.path, "report.json"), "utf8")) as {
			pages: unknown[];
			artifacts: string[];
		};
		expect(report.pages).toMatchObject([
			{ viewport: "mobile", viewportSize: { width: 375, height: 667 } },
			{ viewport: "desktop", viewportSize: { width: 1280, height: 720 } },
		]);
		expect(report.artifacts).toEqual([
			join(temp.path, "report.txt"),
			join(temp.path, "result-mobile.png"),
			join(temp.path, "result-desktop.png"),
		]);
		expect(test.scoped).toHaveBeenCalledWith("main");
		expect(test.globalText).not.toHaveBeenCalled();
		expect(test.close).toHaveBeenCalledTimes(2);
		expect(test.browserClose).toHaveBeenCalledOnce();
		expect(readFileSync(join(temp.path, "report.txt"), "utf8")).toContain("Viewport: 375x667");
	});

	it("honors an explicit envelope viewport and runs an unpinned envelope at every CLI size", async () => {
		const test = harness({ viewport: "800x600", steps: [{ type: "screenshot", path: "one.png" }] });
		await runQaShot(test.options, { openBrowser: test.openBrowser });
		expect(test.sizes).toEqual([{ width: 800, height: 600 }]);
		expect(readFileSync(join(temp.path, "one.png"), "utf8")).toBe("fake screenshot");
		expect(parseQaShotScript({ steps: [{ type: "goto" }] }, ["mobile", "desktop"]).viewports).toEqual([
			"mobile",
			"desktop",
		]);
	});

	it.each([
		[{ goto: "/" }],
		[{ type: "click" }],
		[{ type: "screenshot", name: "ignored.png" }],
		[{ type: "expectText", text: "" }],
		[{ type: "wait", ms: -1 }],
		{ steps: [] },
		{ viewport: "0x667", steps: [{ type: "goto" }] },
	])("validates malformed script %j before any browser connection", async (script) => {
		const test = harness(script);
		expect(await runQaShot(test.options, { openBrowser: test.openBrowser })).toMatchObject({
			exitCode: 2,
			message: expect.stringContaining("invalid input"),
		});
		expect(test.openBrowser).not.toHaveBeenCalled();
	});

	it("rejects an invalid CLI viewport before opening a browser, even for route-only captures", async () => {
		const test = harness([{ type: "goto" }], ["moblie"]);
		expect(
			await runQaShot({ ...test.options, scripts: [], routes: ["/"] }, { openBrowser: test.openBrowser }),
		).toMatchObject({ exitCode: 2 });
		expect(test.openBrowser).not.toHaveBeenCalled();
	});
});
