import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { checkClineLocalAiProvider } from "../../../src/doctor/cline-localai-checks";
import { applyClineLocalAiProvider } from "../../../src/setup/cline-localai-provider";
import { type FakeLocalAi, startFakeLocalAi } from "../../utilities/localai-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

const ORIGIN = "http://127.0.0.1:3485";

describe("doctor: Cline's localai provider", () => {
	let root: { path: string; cleanup: () => void };
	let dataDir: string;
	let modelsPath: string;
	let localai: FakeLocalAi;

	beforeEach(async () => {
		root = createTempDir("kanban-doctor-localai-");
		dataDir = join(root.path, "cline-data");
		modelsPath = join(dataDir, "settings", "models.json");
		mkdirSync(join(dataDir, "settings"), { recursive: true });
		localai = await startFakeLocalAi();
	});

	afterEach(async () => {
		await localai.close();
		root.cleanup();
	});

	function config(input: { url?: string | null; capacity?: number } = {}) {
		return parsePipelineConfig({
			agents: { cline: { dataDir } },
			models: {
				lists: { localai: { url: input.url === undefined ? localai.url : input.url } },
				...(input.capacity === undefined
					? {}
					: { providerCapacity: { localai: { maxLoadedModels: input.capacity } } }),
			},
		}).config;
	}

	it("says nothing where LocalAI isn't set up", async () => {
		expect(await checkClineLocalAiProvider({ config: config({ url: null }), origin: ORIGIN })).toEqual([]);
	});

	it("warns when the provider is missing, with the user's command", async () => {
		const findings = await checkClineLocalAiProvider({ config: config(), origin: ORIGIN });
		expect(findings[0]).toMatchObject({
			level: "warn",
			area: "setup",
			message: expect.stringContaining("missing, so Cline cards can't run on LocalAI"),
			hint: `kanban cline apply-localai-provider --base-url ${localai.url} --origin ${ORIGIN}`,
		});
		expect(findings[1]).toMatchObject({ level: "pass", message: expect.stringContaining("keeps 1 model(s) loaded") });
	});

	it("passes once applied, warns when it differs, and finds LocalAI through Cline's entry alone", async () => {
		await applyClineLocalAiProvider({
			modelsPath,
			providersPath: join(dataDir, "settings", "providers.json"),
			baseUrl: localai.url,
			origin: ORIGIN,
			requireCapabilities: ["chat"],
			backupDir: join(root.path, "backups"),
			dryRun: false,
		});
		// No models.lists.localai.url: the entry's baseUrl is where doctor asks.
		const applied = await checkClineLocalAiProvider({ config: config({ url: null }), origin: ORIGIN });
		expect(applied[0]).toMatchObject({ level: "pass", message: expect.stringContaining("6 model(s) in sync") });

		await localai.close();
		localai = await startFakeLocalAi({
			routes: {
				"/v1/models/capabilities": {
					data: [{ id: "gemma-4-26b-a4b-it", capabilities: ["chat", "vision"], context_size: 65536 }],
				},
				"/api/settings": { max_active_backends: 1 },
			},
		});
		// Same entry, a LocalAI elsewhere now (the config's URL wins over the entry's).
		const moved = await checkClineLocalAiProvider({ config: config(), origin: ORIGIN });
		expect(moved[0]).toMatchObject({ level: "warn", hint: expect.stringContaining(localai.url) });
		expect(moved[0]?.message).toContain("provider.baseUrl");
		expect(moved[0]?.message).toContain("model ornith-1.5-35b-a3b-apex: remove");
	});

	it("is INFO, not a failure, when LocalAI is down", async () => {
		await applyClineLocalAiProvider({
			modelsPath,
			providersPath: join(dataDir, "settings", "providers.json"),
			baseUrl: localai.url,
			origin: ORIGIN,
			requireCapabilities: ["chat"],
			backupDir: join(root.path, "backups"),
			dryRun: false,
		});
		// The host goes away: the entry's own URL now refuses connections.
		await localai.close();
		const findings = await checkClineLocalAiProvider({ config: config({ url: null }), origin: ORIGIN });
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ level: "info", message: expect.stringContaining("did not answer") });
		localai = await startFakeLocalAi();
	});

	it("warns when Kanban lets more LocalAI models run than LocalAI keeps loaded", async () => {
		const findings = await checkClineLocalAiProvider({ config: config({ capacity: 3 }), origin: ORIGIN });
		expect(findings[1]).toMatchObject({
			level: "warn",
			message: expect.stringContaining("Kanban lets 3 LocalAI model(s) run at once"),
			hint: "set models.providerCapacity.localai.maxLoadedModels to 1 in config.json, or raise LocalAI's max_active_backends",
		});
	});
});
