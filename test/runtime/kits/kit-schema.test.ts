import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	type KitDocument,
	kitDocumentObjectSchema,
	kitDocumentSchema,
	kitPresetSchema,
	listLegacyKitKeys,
} from "../../../src/kits/kit-schema";
import { createRoutingPolicy, getModelVendor } from "../../../src/kits/policy";
import { getBuiltInKits, getBuiltInPresets, parseUserKit } from "../../../src/kits/resolve-kit";
import { createCardHistory, createEffectiveCard } from "../../utilities/effective-card";
import { resolveTeamKit } from "../../utilities/team-kits";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

function readKitFile(name: string): unknown {
	return JSON.parse(readFileSync(join(REPO_ROOT, "kits", `${name}.json`), "utf8"));
}

describe("kit schema", () => {
	it("parses the built-in kits and the team kit's presets", () => {
		expect(kitDocumentSchema.safeParse(readKitFile("default")).success).toBe(true);
		expect(kitDocumentSchema.safeParse(readKitFile("team")).success).toBe(true);
		for (const preset of ["cloud", "cline", "lemonade"]) {
			expect(kitPresetSchema.safeParse(readKitFile(`presets/${preset}`)).success).toBe(true);
		}
		expect([...getBuiltInKits().keys()]).toEqual(["default", "team"]);
		expect([...getBuiltInPresets().keys()]).toEqual(["cloud", "cline", "lemonade"]);
	});

	it("a preset can't carry a workflow key: only models, tiers, plan candidates, the price region and its notes", () => {
		const base = { preset: 1, name: "x", roles: { dev: { agent: "codex", model: "m" } } };
		expect(kitPresetSchema.safeParse(base).success).toBe(true);
		for (const workflow of [
			{ onFail: { reworkRounds: 1 } },
			{ fallback: { requireApproval: true } },
			{ fallback: { on: { outage: false } } },
			{ qa: { enabled: false } },
			{ qa: { routes: [] } },
			{ features: ["scoreboard"] },
			{ plan: { startInPlanMode: false } },
			{ prices: { autoSync: true } },
			{ recommends: { landingMode: "off" } },
			{ land: { postLand: [] } },
		]) {
			expect(kitPresetSchema.safeParse({ ...base, ...workflow }).success, JSON.stringify(workflow)).toBe(false);
		}
	});

	it("rejects unknown keys at every level", () => {
		expect(kitDocumentSchema.safeParse({ kit: 1, name: "x", qaAgent: "codex" }).success).toBe(false);
		expect(kitDocumentSchema.safeParse({ kit: 1, name: "x", qa: { enable: true } }).success).toBe(false);
		expect(
			kitDocumentSchema.safeParse({
				kit: 1,
				name: "x",
				qa: { routes: [{ devModel: "x", agent: "codex", modle: "m" }] },
			}).success,
		).toBe(false);
	});

	it("rejects another schema version, bad names, bad regexes and unknown agents", () => {
		expect(kitDocumentSchema.safeParse({ kit: 2, name: "x" }).success).toBe(false);
		expect(kitDocumentSchema.safeParse({ kit: 1, name: "../x" }).success).toBe(false);
		expect(
			kitDocumentSchema.safeParse({ kit: 1, name: "x", qa: { routes: [{ devModel: "(", agent: "codex" }] } })
				.success,
		).toBe(false);
		expect(kitDocumentSchema.safeParse({ kit: 1, name: "x", dev: { agent: "nobody" } }).success).toBe(false);
	});

	it("accepts the legacy cline-cli agent id as cline", () => {
		const parsed = kitDocumentSchema.parse({ kit: 1, name: "x", roles: { dev: { agent: "cline-cli" } } });
		expect(parsed.roles?.dev?.agent).toBe("cline");
	});

	it("validates roles: known roles only, model or tier (not both), provider needs model, model needs agent", () => {
		const parse = (roles: unknown) => kitDocumentSchema.safeParse({ kit: 1, name: "x", roles }).success;
		expect(parse({ dev: { agent: "codex", model: "m", provider: "bedrock" } })).toBe(true);
		expect(parse({ fallback: { model: "m" } })).toBe(true);
		expect(parse({ senior: { agent: "codex" } })).toBe(false);
		expect(parse({ dev: { agent: "codex", model: "m", tier: "t" } })).toBe(false);
		expect(parse({ dev: { agent: "codex", provider: "bedrock" } })).toBe(false);
		expect(parse({ dev: { model: "m" } })).toBe(false);
		expect(parse({ qa: { agent: "codex", tier: "missing" } })).toBe(false);
	});

	it("refuses a fallback trigger without a fallback role, and legacy keys on a resolved kit", () => {
		expect(kitDocumentSchema.safeParse({ kit: 1, name: "x", fallback: { on: { qaFails: true } } }).success).toBe(
			false,
		);
		expect(
			kitDocumentSchema.safeParse({ kit: 1, name: "x", fallback: { on: { qaFails: false, outage: false } } })
				.success,
		).toBe(true);
		expect(kitDocumentSchema.safeParse({ kit: 1, name: "x", dev: { agent: "codex" } }).success).toBe(false);
		// A kit file may still carry them: the layer schema parses them, the resolver translates them.
		expect(kitDocumentObjectSchema.safeParse({ kit: 1, name: "x", dev: { agent: "codex" } }).success).toBe(true);
	});

	it("checks keys that refer to each other", () => {
		const unknownRule = kitDocumentSchema.safeParse({
			kit: 1,
			name: "x",
			qa: { routes: [{ devModel: "gpt", agent: "codex", rules: ["drive"] }] },
		});
		expect(unknownRule.success).toBe(false);
		expect(kitDocumentSchema.safeParse({ kit: 1, name: "x", roles: { dev: { model: "m" } } }).success).toBe(false);
		expect(
			kitDocumentSchema.safeParse({
				kit: 1,
				name: "x",
				tiers: {
					t: [
						{ model: "a", default: true },
						{ model: "b", default: true },
					],
				},
			}).success,
		).toBe(false);
	});

	it("refuses a user kit with a built-in name, or a name that isn't its file name", () => {
		const team = parseUserKit({ kit: 1, name: "team" }, "team");
		expect(team.ok).toBe(false);
		expect(team.ok ? "" : team.error).toContain("built-in");
		expect(parseUserKit({ kit: 1, name: "default" }, "default").ok).toBe(false);
		for (const name of ["team-cloud", "team-local", "team-cline"]) {
			const oldName = parseUserKit({ kit: 1, name }, name);
			expect(oldName.ok ? "" : oldName.error).toContain(`"${name}" is the old name of a built-in kit`);
		}
		expect(parseUserKit({ kit: 1, name: "mine" }, "other").ok).toBe(false);
		expect(
			parseUserKit({ kit: 1, name: "mine", qa: { enabled: true, default: { agent: "codex" } } }, "mine").ok,
		).toBe(true);
	});

	it("the team kit holds the one workflow and no models", () => {
		const team = getBuiltInKits().get("team");
		for (const role of ["dev", "qa", "plan", "fallback"] as const) {
			expect(team?.roles?.[role]).toBeDefined();
			expect(team?.roles?.[role]?.agent).toBeUndefined();
			expect(team?.roles?.[role]?.model).toBeUndefined();
			expect(team?.roles?.[role]?.tier).toBeUndefined();
		}
		expect(team?.tiers).toBeUndefined();
		expect(team?.qa).toMatchObject({ enabled: true, requireDifferentVendor: true, routes: [] });
		expect(team?.qa?.rules?.drive).toContain("DRIVE THE CHANGED PATH");
		expect(team?.onFail).toMatchObject({
			rework: "same-model",
			reworkRounds: 3,
			conflict: "rework",
			// biome-ignore lint/suspicious/noThenProperty: the kit key onFail.then; plain data, never awaited.
			then: "escalate",
		});
		// One fixed behaviour for every preset and custom team (user 2026-10-12): every trigger hands the task to the
		// fallback, which starts at once without approval, paid or free.
		expect(team?.fallback).toMatchObject({
			on: { qaFails: true, qaStalled: true, unchanged: true, conflict: true, outage: true },
			requireApproval: false,
		});
		expect(team?.features).toEqual(["scoreboard", "bench", "runoffs", "calibration", "tiers"]);
		expect(team?.plan).toMatchObject({ enabled: true, startInPlanMode: true });
		expect(team?.recommends?.landingMode).toBe("qa");
		for (const name of ["default", "team"]) {
			expect(listLegacyKitKeys(getBuiltInKits().get(name) as KitDocument)).toEqual([]);
		}
	});

	it("every preset resolves to the same workflow; only the models differ", () => {
		const custom = resolveTeamKit(null);
		const workflow = (kit: KitDocument) => {
			const {
				roles: _roles,
				tiers: _tiers,
				tierRules: _rules,
				tierNotes: _notes,
				plan,
				prices,
				recommends,
				dropped: _dropped,
				...rest
			} = kit;
			return {
				...rest,
				plan: { ...plan, candidates: undefined, note: undefined },
				landingMode: recommends?.landingMode,
				autoSync: prices?.autoSync,
			};
		};
		for (const preset of ["cloud", "cline", "lemonade"]) {
			expect(workflow(resolveTeamKit(preset)), preset).toEqual(workflow(custom));
		}
	});

	it("the cloud preset: Sol on Codex builds, Haiku 5.5 on Cline reviews, Opus 5.5 on Cline plans, Kimi K3 on Codex falls back", () => {
		const kit = resolveTeamKit("cloud");
		expect(kit.roles).toMatchObject({
			dev: { agent: "codex", provider: "bedrock", model: "us.openai.gpt-6.1-sol" },
			qa: { agent: "cline", provider: "bedrock", model: "us.anthropic.claude-haiku-5-5" },
			plan: { agent: "cline", provider: "bedrock", model: "us.anthropic.claude-opus-5-5" },
			fallback: { agent: "codex", provider: "bedrock", model: "us.moonshotai.kimi-k3" },
		});
		expect(kit.qa?.routes).toEqual([]);
		expect(kit.prices?.region).toBe("us-west-2");
		const policy = createRoutingPolicy(kit);
		// requireDifferentVendor holds: QA (anthropic) differs from dev (openai) and fallback (moonshotai).
		for (const model of ["us.openai.gpt-6.1-sol", "us.moonshotai.kimi-k3"]) {
			expect(getModelVendor(model)).not.toBe("anthropic");
			expect(
				policy.qaPolicy({
					dev: createEffectiveCard({ agentId: "codex", model: { provider: "bedrock", model } }),
					round: 1,
					history: createCardHistory(),
				}),
			).toMatchObject({
				kind: "qa",
				agentId: "cline",
				model: { model: "us.anthropic.claude-haiku-5-5" },
				route: null,
			});
		}
		expect(
			policy.onFail({
				dev: createEffectiveCard({
					agentId: "codex",
					model: { provider: "bedrock", model: "us.openai.gpt-6.1-sol" },
				}),
				cause: "fail",
				verdict: null,
				history: createCardHistory([1, 2, 3]),
				limits: { maxFailRounds: 3 },
			}),
		).toMatchObject({
			action: "escalate",
			to: { agentId: "codex", model: { provider: "bedrock", model: "us.moonshotai.kimi-k3" } },
			requireApproval: false,
		});
	});
});
