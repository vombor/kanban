import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerBenchCommand } from "../../../../src/commands/bench";
import { getWatchdogWorkspacePaths } from "../../../../src/state/kanban-home";
import { withTemporaryKanbanHome } from "../../../utilities/kanban-home";

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
	const program = new Command();
	program.exitOverride();
	registerBenchCommand(program);
	let stdout = "";
	let stderr = "";
	const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdout += String(chunk);
		return true;
	});
	const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		stderr += String(chunk);
		return true;
	});
	const previous = process.exitCode;
	process.exitCode = undefined;
	try {
		await program.parseAsync(["node", "kanban", "bench", ...args]);
		return { stdout, stderr, exitCode: process.exitCode };
	} finally {
		out.mockRestore();
		err.mockRestore();
		process.exitCode = previous;
	}
}

describe("kanban bench runoff status / tiers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("tiers --kit team prints the tier picks", async () => {
		await withTemporaryKanbanHome(async () => {
			const result = await run(["tiers", "--kit", "team", "--json"]);
			expect(result.exitCode).toBe(0);
			const report = JSON.parse(result.stdout) as { kitName: string; tiers: Array<{ name: string; pick: unknown }> };
			expect(report.kitName).toBe("team");
			expect(report.tiers.find((tier) => tier.name === "tier3")?.pick).toEqual({
				provider: "bedrock",
				model: "us.openai.gpt-6.1-sol",
			});
		});
	});

	it("runoff status lists open runoffs by default and every runoff with --all", async () => {
		await withTemporaryKanbanHome(async () => {
			const path = getWatchdogWorkspacePaths("foo").runoffs;
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(
				path,
				JSON.stringify({
					runoffs: [
						{ name: "old", cards: ["a1", "a2"], decided: "2026-10-06T03:38:25Z", winner: "a1" },
						{ name: "race", cards: ["b1", "b2"], models: { b1: "bedrock/m1", b2: "bedrock/m2" } },
					],
				}),
			);

			const open = await run(["runoff", "status", "--project", "foo"]);
			expect(open.exitCode).toBe(0);
			expect(open.stdout).toContain("race: open");
			expect(open.stdout).toContain("b1 bedrock/m1: gone, not on the board");
			expect(open.stdout).not.toContain("old:");

			const all = await run(["runoff", "status", "--project", "foo", "--all", "--json"]);
			const payload = JSON.parse(all.stdout) as {
				runoffs: Array<{ name: string; open: boolean; winner: string | null }>;
			};
			expect(payload.runoffs.map((runoff) => [runoff.name, runoff.open, runoff.winner])).toEqual([
				["old", false, "a1"],
				["race", true, null],
			]);
		});
	});
});
