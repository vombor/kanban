import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RUNTIME_AGENT_CATALOG } from "../../../src/core/agent-catalog";
import { DEV_COMPLETION_MARKER } from "../../../src/kits/dev-completion";
import { prepareKitDevPrompt } from "../../../src/server/kit-dev-instructions";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

describe("kit-owned native dev dispatch instructions (#71)", () => {
	it("uses the native card role/kit for all supported CLIs and resume/rework input without rewriting stored tasks", async () =>
		withTemporaryKanbanHome(async ({ homePath }) => {
			await mkdir(join(homePath, "workspaces/own"), { recursive: true });
			await writeFile(
				join(homePath, "config.json"),
				JSON.stringify({ workspaces: { own: { kit: { name: "team", preset: "lemonade" } } } }),
			);
			const boardPath = join(homePath, "workspaces/own/board.json");
			for (const agent of RUNTIME_AGENT_CATALOG) {
				const board = createBoard({
					review: [
						createCard({ id: "dev1", role: "dev", agentId: agent.id }),
						createCard({ id: "qa1", role: "qa", agentId: agent.id }),
					],
				});
				const original = JSON.stringify(board);
				await writeFile(boardPath, original);
				for (const text of [
					"Implement the requested feature.",
					"Resume the retained task; preserve its requirements.",
					"REWORK round 2: fix the independently reproduced QA issue.",
				]) {
					expect(await prepareKitDevPrompt("own", "dev1", text)).toContain(DEV_COMPLETION_MARKER);
					expect(await prepareKitDevPrompt("own", "qa1", text)).toBe(text);
				}
				expect(await readFile(boardPath, "utf8")).toBe(original);
			}
		}));
});
