import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { RuntimeBoardData } from "../../../src/core/api-contract";
import { checkClineModelsAllowList } from "../../../src/doctor/cline-models-allow-list-checks";
import { loadKitCatalog } from "../../../src/kits/resolve-kit";
import { createTempDir } from "../../utilities/temp-dir";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const MUSE = "Muse-Glimmer-30B-GGUF-Q4_K_M";
const GEMMA = "gemma-4-31B-it-qat-q4_0-gguf-Q4_0";
const LAGUNA = "Laguna-XS-2.1-GGUF-Q4_K_M";

describe("doctor: Cline's models.json is the allow list", () => {
	let root: { path: string; cleanup: () => void };
	let modelsPath: string;

	beforeEach(() => {
		root = createTempDir("kanban-cline-allow-list-");
		modelsPath = join(root.path, "settings", "models.json");
		mkdirSync(join(root.path, "settings"), { recursive: true });
	});

	afterEach(() => {
		root.cleanup();
	});

	function writeModels(lemonadeModels: unknown): void {
		writeFileSync(
			modelsPath,
			JSON.stringify({
				version: 1,
				providers: { lemonade: { provider: { name: "Lemonade" }, models: lemonadeModels } },
			}),
		);
	}

	async function check(options: { kit?: string; board?: RuntimeBoardData | null } = {}) {
		const kitsDir = createTempDir("kanban-kits-");
		try {
			return await checkClineModelsAllowList({
				config: parsePipelineConfig({
					workspaces: options.kit ? { local: { kit: { name: options.kit } } } : {},
				}).config,
				catalog: await loadKitCatalog(kitsDir.path),
				entries: [{ workspaceId: "local" }],
				modelsPath,
				selectedAgentId: "cline",
				loadBoard: async () => options.board ?? null,
			});
		} finally {
			kitsDir.cleanup();
		}
	}

	it("warns about a kit role on a Lemonade model the record doesn't list, nothing more", async () => {
		writeModels({ [MUSE]: {}, [GEMMA]: {} });
		const findings = await check({ kit: "team-local" });
		expect(findings).toEqual([
			{
				level: "warn",
				area: "project",
				message: `local: kit team (lemonade) roles.fallback puts Cline cards on lemonade + ${LAGUNA}, which lemonade's models record in Cline's models.json doesn't list, so Cline couldn't select it`,
				hint: expect.stringContaining("kanban models vet"),
			},
		]);
		writeModels([MUSE, GEMMA, LAGUNA]);
		expect(await check({ kit: "team-local" })).toEqual([]);
	});

	it("warns about open Cline cards on an unlisted model; other agents, providers without a record and Done cards are not checked", async () => {
		writeModels({ [MUSE]: {} });
		const board = createBoard({
			backlog: [
				createCard({ id: "c0001", agentSettings: { providerId: "lemonade", modelId: "Other-GGUF" } }),
				// The selected agent (Cline) with a provider from models.providers: bedrock has no record here.
				createCard({ id: "c0002", agentSettings: { modelId: "us.openai.gpt-6.1-sol" } }),
				createCard({ id: "c0003", agentId: "claude", agentSettings: { providerId: "lemonade", modelId: "x" } }),
				createCard({ id: "c0004", agentSettings: { providerId: "lemonade", modelId: MUSE } }),
			],
			trash: [createCard({ id: "c0005", agentSettings: { providerId: "lemonade", modelId: "Gone-GGUF" } })],
		});
		const findings = await check({ board });
		expect(findings).toEqual([
			expect.objectContaining({
				level: "warn",
				message: expect.stringMatching(
					/^local: 1 card\(s\) run Cline on a model .*: c0001 \(lemonade \+ Other-GGUF\)$/u,
				),
			}),
		]);
	});

	it("says nothing without models.json", async () => {
		expect(await check({ kit: "team-local" })).toEqual([]);
	});
});
