import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { CLINE_RULE_FILES } from "../../../src/setup/cline-rules";
import { type MachineSetupPaths, planMachineSetup, type SetupStepPlan } from "../../../src/setup/machine-setup";
import { runMachineSetup } from "../../../src/setup/run-setup";
import { createFakeLemonadeFetch } from "../../utilities/lemonade-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

const ORIGIN = "http://127.0.0.1:3485";
const NOW = new Date("2026-10-07T12:00:00.000Z");
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
			clineRulesDir: join(root, "cline", "rules"),
			clineNotices: join(root, "cline", "data", "settings", "cli-notices.json"),
			clineProviders: join(root, "cline", "data", "settings", "providers.json"),
			clineModels: join(root, "cline", "data", "settings", "models.json"),
			claudeDir: join(root, "claude"),
			claudeMd: join(root, "claude", "CLAUDE.md"),
		};
	});
	afterEach(() => cleanup());

	function plan(overrides: { legacyKitInstalled?: boolean; env?: NodeJS.ProcessEnv; forceRules?: boolean } = {}) {
		return planMachineSetup({
			origin: ORIGIN,
			legacyKitInstalled: overrides.legacyKitInstalled ?? false,
			config: parsePipelineConfig({}).config,
			forceRules: overrides.forceRules,
			env: overrides.env ?? {},
			now: NOW,
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

	it("installs missing Cline rules, leaves a changed one alone unless forced, and ships no project rule", async () => {
		expect(Object.keys(CLINE_RULE_FILES)).not.toContain("dev-servers.md");
		mkdirSync(paths.clineRulesDir, { recursive: true });
		writeFileSync(join(paths.clineRulesDir, "keep-acting.md"), "my own version\n");
		const step = byId(await plan(), "cline-rules");
		expect(step.details).toContain(
			"keep-acting.md differs from Kanban's copy; left alone (--force-rules overwrites)",
		);
		await step.apply?.();
		expect(readFileSync(join(paths.clineRulesDir, "keep-acting.md"), "utf8")).toBe("my own version\n");
		expect(readFileSync(join(paths.clineRulesDir, "status-line.md"), "utf8")).toBe(
			CLINE_RULE_FILES["status-line.md"],
		);
		expect(byId(await plan(), "cline-rules").status).toBe("ok");
		await byId(await plan({ forceRules: true }), "cline-rules").apply?.();
		expect(readFileSync(join(paths.clineRulesDir, "keep-acting.md"), "utf8")).toBe(
			CLINE_RULE_FILES["keep-acting.md"],
		);
	});

	it("marks the Cline TUI promo notices shown and keeps the file's other keys", async () => {
		mkdirSync(join(root, "cline", "data", "settings"), { recursive: true });
		writeFileSync(paths.clineNotices, JSON.stringify({ shown: { other: true }, extra: 1 }));
		await byId(await plan(), "cline-notices").apply?.();
		expect(JSON.parse(readFileSync(paths.clineNotices, "utf8"))).toEqual({
			shown: { other: true, "cline-cli-cline-pass-intro": true, "cline-cli-desktop-launch": true },
			extra: 1,
		});
	});

	it("adds the Bedrock provider entry with a key from the environment, backs up the file, never prints the key", async () => {
		mkdirSync(join(root, "cline", "data", "settings"), { recursive: true });
		const original = { version: 1, providers: { lemonade: { settings: { provider: "lemonade", model: "m" } } } };
		writeFileSync(paths.clineProviders, JSON.stringify(original), { mode: 0o600 });
		const step = byId(await plan({ env: { BEDROCK_API_KEY: "secret-value-123" } }), "cline-providers");
		expect(step.status).toBe("change");
		const applied = (await step.apply?.()) ?? [];
		const output = [...step.details, ...applied].join("\n");
		expect(output).not.toContain("secret-value-123");
		expect(output).toContain("bedrock.settings.apiKey (from BEDROCK_API_KEY)");
		const written = JSON.parse(readFileSync(paths.clineProviders, "utf8"));
		expect(written.providers.bedrock.settings).toEqual({
			provider: "bedrock",
			model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
			aws: { region: "us-west-2" },
			apiKey: "secret-value-123",
		});
		expect(written.providers.lemonade).toEqual(original.providers.lemonade);
		expect(statSync(paths.clineProviders).mode & 0o777).toBe(0o600);
		const backups = readdirSync(join(root, "cline", "data", "settings")).filter((name) => name.includes(".bak-"));
		expect(backups).toEqual(["providers.json.bak-before-kanban-setup-20261007T120000Z"]);
		expect(statSync(join(root, "cline", "data", "settings", backups[0] as string)).mode & 0o777).toBe(0o600);
		expect(byId(await plan(), "cline-providers").status).toBe("ok");
	});

	it("skips providers.json and CLAUDE.md on a machine without Cline or Claude Code", async () => {
		const plans = await plan();
		expect(byId(plans, "cline-providers").status).toBe("skipped");
		expect(byId(plans, "claude-md").status).toBe("skipped");
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

	it("points Cline's Lemonade model list at Kanban's route", async () => {
		mkdirSync(join(root, "cline", "data", "settings"), { recursive: true });
		writeFileSync(
			paths.clineModels,
			JSON.stringify({
				providers: {
					lemonade: {
						provider: { name: "Lemonade", modelsSourceUrl: "http://127.0.0.1:13306/lemonade/models" },
						models: ["m"],
					},
				},
			}),
		);
		const step = byId(await plan(), "cline-models-source");
		expect(step.status).toBe("change");
		await step.apply?.();
		expect(JSON.parse(readFileSync(paths.clineModels, "utf8")).providers.lemonade.provider.modelsSourceUrl).toBe(
			`${ORIGIN}/api/model-lists/lemonade`,
		);
	});

	it("fills in Cline's Lemonade model metadata in the same run that repoints the model list", async () => {
		mkdirSync(join(root, "cline", "data", "settings"), { recursive: true });
		writeFileSync(
			paths.clineModels,
			JSON.stringify({
				version: 1,
				providers: {
					lemonade: {
						provider: { name: "Lemonade", baseUrl: "http://lemonade.test:13305/api/v1" },
						models: ["GLM-4.7-Flash-GGUF"],
					},
				},
			}),
		);
		const result = await runMachineSetup({
			origin: ORIGIN,
			legacyKitInstalled: false,
			config: parsePipelineConfig({}).config,
			env: {},
			now: NOW,
			paths,
			...LEMONADE,
			fetch: createFakeLemonadeFetch(),
			dryRun: false,
			entries: [],
		});
		const step = result.steps.find((entry) => entry.plan.id === "cline-lemonade-models");
		expect(step?.error).toBeNull();
		expect(step?.plan.status).toBe("change");
		const lemonade = JSON.parse(readFileSync(paths.clineModels, "utf8")).providers.lemonade;
		expect(lemonade.provider.modelsSourceUrl).toBe(`${ORIGIN}/api/model-lists/lemonade`);
		expect(lemonade.models["GLM-4.7-Flash-GGUF"]).toMatchObject({ contextWindow: 202752, maxTokens: 32768 });
		// Two writes in the same second: two backups, neither overwritten.
		expect(readdirSync(join(root, "cline", "data", "settings")).filter((name) => name.includes(".bak-")).length).toBe(
			2,
		);
	});

	it("a dry run writes nothing", async () => {
		const result = await runMachineSetup({
			origin: ORIGIN,
			legacyKitInstalled: false,
			config: parsePipelineConfig({}).config,
			env: {},
			now: NOW,
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
