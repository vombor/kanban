import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	buildLemonadeModelListUrl,
	isManagedModelsSourceUrl,
	planClineModelsSource,
} from "../../../src/setup/cline-models-source";
import { createTempDir } from "../../utilities/temp-dir";

const TARGET = "http://127.0.0.1:3485/api/model-lists/lemonade";

// The shape of the pod's ~/.cline/data/settings/models.json on 2026-10-07, pointing at the legacy kit service.
function clineModelsFile(modelsSourceUrl?: string): Record<string, unknown> {
	return {
		version: 1,
		providers: {
			lemonade: {
				provider: {
					name: "Lemonade (local)",
					baseUrl: "http://localhost:13305/api/v1",
					...(modelsSourceUrl === undefined ? {} : { modelsSourceUrl }),
					defaultModelId: "Qwen3-Coder-Next-GGUF",
					protocol: "openai-chat",
					capabilities: ["tools"],
				},
				models: ["Qwen3-Coder-Next-GGUF", "gpt-oss-20b-mxfp4-GGUF"],
			},
			other: { provider: { name: "Other", modelsSourceUrl: "http://127.0.0.1:13306/lemonade/models" } },
		},
	};
}

describe("Cline models.json modelsSourceUrl step", () => {
	let dir: { path: string; cleanup: () => void };
	let modelsPath: string;

	beforeEach(() => {
		dir = createTempDir("kanban-cline-models-");
		modelsPath = join(dir.path, "models.json");
	});

	afterEach(() => {
		dir.cleanup();
	});

	function write(document: unknown): void {
		writeFileSync(modelsPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o640 });
	}

	function backups(): string[] {
		return readdirSync(dir.path).filter((name) => name.includes(".bak"));
	}

	it("builds the route URL from a server URL", () => {
		expect(buildLemonadeModelListUrl("http://127.0.0.1:3485/my-workspace")).toBe(TARGET);
	});

	it("recognizes the legacy kit service and the route on any origin", () => {
		expect(isManagedModelsSourceUrl("http://127.0.0.1:13306/lemonade/models")).toBe(true);
		expect(isManagedModelsSourceUrl("http://localhost:13306/lemonade/v1/models/")).toBe(true);
		expect(isManagedModelsSourceUrl("http://127.0.0.1:3484/api/model-lists/lemonade")).toBe(true);
		expect(isManagedModelsSourceUrl("http://10.0.0.5:13306/lemonade/models")).toBe(false);
		expect(isManagedModelsSourceUrl("https://models.example.com/list")).toBe(false);
	});

	it("wants the legacy service URL repointed, and writes nothing", async () => {
		write(clineModelsFile("http://127.0.0.1:13306/lemonade/models"));
		const before = readFileSync(modelsPath, "utf8");

		expect(await planClineModelsSource(modelsPath, TARGET)).toMatchObject({
			action: "update",
			currentUrl: "http://127.0.0.1:13306/lemonade/models",
			targetUrl: TARGET,
		});
		// Planning never writes: only the user's apply command does (cline-lemonade-apply.test.ts).
		expect(readFileSync(modelsPath, "utf8")).toBe(before);
		expect(backups()).toEqual([]);
	});

	it("wants a missing URL set, a route on another Kanban origin moved, and the route kept", async () => {
		write(clineModelsFile());
		expect((await planClineModelsSource(modelsPath, TARGET)).action).toBe("update");
		write(clineModelsFile("http://127.0.0.1:3484/api/model-lists/lemonade"));
		expect((await planClineModelsSource(modelsPath, TARGET)).action).toBe("update");
		write(clineModelsFile(TARGET));
		expect((await planClineModelsSource(modelsPath, TARGET)).action).toBe("up-to-date");
	});

	it("leaves a URL the user chose alone", async () => {
		write(clineModelsFile("https://models.example.com/lemonade"));
		expect(await planClineModelsSource(modelsPath, TARGET)).toMatchObject({
			action: "custom",
			currentUrl: "https://models.example.com/lemonade",
		});
	});

	it("skips a missing file or a file without a Lemonade provider", async () => {
		expect((await planClineModelsSource(modelsPath, TARGET)).action).toBe("skip");
		write({ version: 1, providers: { other: { provider: { name: "Other" } } } });
		expect((await planClineModelsSource(modelsPath, TARGET)).action).toBe("skip");
	});

	it("reports a broken file as an error", async () => {
		writeFileSync(modelsPath, "{ broken");
		expect((await planClineModelsSource(modelsPath, TARGET)).action).toBe("error");
		write({ version: 1 });
		expect((await planClineModelsSource(modelsPath, TARGET)).action).toBe("error");
	});
});
