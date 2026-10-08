import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { refuseRemoveClineBedrockKey, storeClineBedrockKey } from "../../../src/setup/cline-bedrock-key";
import { describeClineTuiSignInGap } from "../../../src/terminal/cline-tui-sign-in";
import { createTempDir } from "../../utilities/temp-dir";

const KEY = "test-bedrock-key-abc123";
const NOW = new Date("2026-10-08T12:00:00.000Z");

function providersFile(bedrockSettings: Record<string, unknown> | null): Record<string, unknown> {
	return {
		version: 1,
		lastUsedProvider: "bedrock",
		modes: {},
		providers: {
			...(bedrockSettings
				? {
						bedrock: {
							settings: { provider: "bedrock", model: "us.example.model", ...bedrockSettings },
							updatedAt: "2026-10-08T04:48:56.163Z",
							tokenSource: "manual",
						},
					}
				: {}),
			lemonade: { settings: { provider: "lemonade", apiKey: "lemonade-key-stays" } },
		},
	};
}

describe("kanban cline store-bedrock-key", () => {
	let root: { path: string; cleanup: () => void };
	let providersPath: string;
	let backupDir: string;

	beforeEach(() => {
		// Never the real ~/.cline: providers.json and the backups are temp ones.
		root = createTempDir("kanban-cline-bedrock-key-");
		providersPath = join(root.path, "cline", "data", "settings", "providers.json");
		backupDir = join(root.path, "home", "backups", "cline");
		mkdirSync(dirname(providersPath), { recursive: true });
	});
	afterEach(() => root.cleanup());

	function writeProviders(document: unknown, mode = 0o600): string {
		const raw = `${JSON.stringify(document, null, 2)}\n`;
		writeFileSync(providersPath, raw, { mode });
		return raw;
	}

	function run(overrides: { env?: NodeJS.ProcessEnv; dryRun?: boolean } = {}) {
		return storeClineBedrockKey({
			providersPath,
			env: overrides.env ?? { AWS_BEARER_TOKEN_BEDROCK: KEY },
			defaultRegion: "us-west-2",
			dryRun: overrides.dryRun ?? false,
			backupDir,
			now: NOW,
		});
	}

	it("backs up providers.json, then stores only the env's key, atomically with the file's mode (issue #9)", async () => {
		// The state `remove-bedrock-key` left behind: region and model, no key, so Cline's TUI shows its sign-in screen.
		const before = writeProviders(providersFile({ aws: { region: "us-west-2" } }), 0o640);
		expect(describeClineTuiSignInGap(JSON.parse(before), "bedrock")).toContain("stores no Bedrock key");

		const result = await run();
		expect(result.status).toBe("written");
		expect(result.backupPath).toBe(join(backupDir, "providers.json.20261008T120000Z"));
		expect(readFileSync(result.backupPath ?? "", "utf8")).toBe(before);
		expect(statSync(result.backupPath ?? "").mode & 0o777).toBe(0o600);
		expect(result.rollback).toBe(`cp '${result.backupPath}' '${providersPath}'`);

		const after = JSON.parse(readFileSync(providersPath, "utf8"));
		expect(after).toEqual(providersFile({ aws: { region: "us-west-2" }, apiKey: KEY }));
		expect(describeClineTuiSignInGap(after, "bedrock")).toBeNull();
		expect(statSync(providersPath).mode & 0o777).toBe(0o640);
		// Nothing but providers.json next to Cline's files: no backup, no temp file left.
		expect(readdirSync(dirname(providersPath))).toEqual(["providers.json"]);
		// No key value anywhere in what it prints.
		expect(JSON.stringify(result)).not.toContain(KEY);

		const again = await run();
		expect(again.status).toBe("nothing-to-do");
		expect(readdirSync(backupDir)).toHaveLength(1);
	});

	it("replaces a different stored key (a rotated secret) and stores a missing region", async () => {
		writeProviders(providersFile({ apiKey: "old-key-value" }));
		const result = await run({ env: { AWS_BEARER_TOKEN_BEDROCK: KEY, AWS_REGION: "eu-central-1" } });
		expect(result.status).toBe("written");
		expect(result.lines.join("\n")).toContain("replace providers.bedrock.settings.apiKey");
		expect(result.lines.join("\n")).toContain("aws.region = eu-central-1");
		expect(JSON.stringify(result)).not.toContain("old-key-value");
		const settings = JSON.parse(readFileSync(providersPath, "utf8")).providers.bedrock.settings;
		expect(settings).toMatchObject({ apiKey: KEY, aws: { region: "eu-central-1" }, model: "us.example.model" });
	});

	it("adds a Bedrock entry in Cline's own shape when providers.json has none", async () => {
		writeProviders(providersFile(null));
		expect((await run()).status).toBe("written");
		const after = JSON.parse(readFileSync(providersPath, "utf8"));
		expect(after.providers.bedrock).toEqual({
			settings: { provider: "bedrock", apiKey: KEY, aws: { region: "us-west-2" } },
			updatedAt: NOW.toISOString(),
			tokenSource: "manual",
		});
		expect(after.providers.lemonade.settings.apiKey).toBe("lemonade-key-stays");
		expect(describeClineTuiSignInGap(after, "bedrock")).toBeNull();
	});

	it("a dry run writes nothing, not even a backup", async () => {
		const before = writeProviders(providersFile({ aws: { region: "us-west-2" } }));
		const result = await run({ dryRun: true });
		expect(result.status).toBe("would-write");
		expect(result.lines[0]).toContain("store providers.bedrock.settings.apiKey from AWS_BEARER_TOKEN_BEDROCK");
		expect(readFileSync(providersPath, "utf8")).toBe(before);
		expect(() => readdirSync(backupDir)).toThrow();
	});

	it("is refused without AWS_BEARER_TOKEN_BEDROCK in its env, without providers.json, or with AWS credentials", async () => {
		expect((await run()).status).toBe("refused");
		expect((await run()).lines[0]).toContain("no providers.json yet");

		const before = writeProviders(providersFile({ aws: { region: "us-west-2" } }));
		for (const env of [{}, { AWS_BEARER_TOKEN_BEDROCK: "  " }]) {
			const result = await run({ env });
			expect(result.status).toBe("refused");
			expect(result.lines[0]).toContain("AWS_BEARER_TOKEN_BEDROCK is not set");
		}
		expect(readFileSync(providersPath, "utf8")).toBe(before);

		for (const aws of [
			{ region: "us-west-2", authentication: "iam" },
			{ region: "us-west-2", accessKey: "AKIA", secretKey: "s" },
		]) {
			const stored = writeProviders(providersFile({ aws }));
			expect((await run()).status).toBe("refused");
			expect(readFileSync(providersPath, "utf8")).toBe(stored);
		}
	});

	it("errors on bad JSON and never writes it", async () => {
		writeFileSync(providersPath, "{not json");
		expect((await run()).status).toBe("error");
		expect(readFileSync(providersPath, "utf8")).toBe("{not json");
	});
});

describe("kanban cline remove-bedrock-key", () => {
	it("always refuses and points at store-bedrock-key", () => {
		const result = refuseRemoveClineBedrockKey();
		expect(result.status).toBe("refused");
		expect(result.lines.join("\n")).toContain("sign-in screen");
		expect(result.lines.join("\n")).toContain("kanban cline store-bedrock-key");
	});
});

describe("Cline's TUI sign-in check", () => {
	const doc = (settings: Record<string, unknown>) => ({ providers: { bedrock: { settings } } });

	it("needs a stored key or AWS credentials and a stored region for bedrock; the env never counts", () => {
		expect(describeClineTuiSignInGap(null, "bedrock")).toBe("providers.json has no bedrock entry");
		expect(describeClineTuiSignInGap(doc({ apiKey: KEY, aws: { region: "us-west-2" } }), "bedrock")).toContain(
			"doesn't name its provider",
		);
		expect(describeClineTuiSignInGap(doc({ provider: "bedrock", aws: { region: "us-west-2" } }), "bedrock")).toBe(
			"providers.json stores no Bedrock key (Cline's TUI doesn't count AWS_BEARER_TOKEN_BEDROCK)",
		);
		expect(describeClineTuiSignInGap(doc({ provider: "bedrock", apiKey: KEY }), "bedrock")).toContain(
			"stores no Bedrock region",
		);
		for (const settings of [
			{ apiKey: KEY, aws: { region: "us-west-2" } },
			{ auth: { accessToken: KEY }, region: "us-west-2" },
			{ aws: { region: "us-west-2", authentication: "iam" } },
			{ aws: { region: "us-west-2", profile: "work" } },
			{ aws: { region: "us-west-2", accessKey: "AKIA", secretKey: "s" } },
		]) {
			expect(describeClineTuiSignInGap(doc({ provider: "bedrock", ...settings }), "bedrock")).toBeNull();
		}
	});

	it("only judges a missing entry for other providers", () => {
		const document = { providers: { lemonade: { settings: { provider: "lemonade" } } } };
		expect(describeClineTuiSignInGap(document, "lemonade")).toBeNull();
		expect(describeClineTuiSignInGap(document, "openai-native")).toBe("providers.json has no openai-native entry");
	});
});
