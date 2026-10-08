import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkClineBedrockKey } from "../../../src/doctor/cline-bedrock-key-checks";
import { createTempDir } from "../../utilities/temp-dir";

const KEY = "test-bedrock-key-abc123";

describe("doctor: Cline's Bedrock key", () => {
	let root: { path: string; cleanup: () => void };
	let providersPath: string;

	beforeEach(() => {
		// Never the real ~/.cline.
		root = createTempDir("kanban-doctor-bedrock-key-");
		providersPath = join(root.path, "cline", "data", "settings", "providers.json");
		mkdirSync(dirname(providersPath), { recursive: true });
	});
	afterEach(() => root.cleanup());

	function writeProviders(settings: Record<string, unknown>): void {
		writeFileSync(
			providersPath,
			JSON.stringify({ version: 1, providers: { bedrock: { settings: { provider: "bedrock", ...settings } } } }),
		);
	}

	function check(env: NodeJS.ProcessEnv, defaultProvider = "bedrock") {
		return checkClineBedrockKey({ providersPath, defaultProvider, env });
	}

	it("warns when the key is only in the environment: Cline's TUI opens its sign-in screen (issue #9)", async () => {
		writeProviders({ aws: { region: "us-west-2" } });
		const findings = await check({ AWS_BEARER_TOKEN_BEDROCK: KEY, AWS_REGION: "us-west-2" });
		expect(findings).toEqual([
			{
				level: "warn",
				area: "setup",
				message: `${providersPath} stores no Bedrock key: Cline's Bedrock cards open on Cline's sign-in screen and never start (its TUI doesn't read AWS_BEARER_TOKEN_BEDROCK, though Kanban's environment has it)`,
				hint: "kanban cline store-bedrock-key",
			},
		]);
		expect(JSON.stringify(findings)).not.toContain(KEY);
	});

	it("passes with the key stored, and never recommends removing it", async () => {
		writeProviders({ apiKey: KEY, aws: { region: "us-west-2" } });
		const findings = await check({ AWS_BEARER_TOKEN_BEDROCK: KEY });
		expect(findings).toEqual([
			{
				level: "pass",
				area: "setup",
				message: `Cline's Bedrock key is stored in ${providersPath} (the same value as AWS_BEARER_TOKEN_BEDROCK), region us-west-2`,
			},
		]);
		expect(await check({})).toMatchObject([{ level: "pass" }]);
		expect(JSON.stringify(findings)).not.toContain("remove-bedrock-key");
		expect(JSON.stringify(findings)).not.toContain(KEY);
	});

	it("warns when the stored key differs from the environment's (a rotated secret)", async () => {
		writeProviders({ apiKey: KEY, aws: { region: "us-west-2" } });
		const different = await check({ AWS_BEARER_TOKEN_BEDROCK: "another-key" });
		expect(different).toHaveLength(1);
		expect(different[0]).toMatchObject({ level: "warn", hint: "kanban cline store-bedrock-key" });
		expect(different[0]?.message).toContain("Cline uses the stored one");
		expect(JSON.stringify(different)).not.toContain(KEY);
		expect(JSON.stringify(different)).not.toContain("another-key");
	});

	it("warns about a region only in AWS_REGION, and points at the doc without any key", async () => {
		writeProviders({ apiKey: KEY });
		const noRegion = await check({ AWS_BEARER_TOKEN_BEDROCK: KEY, AWS_REGION: "us-west-2" });
		expect(noRegion).toHaveLength(1);
		expect(noRegion[0]?.message).toContain("stores no Bedrock region");
		expect(noRegion[0]?.message).toContain("doesn't count AWS_REGION=us-west-2");

		writeProviders({});
		const neither = await check({});
		expect(neither.map((finding) => [finding.level, finding.hint])).toEqual([
			["warn", "docs/fork/cline-bedrock-auth.md"],
			["warn", "docs/fork/cline-bedrock-auth.md"],
		]);
		expect(neither[0]?.message).toContain("Cline's Bedrock cards have no key");
		expect(neither[0]?.message).toContain("type=env,target=AWS_BEARER_TOKEN_BEDROCK");
	});

	it("passes with IAM credentials and only notes an unused stored key", async () => {
		writeProviders({ aws: { region: "us-west-2", authentication: "iam" } });
		expect(await check({})).toMatchObject([{ level: "pass" }]);
		writeProviders({ apiKey: KEY, aws: { region: "us-west-2", authentication: "iam" } });
		expect(await check({})).toMatchObject([{ level: "info" }]);
	});

	it("has nothing to say when Bedrock isn't used", async () => {
		expect(await check({}, "lemonade")).toEqual([]);
	});
});
