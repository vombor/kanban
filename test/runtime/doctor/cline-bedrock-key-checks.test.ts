import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkClineBedrockKey } from "../../../src/doctor/cline-bedrock-key-checks";
import { createTempDir } from "../../utilities/temp-dir";

const KEY = "test-bedrock-key-abc123";

describe("doctor: Cline's Bedrock key", () => {
	let root: { path: string; cleanup: () => void };
	let providersPath: string;
	let procRoot: string;

	beforeEach(() => {
		// Never the real ~/.cline or /proc.
		root = createTempDir("kanban-doctor-bedrock-key-");
		providersPath = join(root.path, "cline", "data", "settings", "providers.json");
		procRoot = join(root.path, "proc");
		mkdirSync(dirname(providersPath), { recursive: true });
		mkdirSync(procRoot, { recursive: true });
	});
	afterEach(() => root.cleanup());

	function writeProviders(settings: Record<string, unknown>): void {
		writeFileSync(
			providersPath,
			JSON.stringify({ version: 1, providers: { bedrock: { settings: { provider: "bedrock", ...settings } } } }),
		);
	}

	function writeHubDaemon(pid: number, env: Record<string, string>): void {
		const dir = join(procRoot, String(pid));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "cmdline"), "/usr/bin/cline\0--cline-hub-daemon\0");
		writeFileSync(
			join(dir, "environ"),
			Object.entries(env)
				.map(([name, value]) => `${name}=${value}\0`)
				.join(""),
		);
	}

	function check(env: NodeJS.ProcessEnv, defaultProvider = "bedrock") {
		return checkClineBedrockKey({
			providersPath,
			defaultProvider,
			bedrockRegion: "us-west-2",
			env,
			launcherDeps: { procRoot },
		});
	}

	it("warns when providers.json stores a key the environment already provides, with the user's command", async () => {
		writeProviders({ apiKey: KEY, aws: { region: "us-west-2" } });
		const findings = await check({ AWS_BEARER_TOKEN_BEDROCK: KEY });
		expect(findings).toEqual([
			{
				level: "warn",
				area: "setup",
				message: `Cline stores a Bedrock API key in ${providersPath}; the environment already provides it (the same value as AWS_BEARER_TOKEN_BEDROCK)`,
				hint: "kanban cline remove-bedrock-key",
			},
		]);

		const different = await check({ AWS_BEARER_TOKEN_BEDROCK: "another-key" });
		expect(different[0]?.message).toContain(
			"a different value than AWS_BEARER_TOKEN_BEDROCK; Cline uses the stored one",
		);
		expect(JSON.stringify([...findings, ...different])).not.toContain(KEY);
		expect(JSON.stringify(different)).not.toContain("another-key");
	});

	it("passes with the key only in the environment, and flags a hub daemon started without it", async () => {
		writeProviders({ aws: { region: "us-west-2" } });
		expect(await check({ AWS_BEARER_TOKEN_BEDROCK: KEY })).toEqual([
			{
				level: "pass",
				area: "setup",
				message: `Cline's Bedrock key comes from AWS_BEARER_TOKEN_BEDROCK; none stored in ${providersPath}`,
			},
		]);

		writeHubDaemon(4242, { AWS_REGION: "us-west-2" });
		writeHubDaemon(4343, { AWS_BEARER_TOKEN_BEDROCK: KEY });
		const findings = await check({ AWS_BEARER_TOKEN_BEDROCK: KEY });
		expect(findings).toHaveLength(2);
		expect(findings[1]).toMatchObject({ level: "warn" });
		expect(findings[1]?.message).toContain("Cline hub daemon pid 4242 has no AWS_BEARER_TOKEN_BEDROCK");
		expect(JSON.stringify(findings)).not.toContain("4343");
	});

	it("says so when the env var is missing: with a stored key, and with no key at all", async () => {
		writeProviders({ apiKey: KEY, aws: { region: "us-west-2" } });
		const stored = await check({});
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ level: "warn", hint: "docs/fork/cline-bedrock-auth.md" });
		expect(stored[0]?.message).toContain("AWS_BEARER_TOKEN_BEDROCK is not set, but Cline uses Bedrock");
		expect(stored[0]?.message).toContain("type=env,target=AWS_BEARER_TOKEN_BEDROCK");
		expect(JSON.stringify(stored)).not.toContain(KEY);

		writeProviders({});
		const neither = await check({});
		expect(neither.map((finding) => finding.level)).toEqual(["warn", "warn"]);
		expect(neither[0]?.message).toContain("Cline's Bedrock cards have no key");
		expect(neither[1]?.message).toContain("export AWS_REGION=us-west-2");
	});

	it("has nothing to say when Bedrock isn't used", async () => {
		expect(await check({}, "lemonade")).toEqual([]);
	});
});
