import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerKitCommand } from "../../../src/commands/kit";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

async function run(args: string[]): Promise<{ stdout: string; exitCode: number | undefined }> {
	const program = new Command();
	program.exitOverride();
	registerKitCommand(program);
	let stdout = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdout += String(chunk);
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const previous = process.exitCode;
	process.exitCode = undefined;
	try {
		await program.parseAsync(["node", "kanban", "kit", ...args]);
		return { stdout, exitCode: process.exitCode };
	} finally {
		vi.restoreAllMocks();
		process.exitCode = previous;
	}
}

describe("kanban kit list", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lists the team kit with its presets and custom teams, never an old name, with the workspaces on each", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			mkdirSync(dirname(globalConfigPath), { recursive: true });
			writeFileSync(
				globalConfigPath,
				JSON.stringify({
					workspaces: {
						old: { kit: { name: "team-local" } },
						current: { kit: { name: "team", preset: "lemonade" } },
						cloud: { kit: { name: "team", preset: "cloud" } },
						mine: { kit: { name: "team", preset: null, overrides: { "roles.dev.agent": "codex" } } },
					},
				}),
			);
			const result = await run(["list", "--json"]);
			expect(result.exitCode).toBeUndefined();
			const { kits, presets, customTeams } = JSON.parse(result.stdout) as {
				kits: Array<{ name: string; workspaces: string[] }>;
				presets: Array<{ name: string; workspaces: string[] }>;
				customTeams: string[];
			};
			expect(kits.map((kit) => kit.name)).toEqual(["default", "team"]);
			expect(kits.find((kit) => kit.name === "team")?.workspaces).toEqual(["old", "current", "cloud", "mine"]);
			expect(Object.fromEntries(presets.map((preset) => [preset.name, preset.workspaces]))).toEqual({
				cloud: ["cloud"],
				cline: [],
				lemonade: ["old", "current"],
			});
			expect(customTeams).toEqual(["mine"]);
		});
	});

	it("kit presets lists each preset's four roles and says the fallback starts without asking", async () => {
		await withTemporaryKanbanHome(async () => {
			const result = await run(["presets"]);
			expect(result.exitCode).toBeUndefined();
			expect(result.stdout).toContain("  dev       codex on bedrock/us.openai.gpt-6.1-sol");
			expect(result.stdout).toContain("  fallback  codex on bedrock/us.moonshotai.kimi-k3");
			expect(result.stdout).toContain("kanban kit apply team --preset <name>");
			expect(result.stdout).toContain("a paid fallback model runs and costs without asking");
		});
	});
});
