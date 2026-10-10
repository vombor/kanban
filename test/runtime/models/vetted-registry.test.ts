import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import teamKitJson from "../../../kits/team.json" with { type: "json" };
import teamLocalKitJson from "../../../kits/team-local.json" with { type: "json" };
import { getBuiltInKits } from "../../../src/kits/resolve-kit";
import { lookupTierModel } from "../../../src/kits/tier-lookup";
import {
	buildVettedRegistryJsonSchema,
	getVettedRegistry,
	listModelWideRejections,
	lookupVetting,
	parseVettedRegistry,
} from "../../../src/models/vetted-registry";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const vetted = { status: "vetted", at: "2026-10-09", cliVersion: null, evidence: { run: null, summary: "x" } };

describe("the vetted model registry (models/vetted.json)", () => {
	it("parses, and its committed JSON Schema is the schema's (npx tsx scripts/write-vetted-schema.ts)", () => {
		expect(getVettedRegistry().entries.length).toBeGreaterThan(10);
		const committed = JSON.parse(readFileSync(join(repoRoot, "models", "vetted.schema.json"), "utf8"));
		expect(committed).toEqual(JSON.parse(JSON.stringify(buildVettedRegistryJsonSchema())));
	});

	it("vets foo's team (Codex sol and kimi build, Haiku 5.5 on Cline reviews, Opus 5.5 on Cline plans)", () => {
		const registry = getVettedRegistry();
		const status = (
			agentId: "codex" | "cline",
			provider: string | null,
			model: string,
			role: "dev" | "qa" | "plan",
		) => lookupVetting(registry, { agentId, provider, model }, role).status;
		expect(status("codex", "bedrock", "us.openai.gpt-6.1-sol", "dev")).toBe("vetted");
		// Codex reads its provider from its own config: a card without one matches the entry.
		expect(status("codex", null, "us.openai.gpt-6.1-sol", "dev")).toBe("vetted");
		expect(status("codex", null, "us.moonshotai.kimi-k3", "dev")).toBe("vetted");
		expect(status("cline", "bedrock", "us.anthropic.claude-haiku-5-5", "qa")).toBe("vetted");
		expect(status("cline", "bedrock", "us.anthropic.claude-opus-5-5", "plan")).toBe("vetted");
		// Vetted per role: Haiku is not vetted for dev, Opus only provisional for dev.
		expect(status("cline", "bedrock", "us.anthropic.claude-haiku-5-5", "dev")).toBe("unknown");
		expect(status("cline", "bedrock", "us.anthropic.claude-opus-5-5", "dev")).toBe("provisional");
		// team-local's routes and the other Lemonade models, vetted by kanban models vet (2026-10-09/10).
		expect(status("cline", "lemonade", "GLM-4.7-Flash-GGUF", "dev")).toBe("vetted");
		expect(status("cline", "lemonade", "GLM-4.7-Flash-GGUF", "plan")).toBe("vetted");
		expect(status("cline", "lemonade", "GLM-4.7-Flash-GGUF", "qa")).toBe("vetted");
		expect(status("cline", "lemonade", "Gemma-4-12B-it-GGUF", "qa")).toBe("vetted");
		expect(status("cline", "lemonade", "Gemma-4-12B-it-GGUF", "dev")).toBe("vetted");
		expect(status("cline", "lemonade", "Gemma-4-12B-it-GGUF", "plan")).toBe("vetted");
		expect(status("cline", "lemonade", "Qwen3.6-35B-A3B-MTP-GGUF", "dev")).toBe("vetted");
		expect(status("cline", "lemonade", "Devstral-Small-2507-GGUF", "qa")).toBe("rejected");
		expect(status("cline", "lemonade", "Devstral-Small-2507-GGUF", "dev")).toBe("rejected");
		expect(status("cline", "lemonade", "Qwen3-Coder-Next-GGUF-Q4_K_M", "plan")).toBe("rejected");
		expect(status("cline", "lemonade", "Laguna-S-2.1-GGUF-UD-Q4_K_XL", "plan")).toBe("vetted");
		expect(status("cline", "lemonade", "gemma-4-31B-it-GGUF-Q4_K_M", "qa")).toBe("vetted");
		expect(status("cline", "lemonade", "gemma-4-31B-it-GGUF-Q4_K_M", "dev")).toBe("provisional");
		// Another provider is another combination.
		expect(status("cline", "lemonade", "us.anthropic.claude-haiku-5-5", "qa")).toBe("unknown");
	});

	it("holds the kits' old dropped lists: rejected on every agent and provider, never picked by a tier", () => {
		expect("dropped" in teamKitJson).toBe(false);
		expect("dropped" in teamLocalKitJson).toBe(false);
		const rejected = listModelWideRejections(getVettedRegistry()).map((entry) => entry.model);
		expect(rejected).toEqual(
			expect.arrayContaining([
				"qwen.qwen3-next-80b-a3b",
				"openai.gpt-oss-120b-1:0",
				"nvidia.nemotron-super-3-120b",
				"us.openai.gpt-6-luna",
				"us.anthropic.claude-sonnet-5-5",
				"LMX-Omni-52B-Halo",
			]),
		);
		const verdict = lookupVetting(
			getVettedRegistry(),
			{ agentId: "codex", provider: "bedrock", model: "us.openai.gpt-6-luna" },
			"dev",
		);
		expect(verdict).toMatchObject({ status: "rejected", reason: expect.stringContaining("lost the tier-3 runoff") });
		const team = getBuiltInKits().get("team");
		if (!team) {
			throw new Error("no team kit");
		}
		const withRejected = {
			...team,
			tiers: {
				t: [{ provider: "bedrock", model: "qwen.qwen3-next-80b-a3b", default: true }, { model: "ok-model" }],
			},
		};
		expect(lookupTierModel(withRejected, "t")).toMatchObject({ ok: true, choice: { model: "ok-model" } });
	});

	it("answers the least permissive entry when several fit, and refuses bad documents", () => {
		const registry = parseVettedRegistry({
			registry: 1,
			entries: [
				{ agent: "cline", provider: "a", model: "m", roles: { dev: vetted } },
				{ agent: "cline", provider: "b", model: "m", roles: { dev: { ...vetted, status: "provisional" } } },
			],
		});
		expect(lookupVetting(registry, { agentId: "cline", provider: "a", model: "m" }, "dev").status).toBe("vetted");
		expect(lookupVetting(registry, { agentId: "cline", provider: null, model: "m" }, "dev").status).toBe(
			"provisional",
		);
		const entry = { agent: "cline", provider: "a", model: "m", roles: { dev: vetted } };
		expect(() => parseVettedRegistry({ registry: 1, entries: [entry, entry] })).toThrow(/one entry per combination/u);
		expect(() =>
			parseVettedRegistry({
				registry: 1,
				entries: [{ ...entry, rejected: { at: "2026-10-09", reason: "x" } }],
			}),
		).toThrow(/no role can be vetted/u);
		expect(() =>
			parseVettedRegistry({
				registry: 1,
				entries: [{ ...entry, roles: { dev: { ...vetted, status: "rejected" } } }],
			}),
		).toThrow(/needs a reason/u);
		expect(() =>
			parseVettedRegistry({ registry: 1, entries: [{ agent: "cline", provider: null, model: "m" }] }),
		).toThrow(/a role vetting or rejected/u);
		expect(() => parseVettedRegistry({ registry: 1, entries: [{ ...entry, agent: "nope" }] })).toThrow();
	});
});
