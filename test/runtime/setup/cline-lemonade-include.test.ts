// `models.lists.lemonade.include` (the user's choice of models Cline's lemonade provider offers, 2026-10-12): the
// models.json plan, kanban setup-provider lemonade, the context sync and doctor's rows, on a fake Lemonade and a temp
// models.json (never the real ~/.cline or Lemonade).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { checkClineLemonadeModels } from "../../../src/doctor/cline-models-checks";
import { checkKitLemonadeModels } from "../../../src/doctor/kit-settings-checks";
import { loadKitCatalog } from "../../../src/kits/resolve-kit";
import { applyClineLemonadeEntry } from "../../../src/setup/cline-lemonade-apply";
import { syncClineLemonadeContextWindows } from "../../../src/setup/cline-lemonade-context-sync";
import { planClineLemonadeModels } from "../../../src/setup/cline-lemonade-models";
import { createFakeLemonadeFetch, LEMONADE_MODELS_PAYLOAD } from "../../utilities/lemonade-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

const ORIGIN = "http://127.0.0.1:3485";
const LABELS = ["tool-calling"];
// Gemma first: the include's order decides the new default. Not-Downloaded and Gone can't be offered.
const INCLUDE = ["Gemma-4-12B-it-GGUF", "GLM-4.7-Flash-GGUF", "Not-Downloaded-GGUF", "Gone-GGUF"];
const NOW = new Date("2026-10-12T08:00:00.000Z");

type Models = Record<string, Record<string, unknown>>;

function entry(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
	return { id, name: id, supportsVision: false, supportsReasoning: false, inputPrice: 0, outputPrice: 0, ...fields };
}

function clineModelsFile(models: unknown, defaultModelId = "Devstral-Small-2507-GGUF"): Record<string, unknown> {
	return {
		version: 1,
		providers: {
			lemonade: {
				provider: {
					name: "Lemonade (local)",
					baseUrl: "http://lemonade.test:13305/api/v1",
					modelsSourceUrl: `${ORIGIN}/api/model-lists/lemonade`,
					defaultModelId,
					protocol: "openai-chat",
				},
				models,
			},
		},
	};
}

describe("models.lists.lemonade.include", () => {
	let dir: { path: string; cleanup: () => void };
	let modelsPath: string;

	beforeEach(() => {
		dir = createTempDir("kanban-cline-lemonade-include-");
		modelsPath = join(dir.path, "models.json");
	});

	afterEach(() => {
		dir.cleanup();
	});

	function write(document: unknown): string {
		const raw = `${JSON.stringify(document, null, 2)}\n`;
		writeFileSync(modelsPath, raw, { mode: 0o640 });
		return raw;
	}

	function readEntry(): { provider: Record<string, unknown>; models: Models } {
		const document = JSON.parse(readFileSync(modelsPath, "utf8")) as {
			providers: { lemonade: { provider: Record<string, unknown>; models: Models } };
		};
		return document.providers.lemonade;
	}

	// Devstral and Mystery are listed by Lemonade but left out; GLM's window is stale.
	function currentFile(): Record<string, unknown> {
		return clineModelsFile({
			"Devstral-Small-2507-GGUF": entry("Devstral-Small-2507-GGUF", { contextWindow: 4096, maxTokens: 1024 }),
			"GLM-4.7-Flash-GGUF": entry("GLM-4.7-Flash-GGUF", { contextWindow: 65536, maxTokens: 16384 }),
			"Mystery-Coder-GGUF": entry("Mystery-Coder-GGUF"),
		});
	}

	it("plans the models record to exactly the included set, with the reason, and fixes defaultModelId", async () => {
		write(currentFile());
		const plan = await planClineLemonadeModels({
			modelsPath,
			requireLabels: LABELS,
			include: INCLUDE,
			fetch: createFakeLemonadeFetch(),
		});
		if (plan.kind !== "found") {
			throw new Error(plan.details.join("; "));
		}
		expect(Object.keys(plan.models)).toEqual(["GLM-4.7-Flash-GGUF", "Gemma-4-12B-it-GGUF"]);
		expect(plan.diff.added).toEqual(["Gemma-4-12B-it-GGUF"]);
		expect(plan.diff.removed).toEqual(["Devstral-Small-2507-GGUF", "Mystery-Coder-GGUF"]);
		expect(plan.details).toContain("Devstral-Small-2507-GGUF: remove (not in models.lists.lemonade.include)");
		expect(plan.details).toContain("Mystery-Coder-GGUF: remove (not in models.lists.lemonade.include)");
		expect(plan.defaultModel).toEqual({
			from: "Devstral-Small-2507-GGUF",
			to: "Gemma-4-12B-it-GGUF",
			reason: "not in models.lists.lemonade.include",
		});
		expect(plan.details).toContain(
			"defaultModelId: Devstral-Small-2507-GGUF -> Gemma-4-12B-it-GGUF (Devstral-Small-2507-GGUF: not in models.lists.lemonade.include)",
		);
		expect(plan.unlistedIncluded).toEqual(["Not-Downloaded-GGUF is not downloaded", "Gone-GGUF is not on Lemonade"]);

		// Without an include every listed model stays, and a default Lemonade still lists is kept.
		const all = await planClineLemonadeModels({
			modelsPath,
			requireLabels: LABELS,
			fetch: createFakeLemonadeFetch(),
		});
		expect(all.kind === "found" && Object.keys(all.models)).toHaveLength(6);
		expect(all.kind === "found" && all.defaultModel).toBeNull();
		expect(all.kind === "found" && all.unlistedIncluded).toEqual([]);
	});

	it("moves a default Lemonade no longer lists to the first model, even without an include", async () => {
		write(clineModelsFile({ "GLM-4.7-Flash-GGUF": entry("GLM-4.7-Flash-GGUF") }, "Removed-GGUF"));
		const plan = await planClineLemonadeModels({
			modelsPath,
			requireLabels: LABELS,
			fetch: createFakeLemonadeFetch(),
		});
		expect(plan.kind === "found" && plan.defaultModel).toEqual({
			from: "Removed-GGUF",
			to: "Devstral-Small-2507-GGUF",
			reason: "Lemonade no longer lists it",
		});
		// With Lemonade down nothing is compared, the default included.
		const down = await planClineLemonadeModels({
			modelsPath,
			requireLabels: LABELS,
			include: INCLUDE,
			fetch: createFakeLemonadeFetch({ down: true }),
		});
		expect(down.kind === "found" && down.defaultModel).toBeNull();
	});

	it("setup-provider lemonade writes the included set and the new defaultModelId, then is in sync", async () => {
		write(currentFile());
		const apply = () =>
			applyClineLemonadeEntry({
				modelsPath,
				origin: ORIGIN,
				requireLabels: LABELS,
				include: INCLUDE,
				backupDir: join(dir.path, "kanban-home", "backups", "cline"),
				dryRun: false,
				fetch: createFakeLemonadeFetch(),
				now: NOW,
			});
		const result = await apply();
		expect(result.status).toBe("written");
		expect(result.lines).toContain("Devstral-Small-2507-GGUF: remove (not in models.lists.lemonade.include)");
		expect(result.lines).toContain(
			"defaultModelId: Devstral-Small-2507-GGUF -> Gemma-4-12B-it-GGUF (Devstral-Small-2507-GGUF: not in models.lists.lemonade.include)",
		);
		const written = readEntry();
		expect(Object.keys(written.models).sort()).toEqual(["GLM-4.7-Flash-GGUF", "Gemma-4-12B-it-GGUF"]);
		expect(written.provider).toMatchObject({ defaultModelId: "Gemma-4-12B-it-GGUF", protocol: "openai-chat" });

		const again = await apply();
		expect(again.status).toBe("in-sync");
	});

	it("the context sync writes only included models and leaves an excluded one to the user's command", async () => {
		const before = write(currentFile());
		const result = await syncClineLemonadeContextWindows({
			modelsPath,
			mode: "on",
			requireLabels: LABELS,
			include: INCLUDE,
			backupDir: join(dir.path, "kanban-home", "backups", "cline"),
			fetch: createFakeLemonadeFetch(),
			now: NOW,
		});
		// Devstral's window (4096) is stale too and comes from its recipe, but the include leaves it out.
		expect(result.status).toBe("written");
		expect(result.changes.map((change) => change.id)).toEqual(["GLM-4.7-Flash-GGUF"]);
		expect(result.skipped).toEqual([]);
		const written = readEntry();
		expect(written.models["Devstral-Small-2507-GGUF"]).toEqual(
			(JSON.parse(before) as { providers: { lemonade: { models: Models } } }).providers.lemonade.models[
				"Devstral-Small-2507-GGUF"
			],
		);
		expect(written.models["GLM-4.7-Flash-GGUF"]).toMatchObject({ contextWindow: 202752 });
		// Adding Gemma, removing the two and the default are the user's.
		expect(result.userDifferences).toBe(4);
		expect(written.provider.defaultModelId).toBe("Devstral-Small-2507-GGUF");
	});

	describe("doctor rows", () => {
		function check(include: string[] | null) {
			return checkClineLemonadeModels({
				modelsPath,
				origin: ORIGIN,
				lemonadeModelList: { url: "http://lemonade.test:13305", requireLabels: LABELS, include },
				fetch: createFakeLemonadeFetch(),
			});
		}

		it("compares against the included set and names include ids Lemonade can't offer", async () => {
			write(currentFile());
			const [warn] = await check(INCLUDE);
			expect(warn?.level).toBe("warn");
			expect(warn?.message).toContain("Mystery-Coder-GGUF: remove (not in models.lists.lemonade.include)");
			expect(warn?.message).toContain("defaultModelId: Devstral-Small-2507-GGUF -> Gemma-4-12B-it-GGUF");
			expect(warn?.message).toContain(
				"models.lists.lemonade.include names models Lemonade can't offer: Not-Downloaded-GGUF is not downloaded; Gone-GGUF is not on Lemonade",
			);
			expect(warn?.hint).toBe("kanban setup-provider lemonade --origin http://127.0.0.1:3485");

			// In sync with the included set: the file passes, but the include list still warns.
			const include = ["Gemma-4-12B-it-GGUF", "GLM-4.7-Flash-GGUF"];
			await applyClineLemonadeEntry({
				modelsPath,
				origin: ORIGIN,
				requireLabels: LABELS,
				include,
				backupDir: join(dir.path, "backups"),
				dryRun: false,
				fetch: createFakeLemonadeFetch(),
				now: NOW,
			});
			expect(await check(include)).toMatchObject([{ level: "pass" }]);
			const [unlisted] = await check([...include, "Gone-GGUF"]);
			expect(unlisted).toMatchObject({
				level: "warn",
				message: expect.stringContaining("Gone-GGUF is not on Lemonade"),
				hint: expect.stringContaining("kanban config set models.lists.lemonade.include"),
			});
		});

		it("warns when a project's kit routes to a Lemonade model the include leaves out", async () => {
			const kits = createTempDir("kanban-kits-");
			try {
				const roles = [
					"Qwen3.8-27B-GGUF-UD-Q4_K_XL",
					"gemma-4-31B-it-qat-q4_0-gguf-Q4_0",
					"Devstral-Small-2-24B-Instruct-2512-GGUF-Q4_K_M",
				];
				const models = {
					...LEMONADE_MODELS_PAYLOAD,
					data: [
						...LEMONADE_MODELS_PAYLOAD.data,
						...roles.map((id) => ({ id, owned_by: "lemonade", downloaded: true, labels: ["tool-calling"] })),
					],
				};
				const findings = await checkKitLemonadeModels({
					config: parsePipelineConfig({
						workspaces: { local: { landing: { mode: "qa" }, kit: { name: "team-local", overrides: {} } } },
					}).config,
					catalog: await loadKitCatalog(kits.path),
					entries: [{ workspaceId: "local" }],
					lemonadeModelList: {
						url: "http://lemonade.test:13305",
						requireLabels: LABELS,
						include: ["gemma-4-31B-it-qat-q4_0-gguf-Q4_0"],
					},
					fetch: createFakeLemonadeFetch({ models }),
				});
				const row = findings.find((finding) => finding.message.includes("routes to Lemonade models"));
				expect(row?.level).toBe("warn");
				expect(row?.message).toContain(
					"Qwen3.8-27B-GGUF-UD-Q4_K_XL is not in models.lists.lemonade.include (Cline's list leaves it out)",
				);
				expect(row?.message).not.toContain("gemma-4-31B-it-qat-q4_0-gguf-Q4_0 is not in");
				expect(row?.hint).toContain("kanban config set models.lists.lemonade.include");
			} finally {
				kits.cleanup();
			}
		});
	});
});
