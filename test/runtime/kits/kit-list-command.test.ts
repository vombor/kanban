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

	it("lists team-cloud, never the old name team, with the workspaces still configured as team", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			mkdirSync(dirname(globalConfigPath), { recursive: true });
			writeFileSync(
				globalConfigPath,
				JSON.stringify({
					workspaces: { old: { kit: { name: "team" } }, current: { kit: { name: "team-cloud" } } },
				}),
			);
			const result = await run(["list", "--json"]);
			expect(result.exitCode).toBeUndefined();
			const { kits } = JSON.parse(result.stdout) as { kits: Array<{ name: string; workspaces: string[] }> };
			expect(kits.map((kit) => kit.name)).toEqual(["default", "team-cloud", "team-local", "team-cline"]);
			expect(kits.find((kit) => kit.name === "team-cloud")?.workspaces).toEqual(["old", "current"]);
		});
	});
});
