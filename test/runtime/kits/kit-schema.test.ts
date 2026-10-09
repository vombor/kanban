import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	type KitDocument,
	kitDocumentObjectSchema,
	kitDocumentSchema,
	listLegacyKitKeys,
} from "../../../src/kits/kit-schema";
import { getBuiltInKits, parseUserKit } from "../../../src/kits/resolve-kit";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

function readKitFile(name: string): unknown {
	return JSON.parse(readFileSync(join(REPO_ROOT, "kits", `${name}.json`), "utf8"));
}

describe("kit schema", () => {
	it("parses the built-in kits", () => {
		expect(kitDocumentSchema.safeParse(readKitFile("default")).success).toBe(true);
		expect(kitDocumentSchema.safeParse(readKitFile("team")).success).toBe(true);
		expect([...getBuiltInKits().keys()]).toEqual(["default", "team", "team-local"]);
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
		expect(parseUserKit({ kit: 1, name: "mine" }, "other").ok).toBe(false);
		expect(
			parseUserKit({ kit: 1, name: "mine", qa: { enabled: true, default: { agent: "codex" } } }, "mine").ok,
		).toBe(true);
	});

	it("carries foo's live routing in the team kit", () => {
		const team = getBuiltInKits().get("team");
		expect(team?.roles?.dev).toMatchObject({ agent: "cline", tier: "tier3" });
		expect(team?.tiers?.tier3?.find((entry) => entry.default)?.model).toBe("us.openai.gpt-6.1-sol");
		expect(team?.roles?.qa).toMatchObject({ agent: "codex" });
		expect(team?.roles?.qa?.model).toBeUndefined();
		expect(team?.qa?.routes).toEqual([
			expect.objectContaining({
				devModel: "(^|\\.)openai\\.|^gpt-",
				agent: "cline",
				model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
				rules: ["drive"],
			}),
		]);
		expect(team?.qa?.rules?.drive).toContain("DRIVE THE CHANGED PATH");
		expect(team?.onFail).toMatchObject({ rework: "same-model", reworkRounds: 3, conflict: "rework" });
		expect(team?.onFail?.then).toBe("escalate");
		// The fallback is team definition since 2026-10-09 (formerly foo's escalate/onOutage overrides).
		expect(team?.roles?.fallback).toMatchObject({ tier: "tier2" });
		expect(team?.fallback).toMatchObject({
			on: { qaFails: true, qaStalled: true, unchanged: true, conflict: true, outage: true },
			requireApproval: false,
		});
		for (const name of ["default", "team", "team-local"]) {
			expect(listLegacyKitKeys(getBuiltInKits().get(name) as KitDocument)).toEqual([]);
		}
		expect(team?.recommends?.landingMode).toBe("qa");
	});
});
