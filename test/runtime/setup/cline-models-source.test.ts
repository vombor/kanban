import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	applyClineModelsSource,
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

	function read(): ReturnType<typeof clineModelsFile> {
		return JSON.parse(readFileSync(modelsPath, "utf8")) as ReturnType<typeof clineModelsFile>;
	}

	function backups(): string[] {
		return readdirSync(dir.path).filter((name) => name.includes(".bak-before-kanban-setup-"));
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

	it("repoints the legacy service URL, keeping everything else, the file mode and a backup", async () => {
		write(clineModelsFile("http://127.0.0.1:13306/lemonade/models"));
		const before = readFileSync(modelsPath, "utf8");

		const result = await applyClineModelsSource({
			modelsPath,
			targetUrl: TARGET,
			dryRun: false,
			now: new Date("2026-10-07T12:00:00.000Z"),
		});

		expect(result).toMatchObject({
			action: "update",
			applied: true,
			currentUrl: "http://127.0.0.1:13306/lemonade/models",
		});
		expect(result.backupPath).toBe(`${modelsPath}.bak-before-kanban-setup-20261007T120000Z`);
		expect(readFileSync(result.backupPath ?? "", "utf8")).toBe(before);
		expect(read()).toEqual(clineModelsFile(TARGET));
		expect(statSync(modelsPath).mode & 0o777).toBe(0o640);
		// Only the lemonade provider is Kanban's to change.
		expect(
			(read().providers as Record<string, { provider: { modelsSourceUrl?: string } }>).other?.provider
				.modelsSourceUrl,
		).toBe("http://127.0.0.1:13306/lemonade/models");
	});

	it("sets a missing URL and is idempotent afterwards", async () => {
		write(clineModelsFile());

		expect((await applyClineModelsSource({ modelsPath, targetUrl: TARGET, dryRun: false })).action).toBe("update");
		const second = await applyClineModelsSource({ modelsPath, targetUrl: TARGET, dryRun: false });

		expect(second).toMatchObject({ action: "up-to-date", applied: false, backupPath: null });
		expect(read()).toEqual(clineModelsFile(TARGET));
		expect(backups()).toHaveLength(1);
	});

	it("moves the route to a new Kanban origin", async () => {
		write(clineModelsFile("http://127.0.0.1:3484/api/model-lists/lemonade"));

		expect(await applyClineModelsSource({ modelsPath, targetUrl: TARGET, dryRun: false })).toMatchObject({
			action: "update",
			applied: true,
		});
		expect(read()).toEqual(clineModelsFile(TARGET));
	});

	it("writes nothing on a dry run", async () => {
		write(clineModelsFile("http://127.0.0.1:13306/lemonade/models"));
		const before = readFileSync(modelsPath, "utf8");

		const result = await applyClineModelsSource({ modelsPath, targetUrl: TARGET, dryRun: true });

		expect(result).toMatchObject({ action: "update", applied: false, backupPath: null });
		expect(readFileSync(modelsPath, "utf8")).toBe(before);
		expect(backups()).toEqual([]);
	});

	it("leaves a URL the user chose alone", async () => {
		write(clineModelsFile("https://models.example.com/lemonade"));
		const before = readFileSync(modelsPath, "utf8");

		expect(await applyClineModelsSource({ modelsPath, targetUrl: TARGET, dryRun: false })).toMatchObject({
			action: "custom",
			applied: false,
		});
		expect(readFileSync(modelsPath, "utf8")).toBe(before);
	});

	it("skips a missing file or a file without a Lemonade provider, and never creates one", async () => {
		expect((await planClineModelsSource(modelsPath, TARGET)).action).toBe("skip");
		write({ version: 1, providers: { other: { provider: { name: "Other" } } } });
		const before = readFileSync(modelsPath, "utf8");

		expect((await applyClineModelsSource({ modelsPath, targetUrl: TARGET, dryRun: false })).action).toBe("skip");
		expect(readFileSync(modelsPath, "utf8")).toBe(before);
	});

	it("reports a broken file as an error and leaves it alone", async () => {
		writeFileSync(modelsPath, "{ broken");
		expect((await applyClineModelsSource({ modelsPath, targetUrl: TARGET, dryRun: false })).action).toBe("error");
		write({ version: 1 });
		expect((await planClineModelsSource(modelsPath, TARGET)).action).toBe("error");
		expect(backups()).toEqual([]);
	});
});
