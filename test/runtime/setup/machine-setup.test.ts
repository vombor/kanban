import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { type MachineSetupPaths, planMachineSetup, type SetupStepPlan } from "../../../src/setup/machine-setup";
import { runMachineSetup } from "../../../src/setup/run-setup";
import { createFakeLemonadeFetch } from "../../utilities/lemonade-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

const ORIGIN = "http://127.0.0.1:3485";
// Never the machine's own Lemonade or config.json.
const LEMONADE = { lemonadeModelList: { url: "http://lemonade.test:13305", requireLabels: ["tool-calling"] } };

describe("kanban setup steps", () => {
	let root: string;
	let cleanup: () => void;
	let paths: MachineSetupPaths;

	beforeEach(() => {
		({ path: root, cleanup } = createTempDir("kanban-machine-setup-"));
		paths = {
			npmrc: join(root, ".npmrc"),
			clineProviders: join(root, "cline", "data", "settings", "providers.json"),
			clineModels: join(root, "cline", "data", "settings", "models.json"),
			claudeDir: join(root, "claude"),
			claudeMd: join(root, "claude", "CLAUDE.md"),
		};
	});
	afterEach(() => cleanup());

	function plan(overrides: { legacyKitInstalled?: boolean; env?: NodeJS.ProcessEnv } = {}) {
		return planMachineSetup({
			origin: ORIGIN,
			legacyKitInstalled: overrides.legacyKitInstalled ?? false,
			config: parsePipelineConfig({}).config,
			env: overrides.env ?? {},
			paths,
			...LEMONADE,
			fetch: createFakeLemonadeFetch(),
		});
	}

	function byId(plans: SetupStepPlan[], id: SetupStepPlan["id"]): SetupStepPlan {
		const found = plans.find((entry) => entry.id === id);
		if (!found) {
			throw new Error(`no ${id} step`);
		}
		return found;
	}

	it("adds missing npm settings and never changes one the user set", async () => {
		writeFileSync(paths.npmrc, "loglevel=info\nregistry=https://example.test/");
		const step = byId(await plan(), "npmrc");
		expect(step.status).toBe("change");
		await step.apply?.();
		expect(readFileSync(paths.npmrc, "utf8")).toBe(
			"loglevel=info\nregistry=https://example.test/\n# kanban setup: quiet npm\nupdate-notifier=false\nfund=false\n",
		);
		expect(byId(await plan(), "npmrc").status).toBe("ok");
	});

	it("has no step that writes Cline's rules or notices (Kanban writes nothing under ~/.cline)", async () => {
		const ids = (await plan()).map((entry) => entry.id);
		expect(ids).not.toContain("cline-rules");
		expect(ids).not.toContain("cline-notices");
	});

	it("only checks Cline's Bedrock settings: providers.json or the environment, and says what to run", async () => {
		mkdirSync(join(root, "cline", "data", "settings"), { recursive: true });
		const original = JSON.stringify({ version: 1, providers: { lemonade: { settings: { provider: "lemonade" } } } });
		writeFileSync(paths.clineProviders, original, { mode: 0o600 });
		const missing = byId(await plan({ env: { BEDROCK_API_KEY: "secret-value-123" } }), "cline-providers");
		expect(missing.status).toBe("manual");
		expect(missing.apply).toBeUndefined();
		expect(missing.details.join("\n")).toContain("export AWS_BEARER_TOKEN_BEDROCK=$BEDROCK_API_KEY");
		expect(missing.details.join("\n")).toContain("export AWS_REGION=us-west-2");
		expect(missing.details.join("\n")).not.toContain("secret-value-123");

		const fromEnv = byId(
			await plan({ env: { AWS_BEARER_TOKEN_BEDROCK: "secret-value-123", AWS_REGION: "us-east-1" } }),
			"cline-providers",
		);
		expect(fromEnv).toMatchObject({
			status: "ok",
			details: ["bedrock key from AWS_BEARER_TOKEN_BEDROCK, region us-east-1"],
		});

		writeFileSync(
			paths.clineProviders,
			JSON.stringify({ providers: { bedrock: { settings: { apiKey: "k", aws: { region: "eu-west-1" } } } } }),
		);
		expect(byId(await plan(), "cline-providers")).toMatchObject({
			status: "ok",
			details: ["bedrock key from providers.json, region eu-west-1"],
		});
		const settingsFiles = readdirSync(join(root, "cline", "data", "settings"));
		expect(settingsFiles).toEqual(["providers.json"]);
	});

	it("skips CLAUDE.md on a machine without Claude Code", async () => {
		expect(byId(await plan(), "claude-md").status).toBe("skipped");
	});

	it("writes the CLAUDE.md section around the user's text, but not while the legacy kit is installed", async () => {
		mkdirSync(paths.claudeDir, { recursive: true });
		writeFileSync(paths.claudeMd, "# My own notes\n");
		const withKit = byId(await plan({ legacyKitInstalled: true }), "claude-md");
		expect(withKit.status).toBe("skipped");
		expect(withKit.details.join(" ")).toContain("legacy kit");
		await byId(await plan(), "claude-md").apply?.();
		const text = readFileSync(paths.claudeMd, "utf8");
		expect(text.startsWith("# My own notes\n\n<!-- kanban:managed begin kanban ")).toBe(true);
		expect(text).toContain("kanban doctor <workspace path>");
		// Once Kanban owns a section, it keeps it current even while the kit is installed.
		expect(byId(await plan({ legacyKitInstalled: true }), "claude-md").status).toBe("ok");
	});

	it("says which command repoints Cline's Lemonade model list, and writes nothing", async () => {
		mkdirSync(join(root, "cline", "data", "settings"), { recursive: true });
		const raw = JSON.stringify({
			providers: {
				lemonade: {
					provider: { name: "Lemonade", modelsSourceUrl: "http://127.0.0.1:13306/lemonade/models" },
					models: ["m"],
				},
			},
		});
		writeFileSync(paths.clineModels, raw);
		const step = byId(await plan(), "cline-models-source");
		expect(step.status).toBe("manual");
		expect(step.apply).toBeUndefined();
		expect(step.details).toEqual([
			`lemonade modelsSourceUrl: http://127.0.0.1:13306/lemonade/models -> ${ORIGIN}/api/model-lists/lemonade`,
			`to apply, run \`kanban cline apply-lemonade-models --origin ${ORIGIN}\` (Kanban itself never writes Cline's models.json)`,
		]);
		expect(readFileSync(paths.clineModels, "utf8")).toBe(raw);
	});

	it("prints Cline's Lemonade model metadata changes; a real run writes nothing under Cline's dir", async () => {
		const settingsDir = join(root, "cline", "data", "settings");
		mkdirSync(settingsDir, { recursive: true });
		const raw = JSON.stringify({
			version: 1,
			providers: {
				lemonade: {
					provider: { name: "Lemonade", baseUrl: "http://lemonade.test:13305/api/v1" },
					models: ["GLM-4.7-Flash-GGUF"],
				},
			},
		});
		writeFileSync(paths.clineModels, raw);
		const result = await runMachineSetup({
			origin: ORIGIN,
			legacyKitInstalled: false,
			config: parsePipelineConfig({}).config,
			env: {},
			paths,
			...LEMONADE,
			fetch: createFakeLemonadeFetch(),
			dryRun: false,
			entries: [],
		});
		const step = result.steps.find((entry) => entry.plan.id === "cline-lemonade-models");
		expect(step?.plan.status).toBe("manual");
		expect(step?.applied).toEqual([]);
		expect(step?.plan.details).toContain(
			"GLM-4.7-Flash-GGUF: contextWindow (unset) -> 202752 (recipe ctx_size), maxTokens (unset) -> 32768, supportsVision (unset) -> false, supportsReasoning (unset) -> false, inputPrice (unset) -> 0, outputPrice (unset) -> 0",
		);
		expect(step?.plan.details.at(-1)).toContain("kanban cline apply-lemonade-models --origin");
		expect(readFileSync(paths.clineModels, "utf8")).toBe(raw);
		expect(readdirSync(settingsDir)).toEqual(["models.json"]);
	});

	it("doctor can leave the Lemonade models step to its own row", async () => {
		const plans = await planMachineSetup({
			origin: ORIGIN,
			legacyKitInstalled: false,
			config: parsePipelineConfig({}).config,
			env: {},
			paths,
			...LEMONADE,
			fetch: createFakeLemonadeFetch(),
			skipSteps: ["cline-lemonade-models"],
		});
		expect(plans.map((entry) => entry.id)).not.toContain("cline-lemonade-models");
	});

	it("a dry run writes nothing", async () => {
		const result = await runMachineSetup({
			origin: ORIGIN,
			legacyKitInstalled: false,
			config: parsePipelineConfig({}).config,
			env: {},
			paths,
			...LEMONADE,
			fetch: createFakeLemonadeFetch(),
			dryRun: true,
			entries: [],
		});
		expect(result.steps.find((step) => step.plan.id === "npmrc")?.plan.status).toBe("change");
		expect(readdirSync(root)).toEqual([]);
	});
});
