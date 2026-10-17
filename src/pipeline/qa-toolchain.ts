// Packaged, pinned QA tooling: no per-worktree npm installs and no browser downloads/launches.
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { type Browser, chromium } from "playwright-core";
import { PNG } from "pngjs";
import { z } from "zod";

export function getQaToolchainInfo() {
	const require = createRequire(import.meta.url);
	const endpoint = new URL(process.env.PLAYWRIGHT_CDP_URL || "http://127.0.0.1:9222");
	if (
		!["http:", "https:", "ws:", "wss:"].includes(endpoint.protocol) ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash
	)
		throw new Error("Use an HTTP(S)/WS(S) shared Chrome endpoint without credentials, query or fragment");
	const metadata = z.object({ version: z.string() });
	return {
		playwrightVersion: metadata.parse(require("playwright-core/package.json")).version,
		pngVersion: metadata.parse(require("pngjs/package.json")).version,
		playwrightModule: require.resolve("playwright-core"),
		playwrightDirectory: dirname(require.resolve("playwright-core/package.json")),
		pngModule: require.resolve("pngjs"),
		cdpUrl: endpoint.toString().replace(/\/$/u, ""),
	};
}

export async function connectQaBrowser(): Promise<Browser> {
	try {
		return await chromium.connectOverCDP(getQaToolchainInfo().cdpUrl, { isLocal: false, timeout: 15_000 });
	} catch {
		throw new Error(
			"Shared Chrome CDP is unavailable. Start the configured Chrome sidecar or set PLAYWRIGHT_CDP_URL; run kanban qa tools --verify. Do not install or launch another browser.",
		);
	}
}

/** Readiness means actual normal-input journeys and decoded raster evidence in isolated owned contexts. */
export async function verifyQaToolchain() {
	const browser = await connectQaBrowser();
	const checks: Array<{ width: number; height: number; journey: boolean; decoded: boolean }> = [];
	try {
		for (const viewport of [
			{ width: 375, height: 667 },
			{ width: 1280, height: 720 },
		]) {
			const context = await browser.newContext({ viewport });
			try {
				const page = await context.newPage();
				await page.setContent(
					'<!doctype html><style>body{background:#267a45}</style><input id="value"><button onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#value\').value">Save</button><p id="result"></p>',
				);
				await page.fill("#value", "QA readiness");
				await page.click("button");
				if ((await page.locator("#result").textContent()) !== "QA readiness")
					throw new Error("QA toolchain input journey failed");
				const png = PNG.sync.read(await page.screenshot());
				if (
					png.width !== viewport.width ||
					png.height !== viewport.height ||
					png.data.length !== png.width * png.height * 4
				)
					throw new Error("QA toolchain raster verification failed");
				const offset = ((png.height - 1) * png.width + png.width - 1) * 4;
				if (
					png.data[offset] !== 38 ||
					png.data[offset + 1] !== 122 ||
					png.data[offset + 2] !== 69 ||
					png.data[offset + 3] !== 255
				)
					throw new Error("QA toolchain decoded pixels do not match the rendered readiness fixture");
				checks.push({ ...viewport, journey: true, decoded: true });
			} finally {
				await context.close();
			}
		}
	} finally {
		await browser.close();
	}
	return { ...getQaToolchainInfo(), ready: true, checks };
}
