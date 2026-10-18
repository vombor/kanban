import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { objectiveCreateSchema } from "../../../src/core/objective-contract";
import { createPriceTable, priceTableFileSchema } from "../../../src/kits/team/bench/prices";
import { createObjectiveStore } from "../../../src/objectives/objective-store";
import { createObjectiveUsageCollector } from "../../../src/server/objective-usage-collector";
import type { AgentTokenUsageReader } from "../../../src/terminal/agent-token-usage";
import { createTempDir } from "../../utilities/temp-dir";

describe("objective usage uses registered scope, not terminal activation", () => {
	it("collects only canonical own/pruned member paths for a newly registered project, without activating an agent", async () => {
		const temp = createTempDir("objective-unactivated-usage-");
		try {
			const store = createObjectiveStore({ home: temp.path });
			await store.create(
				"fresh",
				objectiveCreateSchema.parse({
					requestId: randomUUID(),
					title: "Objective",
					requirements: "Acceptance",
					taskIds: ["dev01"],
				}),
			);
			const read = vi.fn<AgentTokenUsageReader["read"]>(async () => new Map());
			const paths = vi.fn((repo: string, id: string) => [repo, `/fixture/worktrees/${id}/repo`]);
			const collect = createObjectiveUsageCollector({
				store,
				reader: { read },
				workspacePath: () => null,
				registeredProjects: async () => [
					{ workspaceId: "fresh", repoPath: "/fixture/repo" },
					{ workspaceId: "other", repoPath: "/private/other" },
				],
				worktrees: paths,
				sources: async () => ({
					claudeProjectsPath: "/fixture/claude",
					clineSessionsPath: "/fixture/cline",
					codexSessionsPath: "/fixture/codex",
					copilotSessionStatePath: "/fixture/copilot",
				}),
				prices: async () => createPriceTable(priceTableFileSchema.parse({ prices: [] }), "seed"),
			});
			await collect("fresh");
			expect(paths).toHaveBeenCalledExactlyOnceWith("/fixture/repo", "dev01");
			expect(read.mock.calls[0]?.[0]).toEqual(["/fixture/worktrees/dev01/repo"]);
			const objective = (await store.read("fresh")).objectives[0];
			expect(objective?.estimatedUsd).toBeNull();
			expect(objective?.observedEstimatedUsd).toBeNull();
			expect(objective?.usage).toEqual([]);
		} finally {
			temp.cleanup();
		}
	});
});
