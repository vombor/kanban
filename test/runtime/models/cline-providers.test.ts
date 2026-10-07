import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import {
	deprecatedProviderIds,
	findCodexMantleProviders,
	findDeprecatedProviderEntries,
	type ProviderSettingsPaths,
	type ProvidersPolicy,
	planDeprecatedProviderCleanup,
	providerForModel,
} from "../../../src/models/cline-providers";
import { createTempDir } from "../../utilities/temp-dir";

// The legacy kit's live `providers` section on 2026-10-07 (kit.config.json), minus the upstream-only mapping.
const POLICY: ProvidersPolicy = {
	default: "bedrock",
	fallback: { "moonshotai.kimi-k3": "lemonade" },
	deprecated: {
		"openai-native": "Cline providers.json entry pointed at Bedrock /openai/v1 (Mantle).",
		"models.json:mantle": "custom provider at bedrock-mantle.us-east-1.api.aws/v1 (experiment, unused)",
		"codex:bedrock-mantle": "~/.codex/config.toml model provider; goes away with the Codex retirement",
		"kit probe-models --openai": "probes the deprecated openai-native path",
	},
};

// Cline settings as they were before the 10/06 fork switch (fake keys).
function providersFile(): Record<string, unknown> {
	return {
		version: 1,
		lastUsedProvider: "openai-native",
		providers: {
			bedrock: {
				settings: {
					provider: "bedrock",
					apiKey: "fake-bedrock",
					model: "us.openai.gpt-6.1-sol",
					aws: { region: "us-west-2" },
				},
			},
			"openai-native": {
				settings: {
					provider: "openai-native",
					apiKey: "fake",
					baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1",
				},
			},
			lemonade: {
				settings: {
					provider: "lemonade",
					model: "Qwen3-Coder-Next-GGUF",
					baseUrl: "http://localhost:13305/api/v1",
				},
			},
		},
	};
}

function modelsFile(): Record<string, unknown> {
	return {
		version: 1,
		providers: {
			mantle: { provider: { name: "Mantle", baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1" }, models: [] },
			"bedrock-mantle": {
				provider: {
					name: "Bedrock Mantle",
					baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1",
					protocol: "openai-responses",
				},
				models: [],
			},
			lemonade: { provider: { name: "Lemonade (local)", baseUrl: "http://localhost:13305/api/v1" }, models: [] },
		},
	};
}

const CODEX_TOML = `model = "gpt-6"
model_provider = "bedrock-mantle"

[model_providers.bedrock-mantle]
name = "Bedrock Mantle"
base_url = "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1"

[model_providers.local]
base_url = "http://localhost:13305/api/v1"

[projects."/projects/foo"]
trust_level = "trusted"
`;

describe("providerForModel", () => {
	it("gives the fallback provider for a listed model, else the default", () => {
		expect(providerForModel("moonshotai.kimi-k3", POLICY)).toBe("lemonade");
		expect(providerForModel("us.openai.gpt-6.1-sol", POLICY)).toBe("bedrock");
		expect(providerForModel(null, POLICY)).toBe("bedrock");
		expect(providerForModel(" ", POLICY)).toBe("bedrock");
	});

	it("defaults to bedrock with an empty config", () => {
		const { providers } = parsePipelineConfig({}).config.models;
		expect(providerForModel("anything", providers)).toBe("bedrock");
		expect(deprecatedProviderIds(providers).size).toBe(0);
	});

	it("reads only plain provider ids from deprecated", () => {
		expect([...deprecatedProviderIds(POLICY)]).toEqual(["openai-native"]);
	});
});

describe("findCodexMantleProviders", () => {
	it("finds model providers at a Mantle URL only", () => {
		expect(findCodexMantleProviders(CODEX_TOML)).toEqual(["bedrock-mantle"]);
		expect(
			findCodexMantleProviders('[model_providers."m"]\nbase_url = "https://bedrock-mantle.us-east-1.api.aws/v1"\n'),
		).toEqual(["m"]);
		expect(findCodexMantleProviders("")).toEqual([]);
	});
});

describe("deprecated provider settings", () => {
	let dir: { path: string; cleanup: () => void };
	let paths: ProviderSettingsPaths;
	let backupsRoot: string;

	beforeEach(() => {
		dir = createTempDir("kanban-cline-providers-");
		mkdirSync(join(dir.path, "settings"));
		paths = {
			providersPath: join(dir.path, "settings", "providers.json"),
			modelsPath: join(dir.path, "settings", "models.json"),
			codexConfigPath: join(dir.path, "config.toml"),
		};
		backupsRoot = join(dir.path, "backups");
		writeFileSync(paths.providersPath, JSON.stringify(providersFile(), null, 2), { mode: 0o600 });
		writeFileSync(paths.modelsPath, JSON.stringify(modelsFile(), null, 2), { mode: 0o644 });
		writeFileSync(paths.codexConfigPath, CODEX_TOML);
	});

	afterEach(() => {
		dir.cleanup();
	});

	it("reports the workarounds and leaves normal providers such as lemonade out", async () => {
		const entries = await findDeprecatedProviderEntries(paths, POLICY);
		expect(entries.map((entry) => [entry.id, entry.file, entry.keep])).toEqual([
			["openai-native", paths.providersPath, false],
			["lastUsedProvider", paths.providersPath, false],
			["mantle", paths.modelsPath, false],
			["bedrock-mantle", paths.modelsPath, false],
			["codex:bedrock-mantle", paths.codexConfigPath, true],
		]);
		expect(entries[0]?.note).toBe(POLICY.deprecated["openai-native"]);
		expect(entries[3]?.what).toContain("openai-responses");
		// Never prints secrets.
		expect(JSON.stringify(entries)).not.toContain("fake");
	});

	it("flags a Mantle baseUrl even when the provider isn't listed as deprecated", async () => {
		const entries = await findDeprecatedProviderEntries(paths, { default: "bedrock", fallback: {}, deprecated: {} });
		expect(entries.map((entry) => entry.id)).toEqual([
			"openai-native",
			"lastUsedProvider",
			"mantle",
			"bedrock-mantle",
			"codex:bedrock-mantle",
		]);
	});

	it("reports nothing when the files are missing", async () => {
		const missing = {
			providersPath: join(dir.path, "x.json"),
			modelsPath: join(dir.path, "y.json"),
			codexConfigPath: join(dir.path, "z.toml"),
		};
		await expect(findDeprecatedProviderEntries(missing, POLICY)).resolves.toEqual([]);
	});

	it("cleanup only lists the edits: Cline's files and the backups dir stay untouched", async () => {
		const before = [paths.providersPath, paths.modelsPath, paths.codexConfigPath].map((path) =>
			readFileSync(path, "utf8"),
		);
		const result = await planDeprecatedProviderCleanup({ paths, policy: POLICY });
		expect(result.edits.map((edit) => edit.description)).toEqual([
			"delete providers.openai-native",
			"lastUsedProvider: openai-native -> bedrock",
			"delete custom provider mantle (https://bedrock-mantle.us-east-1.api.aws/v1)",
			"delete custom provider bedrock-mantle (https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1)",
		]);
		expect(result.kept.map((entry) => entry.id)).toEqual(["codex:bedrock-mantle"]);
		expect(
			[paths.providersPath, paths.modelsPath, paths.codexConfigPath].map((path) => readFileSync(path, "utf8")),
		).toEqual(before);
		expect(existsSync(backupsRoot)).toBe(false);
	});

	it("says when a file isn't valid JSON", async () => {
		writeFileSync(paths.modelsPath, "{ not json");
		const result = await planDeprecatedProviderCleanup({ paths, policy: POLICY });
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain(paths.modelsPath);
		expect(result.edits.every((edit) => edit.file === paths.providersPath)).toBe(true);
	});
});
