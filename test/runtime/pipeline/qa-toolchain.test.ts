import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP: mocks.connect } }));

import { getQaToolchainInfo, verifyQaToolchain } from "../../../src/pipeline/qa-toolchain";

describe("packaged shared QA tooling (#57)", () => {
	afterEach(() => {
		mocks.connect.mockReset();
		vi.unstubAllEnvs();
	});
	it("resolves pinned explicit modules rather than a worktree/global guess", () => {
		vi.stubEnv("PLAYWRIGHT_CDP_URL", "http://127.0.0.1:9222");
		const info = getQaToolchainInfo();
		expect(info.playwrightVersion).toBe("1.63.0");
		expect(info.pngVersion).toBe("7.0.0");
		expect(info.playwrightModule).toContain("playwright-core");
		expect(info.pngModule).toContain("pngjs");
	});
	it("drives only new owned contexts at both sizes and verifies actual RGBA pixels", async () => {
		const sizes: Array<{ width: number; height: number }> = [];
		const close = vi.fn(async () => undefined);
		const disconnect = vi.fn(async () => undefined);
		mocks.connect.mockResolvedValue({
			close: disconnect,
			newContext: async ({ viewport }: { viewport: { width: number; height: number } }) => {
				sizes.push(viewport);
				return {
					close,
					newPage: async () => ({
						setContent: vi.fn(async () => undefined),
						fill: vi.fn(async () => undefined),
						click: vi.fn(async () => undefined),
						locator: () => ({
							textContent: async () => "QA readiness",
							inputValue: async () => "first line\nsecond line",
							boundingBox: async () => ({ x: 0, y: 0, width: 200, height: 40 }),
							screenshot: async () => {
								const png = new PNG({ width: 200, height: 40 });
								png.data.fill(255);
								for (let index = 40; index < 200; index += 1) {
									png.data[index * 4] = 0;
									png.data[index * 4 + 1] = 0;
									png.data[index * 4 + 2] = 0;
								}
								return PNG.sync.write(png);
							},
						}),
						screenshot: async () => {
							const png = new PNG(viewport);
							for (let index = 0; index < png.data.length; index += 4) {
								png.data[index] = 38;
								png.data[index + 1] = 122;
								png.data[index + 2] = 69;
								png.data[index + 3] = 255;
							}
							return PNG.sync.write(png);
						},
					}),
				};
			},
		});
		expect(await verifyQaToolchain()).toMatchObject({
			ready: true,
			checks: [
				{ width: 375, height: 667, decoded: true, glyphs: true, multiline: true },
				{ width: 1280, height: 720, decoded: true, glyphs: true, multiline: true },
			],
		});
		expect(sizes).toHaveLength(2);
		expect(close).toHaveBeenCalledTimes(2);
		expect(disconnect).toHaveBeenCalledOnce();
	});
	it("fails precisely without suggesting package/browser installation and never leaks credential endpoints", async () => {
		mocks.connect.mockRejectedValue(new Error("untrusted driver diagnostic"));
		await expect(verifyQaToolchain()).rejects.toThrow("Shared Chrome CDP is unavailable");
		vi.stubEnv("PLAYWRIGHT_CDP_URL", "http://user:private-password@host:9222");
		expect(() => getQaToolchainInfo()).toThrow("without credentials");
	});
});
