import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	applyClineLemonadeEntry,
	formatApplyLemonadeModelsCommand,
	getClineModelsBackupDir,
} from "../../../src/setup/cline-lemonade-apply";
import { getClineModelsSettingsPath } from "../../../src/state/kanban-home";
import { createFakeLemonadeFetch } from "../../utilities/lemonade-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

const ORIGIN = "http://127.0.0.1:3485";
const TARGET = `${ORIGIN}/api/model-lists/lemonade`;
const NOW = new Date("2026-10-07T12:00:00.000Z");

function clineModelsFile(modelsSourceUrl: string | undefined, models: unknown): Record<string, unknown> {
	return {
		version: 1,
		providers: {
			lemonade: {
				provider: {
					name: "Lemonade (local)",
					baseUrl: "http://lemonade.test:13305/api/v1",
					...(modelsSourceUrl === undefined ? {} : { modelsSourceUrl }),
					apiKey: "secret-in-the-file",
				},
				models,
			},
			other: {
				provider: { name: "Other", modelsSourceUrl: "http://127.0.0.1:13306/lemonade/models" },
				models: ["x"],
			},
		},
		unrelatedTopLevel: { keep: true },
	};
}

type ModelsDocument = {
	version: number;
	unrelatedTopLevel: unknown;
	providers: {
		lemonade: { provider: Record<string, unknown>; models: Record<string, Record<string, unknown>> };
		other: unknown;
	};
};

describe("kanban cline apply-lemonade-models", () => {
	let root: { path: string; cleanup: () => void };
	let savedEnv: { CLINE_DIR?: string; CLINE_DATA_DIR?: string };
	let modelsPath: string;
	let homePath: string;

	beforeEach(() => {
		root = createTempDir("kanban-cline-apply-");
		savedEnv = { CLINE_DIR: process.env.CLINE_DIR, CLINE_DATA_DIR: process.env.CLINE_DATA_DIR };
		// Never the real ~/.cline: Cline's dir is a temp one, resolved the way the command resolves it.
		process.env.CLINE_DIR = join(root.path, "cline");
		delete process.env.CLINE_DATA_DIR;
		modelsPath = getClineModelsSettingsPath();
		homePath = join(root.path, "kanban-home");
		mkdirSync(dirname(modelsPath), { recursive: true });
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		root.cleanup();
	});

	function write(document: unknown): string {
		const raw = `${JSON.stringify(document, null, 2)}\n`;
		writeFileSync(modelsPath, raw, { mode: 0o640 });
		return raw;
	}

	function read(): ModelsDocument {
		return JSON.parse(readFileSync(modelsPath, "utf8")) as ModelsDocument;
	}

	function apply(options: { dryRun?: boolean; fetch?: typeof fetch } = {}) {
		return applyClineLemonadeEntry({
			modelsPath,
			origin: ORIGIN,
			requireLabels: ["tool-calling"],
			backupDir: getClineModelsBackupDir(homePath),
			dryRun: options.dryRun ?? false,
			fetch: options.fetch ?? createFakeLemonadeFetch(),
			now: NOW,
		});
	}

	it("prints a command with the origin", () => {
		expect(formatApplyLemonadeModelsCommand("http://127.0.0.1:3485/x")).toBe(
			"kanban cline apply-lemonade-models --origin http://127.0.0.1:3485",
		);
	});

	it("writes only the Lemonade entry, atomically with the file's mode, after a backup in the Kanban home", async () => {
		const before = write(
			clineModelsFile("http://127.0.0.1:13306/lemonade/models", ["GLM-4.7-Flash-GGUF", "Gone-GGUF"]),
		);

		const result = await apply();

		expect(result.status).toBe("written");
		expect(result.lines).toContain(`modelsSourceUrl: http://127.0.0.1:13306/lemonade/models -> ${TARGET}`);
		expect(result.lines).toContain("Gone-GGUF: remove (Lemonade no longer lists it)");
		const backupDir = join(homePath, "backups", "cline");
		expect(result.backupPath).toBe(join(backupDir, "models.json.20261007T120000Z"));
		expect(readFileSync(result.backupPath ?? "", "utf8")).toBe(before);
		expect(statSync(result.backupPath ?? "").mode & 0o777).toBe(0o600);
		// Nothing but models.json next to Cline's files: no backup, no temp file left.
		expect(readdirSync(dirname(modelsPath))).toEqual(["models.json"]);
		expect(statSync(modelsPath).mode & 0o777).toBe(0o640);

		const after = read();
		const expected = clineModelsFile(TARGET, {}) as ModelsDocument;
		expect(after.providers.lemonade.provider).toEqual(expected.providers.lemonade.provider);
		expect(Object.keys(after.providers.lemonade.models)).toHaveLength(6);
		expect(after.providers.lemonade.models["GLM-4.7-Flash-GGUF"]).toMatchObject({ contextWindow: 202752 });
		expect(after.providers.other).toEqual(expected.providers.other);
		expect(after.unrelatedTopLevel).toEqual({ keep: true });
		expect(after.version).toBe(1);
	});

	it("is idempotent: a second run is in sync and writes nothing", async () => {
		write(clineModelsFile(undefined, ["GLM-4.7-Flash-GGUF"]));
		await apply();
		const once = readFileSync(modelsPath, "utf8");

		const again = await apply();
		expect(again.status).toBe("in-sync");
		expect(again.backupPath).toBeNull();
		expect(readFileSync(modelsPath, "utf8")).toBe(once);
		expect(readdirSync(join(homePath, "backups", "cline"))).toHaveLength(1);
	});

	it("a dry run writes nothing, not even a backup", async () => {
		const before = write(clineModelsFile(undefined, ["GLM-4.7-Flash-GGUF"]));
		const result = await apply({ dryRun: true });
		expect(result.status).toBe("would-write");
		expect(readFileSync(modelsPath, "utf8")).toBe(before);
		expect(readdirSync(root.path)).not.toContain("kanban-home");
	});

	it("with Lemonade down keeps every model value and still points the URL", async () => {
		const models = { "GLM-4.7-Flash-GGUF": { id: "GLM-4.7-Flash-GGUF", contextWindow: 202752 } };
		write(clineModelsFile("https://models.example.com/mine", models));
		const custom = await apply({ fetch: createFakeLemonadeFetch({ down: true }) });
		expect(custom.status).toBe("in-sync");

		write(clineModelsFile(undefined, models));
		const result = await apply({ fetch: createFakeLemonadeFetch({ down: true }) });
		expect(result.status).toBe("written");
		expect(read().providers.lemonade.models).toEqual(models);
		expect(read().providers.lemonade.provider.modelsSourceUrl).toBe(TARGET);
	});

	it("leaves a file alone that changed while Lemonade was asked", async () => {
		write(clineModelsFile(undefined, ["GLM-4.7-Flash-GGUF"]));
		const lemonade = createFakeLemonadeFetch();
		const editing: typeof fetch = async (input, init) => {
			writeFileSync(modelsPath, JSON.stringify(clineModelsFile(undefined, ["Edited-GGUF"])));
			return await lemonade(input, init);
		};
		const edited = JSON.stringify(clineModelsFile(undefined, ["Edited-GGUF"]));

		const result = await apply({ fetch: editing });
		expect(result.status).toBe("error");
		expect(readFileSync(modelsPath, "utf8")).toBe(edited);
	});

	it("does nothing without a Lemonade provider and never creates one", async () => {
		expect((await apply()).status).toBe("absent");
		const before = write({ version: 1, providers: { other: { models: {} } } });
		expect((await apply()).status).toBe("absent");
		expect(readFileSync(modelsPath, "utf8")).toBe(before);
	});
});
