import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCalibrateCommand } from "../../../../src/commands/bench-calibrate";
import { getKanbanGlobalConfigPath } from "../../../../src/state/kanban-home";
import { loadWorkspaceContext, mutateWorkspaceState } from "../../../../src/state/workspace-state";
import { createGitTestEnv } from "../../../utilities/git-env";
import { withTemporaryKanbanHome } from "../../../utilities/kanban-home";
import { createBoard, createCard } from "../../../utilities/workspace-state-store";

async function createWorkspace(userHomePath: string, kit: string | null) {
	const repoPath = join(userHomePath, "repo");
	mkdirSync(repoPath);
	const env = createGitTestEnv();
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoPath, env });
	writeFileSync(join(repoPath, "a.txt"), "a\n");
	execFileSync("git", ["add", "."], { cwd: repoPath, env });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a"], { cwd: repoPath, env });
	const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoPath, env, encoding: "utf8" }).trim();
	const { workspaceId } = await loadWorkspaceContext(repoPath);
	await mutateWorkspaceState(repoPath, () => ({
		board: createBoard({ trash: [createCard({ id: "f80db", prompt: "Build the login.\n\nFINAL STEP: reply." })] }),
		value: null,
	}));
	if (kit) {
		writeFileSync(
			getKanbanGlobalConfigPath(),
			JSON.stringify({ workspaces: { [workspaceId]: { kit: { name: kit } } } }),
		);
	}
	const writeSpec = (models: unknown[]) => {
		const path = join(userHomePath, "spec.json");
		writeFileSync(
			path,
			JSON.stringify({
				name: "t1",
				workspace: workspaceId,
				sets: [
					{ id: "A", ref: head, base: head, fromCard: "f80db", expect: "PASS" },
					{ id: "B", ref: "nosuchref", base: head, fromCard: "gone0" },
				],
				models,
			}),
		);
		return path;
	};
	return { repoPath, workspaceId, head, writeSpec };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("kanban bench calibrate", () => {
	it("refuses a workspace whose kit doesn't list the calibration feature (the default kit)", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { writeSpec, workspaceId } = await createWorkspace(userHomePath, null);
			const spec = writeSpec([{ key: "sol", agent: "codex" }]);
			await expect(runCalibrateCommand(spec, {})).rejects.toThrow(
				`workspace ${workspaceId} is on kit default, which doesn't list the calibration feature (--force to run anyway)`,
			);
		});
	});

	it("refuses rule names the kit doesn't have", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { writeSpec } = await createWorkspace(userHomePath, "team");
			const spec = writeSpec([{ key: "haiku", agent: "cline", rules: ["drive", "nope"] }]);
			await expect(runCalibrateCommand(spec, { print: true })).rejects.toThrow(
				/model haiku: rule nope is not in kit team's qa\.rules \(drive\)/u,
			);
		});
	});

	it("--print checks the dev prompts and refs without creating cards", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { writeSpec, head } = await createWorkspace(userHomePath, "team");
			const spec = writeSpec([{ key: "haiku", agent: "cline", rules: ["drive"] }]);
			const output: string[] = [];
			vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
				output.push(String(chunk));
				return true;
			});
			expect(await runCalibrateCommand(spec, { print: true })).toBe(0);
			const text = output.join("");
			expect(text).toContain(`A: f80db prompt 36 chars → requirements 16; ref ${head} base ${head}`);
			expect(text).toContain(`B: gone0 prompt MISSING; ref BAD base ${head}`);
			expect(text).toContain("2 runs, 3 at a time");
		});
	});
});
