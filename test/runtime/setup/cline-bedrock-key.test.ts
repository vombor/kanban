import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listClineKeyLaunchers, removeClineBedrockKey } from "../../../src/setup/cline-bedrock-key";
import { createTempDir } from "../../utilities/temp-dir";

const KEY = "test-bedrock-key-abc123";
const NOW = new Date("2026-10-08T12:00:00.000Z");

function providersFile(bedrockSettings: Record<string, unknown>): Record<string, unknown> {
	return {
		version: 1,
		lastUsedProvider: "bedrock",
		providers: {
			bedrock: {
				settings: { provider: "bedrock", model: "us.example.model", ...bedrockSettings },
				tokenSource: "manual",
			},
			lemonade: { settings: { provider: "lemonade", apiKey: "lemonade-key-stays" } },
		},
	};
}

/** A fake /proc: one dir per pid with its cmdline and environ (NUL-separated). */
function writeFakeProcess(procRoot: string, pid: number, argv: string[], env: Record<string, string>): void {
	const dir = join(procRoot, String(pid));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "cmdline"), `${argv.join("\0")}\0`);
	writeFileSync(
		join(dir, "environ"),
		`${Object.entries(env)
			.map(([name, value]) => `${name}=${value}`)
			.join("\0")}\0`,
	);
}

describe("kanban cline remove-bedrock-key", () => {
	let root: { path: string; cleanup: () => void };
	let providersPath: string;
	let backupDir: string;
	let procRoot: string;

	beforeEach(() => {
		// Never the real ~/.cline: providers.json, the backups and /proc are all temp ones.
		root = createTempDir("kanban-cline-bedrock-key-");
		providersPath = join(root.path, "cline", "data", "settings", "providers.json");
		backupDir = join(root.path, "home", "backups", "cline");
		procRoot = join(root.path, "proc");
		mkdirSync(dirname(providersPath), { recursive: true });
		mkdirSync(procRoot, { recursive: true });
	});
	afterEach(() => root.cleanup());

	function writeProviders(document: unknown, mode = 0o600): string {
		const raw = `${JSON.stringify(document, null, 2)}\n`;
		writeFileSync(providersPath, raw, { mode });
		return raw;
	}

	function run(overrides: { env?: NodeJS.ProcessEnv; dryRun?: boolean; serverPid?: number } = {}) {
		return removeClineBedrockKey({
			providersPath,
			env: overrides.env ?? { AWS_BEARER_TOKEN_BEDROCK: KEY },
			dryRun: overrides.dryRun ?? false,
			backupDir,
			now: NOW,
			launcherDeps: { procRoot, serverPid: overrides.serverPid ?? null },
		});
	}

	it("backs up providers.json, then removes only the Bedrock key, atomically with the file's mode", async () => {
		const before = writeProviders(providersFile({ apiKey: KEY, aws: { region: "us-west-2" } }), 0o640);
		writeFakeProcess(procRoot, 4242, ["/usr/bin/cline", "--cline-hub-daemon", "--port", "25463"], {
			AWS_BEARER_TOKEN_BEDROCK: KEY,
		});
		const result = await run();
		expect(result.status).toBe("written");
		expect(result.backupPath).toBe(join(backupDir, "providers.json.20261008T120000Z"));
		expect(readFileSync(result.backupPath ?? "", "utf8")).toBe(before);
		expect(statSync(result.backupPath ?? "").mode & 0o777).toBe(0o600);
		expect(result.rollback).toBe(`cp '${result.backupPath}' '${providersPath}'`);

		const after = JSON.parse(readFileSync(providersPath, "utf8"));
		const expected = providersFile({ aws: { region: "us-west-2" } });
		expect(after).toEqual(expected);
		expect(after.providers.lemonade.settings.apiKey).toBe("lemonade-key-stays");
		expect(statSync(providersPath).mode & 0o777).toBe(0o640);
		// Nothing but providers.json next to Cline's files: no backup, no temp file left.
		expect(readdirSync(dirname(providersPath))).toEqual(["providers.json"]);
		// No key value anywhere in what it prints.
		expect(JSON.stringify(result)).not.toContain(KEY);

		const again = await run();
		expect(again.status).toBe("nothing-to-do");
		expect(readdirSync(backupDir)).toHaveLength(1);
	});

	it("a dry run writes nothing, not even a backup", async () => {
		const before = writeProviders(providersFile({ apiKey: KEY, aws: { region: "us-west-2" } }));
		const result = await run({ dryRun: true });
		expect(result.status).toBe("would-write");
		expect(result.lines[0]).toContain("the same value as AWS_BEARER_TOKEN_BEDROCK");
		expect(readFileSync(providersPath, "utf8")).toBe(before);
		expect(() => readdirSync(backupDir)).toThrow();
	});

	it("is refused without AWS_BEARER_TOKEN_BEDROCK in its env", async () => {
		const before = writeProviders(providersFile({ apiKey: KEY }));
		for (const env of [{}, { AWS_BEARER_TOKEN_BEDROCK: "  " }]) {
			const result = await run({ env });
			expect(result.status).toBe("refused");
			expect(result.lines[0]).toContain("AWS_BEARER_TOKEN_BEDROCK is not set");
		}
		expect(readFileSync(providersPath, "utf8")).toBe(before);
	});

	it("is refused while the server or a hub daemon doesn't have the same env key", async () => {
		const before = writeProviders(providersFile({ apiKey: KEY }));
		writeFakeProcess(procRoot, 100, ["node", "kanban"], { AWS_BEARER_TOKEN_BEDROCK: KEY });
		writeFakeProcess(procRoot, 4242, ["/usr/bin/cline", "--cline-hub-daemon"], { AWS_REGION: "us-west-2" });
		writeFakeProcess(procRoot, 4343, ["/usr/bin/cline", "--cline-hub-daemon"], {
			AWS_BEARER_TOKEN_BEDROCK: "rotated-value-xyz",
		});
		writeFakeProcess(procRoot, 4444, ["/usr/bin/cline", "--tui"], {});
		const result = await run({ serverPid: 100 });
		expect(result.status).toBe("refused");
		expect(result.lines.join("\n")).toContain("Cline hub daemon pid 4242 has no AWS_BEARER_TOKEN_BEDROCK");
		expect(result.lines.join("\n")).toContain("Cline hub daemon pid 4343 has a different AWS_BEARER_TOKEN_BEDROCK");
		expect(result.lines.join("\n")).not.toContain("4444");
		expect(result.lines.join("\n")).not.toContain("rotated-value-xyz");
		expect(readFileSync(providersPath, "utf8")).toBe(before);

		writeFakeProcess(procRoot, 101, ["node", "kanban"], {});
		expect(await listClineKeyLaunchers(KEY, { procRoot, serverPid: 101 })).toContainEqual({
			pid: 101,
			role: "kanban server",
			env: "missing",
		});
	});

	it("is refused when stored access keys would replace the API key", async () => {
		const before = writeProviders(providersFile({ apiKey: KEY, aws: { accessKey: "AKIA", secretKey: "s" } }));
		const result = await run();
		expect(result.status).toBe("refused");
		expect(result.lines[0]).toContain("AWS access keys");
		expect(readFileSync(providersPath, "utf8")).toBe(before);
	});

	it("says there is nothing to do without a stored key or a providers.json, and errors on bad JSON", async () => {
		expect((await run()).status).toBe("nothing-to-do");
		writeProviders(providersFile({ aws: { region: "us-west-2" } }));
		expect((await run()).status).toBe("nothing-to-do");
		writeFileSync(providersPath, "{not json");
		expect((await run()).status).toBe("error");
	});
});
