import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { buildKitReport, formatKitReport } from "../../../src/kits/kit-report";
import { kitDocumentSchema } from "../../../src/kits/kit-schema";
import {
	getDefaultKit,
	loadKitCatalog,
	resolveKitByName,
	resolveKitLayers,
	resolveWorkspaceKit,
} from "../../../src/kits/resolve-kit";
import { createTempDir } from "../../utilities/temp-dir";

async function builtInCatalog() {
	const { path, cleanup } = createTempDir("kanban-kits-");
	try {
		return await loadKitCatalog(path);
	} finally {
		cleanup();
	}
}

describe("resolveKitLayers", () => {
	const named = kitDocumentSchema.parse({
		kit: 1,
		name: "mine",
		qa: { enabled: true, default: { agent: "codex" }, skip: { roles: ["qa"] }, blurb: "kit blurb" },
		onFail: { rework: "same-model", reworkRounds: 2 },
	});

	it("takes the override, then the kit, then default", () => {
		const resolved = resolveKitLayers(getDefaultKit(), named, { "qa.blurb": "override blurb" });
		if (!resolved.ok) {
			throw new Error(resolved.error);
		}
		expect(resolved.kit.qa?.blurb).toBe("override blurb");
		expect(resolved.kit.onFail?.reworkRounds).toBe(2);
		expect(resolved.kit.onFail?.then).toBe("stop");
		expect(resolved.sources["qa.blurb"]).toBe("override");
		expect(resolved.sources["onFail.reworkRounds"]).toBe("mine");
		expect(resolved.sources["onFail.then"]).toBe("default");
		expect(resolved.sources["qa.routes"]).toBe("default");
	});

	it("replaces arrays instead of merging them", () => {
		const resolved = resolveKitLayers(getDefaultKit(), named, {});
		if (!resolved.ok) {
			throw new Error(resolved.error);
		}
		// default has ["qa", "triage", "calibration"]; the kit's one-element list wins as a whole.
		expect(resolved.kit.qa?.skip?.roles).toEqual(["qa"]);
		const overridden = resolveKitLayers(getDefaultKit(), named, { "qa.skip.roles": ["triage"] });
		expect(overridden.ok && overridden.kit.qa?.skip?.roles).toEqual(["triage"]);
	});

	it("refuses unknown override keys and keys that identify the kit", () => {
		const unknown = resolveKitLayers(getDefaultKit(), named, { "qa.blurbs": "x" });
		expect(unknown.ok).toBe(false);
		expect(resolveKitLayers(getDefaultKit(), named, { name: "team" }).ok).toBe(false);
		expect(resolveKitLayers(getDefaultKit(), named, { "qa.enabled.x": true }).ok).toBe(false);
		expect(resolveKitLayers(getDefaultKit(), named, { "qa..blurb": "x" }).ok).toBe(false);
	});
});

describe("resolveWorkspaceKit", () => {
	it("gives a workspace without a kit entry the default kit", async () => {
		const catalog = await builtInCatalog();
		const { config } = parsePipelineConfig({});
		const resolved = resolveWorkspaceKit(config, "kanban-2uge", catalog);
		expect(resolved.kitName).toBe("default");
		expect(resolved.requestedKitName).toBeNull();
		expect(resolved.kit.qa?.enabled).toBe(false);
		expect(resolved.issues).toEqual([]);
	});

	it("never inherits another workspace's kit or overrides", async () => {
		const catalog = await builtInCatalog();
		const { config } = parsePipelineConfig({
			workspaces: {
				foo: { landing: { mode: "qa" }, kit: { name: "team", overrides: { "qa.blurb": "Project: Pawsome" } } },
				"kanban-2uge": { landing: { mode: "off" } },
			},
		});
		const foo = resolveWorkspaceKit(config, "foo", catalog);
		expect(foo.kitName).toBe("team");
		expect(foo.kit.qa?.blurb).toBe("Project: Pawsome");
		expect(foo.sources["qa.blurb"]).toBe("override");
		expect(foo.sources["qa.enabled"]).toBe("team");
		for (const workspaceId of ["kanban-2uge", "brand-new"]) {
			const other = resolveWorkspaceKit(config, workspaceId, catalog);
			expect(other.kitName).toBe("default");
			expect(other.kit.qa?.enabled).toBe(false);
			expect(other.kit.qa?.blurb).toBe("");
		}
	});

	it("falls back to default with an issue when the kit is unknown or its overrides are invalid", async () => {
		const catalog = await builtInCatalog();
		const { config } = parsePipelineConfig({
			workspaces: {
				a: { kit: { name: "gone" } },
				b: { kit: { name: "team", overrides: { "qa.nope": 1 } } },
			},
		});
		for (const workspaceId of ["a", "b"]) {
			const resolved = resolveWorkspaceKit(config, workspaceId, catalog);
			expect(resolved.kitName).toBe("default");
			expect(resolved.kit.qa?.enabled).toBe(false);
			expect(resolved.issues).toHaveLength(1);
		}
	});
});

describe("loadKitCatalog", () => {
	it("loads user kits and refuses built-in names, mismatched names and invalid files", async () => {
		const { path, cleanup } = createTempDir("kanban-kits-");
		try {
			mkdirSync(path, { recursive: true });
			writeFileSync(
				join(path, "solo.json"),
				JSON.stringify({ kit: 1, name: "solo", dev: { agent: "codex" }, qa: { enabled: false } }),
			);
			writeFileSync(join(path, "team.json"), JSON.stringify({ kit: 1, name: "team" }));
			writeFileSync(join(path, "other.json"), JSON.stringify({ kit: 1, name: "renamed" }));
			writeFileSync(join(path, "broken.json"), "{");
			writeFileSync(join(path, "typo.json"), JSON.stringify({ kit: 1, name: "typo", qa: { enable: true } }));
			const catalog = await loadKitCatalog(path);
			expect([...catalog.kits.keys()].sort()).toEqual(["default", "solo", "team", "team-local"]);
			expect(catalog.kits.get("team")?.origin).toEqual({ kind: "built-in" });
			expect(catalog.kits.get("solo")?.origin).toEqual({ kind: "user", path: join(path, "solo.json") });
			expect(catalog.errors.map((error) => error.path).sort()).toEqual(
				["broken.json", "other.json", "team.json", "typo.json"].map((file) => join(path, file)),
			);
			const solo = resolveKitByName(catalog, "solo");
			expect(solo.ok && solo.sources["dev.agent"]).toBe("solo");
		} finally {
			cleanup();
		}
	});

	it("reports an unreadable kits directory instead of throwing", async () => {
		const { path, cleanup } = createTempDir("kanban-kits-");
		try {
			const notADir = join(path, "kits");
			writeFileSync(notADir, "");
			const catalog = await loadKitCatalog(notADir);
			expect([...catalog.kits.keys()]).toEqual(["default", "team", "team-local"]);
			expect(catalog.errors).toEqual([{ path: notADir, error: expect.stringContaining("ENOTDIR") }]);
		} finally {
			cleanup();
		}
	});

	it("works without a kits directory", async () => {
		const { path, cleanup } = createTempDir("kanban-kits-");
		try {
			const catalog = await loadKitCatalog(join(path, "missing"));
			expect([...catalog.kits.keys()]).toEqual(["default", "team", "team-local"]);
			expect(catalog.errors).toEqual([]);
		} finally {
			cleanup();
		}
	});
});

describe("kanban kit show report", () => {
	it("lists each resolved value with its source and the evaluator's answers", async () => {
		const catalog = await builtInCatalog();
		const resolved = resolveKitByName(catalog, "team", { "qa.blurb": "Project: Pawsome" });
		if (!resolved.ok) {
			throw new Error(resolved.error);
		}
		const report = buildKitReport({
			kitName: "team",
			resolved,
			workspaceId: "foo",
			selectedAgentId: "claude",
			maxFailRounds: 3,
			outageMaxMin: 360,
			config: parsePipelineConfig({}).config,
		});
		const sourceOf = (key: string) => report.values.find((row) => row.key === key)?.source;
		expect(sourceOf("qa.blurb")).toBe("override");
		expect(sourceOf("qa.enabled")).toBe("team");
		expect(sourceOf("land.postLand")).toBe("default");
		expect(report.devAssignment).toMatchObject({ agentId: "cline", tier: "tier3" });
		expect(report.qa[0]).toMatchObject({ devModel: { model: "us.openai.gpt-6.1-sol" }, answer: { kind: "qa" } });
		// Every usable tier model is a sample dev card once, also when two tiers list it (Nova 2 Lite: tier3 and qa);
		// dropped ones are not offered.
		expect(report.qa.filter((row) => row.devModel?.model === "us.amazon.nova-2-lite-v1:0")).toHaveLength(1);
		expect(report.qa.some((row) => row.devModel?.model === "qwen.qwen3-next-80b-a3b")).toBe(false);
		expect(report.recommendedLandingMode).toBe("qa");
		expect(report.warnings).toEqual([]);
		expect(formatKitReport(report).join("\n")).toContain('qa.blurb = "Project: Pawsome"  [override]');
		expect(formatKitReport(report).join("\n")).toContain("After 360 min of provider outage: keep holding");
	});

	it("shows the outage takeover a kit's onOutage asks for", async () => {
		const resolved = resolveKitByName(await builtInCatalog(), "team", {
			"onOutage.then": "escalate",
			"onOutage.afterMin": 45,
			"escalate.to": { agent: "codex", provider: "bedrock", model: "us.moonshotai.kimi-k3" },
			"escalate.requireApproval": false,
		});
		if (!resolved.ok) {
			throw new Error(resolved.error);
		}
		const lines = formatKitReport(
			buildKitReport({
				kitName: "team",
				resolved,
				workspaceId: "foo",
				selectedAgentId: "claude",
				maxFailRounds: 3,
				outageMaxMin: 360,
				config: parsePipelineConfig({}).config,
			}),
		);
		expect(lines).toContain("After 45 min of provider outage: take over on codex bedrock/us.moonshotai.kimi-k3");
	});
});
