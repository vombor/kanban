import { test as base } from "@playwright/test";

/** Every test gets its own context on the same Chrome sidecar agents use. Never launch/install a browser. */
export const test = base.extend<{ disableWebGL: boolean }>({
	disableWebGL: [false, { option: true }],
	browser: [
		async ({ playwright }, use) => {
			const endpoint = process.env.PLAYWRIGHT_CDP_URL ?? "http://127.0.0.1:9222";
			const browser = await playwright.chromium.connectOverCDP(endpoint, { isLocal: false });
			try {
				await use(browser);
			} finally {
				// connectOverCDP's close disconnects its transport; it does not stop the shared Chrome process.
				await browser.close();
			}
		},
		{ scope: "worker" },
	],
	context: async ({ context, disableWebGL }, use) => {
		if (disableWebGL) {
			// Keep this page's xterm DOM-readable without changing shared Chrome's launch flags.
			await context.addInitScript(() => {
				HTMLCanvasElement.prototype.getContext = new Proxy(HTMLCanvasElement.prototype.getContext, {
					apply(target, canvas, args) {
						if (["webgl", "webgl2", "experimental-webgl"].includes(args[0])) return null;
						return Reflect.apply(target, canvas, args);
					},
				});
			});
		}
		await use(context);
	},
});

export { expect } from "@playwright/test";
