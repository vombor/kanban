// `kanban setup-provider` (src/commands/setup-provider.ts) over the provider registry (src/setup/cline-provider-setup.ts):
// every provider's write through the command, the provider list, and the option rules. Cline's dir is a temp one and
// Lemonade a fake fetch: never the real ~/.cline or the network.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSetupProviderCommand, type SetupProviderOptions } from "../../../src/commands/setup-provider";
import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { CLINE_PROVIDER_SETUPS } from "../../../src/setup/cline-provider-setup";
import { SETUP_PROVIDER_IDS } from "../../../src/setup/setup-provider-command";
import { getClineModelsSettingsPath, getClineProvidersSettingsPath } from "../../../src/state/kanban-home";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createFakeLemonadeFetch } from "../../utilities/lemonade-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const BEDROCK_KEY = "bedrock-key-from-the-env";
const CLINE_PASS_KEY = "cline-pass-key-from-the-env";

describe("kanban setup-provider", () => {
	let root: { path: string; cleanup: () => void };
	let dataDir: string;
	let homePath: string;

	beforeEach(() => {
		root = createTempDir("kanban-setup-provider-");
		dataDir = join(root.path, "cline-data");
		homePath = join(root.path, "kanban-home");
		mkdirSync(join(dataDir, "settings"), { recursive: true });
	});

	afterEach(() => {
		root.cleanup();
	});

	const providersPath = () => getClineProvidersSettingsPath(dataDir);
	const modelsPath = () => getClineModelsSettingsPath(dataDir);

	function writeJson(path: string, document: unknown): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
	}

	async function run(
		provider: string | undefined,
		options: SetupProviderOptions = {},
		env: NodeJS.ProcessEnv = {},
		defaultProvider = "bedrock",
	) {
		const config = parsePipelineConfig({
			agents: { cline: { dataDir } },
			models: { providers: { default: defaultProvider }, bedrockRegion: "us-west-2" },
		}).config;
		return await withTemporaryKanbanHome(
			async () =>
				await runSetupProviderCommand({
					provider,
					options,
					context: { config, homePath, env, fetch: createFakeLemonadeFetch(), now: NOW },
				}),
		);
	}

	it("has one registry entry per provider id, LocalAI not among them", () => {
		expect(CLINE_PROVIDER_SETUPS.map((setup) => setup.id)).toEqual([...SETUP_PROVIDER_IDS]);
		expect(SETUP_PROVIDER_IDS).toEqual(["lemonade", "bedrock", "cline-pass"]);
	});

	it("bedrock: stores the env's key and a region, backs up first, prints no key", async () => {
		writeJson(providersPath(), { version: 1, providers: { bedrock: { settings: { provider: "bedrock" } } } });
		const env = { AWS_BEARER_TOKEN_BEDROCK: BEDROCK_KEY };
		const dry = await run("bedrock", { dryRun: true }, env);
		expect(dry.exitCode).toBe(0);
		expect(dry.stdout).toContain("dry run: not written");
		expect(JSON.parse(readFileSync(providersPath(), "utf8")).providers.bedrock.settings.apiKey).toBeUndefined();

		const written = await run("bedrock", {}, env);
		expect(written.exitCode).toBe(0);
		expect(written.stdout).toContain(`bedrock (${providersPath()}): written`);
		expect(written.stdout).toContain("to roll back: cp ");
		expect(written.stdout).not.toContain(BEDROCK_KEY);
		const settings = JSON.parse(readFileSync(providersPath(), "utf8")).providers.bedrock.settings;
		expect(settings).toMatchObject({ apiKey: BEDROCK_KEY, aws: { region: "us-west-2" } });
		expect(readdirSync(join(homePath, "backups", "cline"))).toHaveLength(1);

		expect((await run("bedrock", {}, env)).stdout).toContain("nothing to do");
		const json = JSON.parse((await run("bedrock", { json: true }, env)).stdout);
		expect(json).toMatchObject({ provider: "bedrock", status: "nothing-to-do", path: providersPath() });
	});

	it("bedrock: refuses without the env's key (exit 1), nothing written", async () => {
		writeJson(providersPath(), { version: 1, providers: {} });
		const refused = await run("bedrock", {}, {});
		expect(refused.exitCode).toBe(1);
		expect(refused.stdout).toContain("refused, nothing written");
		expect(refused.stdout).toContain("AWS_BEARER_TOKEN_BEDROCK is not set here");
	});

	it("cline-pass: stores CLINE_API_KEY as the cline-pass entry's key and leaves the rest", async () => {
		writeJson(providersPath(), {
			version: 1,
			providers: { bedrock: { settings: { provider: "bedrock", apiKey: "other" } } },
		});
		const written = await run("cline-pass", {}, { CLINE_API_KEY: CLINE_PASS_KEY });
		expect(written.exitCode).toBe(0);
		expect(written.stdout).toContain("written");
		expect(written.stdout).not.toContain(CLINE_PASS_KEY);
		const document = JSON.parse(readFileSync(providersPath(), "utf8"));
		expect(document.providers["cline-pass"].settings).toMatchObject({
			provider: "cline-pass",
			apiKey: CLINE_PASS_KEY,
		});
		expect(document.providers.bedrock.settings.apiKey).toBe("other");
	});

	it("lemonade: drops the entry's modelsSourceUrl and fills in its own models' metadata, only that entry", async () => {
		writeJson(modelsPath(), {
			version: 1,
			providers: {
				lemonade: {
					provider: {
						name: "Lemonade",
						baseUrl: "http://lemonade.test:13305/api/v1",
						modelsSourceUrl: "http://127.0.0.1:3485/api/model-lists/lemonade",
					},
					models: ["GLM-4.7-Flash-GGUF"],
				},
				other: { provider: { name: "Other" }, models: ["x"] },
			},
		});
		const dry = await run("lemonade", { dryRun: true });
		expect(dry.stdout).toContain("dry run: not written");
		expect(dry.stdout).toContain("modelsSourceUrl: http://127.0.0.1:3485/api/model-lists/lemonade -> (none)");

		const written = await run("lemonade", {});
		expect(written.exitCode).toBe(0);
		expect(written.stdout).toContain(`lemonade (${modelsPath()}): written`);
		expect(written.stdout).toContain("backup: ");
		const document = JSON.parse(readFileSync(modelsPath(), "utf8"));
		expect(document.providers.lemonade.provider).toEqual({
			name: "Lemonade",
			baseUrl: "http://lemonade.test:13305/api/v1",
		});
		// The record is the orchestrator's allow list: Lemonade's other models are not added.
		expect(Object.keys(document.providers.lemonade.models)).toEqual(["GLM-4.7-Flash-GGUF"]);
		expect(document.providers.lemonade.models["GLM-4.7-Flash-GGUF"]).toMatchObject({ contextWindow: 202752 });
		expect(document.providers.other).toEqual({ provider: { name: "Other" }, models: ["x"] });
		expect((await run("lemonade", {})).stdout).toContain("in sync, nothing written");
	});

	it("lemonade without an entry is nothing to do", async () => {
		writeJson(modelsPath(), { version: 1, providers: {} });
		const result = await run("lemonade", {});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("nothing to do");
	});

	it("lists every provider with the doctor rows' answer", async () => {
		writeJson(providersPath(), {
			version: 1,
			providers: {
				bedrock: { settings: { provider: "bedrock", apiKey: BEDROCK_KEY, aws: { region: "us-west-2" } } },
			},
		});
		const env = { AWS_BEARER_TOKEN_BEDROCK: BEDROCK_KEY, CLINE_API_KEY: CLINE_PASS_KEY };
		const listed = await run(undefined, {}, env);
		expect(listed.exitCode).toBe(0);
		expect(listed.stdout).toMatch(/^lemonade\s+not in use/mu);
		expect(listed.stdout).toMatch(/^bedrock\s+in sync/mu);
		expect(listed.stdout).toMatch(/^cline-pass\s+out of sync/mu);
		expect(listed.stdout).toContain("-> kanban setup-provider cline-pass");
		expect(listed.stdout).not.toContain(BEDROCK_KEY);
		expect(listed.stdout).not.toContain(CLINE_PASS_KEY);

		const json = JSON.parse((await run(undefined, { json: true }, env)).stdout) as {
			provider: string;
			state: string;
		}[];
		expect(json.map(({ provider, state }) => [provider, state])).toEqual([
			["lemonade", "not-in-use"],
			["bedrock", "in-sync"],
			["cline-pass", "out-of-sync"],
		]);
	});

	it("refuses an unknown provider (localai included)", async () => {
		await expect(run("localai", {})).rejects.toThrow(
			'unknown provider "localai"; one of lemonade, bedrock, cline-pass',
		);
	});
});
