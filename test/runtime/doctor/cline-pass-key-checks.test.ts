import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkClinePassKey } from "../../../src/doctor/cline-pass-key-checks";
import { createTempDir } from "../../utilities/temp-dir";

const KEY = "test-cline-pass-key-abc123";

describe("doctor: Cline's ClinePass key", () => {
	let root: { path: string; cleanup: () => void };
	let providersPath: string;

	beforeEach(() => {
		// Never the real ~/.cline.
		root = createTempDir("kanban-doctor-cline-pass-key-");
		providersPath = join(root.path, "cline", "data", "settings", "providers.json");
		mkdirSync(dirname(providersPath), { recursive: true });
	});
	afterEach(() => root.cleanup());

	function writeProviders(providers: Record<string, Record<string, unknown>>): void {
		writeFileSync(
			providersPath,
			JSON.stringify({
				version: 1,
				providers: Object.fromEntries(
					Object.entries(providers).map(([id, settings]) => [id, { settings: { provider: id, ...settings } }]),
				),
			}),
		);
	}

	function check(env: NodeJS.ProcessEnv, defaultProvider = "bedrock") {
		return checkClinePassKey({ providersPath, defaultProvider, env });
	}

	it("says nothing when ClinePass isn't in use", async () => {
		writeProviders({ bedrock: { apiKey: "b" }, cline: { apiKey: "usage-billing" } });
		expect(await check({})).toEqual([]);
	});

	it("warns when the key is only in the environment: Cline's TUI opens its sign-in screen", async () => {
		writeProviders({ bedrock: { apiKey: "b" } });
		const findings = await check({ CLINE_API_KEY: KEY });
		expect(findings).toEqual([
			{
				level: "warn",
				area: "setup",
				message: `${providersPath} stores no ClinePass key: Cline's cline-pass cards open on Cline's sign-in screen and never start (its TUI doesn't read CLINE_API_KEY, though Kanban's environment has it)`,
				hint: "kanban cline store-cline-pass-key",
			},
		]);
		expect(JSON.stringify(findings)).not.toContain(KEY);
	});

	it("points at the doc when neither the env nor providers.json has a key", async () => {
		writeProviders({ "cline-pass": { model: "cline-pass/mimo-v2.6-flash" } });
		expect(await check({})).toMatchObject([
			{ level: "warn", hint: "docs/fork/cline-pass-auth.md", message: expect.stringContaining("is not set") },
		]);
		expect(await check({}, "cline-pass")).toMatchObject([{ level: "warn" }]);
	});

	it("passes with the env's key stored, and warns when the stored key differs", async () => {
		writeProviders({ "cline-pass": { apiKey: KEY } });
		expect(await check({ CLINE_API_KEY: KEY })).toEqual([
			{
				level: "pass",
				area: "setup",
				message: `Cline's ClinePass key is stored in ${providersPath} (the same value as CLINE_API_KEY)`,
			},
		]);
		expect(await check({})).toMatchObject([{ level: "pass" }]);
		const differs = await check({ CLINE_API_KEY: "rotated-key" });
		expect(differs).toMatchObject([
			{ level: "warn", hint: "kanban cline store-cline-pass-key", message: expect.stringContaining("different") },
		]);
		expect(JSON.stringify(differs)).not.toContain(KEY);
		expect(JSON.stringify(differs)).not.toContain("rotated-key");
	});

	it("passes on a Cline account sign-in, noting that CLINE_API_KEY is unused then", async () => {
		writeProviders({ cline: { auth: { accessToken: "account-token" } }, "cline-pass": {} });
		expect(await check({})).toMatchObject([{ level: "pass", message: expect.stringContaining("sign-in") }]);
		expect(await check({ CLINE_API_KEY: KEY })).toMatchObject([
			{ level: "info", message: expect.stringContaining("not CLINE_API_KEY") },
		]);
	});

	it("warns about a providers.json it can't parse", async () => {
		writeFileSync(providersPath, "{ nope");
		expect(await check({ CLINE_API_KEY: KEY })).toMatchObject([{ level: "warn" }]);
	});
});
