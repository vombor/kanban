import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { importLegacyKitConfig, mapLegacyKitConfig } from "../../../src/config/import-kit";
import { parsePipelineConfig, readLegacyWakeTarget } from "../../../src/config/pipeline-config";
import { loadKitCatalog, resolveWorkspaceKit } from "../../../src/kits/resolve-kit";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

// Shaped like the live kit.config.json at cutover (2026-10-07): foo automated, kanban-2uge with everything off, and
// foo's routing (devAgent, qaAgent, benchmark) at the top level, where K-1 no longer lets a project inherit it.
function liveLikeKitConfig(): Record<string, unknown> {
	return {
		"//": "comment",
		kanbanUrl: "http://127.0.0.1:3485",
		runtimeUrl: "http://127.0.0.1:3484",
		bedrockRegion: "us-west-2",
		syncIntervalSec: 10,
		thresholds: { REWORK_CLEAR_TURNS: 100, REWORK_CLEAR_TOKENS: 150000, NUDGE_MAX: 2, QAFLOW_MAX_FAILS: 3 },
		toggles: { AUTO_DONE: true, AUTO_REWORK: true, QA_CREATE: true, TRIAGE_CARDS: false, WAKE_ORCHESTRATOR: true },
		benchmark: {
			tiers: {
				tier3: [
					{
						provider: "openai-native",
						model: "us.openai.gpt-6.1-sol",
						default: true,
						note: "tier-3 default since 2026-10-06 (won runoff tier3-multiregion: 4.0 vs 3.67, ~21 min vs ~2h45); provider becomes bedrock after the fork switch (kit providers --for)",
					},
					{
						provider: "bedrock",
						model: "us.amazon.nova-2-lite-v1:0",
						note: "candidate; dropped 2026-10-05 (ends turns narrating instead of calling tools; no Cline caching made it ~$26 per 62a99-sized run vs luna ~$1); back 2026-10-07: with the Cline Bedrock cache patch (deploy/patch-cline-bedrock-cache.mjs) probe card 717a9 (Cline 3.0.69) ran 16 turns at ~21K input, cache read on almost every turn after the first, ~$0.0018/turn vs ~$0.007 uncached, $0.045 total, 15 tool calls, STATUS: DONE (small task: narrating not ruled out)",
					},
				],
			},
		},
		projects: [
			{
				workspaceId: "foo",
				projectPath: "/projects/foo",
				toggles: { QA_CREATE: true, AUTO_REWORK: true, AUTO_DONE: true },
				baseBranch: "master",
				name: "Pawsome",
				projectBlurb: "Project: Pawsome, a pet shop.",
				scoreboard: "~/x/data/foo/bench/scoreboard.jsonl",
				qaPrompt: { screenshotFallbackNote: "", knownBaseIssues: "", dbSetup: "npx prisma migrate deploy" },
				postLand: [{ paths: "^prisma/", run: "npx prisma generate", stopUnder: ["server"] }],
				qaPreview: null,
			},
			{
				workspaceId: "kanban-2uge",
				projectPath: "/projects/kanban",
				baseBranch: "fork/stack",
				name: "kanban-fork",
				projectBlurb: "Project: the fork.",
				toggles: { QA_CREATE: false, AUTO_REWORK: false, AUTO_DONE: false },
			},
			// No toggles of its own: since K-1 the top-level `true`s don't apply to it.
			{ workspaceId: "newproj", projectPath: "/projects/newproj", baseBranch: "main" },
		],
		qaAgent: "codex",
		qaSlots: 2,
		wakeMode: "sidebar",
		wakeTarget: "kanban-2uge",
		devAgent: "cline",
		providers: {
			"//": "comment",
			default: "bedrock",
			fallback: {},
			legacyUpstream: { "^us\\.openai\\.": "openai-native" },
			deprecated: { "openai-native": "Mantle path, broken under cline 3.x" },
		},
	};
}

describe("mapLegacyKitConfig", () => {
	it("imports the legacy qaPreview object as qa.preview, and notes one of another shape", () => {
		const preview = { pidFile: ".preview.pid", start: "npm run preview:start", stop: "npm run preview:stop" };
		const withPreview = (qaPreview: unknown) => {
			const raw = liveLikeKitConfig();
			(raw.projects as Array<Record<string, unknown>>)[0] = {
				...(raw.projects as Array<Record<string, unknown>>)[0],
				qaPreview,
			};
			return mapLegacyKitConfig(raw, "kit.config.json").workspaces.find(
				(workspace) => workspace.workspaceId === "foo",
			);
		};
		expect(withPreview(preview)?.overrides["qa.preview"]).toEqual(preview);
		const odd = withPreview("npm run preview");
		expect(odd?.overrides["qa.preview"]).toBeUndefined();
		expect(odd?.notes.join("\n")).toContain("qaPreview is not { pidFile, start, stop }");
	});

	it("maps foo to team with only its project values as overrides, landing qa, in shadow", () => {
		const mapping = mapLegacyKitConfig(liveLikeKitConfig(), "kit.config.json");
		const foo = mapping.workspaces.find((workspace) => workspace.workspaceId === "foo");
		expect(foo).toMatchObject({
			kit: "team",
			landing: "qa",
			shadow: true,
			defaultBaseRef: "master",
			name: "Pawsome",
		});
		// devAgent, qaAgent, the default qaRoutes, QAFLOW_MAX_FAILS and tier3 (deprecated provider → bedrock) all match
		// kits/team.json, so they are not overrides.
		expect(foo?.overrides).toEqual({
			"qa.blurb": "Project: Pawsome, a pet shop.",
			"qa.promptNotes.dbSetup": "npx prisma migrate deploy",
			"land.postLand": [{ paths: "^prisma/", run: "npx prisma generate", stopUnder: ["server"] }],
		});
		expect(foo?.notes.join("\n")).toContain("scoreboard path not imported");
	});

	it("never copies top-level routing onto a project: toggles off or absent mean default, landing off", () => {
		const mapping = mapLegacyKitConfig(liveLikeKitConfig(), "kit.config.json");
		const kanban = mapping.workspaces.find((workspace) => workspace.workspaceId === "kanban-2uge");
		expect(kanban).toMatchObject({
			kit: null,
			overrides: {},
			landing: "off",
			shadow: false,
			defaultBaseRef: "fork/stack",
		});
		expect(kanban?.notes.join("\n")).toContain("projectBlurb not imported");
		const fresh = mapping.workspaces.find((workspace) => workspace.workspaceId === "newproj");
		expect(fresh).toMatchObject({ kit: null, overrides: {}, landing: "off", shadow: false });
	});

	it("turns differences from kits/team.json into overrides", () => {
		const raw = liveLikeKitConfig();
		raw.qaAgent = "claude";
		(raw.thresholds as Record<string, unknown>).QAFLOW_MAX_FAILS = 5;
		const projects = raw.projects as Array<Record<string, unknown>>;
		(projects[0] as Record<string, unknown>).toggles = { QA_CREATE: true, AUTO_REWORK: false, AUTO_DONE: false };
		const foo = mapLegacyKitConfig(raw, "x").workspaces[0];
		expect(foo?.overrides).toMatchObject({
			"qa.default.agent": "claude",
			"onFail.reworkRounds": 5,
			"onFail.rework": "none",
		});
		// QA without auto-landing has no `qa` equivalent: the safe direction is landing off.
		expect(foo?.landing).toBe("off");
		expect(foo?.notes.join("\n")).toContain("AUTO_DONE is off");
	});

	it("maps machine-wide keys to core settings and lists what it drops", () => {
		const mapping = mapLegacyKitConfig(liveLikeKitConfig(), "kit.config.json");
		const core = Object.fromEntries(mapping.core.map((entry) => [entry.key, entry.value]));
		expect(core).toEqual({
			"pipeline.qa.slots": 2,
			"pipeline.rework.maxFailRounds": 3,
			"pipeline.rework.clearAfterTurns": 100,
			"pipeline.rework.clearAfterTokens": 150000,
			"pipeline.recovery.maxNudges": 2,
			"watchdog.triageCards": false,
			"orchestrator.wake.enabled": true,
			"orchestrator.wake.mode": "sidebar",
			"models.providers.default": "bedrock",
			"models.providers.fallback": {},
			"models.providers.deprecated": { "openai-native": "Mantle path, broken under cline 3.x" },
			"models.bedrockRegion": "us-west-2",
		});
		const dropped = mapping.notImported.map((entry) => entry.key);
		expect(dropped).toEqual(
			expect.arrayContaining([
				"kanbanUrl",
				"providers.legacyUpstream",
				"toggles.QA_CREATE",
				"devAgent",
				"benchmark",
				"wakeTarget",
			]),
		);
		expect(dropped).not.toContain("//");
		expect(dropped).not.toContain("providers.//");
	});
});

describe("importLegacyKitConfig", () => {
	it("dry run writes nothing; the import writes only the mapped keys and resolves as the mapping says", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath, userHomePath }) => {
			const sourcePath = join(userHomePath, "legacy", "kit.config.json");
			mkdirSync(dirname(sourcePath), { recursive: true });
			writeFileSync(sourcePath, JSON.stringify(liveLikeKitConfig()));
			mkdirSync(dirname(globalConfigPath), { recursive: true });
			writeFileSync(
				globalConfigPath,
				JSON.stringify({
					selectedAgentId: "claude",
					pipeline: { qa: { timeoutMin: 90 } },
					workspaces: { foo: { checks: { enabled: false } } },
				}),
			);

			const dryRun = await importLegacyKitConfig({ sourcePath, dryRun: true });
			expect(dryRun.written).toBe(false);
			expect(dryRun.changes.map((change) => change.key)).toContain("workspaces.foo.kit");
			expect(JSON.parse(readFileSync(globalConfigPath, "utf8")).pipeline).toEqual({ qa: { timeoutMin: 90 } });

			const result = await importLegacyKitConfig({ sourcePath, dryRun: false });
			expect(result.written).toBe(true);
			const written = JSON.parse(readFileSync(globalConfigPath, "utf8")) as Record<string, unknown>;
			expect(written.selectedAgentId).toBe("claude");
			expect(written.pipeline).toEqual({
				qa: { timeoutMin: 90, slots: 2 },
				rework: expect.any(Object),
				recovery: { maxNudges: 2 },
			});
			const { config, issues } = parsePipelineConfig(written);
			expect(issues).toEqual([]);
			expect(readLegacyWakeTarget(written)).toBeUndefined();
			expect(config.workspaces.foo?.checks.enabled).toBe(false);
			expect(config.workspaces.foo?.pipeline.shadow).toBe(true);
			expect(config.workspaces["kanban-2uge"]?.kit).toBeNull();
			const catalog = await loadKitCatalog(join(userHomePath, "no-user-kits"));
			const foo = resolveWorkspaceKit(config, "foo", catalog);
			expect(foo.kitName).toBe("team");
			expect(foo.issues).toEqual([]);
			expect(foo.kit.qa?.blurb).toBe("Project: Pawsome, a pet shop.");
			expect(resolveWorkspaceKit(config, "newproj", catalog).kitName).toBe("default");

			// Running it again changes nothing.
			expect((await importLegacyKitConfig({ sourcePath, dryRun: true })).changes).toEqual([]);
		});
	});

	it("rewrites P2-1's sessionSync boolean in the same write, keeping its value", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath, userHomePath }) => {
			const sourcePath = join(userHomePath, "kit.config.json");
			writeFileSync(sourcePath, JSON.stringify({ projects: [] }));
			mkdirSync(dirname(globalConfigPath), { recursive: true });
			writeFileSync(globalConfigPath, JSON.stringify({ sessionSync: false }));
			const dryRun = await importLegacyKitConfig({ sourcePath, dryRun: true });
			expect(dryRun.changes).toEqual([{ key: "sessionSync", from: false, to: { enabled: false } }]);
			await importLegacyKitConfig({ sourcePath, dryRun: false });
			expect(JSON.parse(readFileSync(globalConfigPath, "utf8")).sessionSync).toEqual({ enabled: false });
		});
	});

	it("refuses a missing source file", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			await expect(
				importLegacyKitConfig({ sourcePath: join(userHomePath, "missing.json"), dryRun: true }),
			).rejects.toThrow("does not exist");
		});
	});
});
