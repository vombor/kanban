import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseLocalAiModelListSettings } from "../../../src/config/model-lists-config";
import { createLocalAiModelListLoader, resolveLocalAiUrl } from "../../../src/models/localai-endpoint";
import { describeClineTuiSignInGap } from "../../../src/terminal/cline-tui-sign-in";
import { createTempDir } from "../../utilities/temp-dir";

describe("LocalAI settings", () => {
	it("has no default URL and lists chat models", () => {
		expect(parseLocalAiModelListSettings({})).toEqual({
			settings: { url: null, requireCapabilities: ["chat"] },
			warning: null,
		});
		expect(
			parseLocalAiModelListSettings({
				models: { lists: { localai: { url: "http://localai.test", requireCapabilities: [] } } },
			}).settings,
		).toEqual({ url: "http://localai.test", requireCapabilities: [] });
		const bad = parseLocalAiModelListSettings({
			models: { lists: { localai: { url: "ftp://x", requireCapabilities: 1 } } },
		});
		expect(bad.settings).toEqual({ url: null, requireCapabilities: ["chat"] });
		expect(bad.warning).toContain("models.lists.localai.url");
	});

	it("finds LocalAI in config.json first, else in Cline's localai provider, else nowhere", async () => {
		const root = createTempDir("kanban-localai-url-");
		try {
			const modelsPath = join(root.path, "cline", "settings", "models.json");
			expect(await resolveLocalAiUrl({ configUrl: null, modelsPath })).toBeNull();
			mkdirSync(join(root.path, "cline", "settings"), { recursive: true });
			writeFileSync(
				modelsPath,
				JSON.stringify({
					version: 1,
					providers: { localai: { provider: { name: "LocalAI", baseUrl: "http://entry.test/v1" } } },
				}),
			);
			expect(await resolveLocalAiUrl({ configUrl: null, modelsPath })).toBe("http://entry.test");
			expect(await resolveLocalAiUrl({ configUrl: "http://config.test/", modelsPath })).toBe("http://config.test");

			// The model-lists route's loader reads both on every request.
			const configPath = join(root.path, "config.json");
			writeFileSync(configPath, JSON.stringify({ agents: { cline: { dataDir: join(root.path, "cline") } } }));
			const load = createLocalAiModelListLoader(vi.fn(), configPath);
			expect(await load()).toEqual({ url: "http://entry.test", requireCapabilities: ["chat"] });
		} finally {
			root.cleanup();
		}
	});

	it("reads Cline's TUI rule for a keyless custom provider: baseUrl and model stored, or the sign-in screen", () => {
		const providers = (settings: Record<string, unknown>) => ({ providers: { localai: { settings } } });
		expect(describeClineTuiSignInGap({}, "localai")).toBe("providers.json has no localai entry");
		expect(describeClineTuiSignInGap(providers({ provider: "localai", model: "m" }), "localai")).toContain(
			"no baseUrl and model",
		);
		expect(
			describeClineTuiSignInGap(providers({ provider: "localai", model: "m", baseUrl: "http://x/v1" }), "localai"),
		).toBeNull();
		// A stored key is enough without a baseUrl (cline auth's form).
		expect(describeClineTuiSignInGap(providers({ provider: "localai", apiKey: "k" }), "localai")).toBeNull();
	});
});
