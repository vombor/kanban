import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkClineLemonadeModels } from "../../../src/doctor/cline-models-checks";
import {
	type ClineLemonadeModelsPlan,
	type LemonadeModelsPlan,
	maxTokensForContextWindow,
	planClineLemonadeModels,
} from "../../../src/setup/cline-lemonade-models";
import { createFakeLemonadeFetch, LEMONADE_HEALTH_QWEN_LOADED_PAYLOAD } from "../../utilities/lemonade-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

const LABELS = ["tool-calling"];

// The pod's ~/.cline/data/settings/models.json on 2026-10-07 (models as a list), with Lemonade at a test origin.
function clineModelsFile(models: unknown): Record<string, unknown> {
	return {
		version: 1,
		providers: {
			lemonade: {
				provider: {
					name: "Lemonade (local)",
					baseUrl: "http://lemonade.test:13305/api/v1",
					modelsSourceUrl: "http://127.0.0.1:3485/api/model-lists/lemonade",
					defaultModelId: "GLM-4.7-Flash-GGUF",
					protocol: "openai-chat",
					capabilities: ["tools"],
				},
				models,
			},
			other: { provider: { name: "Other", baseUrl: "http://other.test/v1" }, models: ["x"] },
		},
	};
}

function found(plan: ClineLemonadeModelsPlan): LemonadeModelsPlan {
	if (plan.kind !== "found") {
		throw new Error(`no Lemonade entry: ${plan.details.join("; ")}`);
	}
	return plan;
}

describe("Cline models.json Lemonade metadata plan", () => {
	let dir: { path: string; cleanup: () => void };
	let modelsPath: string;

	beforeEach(() => {
		dir = createTempDir("kanban-cline-lemonade-");
		modelsPath = join(dir.path, "models.json");
	});

	afterEach(() => {
		dir.cleanup();
	});

	function write(document: unknown): void {
		writeFileSync(modelsPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o640 });
	}

	function plan(fetchImpl: typeof fetch = createFakeLemonadeFetch()) {
		return planClineLemonadeModels({ modelsPath, fetch: fetchImpl });
	}

	it("sizes maxTokens at a quarter of the window, at most 32K", () => {
		expect(maxTokensForContextWindow(202752)).toBe(32768);
		expect(maxTokensForContextWindow(65536)).toBe(16384);
		expect(maxTokensForContextWindow(4096)).toBe(1024);
	});

	it("fills in the record's own models from Lemonade, never adds or removes one, and writes nothing", async () => {
		write(clineModelsFile(["Qwen3-Coder-Next-GGUF", "GLM-4.7-Flash-GGUF", "Gemma-4-12B-it-GGUF"]));
		const before = readFileSync(modelsPath, "utf8");
		const fetchImpl = createFakeLemonadeFetch();

		const result = found(await plan(fetchImpl));
		expect(result.inSync).toBe(false);
		expect(result.diff).toEqual({ listForm: true, changed: expect.any(Array) });
		expect(result.unlisted).toEqual(["Qwen3-Coder-Next-GGUF"]);
		expect(result.details).toContain(
			"models is a list, which cline 3.x rejects (it drops the provider): rewrite as a record by id",
		);
		expect(result.details).toContain(
			"GLM-4.7-Flash-GGUF: contextWindow (unset) -> 202752 (recipe ctx_size), maxTokens (unset) -> 32768, supportsVision (unset) -> false, supportsReasoning (unset) -> false, inputPrice (unset) -> 0, outputPrice (unset) -> 0",
		);
		expect(result.details).toContain(
			"Qwen3-Coder-Next-GGUF: in the models record but Lemonade doesn't list it (kept; a card on it fails until Lemonade has it or the orchestrator takes it out of models.json)",
		);
		// Metadata comes from the server Cline talks to (the provider's baseUrl).
		expect(fetchImpl.urls).toContain("http://lemonade.test:13305/api/v1/models");
		expect(readFileSync(modelsPath, "utf8")).toBe(before);
		expect(readdirSync(dir.path)).toEqual(["models.json"]);

		// Exactly the record's models: the orchestrator's allow list, not every model Lemonade has.
		expect(result.models).toEqual({
			"Qwen3-Coder-Next-GGUF": { id: "Qwen3-Coder-Next-GGUF", name: "Qwen3-Coder-Next-GGUF" },
			"GLM-4.7-Flash-GGUF": {
				id: "GLM-4.7-Flash-GGUF",
				name: "GLM-4.7-Flash-GGUF",
				contextWindow: 202752,
				maxTokens: 32768,
				supportsVision: false,
				supportsReasoning: false,
				inputPrice: 0,
				outputPrice: 0,
			},
			"Gemma-4-12B-it-GGUF": {
				id: "Gemma-4-12B-it-GGUF",
				name: "Gemma-4-12B-it-GGUF",
				contextWindow: 65536,
				maxTokens: 16384,
				supportsVision: true,
				supportsReasoning: false,
				inputPrice: 0,
				outputPrice: 0,
			},
		});
	});

	it("fills in a model Lemonade has no context info for with Cline's default, and one not downloaded too", async () => {
		write(clineModelsFile({ "Mystery-Coder-GGUF": {}, "Not-Downloaded-GGUF": {} }));
		const result = found(await plan());
		expect(result.unlisted).toEqual([]);
		expect(result.models["Mystery-Coder-GGUF"]).toEqual({
			id: "Mystery-Coder-GGUF",
			name: "Mystery-Coder-GGUF",
			supportsVision: false,
			supportsReasoning: false,
			inputPrice: 0,
			outputPrice: 0,
		});
		expect(Object.keys(result.models)).toEqual(["Mystery-Coder-GGUF", "Not-Downloaded-GGUF"]);
	});

	it("is in sync once the file has the wanted record", async () => {
		write(clineModelsFile(["GLM-4.7-Flash-GGUF", "Mystery-Coder-GGUF"]));
		write(clineModelsFile(found(await plan()).models));

		const again = found(await plan());
		expect(again.inSync).toBe(true);
		expect(again.details).toEqual([
			"2 model(s) in sync: GLM-4.7-Flash-GGUF 202752, Mystery-Coder-GGUF 128000 (Cline default)",
		]);
	});

	it("keeps the user's names and other keys, and follows Lemonade when a window changes", async () => {
		write(
			clineModelsFile({
				"GLM-4.7-Flash-GGUF": {
					id: "GLM-4.7-Flash-GGUF",
					name: "GLM Flash",
					contextWindow: 128000,
					temperature: 0.6,
					inputPrice: 1,
				},
			}),
		);
		const result = found(await plan(createFakeLemonadeFetch({ health: LEMONADE_HEALTH_QWEN_LOADED_PAYLOAD })));
		expect(result.models["GLM-4.7-Flash-GGUF"]).toEqual({
			id: "GLM-4.7-Flash-GGUF",
			name: "GLM Flash",
			contextWindow: 202752,
			temperature: 0.6,
			inputPrice: 1,
			maxTokens: 32768,
			supportsVision: false,
			supportsReasoning: false,
			outputPrice: 0,
		});
		expect(result.details).toContain(
			"GLM-4.7-Flash-GGUF: contextWindow 128000 -> 202752 (recipe ctx_size), maxTokens (unset) -> 32768, supportsVision (unset) -> false, supportsReasoning (unset) -> false, outputPrice (unset) -> 0",
		);
	});

	it("takes a loaded model's ctx_size: what llama-server runs it with", async () => {
		write(clineModelsFile({ "Qwen3.6-35B-A3B-MTP-GGUF": {} }));
		const result = found(await plan(createFakeLemonadeFetch({ health: LEMONADE_HEALTH_QWEN_LOADED_PAYLOAD })));
		expect(result.models["Qwen3.6-35B-A3B-MTP-GGUF"]?.contextWindow).toBe(98304);
	});

	it("never claims more than a positive global ctx_size for a model without its own", async () => {
		write(clineModelsFile({ "Qwen3.6-35B-A3B-MTP-GGUF": {}, "Mystery-Coder-GGUF": {}, "GLM-4.7-Flash-GGUF": {} }));
		const { models } = found(await plan(createFakeLemonadeFetch({ params: { ctx_size: 32768 } })));
		expect(models["Qwen3.6-35B-A3B-MTP-GGUF"]?.contextWindow).toBe(32768);
		expect(models["Mystery-Coder-GGUF"]?.contextWindow).toBe(32768);
		expect(models["GLM-4.7-Flash-GGUF"]?.contextWindow).toBe(202752);
	});

	it("with Lemonade down wants no value changed, and only a list rewritten", async () => {
		const record = {
			"GLM-4.7-Flash-GGUF": { id: "GLM-4.7-Flash-GGUF", name: "GLM-4.7-Flash-GGUF", contextWindow: 202752 },
		};
		write(clineModelsFile(record));
		const down = found(await plan(createFakeLemonadeFetch({ down: true })));
		expect(down.inSync).toBe(false);
		expect(down.unreachable).toBe(
			"Lemonade at http://lemonade.test:13305/api/v1 did not answer (fetch failed); model values can't be compared",
		);
		expect(down.details).toEqual([down.unreachable]);
		expect(down.models).toEqual(record);

		write(clineModelsFile(["GLM-4.7-Flash-GGUF"]));
		const list = found(await plan(createFakeLemonadeFetch({ down: true })));
		expect(list.diff.listForm).toBe(true);
		expect(list.models).toEqual({
			"GLM-4.7-Flash-GGUF": { id: "GLM-4.7-Flash-GGUF", name: "GLM-4.7-Flash-GGUF" },
		});
	});

	it("skips a machine without models.json or a Lemonade provider, and reports a broken file", async () => {
		const fetchImpl = createFakeLemonadeFetch();
		expect((await plan(fetchImpl)).kind).toBe("absent");
		write({ version: 1, providers: { other: { models: {} } } });
		expect((await plan(fetchImpl)).kind).toBe("absent");
		writeFileSync(modelsPath, "{ not json");
		expect((await plan(fetchImpl)).kind).toBe("error");
		expect(fetchImpl.urls).toEqual([]);
	});

	describe("doctor row", () => {
		function check(fetchImpl: typeof fetch = createFakeLemonadeFetch()) {
			return checkClineLemonadeModels({
				modelsPath,
				lemonadeModelList: { url: "http://lemonade.test:13305", requireLabels: LABELS, include: null },
				fetch: fetchImpl,
			});
		}

		it("warns with the differences and the command, passes in sync, is INFO with Lemonade down", async () => {
			expect(await check()).toEqual([]);

			write(clineModelsFile({ "GLM-4.7-Flash-GGUF": { contextWindow: 128000 }, "Old-GGUF": {} }));
			const before = readFileSync(modelsPath, "utf8");
			const [warn] = await check();
			expect(warn?.level).toBe("warn");
			expect(warn?.message).toContain("GLM-4.7-Flash-GGUF: contextWindow 128000 -> 202752 (recipe ctx_size)");
			expect(warn?.message).not.toContain("Gemma-4-12B-it-GGUF");
			expect(warn?.message).toContain("Old-GGUF: in the models record but Lemonade doesn't list it");
			expect(warn?.hint).toBe("kanban setup-provider lemonade");
			expect(readFileSync(modelsPath, "utf8")).toBe(before);

			const [down] = await check(createFakeLemonadeFetch({ down: true }));
			expect(down?.level).toBe("info");
			expect(down?.message).toContain("did not answer");

			// In sync but a model Lemonade doesn't list: a warning the command can't fix.
			write(clineModelsFile(found(await plan()).models));
			const [unlisted] = await check();
			expect(unlisted?.level).toBe("warn");
			expect(unlisted?.hint).toBe("pull the model in Lemonade, or take it out of models.json's lemonade record");

			write(clineModelsFile({ "GLM-4.7-Flash-GGUF": {} }));
			write(clineModelsFile(found(await plan()).models));
			const [pass] = await check();
			expect(pass?.level).toBe("pass");
			expect(pass?.message).toContain("1 model(s) in sync");
		});

		it("says what the Lemonade context sync will write, or that it is off", async () => {
			write(clineModelsFile({ "GLM-4.7-Flash-GGUF": { contextWindow: 65536, maxTokens: 16384 } }));
			const run = (mode: "on" | "report" | "off") =>
				checkClineLemonadeModels({
					modelsPath,
					lemonadeModelList: { url: "http://lemonade.test:13305", requireLabels: LABELS, include: null },
					contextSync: { mode, intervalSec: 30 },
					historyPath: "/home/k/data/models/cline-lemonade-sync.jsonl",
					fetch: createFakeLemonadeFetch(),
				});
			const [on] = await run("on");
			expect(on?.level).toBe("warn");
			expect(on?.message).toContain(
				"the server's Lemonade context sync writes the context windows of GLM-4.7-Flash-GGUF within 30s or before the next Cline launch; if they stay, see /home/k/data/models/cline-lemonade-sync.jsonl",
			);
			const [off] = await run("off");
			expect(off?.level).toBe("warn");
			expect(off?.message).toContain(
				"the Lemonade context sync is off (agents.cline.lemonadeContextSync.mode), so the context windows of GLM-4.7-Flash-GGUF change only with the command",
			);
		});
	});
});
