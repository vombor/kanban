import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeClinePassKey, storeClinePassKey } from "../../../src/setup/cline-pass-key";
import { describeClineTuiSignInGap, resolveClineProviderSettings } from "../../../src/terminal/cline-tui-sign-in";
import { createTempDir } from "../../utilities/temp-dir";

const KEY = "test-cline-pass-key-abc123";
const NOW = new Date("2026-10-12T12:00:00.000Z");

function providersFile(entries: Record<string, Record<string, unknown>>): Record<string, unknown> {
	return {
		version: 1,
		lastUsedProvider: "bedrock",
		modes: {},
		providers: {
			bedrock: {
				settings: { provider: "bedrock", apiKey: "bedrock-key-stays", aws: { region: "us-west-2" } },
				updatedAt: "2026-10-08T04:48:56.163Z",
				tokenSource: "manual",
			},
			...Object.fromEntries(
				Object.entries(entries).map(([id, settings]) => [
					id,
					{
						settings: { provider: id, ...settings },
						updatedAt: "2026-10-11T00:00:00.000Z",
						tokenSource: "manual",
					},
				]),
			),
		},
	};
}

describe("Cline's TUI sign-in rule for ClinePass (cline 3.0.70)", () => {
	it("needs a stored key: CLINE_API_KEY in the env never counts, nor do a stored baseUrl and model", () => {
		expect(describeClineTuiSignInGap(providersFile({}), "cline-pass")).toBe("providers.json has no cline-pass entry");
		expect(
			describeClineTuiSignInGap(
				providersFile({
					"cline-pass": { baseUrl: "http://127.0.0.1:1/api/v1", model: "cline-pass/mimo-v2.6-flash" },
				}),
				"cline-pass",
			),
		).toBe("providers.json stores no ClinePass key (Cline's TUI doesn't count CLINE_API_KEY)");
		expect(describeClineTuiSignInGap(providersFile({ "cline-pass": { apiKey: KEY } }), "cline-pass")).toBeNull();
	});

	it("reads ClinePass's credentials from the cline entry too, as Cline stores them (storageProviderId)", () => {
		const signedIn = providersFile({ cline: { auth: { accessToken: "account-token", refreshToken: "r" } } });
		expect(describeClineTuiSignInGap(signedIn, "cline-pass")).toBeNull();
		expect(resolveClineProviderSettings(signedIn, "cline-pass")).toEqual({
			auth: { accessToken: "account-token", refreshToken: "r" },
			provider: "cline-pass",
		});
		expect(describeClineTuiSignInGap(providersFile({ cline: { apiKey: "account-key" } }), "cline-pass")).toBeNull();
		// The cline-pass entry's own settings win over the cline entry's.
		expect(
			resolveClineProviderSettings(
				providersFile({ cline: { apiKey: "account-key", baseUrl: "https://a" }, "cline-pass": { apiKey: KEY } }),
				"cline-pass",
			),
		).toEqual({ apiKey: KEY, baseUrl: "https://a", provider: "cline-pass" });
	});

	it("counts a sign-in's access token before a stored key, as Cline sends it", () => {
		const document = providersFile({
			cline: { auth: { accessToken: "account-token" } },
			"cline-pass": { apiKey: KEY },
		});
		expect(describeClinePassKey(document, { CLINE_API_KEY: KEY })).toEqual({
			credential: "sign-in",
			storedKey: "none",
			envKey: true,
			hasEntry: true,
		});
		expect(
			describeClinePassKey(providersFile({ "cline-pass": { apiKey: KEY } }), { CLINE_API_KEY: "other" }),
		).toEqual({ credential: "key", storedKey: "different", envKey: true, hasEntry: true });
	});
});

describe("kanban cline store-cline-pass-key", () => {
	let root: { path: string; cleanup: () => void };
	let providersPath: string;
	let backupDir: string;

	beforeEach(() => {
		// Never the real ~/.cline: providers.json and the backups are temp ones.
		root = createTempDir("kanban-cline-pass-key-");
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
		return storeClinePassKey({
			providersPath,
			env: overrides.env ?? { CLINE_API_KEY: KEY },
			dryRun: overrides.dryRun ?? false,
			backupDir,
			now: NOW,
		});
	}

	it("adds a cline-pass entry with only the env's key, after a backup, atomically with the file's mode", async () => {
		const before = writeProviders(providersFile({}), 0o640);
		expect(describeClineTuiSignInGap(JSON.parse(before), "cline-pass")).not.toBeNull();

		const result = await run();
		expect(result.status).toBe("written");
		expect(result.backupPath).toBe(join(backupDir, "providers.json.20261012T120000Z"));
		expect(readFileSync(result.backupPath ?? "", "utf8")).toBe(before);
		expect(statSync(result.backupPath ?? "").mode & 0o777).toBe(0o600);
		expect(result.rollback).toBe(`cp '${result.backupPath}' '${providersPath}'`);

		const after = JSON.parse(readFileSync(providersPath, "utf8"));
		const expected = providersFile({});
		(expected.providers as Record<string, unknown>)["cline-pass"] = {
			settings: { provider: "cline-pass", apiKey: KEY },
			updatedAt: NOW.toISOString(),
			tokenSource: "manual",
		};
		expect(after).toEqual(expected);
		expect(describeClineTuiSignInGap(after, "cline-pass")).toBeNull();
		expect(statSync(providersPath).mode & 0o777).toBe(0o640);
		expect(readdirSync(dirname(providersPath))).toEqual(["providers.json"]);
		// The result never carries the key.
		expect(JSON.stringify(result)).not.toContain(KEY);
	});

	it("replaces a different stored key and keeps the entry's other settings", async () => {
		writeProviders(
			providersFile({
				"cline-pass": { apiKey: "old-key", model: "cline-pass/glm-5.3", baseUrl: "https://x/api/v1" },
			}),
		);
		const result = await run();
		expect(result.status).toBe("written");
		expect(result.lines[0]).toContain("replace the stored ClinePass key");
		const after = JSON.parse(readFileSync(providersPath, "utf8"));
		expect(after.providers["cline-pass"].settings).toEqual({
			provider: "cline-pass",
			apiKey: KEY,
			model: "cline-pass/glm-5.3",
			baseUrl: "https://x/api/v1",
		});
		expect(after.providers.bedrock.settings.apiKey).toBe("bedrock-key-stays");
		expect(after.providers["cline-pass"].updatedAt).toBe("2026-10-11T00:00:00.000Z");
	});

	it("does nothing when the env's key is stored already, and writes nothing on a dry run", async () => {
		const raw = writeProviders(providersFile({ "cline-pass": { apiKey: KEY } }));
		expect((await run()).status).toBe("nothing-to-do");

		writeProviders(providersFile({}));
		const dry = await run({ dryRun: true });
		expect(dry.status).toBe("would-write");
		expect(dry.backupPath).toBeNull();
		expect(readFileSync(providersPath, "utf8")).not.toBe(raw);
		expect(JSON.parse(readFileSync(providersPath, "utf8")).providers["cline-pass"]).toBeUndefined();
	});

	it("refuses without CLINE_API_KEY, without providers.json and while a Cline account sign-in is stored", async () => {
		writeProviders(providersFile({}));
		const noEnv = await run({ env: {} });
		expect(noEnv.status).toBe("refused");
		expect(noEnv.lines[0]).toContain("Secret=<secret name>,type=env,target=CLINE_API_KEY");

		const signedIn = providersFile({ cline: { auth: { accessToken: "account-token" } } });
		const raw = writeProviders(signedIn);
		const refused = await run();
		expect(refused.status).toBe("refused");
		expect(refused.lines[0]).toContain("Cline account sign-in");
		expect(readFileSync(providersPath, "utf8")).toBe(raw);

		const empty = createTempDir("kanban-cline-pass-key-absent-");
		try {
			const absent = await storeClinePassKey({
				providersPath: join(empty.path, "providers.json"),
				env: { CLINE_API_KEY: KEY },
				dryRun: false,
				backupDir,
			});
			expect(absent.status).toBe("refused");
		} finally {
			empty.cleanup();
		}
	});

	it("never rewrites a providers.json it can't parse", async () => {
		writeFileSync(providersPath, "{ not json");
		const result = await run();
		expect(result.status).toBe("error");
		expect(readFileSync(providersPath, "utf8")).toBe("{ not json");
	});
});
