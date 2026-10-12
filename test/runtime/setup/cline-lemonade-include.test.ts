// The Lemonade entry's `provider.defaultModelId` against the models record (the Kanban orchestrator's allow list,
// docs/team/MODELS.md): the models.json plan and kanban setup-provider lemonade move a default the record doesn't
// list to its first model, and `models.lists.lemonade.include` (which only filters the model-lists route) never adds
// or removes a record model. A fake Lemonade and a temp models.json (never the real ~/.cline or Lemonade).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkClineLemonadeModels } from "../../../src/doctor/cline-models-checks";
import { applyClineLemonadeEntry } from "../../../src/setup/cline-lemonade-apply";
import { planClineLemonadeModels } from "../../../src/setup/cline-lemonade-models";
import { createFakeLemonadeFetch } from "../../utilities/lemonade-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

const NOW = new Date("2026-10-12T08:00:00.000Z");

function entry(id: string): Record<string, unknown> {
	return { id, name: id };
}

function clineModelsFile(models: unknown, defaultModelId: string): Record<string, unknown> {
	return {
		version: 1,
		providers: {
			lemonade: {
				provider: {
					name: "Lemonade (local)",
					baseUrl: "http://lemonade.test:13305/api/v1",
					defaultModelId,
					protocol: "openai-chat",
				},
				models,
			},
		},
	};
}

describe("the Lemonade entry's defaultModelId follows the models record", () => {
	let dir: { path: string; cleanup: () => void };
	let modelsPath: string;

	beforeEach(() => {
		dir = createTempDir("kanban-cline-lemonade-default-");
		modelsPath = join(dir.path, "models.json");
	});

	afterEach(() => {
		dir.cleanup();
	});

	function write(document: unknown): void {
		writeFileSync(modelsPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o640 });
	}

	const record = {
		"Gemma-4-12B-it-GGUF": entry("Gemma-4-12B-it-GGUF"),
		"GLM-4.7-Flash-GGUF": entry("GLM-4.7-Flash-GGUF"),
	};

	it("moves a default the record doesn't list to the record's first model, Lemonade up or down", async () => {
		write(clineModelsFile(record, "Removed-GGUF"));
		for (const fetchImpl of [createFakeLemonadeFetch(), createFakeLemonadeFetch({ down: true })]) {
			const plan = await planClineLemonadeModels({ modelsPath, fetch: fetchImpl });
			if (plan.kind !== "found") {
				throw new Error(plan.details.join("; "));
			}
			expect(plan.defaultModel).toEqual({ from: "Removed-GGUF", to: "Gemma-4-12B-it-GGUF" });
			expect(plan.details).toContain(
				"defaultModelId: Removed-GGUF -> Gemma-4-12B-it-GGUF (Removed-GGUF is not in the models record)",
			);
			expect(Object.keys(plan.models)).toEqual(["Gemma-4-12B-it-GGUF", "GLM-4.7-Flash-GGUF"]);
		}
		write(clineModelsFile(record, "GLM-4.7-Flash-GGUF"));
		const kept = await planClineLemonadeModels({ modelsPath, fetch: createFakeLemonadeFetch() });
		expect(kept.kind === "found" && kept.defaultModel).toBeNull();
	});

	it("setup-provider lemonade writes the new defaultModelId and keeps the record, then is in sync", async () => {
		write(clineModelsFile(record, "Removed-GGUF"));
		const apply = () =>
			applyClineLemonadeEntry({
				modelsPath,
				backupDir: join(dir.path, "kanban-home", "backups", "cline"),
				dryRun: false,
				fetch: createFakeLemonadeFetch(),
				now: NOW,
			});
		expect((await apply()).status).toBe("written");
		const written = (
			JSON.parse(readFileSync(modelsPath, "utf8")) as {
				providers: { lemonade: { provider: Record<string, unknown>; models: Record<string, unknown> } };
			}
		).providers.lemonade;
		expect(written.provider).toMatchObject({ defaultModelId: "Gemma-4-12B-it-GGUF", protocol: "openai-chat" });
		expect(Object.keys(written.models)).toEqual(["Gemma-4-12B-it-GGUF", "GLM-4.7-Flash-GGUF"]);
		expect((await apply()).status).toBe("in-sync");
	});

	it("doctor's row ignores models.lists.lemonade.include: the record is what Cline offers", async () => {
		write(clineModelsFile(record, "GLM-4.7-Flash-GGUF"));
		await applyClineLemonadeEntry({
			modelsPath,
			backupDir: join(dir.path, "backups"),
			dryRun: false,
			fetch: createFakeLemonadeFetch(),
			now: NOW,
		});
		const findings = await checkClineLemonadeModels({
			modelsPath,
			lemonadeModelList: {
				url: "http://lemonade.test:13305",
				requireLabels: ["tool-calling"],
				include: ["Devstral-Small-2507-GGUF"],
			},
			fetch: createFakeLemonadeFetch(),
		});
		expect(findings).toMatchObject([{ level: "pass", message: expect.stringContaining("2 model(s) in sync") }]);
	});
});
