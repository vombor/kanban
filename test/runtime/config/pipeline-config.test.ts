import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import {
	DEFAULT_GUARDRAIL_DENY_COMMANDS,
	getWorkspacePipelineSettings,
	migrateLegacyConfigKeys,
	parsePipelineConfig,
	updatePipelineConfigFile,
} from "../../../src/config/pipeline-config";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

describe("pipeline config", () => {
	it("fills in the documented defaults", () => {
		const { config, issues } = parsePipelineConfig({});
		expect(issues).toEqual([]);
		expect(config.pipeline.qa.slots).toBe(2);
		expect(config.pipeline.rework.maxFailRounds).toBe(3);
		expect(config.pipeline.recovery.retryBackoffMin).toEqual([1, 2, 4, 8]);
		// Report-only until the cutover retires the legacy kit's autoland (two owners would nudge twice).
		expect(config.pipeline.recovery).toMatchObject({ mode: "report", resumeGapSec: 20, nudgeCheckSec: 120 });
		expect(config.watchdog.stall.reviewMin).toBe(10);
		expect(config.orchestrator.wake.mode).toBe("headless");
		expect(config.models.providers.default).toBe("bedrock");
		expect(config.models.providerCapacity).toEqual({ lemonade: { maxLoadedModels: 1 } });
		expect(config.workspaces).toEqual({});
	});

	it("has task-card guardrails on by default with the documented deny list", () => {
		const { config, issues } = parsePipelineConfig({});
		expect(issues).toEqual([]);
		expect(config.guardrails).toEqual({
			enabled: true,
			confineWrites: true,
			extraWritableDirs: [],
			sharedBranches: ["main", "master"],
			denyCommands: [...DEFAULT_GUARDRAIL_DENY_COMMANDS],
		});
		expect(config.guardrails.denyCommands).toEqual(
			expect.arrayContaining(["git push", "git filter-branch", "git update-ref {shared}", "kanban home migrate"]),
		);
		// Card-local rebases and resets are allowed: no plain rebase/reset rule.
		expect(config.guardrails.denyCommands.some((pattern) => /^git (rebase|reset)\b/u.test(pattern))).toBe(false);
		expect(getWorkspacePipelineSettings(config, "any").guardrails).toEqual({
			enabled: null,
			extraDenyCommands: [],
			extraWritableDirs: [],
		});
	});

	it("reads guardrail settings and per-workspace overrides, and falls back to the defaults on a bad section", () => {
		const { config, issues } = parsePipelineConfig({
			guardrails: { confineWrites: false, denyCommands: ["git push"], sharedBranches: ["trunk"] },
			workspaces: { ws: { guardrails: { enabled: false, extraDenyCommands: ["npm publish"] } } },
		});
		expect(issues).toEqual([]);
		expect(config.guardrails).toMatchObject({
			confineWrites: false,
			denyCommands: ["git push"],
			sharedBranches: ["trunk"],
		});
		expect(config.workspaces.ws?.guardrails).toEqual({
			enabled: false,
			extraDenyCommands: ["npm publish"],
			extraWritableDirs: [],
		});
		const bad = parsePipelineConfig({ guardrails: { enabled: "yes" } });
		expect(bad.issues.some((issue) => issue.startsWith("guardrails:"))).toBe(true);
		expect(bad.config.guardrails.enabled).toBe(true);
	});

	it("falls back to report-only recovery for an unknown mode", () => {
		expect(parsePipelineConfig({ pipeline: { recovery: { mode: "on" } } }).config.pipeline.recovery.mode).toBe("on");
		const { config, issues } = parsePipelineConfig({ pipeline: { recovery: { mode: "loud" } } });
		expect(config.pipeline.recovery.mode).toBe("report");
		expect(issues[0]).toContain("pipeline: recovery.mode");
	});

	it("accepts the Cline turn detector settings under agents.cline", () => {
		expect(parsePipelineConfig({}).config.agents.cline.turnDetector).toEqual({ mode: "report", intervalSec: 15 });
		const { config, issues } = parsePipelineConfig({
			agents: { pretrust: false, cline: { dataDir: "/data", turnDetector: { mode: "on", intervalSec: 30 } } },
		});
		expect(issues).toEqual([]);
		expect(config.agents.pretrust).toBe(false);
		expect(config.agents.cline).toEqual({ dataDir: "/data", turnDetector: { mode: "on", intervalSec: 30 } });
	});

	it("gives an unconfigured workspace landing off and no kit", () => {
		const { config } = parsePipelineConfig({
			workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team" } } },
		});
		const other = getWorkspacePipelineSettings(config, "kanban-2uge");
		expect(other.landing.mode).toBe("off");
		expect(other.kit).toBeNull();
		expect(other.pipeline.shadow).toBe(false);
		expect(getWorkspacePipelineSettings(config, "foo").kit).toEqual({ name: "team", overrides: {} });
	});

	it("keeps valid sections when another one is invalid", () => {
		const { config, issues } = parsePipelineConfig({
			pipeline: { qa: { slots: 4 } },
			watchdog: { intervalSec: "soon" },
			workspaces: { foo: { landing: { mode: "qa" } }, bad: { landing: { mode: "always" } } },
			selectedAgentId: "claude",
		});
		expect(config.pipeline.qa.slots).toBe(4);
		expect(config.watchdog.intervalSec).toBe(60);
		expect(config.workspaces.foo?.landing.mode).toBe("qa");
		expect(config.workspaces.bad?.landing.mode).toBe("off");
		expect(issues).toHaveLength(2);
	});

	it("merges provider capacity over the defaults", () => {
		const { config } = parsePipelineConfig({ models: { providerCapacity: { ollama: { maxLoadedModels: 2 } } } });
		expect(config.models.providerCapacity).toEqual({
			lemonade: { maxLoadedModels: 1 },
			ollama: { maxLoadedModels: 2 },
		});
		const raised = parsePipelineConfig({ models: { providerCapacity: { lemonade: { maxLoadedModels: 3 } } } });
		expect(raised.config.models.providerCapacity).toEqual({ lemonade: { maxLoadedModels: 3 } });
	});

	it("rejects unknown keys inside a section", () => {
		const { issues } = parsePipelineConfig({ orchestrator: { agent: "claude" } });
		expect(issues[0]).toContain("orchestrator");
	});

	it("has session sync on by default, as sessionSync.enabled, and still reads P2-1's top-level boolean", () => {
		expect(parsePipelineConfig({}).config.sessionSync).toEqual({ enabled: true, reviewSettleSec: 12 });
		expect(parsePipelineConfig({ sessionSync: { enabled: false } }).config.sessionSync).toEqual({
			enabled: false,
			reviewSettleSec: 12,
		});
		expect(parsePipelineConfig({ sessionSync: false })).toMatchObject({
			config: { sessionSync: { enabled: false } },
			issues: [],
		});
		expect(parsePipelineConfig({ sessionSync: "off" }).issues[0]).toContain("sessionSync");
	});

	it("migrates the old sessionSync form and leaves an absent or new one alone", () => {
		expect(migrateLegacyConfigKeys({ a: 1, sessionSync: false })).toEqual({
			config: { a: 1, sessionSync: { enabled: false } },
			migrated: ["sessionSync"],
		});
		expect(migrateLegacyConfigKeys({ a: 1 })).toEqual({ config: { a: 1 }, migrated: [] });
		const current = { sessionSync: { enabled: true } };
		expect(migrateLegacyConfigKeys(current).migrated).toEqual([]);
	});

	it("has one wake target for every workspace's sidebar, none by default", () => {
		expect(parsePipelineConfig({}).config.orchestrator.wake.target).toBeNull();
		const { config, issues } = parsePipelineConfig({
			orchestrator: { wake: { mode: "sidebar", target: "kanban-2uge" } },
		});
		expect(issues).toEqual([]);
		expect(config.orchestrator.wake).toMatchObject({ mode: "sidebar", target: "kanban-2uge", enabled: true });
	});

	it("writes config.json keeping other keys, and refuses an edit that adds a settings issue", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			mkdirSync(dirname(globalConfigPath), { recursive: true });
			// An issue the file already has doesn't block an unrelated edit.
			writeFileSync(globalConfigPath, JSON.stringify({ selectedAgentId: "claude", watchdog: { bogus: 1 } }));
			await updatePipelineConfigFile((config) => ({ ...config, pipeline: { qa: { slots: 3 } } }));
			const written = JSON.parse(readFileSync(globalConfigPath, "utf8"));
			expect(written).toMatchObject({
				selectedAgentId: "claude",
				watchdog: { bogus: 1 },
				pipeline: { qa: { slots: 3 } },
				home: 1,
			});
			await expect(
				updatePipelineConfigFile((config) => ({ ...config, pipeline: { qa: { slots: -1 } } })),
			).rejects.toThrow("pipeline:");
			expect(JSON.parse(readFileSync(globalConfigPath, "utf8")).pipeline).toEqual({ qa: { slots: 3 } });
		});
	});
});
